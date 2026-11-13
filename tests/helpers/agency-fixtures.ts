import type {
  AgencyManifestConfig,
  AgencyProvider,
  BrowserAgency,
  Schematic,
} from "~/agencies/types";
import { createAgencyProvider } from "~/agencies/createAgencyProvider";
import { makeMinimalSchematic } from "./fixtures";
import { withSchematic } from "./browser-agency";

/** Fictional declarations: tests opt into the capabilities they exercise. */
export function makeTestManifest(
  overrides: Partial<AgencyManifestConfig> = {},
): AgencyManifestConfig {
  return {
    id: "sample",
    name: "Sample Transit",
    locale: "en-CA",
    timezone: "America/Toronto",
    bounds: [{ minLat: 43, maxLat: 44, minLon: -80, maxLon: -79 }],
    modes: ["subway", "bus", "rail"],
    stationService: { routeType: "subway" },
    attribution: { name: "Sample Open Data", url: "https://example.test/data", license: "CC0" },
    status: "active",
    alerts: [{ type: "gtfs-rt", url: "https://example.test/alerts" }],
    staticTopology: {
      source: "seed",
      feeds: [
        { name: "Sample", url: "https://example.test/gtfs.zip", cacheFileName: "sample.zip" },
      ],
    },
    realtime: {
      feeds: [
        { kind: "vehicle_positions", url: "https://example.test/vehicles", format: "protobuf" },
        { kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" },
      ],
    },
    ...overrides,
  };
}

export function makeTestSchematic(overrides: Partial<Schematic> = {}): Schematic {
  return { ...makeMinimalSchematic(), ...overrides };
}

export function makeTestProvider(
  manifest: Partial<AgencyManifestConfig> = {},
  schematic: Schematic = makeTestSchematic(),
): AgencyProvider & Pick<BrowserAgency, "light"> {
  const provider = createAgencyProvider({ manifest: makeTestManifest(manifest), schematic });
  // Doubles as a BrowserAgency: light index plus a pre-resolved lazy schematic.
  return Object.assign(provider, withSchematic(schematic, provider.manifest.id));
}

/** Small authored map; geography and feed identities belong to the fixture. */
export function makeStationSchematic(names: readonly string[], lineId = "1"): Schematic {
  const stations = names.map((name, index) => ({
    id: name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, ""),
    name,
    x: 10 + index * 25,
    y: 10 + index * 15,
    lines: [lineId],
  }));
  return makeTestSchematic({
    lines: [
      {
        id: lineId,
        name: `Line ${lineId}`,
        color: "#123456",
        points: stations.map(({ x, y }) => ({ x, y })),
      },
    ],
    stations,
    sequences: { [lineId]: stations.map(({ id }) => id) },
    stationIndex: stations.map(({ id, name, x, y, lines }) => ({
      id: `feed-${id}`,
      schematicId: id,
      name,
      lines,
      platformIds: [`platform-${id}`],
      lat: 44 - y / 100,
      lon: -80 + x / 100,
    })),
  });
}

/** Two intersecting corridors with a declared loop around the hub. */
export function makeTestNetwork(): Schematic {
  const stations = [
    { id: "west", name: "West", x: 100, y: 100, lines: ["1"] },
    { id: "hub", name: "Hub", x: 400, y: 300, lines: ["1", "2"] },
    { id: "east", name: "East", x: 700, y: 100, lines: ["1"] },
    { id: "north", name: "North", x: 400, y: 50, lines: ["2"] },
    { id: "south", name: "South", x: 400, y: 500, lines: ["2"] },
  ];
  return makeTestSchematic({
    viewBoxWidth: 800,
    viewBoxHeight: 600,
    stations,
    lines: [
      {
        id: "1",
        name: "Line 1",
        color: "#123456",
        points: [
          { x: 100, y: 100 },
          { x: 350, y: 300 },
          { x: 400, y: 300 },
          { x: 450, y: 300 },
          { x: 700, y: 100 },
        ],
      },
      {
        id: "2",
        name: "Line 2",
        color: "#654321",
        points: [
          { x: 400, y: 50 },
          { x: 400, y: 500 },
        ],
      },
    ],
    sequences: { "1": ["west", "hub", "east"], "2": ["north", "hub", "south"] },
    cornerInsertions: [
      { lineId: "1", stationId: "hub", before: { x: 350, y: 300 }, after: { x: 450, y: 300 } },
    ],
    viewport: { bounds: { minX: 50, maxX: 750, minY: 30, maxY: 550 }, minZoom: 0.5, maxZoom: 16 },
    stationIndex: stations.map((s) => ({
      id: `feed-${s.id}`,
      schematicId: s.id,
      name: s.name,
      lines: s.lines,
      platformIds: [`platform-${s.id}`],
      lat: 44 - s.y / 600,
      lon: -80 + s.x / 800,
    })),
    geoProjection: {
      refLonWest: -80,
      refLonEast: -79,
      refXWest: 0,
      refXEast: 800,
      refLatNorth: 44,
      refLatSouth: 43,
      refYNorth: 0,
      refYSouth: 600,
    },
  });
}

/** A fictional catalog for tests that exercise registry and browser adapters. */
export const testAgencyCatalog = [
  {
    manifest: makeTestManifest({
      id: "sample",
      name: "Sample Transit",
      shortName: "S",
      brandColor: "#123456",
      staticTopology: {
        source: "seed",
        feeds: [{ url: "https://example.test/static.zip", cacheFileName: "sample.zip" }],
        defaultTextColor: "#fedcba",
      },
      cityPresets: [{ name: "Hub Plaza", lat: 43.5, lon: -79.5 }],
      modes: ["subway", "bus"],
      popularSurfaceRoutes: ["10", "20"],
      jurisdiction: { country: "ca", region: "on" },
    }),
    schematic: makeTestNetwork(),
  },
  {
    manifest: makeTestManifest({
      id: "regional",
      name: "Regional Transit",
      shortName: "R",
      brandColor: "#ffffff",
      modes: ["rail"],
      stationService: { routeType: "rail" },
      bounds: [{ minLat: 42, maxLat: 45, minLon: -81, maxLon: -78 }],
      jurisdiction: { country: "ca", region: "on" },
      scope: "regional",
    }),
    schematic: makeTestNetwork(),
  },
  {
    manifest: makeTestManifest({
      id: "metro",
      name: "Metro Transit",
      shortName: "M",
      cityPresets: [{ name: "North Exchange", lat: 43.8, lon: -79.2 }],
      modes: ["bus"],
      stationService: { routeType: "bus" },
      bounds: [{ minLat: 43.2, maxLat: 44.2, minLon: -79.8, maxLon: -78.8 }],
    }),
    schematic: makeTestNetwork(),
  },
  {
    manifest: makeTestManifest({
      id: "local",
      name: "Local Transit",
      popularSurfaceRoutes: ["30"],
      modes: ["bus"],
      stationService: { routeType: "bus" },
      bounds: [{ minLat: 45, maxLat: 46, minLon: -76, maxLon: -75 }],
    }),
    schematic: makeStationSchematic(["Bus Terminal", "Market"], "2"),
  },
];

export const testInterchanges = [
  {
    id: "sample-regional-hub",
    endpoints: [
      { agencyId: "sample", stationId: "hub", stationName: "Hub" },
      { agencyId: "regional", stationId: "hub", stationName: "Hub" },
    ],
    badgeOffsets: { sample: { dx: 0, dy: -24 }, regional: { dx: 0, dy: -24 } },
  },
];
