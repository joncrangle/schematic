import { fetchSamsaraBoards } from "./samsara/samsaraBoards";
import { fetchCitywayArrivals } from "./cityway/citywaySource";
import { fetchPassioArrivals } from "./passio/passioSource";
import { fetchHubupArrivals } from "./hubup/hubupSource";
import { createZenbusStationsSource } from "./zenbus/zenbusSource";
import { fetchTripSparkArrivals } from "./tripspark/tripsparkSource";
import { fetchBusTimeArrivals } from "./bustime/bustimeSource";
import { fetchTranslocArrivals } from "./transloc/translocSource";
import { fetchSwiftlyArrivals } from "./swiftly/swiftlySource";
import { feedMatchesScope } from "./feedScope";
import { prepareScheduledPredictions } from "./scheduledPredictions";
import { selectSeededTrips } from "./seededTripScope";
import {
  decodeMappedStationDepartures,
  fetchMappedStationDepartures,
} from "./mappedStationDepartures";
import { resolveTripRoutes } from "./gtfsTripDescriptor";
import {
  isTerminatingPrediction,
  type TripTerminal,
  type TripTerminalLookup,
  type TripDirectionLookup,
  type TripRouteLookup,
} from "~/domain/surface/boarding";
import * as Effect from "effect/Effect";

import { calculateHaversineMeters } from "~/domain/map/MapGeometry";
import {
  directionIdForLabel,
  directionLabelFor,
  directionSemanticForCanonicalLabel,
  generatedDirectionLabelText,
  isNorthSouthDirectionIdsInverted,
  scheduledHeadsignDestination,
  type GeneratedDirectionLabel,
} from "~/domain/surface/direction";
import { lineNameFor, type LineMetadata } from "~/domain/lineColors";
import { calculateWalkingMinutes } from "~/domain/proximity";
import { StationsError, type StationsSource } from "~/domain/surface/stationsSource";
import type {
  ArrivalPrediction,
  NearbyStationArrival,
  NearbyStationArrivalGroup,
  SurfaceRouteType,
} from "~/domain/surface/types";
import type { SchematicStationIndexEntry, RealtimeFeedConfig } from "~/agencies/types";
import type { RouteInterpretationConfig } from "~/agencies";
import { fetchDecodedFeeds, TransportFailure } from "./fetchDecodedFeeds";
import { createSwrFeedCache } from "./swrFeedCache";
import { resolveNetworkDocumentFeed } from "~/domain/realtimeFeedRouting";
import { createTsimobileStationsSource } from "./tsimobile/tsimobileSource";
import { createTrainMapStationsSource } from "./trainMap/trainMapSource";
import { createStationTimetablesStationsSource } from "./stationTimetables/stationTimetablesSource";
import { createFerrySailingStationsSource } from "./ferrySailings/ferrySailingSource";
import { decodeStationTripUpdates } from "./stationTripDecoder";
import { cancelledTripsSources, dropCancelledTrips, fetchCancelledTripIds } from "./cancelledTrips";
import { routeIdsMatch } from "~/domain/surface/routeIds";
import { fetchTmixStationArrivals, inferTmixCallDirection } from "./tmix/tmixRealtimeSource";
import { logger } from "~/infrastructure/logging/logger";

/** Calls of one trip at a station this close together are one visit across its kerbs. */
const SAME_VISIT_MS = 5 * 60_000;

export interface GenericStationsSourceOptions {
  readonly getScheduledStopTimes?: import("~/domain/surface/scheduledStopTimes").ScheduledStopLookup;
  readonly getSourceAgencyScope?: import("~/domain/surface/boarding").SourceAgencyScopeLookup;
  readonly restrictToSeededTrips?: boolean;
  readonly getRoutesForTrips?: TripRouteLookup;
  readonly getTripTerminals?: TripTerminalLookup;
  readonly getDirectionsForTrips?: TripDirectionLookup;
  readonly agencyId: string;
  readonly stations: readonly SchematicStationIndexEntry[];
  readonly feeds: readonly RealtimeFeedConfig[];
  readonly fetch: typeof fetch;
  readonly now?: () => number;
  readonly directionLiterals?: Readonly<Record<string, string>>;
  readonly routeType?: SurfaceRouteType;
  readonly splitByLine?: boolean;
  readonly lineMetadata?: readonly LineMetadata[];
  /**
   * Ordered schematic station ids per line, for terminus detection. A trip
   * that ends at a line terminus is an arrival, not a departure: there is no
   * revenue track beyond it. Absent (or for stations mid-sequence), grouping
   * behaves exactly as before.
   */
  readonly lineSequences?: Readonly<Record<string, readonly string[]>>;
  readonly getSecret?: (name: string) => string | undefined;
  readonly devProxyOrigin?: string;
  readonly routeInterpretation?: RouteInterpretationConfig;
  readonly routeLineMap?: Readonly<Record<string, string>>;
  readonly staticRouteIdField?: "id" | "short_name";
  /**
   * Optional per-mode departure gate. Multi-mode agencies (one stations
   * source per stationService entry) keep only the departures whose feed
   * route classifies to that entry's mode, so panels never mix rail labels
   * onto bus departures. Absent for single-service agencies: no filtering.
   */
  readonly predictionFilter?: (routeId: string) => boolean;
}

/**
 * Keep a decoded station snapshot across the 15-second client poll cadence.
 * An interval of 12s ensures client polls always revalidate with fresh data.
 */
export const STATION_FEED_CACHE_TTL_MS = 12_000;
export const STATION_FEED_FAILURE_TTL_MS = STATION_FEED_CACHE_TTL_MS;
export const STATION_FEED_FETCH_ATTEMPTS = 3;
export const STATION_FEED_RETRY_DELAY_MS = 100;
export const STATION_DEPARTURES_CONCURRENCY = 4;
const STATION_EDGE_CACHE_TTL_SECONDS = Math.ceil(STATION_FEED_CACHE_TTL_MS / 1_000);

type StationArrivals = ReadonlyMap<string, readonly ArrivalPrediction[]>;

/** Retain last-good trips absent from an incomplete read; current estimates win by identity. */
function mergeStationArrivals(
  previous: StationArrivals,
  current: StationArrivals,
): StationArrivals {
  const byStop = new Map<string, Map<string, ArrivalPrediction>>();
  const add = (source: StationArrivals) => {
    for (const [stopId, predictions] of source) {
      const byIdentity = byStop.get(stopId) ?? new Map<string, ArrivalPrediction>();
      for (const prediction of predictions) {
        const identity = `${prediction.tripId}\u0000${prediction.routeId}\u0000${prediction.directionId}`;
        byIdentity.set(identity, prediction);
      }
      byStop.set(stopId, byIdentity);
    }
  };
  add(previous);
  add(current);
  return new Map([...byStop].map(([stopId, predictions]) => [stopId, [...predictions.values()]]));
}

function settleWithConcurrency<T>(
  tasks: readonly (() => Promise<T>)[],
  concurrency: number,
): Promise<PromiseSettledResult<T>[]> {
  return Effect.runPromise(
    Effect.all(
      tasks.map((task) =>
        Effect.tryPromise({ try: task, catch: (reason) => reason }).pipe(
          Effect.match({
            onSuccess: (value): PromiseSettledResult<T> => ({ status: "fulfilled", value }),
            onFailure: (reason): PromiseSettledResult<T> => ({ status: "rejected", reason }),
          }),
        ),
      ),
      { concurrency },
    ),
  );
}

/** Furthest relevant stop per trip, so trips ending at a terminus drop out. */
function furthestStopSequences(
  arrivalsByStop: StationArrivals,
  matchesRoute: (routeId: string | undefined) => boolean,
): ReadonlyMap<string, number> {
  const furthest = new Map<string, number>();
  for (const predictions of arrivalsByStop.values()) {
    for (const prediction of predictions) {
      // Zero is the decoder's sentinel for feeds that do not carry stop
      // sequence evidence (for example, per-station JSON departures). Do not
      // let those predictions acquire a synthetic "trip ends here" result.
      if (prediction.stopSequence <= 0 || !matchesRoute(prediction.routeId)) continue;
      const previous = furthest.get(prediction.tripId) ?? -1;
      if (prediction.stopSequence > previous) {
        furthest.set(prediction.tripId, prediction.stopSequence);
      }
    }
  }
  return furthest;
}

