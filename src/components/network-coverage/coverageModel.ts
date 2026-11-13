/**
 * Data shaping for the network coverage overlay.
 *
 * Reads the same agency facts as the main map; the generated geography keeps
 * the overlay working as the agency catalog expands beyond Ontario.
 */
import type { BrowserAgency, BoundingBox } from "~/agencies/types";
import { manifestFallbackBounds, manifestFocus } from "~/domain/location/EffectiveAgency";
import {
  GENERATED_COVERAGE_COUNTRIES,
  GENERATED_COVERAGE_REGIONS,
  type CoverageGeoPolygon,
  type CoverageGeography,
} from "./generated/geography";

export interface GeoBounds {
  readonly minLat: number;
  readonly maxLat: number;
  readonly minLon: number;
  readonly maxLon: number;
}

export interface CoverageAgency {
  readonly id: string;
  readonly name: string;
  readonly shortName: string;
  readonly color: string;
  readonly glow: string;
  readonly status: "active" | "experimental";
  readonly scope: "regional" | "national" | "international";
  readonly countries: readonly string[];
  readonly modes: readonly string[];
  readonly bounds: readonly BoundingBox[];
  /** Visual anchor for the marker and label, kept inside a declared service area. */
  readonly center: { readonly lat: number; readonly lon: number };
  /**
   * Marker and label anchor. National and international networks use the
   * station nearest the middle of their declared extent, because their
   * operational focus is often one terminal rather than the network centre.
   */
  readonly labelCenter: { readonly lat: number; readonly lon: number };
  readonly footprint: GeoBounds;
  readonly isCurrent: boolean;
}

export interface CoverageView {
  readonly id: "all";
  readonly label: string;
  readonly bounds: GeoBounds;
  /** The opening camera frame: the dense southern plate, not the whole province. */
  readonly focusBounds: GeoBounds;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export type ProjectPoint = (lon: number, lat: number) => Point;

export interface Projection {
  readonly project: ProjectPoint;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  /** Horizontal pixels per latitude-degree equivalent at a projected y coordinate. */
  readonly horizontalScaleAt: (y: number) => number;
  readonly unproject: (point: Point) => GeoCenter;
}

export interface LabelPlacement {
  readonly x: number;
  readonly y: number;
  readonly anchor: "start" | "middle" | "end";
}

const DEFAULT_AGENCY_COLOR = "#7dd3fc";

const SCOPE_ORDER: Readonly<Record<CoverageAgency["scope"], number>> = {
  regional: 0,
  national: 1,
  international: 2,
};

/** Latitude north of which a regional agency stops defining the opening frame. */
const SOUTHERN_PLATE_MAX_LAT = 46;
const FOCUS_PADDING_DEGREES = 0.08;
const GEOGRAPHY_PADDING_DEGREES = 0.3;
const BOUNDARY_FADE_START_ZOOM = 3.5;
const BOUNDARY_FADE_END_ZOOM = 7;
const BOUNDARY_MAX_OPACITY = 0.16;

/** One degree of latitude is close enough to constant for a screen scale bar. */
export const KILOMETERS_PER_LATITUDE_DEGREE = 111.32;
const KILOMETERS_PER_MILE = 1.609344;
const SCALE_BAR_OPTIONS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000] as const;
const SCALE_BAR_MAX_PIXELS = 140;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Area-weighted center of the service rectangles. The union midpoint can land
 * in the gap between disjoint bounds, which visually detaches the label from
 * the dominant coverage cloud.
 */
function coverageCenter(bounds: readonly BoundingBox[]): { lat: number; lon: number } {
  let weight = 0;
  let lat = 0;
  let lon = 0;
  for (const box of bounds) {
    const area = Math.max((box.maxLat - box.minLat) * (box.maxLon - box.minLon), 0);
    if (area === 0) continue;
    lat += ((box.minLat + box.maxLat) / 2) * area;
    lon += ((box.minLon + box.maxLon) / 2) * area;
    weight += area;
  }
  if (weight > 0) {
    const center = { lat: lat / weight, lon: lon / weight };
    if (bounds.some((box) => boundsContain(box, center))) return center;
    // Equal or widely separated zones can put even the weighted center in a gap.
    const largest = bounds.reduce((best, box) =>
      (box.maxLat - box.minLat) * (box.maxLon - box.minLon) >
      (best.maxLat - best.minLat) * (best.maxLon - best.minLon)
        ? box
        : best,
    );
    return {
      lat: (largest.minLat + largest.maxLat) / 2,
      lon: (largest.minLon + largest.maxLon) / 2,
    };
  }
  const union = boundsUnion(bounds);
  return { lat: (union.minLat + union.maxLat) / 2, lon: (union.minLon + union.maxLon) / 2 };
}

