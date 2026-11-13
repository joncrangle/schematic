import { bboxFor, calculateWalkingMinutes, clampProximityRadius } from "~/domain/proximity";
import { calculateHaversineMeters } from "~/domain/map/MapGeometry";
import type { NearbyStopResult, SurfaceStop } from "~/domain/surface/types";

/**
 * Domain revalidation helpers shared by the D1 and memory adapters: the
 * `needsUpdate` predicate and `findNearbyStops` haversine+filter+sort logic.
 * Bounding boxes use the clamped radius, so queries never exceed the 1.5 km
 * ceiling.
 */

/**
 * Whether two stop representations identify the same physical stop.
 * Handles GTFS stop_id vs NextBus tag identifiers across feeds.
 */
export function isSameStop(a: SurfaceStop, b: SurfaceStop): boolean {
  if (a.id === b.id) return true;
  if (a.code !== undefined && b.code !== undefined && a.code === b.code) return true;
  if (a.code !== undefined && a.code === b.id) return true;
  if (b.code !== undefined && b.code === a.id) return true;
  return false;
}

const NEARBY_STOP_ALIAS_RADIUS_METERS = 200;
const GENERIC_STOP_NAME_TOKENS = new Set([
  "at",
  "ave",
  "avenue",
  "blvd",
  "boulevard",
  "dr",
  "drive",
  "east",
  "rd",
  "road",
  "st",
  "street",
  "stop",
  "west",
]);

function meaningfulStopNameTokens(name: string): ReadonlySet<string> {
  return new Set(
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((token) => token.length >= 4 && !GENERIC_STOP_NAME_TOKENS.has(token)),
  );
}

/**
 * Whether nearby route data represents the same physical stop under a feed
 * alias or a modest topology revision. Nearby route membership is denormalized
 * and can temporarily carry a newer stop id than the cached route shape. A
 * short same-corridor match prevents that valid stop from disappearing while
 * still rejecting unrelated stale memberships.
 */
export function isEquivalentNearbyStop(a: SurfaceStop, b: SurfaceStop): boolean {
  if (isSameStop(a, b)) return true;

  if (calculateHaversineMeters(a.lat, a.lon, b.lat, b.lon) > NEARBY_STOP_ALIAS_RADIUS_METERS) {
    return false;
  }

  const aTokens = meaningfulStopNameTokens(a.name);
  return [...meaningfulStopNameTokens(b.name)].some((token) => aTokens.has(token));
}

/**
 * Pure haversine nearby selection: filters candidates within radius,
 * computes walking minutes, sorts ascending by distance.
 * Handles clamp + bbox prefilter (with effectiveRadius, not raw) + haversine.
 */
export function filterNearbyStops(
  candidates: readonly SurfaceStop[],
  lat: number,
  lon: number,
  radiusMeters: number,
): NearbyStopResult[] {
  const effectiveRadius = clampProximityRadius(radiusMeters);
  const box = bboxFor(lat, lon, effectiveRadius);
  const results: NearbyStopResult[] = [];
  for (const stop of candidates) {
    if (
      stop.lat < box.minLat ||
      stop.lat > box.maxLat ||
      stop.lon < box.minLon ||
      stop.lon > box.maxLon
    ) {
      continue;
    }
    const distanceMeters = calculateHaversineMeters(lat, lon, stop.lat, stop.lon);
    if (distanceMeters <= effectiveRadius) {
      results.push({
        stop,
        distanceMeters,
        walkingMinutes: calculateWalkingMinutes(distanceMeters),
      });
    }
  }
  results.sort((a, b) => a.distanceMeters - b.distanceMeters);
  return results;
}
