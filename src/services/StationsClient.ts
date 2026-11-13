import { isGeneratedDirectionLabel } from "~/domain/surface/direction";
import type { NearbyStationArrival, NearbyStationArrivalGroup } from "~/domain/surface/types";
import {
  finiteNumberOrUndefined,
  parseNearbyRpcInput,
  parseOptionalUiLocale,
  requireAgencyId,
} from "~/services/nearby/rpcInput";
import type { UiLocale } from "~/domain/locale";
import { handleFetchNearbyStations, handleFetchSavedStations } from "./StationsServer";

// ---------------------------------------------------------------------------
// Validators (extracted so their throwing behavior stays unit-pinnable)
// ---------------------------------------------------------------------------

export interface ParsedSavedStationsInput {
  readonly agencyId: string;
  readonly stationNames: readonly string[];
  readonly lat?: number;
  readonly lon?: number;
  readonly locale?: UiLocale;
}

export interface ParsedStationDeparturesInput {
  readonly agencyId: string;
  readonly stationId: string;
  readonly locale?: UiLocale;
}

export function parseStationDeparturesInput(input: {
  agencyId?: string;
  stationId?: string;
  locale?: unknown;
}): ParsedStationDeparturesInput {
  const stationId = typeof input.stationId === "string" ? input.stationId.trim() : "";
  if (!stationId) throw new Error("Missing or invalid stationId parameter");
  const locale = parseOptionalUiLocale(input.locale);
  return {
    agencyId: requireAgencyId(input.agencyId),
    stationId,
    ...(locale === undefined ? {} : { locale }),
  };
}

export function parseSavedStationsInput(input: {
  agencyId?: string;
  stationNames?: readonly unknown[];
  lat?: number;
  lon?: number;
  locale?: unknown;
}): ParsedSavedStationsInput {
  const stationNames = (Array.isArray(input.stationNames) ? input.stationNames : [])
    .map((name) => String(name).trim())
    .filter((name) => name.length > 0)
    .slice(0, 50);
  const locale = parseOptionalUiLocale(input.locale);
  return {
    agencyId: requireAgencyId(input.agencyId),
    stationNames,
    lat: finiteNumberOrUndefined(input.lat),
    lon: finiteNumberOrUndefined(input.lon),
    ...(locale === undefined ? {} : { locale }),
  };
}

// ---------------------------------------------------------------------------
// Server-function wrappers.
//
// The implementations live server-only in StationsServer. Each wrapper below
// is a thin "use server" boundary that validates caller-controlled input
// inside the server body and delegates. Every argument is treated as
// untrusted.
// Delegates never catch on behalf of the client. A downstream StationsError
// rejects so TanStack Query surfaces real errors.
// ---------------------------------------------------------------------------

/**
 * Production server function for nearby subway stations with next-arrival
 * predictions, sorted ascending by distance. Station geo indexes stay off the
 * client bundle; each agency's adapter supplies them server-side.
 */
export async function fetchNearbyStations(data: {
  agencyId?: string;
  lat?: number | string;
  lon?: number | string;
  radius?: number | string;
  locale?: unknown;
}): Promise<readonly NearbyStationArrival[]> {
  "use server";
  return handleFetchNearbyStations(parseNearbyRpcInput(data));
}

/**
 * Server function for favourited stations, like the surface fetchSavedTransit
 * seam, rider location is optional: favourites render regardless of where the
 * user is, with distance reported against the agency reference when unknown.
 */
export async function fetchSavedStations(
  data: Parameters<typeof parseSavedStationsInput>[0],
): Promise<readonly NearbyStationArrival[]> {
  "use server";
  return handleFetchSavedStations(parseSavedStationsInput(data));
}

/**
 * Arrivals-only wire shape served by `GET /api/departures/:agencyId/:stationId`.
 * One entry per line-split card with no location fields (no
 * distanceMeters/walkingMinutes), so edge responses stay shareable across
 * riders. Defined here beside the HTTP client (mirroring `RouteMeta` in
 * SurfaceClient); the endpoint imports this type rather than the reverse so
 * the client bundle never touches the server-only endpoint module.
 */
export interface StationDepartureGroup {
  readonly livePredictionsOnly?: boolean;
  readonly lineIds: readonly string[];
  readonly lineName?: string;
  readonly arrivals: readonly NearbyStationArrivalGroup[];
  readonly arrivalsStale?: boolean;
}

function isDepartureGroup(value: unknown): value is StationDepartureGroup {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.lineIds) || !record.lineIds.every((id) => typeof id === "string")) {
    return false;
  }
  if (record.lineName !== undefined && typeof record.lineName !== "string") return false;
  if (record.livePredictionsOnly !== undefined && typeof record.livePredictionsOnly !== "boolean")
    return false;
  if (!Array.isArray(record.arrivals)) return false;
  return record.arrivals.every((group) => {
    if (typeof group !== "object" || group === null) return false;
    const arrival = group as Record<string, unknown>;
    return (
      typeof arrival.directionId === "number" &&
      typeof arrival.label === "string" &&
      (arrival.generatedLabel === undefined || isGeneratedDirectionLabel(arrival.generatedLabel)) &&
      Array.isArray(arrival.times) &&
      arrival.times.every((time) => typeof time === "number")
    );
  });
}

/**
 * Stable per-station departures fetch over the portable HTTP endpoint.
 *
 * Same arrivals-only JSON the departures endpoint serves, reached through
 * `GET /api/departures/:agencyId/:stationId` so the edge/browser cache
 * absorbs it: departures are identical for every rider at a station, and the
 * server-function POST path can never be cached. Non-2xx responses reject
 * so the query surfaces real errors.
 */
export async function fetchStationDeparturesViaHttp(
  input: { readonly agencyId: string; readonly stationId: string; readonly locale?: unknown },
  fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = globalThis.fetch,
): Promise<readonly StationDepartureGroup[]> {
  const { agencyId, stationId, locale } = parseStationDeparturesInput(input);
  const localeQuery = locale ? `?locale=${encodeURIComponent(locale)}` : "";
  const response = await fetchFn(
    `/api/departures/${encodeURIComponent(agencyId)}/${encodeURIComponent(stationId)}${localeQuery}`,
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Station departures request failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }
  const json: unknown = await response.json();
  if (!Array.isArray(json) || !json.every(isDepartureGroup)) {
    throw new Error("Station departures response was not a departures array");
  }
  return json;
}
