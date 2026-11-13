import { calculateHaversineMeters } from "~/domain/map/MapGeometry";
import type { RiderStop } from "../direction/types";

/**
 * Corridor geometry for Surface Transit.
 *
 * Retained home for the stop-index resolution, vehicle indexing,
 * closest-vehicle selection, and corridor-ordering geometry formerly housed
 * alongside direction vocabulary. Callers that
 * position vehicles along an ordered stop list (LinearStopStrip,
 * StationArrivalCard, routeTrackingLifecycle, NearbyTransit fallback,
 * direction ETA derivation) depend on these, deleting them would break the
 * build, so they relocate here rather than being removed with the former
 * single-file module.
 * Pure domain logic, no effects.
 */

export type VehicleStopIndices = ReadonlyMap<string, number>;

/**
 * Calculates number of stops away between a vehicle's current stop sequence and the rider's boarding stop.
 * Positive = approaching, 0 = at boarding stop, Negative = passed boarding stop.
 */
export function calculateStopsAway(vehicleStopIndex: number, riderStopIndex: number): number {
  return riderStopIndex - vehicleStopIndex;
}

/**
 * Finds the index of the stop closest to the given geographic coordinates.
 */
export function findNearestStopIndex(
  lat: number,
  lon: number,
  stops: readonly { lat: number; lon: number }[],
): number {
  if (stops.length === 0) return -1;
  let bestDist = Infinity;
  let bestIdx = -1;
  for (let i = 0; i < stops.length; i++) {
    const d = calculateHaversineMeters(lat, lon, stops[i].lat, stops[i].lon);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Resolves a target's index along an ordered stop list: exact stop-id match,
 * then stop-code match, then geographic nearest via haversine. Returns -1
 * when nothing resolves. Single home for the id → code → geo fallthrough
 * shared by rider-stop resolution, vehicle indexing, and strip positioning.
 */
export function resolveStopIndex(
  target: RiderStop,
  stops: readonly { id: string; code?: string; lat: number; lon: number }[],
): number {
  if (target.id) {
    const idx = stops.findIndex((s) => s.id === target.id);
    if (idx >= 0) return idx;
  }
  if (target.code) {
    const idx = stops.findIndex((s) => s.code && s.code === target.code);
    if (idx >= 0) return idx;
  }
  if (target.lat !== undefined && target.lon !== undefined) {
    return findNearestStopIndex(target.lat, target.lon, stops);
  }
  return -1;
}

/**
 * Resolves a vehicle's sequence index along a list of route stops.
 *
 * `currentStopSequence` of 1 is treated as unset: it is the protobuf
 * pattern-start default and live feeds repeatedly reported degenerate seq=1
 * vehicles positioned mid-route, which pinned pill markers to the first stop
 * column while their real position was elsewhere. Geo resolution is reliable,
 * so those vehicles resolve by id → code → nearest instead. Sequences above 1
 * are schedule-derived and keep exact snapping when in range.
 */
export function findVehicleStopIndex(
  vehicle: { currentStopSequence?: number; stopId?: string; latitude: number; longitude: number },
  stops: readonly { id: string; lat: number; lon: number }[],
): number {
  if (
    vehicle.currentStopSequence !== undefined &&
    vehicle.currentStopSequence > 1 &&
    vehicle.currentStopSequence - 1 < stops.length
  ) {
    return vehicle.currentStopSequence - 1;
  }
  return resolveStopIndex(
    { id: vehicle.stopId, lat: vehicle.latitude, lon: vehicle.longitude },
    stops,
  );
}

/**
 * Resolves every vehicle to its ordered corridor stop once. Presentation
 * callers can reuse this map when several derived views need the same
 * vehicle-to-stop relationship.
 */
export function indexVehicleStops(
  vehicles: readonly {
    readonly vehicleId: string;
    readonly currentStopSequence?: number;
    readonly stopId?: string;
    readonly latitude: number;
    readonly longitude: number;
  }[],
  stops: readonly { id: string; lat: number; lon: number }[],
): Map<string, number> {
  const indices = new Map<string, number>();
  for (const vehicle of vehicles) {
    indices.set(vehicle.vehicleId, findVehicleStopIndex(vehicle, stops));
  }
  return indices;
}

/**
 * Vehicle-to-stop resolution honoring a precomputed index map, falling back
 * to sequence/geometry resolution. Shared with direction ETA derivation
 * (`deriveApproachingVehicleEtas`), single home so the corridor-geometry and
 * ETA seams cannot drift (no cycle: direction imports corridor, never back).
 */
export function getVehicleStopIndex(
  vehicle: {
    readonly vehicleId?: string;
    readonly currentStopSequence?: number;
    readonly stopId?: string;
    readonly latitude: number;
    readonly longitude: number;
  },
  stops: readonly { id: string; lat: number; lon: number }[],
  indexedStops?: VehicleStopIndices,
): number {
  if (vehicle.vehicleId && indexedStops?.has(vehicle.vehicleId)) {
    return indexedStops.get(vehicle.vehicleId) ?? -1;
  }
  return findVehicleStopIndex(vehicle, stops);
}

/**
 * Picks the approaching vehicle closest to the rider's boarding stop:
 * minimum non-negative stops-away among vehicles whose index resolves.
 * When every vehicle has already passed the rider stop, degrades to the
 * first vehicle with its real (negative) distance so banner copy can say
 * "Departed" rather than hiding live data. Returns null only when there
 * are no vehicles or the rider stop is unresolvable.
 */
export function findClosestApproachingVehicle<
  T extends {
    vehicleId?: string;
    currentStopSequence?: number;
    stopId?: string;
    latitude: number;
    longitude: number;
  },
>(
  vehicles: readonly T[],
  stops: readonly { id: string; lat: number; lon: number }[],
  riderStopIndex: number,
  indexedStops?: VehicleStopIndices,
): { readonly vehicle: T; readonly stopIndex: number; readonly stopsAway: number } | null {
  if (vehicles.length === 0 || riderStopIndex < 0) return null;

  let best: { vehicle: T; stopIndex: number; stopsAway: number } | null = null;
  for (const v of vehicles) {
    const idx = getVehicleStopIndex(v, stops, indexedStops);
    if (idx < 0) continue;
    const away = calculateStopsAway(idx, riderStopIndex);
    if (away >= 0 && (!best || away < best.stopsAway)) {
      best = { vehicle: v, stopIndex: idx, stopsAway: away };
    }
  }
  if (best) return best;

  const first = vehicles[0];
  const firstIdx = getVehicleStopIndex(first, stops, indexedStops);
  const away = firstIdx >= 0 ? calculateStopsAway(firstIdx, riderStopIndex) : 0;
  return { vehicle: first, stopIndex: firstIdx, stopsAway: away };
}

/**
 * Orders a list of stops along the major spatial axis of the route corridor.
 * Used as a fallback when GTFS sequence numbers are absent.
 * Direction 0 travels along the principal vector; Direction 1 travels reversed.
 */
export function orderStopsAlongCorridor<T extends { lat: number; lon: number }>(
  stops: readonly T[],
  directionId: number = 0,
): readonly T[] {
  if (stops.length <= 2) {
    return directionId === 1 ? [...stops].reverse() : [...stops];
  }

  // Find the two stops that are farthest apart (the corridor endpoints)
  let maxDist = -1;
  let startIdx = 0;
  let endIdx = 0;

  for (let i = 0; i < stops.length; i++) {
    for (let j = i + 1; j < stops.length; j++) {
      const dLat = stops[i].lat - stops[j].lat;
      const dLon = stops[i].lon - stops[j].lon;
      const distSq = dLat * dLat + dLon * dLon;
      if (distSq > maxDist) {
        maxDist = distSq;
        startIdx = i;
        endIdx = j;
      }
    }
  }

  // Normalize so the start endpoint is the westernmost (or southernmost) stop
  let pStart = stops[startIdx];
  let pEnd = stops[endIdx];
  if (pStart.lon > pEnd.lon || (pStart.lon === pEnd.lon && pStart.lat > pEnd.lat)) {
    [pStart, pEnd] = [pEnd, pStart];
  }

  const vX = pEnd.lon - pStart.lon;
  const vY = pEnd.lat - pStart.lat;
  const vLenSq = vX * vX + vY * vY;

  // Project each stop onto the corridor vector [pStart -> pEnd]
  const withProjection = stops.map((stop) => {
    if (vLenSq === 0) return { stop, t: 0 };
    const t = ((stop.lon - pStart.lon) * vX + (stop.lat - pStart.lat) * vY) / vLenSq;
    return { stop, t };
  });

  // Sort by projection scalar t
  withProjection.sort((a, b) => a.t - b.t);

  const sorted = withProjection.map((item) => item.stop);
  return directionId === 1 ? sorted.reverse() : sorted;
}