function boundsContain(bounds: BoundingBox, point: { lat: number; lon: number }): boolean {
  return (
    point.lat >= bounds.minLat &&
    point.lat <= bounds.maxLat &&
    point.lon >= bounds.minLon &&
    point.lon <= bounds.maxLon
  );
}

/**
 * Prefer the operational focus the rest of the app resolves. When that point
 * falls in the gap between disjoint service rectangles, use the area-weighted
 * center so the marker stays on a coverage cloud.
 */
function coverageMarkerCenter(manifest: BrowserAgency["manifest"]): { lat: number; lon: number } {
  const focus = manifestFocus(manifest);
  return manifest.bounds.some((bounds) => boundsContain(bounds, focus))
    ? focus
    : coverageCenter(manifest.bounds);
}

/**
 * Anchor a network-wide label at the station nearest the middle of its
 * declared extent. A national operator's focus is usually one terminal, so
 * using it would put the label at the edge of the network.
 */
function networkMarkerCenter(bounds: readonly BoundingBox[]): { lat: number; lon: number } {
  const union = boundsUnion(bounds);
  const target = {
    lat: (union.minLat + union.maxLat) / 2,
    lon: (union.minLon + union.maxLon) / 2,
  };
  let nearest = bounds[0];
  if (!nearest) return target;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const box of bounds) {
    const lat = (box.minLat + box.maxLat) / 2;
    const lon = (box.minLon + box.maxLon) / 2;
    const dLat = lat - target.lat;
    const dLon = (lon - target.lon) * Math.cos((target.lat * Math.PI) / 180);
    const distance = dLat * dLat + dLon * dLon;
    if (distance < nearestDistance) {
      nearest = box;
      nearestDistance = distance;
    }
  }
  return {
    lat: (nearest.minLat + nearest.maxLat) / 2,
    lon: (nearest.minLon + nearest.maxLon) / 2,
  };
}

