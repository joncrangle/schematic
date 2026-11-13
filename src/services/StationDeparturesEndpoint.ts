import type { NearbyStationArrival } from "~/domain/surface/types";
import type { StationDepartureGroup } from "~/services/StationsClient";
import type { UiLocale } from "~/domain/locale";
import { parseOptionalUiLocale } from "~/services/nearby/rpcInput";
import {
  handleFetchStationDepartures,
  handleFetchFeedStationDepartures,
} from "~/services/StationsServer";
import { interchangeDepartureHubIds, type InterchangeDataset } from "~/domain/map/Interchange";
import {
  endpointErrorMessage,
  headFromGet,
  isKnownAgency,
  isKnownStation,
  noStoreJson,
  parseAgencyIdParam,
  parseStationIdParam,
} from "~/services/apiEndpoint";

/**
 * Per-station departures HTTP composition.
 *
 * Serves arrivals-only departures through
 * `GET /api/departures/:agencyId/:stationId` (plus HEAD with identical
 * status/headers and no body). Same transport pattern as SnapshotEndpoint and
 * RoutesCatalogEndpoint, riding the shared `apiEndpoint` helpers.
 *
 * Departures read the same for every rider at a station, so non-empty
 * healthy responses are edge-cacheable. They are live countdowns, so the
 * edge serves an entry only while fresh. Browsers always revalidate
 * (`max-age=0`) and the edge holds entries 20 seconds. An expired entry
 * blocks and refreshes from origin. An origin error reaches the client as
 * an error. There is no `stale-while-revalidate` here and `stale-if-error`
 * is 0. Leaving `stale-if-error` unset would serve stale countdowns
 * indefinitely whenever the origin fails.
 * Stale responses stay `no-store`; healthy ones with an empty group get a 5s edge entry.
 * The body is deliberately location-free (no distanceMeters): per-user
 * coordinates would poison the shared cache. Errors (400, unknown-agency 404,
 * 503) are `no-store`. An unknown station id is an explicit 404 held briefly
 * at the edge.
 */

export const DEPARTURES_NO_STORE = "no-store";

/** Browsers always revalidate; the edge owns freshness. */
export const DEPARTURES_BROWSER_CACHE = "public, max-age=0";

/** Fresh-only edge policy. 20s fresh, errors surface, never stale. */
export const DEPARTURES_EDGE_CACHE = "public, max-age=20, stale-if-error=0";

/** Healthy with an empty group: 5s so a recovering route shows quickly. */
export const DEPARTURES_PARTIAL_EDGE_CACHE = "public, max-age=5, stale-if-error=0";

/** Unknown stations stay unknown until a deploy, so repeated probes are served from the edge. */
export const DEPARTURES_UNKNOWN_STATION_EDGE_CACHE = "public, max-age=60";

export type StationDeparturesGetter = (input: {
  readonly agencyId: string;
  readonly stationId: string;
  readonly locale?: UiLocale;
}) => Promise<readonly StationDepartureGroup[]>;

function toDepartureGroup(card: NearbyStationArrival): StationDepartureGroup {
  return {
    lineIds: [...card.lineIds],
    ...(card.lineName === undefined ? {} : { lineName: card.lineName }),
    arrivals: [...card.arrivals],
    ...(card.arrivalsStale === true ? { arrivalsStale: true as const } : {}),
    ...(card.livePredictionsOnly === true ? { livePredictionsOnly: true as const } : {}),
  };
}

export function createStationDeparturesGetter(
  dataset: InterchangeDataset,
  getStations = handleFetchStationDepartures,
  getFeedStations = handleFetchFeedStationDepartures,
  knowsStation: (agencyId: string, stationId: string) => boolean = isKnownStation,
): StationDeparturesGetter {
  return async ({ agencyId, stationId, locale }) => {
    const hubIds = interchangeDepartureHubIds(stationId);
    if (hubIds !== null) {
      const endpoints = hubIds.map((hubId) =>
        dataset
          .find((hub) => hub.id === hubId)
          ?.endpoints.find(
            (candidate) => candidate.agencyId === agencyId && candidate.feedStopIds?.length,
          ),
      );
      if (endpoints.length === 0 || endpoints.some((endpoint) => !endpoint)) return [];
      const cards = await getFeedStations({
        agencyId,
        stationId,
        stationName: endpoints[0]!.stationName,
        stopIds: [...new Set(endpoints.flatMap((endpoint) => endpoint!.feedStopIds!))],
      });
      return cards.map(toDepartureGroup);
    }
    // Unknown ids answer empty before any feed or database work.
    if (!knowsStation(agencyId, stationId)) return [];
    const cards = await getStations({ agencyId, stationIds: [stationId], locale });
    return cards.map(toDepartureGroup);
  };
}

const defaultDeparturesGetter = createStationDeparturesGetter([]);

/**
 * Core GET logic returning a Response. Unknown agencies and unknown stations
 * are explicit 404s; malformed ids are 400; store failures are 503. Only the
 * unknown-station 404 is edge-cacheable. Stale 200s are `no-store`; other 200s carry a short public cache.
 */
export async function handleDeparturesGet(
  agencyIdRaw: unknown,
  stationIdRaw: unknown,
  getDepartures: StationDeparturesGetter = defaultDeparturesGetter,
  localeRaw?: unknown,
): Promise<Response> {
  let agencyId: string;
  let stationId: string;
  try {
    agencyId = parseAgencyIdParam(agencyIdRaw);
    stationId = parseStationIdParam(stationIdRaw);
  } catch (error) {
    return noStoreJson(400, {
      error: endpointErrorMessage(error, "Missing or invalid parameters"),
    });
  }

  if (!isKnownAgency(agencyId)) {
    return noStoreJson(404, { error: `Unknown agency "${agencyId}"` });
  }

  let locale: UiLocale | undefined;
  try {
    locale = parseOptionalUiLocale(localeRaw);
  } catch {
    return noStoreJson(400, { error: "Missing or invalid locale" });
  }

  try {
    const groups = await getDepartures({ agencyId, stationId, locale });
    if (groups.length === 0) {
      return Response.json(
        { error: `Unknown station "${stationId}"` },
        {
          status: 404,
          headers: {
            "Cache-Control": DEPARTURES_BROWSER_CACHE,
            "cloudflare-cdn-cache-control": DEPARTURES_UNKNOWN_STATION_EDGE_CACHE,
          },
        },
      );
    }
    const isStale = groups.some((group) => group.arrivalsStale === true);
    const everyGroupHasDepartures = groups.every((group) =>
      group.arrivals.some((arrival) => arrival.times.length > 0),
    );
    return Response.json(groups, {
      status: 200,
      headers: isStale
        ? { "Cache-Control": DEPARTURES_NO_STORE }
        : {
            "Cache-Control": DEPARTURES_BROWSER_CACHE,
            "cloudflare-cdn-cache-control": everyGroupHasDepartures
              ? DEPARTURES_EDGE_CACHE
              : DEPARTURES_PARTIAL_EDGE_CACHE,
          },
    });
  } catch (error) {
    return noStoreJson(503, {
      error: endpointErrorMessage(error, "Station departures unavailable"),
    });
  }
}

/** HEAD mirrors GET status/headers with no response body. */
export async function handleDeparturesHead(
  agencyIdRaw: unknown,
  stationIdRaw: unknown,
  getDepartures: StationDeparturesGetter = defaultDeparturesGetter,
  localeRaw?: unknown,
): Promise<Response> {
  return headFromGet(
    await handleDeparturesGet(agencyIdRaw, stationIdRaw, getDepartures, localeRaw),
  );
}
