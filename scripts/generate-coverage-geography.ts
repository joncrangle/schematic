#!/usr/bin/env bun
/**
 * Generate the simplified geography rings used by the network coverage
 * overlay.
 *
 * Adding a province, state, or country is one config entry in
 * `COVERAGE_REGIONS` below. The source data comes from Natural Earth's
 * 1:50m boundaries (public domain), which cover every country and first-level
 * subdivision, so the same generator keeps working as the agency catalog
 * expands beyond Ontario.
 *
 * Usage:
 *   bun run coverage:geography          # writes the generated module
 *   bun run coverage:geography:check    # fails when the checked-in copy is stale
 *   bun scripts/generate-coverage-geography.ts --refresh  # ignore cache
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

type GeographySourceId = "admin1" | "admin0" | "countryCanada" | "countryUnitedStates";

interface GeographySource {
  readonly id: GeographySourceId;
  readonly label: string;
  readonly url: string;
  readonly license: string;
  readonly attributionUrl: string;
}

interface CoverageRegionConfig {
  /** Stable id used by the coverage UI and future agency jurisdiction matching. */
  readonly id: string;
  readonly label: string;
  readonly source: GeographySourceId;
  /** Match against any feature property, for example `iso_3166_2: "CA-ON"`. */
  readonly match: Readonly<Record<string, string>>;
  /** Douglas-Peucker tolerance in degrees. Smaller keeps more coastline detail. */
  readonly simplifyTolerance?: number;
  /** Drop island polygons smaller than this shoelace area (square degrees). */
  readonly minPolygonArea?: number;
  /**
   * Drop polygons whose outer ring lies entirely east of this longitude.
   * Natural Earth stores the far-west Aleutians at positive longitudes, which
   * would otherwise stretch a North American map across the antimeridian.
   */
  readonly dropPolygonsEastOf?: number;
}

/**
 * Add new coverage regions here. A province/state uses `admin1`; a whole
 * country uses `admin0`. Selectors use Natural Earth properties:
 *
 *   { id: "ca-bc", label: "British Columbia", source: "admin1",
 *     match: { iso_3166_2: "CA-BC" } }
 *   { id: "us-wa", label: "Washington", source: "admin1",
 *     match: { iso_3166_2: "US-WA" } }
 *   { id: "fr", label: "France", source: "admin0", match: { ADM0_A3: "FRA" } }
 */
const US_STATES = [
  ["AL", "Alabama"],
  ["AK", "Alaska"],
  ["AZ", "Arizona"],
  ["AR", "Arkansas"],
  ["CA", "California"],
  ["CO", "Colorado"],
  ["CT", "Connecticut"],
  ["DE", "Delaware"],
  ["FL", "Florida"],
  ["GA", "Georgia"],
  ["HI", "Hawaii"],
  ["ID", "Idaho"],
  ["IL", "Illinois"],
  ["IN", "Indiana"],
  ["IA", "Iowa"],
  ["KS", "Kansas"],
  ["KY", "Kentucky"],
  ["LA", "Louisiana"],
  ["ME", "Maine"],
  ["MD", "Maryland"],
  ["MA", "Massachusetts"],
  ["MI", "Michigan"],
  ["MN", "Minnesota"],
  ["MS", "Mississippi"],
  ["MO", "Missouri"],
  ["MT", "Montana"],
  ["NE", "Nebraska"],
  ["NV", "Nevada"],
  ["NH", "New Hampshire"],
  ["NJ", "New Jersey"],
  ["NM", "New Mexico"],
  ["NY", "New York"],
  ["NC", "North Carolina"],
  ["ND", "North Dakota"],
  ["OH", "Ohio"],
  ["OK", "Oklahoma"],
  ["OR", "Oregon"],
  ["PA", "Pennsylvania"],
  ["RI", "Rhode Island"],
  ["SC", "South Carolina"],
  ["SD", "South Dakota"],
  ["TN", "Tennessee"],
  ["TX", "Texas"],
  ["UT", "Utah"],
  ["VT", "Vermont"],
  ["VA", "Virginia"],
  ["WA", "Washington"],
  ["WV", "West Virginia"],
  ["WI", "Wisconsin"],
  ["WY", "Wyoming"],
] as const;

