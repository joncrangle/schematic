/**
 * Pure map-geometry engine (ADR-0007 core).
 *
 * This module serves any agency unchanged: it contains generic WGS84 →
 * schematic projection math, polyline decoding, and path construction. Camera
 * transforms live in the sibling MapCamera primitive. It imports NOTHING from the component
 * layer or any agency data source, every agency-specific constant (geographic
 * reference anchors, canvas dimensions, zoom limits, and default bounds) is
 * injected through `createMapGeometry`.
 *
 * The dependency rule is enforced twice (ADR-0007): oxlint no-restricted-imports
 * (.oxlintrc.json) plus tests/unit/domain-boundary.test.ts. Removing either
 * guard fails loudly.
 */

import type { MapBoundingBox, Point } from "./MapCamera";

export interface Geometry {
  rect: DOMRect;
  scale: number;
  offsetX: number;
  offsetY: number;
}

/**
 * A surface stop as returned by the transit data layer.
 *
 * `parentStationId` is the repository-owned schematic station identity when
 * the surface stop belongs to a station. It remains metadata for interchange
 * presentation; it never changes the surface stop's map position.
 * `parentStation` remains display-only.
 */
export interface SurfaceRouteStop {
  readonly lat: number;
  readonly lon: number;
  readonly parentStation?: string;
  readonly parentStationId?: string;
}

/**
 * Clamps a number between a minimum and maximum value.
 */
/**
 * Standard Haversine distance formula between two GPS coordinates in meters.
 */
export function calculateHaversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371e3;

  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(R * c);
}

/**
 * Canonical schematic anchor-key grammar: case-folded with whitespace,
 * hyphens, underscores, dots, and apostrophes stripped, so "St. George",
 * "st george", and "St-George" all resolve to the same anchor. This is the
 * key-space used by legacy display-oriented alert projection, schematic
 * station anchors themselves are keyed by repository-owned station id.
 */