function parseHex(color: string): readonly [number, number, number] | undefined {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return undefined;
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** Lift dark brand colors so they stay legible on the near-black canvas. */
export function brighten(color: string, amount = 0.28): string {
  const rgb = parseHex(color);
  if (!rgb) return color;
  const mix = (channel: number) => Math.round(channel + (255 - channel) * amount);
  const [red, green, blue] = rgb;
  return `#${[mix(red), mix(green), mix(blue)]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

export function agencyColor(agency: BrowserAgency): string {
  const brand = agency.brandColor?.trim();
  return brand && parseHex(brand) ? brand : DEFAULT_AGENCY_COLOR;
}

export function boundsUnion(bounds: readonly BoundingBox[]): GeoBounds {
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  for (const box of bounds) {
    minLat = Math.min(minLat, box.minLat);
    maxLat = Math.max(maxLat, box.maxLat);
    minLon = Math.min(minLon, box.minLon);
    maxLon = Math.max(maxLon, box.maxLon);
  }
  return { minLat, maxLat, minLon, maxLon };
}

export function expandBounds(bounds: GeoBounds, padding: number): GeoBounds {
  return {
    minLat: bounds.minLat - padding,
    maxLat: bounds.maxLat + padding,
    minLon: bounds.minLon - padding,
    maxLon: bounds.maxLon + padding,
  };
}

/** Admin-1 borders stay hidden until the camera passes 3.5x zoom. */
export function boundaryOpacityForZoom(zoom: number): number {
  const progress = clamp(
    (zoom - BOUNDARY_FADE_START_ZOOM) / (BOUNDARY_FADE_END_ZOOM - BOUNDARY_FADE_START_ZOOM),
    0,
    1,
  );
  return BOUNDARY_MAX_OPACITY * progress;
}

/** Longest side of an agency's declared service footprint, in kilometres. */
export function agencySpanKilometers(agency: Pick<CoverageAgency, "footprint">): number {
  const { footprint } = agency;
  const latSpan = (footprint.maxLat - footprint.minLat) * KILOMETERS_PER_LATITUDE_DEGREE;
  const midLat = (footprint.minLat + footprint.maxLat) / 2;
  const lonSpan =
    (footprint.maxLon - footprint.minLon) *
    KILOMETERS_PER_LATITUDE_DEGREE *
    Math.cos((midLat * Math.PI) / 180);
  return Math.round(Math.max(latSpan, lonSpan));
}

export interface ScaleBar {
  readonly length: number;
  readonly distance: number;
  readonly unit: "km" | "mi";
}

/**
 * Pick the longest round distance that fits the scale bar. `projectionScale`
 * is pixels per degree of latitude, so the imperial conversion only happens
 * once and never applies a second longitude correction.
 */
export function scaleBarFor(
  projectionScale: number,
  zoom: number,
  unitSystem: "metric" | "imperial",
): ScaleBar {
  const pixelsPerKilometer = (projectionScale * zoom) / KILOMETERS_PER_LATITUDE_DEGREE;
  const pixelsPerUnit =
    unitSystem === "metric" ? pixelsPerKilometer : pixelsPerKilometer * KILOMETERS_PER_MILE;
  const distance =
    [...SCALE_BAR_OPTIONS]
      .reverse()
      .find((value) => pixelsPerUnit * value <= SCALE_BAR_MAX_PIXELS) ?? SCALE_BAR_OPTIONS[0];
  return {
    length: pixelsPerUnit * distance,
    distance,
    unit: unitSystem === "metric" ? "km" : "mi",
  };
}

const COUNTRY_REGIONS = GENERATED_COVERAGE_COUNTRIES.map(
  (country) => GENERATED_COVERAGE_REGIONS[country.id],
);
const ADMIN1_REGIONS = GENERATED_COVERAGE_COUNTRIES.flatMap((country) =>
  country.admin1Ids.map((id) => GENERATED_COVERAGE_REGIONS[id]),
);

/** Border layer: every generated country's subdivisions, in drawn order. */
export const COVERAGE_BOUNDARIES: readonly CoverageGeography[] = ADMIN1_REGIONS;

/** Shared citations from every drawn country, in generated order. */
export const COVERAGE_SOURCES: readonly { label: string; url: string }[] = (() => {
  const cited = new Set<string>();
  const sources: Array<{ label: string; url: string }> = [];
  for (const country of GENERATED_COVERAGE_COUNTRIES) {
    for (const source of country.sources) {
      const key = `${source.label} ${source.attributionUrl}`;
      if (cited.has(key)) continue;
      cited.add(key);
      sources.push({ label: source.label, url: source.attributionUrl });
    }
  }
  return sources;
})();

function listLabel(labels: readonly string[]): string {
  if (labels.length < 2) return labels[0] ?? "";
  const head = labels.slice(0, -1).join(", ");
  return `${head} and ${labels[labels.length - 1]}`;
}

/** English aggregate name for the data record; the UI label is localized separately. */
const LANDMASS_LABEL = listLabel(GENERATED_COVERAGE_COUNTRIES.map((country) => country.label));

/**
 * The map's landmass: every country the generator draws. Country outlines
 * draw the coastlines and shared borders at every zoom. Admin-1 borders live
 * in `COVERAGE_BOUNDARIES` and fade in separately.
 */
export const COVERAGE_GEOGRAPHY: CoverageGeography = {
  id: "landmass",
  label: LANDMASS_LABEL,
  source: listLabel([...new Set(COVERAGE_SOURCES.map((source) => source.label))]),
  // CoverageGeography repeats the display label as the matched feature name.
  sourceFeature: LANDMASS_LABEL,
  bounds: boundsUnion(COUNTRY_REGIONS.map((region) => region.bounds)),
  polygons: COUNTRY_REGIONS.flatMap((region) =>
    (region.polygons as readonly CoverageGeoPolygon[]).slice(),
  ),
};

export interface GeoCenter {
  readonly lat: number;
  readonly lon: number;
}

function ringContains(ring: readonly (readonly [number, number])[], point: GeoCenter): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > point.lat !== yj > point.lat &&
      point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

const outerBoundsCache = new WeakMap<object, GeoBounds>();

/** Outer-ring bounds, computed once, so most polygons reject a point in O(1). */
function outerBounds(polygon: { readonly outer: readonly (readonly [number, number])[] }) {
  let bounds = outerBoundsCache.get(polygon);
  if (!bounds) {
    let minLon = Infinity;
    let maxLon = -Infinity;
    let minLat = Infinity;
    let maxLat = -Infinity;
    for (const [lon, lat] of polygon.outer) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    bounds = { minLon, maxLon, minLat, maxLat };
    outerBoundsCache.set(polygon, bounds);
  }
  return bounds;
}

/**
 * Use detailed country geometry independently of the simplified map drawing.
 * The coverage header calls this for every pan frame, so each polygon is
 * bounds-checked before any ring walk.
 */
export function focusedCoverageCountry(
  point: GeoCenter,
  countries: Readonly<Record<string, CoverageGeography>>,
): string | undefined {
  return Object.values(countries).find(
    (country) =>
      boundsContain(country.bounds, point) &&
      country.polygons.some(
        (polygon) =>
          boundsContain(outerBounds(polygon), point) &&
          ringContains(polygon.outer, point) &&
          !(polygon.holes ?? []).some((hole) => ringContains(hole, point)),
      ),
  )?.id;
}

export function coverageCountsForCountry(
  agencies: readonly CoverageAgency[],
  country: string | undefined,
) {
  const counts = { total: 0, regional: 0, national: 0, international: 0 };
  if (!country) return counts;
  for (const agency of agencies) {
    if (!agency.countries.includes(country)) continue;
    counts.total += 1;
    counts[agency.scope] += 1;
  }
  return counts;
}

/** Jurisdiction and service-zone centres define membership independently of scope. */
function agencyCountries(
  manifest: BrowserAgency["manifest"],
  geography: Readonly<Record<string, CoverageGeography>>,
): readonly string[] {
  const countries = new Set<string>();
  const home = manifest.jurisdiction?.country;
  if (home) countries.add(home.toLowerCase());
  for (const bounds of manifest.bounds) {
    const country = focusedCoverageCountry(
      {
        lat: (bounds.minLat + bounds.maxLat) / 2,
        lon: (bounds.minLon + bounds.maxLon) / 2,
      },
      geography,
    );
    if (country) countries.add(country);
  }
  return [...countries];
}

export function buildCoverageAgencies(
  providers: readonly BrowserAgency[],
  currentAgencyId: string | undefined,
  countries: Readonly<Record<string, CoverageGeography>>,
): readonly CoverageAgency[] {
  return providers
    .map((provider) => {
      const { manifest } = provider;
      const color = agencyColor(provider);
      const scope = manifest.scope ?? "regional";
      const center = coverageMarkerCenter(manifest);
      return {
        id: manifest.id,
        name: manifest.name,
        shortName: manifest.shortName ?? manifest.id.toUpperCase(),
        color,
        glow: brighten(color),
        status: manifest.status,
        scope,
        countries: agencyCountries(manifest, countries),
        modes: manifest.modes,
        bounds: manifest.bounds,
        center,
        labelCenter: scope === "regional" ? center : networkMarkerCenter(manifest.bounds),
        footprint: manifestFallbackBounds(manifest),
        isCurrent: manifest.id === currentAgencyId,
      } satisfies CoverageAgency;
    })
    .sort((left, right) => {
      const scopeDifference = SCOPE_ORDER[left.scope] - SCOPE_ORDER[right.scope];
      return scopeDifference !== 0 ? scopeDifference : left.name.localeCompare(right.name);
    });
}

/**
 * One continuous projection over every mapped regional network. The camera
 * opens on the dense southern plate; panning north reveals the rest without a
 * second map. When the catalog grows, derive this from `manifest.jurisdiction`
 * plus the generated geography list.
 */
export function buildCoverageView(agencies: readonly CoverageAgency[]): CoverageView {
  const regional = agencies.filter((agency) => agency.scope === "regional");
  const mapped = regional.length > 0 ? regional : agencies;
  const south = mapped.filter((agency) => agency.center.lat < SOUTHERN_PLATE_MAX_LAT);
  const focus = south.length > 0 ? south : mapped;
  return {
    id: "all",
    label: COVERAGE_GEOGRAPHY.label,
    bounds: expandBounds(COVERAGE_GEOGRAPHY.bounds, GEOGRAPHY_PADDING_DEGREES),
    focusBounds: expandBounds(
      boundsUnion(focus.map((agency) => agency.footprint)),
      FOCUS_PADDING_DEGREES,
    ),
  };
}

export function agencyById(
  agencies: readonly CoverageAgency[],
  id: string | undefined,
): CoverageAgency | undefined {
  return id ? agencies.find((agency) => agency.id === id) : undefined;
}

/**
 * Equirectangular projection with a cos(latitude) correction, fitted into a
 * fixed pixel box while preserving aspect ratio.
 */
export function createProjection(
  bounds: GeoBounds,
  width: number,
  height: number,
  padding = 12,
): Projection {
  const midLat = (bounds.minLat + bounds.maxLat) / 2;
  const lonScale = Math.cos((midLat * Math.PI) / 180);
  const spanX = Math.max((bounds.maxLon - bounds.minLon) * lonScale, 1e-6);
  const spanY = Math.max(bounds.maxLat - bounds.minLat, 1e-6);
  const innerWidth = Math.max(width - padding * 2, 1);
  const innerHeight = Math.max(height - padding * 2, 1);
  const scale = Math.min(innerWidth / spanX, innerHeight / spanY);
  const offsetX = (width - spanX * scale) / 2;
  const offsetY = (height - spanY * scale) / 2;
  const project: ProjectPoint = (lon, lat) => ({
    x: offsetX + (lon - bounds.minLon) * lonScale * scale,
    y: offsetY + (bounds.maxLat - lat) * scale,
  });
  const horizontalScaleAt = (y: number) => {
    const latitude = clamp(bounds.maxLat - (y - offsetY) / scale, -89, 89);
    return (scale * lonScale) / Math.cos((latitude * Math.PI) / 180);
  };
  const unproject = (point: Point): GeoCenter => ({
    lon: bounds.minLon + (point.x - offsetX) / (lonScale * scale),
    lat: bounds.maxLat - (point.y - offsetY) / scale,
  });
  return { project, unproject, width, height, scale, horizontalScaleAt };
}

type GeoRing = readonly (readonly [number, number])[];

function ringPath(ring: GeoRing, project: ProjectPoint, close: boolean): string {
  let path = "";
  for (let index = 0; index < ring.length; index += 1) {
    const point = project(ring[index][0], ring[index][1]);
    path += `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`;
  }
  return close && path ? `${path}Z` : path;
}

export function geographyPath(geography: CoverageGeography, project: ProjectPoint): string {
  return geography.polygons
    .map(
      (polygon) =>
        ringPath(polygon.outer, project, true) +
        (polygon.holes ?? []).map((hole) => ringPath(hole, project, true)).join(""),
    )
    .join("");
}

/** Open polylines drawn as one path; used for outline pieces that need no fill. */
export function runsPath(runs: readonly GeoRing[], project: ProjectPoint): string {
  return runs.map((run) => ringPath(run, project, false)).join("");
}

const OUTLINE_RUN_POINTS = 48;

/** Short open runs grouped by grid cell, so each raster tile restrokes only nearby outline. */
export function outlineChunks(
  geography: Pick<CoverageGeography, "polygons">,
  cellDegrees: number,
): readonly (readonly GeoRing[])[] {
  const cells = new Map<string, GeoRing[]>();
  const addRun = (run: GeoRing) => {
    const key = `${Math.floor(run[0][0] / cellDegrees)},${Math.floor(run[0][1] / cellDegrees)}`;
    const cell = cells.get(key);
    if (cell) cell.push(run);
    else cells.set(key, [run]);
  };
  for (const polygon of geography.polygons) {
    for (const ring of [polygon.outer, ...(polygon.holes ?? [])]) {
      if (ring.length < 2) continue;
      const first = ring[0];
      const last = ring[ring.length - 1];
      const closed = first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first];
      let run = [closed[0]];
      let bounds = { minLon: first[0], maxLon: first[0], minLat: first[1], maxLat: first[1] };
      for (let index = 1; index < closed.length; index += 1) {
        const [lon, lat] = closed[index];
        const next = {
          minLon: Math.min(bounds.minLon, lon),
          maxLon: Math.max(bounds.maxLon, lon),
          minLat: Math.min(bounds.minLat, lat),
          maxLat: Math.max(bounds.maxLat, lat),
        };
        const leavesCell =
          next.maxLon - next.minLon > cellDegrees || next.maxLat - next.minLat > cellDegrees;
        if (run.length > 1 && (run.length > OUTLINE_RUN_POINTS || leavesCell)) {
          addRun(run);
          const [startLon, startLat] = closed[index - 1];
          run = [closed[index - 1]];
          bounds = {
            minLon: Math.min(startLon, lon),
            maxLon: Math.max(startLon, lon),
            minLat: Math.min(startLat, lat),
            maxLat: Math.max(startLat, lat),
          };
        } else {
          bounds = next;
        }
        run.push(closed[index]);
      }
      if (run.length > 1) addRun(run);
    }
  }
  return [...cells.values()];
}

export interface ProjectedRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function projectBounds(bounds: BoundingBox, project: ProjectPoint): ProjectedRect {
  const topLeft = project(bounds.minLon, bounds.maxLat);
  const bottomRight = project(bounds.maxLon, bounds.minLat);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: Math.max(bottomRight.x - topLeft.x, 1),
    height: Math.max(bottomRight.y - topLeft.y, 1),
  };
}

/** Smooth blob around a projected rectangle, so coverage reads organic, not boxy. */
export function blobPath(rect: ProjectedRect, seed: number): string {
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const radiusX = Math.max(rect.width / 2, 3);
  const radiusY = Math.max(rect.height / 2, 3);
  const points: Point[] = [];
  const count = 14;
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2;
    const wobble = 0.9 + 0.1 * Math.sin(angle * 3 + seed) + 0.06 * Math.cos(angle * 5 + seed * 1.7);
    points.push({
      x: centerX + Math.cos(angle) * radiusX * wobble,
      y: centerY + Math.sin(angle) * radiusY * wobble,
    });
  }
  const midpoint = (start: Point, end: Point) => ({
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2,
  });
  const first = points[0];
  const last = points[points.length - 1];
  const initial = midpoint(last, first);
  let path = `M${initial.x.toFixed(1)},${initial.y.toFixed(1)}`;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const control = current;
    const end = midpoint(current, next);
    path += `Q${control.x.toFixed(1)},${control.y.toFixed(1)} ${end.x.toFixed(1)},${end.y.toFixed(1)}`;
  }
  return `${path}Z`;
}

/** One service zone's blob, seeded so every layer draws the same shape. */
export function zonePath(
  agency: Pick<CoverageAgency, "id" | "bounds">,
  index: number,
  project: ProjectPoint,
): string {
  return blobPath(projectBounds(agency.bounds[index], project), index + agency.id.length);
}

/** Every service zone of one agency as one compound path, so a halo is one element. */
export function coveragePath(
  agency: Pick<CoverageAgency, "id" | "bounds">,
  project: ProjectPoint,
): string {
  return agency.bounds.map((_, index) => zonePath(agency, index, project)).join("");
}

/**
 * Place labels with a tiny greedy collision solver. This is what keeps the
 * Toronto cluster readable without hiding the rest of the map.
 */
export function layoutLabels(
  items: readonly {
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly text: string;
    readonly priority: number;
  }[],
  width: number,
  height: number,
  textScale = 1,
): ReadonlyMap<string, LabelPlacement> {
  const placed: Array<{
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
  }> = [];
  const result = new Map<string, LabelPlacement>();
  const candidates = [
    { dx: 10, dy: -5, anchor: "start" as const },
    { dx: -10, dy: -5, anchor: "end" as const },
    { dx: 0, dy: -17, anchor: "middle" as const },
    { dx: 0, dy: 17, anchor: "middle" as const },
    { dx: 13, dy: 12, anchor: "start" as const },
    { dx: -13, dy: 12, anchor: "end" as const },
    { dx: 13, dy: -18, anchor: "start" as const },
    { dx: -13, dy: -18, anchor: "end" as const },
  ];
  const ordered = [...items].sort((left, right) => right.priority - left.priority);
  for (const item of ordered) {
    const estimateWidth = clamp(item.text.length * 5.6 + 8, 18, 130) * textScale;
    const estimateHeight = 11 * textScale;
    for (const candidate of candidates) {
      const x = item.x + candidate.dx * textScale;
      const y = item.y + candidate.dy * textScale;
      const left =
        candidate.anchor === "start"
          ? x
          : candidate.anchor === "end"
            ? x - estimateWidth
            : x - estimateWidth / 2;
      const right = left + estimateWidth;
      const top = y - estimateHeight;
      const bottom = y + 3;
      if (left < 2 || right > width - 2 || top < 2 || bottom > height - 2) continue;
      const collides = placed.some(
        (box) => left < box.right && right > box.left && top < box.bottom && bottom > box.top,
      );
      if (collides) continue;
      placed.push({ left, right, top, bottom });
      result.set(item.id, { x, y, anchor: candidate.anchor });
      break;
    }
  }
  return result;
}