const US_STATE_REGIONS: readonly CoverageRegionConfig[] = US_STATES.map(([code, label]) => ({
  id: `us-${code.toLowerCase()}`,
  label,
  source: "admin1",
  match: { iso_3166_2: `US-${code}` },
  simplifyTolerance: 0.02,
}));

const COVERAGE_REGIONS: readonly CoverageRegionConfig[] = [
  {
    id: "ca",
    label: "Canada",
    source: "admin0",
    match: { ADM0_A3: "CAN" },
    simplifyTolerance: 0.02,
  },
  {
    id: "us",
    label: "United States",
    source: "admin0",
    match: { ADM0_A3: "USA" },
    simplifyTolerance: 0.02,
    dropPolygonsEastOf: 0,
  },
  {
    id: "ca-on",
    label: "Ontario",
    source: "admin1",
    match: { iso_3166_2: "CA-ON" },
    simplifyTolerance: 0.012,
  },
  {
    id: "ca-bc",
    label: "British Columbia",
    source: "admin1",
    match: { iso_3166_2: "CA-BC" },
    simplifyTolerance: 0.018,
  },
  {
    id: "ca-ab",
    label: "Alberta",
    source: "admin1",
    match: { iso_3166_2: "CA-AB" },
    simplifyTolerance: 0.018,
  },
  {
    id: "ca-sk",
    label: "Saskatchewan",
    source: "admin1",
    match: { iso_3166_2: "CA-SK" },
    simplifyTolerance: 0.018,
  },
  {
    id: "ca-mb",
    label: "Manitoba",
    source: "admin1",
    match: { iso_3166_2: "CA-MB" },
    simplifyTolerance: 0.018,
  },
  {
    id: "ca-qc",
    label: "Québec",
    source: "admin1",
    match: { iso_3166_2: "CA-QC" },
    simplifyTolerance: 0.014,
  },
  {
    id: "ca-nb",
    label: "New Brunswick",
    source: "admin1",
    match: { iso_3166_2: "CA-NB" },
    simplifyTolerance: 0.014,
  },
  {
    id: "ca-ns",
    label: "Nova Scotia",
    source: "admin1",
    match: { iso_3166_2: "CA-NS" },
    simplifyTolerance: 0.012,
  },
  {
    id: "ca-pe",
    label: "Prince Edward Island",
    source: "admin1",
    match: { iso_3166_2: "CA-PE" },
    simplifyTolerance: 0.01,
  },
  {
    id: "ca-nl",
    label: "Newfoundland and Labrador",
    source: "admin1",
    match: { iso_3166_2: "CA-NL" },
    simplifyTolerance: 0.02,
  },
  {
    id: "ca-yt",
    label: "Yukon",
    source: "admin1",
    match: { iso_3166_2: "CA-YT" },
    simplifyTolerance: 0.02,
  },
  {
    id: "ca-nt",
    label: "Northwest Territories",
    source: "admin1",
    match: { iso_3166_2: "CA-NT" },
    simplifyTolerance: 0.02,
  },
  {
    id: "ca-nu",
    label: "Nunavut",
    source: "admin1",
    match: { iso_3166_2: "CA-NU" },
    simplifyTolerance: 0.02,
  },
  ...US_STATE_REGIONS,
];

const CLASSIFICATION_COUNTRIES: readonly CoverageRegionConfig[] = [
  {
    id: "ca",
    label: "Canada",
    source: "countryCanada",
    match: { shapeISO: "CAN" },
    simplifyTolerance: 0.005,
    minPolygonArea: 0.0001,
  },
  {
    id: "us",
    label: "United States",
    source: "countryUnitedStates",
    match: { shapeISO: "USA" },
    simplifyTolerance: 0.005,
    minPolygonArea: 0.0001,
    dropPolygonsEastOf: 0,
  },
];