function railTerminalForDirection(
  routeId: string | undefined,
  directionId: 0 | 1,
  lineSequences: Readonly<Record<string, readonly string[]>> | undefined,
  stations: readonly SchematicStationIndexEntry[],
): string | undefined {
  if (!routeId || !lineSequences) return undefined;
  const sequence =
    lineSequences[routeId] ??
    Object.entries(lineSequences).find(([id]) => routeIdsMatch(routeId, id))?.[1];
  const terminalId = directionId === 0 ? sequence?.[0] : sequence?.at(-1);
  if (!terminalId) return undefined;
  const terminalKey = terminalId.trim().toLowerCase();
  return stations.find(
    (station) => (station.schematicId ?? station.id).trim().toLowerCase() === terminalKey,
  )?.name;
}

interface TerminusConfig {
  readonly departingDirectionId: 0 | 1;
  readonly departingLabel: string;
  readonly departingGeneratedLabel?: GeneratedDirectionLabel;
  readonly terminatingDirectionId: 0 | 1;
}

/**
 * Resolves the valid departing direction and non-departing terminating direction
 * for a station when it is at the start or end of an ordered schematic line sequence.
 * At a terminus, departures head into the line toward the adjacent station;
 * terminating arrivals from the line cannot depart in that direction.
 */
function resolveTerminusConfig(
  station: SchematicStationIndexEntry,
  lineId: string,
  lineSequences: Readonly<Record<string, readonly string[]>> | undefined,
  allStations: readonly SchematicStationIndexEntry[],
  directionLiterals: Readonly<Record<string, string>> | undefined,
  routeType: SurfaceRouteType | undefined,
  routeInterpretation?: RouteInterpretationConfig,
): TerminusConfig | undefined {
  if (!lineSequences) return undefined;
  const schematicKey = (station.schematicId ?? station.id).trim().toLowerCase();
  const sequence =
    lineSequences[lineId] ??
    Object.entries(lineSequences).find(([k]) => routeIdsMatch(lineId, k))?.[1];
  if (!sequence || sequence.length < 2) return undefined;

  const isFirst = sequence[0].trim().toLowerCase() === schematicKey;
  const isLast = sequence[sequence.length - 1].trim().toLowerCase() === schematicKey;
  if (!isFirst && !isLast) return undefined;

  if (routeType === "rail") {
    // In rail networks (e.g. GO Transit), line sequences run from outer terminals (index 0)
    // to the central terminal (index length-1, Union).
    // Outbound (direction 0) heads away from Union to outer terminals.
    // Inbound (direction 1) heads toward Union.
    const departingDirectionId: 0 | 1 = isLast ? 0 : 1;
    const terminatingDirectionId: 0 | 1 = isLast ? 1 : 0;
    const terminalName = railTerminalForDirection(
      lineId,
      departingDirectionId,
      lineSequences,
      allStations,
    );
    const generatedLabel: GeneratedDirectionLabel =
      departingDirectionId === 0 ? "outbound" : "inbound";
    const configuredLabel =
      departingDirectionId === 0 ? directionLiterals?.outbound : directionLiterals?.inbound;
    const departingLabel = terminalName
      ? `→ ${terminalName}`
      : (configuredLabel ?? generatedDirectionLabelText(generatedLabel));
    return {
      departingDirectionId,
      departingLabel,
      ...(!terminalName && configuredLabel === undefined
        ? { departingGeneratedLabel: generatedLabel }
        : {}),
      terminatingDirectionId,
    };
  }

  const adjacentKey = (isFirst ? sequence[1] : sequence[sequence.length - 2]).trim().toLowerCase();
  const adjacent = allStations.find(
    (s) => (s.schematicId ?? s.id).trim().toLowerCase() === adjacentKey,
  );
  if (!adjacent) return undefined;

  const inferenceMode =
    (lineId ? routeInterpretation?.directionInference?.routeOverrides?.[lineId] : undefined) ??
    routeInterpretation?.directionInference?.default;
  const invertNorthSouth = isNorthSouthDirectionIdsInverted(lineId, routeInterpretation);

  const dLat = adjacent.lat - station.lat;
  const dLon = adjacent.lon - station.lon;
  const isNorthSouth =
    inferenceMode === "north-south"
      ? true
      : inferenceMode === "east-west"
        ? false
        : Math.abs(dLat) >= Math.abs(dLon * Math.cos((station.lat * Math.PI) / 180));

  let departingDirectionId: 0 | 1;
  let rawDepartingDirection: string;

  if (isNorthSouth) {
    if (dLat < 0) {
      departingDirectionId = invertNorthSouth ? 0 : 1;
      rawDepartingDirection = "southbound";
    } else {
      departingDirectionId = invertNorthSouth ? 1 : 0;
      rawDepartingDirection = "northbound";
    }
  } else {
    if (dLon < 0) {
      departingDirectionId = 1;
      rawDepartingDirection = "westbound";
    } else {
      departingDirectionId = 0;
      rawDepartingDirection = "eastbound";
    }
  }

  const terminatingDirectionId: 0 | 1 = departingDirectionId === 0 ? 1 : 0;
  const { label: departingLabel, generatedLabel: departingGeneratedLabel } =
    resolveStationDirection(
      rawDepartingDirection,
      departingDirectionId,
      directionLiterals,
      routeType,
      inferenceMode,
      invertNorthSouth,
    );

  return {
    departingDirectionId,
    departingLabel,
    ...(departingGeneratedLabel ? { departingGeneratedLabel } : {}),
    terminatingDirectionId,
  };
}

type EdgeCache = Pick<Cache, "match" | "put">;

function getEdgeCache(): EdgeCache | undefined {
  const cacheStorage = (
    globalThis as typeof globalThis & {
      caches?: CacheStorage & { readonly default?: EdgeCache };
    }
  ).caches;
  return cacheStorage?.default;
}

function edgeCacheKey(agencyId: string, feeds: readonly RealtimeFeedConfig[]): Request {
  const url = new URL("https://schematic-edge-cache.invalid/station-trip-updates");
  url.searchParams.set("agency", agencyId);
  url.searchParams.set("feeds", JSON.stringify(feeds));
  return new Request(url);
}

async function readEdgeCachedArrivals(
  agencyId: string,
  feeds: readonly RealtimeFeedConfig[],
): Promise<StationArrivals | undefined> {
  const cache = getEdgeCache();
  if (!cache) return undefined;
  const response = await cache.match(edgeCacheKey(agencyId, feeds));
  if (!response) return undefined;
  const entries = (await response.json()) as readonly [string, readonly ArrivalPrediction[]][];
  if (!Array.isArray(entries)) return undefined;
  return new Map(entries);
}

async function writeEdgeCachedArrivals(
  agencyId: string,
  feeds: readonly RealtimeFeedConfig[],
  arrivals: StationArrivals,
): Promise<void> {
  const cache = getEdgeCache();
  if (!cache) return;
  await cache.put(
    edgeCacheKey(agencyId, feeds),
    new Response(JSON.stringify([...arrivals.entries()]), {
      headers: {
        "Cache-Control": `public, max-age=${STATION_EDGE_CACHE_TTL_SECONDS}`,
        "Content-Type": "application/json",
      },
    }),
  );
}