export function anchorKey(name: string): string {
  return name.toLowerCase().replace(/[\s\-_.']/g, "");
}

// ---------------------------------------------------------------------------
// Geographic → schematic projection
// ---------------------------------------------------------------------------

/**
 * Geographic reference anchors defining the linear geo → schematic mapping.
 *
 * These anchors establish a rough geographic coordinate system over the
 * schematic map. They are NOT intended to reproduce the subway layout.
 * They only provide a useful starting position for surface-route geometry.
 */
export interface GeoProjectionConfig {
  readonly refLonWest: number;
  readonly refLonEast: number;
  readonly refXWest: number;
  readonly refXEast: number;
  readonly refLatNorth: number;
  readonly refLatSouth: number;
  readonly refYNorth: number;
  readonly refYSouth: number;
}

/** Schematic canvas dimensions and the zoom range operators may reach. */
export interface ViewportConfig {
  readonly viewBoxWidth: number;
  readonly viewBoxHeight: number;
  readonly minZoom: number;
  readonly maxZoom: number;
}

/** Everything the engine needs to know about one agency's schematic map. */
export interface MapGeometryConfig {
  readonly projection: GeoProjectionConfig;
  readonly viewport: ViewportConfig;
  /**
   * The schematic's own drawn line geometry, offered to the projection as snap
   * targets. Every schematic supplies its own; with none, the engine holds no
   * targets and every projection stays affine.
   */
  readonly snapLines?: readonly SchematicLineGeometry[];
  /**
   * The schematic's own stations in their true WGS84 positions, from the
   * already-declared `stationIndex`. This is what makes the snap cutoff
   * derivable rather than a guessed constant: it is the evidence of how far
   * this schematic's own drawn lines sit from its own geography.
   */
  readonly stylisedStations?: readonly StylisedStationGeometry[];
  /** Bounding box returned when there is nothing to bound (empty routes). */
  readonly defaultBounds: MapBoundingBox;
}

/** One drawn schematic line, in schematic pixels. */
export interface SchematicLineGeometry {
  readonly id: string;
  readonly points: readonly Point[];
}

/**
 * A station's true WGS84 position together with the drawn lines it sits on.
 *
 * The distance from this position's affine projection to the nearest of its own
 * drawn lines is precisely the correction the schematic makes to itself, and
 * it is the same quantity the snap gate compares against. Measuring anchor
 * offsets instead would overstate it by an order of three, because a schematic
 * nudges a station anchor for legibility in ways it never nudges the corridor
 * running through it.
 */
export interface StylisedStationGeometry {
  readonly id: string;
  readonly lineIds: readonly string[];
  readonly lat: number;
  readonly lon: number;
}

/**
 * Attribution for a single projected point: which drawn line it belongs to.
 *
 * Attribution is the safety guard that matters. A point is only ever moved onto
 * a line it is declared to be on, so a bus on one corridor can never be pulled
 * onto a parallel neighbour no matter how far the projection lands; the cutoff
 * only bounds how large a correction onto that same line may be.
 */
export interface SnapAttribution {
  readonly lineId: string;
}

/** Bound map-geometry operations for one agency configuration. */
export interface MapGeometryEngine {
  /**
   * Width of this schematic's snap cutoff as a fraction of its canvas
   * diagonal, derived from its own drawn geometry. Zero when the engine holds
   * no snap lines or no station index to measure them against.
   */
  readonly snapCutoffRatio: number;
  /**
   * Projects WGS84 coordinates into the SVG map coordinate system, then snaps
   * the result onto the drawn line named by `attribution` when one exists and
   * the correction is within the cutoff derived from this schematic's own
   * stylisation. Without a resolving attribution the affine point is returned
   * untouched.
   */
  projectGeoToMapPoint(lat: number, lon: number, attribution?: SnapAttribution): Point;
  /**
   * The drawn line's own authored points, or `undefined` when this schematic
   * draws no line by that name. The corridor to draw and frame for a route the
   * schematic draws, since the affine projection disagrees with a stylised
   * drawing by a per-schematic factor.
   */
  drawnLineMapPoints(lineId: string): Point[] | undefined;
  /**
   * Extracts route corridor geometry from a shape polyline or geographic stop
   * sequence. Schematic station anchors are never part of this corridor.
   *
   * Shares SnapAttribution with projectGeoToMapPoint so the drawn corridor and
   * everything placed on it stay on one line.
   */
  extractRouteMapPoints(
    shape?: {
      polyline?: string;
    } | null,
    stops?: readonly SurfaceRouteStop[] | null,
    attribution?: SnapAttribution,
  ): Point[];
  /** Projects a geographic bounding box into SVG map space. */
  projectGeoBoundingBoxToMapBounds(box: {
    minLat: number;
    maxLat: number;
    minLon: number;
    maxLon: number;
  }): MapBoundingBox;
  /** Computes a bounding box for map points or [lat, lon] tuples. */
  computeRouteBoundingBox(points: readonly (Point | [number, number])[]): MapBoundingBox;
}

/**
 * Memoized polyline decoding, keyed by the shape object itself.
 *
 * Every tracking renewal produces a NEW shape (and polyline), so a
 * WeakMap gives per-snapshot memoization with automatic eviction once the
 * snapshot is dropped: within one snapshot the corridor is decoded exactly
 * once no matter how many consumers ask, and old encodings never leak.
 */
const decodedPolylineCache = new WeakMap<object, readonly [number, number][]>();

const EMPTY_DECODED_POLYLINE: readonly [number, number][] = [];

// A route shape that leaves a stop more than this far away in map space is
// treated as belonging to a different pattern. The stop corridor is the
// safer fallback because it is the geometry actually being presented to the
// rider. This is deliberately expressed in schematic units, not agency or
// geographic units, so the rule remains provider-neutral.
const MAX_STOP_TO_SHAPE_DISTANCE = 48;

/** The point of segment `start`→`end` nearest to `point`, and how far it was. */
function projectOntoSegment(
  point: Point,
  start: Point,
  end: Point,
): { readonly point: Point; readonly distance: number; readonly offTheEnd: boolean } {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  // Unclamped, so a projection past either end can be told apart from one that
  // genuinely lands on the segment.
  const raw =
    lengthSquared === 0 ? 0 : ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
  const t = Math.max(0, Math.min(1, raw));
  const projected = { x: start.x + t * dx, y: start.y + t * dy };
  return {
    point: projected,
    distance: Math.hypot(point.x - projected.x, point.y - projected.y),
    // A point beyond the end of the segment has no nearest point ON it; the
    // clamp silently substitutes the endpoint, which is how a whole region
    // collapses onto one vertex. Reported rather than hidden so the caller can
    // keep the affine projection instead.
    offTheEnd: lengthSquared > 0 && (raw < 0 || raw > 1),
  };
}

/** Shortest distance from `point` to the polyline, in schematic units. */
export function distancePointToPolyline(point: Point, polyline: readonly Point[]): number {
  let nearest = Infinity;
  for (let index = 0; index < polyline.length - 1; index += 1) {
    nearest = Math.min(
      nearest,
      projectOntoSegment(point, polyline[index], polyline[index + 1]).distance,
    );
  }
  return nearest;
}

/**
 * Headroom over a schematic's own measured stylisation when deriving its snap
 * cutoff.
 *
 * A vehicle or a stop is not a station: it sits between stations, past a
 * terminal, or on a curve the schematic straightens, so its distance from the
 * drawn line can exceed every station's. GRT's furthest station sits 2.2x its
 * own p90, so a cutoff pinned at p90 would refuse it. This headroom is
 * deliberately short of that tail: a cutoff wide enough to swallow every last
 * outlier would also swallow bad feed data, so points beyond it stay visibly
 * affine instead of being moved by a correction the drawing never warranted.
 */
export const SNAP_HEADROOM = 1.5;

/**
 * Ceiling on the derived cutoff, as a fraction of the canvas diagonal.
 *
 * The real risk this feature carries is a bad feed coordinate: a vehicle or
 * stop whose lat/lon is wrong, projected somewhere the drawing never put it. The
 * property that makes that survivable is ATTRIBUTION, not this number. A point
 * is only ever a candidate for the one drawn line it is declared on, so a bad
 * coordinate can never land on a neighbouring trunk, and no value of this
 * constant would change that. What the cutoff bounds is narrower: how far along
 * its own line a point may travel before the correction stops being a
 * correction and becomes a re-plot of wherever the feed happened to say.
 *
 * That makes this a guard against degenerate evidence rather than the sizing
 * mechanism. The derived cutoff is a p90 of one schematic's own measured
 * stylisation, so a single misplaced station cannot widen it, but a schematic
 * whose `geoProjection` does not describe its own drawing at all would measure
 * its whole canvas as stylisation and derive a cutoff that admits everything.
 *
 * It sits at half the canvas diagonal, above every shipped schematic's derived
 * need with margin (the largest is GO at 38.8% of its diagonal, then Brampton
 * 27.6%, Milton 26.0%, Miway 25.1%). It is not a claim that nothing can reach
 * it: a future schematic more stylised than half its canvas would clamp, and
 * that is the intended behaviour, because past that point a snap is a re-plot.
 * What it must never do is bind on a schematic whose own measurement asked for
 * less, which would silently hand an agency a partial correction. The
 * per-schematic test in `snap-cutoff-derivation.test.ts` is what holds that
 * line, because the two failure modes look identical from inside one agency.
 */
export const MAX_SNAP_DISTANCE_RATIO = 0.5;

/**
 * Derives the snap cutoff for one schematic: the 90th percentile of how far its
 * own stations land from the drawn lines they are drawn on, plus headroom, as a
 * fraction of the canvas diagonal.
 *
 * A single global constant cannot serve these schematics. Measured across the
 * eleven shipped ones, that p90 spans 1.2% of the diagonal (DRT, whose drawing
 * essentially tracks its geography) to 25.9% (GO, the most stylised), so any
 * one number either starves the stylised maps of the correction the feature
 * exists to make or hands the faithful ones a gate far wider than their drawing
 * warrants. Deriving per schematic keeps each cutoff just wide enough for the
 * map it belongs to, and needs no agency to declare anything: it is read from
 * the `stationIndex` and `lines` every schematic already carries.
 *
 * This deliberately measures to the drawn line rather than to the station
 * anchor. Anchors carry label placement and interline spacing the corridor
 * itself never has: GRT's anchors sit a median 13.6% of its diagonal off affine
 * while its own lines sit 4.2% off, so anchoring here would derive a cutoff
 * three times wider than the drawing calls for.
 *
 * Returns 0 when no stations resolve to a drawn line, leaving the engine in its
 * pre-snap state rather than guessing.
 */
export function deriveSnapDistanceRatio(
  stations: readonly StylisedStationGeometry[],
  lines: readonly SchematicLineGeometry[],
  canvasDiagonal: number,
  affineOf: (lat: number, lon: number) => Point,
): number {
  if (stations.length === 0 || !(canvasDiagonal > 0)) return 0;
  const drawnByKey = new Map<string, readonly Point[]>();
  for (const line of lines) drawnByKey.set(snapLineKey(line.id), line.points);
  const offsets: number[] = [];
  for (const station of stations) {
    if (!Number.isFinite(station.lat) || !Number.isFinite(station.lon)) continue;
    const projected = affineOf(station.lat, station.lon);
    // A station belongs to every line it is drawn on, so the nearest of them is
    // the only distance its own corridor accounts for.
    let nearest = Infinity;
    for (const lineId of new Set(station.lineIds.map(snapLineKey))) {
      const drawn = drawnByKey.get(lineId);
      if (drawn && drawn.length >= 2) {
        nearest = Math.min(nearest, distancePointToPolyline(projected, drawn));
      }
    }
    const offset = nearest / canvasDiagonal;
    if (Number.isFinite(offset)) offsets.push(offset);
  }
  if (offsets.length === 0) return 0;
  offsets.sort((first, second) => first - second);
  const index = (offsets.length - 1) * 0.9;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const p90 =
    lower === upper
      ? offsets[lower]
      : offsets[lower] + (offsets[upper] - offsets[lower]) * (index - lower);
  return Math.min(MAX_SNAP_DISTANCE_RATIO, p90 * SNAP_HEADROOM);
}

function roundToHundredth(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Key-space for drawn line ids. An attribution resolves against this key and
 * nowhere else, so both the snap-target index and every incoming attribution
 * normalise here: one grammar, so a hint that differs only in case or
 * surrounding whitespace cannot resolve against one line and miss another.
 */
export function snapLineKey(lineId: string): string {
  return lineId.trim().toLowerCase();
}

/**
 * Closest point on `polyline` to `point`, plus how far away it was.
 *
 * Prefers a projection that lands on a segment. A candidate clamped to a
 * segment's end is only used when nothing else was nearer, and `offTheEnd`
 * reports that it was, so a caller can decline to move a point that has no
 * nearest point on the line at all.
 */
function nearestPointOnPolyline(
  point: Point,
  polyline: readonly Point[],
): { readonly point: Point; readonly distance: number; readonly offTheEnd: boolean } | undefined {
  if (polyline.length < 2) return undefined;
  let best:
    | { readonly point: Point; readonly distance: number; readonly offTheEnd: boolean }
    | undefined;
  let bestOnSegment:
    | { readonly point: Point; readonly distance: number; readonly offTheEnd: boolean }
    | undefined;
  for (let index = 0; index < polyline.length - 1; index += 1) {
    const candidate = projectOntoSegment(point, polyline[index], polyline[index + 1]);
    if (!best || candidate.distance < best.distance) best = candidate;
    if (!candidate.offTheEnd && (!bestOnSegment || candidate.distance < bestOnSegment.distance)) {
      bestOnSegment = candidate;
    }
  }
  // A vertex shared by two segments is on the line even when both clamp to it,
  // so an endpoint hit is only off-the-end when no segment took the point.
  if (bestOnSegment) return { ...bestOnSegment, offTheEnd: false };
  return best ? { ...best, offTheEnd: true } : undefined;
}

function shapeCoversStops(shape: readonly Point[], stops: readonly Point[]): boolean {
  return stops.every((stop) => distancePointToPolyline(stop, shape) <= MAX_STOP_TO_SHAPE_DISTANCE);
}

/**
 * Decodes `shape.polyline` once per shape object; repeat calls with the same
 * object return the SAME decoded array (cache hit). Non-object or empty
 * inputs short-circuit to a shared empty tuple list and are not cached.
 */
export function decodePolylineCached(
  shape?: { readonly polyline?: string } | null,
): readonly [number, number][] {
  if (!shape || typeof shape !== "object" || !shape.polyline) {
    return EMPTY_DECODED_POLYLINE;
  }

  const cached = decodedPolylineCache.get(shape);
  if (cached) {
    return cached;
  }

  const decoded = decodePolyline(shape.polyline);
  // Only worth caching non-trivial decodes: degenerate/invalid strings would
  // otherwise pin garbage entries on every ad-hoc wrapper object.
  if (decoded.length > 1) {
    decodedPolylineCache.set(shape, decoded);
  }
  return decoded;
}

/**
 * Decodes a Google Encoded Polyline string into WGS84 [lat, lon] tuples.
 */
export function decodePolyline(encoded: string): [number, number][] {
  if (!encoded || typeof encoded !== "string") {
    return [];
  }

  const points: [number, number][] = [];

  let index = 0;
  let lat = 0;
  let lon = 0;

  try {
    while (index < encoded.length) {
      let b: number;
      let shift = 0;
      let result = 0;

      do {
        if (index >= encoded.length) {
          return points;
        }

        b = encoded.charCodeAt(index++) - 63;

        if (b < 0 || b > 63) {
          return points;
        }

        result |= (b & 0x1f) << shift;

        shift += 5;
      } while (b >= 0x20);

      const dlat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;

      lat += dlat;

      shift = 0;
      result = 0;

      do {
        if (index >= encoded.length) {
          return points;
        }

        b = encoded.charCodeAt(index++) - 63;

        if (b < 0 || b > 63) {
          return points;
        }

        result |= (b & 0x1f) << shift;

        shift += 5;
      } while (b >= 0x20);

      const dlon = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;

      lon += dlon;

      points.push([lat / 1e5, lon / 1e5]);
    }
  } catch {
    return points;
  }

  return points;
}

/**
 * Encodes WGS84 [lat, lon] tuples into a Google Encoded Polyline string.
 */
export function encodePolyline(points: readonly (readonly [number, number])[]): string {
  if (!points || points.length === 0) {
    return "";
  }

  let result = "";
  let prevLat = 0;
  let prevLon = 0;

  for (const [lat, lon] of points) {
    const latE5 = Math.round(lat * 1e5);
    const lonE5 = Math.round(lon * 1e5);

    result += encodeSignedNumber(latE5 - prevLat);
    result += encodeSignedNumber(lonE5 - prevLon);

    prevLat = latE5;
    prevLon = lonE5;
  }

  return result;
}

function encodeSignedNumber(num: number): string {
  let sgnNum = num < 0 ? ~(num << 1) : num << 1;
  let result = "";
  while (sgnNum >= 0x20) {
    result += String.fromCharCode((0x20 | (sgnNum & 0x1f)) + 63);
    sgnNum >>= 5;
  }
  result += String.fromCharCode(sgnNum + 63);
  return result;
}

/**
 * Constructs a smooth SVG path from map points, rounding each interior
 * corner with a quadratic curve whose radius never exceeds half of either
 * adjacent segment. Collinear vertices pass through untouched.
 */
export function buildSmoothPathD(points: readonly Point[], cornerRadius = 18): string {
  if (points.length < 2) {
    return "";
  }

  let path = `M ${points[0].x},${points[0].y}`;

  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1];

    const v1x = current.x - previous.x;
    const v1y = current.y - previous.y;
    const v2x = next.x - current.x;
    const v2y = next.y - current.y;

    const length1 = Math.hypot(v1x, v1y);
    const length2 = Math.hypot(v2x, v2y);

    if (length1 === 0 || length2 === 0) {
      path += ` L ${current.x},${current.y}`;
      continue;
    }

    const dot = (v1x * v2x + v1y * v2y) / (length1 * length2);

    if (Math.abs(dot - 1) < 0.001) {
      path += ` L ${current.x},${current.y}`;
      continue;
    }

    const radius = Math.min(cornerRadius, length1 / 2, length2 / 2);

    const startX = current.x - (v1x / length1) * radius;
    const startY = current.y - (v1y / length1) * radius;

    const endX = current.x + (v2x / length2) * radius;
    const endY = current.y + (v2y / length2) * radius;

    path += ` L ${startX},${startY}` + ` Q ${current.x},${current.y} ${endX},${endY}`;
  }

  const last = points[points.length - 1];

  return `${path} L ${last.x},${last.y}`;
}

/** Two polyline parameters this far apart are the same place on the line. */
const PARAM_EPSILON = 1e-6;

/**
 * Every parameter along `polyline` at which `target` sits, ascending. A vertex
 * and the two segments meeting it report the same parameter, so a station drawn
 * on a vertex yields one; a line that runs through a station twice (a spur, a
 * closed circuit) yields both, and the caller decides which one the service
 * actually stops at.
 */
function polylineParamsFor(polyline: readonly Point[], target: Point): number[] {
  let nearest = Infinity;
  const params: number[] = [];
  const consider = (param: number, distance: number): void => {
    if (distance < nearest - PARAM_EPSILON) {
      nearest = distance;
      params.length = 0;
    }
    if (distance <= nearest + PARAM_EPSILON) params.push(param);
  };
  polyline.forEach((point, index) => {
    consider(index, Math.hypot(target.x - point.x, target.y - point.y));
  });
  for (let index = 0; index < polyline.length - 1; index += 1) {
    const start = polyline[index];
    const end = polyline[index + 1];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) continue;
    const raw = ((target.x - start.x) * dx + (target.y - start.y) * dy) / lengthSquared;
    const t = Math.max(0, Math.min(1, raw));
    consider(index + t, Math.hypot(target.x - (start.x + t * dx), target.y - (start.y + t * dy)));
  }
  return [...new Set(params)].sort((first, second) => first - second);
}

