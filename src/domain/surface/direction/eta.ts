import { getVehicleStopIndex, resolveStopIndex, type VehicleStopIndices } from "../corridor/index";
import type { RiderStop } from "./types";

/**
 * Approaching-vehicle ETA derivation for Surface Transit.
 *
 * Single home for the arrival heuristic shared by the server fuse
 * (NearbyTransit, authoritative) and the collapsed-card presentation fallback
 * (RouteArrivalCard). Pure domain logic, no effects.
 */

/**
 * Collapsed rows read tracking data non-reactively without owning the 10s
 * renewal lifecycle, so cached vehicle positions can age arbitrarily.
 * Positions staler than this window must not drive countdown derivation.
 */
export const COLLAPSED_TRACKING_MAX_AGE_MS = 60_000;

/**
 * Derives arrival timestamps (epoch ms) from live approaching corridor vehicles.
 *
 * Arrival heuristic: a vehicle at the rider's boarding stop arrives in 30
 * seconds; each further stop of distance adds 120 seconds. Results are
 * filtered by direction, sorted ascending, and capped at maxResults
 * (default 3). No 60s dedup here by design: ETAs derive from distinct
 * corridor vehicles and are only sorted + capped, near-duplicate collapsing
 * lives in the stations fold (genericStationsSource grouping, R2).
 *
 * Freshness gate: when maxVehicleAgeMs is set, vehicles whose epoch-ms
 * timestamp is older than now − maxVehicleAgeMs are dropped BEFORE the
 * heuristic, callers that read snapshots without owning their renewal (e.g.
 * non-reactive cache readers) must not derive countdowns from arbitrarily old
 * positions. If every vehicle is filtered out, no ETAs are derived.
 * Omitting maxVehicleAgeMs takes the collapsed-row default
 * (COLLAPSED_TRACKING_MAX_AGE_MS); passing it explicitly, including an
 * explicit `undefined`, keeps age-blind behavior for callers that own
 * renewal (the server fuse). Vehicles without a timestamp cannot be proven
 * stale and survive the gate either way.
 */
export function deriveApproachingVehicleEtas(params: {
  stops: readonly { id: string; code?: string; lat: number; lon: number }[];
  vehicles: readonly {
    vehicleId?: string;
    currentStopSequence?: number;
    stopId?: string;
    directionId?: number;
    latitude: number;
    longitude: number;
    /** Epoch ms of the position snapshot; consulted only when maxVehicleAgeMs is set. */
    timestamp?: number;
  }[];
  riderStop: RiderStop;
  directionId?: number;
  now?: number;
  maxResults?: number;
  maxVehicleAgeMs?: number;
  vehicleStopIndices?: VehicleStopIndices;
}): number[] {
  const {
    stops,
    vehicles,
    riderStop,
    directionId,
    now = Date.now(),
    maxResults = 3,
    vehicleStopIndices,
  } = params;
  // `"maxVehicleAgeMs" in params` distinguishes omission (collapsed-card path
  // takes the seam default above) from an explicit `undefined` (the server's
  // age-blind opt-out). A `= default` destructure could not tell them apart —
  // explicit `undefined` triggers defaults, and would silently gate the
  // server's age-blind derivation.
  const maxVehicleAgeMs =
    "maxVehicleAgeMs" in params ? params.maxVehicleAgeMs : COLLAPSED_TRACKING_MAX_AGE_MS;
  if (stops.length === 0 || vehicles.length === 0) return [];

  // Freshness gate runs before any heuristic work; direction filter, sort,
  // and cap below are untouched by it.
  const minTimestamp = maxVehicleAgeMs === undefined ? undefined : now - maxVehicleAgeMs;
  const freshVehicles =
    minTimestamp === undefined
      ? vehicles
      : vehicles.filter((v) => v.timestamp === undefined || v.timestamp >= minTimestamp);

  if (freshVehicles.length === 0) return [];

  const riderIdx = resolveStopIndex(riderStop, stops);

  if (riderIdx < 0) return [];

  const relevantVehicles =
    directionId !== undefined
      ? freshVehicles.filter((v) => v.directionId === directionId)
      : freshVehicles;

  const derivedTimes: number[] = [];

  for (const v of relevantVehicles) {
    const vIdx = getVehicleStopIndex(v, stops, vehicleStopIndices);
    if (vIdx >= 0) {
      const stopsAway = riderIdx - vIdx;
      if (stopsAway >= 0) {
        const etaMs = stopsAway === 0 ? 30_000 : stopsAway * 120_000;
        derivedTimes.push(now + etaMs);
      }
    }
  }

  return derivedTimes.sort((a, b) => a - b).slice(0, maxResults);
}