function resolveStationDirection(
  rawDirection: string | undefined,
  predictionDirectionId: number | undefined,
  directionLiterals: Readonly<Record<string, string>> | undefined,
  routeType: SurfaceRouteType | undefined,
  inferenceMode?: "east-west" | "north-south",
  invertNorthSouth = false,
): {
  directionId: 0 | 1;
  label: string;
  generatedLabel?: GeneratedDirectionLabel;
  /** False when nothing stated a direction, so the index alone decided the bucket. */
  stated: boolean;
} {
  let directionId: 0 | 1;
  let label: string | undefined;
  let generatedLabel: GeneratedDirectionLabel | undefined;

  if (rawDirection === "outbound") {
    directionId = 0;
    if (directionLiterals?.outbound !== undefined) label = directionLiterals.outbound;
    else {
      label = generatedDirectionLabelText("outbound");
      generatedLabel = "outbound";
    }
  } else if (rawDirection === "inbound") {
    directionId = 1;
    if (directionLiterals?.inbound !== undefined) label = directionLiterals.inbound;
    else {
      label = generatedDirectionLabelText("inbound");
      generatedLabel = "inbound";
    }
  } else {
    const canonical = rawDirection ? directionLabelFor(rawDirection) : "";
    // A stated compass word decides the index, from the one place that fact
    // lives. When the word states no direction, the feed's own prediction index
    // is all there is to go on.
    directionId =
      directionIdForLabel(canonical, inferenceMode === "north-south" && invertNorthSouth) ??
      (predictionDirectionId === 0 ? 0 : 1);

    if (canonical) {
      const word = canonical.slice(0, -"bound".length).toLowerCase();
      const boundWord = `${word}bound`;
      const configuredLabel =
        rawDirection === boundWord
          ? (directionLiterals?.[boundWord] ?? directionLiterals?.[word])
          : directionLiterals?.[word];
      if (configuredLabel !== undefined) label = configuredLabel;
      else {
        label = canonical;
        generatedLabel = directionSemanticForCanonicalLabel(canonical);
      }
    }
  }

  if (!label) {
    let fallbackLabel: GeneratedDirectionLabel;
    let configuredLabel: string | undefined;
    if (routeType === "rail") {
      fallbackLabel = directionId === 0 ? "outbound" : "inbound";
      configuredLabel =
        directionId === 0 ? directionLiterals?.outbound : directionLiterals?.inbound;
    } else if (inferenceMode === "east-west") {
      fallbackLabel = directionId === 0 ? "eastbound" : "westbound";
      configuredLabel = directionId === 0 ? directionLiterals?.east : directionLiterals?.west;
    } else if (inferenceMode === "north-south") {
      const northboundDirectionId: 0 | 1 = invertNorthSouth ? 1 : 0;
      const isNorthbound = directionId === northboundDirectionId;
      fallbackLabel = isNorthbound ? "northbound" : "southbound";
      configuredLabel = isNorthbound ? directionLiterals?.north : directionLiterals?.south;
    } else {
      // A direction index carries no bearing; only the trip's own headsign can name it.
      return { directionId, label: "", stated: false };
    }
    label = configuredLabel ?? generatedDirectionLabelText(fallbackLabel);
    generatedLabel = configuredLabel === undefined ? fallbackLabel : undefined;
  }

  return { directionId, label, ...(generatedLabel ? { generatedLabel } : {}), stated: true };
}

const STATION_DEPARTURES_STOP_PLACEHOLDER = "{stopId}";
const STATION_DEPARTURES_TIMEOUT_MS = 8_000;

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const result = String(value).trim();
  return result.length > 0 ? result : undefined;
}

function parseStationDepartureMinutes(value: unknown): readonly number[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [value];
  return values
    .map((entry) => {
      if (typeof entry === "string" && entry.trim().length === 0) return Number.NaN;
      return typeof entry === "string" || typeof entry === "number" ? Number(entry) : Number.NaN;
    })
    .filter((minutes) => Number.isFinite(minutes) && minutes >= 0);
}

/** Decodes a per-stop JSON departures response into the shared arrival shape. */
function decodeStationDeparturesJson(
  body: unknown,
  stopId: string,
  now: () => number,
  directionLiterals: Readonly<Record<string, string>> | undefined,
  routeType: SurfaceRouteType | undefined,
  lineIds: readonly string[] | undefined,
): readonly ArrivalPrediction[] {
  if (!Array.isArray(body)) throw new Error("Station departures response was not an array");
  const baseNow = now();
  const arrivals: ArrivalPrediction[] = [];

  for (const [entryIndex, value] of body.entries()) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    const routeId = trimmedString(entry.line);
    if (!routeId || (lineIds?.length && !lineIds.some((id) => routeIdsMatch(routeId, id)))) {
      continue;
    }

    const directionText = trimmedString(entry.directionText);
    const rawDirection = directionText
      ?.match(/\b(?:north|south|east|west)bound\b/i)?.[0]
      .toLowerCase();
    const directionValue = Number(entry.direction);
    const predictionDirectionId =
      directionValue === 0 || directionValue === 1 ? (directionValue as 0 | 1) : undefined;
    const { directionId } = resolveStationDirection(
      rawDirection,
      predictionDirectionId,
      directionLiterals,
      routeType,
    );
    const headsign = directionText?.match(/\b(?:to|towards)\s+(.+)$/i)?.[1]?.trim();

    for (const [predictionIndex, minutes] of parseStationDepartureMinutes(
      entry.nextTrains,
    ).entries()) {
      const predictedTime = baseNow + Math.max(1_000, minutes * 60_000);
      arrivals.push({
        tripId: `station-${stopId}-${routeId}-${directionId}-${entryIndex}-${predictionIndex}`,
        routeId,
        directionId,
        stopSequence: 0,
        stopId,
        predictedTime,
        delaySeconds: 0,
        scheduleRelationship: "SCHEDULED",
        isRealtime: true,
        rawEntityId: `station-${stopId}|${rawDirection ?? directionId}`,
        ...(headsign ? { headsign } : {}),
      });
    }
  }

  return arrivals;
}