/**
 * One monotone reading of the span's stations along the line, or undefined when
 * the declared order cannot be read off the drawing at all.
 *
 * Each station may sit at more than one parameter, so the walk takes the
 * nearest one in the direction of travel and the stations in between decide
 * which reading survives: GO's Lakeshore West runs out to Hamilton and back
 * through Aldershot, so a West Harbour-to-Aldershot span is only coherent if it
 * passes Hamilton, and the short reading that skips it is not a candidate.
 */
function monotoneSpanParams(
  candidates: readonly (readonly number[])[],
  start: number,
  forward: boolean,
): number[] | undefined {
  const chosen = [start];
  for (let index = 1; index < candidates.length; index += 1) {
    const reachable = candidates[index].filter((param) =>
      forward
        ? param > chosen[index - 1] + PARAM_EPSILON
        : param < chosen[index - 1] - PARAM_EPSILON,
    );
    if (reachable.length === 0) return undefined;
    reachable.sort(forward ? (a, b) => a - b : (a, b) => b - a);
    chosen.push(reachable[0]);
  }
  return chosen;
}

/**
 * The points a station-to-station span is drawn through, following the line's
 * own polyline between its endpoints.
 *
 * A span is a slice of a line, not a chord across it. Joining the two station
 * anchors directly cuts across every corner the line draws in between, which on
 * a stylised schematic is most of the line: GO's Lakeshore West drops from West
 * Harbour to Hamilton on a diagonal, and a straight join there ignores the
 * corridor the trains run in.
 *
 * `stationAnchors` is the span's stations in declared order, which is the
 * authority on which end of the line comes first: the reading whose traversal
 * agrees with that order wins, and the polyline's own forward direction breaks
 * a tie. Returns undefined when the drawing cannot support the span at all (no
 * polyline, an unplotted station, a declared order the line does not follow), so
 * a caller can fall back rather than draw a shape the schematic never declared.
 */
