/**
 * Proximity primitives shared by surface-route and subway-station nearby
 * selection. Pure domain math, infrastructure adapters import from here,
 * never the reverse.
 */

/**
 * Nearby search ceiling (docs/development.md#nearby-search): nearby queries never exceed a 1.5 km radius.
 * Single source of truth shared by every data-store adapter.
 */
export const MAX_PROXIMITY_RADIUS_METERS = 1500;

/**
 * Small conservative margin for the SQL bbox prefilter. The exact Haversine
 * check still enforces the requested radius; this margin only prevents a
 * stop on the circle boundary from being lost to degree-scale rounding.
 */
export const PROXIMITY_BBOX_MARGIN_METERS = 10;

/**
 * Meters per degree of latitude at geodetic latitude φ (degrees), from the
 * standard spherical-expansion series.
 */
export function metersPerDegreeLat(latDeg: number): number {
  const φ = (latDeg * Math.PI) / 180;
  const cos2φ = Math.cos(2 * φ);
  const cos4φ = Math.cos(4 * φ);
  const cos6φ = Math.cos(6 * φ);
  return 111132.92 - 559.82 * cos2φ + 1.175 * cos4φ - 0.0023 * cos6φ;
}

/**
 * Meters per degree of longitude at geodetic latitude φ (degrees); shrinks
 * toward the poles as cos(φ).
 */
export function metersPerDegreeLon(latDeg: number): number {
  const φ = (latDeg * Math.PI) / 180;
  return 111412.84 * Math.cos(φ) - 93.5 * Math.cos(3 * φ) + 0.118 * Math.cos(5 * φ);
}

/** Average walking pace in meters per minute. */
export const WALKING_METERS_PER_MINUTE = 80;

/** Clamps a requested proximity search radius to the 0–1.5 km range. */
export function clampProximityRadius(radiusMeters: number): number {
  return Math.max(0, Math.min(radiusMeters, MAX_PROXIMITY_RADIUS_METERS));
}

/** Wire shape of a nearby-proximity query before coercion (values may arrive as query strings). */
export interface RawProximityQuery {
  readonly lat?: number | string;
  readonly lon?: number | string;
  readonly radius?: number | string;
}

export interface ParsedProximityQuery {
  readonly lat: number;
  readonly lon: number;
  readonly radius: number;
}

const DEFAULT_PROXIMITY_RADIUS_METERS = 500;

/**
 * Coerces wire strings to numbers and hard-caps radius at the 1.5 km
 * ceiling. Shared coercion for every nearby-RPC validator (surface,
 * stations); callers keep agency-scoping concerns client-side.
 */
export function parseProximityQuery(input: RawProximityQuery): ParsedProximityQuery {
  const lat = typeof input.lat === "number" ? input.lat : parseFloat(String(input.lat));
  const lon = typeof input.lon === "number" ? input.lon : parseFloat(String(input.lon));
  const rawRadius =
    typeof input.radius === "number"
      ? input.radius
      : input.radius !== undefined
        ? parseFloat(String(input.radius))
        : DEFAULT_PROXIMITY_RADIUS_METERS;

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new Error("Invalid latitude or longitude coordinates");
  }
  if (!Number.isFinite(rawRadius)) throw new Error("Invalid proximity radius");

  return { lat, lon, radius: clampProximityRadius(rawRadius) };
}

/** Approximate walking time in minutes at an average 80 meters/minute pace. */
export function calculateWalkingMinutes(distanceMeters: number): number {
  return Math.max(1, Math.ceil(distanceMeters / WALKING_METERS_PER_MINUTE));
}

export interface ProximityBoundingBox {
  readonly minLat: number;
  readonly maxLat: number;
  readonly minLon: number;
  readonly maxLon: number;
}

/**
 * Bounding box for a proximity search centered at (lat, lon).
 * Clamps radius at the 1.5km ceiling and derives latitude-aware
 * meters-per-degree deltas from the query latitude. Single source
 * for bbox math.
 */
export function bboxFor(lat: number, lon: number, radiusMeters: number): ProximityBoundingBox {
  const effectiveRadius = clampProximityRadius(radiusMeters);
  const bboxRadius = effectiveRadius + PROXIMITY_BBOX_MARGIN_METERS;
  const latDelta = bboxRadius / metersPerDegreeLat(lat);
  const lonDelta = bboxRadius / metersPerDegreeLon(lat);
  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLon: lon - lonDelta,
    maxLon: lon + lonDelta,
  };
}