/** Builds the Core station panel from a schematic-declared geographic index. */
export function createGenericStationsSource(opts: GenericStationsSourceOptions): StationsSource {
  const networkFeed = resolveNetworkDocumentFeed(opts.feeds);
  if (networkFeed?.kind === "ferry_sailing_boards") {
    if (opts.routeType !== undefined && opts.routeType !== "ferry") {
      throw new Error("ferry sailing boards require ferry station service");
    }
    return createFerrySailingStationsSource({ ...opts, feed: networkFeed });
  }
  if (networkFeed?.kind === "zenbus")
    return createZenbusStationsSource({ ...opts, feed: networkFeed });
  if (networkFeed?.kind === "tsimobile") {
    if (opts.routeType !== undefined && opts.routeType !== "rail") {
      throw new Error("tsimobile requires rail station service");
    }
    return createTsimobileStationsSource({ ...opts, feed: networkFeed });
  }
  if (networkFeed?.kind === "station_timetables")
    return createStationTimetablesStationsSource({ ...opts, feed: networkFeed });
  if (networkFeed?.kind === "train_map") {
    if (opts.routeType !== undefined && opts.routeType !== "rail") {
      throw new Error("train_map requires rail station service");
    }
    return createTrainMapStationsSource({ ...opts, feed: networkFeed });
  }
  const samsara = opts.feeds.find((feed) => feed.kind === "samsara_boards");
  const cityway = opts.feeds.find((feed) => feed.kind === "cityway");
  const passio = opts.feeds.find((feed) => feed.kind === "passio");
  const hubup = opts.feeds.find((feed) => feed.kind === "hubup");
  const tripspark = opts.feeds.find((feed) => feed.kind === "tripspark");
  const bustime = opts.feeds.find((feed) => feed.kind === "bustime");
  const transloc = opts.feeds.find((feed) => feed.kind === "transloc");
  const swiftly = opts.feeds.find((feed) => feed.kind === "swiftly");
  const now = opts.now ?? (() => Date.now());
  const stationTripFeeds = opts.feeds.filter(
    (feed): feed is Extract<RealtimeFeedConfig, { kind: "station_trip_updates" }> =>
      feed.kind === "station_trip_updates",
  );
  const stationDepartureFeeds = opts.feeds.filter(
    (feed): feed is Extract<RealtimeFeedConfig, { kind: "station_departures" }> =>
      feed.kind === "station_departures",
  );
  // Tmix needs no per-station feed declaration: one `tmix_anyride` feed
  // answers departures for every stop the schematic indexes.
  const tmixFeeds = opts.feeds.filter(
    (feed): feed is Extract<RealtimeFeedConfig, { kind: "tmix_anyride" }> =>
      feed.kind === "tmix_anyride",
  );
  const tripFeeds: readonly Extract<
    RealtimeFeedConfig,
    { kind: "station_trip_updates" | "trip_updates" }
  >[] =
    stationTripFeeds.length > 0
      ? stationTripFeeds
      : opts.feeds.filter(
          (feed): feed is Extract<RealtimeFeedConfig, { kind: "trip_updates" }> =>
            feed.kind === "trip_updates",
        );
  const declaredPlatformIds = new Set(
    opts.stations.flatMap((station) => [
      station.id,
      ...(station.schematicId ? [station.schematicId] : []),
      ...station.platformIds,
    ]),
  );
  const relevantStopIds = declaredPlatformIds.size > 0 ? declaredPlatformIds : undefined;

  type StationArrivalsResult = { readonly byStop: StationArrivals; readonly stale: boolean };
  type StationArrivalsState = {
    readonly byStop: StationArrivals;
    readonly generatedAt: number;
    readonly stale?: boolean;
  };

  const refreshArrivals = Effect.gen(function* () {
    if (opts.stations.length === 0) {
      return { byStop: new Map() as StationArrivals, stale: false } satisfies StationArrivalsResult;
    }
    if (tripFeeds.length === 0) {
      // Per-station feeds (declared departures, or Tmix's per-stop GetCalls)
      // serve this path below, so a missing bulk trip feed is not a failure
      // for them. Returning empty rather than failing keeps the shared cache
      // warm and the stale flag off; `getStationArrivals` owns the real data.
      if (
        stationDepartureFeeds.length > 0 ||
        tmixFeeds.length > 0 ||
        swiftly !== undefined ||
        tripspark !== undefined ||
        bustime !== undefined ||
        samsara !== undefined ||
        cityway !== undefined ||
        passio !== undefined ||
        hubup !== undefined ||
        transloc !== undefined
      ) {
        return {
          byStop: new Map() as StationArrivals,
          stale: false,
        } satisfies StationArrivalsResult;
      }
      return yield* Effect.fail(
        new StationsError({
          agencyId: opts.agencyId,
          message: `Missing trip_updates feed for ${opts.agencyId}`,
        }),
      );
    }
    const usesStaticPredictions = tripFeeds.some(
      (feed) => feed.predictionTimeSource === "static-with-delay" || feed.stopIdAliases,
    );
    const edgeCached = usesStaticPredictions
      ? undefined
      : yield* Effect.promise(() =>
          readEdgeCachedArrivals(opts.agencyId, tripFeeds).catch(() => undefined),
        );
    if (edgeCached) {
      return { byStop: edgeCached, stale: false } satisfies StationArrivalsResult;
    }
    const [{ usable, firstError }, cancelledTripIds] = yield* Effect.all(
      [
        fetchDecodedFeeds(
          tripFeeds
            .filter((feed) => feedMatchesScope(feed, { stopIds: relevantStopIds }))
            .map((tripFeed) => ({
              url: tripFeed.url,
              auth: tripFeed.auth,
              devProxyPrefix: tripFeed.devProxyPrefix,
              format: tripFeed.format,
              accept: tripFeed.accept,
              decode: (bytes: Uint8Array) =>
                resolveTripRoutes(
                  bytes,
                  opts.getRoutesForTrips,
                  opts.restrictToSeededTrips ? "static" : tripFeed.tripDirectionSource,
                  tripFeed.idNamespace,
                ).pipe(
                  // A feed with no decodable entities throws; keep that a typed
                  // feed failure rather than a defect that aborts every feed.
                  Effect.flatMap((tripRoutes) =>
                    prepareScheduledPredictions(bytes, {
                      ...tripFeed,
                      tripRoutes,
                      getScheduledStopTimes: opts.getScheduledStopTimes,
                      getSourceAgencyScope: opts.getSourceAgencyScope,
                      stopIds: relevantStopIds,
                    }).pipe(
                      Effect.flatMap((predictionOptions) =>
                        Effect.try(() => {
                          const arrivals = decodeStationTripUpdates(
                            bytes,
                            relevantStopIds,
                            tripRoutes,
                            predictionOptions,
                          );
                          return opts.restrictToSeededTrips
                            ? selectSeededTrips(arrivals, tripRoutes)
                            : arrivals;
                        }),
                      ),
                    ),
                  ),
                ),
              mapError: (cause: unknown) =>
                cause instanceof TransportFailure
                  ? new StationsError({
                      agencyId: opts.agencyId,
                      message: "Station trip feed unavailable",
                      cause,
                    })
                  : new StationsError({
                      agencyId: opts.agencyId,
                      message: cause instanceof Error ? cause.message : String(cause),
                      cause,
                    }),
            })),
          {
            fetch: opts.fetch,
            getSecret: opts.getSecret,
            devProxyOrigin: opts.devProxyOrigin,
            // The TTC subway host intermittently resets Worker-originated
            // connections. A short bounded retry avoids turning one transport
            // blip into a panel-wide Last known state.
            attempts: STATION_FEED_FETCH_ATTEMPTS,
            retryDelayMs: STATION_FEED_RETRY_DELAY_MS,
            timeoutMs: 8_000,
          },
        ),
        // Read alongside the trip feed, so cancellations add no round trip.
        fetchCancelledTripIds(
          cancelledTripsSources(tripFeeds),
          { fetch: opts.fetch, getSecret: opts.getSecret, devProxyOrigin: opts.devProxyOrigin },
          opts.now ?? (() => Date.now()),
        ),
      ],
      { concurrency: 2 },
    );
    if (usable.length === 0) {
      return yield* Effect.fail(
        firstError ??
          new StationsError({
            agencyId: opts.agencyId,
            message: `No usable trip_updates feed for ${opts.agencyId}`,
          }),
      );
    }
    const byStop = new Map<string, ArrivalPrediction[]>();
    for (const feed of usable) {
      for (const prediction of dropCancelledTrips(feed, cancelledTripIds)) {
        if (!prediction.stopId) continue;
        const values = byStop.get(prediction.stopId) ?? [];
        values.push(prediction);
        byStop.set(prediction.stopId, values);
      }
    }
    if (firstError === undefined && !usesStaticPredictions) {
      yield* Effect.promise(() =>
        writeEdgeCachedArrivals(opts.agencyId, tripFeeds, byStop).catch(() => undefined),
      );
    } else if (firstError !== undefined) {
      logger.warn(`${opts.agencyId} station trip feeds are partial`, {
        agencyId: opts.agencyId,
        hasUsableFeed: true,
      });
    }
    return {
      byStop: byStop as StationArrivals,
      stale: firstError !== undefined,
    } satisfies StationArrivalsResult;
  });

  let arrivalsCache!: ReturnType<typeof createSwrFeedCache<StationArrivalsState>>;
  arrivalsCache = createSwrFeedCache<StationArrivalsState>({
    label: `${opts.agencyId} station trip updates`,
    ttlMs: STATION_FEED_CACHE_TTL_MS,
    initialState: { byStop: new Map(), generatedAt: 0 },
    expiryPolicy: "join-refresh",
    onRefreshFailure: "throw",
    failureTtlMs: STATION_FEED_FAILURE_TTL_MS,
    refresh: async () => {
      const refreshed = await Effect.runPromise(refreshArrivals);
      const previous = arrivalsCache.peek().byStop;
      return {
        // Partial results are useful now, but a missing feed must not erase its last-good trips.
        byStop: refreshed.stale
          ? mergeStationArrivals(previous, refreshed.byStop)
          : refreshed.byStop,
        generatedAt: Date.now(),
        stale: refreshed.stale,
      };
    },
  });

  const getArrivals = Effect.tryPromise({
    try: () => arrivalsCache.get(),
    catch: (cause) => cause,
  }).pipe(
    Effect.map(
      ({ byStop, stale }) => ({ byStop, stale: stale === true }) satisfies StationArrivalsResult,
    ),
    // Station identity is useful even when a provider's live feed is not
    // configured. Keep the last good predictions, or an empty map on the
    // first request, and mark the card honestly.
    Effect.catch(() =>
      Effect.succeed({
        byStop: arrivalsCache.peek().byStop,
        stale: true,
      } satisfies StationArrivalsResult),
    ),
  );

  const stationDepartureCaches = new Map<
    string,
    ReturnType<typeof createSwrFeedCache<StationArrivalsState>>
  >();

  const feedsForStation = (
    station: SchematicStationIndexEntry,
  ): readonly Extract<RealtimeFeedConfig, { kind: "station_departures" }>[] =>
    stationDepartureFeeds.filter(
      (feed) =>
        !feed.lineIds?.length ||
        feed.lineIds.some((feedLineId) =>
          departureLines(station).some((stationLineId) => routeIdsMatch(feedLineId, stationLineId)),
        ),
    );

  /**
   * Departures for one station from Tmix's per-stop `GetCalls`, keyed by the
   * GTFS platform id the query used.
   */
  const fetchTmixStationCalls = async (
    station: SchematicStationIndexEntry,
    feeds: readonly Extract<RealtimeFeedConfig, { kind: "tmix_anyride" }>[],
  ): Promise<StationArrivalsResult> => {
    return Effect.runPromise(
      fetchTmixStationArrivals({
        agencyId: opts.agencyId,
        platformIds: station.platformIds,
        feeds,
        fetch: opts.fetch,
        devProxyOrigin: opts.devProxyOrigin,
        getSecret: opts.getSecret,
        project: (call, stopId) =>
          inferTmixCallDirection(call, {
            directionTermini: station.directionTermini,
            stopId,
          }),
      }).pipe(
        Effect.map(({ byStop, partial }) => ({ byStop, stale: partial })),
        Effect.mapError(
          (cause) =>
            new StationsError({
              agencyId: opts.agencyId,
              message: `Tmix departure feed unavailable for ${station.id}`,
              cause,
            }),
        ),
      ),
    );
  };

  const tmixFeedsForStation = (
    station: SchematicStationIndexEntry,
  ): readonly Extract<RealtimeFeedConfig, { kind: "tmix_anyride" }>[] =>
    tmixFeeds.filter(
      (feed) =>
        !feed.lineIds?.length ||
        feed.lineIds.some((feedLineId) =>
          departureLines(station).some((stationLineId) => routeIdsMatch(feedLineId, stationLineId)),
        ),
    );

  const fetchStationDepartures = async (
    station: SchematicStationIndexEntry,
    feeds: readonly Extract<RealtimeFeedConfig, { kind: "station_departures" }>[],
  ): Promise<StationArrivalsResult> => {
    const requests = feeds.flatMap((feed) =>
      station.platformIds.map((stopId) => async () => {
        if (feed.responseMapping && feed.method !== "POST")
          return { stopId, predictions: await fetchMappedStationDepartures(opts, feed, stopId) };
        const templateUrl = feed.url;
        const requestUrl = templateUrl.replaceAll(
          STATION_DEPARTURES_STOP_PLACEHOLDER,
          encodeURIComponent(stopId),
        );
        const date = new Intl.DateTimeFormat("en-CA", {
          timeZone: feed.dateTimezone ?? "UTC",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(now()));
        const bodyTemplate = feed.bodyTemplate;
        if (
          requestUrl === templateUrl &&
          !Object.values(bodyTemplate ?? {}).some((value) =>
            value.includes(STATION_DEPARTURES_STOP_PLACEHOLDER),
          )
        ) {
          throw new Error("Station departures request is missing the {stopId} placeholder");
        }
        const requestBody = bodyTemplate
          ? JSON.stringify(
              Object.fromEntries(
                Object.entries(bodyTemplate).map(([key, value]) => [
                  key,
                  value
                    .replaceAll(STATION_DEPARTURES_STOP_PLACEHOLDER, stopId)
                    .replaceAll("{date}", date),
                ]),
              ),
            )
          : undefined;

        const { usable, firstError } = await Effect.runPromise(
          fetchDecodedFeeds(
            [
              {
                url: requestUrl,
                auth: feed.auth,
                devProxyPrefix: feed.devProxyPrefix,
                format: "json",
                method: feed.method ?? "GET",
                ...(requestBody ? { body: requestBody } : {}),
                decode: (bytes) =>
                  Effect.try({
                    try: () => {
                      const body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
                      return {
                        stopId,
                        predictions: feed.responseMapping
                          ? decodeMappedStationDepartures(
                              body,
                              stopId,
                              feed.responseMapping,
                              feed.lineIds,
                            )
                          : decodeStationDeparturesJson(
                              body,
                              stopId,
                              now,
                              opts.directionLiterals,
                              opts.routeType,
                              feed.lineIds,
                            ),
                      };
                    },
                    catch: (cause) => cause,
                  }),
                mapError: (cause) => cause,
              },
            ],
            {
              fetch: opts.fetch,
              getSecret: opts.getSecret,
              devProxyOrigin: opts.devProxyOrigin,
              attempts: 1,
              timeoutMs: STATION_DEPARTURES_TIMEOUT_MS,
            },
          ),
        );
        const departure = usable[0];
        if (departure === undefined) {
          throw firstError ?? new Error("Station departures response was not usable");
        }
        return departure;
      }),
    );
    const results = await settleWithConcurrency(requests, STATION_DEPARTURES_CONCURRENCY);
    const byStop = new Map<string, ArrivalPrediction[]>();
    let failedRequests = 0;
    for (const result of results) {
      if (result?.status === "rejected") {
        failedRequests += 1;
        continue;
      }
      if (result?.status !== "fulfilled") continue;
      const values = byStop.get(result.value.stopId) ?? [];
      values.push(...result.value.predictions);
      byStop.set(result.value.stopId, values);
    }
    if (failedRequests > 0) {
      logger.warn(`${opts.agencyId} station departures are partial`, {
        agencyId: opts.agencyId,
        failedRequests,
        totalRequests: requests.length,
      });
    }
    return { byStop, stale: failedRequests > 0 };
  };

  const getStationArrivals = (
    station: SchematicStationIndexEntry,
  ): Effect.Effect<StationArrivalsResult> => {
    const feeds = feedsForStation(station);
    const tmix = tmixFeedsForStation(station);
    if (
      (feeds.length === 0 &&
        tmix.length === 0 &&
        !samsara &&
        !cityway &&
        !passio &&
        !hubup &&
        !swiftly &&
        !transloc &&
        !bustime &&
        !tripspark) ||
      station.platformIds.length === 0
    ) {
      return Effect.succeed({ byStop: new Map(), stale: false });
    }

    const cacheKey = `${station.id}:${[...feeds, ...tmix].map((feed) => feed.url).join("|")}`;
    let cache = stationDepartureCaches.get(cacheKey);
    if (!cache) {
      cache = createSwrFeedCache<StationArrivalsState>({
        label: `${opts.agencyId} station departures ${station.id}`,
        ttlMs: STATION_FEED_CACHE_TTL_MS,
        initialState: { byStop: new Map(), generatedAt: 0 },
        expiryPolicy: "join-refresh",
        onRefreshFailure: "throw",
        failureTtlMs: STATION_FEED_FAILURE_TTL_MS,
        refresh: async () => {
          const previous = cache!.peek().byStop;
          let refreshed: StationArrivalsResult;
          if (
            samsara ||
            cityway ||
            passio ||
            hubup ||
            swiftly ||
            transloc ||
            bustime ||
            tripspark
          ) {
            const arrivalOptions = {
              ...opts,
              stopIds: new Set(station.platformIds),
              routeIds: new Set(station.departureRouteIds),
            };
            const result = await (samsara
              ? fetchSamsaraBoards(samsara, arrivalOptions)
              : cityway
                ? fetchCitywayArrivals(cityway, arrivalOptions)
                : passio
                  ? fetchPassioArrivals(passio, arrivalOptions)
                  : hubup
                    ? fetchHubupArrivals(hubup, arrivalOptions)
                    : tripspark
                      ? fetchTripSparkArrivals(tripspark, arrivalOptions)
                      : bustime
                        ? fetchBusTimeArrivals(bustime, arrivalOptions)
                        : transloc
                          ? fetchTranslocArrivals(transloc, arrivalOptions)
                          : fetchSwiftlyArrivals(swiftly!, arrivalOptions));
            const byStop = new Map<string, ArrivalPrediction[]>();
            for (const arrival of result.arrivals) {
              const rows = byStop.get(arrival.stopId!) ?? [];
              rows.push(arrival);
              byStop.set(arrival.stopId!, rows);
            }
            refreshed = { byStop, stale: result.partial };
          } else if (tmix.length > 0 && feeds.length > 0) {
            const [tmixResult, feedResult] = await Promise.allSettled([
              fetchTmixStationCalls(station, tmix),
              fetchStationDepartures(station, feeds),
            ]);
            if (tmixResult.status === "rejected" && feedResult.status === "rejected") {
              throw tmixResult.reason;
            }
            const merged = new Map<string, readonly ArrivalPrediction[]>(
              tmixResult.status === "fulfilled" ? tmixResult.value.byStop : [],
            );
            if (feedResult.status === "fulfilled") {
              for (const [stopId, preds] of feedResult.value.byStop) {
                const existing = merged.get(stopId) ?? [];
                merged.set(stopId, [...existing, ...preds]);
              }
            }
            refreshed = {
              byStop: merged,
              stale:
                tmixResult.status === "rejected" ||
                feedResult.status === "rejected" ||
                (tmixResult.status === "fulfilled" && tmixResult.value.stale) ||
                (feedResult.status === "fulfilled" && feedResult.value.stale),
            };
          } else if (tmix.length > 0) {
            refreshed = await fetchTmixStationCalls(station, tmix);
          } else {
            refreshed = await fetchStationDepartures(station, feeds);
          }
          return {
            // Keep the last complete platform predictions when this refresh lost a request.
            byStop: refreshed.stale
              ? mergeStationArrivals(previous, refreshed.byStop)
              : refreshed.byStop,
            generatedAt: Date.now(),
            stale: refreshed.stale,
          };
        },
      });
      stationDepartureCaches.set(cacheKey, cache);
    }

    return Effect.tryPromise({
      try: () => cache!.get(),
      catch: (cause) => cause,
    }).pipe(
      Effect.map(
        ({ byStop, stale }) => ({ byStop, stale: stale === true }) satisfies StationArrivalsResult,
      ),
      Effect.catch(() =>
        Effect.succeed({
          byStop: cache!.peek().byStop,
          stale: true,
        } satisfies StationArrivalsResult),
      ),
    );
  };

  const normalizeRouteId = (routeId?: string): string | undefined => {
    if (!routeId) return undefined;
    const stripped = canonicalDepartureRouteIds.has(routeId)
      ? routeId
      : routeId.slice(routeId.lastIndexOf("-") + 1).trim();
    const canonical = opts.routeLineMap?.[routeId] ?? opts.routeLineMap?.[stripped] ?? stripped;
    // Vendor labels can name a canonical route which itself belongs to a shared
    // schematic corridor. Cards compare corridor identities, while the surface
    // realtime adapter keeps the first translation as the canonical route ID.
    return opts.routeLineMap?.[canonical] ?? canonical;
  };
  const canonicalDepartureRouteIds = new Set(
    opts.stations.flatMap((station) => station.departureRouteIds ?? []),
  );
  const stationByStop = new Map<string, SchematicStationIndexEntry>();
  for (const station of opts.stations)
    for (const stopId of station.platformIds)
      if (!stationByStop.has(stopId)) stationByStop.set(stopId, station);
  /** A trip's end as a rider names it: its terminal station, else its scheduled headsign. */
  const scheduledDestinationFor = (
    terminal: TripTerminal | undefined,
    station: SchematicStationIndexEntry,
    routeId: string | undefined,
  ): string | undefined => {
    if (!terminal) return undefined;
    const end = stationByStop.get(terminal.stopId);
    // A trip ending here names this station; it tells the rider nothing.
    if (end) return end.id === station.id ? undefined : end.name;
    return scheduledHeadsignDestination(terminal.headsign, routeId);
  };
  const staticRouteId = (routeId: string): string => {
    if (canonicalDepartureRouteIds.has(routeId)) return routeId;
    const canonical = opts.routeLineMap?.[routeId];
    if (canonical && canonicalDepartureRouteIds.has(canonical)) return canonical;
    return opts.staticRouteIdField === "short_name"
      ? (normalizeRouteId(routeId) ?? routeId)
      : routeId;
  };

  const getArrivalsForStations = (
    stations: readonly SchematicStationIndexEntry[],
  ): Effect.Effect<
    {
      readonly byStop: StationArrivals;
      readonly terminalsByRoute: ReadonlyMap<string, ReadonlyMap<string, TripTerminal>>;
      readonly directionsByRoute: ReadonlyMap<string, ReadonlyMap<string, number>>;
      readonly staleStationIds: ReadonlySet<string>;
    },
    StationsError
  > =>
    Effect.gen(function* () {
      const tripArrivals = yield* getArrivals;
      const stationResults = yield* Effect.all(
        stations.map((station) => getStationArrivals(station)),
      );
      // A nested operator board owns its returned stops, including empty boards.
      // Bulk trip predictions must not reintroduce cancelled or removed calls.
      const authoritativeFeedsByStop = new Map<string, typeof stationDepartureFeeds>();
      stations.forEach((station, index) => {
        const mappedFeeds = feedsForStation(station).filter((feed) => feed.responseMapping);
        for (const stopId of stationResults[index]?.byStop.keys() ?? []) {
          const existing = authoritativeFeedsByStop.get(stopId) ?? [];
          authoritativeFeedsByStop.set(stopId, [...existing, ...mappedFeeds]);
        }
      });
      const byStop = new Map<string, ArrivalPrediction[]>();
      const staleStationIds = new Set<string>();
      if (tripArrivals.stale) {
        for (const station of stations) staleStationIds.add(station.id);
      }
      stations.forEach((station, index) => {
        if (stationResults[index]?.stale) staleStationIds.add(station.id);
      });
      const keepPrediction = (routeId: string): boolean =>
        opts.predictionFilter ? opts.predictionFilter(routeId) : true;
      for (const result of [tripArrivals, ...stationResults]) {
        for (const [stopId, predictions] of result.byStop) {
          for (const prediction of predictions) {
            if (!keepPrediction(prediction.routeId)) continue;
            if (
              result === tripArrivals &&
              authoritativeFeedsByStop
                .get(stopId)
                ?.some(
                  (feed) =>
                    !feed.lineIds?.length ||
                    feed.lineIds.some((id) => routeIdsMatch(id, prediction.routeId)),
                )
            )
              continue;
            const values = byStop.get(stopId) ?? [];
            values.push(prediction);
            byStop.set(stopId, values);
          }
        }
      }
      const terminalsByRoute = new Map<string, ReadonlyMap<string, TripTerminal>>();
      const directionsByRoute = new Map<string, ReadonlyMap<string, number>>();
      if (opts.getTripTerminals || opts.getDirectionsForTrips) {
        const wantedStops = new Set(
          stations.flatMap((station) => [
            ...station.platformIds,
            station.id,
            station.schematicId ?? station.id,
          ]),
        );
        const tripsByRoute = new Map<string, Set<string>>();
        for (const [stopId, predictions] of byStop) {
          if (!wantedStops.has(stopId)) continue;
          for (const prediction of predictions) {
            const routeId = staticRouteId(prediction.routeId);
            if (!routeId) continue;
            const ids = tripsByRoute.get(routeId) ?? new Set<string>();
            ids.add(prediction.tripId);
            tripsByRoute.set(routeId, ids);
          }
        }
        yield* Effect.forEach(
          [...tripsByRoute],
          ([routeId, ids]) =>
            Effect.all({
              terminals:
                opts.getTripTerminals?.(routeId, [...ids]) ??
                Effect.succeed(new Map<string, TripTerminal>()),
              directions:
                opts.getDirectionsForTrips?.(routeId, [...ids]) ??
                Effect.succeed(new Map<string, number>()),
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new StationsError({
                    agencyId: opts.agencyId,
                    message: "Static trip boarding facts unavailable",
                    cause,
                  }),
              ),
              Effect.tap(({ terminals, directions }) =>
                Effect.sync(() => {
                  terminalsByRoute.set(routeId, terminals);
                  directionsByRoute.set(routeId, directions);
                }),
              ),
            ),
          { concurrency: 4 },
        );
      }
      return {
        byStop,
        terminalsByRoute,
        directionsByRoute,
        staleStationIds,
      };
    });

  const departureLines = (station: SchematicStationIndexEntry): readonly string[] => {
    const routes = station.departureRouteIds ?? station.lines;
    return [
      ...new Set(
        routes
          .filter((id) => {
            const feedRouteId =
              Object.entries(opts.routeLineMap ?? {}).find(([, line]) => line === id)?.[0] ?? id;
            return opts.predictionFilter?.(feedRouteId) ?? true;
          })
          .map((id) => normalizeRouteId(id) ?? id),
      ),
    ];
  };
  const servesStation = (station: SchematicStationIndexEntry): boolean =>
    !opts.predictionFilter || departureLines(station).length > 0;

  const attach = (
    station: SchematicStationIndexEntry,
    arrivalsByStop: StationArrivals,
    lat: number,
    lon: number,
    arrivalsStale: boolean,
    terminalsByRoute: ReadonlyMap<string, ReadonlyMap<string, TripTerminal>>,
    directionsByRoute: ReadonlyMap<string, ReadonlyMap<string, number>>,
    lineId?: string,
  ): NearbyStationArrival => {
    // Static terminals decide boarding whenever a lookup is supplied, including
    // branches and short turns at intermediate schematic stations. Unknown
    // trips retain their feed direction. The schematic/sequence fallback below
    // serves sources without a static trip lookup.
    // A trip that ends at a line terminus is an arrival, never a departure:
    // no revenue track runs beyond it, so its platform predictions would
    // otherwise render as departures for a direction that does not leave.
    // Terminus detection rides the schematic sequences (first/last id), and
    // each trip's furthest stop sequence distinguishes an arrival into the
    // turnaround from a departure leaving it. Terminating arrivals never render
    // under the terminating direction; when a route turns around with no active
    // departing trips in the feed yet, they populate that valid direction.
    const terminusLines = lineId ? [lineId] : station.lines;
    const terminusConfigs = new Map<string, TerminusConfig>();
    for (const id of terminusLines) {
      const config = resolveTerminusConfig(
        station,
        id,
        opts.lineSequences,
        opts.stations,
        opts.directionLiterals,
        opts.routeType,
        opts.routeInterpretation,
      );
      if (config) {
        terminusConfigs.set(id, config);
      }
    }

    const tripFurthestSequence =
      terminusConfigs.size > 0
        ? furthestStopSequences(arrivalsByStop, (routeId) => {
            const normalizedRouteId = normalizeRouteId(routeId);
            return lineId ? routeIdsMatch(normalizedRouteId, lineId) : true;
          })
        : undefined;

    const getTerminusConfigForRoute = (routeId?: string): TerminusConfig | undefined => {
      if (terminusConfigs.size === 0) return undefined;
      if (lineId) return terminusConfigs.get(lineId);
      if (!routeId) return undefined;
      for (const [id, config] of terminusConfigs.entries()) {
        if (routeIdsMatch(routeId, id)) return config;
      }
      return undefined;
    };

    type DepartureBucket = {
      directionId: 0 | 1;
      label: string;
      generatedLabel?: GeneratedDirectionLabel;
      directionName: string;
      lineId?: string;
      headsign?: string;
      times: number[];
      /**
       * Every prediction in this bucket had its direction inferred rather than
       * read from the operator. Drives the headsign preference below.
       */
      directionInferred: boolean;
      headsignPreferred: boolean;
      /** Where the trips go by the static schedule, for rows the feed leaves unnamed. */
      scheduledDestination?: string;
    };
    const grouped = new Map<string, DepartureBucket>();
    const turnaroundArrivals = new Map<string, number[]>();

    const stopKeys = [
      ...station.platformIds,
      station.id,
      ...(station.schematicId ? [station.schematicId] : []),
    ];
    const seenPredictionKeys = new Set<string>();
    const listedTripTimes = new Map<string, number[]>();
    const stationPredictions = stopKeys
      .flatMap((stopKey) => arrivalsByStop.get(stopKey) ?? [])
      .sort((first, second) => first.predictedTime - second.predictedTime);

    for (const prediction of stationPredictions) {
      const predKey = `${prediction.tripId}:${prediction.predictedTime}:${prediction.stopSequence}`;
      if (seenPredictionKeys.has(predKey)) continue;
      seenPredictionKeys.add(predKey);

      const normalizedRouteId = normalizeRouteId(prediction.routeId);
      if (lineId) {
        if (!routeIdsMatch(normalizedRouteId, lineId)) continue;
      } else if (
        departureLines(station).length > 0 &&
        !departureLines(station).some((l) => routeIdsMatch(normalizedRouteId, l))
      ) {
        continue;
      }
      if (prediction.scheduleRelationship === "SKIPPED" || prediction.predictedTime <= now())
        continue;

      const targetRouteId = normalizedRouteId ?? prediction.routeId;
      const terminal = terminalsByRoute
        .get(staticRouteId(prediction.routeId))
        ?.get(prediction.tripId);
      if (isTerminatingPrediction(prediction, terminal)) continue;
      const inferenceMode =
        (targetRouteId
          ? opts.routeInterpretation?.directionInference?.routeOverrides?.[targetRouteId]
          : undefined) ?? opts.routeInterpretation?.directionInference?.default;
      const invertNorthSouth = targetRouteId
        ? isNorthSouthDirectionIdsInverted(targetRouteId, opts.routeInterpretation)
        : false;

      // Direction vocabulary resolves via resolveStationDirection (agency directionLiterals
      // override canonical label per word, falling back to routeType direction defaults).
      const rawDirection = prediction.rawEntityId?.split("|").at(-1)?.trim().toLowerCase();
      const joinedDirection = directionsByRoute
        .get(staticRouteId(prediction.routeId))
        ?.get(prediction.tripId);
      let { directionId, label, generatedLabel, stated } = resolveStationDirection(
        rawDirection,
        joinedDirection ?? prediction.directionId,
        opts.directionLiterals,
        opts.routeType,
        inferenceMode,
        invertNorthSouth,
      );

      const terminus = getTerminusConfigForRoute(normalizedRouteId ?? prediction.routeId);
      const furthestStopSequence = tripFurthestSequence?.get(prediction.tripId);
      const hasSequenceEvidence = prediction.stopSequence > 0 || furthestStopSequence !== undefined;
      const tripEndsAtStation =
        furthestStopSequence !== undefined && furthestStopSequence <= prediction.stopSequence;
      const isAmbiguousTerminusDeparture =
        terminus !== undefined &&
        tripEndsAtStation &&
        directionId === terminus.departingDirectionId;
      // Without per-trip sequence evidence, topology plus direction is the
      // only available terminal signal. Never let a sequence-less platform
      // feed's zero sentinel masquerade as a one-stop trip; treat its
      // terminating-direction prediction as an arrival and preserve the
      // existing turnaround fallback if no departure is present.
      const sequenceLessTerminatingArrival =
        terminus !== undefined &&
        !hasSequenceEvidence &&
        directionId === terminus.terminatingDirectionId;
      if (
        // Gate on the resolved fact for this trip, not on whether a lookup
        // was injected. Presence of the callback says nothing about whether
        // it answered: an unseeded table returns nothing, and gating on
        // presence would disable this handling agency-wide and re-render a
        // terminating arrival as a departure to its own terminal.
        prediction.directionAuthoritative !== true &&
        terminal === undefined &&
        joinedDirection === undefined &&
        terminus &&
        ((tripEndsAtStation && !isAmbiguousTerminusDeparture) || sequenceLessTerminatingArrival)
      ) {
        // Terminating arrival at a line terminus: trains/buses arrive and turn around.
        // Never render this under the terminating direction (e.g. Northbound at Finch).
        // Stash for turnaround fallback if no departing trips exist in the feed.
        const routeKey = lineId ?? normalizedRouteId ?? prediction.routeId ?? "default";
        const times = turnaroundArrivals.get(routeKey) ?? [];
        times.push(prediction.predictedTime);
        turnaroundArrivals.set(routeKey, times);
        continue;
      }

      // At a line terminus, an outgoing departure can only depart into the line
      // in the valid departing direction.
      if (
        // Gate on the resolved fact for this trip, not on whether a lookup
        // was injected. Presence of the callback says nothing about whether
        // it answered: an unseeded table returns nothing, and gating on
        // presence would disable this handling agency-wide and re-render a
        // terminating arrival as a departure to its own terminal.
        prediction.directionAuthoritative !== true &&
        terminal === undefined &&
        joinedDirection === undefined &&
        terminus &&
        !tripEndsAtStation
      ) {
        directionId = terminus.departingDirectionId;
        label = terminus.departingLabel;
        generatedLabel = terminus.departingGeneratedLabel;
        stated = true;
      }

      // One visit across several kerbs lists once; a circuit's later pass stays.
      if (prediction.tripId) {
        const listed = listedTripTimes.get(prediction.tripId) ?? [];
        if (listed.some((time) => prediction.predictedTime - time < SAME_VISIT_MS)) continue;
        listedTripTimes.set(prediction.tripId, [...listed, prediction.predictedTime]);
      }

      const predLineId =
        lineId ??
        station.lines.find((l) => routeIdsMatch(normalizedRouteId, l)) ??
        normalizedRouteId ??
        (station.lines.length === 1 ? station.lines[0] : undefined);

      // Trips sharing a service direction can head to different terminals
      // (both Lakeshore legs read northbound leaving Union). Bucket by
      // headsign so they never merge; labels stay plain unless buckets
      // actually collide.
      const headsign = prediction.headsign;
      // A rail trip can end beyond the simplified drawing or turn short.
      const scheduledDestination =
        headsign || (label && opts.routeType !== "rail")
          ? undefined
          : scheduledDestinationFor(terminal, station, targetRouteId);
      const key = `${predLineId ?? ""}:${directionId}:${label}:${headsign ?? scheduledDestination ?? ""}`;
      const group = grouped.get(key) ?? {
        directionId,
        label,
        ...(generatedLabel ? { generatedLabel } : {}),
        directionName: label,
        lineId: predLineId,
        headsign,
        times: [],
        directionInferred: prediction.directionInferred === true,
        headsignPreferred: prediction.headsignPreferred === true || !stated,
        ...(scheduledDestination ? { scheduledDestination } : {}),
      };
      group.times.push(prediction.predictedTime);
      grouped.set(key, group);
    }

    // Turnaround fallback: if a route terminates and turns around, but no active departing
    // trips are present in the feed yet, the terminating arrivals become the departures in
    // the valid departing direction so departures are not lost.
    for (const [id, terminus] of terminusConfigs.entries()) {
      const hasDepartures = [...grouped.values()].some(
        (group) =>
          (!group.lineId || routeIdsMatch(group.lineId, id)) &&
          group.directionId === terminus.departingDirectionId,
      );
      if (!hasDepartures) {
        const routeKey = lineId ?? id;
        const times = turnaroundArrivals.get(routeKey);
        if (times && times.length > 0) {
          const key = `${id}:${terminus.departingDirectionId}:${terminus.departingLabel}:`;
          const group = grouped.get(key) ?? {
            directionId: terminus.departingDirectionId,
            label: terminus.departingLabel,
            ...(terminus.departingGeneratedLabel
              ? { generatedLabel: terminus.departingGeneratedLabel }
              : {}),
            directionName: terminus.departingLabel,
            lineId: id,
            times: [],
            // Turnaround buckets reuse schematic topology, which *did* establish
            // the direction, so this is a real direction and not an inference.
            directionInferred: false,
            headsignPreferred: false,
          };
          group.times.push(...times);
          grouped.set(key, group);
        }
      }
    }
    const familySizes = new Map<string, number>();
    for (const group of grouped.values()) {
      const family = `${group.lineId ?? ""}:${group.directionId}:${group.label}`;
      familySizes.set(family, (familySizes.get(family) ?? 0) + 1);
    }

    const isTransfer = !lineId && departureLines(station).length > 1;

    const directionRank = (directionName: string): number => {
      const lower = directionName.toLowerCase();
      if (lower.includes("north")) return 0;
      if (lower.includes("south")) return 1;
      if (lower.includes("west")) return 2;
      if (lower.includes("east")) return 3;
      if (lower.includes("outbound")) return 4;
      if (lower.includes("inbound")) return 5;
      return 6;
    };

    const arrivals: NearbyStationArrivalGroup[] = [...grouped.values()]
      .map((group) => {
        const times = [...new Set(group.times)].sort((a, b) => a - b);
        const deduped: number[] = [];
        for (const time of times) {
          if (deduped.length === 0 || time - deduped[deduped.length - 1] >= 60_000) {
            deduped.push(time);
          }
        }
        const collides =
          (familySizes.get(`${group.lineId ?? ""}:${group.directionId}:${group.label}`) ?? 0) > 1;
        // A named destination replaces the direction word outright. Rail
        // headsigns are useful even when they do not split a direction; other
        // modes use them only to distinguish colliding direction buckets.
        //
        // The third case is the one that is not about splitting buckets at all.
        // When the feed published no direction and the adapter inferred
        // `directionId` from other evidence, the direction word on screen is
        // *our* claim, not the operator's — so the operator's own headsign
        // outranks it. Absent `directionInferred` (every GTFS-RT feed) this
        // reduces to `routeType === "rail" || collides`, which is the
        // pre-existing rule unchanged.
        const terminal = station.directionTermini?.[group.label.toLowerCase()];
        const railDestination =
          opts.routeType === "rail"
            ? railTerminalForDirection(
                group.lineId ?? lineId,
                group.directionId,
                opts.lineSequences,
                opts.stations,
              )
            : undefined;
        const liveDestination =
          opts.routeType === "rail" ||
          collides ||
          group.directionInferred ||
          group.headsignPreferred
            ? group.headsign
            : undefined;
        const destination =
          liveDestination ?? group.scheduledDestination ?? terminal ?? railDestination;
        const isTerminalDeparture =
          getTerminusConfigForRoute(group.lineId)?.departingDirectionId === group.directionId;
        return {
          directionId: group.directionId,
          label: destination ? `→ ${destination}` : group.label,
          ...(!destination && group.generatedLabel ? { generatedLabel: group.generatedLabel } : {}),
          times: deduped.slice(0, 3),
          directionName: group.directionName,
          lineId: group.lineId,
          needsLineBadge: terminal !== undefined || isTerminalDeparture,
        };
      })
      .filter((group) => group.times.length > 0)
      .sort((a, b) => {
        if (isTransfer) {
          if (a.lineId && b.lineId && a.lineId !== b.lineId) {
            return a.lineId.localeCompare(b.lineId, undefined, { numeric: true });
          }
          const rankA = directionRank(a.directionName);
          const rankB = directionRank(b.directionName);
          if (rankA !== rankB) return rankA - rankB;
        }
        return a.times[0] - b.times[0];
      })
      .map(({ directionId, label, generatedLabel, times, lineId: rowLineId, needsLineBadge }) => ({
        directionId,
        label,
        ...(generatedLabel ? { generatedLabel } : {}),
        times,
        ...(rowLineId && (isTransfer || needsLineBadge || opts.predictionFilter !== undefined)
          ? { lineId: rowLineId }
          : {}),
      }));
    const distanceMeters = calculateHaversineMeters(lat, lon, station.lat, station.lon);
    return {
      id: lineId && opts.splitByLine ? `${station.id}:${lineId}` : station.id,
      stationName: station.name,
      lineIds: lineId ? [lineId] : departureLines(station),
      lineName: lineId ? lineNameFor(lineId, opts.lineMetadata) : undefined,
      agencyId: opts.agencyId,
      routeType: opts.routeType,
      lat: station.lat,
      lon: station.lon,
      distanceMeters,
      walkingMinutes: calculateWalkingMinutes(distanceMeters),
      arrivals,
      arrivalsStale: arrivalsStale ? true : undefined,
    };
  };

  const nearby = (lat: number, lon: number, radiusMeters: number) => {
    const stations = opts.stations
      .filter(servesStation)
      .map((station) => ({
        station,
        distance: calculateHaversineMeters(lat, lon, station.lat, station.lon),
      }))
      .filter(({ distance }) => distance <= radiusMeters)
      .sort((a, b) => a.distance - b.distance)
      .map(({ station }) => station);

    return getArrivalsForStations(stations).pipe(
      Effect.map(({ byStop, terminalsByRoute, directionsByRoute, staleStationIds }) =>
        stations.flatMap((station) =>
          (opts.splitByLine && departureLines(station).length > 0
            ? departureLines(station)
            : [undefined]
          ).map((lineId) =>
            attach(
              station,
              byStop,
              lat,
              lon,
              staleStationIds.has(station.id),
              terminalsByRoute,
              directionsByRoute,
              lineId,
            ),
          ),
        ),
      ),
    );
  };

  return {
    fetchNearby: ({ lat, lon, radiusMeters }) => nearby(lat, lon, radiusMeters),
    fetchSaved: ({ stationNames, lat, lon }) => {
      const wanted = new Set(stationNames.map((name) => name.trim().toLowerCase()));
      const stations = opts.stations.filter(
        (station) => servesStation(station) && wanted.has(station.name.trim().toLowerCase()),
      );
      const refLat = lat ?? opts.stations[0]?.lat ?? 0;
      const refLon = lon ?? opts.stations[0]?.lon ?? 0;
      return getArrivalsForStations(stations).pipe(
        Effect.map(({ byStop, terminalsByRoute, directionsByRoute, staleStationIds }) =>
          stations
            .flatMap((station) =>
              (opts.splitByLine && departureLines(station).length > 0
                ? departureLines(station)
                : [undefined]
              ).map((lineId) =>
                attach(
                  station,
                  byStop,
                  refLat,
                  refLon,
                  staleStationIds.has(station.id),
                  terminalsByRoute,
                  directionsByRoute,
                  lineId,
                ),
              ),
            )
            .sort((a, b) => a.distanceMeters - b.distanceMeters),
        ),
      );
    },
    fetchByIds: ({ stationIds, lat, lon }) => {
      // Callers pass map identity (schematic id, what the popover holds)
      // or card identity (index id, what panel cards hold after stripping
      // the `:lineId` split suffix). Both namespaces are unique per
      // agency, so match either side and answer with the index-keyed card
      // (all line splits when the manifest opts in). Unknown ids are a
      // legitimate empty, never an error.
      const wanted = new Set(stationIds.map((id) => id.trim()).filter((id) => id.length > 0));
      const stations = opts.stations.filter(
        (station) =>
          servesStation(station) &&
          (wanted.has((station.schematicId ?? station.id).trim()) || wanted.has(station.id.trim())),
      );
      const refLat = lat ?? opts.stations[0]?.lat ?? 0;
      const refLon = lon ?? opts.stations[0]?.lon ?? 0;
      return getArrivalsForStations(stations).pipe(
        Effect.map(({ byStop, terminalsByRoute, directionsByRoute, staleStationIds }) =>
          stations
            .flatMap((station) =>
              (opts.splitByLine && departureLines(station).length > 0
                ? departureLines(station)
                : [undefined]
              ).map((lineId) =>
                attach(
                  station,
                  byStop,
                  refLat,
                  refLon,
                  staleStationIds.has(station.id),
                  terminalsByRoute,
                  directionsByRoute,
                  lineId,
                ),
              ),
            )
            .sort((a, b) => a.distanceMeters - b.distanceMeters),
        ),
      );
    },
  };
}