export function polylineSpanPoints(
  polyline: readonly Point[],
  stationAnchors: readonly (Point | undefined)[],
  branching = false,
): Point[] | undefined {
  if (polyline.length < 2 || stationAnchors.length < 2) return undefined;
  if (stationAnchors.some((anchor) => !anchor)) return undefined;
  const anchors = stationAnchors as readonly Point[];
  if (branching && anchors.length > 2) {
    const points: Point[] = [];
    for (let index = 1; index < anchors.length; index += 1) {
      const segment = polylineSpanPoints(polyline, [anchors[index - 1], anchors[index]], true);
      if (!segment) return undefined;
      points.push(...(index === 1 ? segment : segment.slice(1)));
    }
    return points;
  }
  const candidates = anchors.map((anchor) => polylineParamsFor(polyline, anchor));

  let shortest: Point[] | undefined;
  let shortestLength = Infinity;
  for (const forward of [true, false]) {
    for (const start of candidates[0]) {
      const params = monotoneSpanParams(candidates, start, forward);
      if (!params) continue;
      const points: Point[] = [];
      anchors.forEach((anchor, index) => {
        points.push(anchor);
        const next = params[index + 1];
        if (next === undefined) return;
        if (forward) {
          for (let i = Math.floor(params[index]) + 1; i < Math.ceil(next); i += 1) {
            if (i > 0 && i < polyline.length - 1) points.push(polyline[i]);
          }
          return;
        }
        for (let i = Math.ceil(params[index]) - 1; i > Math.floor(next); i -= 1) {
          if (i > 0 && i < polyline.length - 1) points.push(polyline[i]);
        }
      });
      if (!branching) return points;
      const length = points
        .slice(1)
        .reduce(
          (sum, point, i) => sum + Math.hypot(point.x - points[i].x, point.y - points[i].y),
          0,
        );
      if (length < shortestLength) {
        shortest = points;
        shortestLength = length;
      }
    }
  }
  return shortest;
}