const SOURCES: Readonly<Record<GeographySourceId, GeographySource>> = {
  countryCanada: {
    id: "countryCanada",
    label: "OpenStreetMap contributors via geoBoundaries CAN-ADM0-50000805",
    url: "https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/9469f09/releaseData/gbOpen/CAN/ADM0/geoBoundaries-CAN-ADM0_simplified.geojson",
    license:
      "Open Data Commons Open Database License 1.0, https://opendatacommons.org/licenses/odbl/1-0/",
    attributionUrl: "https://www.openstreetmap.org/copyright",
  },
  countryUnitedStates: {
    id: "countryUnitedStates",
    label: "US Census Bureau MAF/TIGER via geoBoundaries USA-ADM0-2327393",
    url: "https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/9469f09/releaseData/gbOpen/USA/ADM0/geoBoundaries-USA-ADM0.geojson",
    license: "Public domain (US Census Bureau)",
    attributionUrl:
      "https://www.census.gov/programs-surveys/geography/technical-documentation/naming-convention/cartographic-boundary-file.html",
  },
  admin1: {
    id: "admin1",
    label: "Natural Earth 1:50m admin-1 states and provinces",
    url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_1_states_provinces.geojson",
    license: "Public domain (Natural Earth)",
    attributionUrl: "https://www.naturalearthdata.com/about/terms-of-use/",
  },
  admin0: {
    id: "admin0",
    label: "Natural Earth 1:50m admin-0 countries",
    url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson",
    license: "Public domain (Natural Earth)",
    attributionUrl: "https://www.naturalearthdata.com/about/terms-of-use/",
  },
};

interface GeneratedSourceAttribution {
  readonly label: string;
  readonly attributionUrl: string;
}

interface CoverageCountryMetadata {
  readonly id: string;
  readonly label: string;
  /** Subdivision regions drawn for this country, in config order. */
  readonly admin1Ids: readonly string[];
  /** Classification and drawn-geometry sources, cited once per country. */
  readonly sources: readonly GeneratedSourceAttribution[];
}

type GeoPoint = readonly [number, number];
type GeoRing = readonly GeoPoint[];

interface GeoPolygon {
  readonly outer: GeoRing;
  readonly holes: readonly GeoRing[];
}

interface CoverageRegion {
  readonly id: string;
  readonly label: string;
  readonly source: GeographySource;
  readonly sourceFeature: string;
  readonly polygons: readonly GeoPolygon[];
  readonly bounds: {
    readonly minLon: number;
    readonly maxLon: number;
    readonly minLat: number;
    readonly maxLat: number;
  };
}

interface GeoJsonGeometry {
  readonly type: string;
  readonly coordinates: unknown;
}

interface GeoJsonFeature {
  readonly properties: Readonly<Record<string, unknown>>;
  readonly geometry: GeoJsonGeometry | null;
}

interface GeoJsonCollection {
  readonly features: readonly GeoJsonFeature[];
}

const OUTPUT_PATH = resolve(
  import.meta.dirname,
  "../src/components/network-coverage/generated/geography.ts",
);
const CACHE_DIR = resolve(import.meta.dirname, "../.state/geography-cache");

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isGeoFeature(value: unknown): value is GeoJsonFeature {
  return isRecord(value) && isRecord(value.properties) && isRecord(value.geometry);
}

function parseRing(value: unknown): GeoRing | undefined {
  if (!Array.isArray(value) || value.length < 4) return undefined;
  const points: GeoPoint[] = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length < 2) return undefined;
    const [lon, lat] = item;
    if (typeof lon !== "number" || typeof lat !== "number") return undefined;
    points.push([lon, lat]);
  }
  return points;
}

function parsePolygon(value: unknown): GeoPolygon | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const outer = parseRing(value[0]);
  if (!outer) return undefined;
  const holes: GeoRing[] = [];
  for (const hole of value.slice(1)) {
    const ring = parseRing(hole);
    if (ring) holes.push(ring);
  }
  return { outer, holes };
}

function geometryPolygons(geometry: GeoJsonGeometry): readonly GeoPolygon[] {
  const { type, coordinates } = geometry;
  if (type === "Polygon") {
    const polygon = parsePolygon(coordinates);
    return polygon ? [polygon] : [];
  }
  if (type === "MultiPolygon" && Array.isArray(coordinates)) {
    const polygons: GeoPolygon[] = [];
    for (const item of coordinates) {
      const polygon = parsePolygon(item);
      if (polygon) polygons.push(polygon);
    }
    return polygons;
  }
  return [];
}

function squareSegmentDistance(point: GeoPoint, start: GeoPoint, end: GeoPoint): number {
  let x = start[0];
  let y = start[1];
  let dx = end[0] - x;
  let dy = end[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((point[0] - x) * dx + (point[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = end[0];
      y = end[1];
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = point[0] - x;
  dy = point[1] - y;
  return dx * dx + dy * dy;
}

/** Douglas-Peucker. Keeps the ring closed because the endpoints are retained. */
function simplifyRing(ring: GeoRing, tolerance: number): GeoRing {
  if (ring.length <= 4) return ring;
  const squaredTolerance = tolerance * tolerance;
  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[ring.length - 1] = 1;
  const stack: Array<readonly [number, number]> = [[0, ring.length - 1]];
  while (stack.length > 0) {
    const pair = stack.pop();
    if (!pair) break;
    const [start, end] = pair;
    let furthest = 0;
    let furthestIndex = -1;
    for (let index = start + 1; index < end; index += 1) {
      const distance = squareSegmentDistance(ring[index], ring[start], ring[end]);
      if (distance > furthest) {
        furthest = distance;
        furthestIndex = index;
      }
    }
    if (furthest > squaredTolerance && furthestIndex > 0) {
      keep[furthestIndex] = 1;
      stack.push([start, furthestIndex], [furthestIndex, end]);
    }
  }
  return ring.filter((_, index) => keep[index] === 1);
}

function ringArea(ring: GeoRing): number {
  let area = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const current = ring[index];
    const next = ring[index + 1];
    area += current[0] * next[1] - next[0] * current[1];
  }
  return Math.abs(area / 2);
}

function matchesProperties(
  properties: Readonly<Record<string, unknown>>,
  match: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(match).every(([key, expected]) => properties[key] === expected);
}

function formatNumber(value: number): string {
  return String(Number(value.toFixed(5)));
}

function formatPoint([lon, lat]: GeoPoint): string {
  return `[${formatNumber(lon)},${formatNumber(lat)}]`;
}

function formatRing(ring: GeoRing): string {
  return `[${ring.map(formatPoint).join(",")}]`;
}

function formatPolygon(polygon: GeoPolygon): string {
  const holes = polygon.holes.length ? `,holes:[${polygon.holes.map(formatRing).join(",")}]` : "";
  return `{outer:${formatRing(polygon.outer)}${holes}}`;
}

function computeBounds(polygons: readonly GeoPolygon[]): CoverageRegion["bounds"] {
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const polygon of polygons) {
    for (const point of polygon.outer) {
      minLon = Math.min(minLon, point[0]);
      maxLon = Math.max(maxLon, point[0]);
      minLat = Math.min(minLat, point[1]);
      maxLat = Math.max(maxLat, point[1]);
    }
  }
  return { minLon, maxLon, minLat, maxLat };
}

async function loadSource(source: GeographySource, refresh: boolean): Promise<GeoJsonCollection> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = resolve(CACHE_DIR, `${source.id}.geojson`);
  if (!refresh && existsSync(cachePath)) {
    return JSON.parse(readFileSync(cachePath, "utf8")) as GeoJsonCollection;
  }
  const response = await fetch(source.url);
  if (!response.ok) {
    throw new Error(`Failed to download ${source.url}: ${response.status} ${response.statusText}`);
  }
  const text = await response.text();
  writeFileSync(cachePath, text);
  return JSON.parse(text) as GeoJsonCollection;
}

function buildRegion(
  config: CoverageRegionConfig,
  source: GeographySource,
  collection: GeoJsonCollection,
): CoverageRegion {
  const feature = collection.features
    .filter(isGeoFeature)
    .find((candidate) => matchesProperties(candidate.properties, config.match));
  if (!feature?.geometry) {
    throw new Error(
      `No ${config.source} feature matched ${config.id}: ${JSON.stringify(config.match)}`,
    );
  }
  const tolerance = config.simplifyTolerance ?? 0.012;
  const minPolygonArea = config.minPolygonArea ?? 0.0005;
  const dropEastOf = config.dropPolygonsEastOf;
  const polygons = geometryPolygons(feature.geometry)
    .filter(
      (polygon) => dropEastOf === undefined || polygon.outer.every(([lon]) => lon <= dropEastOf),
    )
    .map((polygon) => {
      const outer = simplifyRing(polygon.outer, tolerance);
      const holes = polygon.holes
        .map((hole) => simplifyRing(hole, tolerance))
        .filter((hole) => ringArea(hole) >= minPolygonArea);
      return { outer, holes };
    })
    .filter((polygon) => ringArea(polygon.outer) >= minPolygonArea);
  if (polygons.length === 0) {
    throw new Error(`Region ${config.id} simplified to an empty shape`);
  }
  const sourceFeature = Object.entries(config.match)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  return {
    id: config.id,
    label: config.label,
    source,
    sourceFeature,
    polygons,
    bounds: computeBounds(polygons),
  };
}

function countryMetadata(config: CoverageRegionConfig): CoverageCountryMetadata {
  const classification = CLASSIFICATION_COUNTRIES.find((entry) => entry.id === config.id);
  if (!classification) {
    throw new Error(
      `Country ${config.id} has no classification outline; add it to CLASSIFICATION_COUNTRIES.`,
    );
  }
  const subdivisions = COVERAGE_REGIONS.filter(
    (region) => region.source === "admin1" && region.id.startsWith(`${config.id}-`),
  );
  const sourceIds = [
    classification.source,
    config.source,
    ...subdivisions.map((region) => region.source),
  ];
  const cited = new Set<string>();
  const sources = sourceIds
    .map((sourceId) => {
      const source = SOURCES[sourceId];
      if (!source) throw new Error(`Unknown geography source: ${sourceId}`);
      return source;
    })
    .filter((source) => {
      const key = `${source.label} ${source.attributionUrl}`;
      if (cited.has(key)) return false;
      cited.add(key);
      return true;
    })
    .map((source) => ({ label: source.label, attributionUrl: source.attributionUrl }));
  return {
    id: config.id,
    label: config.label,
    admin1Ids: subdivisions.map((region) => region.id),
    sources,
  };
}

function renderModule(
  regions: readonly CoverageRegion[],
  countries: readonly CoverageCountryMetadata[],
): string {
  const sourceIds = [...new Set(regions.map((region) => region.source.id))];
  const sources = sourceIds.map((id) => SOURCES[id]);
  const licenses = [...new Set(sources.map((source) => source.license))];
  const attributionUrls = [...new Set(sources.map((source) => source.attributionUrl))];
  const regionLines = regions
    .map(
      (region) => `  ${JSON.stringify(region.id)}: {
    id: ${JSON.stringify(region.id)},
    label: ${JSON.stringify(region.label)},
    source: ${JSON.stringify(region.source.id)},
    sourceFeature: ${JSON.stringify(region.sourceFeature)},
    bounds: { minLon: ${formatNumber(region.bounds.minLon)}, maxLon: ${formatNumber(region.bounds.maxLon)}, minLat: ${formatNumber(region.bounds.minLat)}, maxLat: ${formatNumber(region.bounds.maxLat)} },
    polygons: [
      ${region.polygons.map(formatPolygon).join(",\n      ")},
    ],
  },`,
    )
    .join("\n");
  const countryLines = countries
    .map(
      (country) => `  {
    id: ${JSON.stringify(country.id)},
    label: ${JSON.stringify(country.label)},
    admin1Ids: [${country.admin1Ids.map((id) => JSON.stringify(id)).join(", ")}],
    sources: [
${country.sources
  .map(
    (source) =>
      `      { label: ${JSON.stringify(source.label)}, attributionUrl: ${JSON.stringify(source.attributionUrl)} },`,
  )
  .join("\n")}
    ],
  },`,
    )
    .join("\n");
  return `/**
 * Generated by \`bun run coverage:geography\`. Do not edit by hand.
 * Add or change coverage regions in \`scripts/generate-coverage-geography.ts\`.
 *
 * Sources: ${sources.map((source) => source.label).join("; ")}
 * ${licenses.join("\n * ")}
 * ${attributionUrls.join("\n * ")}
 */
export type CoverageGeoPoint = readonly [lon: number, lat: number];

export interface CoverageGeoPolygon {
  readonly outer: readonly CoverageGeoPoint[];
  readonly holes?: readonly (readonly CoverageGeoPoint[])[];
}

export interface CoverageGeography {
  readonly id: string;
  readonly label: string;
  readonly source: string;
  readonly sourceFeature: string;
  readonly bounds: {
    readonly minLon: number;
    readonly maxLon: number;
    readonly minLat: number;
    readonly maxLat: number;
  };
  readonly polygons: readonly CoverageGeoPolygon[];
}

export const GENERATED_COVERAGE_REGIONS = {
${regionLines}
} as const satisfies Readonly<Record<string, CoverageGeography>>;

export interface GeneratedSourceAttribution {
  readonly label: string;
  readonly attributionUrl: string;
}

export interface GeneratedCoverageCountry {
  readonly id: string;
  readonly label: string;
  readonly admin1Ids: readonly string[];
  readonly sources: readonly GeneratedSourceAttribution[];
}

export const GENERATED_COVERAGE_COUNTRIES = [
${countryLines}
] as const;
`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unknownArgs = args.filter((arg) => arg !== "--check" && arg !== "--refresh");
  if (unknownArgs.length > 0) {
    console.error(`Unknown argument(s): ${unknownArgs.join(", ")}`);
    console.error("Usage: bun scripts/generate-coverage-geography.ts [--check] [--refresh]");
    process.exitCode = 1;
    return;
  }
  const check = args.includes("--check");
  const refresh = args.includes("--refresh");
  const configs = [...COVERAGE_REGIONS, ...CLASSIFICATION_COUNTRIES];
  const sources = new Map<GeographySourceId, GeoJsonCollection>();
  await Promise.all(
    [...new Set(configs.map((region) => region.source))].map(async (sourceId) => {
      sources.set(sourceId, await loadSource(SOURCES[sourceId], refresh));
    }),
  );
  const build = (configs: readonly CoverageRegionConfig[]) =>
    configs.map((config) => {
      const collection = sources.get(config.source);
      if (!collection) throw new Error(`Source ${config.source} was not loaded`);
      return buildRegion(config, SOURCES[config.source], collection);
    });
  const regions = build(COVERAGE_REGIONS);
  const countryMetadataList = COVERAGE_REGIONS.filter(
    (config) => config.source === "admin0",
  ).map(countryMetadata);
  const countriesPath = resolve(dirname(OUTPUT_PATH), "countries.json");
  const countries =
    JSON.stringify(
      Object.fromEntries(
        build(CLASSIFICATION_COUNTRIES).map((region) => [
          region.id,
          {
            ...region,
            source: region.source.label,
            license: region.source.license,
            attributionUrl: region.source.attributionUrl,
          },
        ]),
      ),
      (_key, value) => (typeof value === "number" ? Number(formatNumber(value)) : value),
    ) + "\n";
  const outputs = [
    [OUTPUT_PATH, renderModule(regions, countryMetadataList)],
    [countriesPath, countries],
  ] as const;
  for (const [path, generated] of outputs) {
    if (check) {
      const current = existsSync(path) ? readFileSync(path, "utf8") : "";
      if (current !== generated) {
        console.error(
          `${path} is missing or out of date. Run bun run coverage:geography and commit the result.`,
        );
        process.exitCode = 1;
        return;
      }
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, generated);
    }
  }
  console.log(
    `Coverage geography ${check ? "checked" : "generated"} for ${regions.length} display regions and ${CLASSIFICATION_COUNTRIES.length} classification countries.`,
  );
}

if (import.meta.main) {
  await main();
}