/**
 * Constructs an SVG path from map points.
 */
export function buildRouteSvgPathD(points: readonly Point[]): string {
  if (points.length === 0) {
    return "";
  }

  if (points.length === 1) {
    return `M ${points[0].x},${points[0].y}`;
  }

  let d = `M ${points[0].x},${points[0].y}`;

  for (let i = 1; i < points.length; i++) {
    d += ` L ${points[i].x},${points[i].y}`;
  }

  return d;
}

// ---------------------------------------------------------------------------
// Config-bound engine
// ---------------------------------------------------------------------------

/**
 * Binds the generic geometry engine to one agency's schematic-map constants.
 *
 * All returned methods are plain closures (no `this`), so consumers may
 * destructure them freely.
 */
export function createMapGeometry(config: MapGeometryConfig): MapGeometryEngine {
  const { projection, defaultBounds } = config;

  const lonScale =
    (projection.refXEast - projection.refXWest) / (projection.refLonEast - projection.refLonWest);

  const latScale =
    (projection.refYSouth - projection.refYNorth) /
    (projection.refLatNorth - projection.refLatSouth);

  /**
   * Drawn line geometry indexed by `snapLineKey`. Built once per agency: a
   * schematic's lines never change for a given configuration. Two drawn lines
   * whose ids normalise identically are the same key by that grammar, so the
   * first one drawn owns it and the later one cannot shadow it.
   */
  const snapTargets = new Map<string, readonly Point[]>();
  for (const line of config.snapLines ?? []) {
    const key = snapLineKey(line.id);
    if (!key || snapTargets.has(key)) continue;
    snapTargets.set(key, line.points);
  }

  const projectAffine = (lat: number, lon: number): Point => {
    const x = projection.refXWest + (lon - projection.refLonWest) * lonScale;

    const y = projection.refYNorth + (projection.refLatNorth - lat) * latScale;

    return { x: roundToHundredth(x), y: roundToHundredth(y) };
  };

  // Derived from this schematic's own stylisation, never a shared constant:
  // see deriveSnapDistanceRatio for why one number cannot serve every canvas.
  const canvasDiagonal = Math.hypot(config.viewport.viewBoxWidth, config.viewport.viewBoxHeight);
  const snapCutoffRatio = deriveSnapDistanceRatio(
    config.stylisedStations ?? [],
    config.snapLines ?? [],
    canvasDiagonal,
    projectAffine,
  );
  const snapCutoff = snapCutoffRatio * canvasDiagonal;

  /**
   * Moves an affine point onto the drawn line it is attributed to.
   *
   * Attribution is what makes this safe: a point is only ever a candidate for
   * the one line it is declared on, so no correction here can reach a
   * neighbouring trunk. The cutoff then bounds how large that correction may
   * be. A point whose attribution names no drawn line, or whose nearest point on
   * that line is further away than the cutoff, is returned exactly as
   * projected, so bad feed data and branches the schematic does not draw stay
   * visibly where the feed put them.
   *
   * A point that projects past the END of the line is returned unprojected too.
   * It has no nearest point on the line, only the nearest endpoint, and clamping
   * to that endpoint maps every such point in the region onto one vertex. On GO's
   * Lakeshore East that collapsed all eleven stops onto Union, which then framed
   * the camera to a 20x20 box. Attribution alone cannot prevent this, because the
   * collapse happens within the one line the point is attributed to.
   */
  const snapToAttributedLine = (point: Point, attribution?: SnapAttribution): Point => {
    if (!attribution) return point;
    const target = snapTargets.get(snapLineKey(attribution.lineId));
    if (!target) return point;
    const nearest = nearestPointOnPolyline(point, target);
    if (!nearest || nearest.offTheEnd || nearest.distance > snapCutoff) return point;
    return { x: roundToHundredth(nearest.point.x), y: roundToHundredth(nearest.point.y) };
  };

  const projectGeoToMapPoint = (lat: number, lon: number, attribution?: SnapAttribution): Point =>
    snapToAttributedLine(projectAffine(lat, lon), attribution);

  /**
   * The drawn line's own authored points, or `undefined` when this schematic
   * draws no line by that name.
   *
   * This is the corridor at the scale the schematic actually draws it. The
   * affine projection cannot stand in for it: it maps real coordinates onto the
   * canvas linearly, while a schematic is stylised, and the two disagree by a
   * per-schematic factor. On GO's Lakeshore West the drawn line spans 540 units
   * and the same stations project to 314, and on Union Pearson 333 against 55,
   * so a trip's own shape lands as a stub well inside the line the rider is
   * looking at. Framing or drawing the feed's projection therefore cannot show
   * the full route no matter how the projection is tuned.
   *
   * Returned as a fresh array so a caller cannot reach into the snap index.
   */
  const drawnLineMapPoints = (lineId: string): Point[] | undefined => {
    const target = snapTargets.get(snapLineKey(lineId));
    if (!target || target.length < 2) return undefined;
    return target.map((point) => ({ x: roundToHundredth(point.x), y: roundToHundredth(point.y) }));
  };

  const extractRouteMapPoints = (
    shape?: {
      polyline?: string;
    } | null,
    stops?: readonly SurfaceRouteStop[] | null,
    attribution?: SnapAttribution,
  ): Point[] => {
    // The shape-versus-stop-sequence choice is a question about the feed's own
    // geometry, not about the schematic's stylisation, so it is decided on the
    // affine points. Only the corridor that survives that choice is snapped.
    const affineStops = stops?.map((stop) => projectAffine(stop.lat, stop.lon)) ?? [];

    // If the feed provides a shape/polyline, use it.
    //
    // Otherwise, use the ordered stop sequence. This matters because live
    // feeds do not require previously persisted GTFS shapes.
    if (shape?.polyline && shape.polyline.length > 5) {
      const decoded = decodePolylineCached(shape);

      if (decoded.length > 1) {
        const affineShape = decoded.map(([lat, lon]) => projectAffine(lat, lon));

        // Some feeds publish a stop pattern without a matching shape (for
        // example, a branch or short turn). Never pair that stop list with a
        // different corridor: use the ordered stops so the line and nodes
        // remain one coherent route variant.
        if (affineStops.length === 0 || shapeCoversStops(affineShape, affineStops)) {
          return affineShape.map((point) => snapToAttributedLine(point, attribution));
        }
      }
    }

    if (affineStops.length > 0) {
      return affineStops.map((point) => snapToAttributedLine(point, attribution));
    }

    return [];
  };

  const projectGeoBoundingBoxToMapBounds = (box: {
    minLat: number;
    maxLat: number;
    minLon: number;
    maxLon: number;
  }): MapBoundingBox => {
    // A bounding box is an extent, not a marker: snapping its corners onto a
    // drawn line would shrink the box toward that line and frame the camera on
    // less of the route than is actually drawn. Extents stay affine.
    const p1 = projectAffine(box.maxLat, box.minLon);

    const p2 = projectAffine(box.minLat, box.maxLon);

    const minX = Math.min(p1.x, p2.x);

    const maxX = Math.max(p1.x, p2.x);

    const minY = Math.min(p1.y, p2.y);

    const maxY = Math.max(p1.y, p2.y);

    const width = Math.max(10, maxX - minX);

    const height = Math.max(10, maxY - minY);

    return {
      minX,
      maxX,
      minY,
      maxY,
      width,
      height,
      centerX: minX + width / 2,
      centerY: minY + height / 2,
    };
  };

  const computeRouteBoundingBox = (
    points: readonly (Point | [number, number])[],
  ): MapBoundingBox => {
    if (points.length === 0) {
      return defaultBounds;
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const pt of points) {
      let x: number;
      let y: number;

      if (Array.isArray(pt)) {
        // Raw [lat, lon] tuples carry no attribution, so they land on the same
        // affine point the route's own corridor was measured against.
        const projected = projectAffine(pt[0], pt[1]);

        x = projected.x;
        y = projected.y;
      } else {
        x = pt.x;
        y = pt.y;
      }

      minX = Math.min(minX, x);

      maxX = Math.max(maxX, x);

      minY = Math.min(minY, y);

      maxY = Math.max(maxY, y);
    }

    const width = Math.max(20, maxX - minX);

    const height = Math.max(20, maxY - minY);

    return {
      minX,
      maxX,
      minY,
      maxY,
      width,
      height,
      centerX: minX + width / 2,
      centerY: minY + height / 2,
    };
  };

  return {
    snapCutoffRatio,
    projectGeoToMapPoint,
    drawnLineMapPoints,
    extractRouteMapPoints,
    projectGeoBoundingBoxToMapBounds,
    computeRouteBoundingBox,
  };
}
