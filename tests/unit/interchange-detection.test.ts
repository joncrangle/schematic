vi.mock("~/agencies/agencyCatalog", async () => {
  const { testAgencyCatalog } = await import("../helpers/agency-fixtures");
  return { agencyCatalog: testAgencyCatalog };
});
import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { decodeInterchangeDataset, InterchangeHubSchema } from "~/domain/map/Interchange";
import type { Schematic } from "~/agencies/types";
import {
  compileInterchangeArtifact,
  hasCompleteSeedScope,
  interchangeAgencyIds,
} from "../../scripts/seed";
import {
  compileInterchanges,
  decodeInterchangeOverrides,
  discoverInterchanges,
  mergeInterchanges,
  normalizeInterchangeName,
  stationsFromSeededTables,
} from "../../scripts/lib/interchange-detection";

const placementSchematic = {
  viewBoxWidth: 200,
  viewBoxHeight: 200,
  lines: [
    {
      id: "line",
      name: "Test Line",
      color: "#000000",
      points: [
        { x: 20, y: 100 },
        { x: 180, y: 100 },
      ],
    },
  ],
  stations: [
    {
      id: "union",
      name: "Union",
      x: 100,
      y: 100,
      lines: ["line"],
      label: { x: 100, y: 72, anchor: "middle" },
    },
  ],
  viewport: {
    bounds: { minX: 0, maxX: 200, minY: 0, maxY: 200 },
    minZoom: 0.5,
    maxZoom: 2,
  },
  geoProjection: {
    refLonWest: -80,
    refLonEast: -79,
    refXWest: 0,
    refXEast: 200,
    refLatNorth: 44,
    refLatSouth: 43,
    refYNorth: 0,
    refYSouth: 200,
  },
} satisfies Schematic;

describe("static interchange detection", () => {
  it("only permits artifact compilation when every seedable agency is selected", () => {
    expect(hasCompleteSeedScope(["ttc", "go"], ["ttc", "go", "yrt"])).toBe(false);
    expect(hasCompleteSeedScope(["ttc", "go", "yrt"], ["ttc", "go", "yrt"])).toBe(true);
  });

  it("derives the required compilation scope from artifact and override endpoints", () => {
    expect(
      interchangeAgencyIds(
        [
          {
            id: "ttc-go-union",
            endpoints: [
              { agencyId: "ttc", stationName: "Union" },
              { agencyId: "go", stationName: "Union" },
            ],
          },
        ],
        {
          hubs: [
            {
              id: "ttc-yrt-finch",
              endpoints: [
                { agencyId: "ttc", stationName: "Finch" },
                { agencyId: "yrt", stationName: "Finch" },
              ],
            },
          ],
          exclusions: [],
        },
      ),
    ).toEqual(["go", "ttc", "yrt"]);
  });

  it("derives agencies from ID-only overrides for offline compilation", () => {
    expect(
      interchangeAgencyIds(
        [
          {
            id: "sample-regional-union",
            endpoints: [
              { agencyId: "sample", stationName: "Union" },
              { agencyId: "regional", stationName: "Union" },
            ],
          },
        ],
        { hubs: [{ id: "regional-metro-rutherford" }], exclusions: [] },
      ),
    ).toEqual(["metro", "regional", "sample"]);
  });

  it.each([
    ["Union Station", "union"],
    ["Kipling GO", "kipling"],
    ["St. André", "standre"],
    ["Central vers Centre-ville", "central"],
    ["Central Quai 2", "central"],
    ["Central Voie 4", "central"],
    ["東京駅", "東京駅"],
  ])("normalizes upstream station name %s", (input, expected) => {
    expect(normalizeInterchangeName(input)).toBe(expected);
  });

  it("clusters nearby same-name rail stations into a multi-agency hub", () => {
    const hubs = discoverInterchanges([
      { agencyId: "go", id: "union-go", name: "Union Station GO", lat: 43.6452, lon: -79.3806 },
      { agencyId: "ttc", id: "union-ttc", name: "Union", lat: 43.6455, lon: -79.3806 },
      { agencyId: "far", id: "union-far", name: "Union", lat: 44, lon: -79 },
    ]);

    expect(hubs).toEqual([
      {
        id: "go-ttc-union",
        endpoints: [
          { agencyId: "go", stationName: "Union Station GO" },
          { agencyId: "ttc", stationName: "Union" },
        ],
      },
    ]);
  });

  it("keeps an isolated station out of every discovered hub", () => {
    const stations = [
      {
        agencyId: "coach",
        id: "coach-downtown",
        name: "Downtown Kerb",
        lat: 43.6452,
        lon: -79.3806,
      },
      { agencyId: "city", id: "city-stop", name: "Main at King", lat: 43.6453, lon: -79.3806 },
      { agencyId: "city", id: "city-next", name: "Main at Queen", lat: 43.6456, lon: -79.3806 },
    ];

    expect(discoverInterchanges(stations)).toHaveLength(1);
    expect(
      discoverInterchanges(
        stations,
        350,
        [],
        [{ agencyId: "coach", stationName: "Downtown Kerb" }],
      ),
    ).toEqual([]);
  });

  it.each([
    ["go-ttc-bloor", "Bloor", "Dundas West"],
    ["go-ttc-danforth", "Danforth", "Main Street"],
  ])("clusters nearby differently named stations into %s", (id, firstName, secondName) => {
    expect(
      discoverInterchanges([
        { agencyId: "go", id: `${id}-go`, name: firstName, lat: 43.657, lon: -79.45 },
        { agencyId: "ttc", id: `${id}-ttc`, name: secondName, lat: 43.657, lon: -79.45 },
      ]),
    ).toEqual([
      {
        id,
        endpoints: [
          { agencyId: "go", stationName: firstName },
          { agencyId: "ttc", stationName: secondName },
        ],
      },
    ]);
  });

  it("resolves a one-sided ID override from its unique discovered component", () => {
    const nearbyPair = { lat: 43.69, lon: -79.3 };
    const goStations = Array.from({ length: 78 }, (_, index) =>
      index === 0
        ? {
            agencyId: "go",
            id: "go-danforth",
            schematicId: "danforth",
            name: "Danforth",
            ...nearbyPair,
          }
        : {
            agencyId: "go",
            id: `go-unrelated-${index}`,
            name: `Unrelated ${index}`,
            lat: 45 + index / 100,
            lon: -79.3,
          },
    );

    expect(
      compileInterchanges(
        [
          ...goStations,
          {
            agencyId: "ttc",
            id: "ttc-main-street",
            schematicId: "main-street",
            name: "Main Street",
            ...nearbyPair,
          },
        ],
        {
          hubs: [
            {
              id: "go-ttc-mainstreet",
              badgeOffsets: {
                ttc: { dx: 30, dy: 24 },
                go: { dx: 12, dy: 24 },
              },
            },
          ],
          exclusions: [],
        },
      ),
    ).toEqual([
      {
        id: "go-ttc-mainstreet",
        endpoints: [
          { agencyId: "go", stationId: "danforth", stationName: "Danforth" },
          { agencyId: "ttc", stationId: "main-street", stationName: "Main Street" },
        ],
        badgeOffsets: {
          ttc: { dx: 30, dy: 24 },
          go: { dx: 12, dy: 24 },
        },
      },
    ]);
  });

  it("rejects a one-sided ID override when multiple discovered components match", () => {
    const stations = [
      {
        agencyId: "ttc",
        id: "ttc-peer-a",
        name: "Alias A",
        lat: 43.69,
        lon: -79.3,
      },
      {
        agencyId: "ttc",
        id: "ttc-peer-b",
        name: "Alias B",
        lat: 43.7,
        lon: -79.3,
      },
      {
        agencyId: "go",
        id: "main-street-go-a",
        schematicId: "main-street",
        name: "Main Street",
        lat: 43.69,
        lon: -79.3,
      },
      {
        agencyId: "go",
        id: "main-street-go-b",
        schematicId: "main-street",
        name: "Main Street",
        lat: 43.7,
        lon: -79.3,
      },
    ];

    expect(() =>
      compileInterchanges(stations, { hubs: [{ id: "go-ttc-mainstreet" }], exclusions: [] }),
    ).toThrow(
      '[seed:interchanges] Hub override "go-ttc-mainstreet" cannot create a new hub without at least 2 endpoints',
    );
  });

  it("rejects a one-sided ID override without a unique discovered component", () => {
    expect(() =>
      compileInterchanges(
        [
          { agencyId: "go", id: "go-danforth", name: "Danforth", lat: 44, lon: -79.3 },
          {
            agencyId: "ttc",
            id: "ttc-main-street",
            name: "Main Street",
            lat: 43.69,
            lon: -79.3,
          },
        ],
        { hubs: [{ id: "go-ttc-mainstreet" }], exclusions: [] },
      ),
    ).toThrow(
      '[seed:interchanges] Hub override "go-ttc-mainstreet" cannot create a new hub without at least 2 endpoints',
    );
  });

  it("applies an ID-only visual override to a geographically discovered alias", () => {
    const stations = [
      { agencyId: "go", id: "bloor-go", name: "Bloor", lat: 43.657, lon: -79.45 },
      { agencyId: "ttc", id: "dundas-west-ttc", name: "Dundas West", lat: 43.657, lon: -79.45 },
    ];

    expect(
      mergeInterchanges(
        discoverInterchanges(stations),
        {
          hubs: [
            {
              id: "ttc-go-dundas-west-bloor",
              badgeOffsets: { ttc: { dx: 8, dy: 24 } },
            },
          ],
          exclusions: [],
        },
        stations,
      ),
    ).toEqual([
      {
        id: "ttc-go-dundas-west-bloor",
        endpoints: [
          { agencyId: "go", stationName: "Bloor" },
          { agencyId: "ttc", stationName: "Dundas West" },
        ],
        badgeOffsets: { ttc: { dx: 8, dy: 24 } },
      },
    ]);
  });

  it("narrows a repeated name-only exclusion to its declared feed stops", () => {
    const stations = [
      { agencyId: "bus", id: "park-a", name: "Park", lat: 44, lon: -79, feedStopIds: ["a1"] },
      { agencyId: "bus", id: "park-b", name: "Park", lat: 44.2, lon: -79.2, feedStopIds: ["b1"] },
      { agencyId: "rail", id: "park-rail", name: "Park Rail", lat: 44, lon: -79.0001 },
    ];

    expect(
      compileInterchanges(stations, {
        hubs: [],
        exclusions: [
          {
            left: { agencyId: "bus", stationName: "Park", feedStopIds: ["a1"] },
            right: { agencyId: "rail", stationName: "Park Rail" },
          },
        ],
      }),
    ).toEqual([]);
  });

  it("excludes only the declared stop of a repeated name when both stops pair", () => {
    const stations = [
      { agencyId: "bus", id: "park-a", name: "Park", lat: 44, lon: -79, feedStopIds: ["a1"] },
      { agencyId: "bus", id: "park-b", name: "Park", lat: 44.01, lon: -79.01, feedStopIds: ["b1"] },
      { agencyId: "rail", id: "rail-a", name: "Azilda", lat: 44, lon: -79.0001 },
      { agencyId: "rail", id: "rail-b", name: "Azilda North", lat: 44.01, lon: -79.0101 },
    ];

    const hubs = compileInterchanges(stations, {
      hubs: [],
      exclusions: [
        {
          left: { agencyId: "bus", stationName: "Park", feedStopIds: ["a1"] },
          right: { agencyId: "rail", stationName: "Azilda" },
        },
      ],
    });

    expect(hubs).toHaveLength(1);
    expect(JSON.stringify(hubs)).toContain("b1");
    expect(JSON.stringify(hubs)).not.toContain("a1");
  });

  it("rejects a name-only endpoint whose declared feed stops match no station", () => {
    expect(() =>
      compileInterchanges(
        [{ agencyId: "bus", id: "park-a", name: "Park", lat: 44, lon: -79, feedStopIds: ["a1"] }],
        {
          hubs: [],
          exclusions: [
            {
              left: { agencyId: "bus", stationName: "Park", feedStopIds: ["gone"] },
              right: { agencyId: "rail", stationName: "Park Rail" },
            },
          ],
        },
      ),
    ).toThrow(/declares feedStopIds that match no station: gone/);
  });

  it("rejects a name-only override when one agency has multiple matching identities", () => {
    expect(() =>
      mergeInterchanges(
        [],
        {
          hubs: [
            {
              id: "ttc-go-central",
              endpoints: [
                { agencyId: "ttc", stationName: "Central" },
                { agencyId: "go", stationName: "Union" },
              ],
            },
          ],
          exclusions: [],
        },
        [
          {
            agencyId: "ttc",
            id: "central-a-feed",
            schematicId: "central-a",
            name: "Central",
            lat: 43,
            lon: -79,
          },
          {
            agencyId: "ttc",
            id: "central-b-feed",
            schematicId: "central-b",
            name: "Central",
            lat: 43,
            lon: -79,
          },
          {
            agencyId: "go",
            id: "union-feed",
            schematicId: "union",
            name: "Union",
            lat: 43,
            lon: -79,
          },
        ],
      ),
    ).toThrow(/Ambiguous name-only endpoint/);
  });

  it("includes bus station groups alongside rail and rapid-transit station groups", () => {
    expect(
      stationsFromSeededTables(
        "ttc",
        [
          {
            table: "routes",
            rows: [
              { id: "subway", route_type: 1 },
              { id: "bus", route_type: 3 },
            ],
          },
          {
            table: "stops",
            rows: [
              {
                id: "subway-platform",
                name: "Union",
                lat: 43.645,
                lon: -79.38,
                parent_station: "union",
                routes_json: '["subway"]',
              },
              {
                id: "bus-platform",
                name: "Union",
                lat: 43.645,
                lon: -79.38,
                parent_station: "union",
                routes_json: '["bus"]',
              },
            ],
          },
        ],
        [{ id: "union", name: "Union" }],
      ).map(({ name, agencyId }) => ({ name, agencyId })),
    ).toEqual([{ name: "Union", agencyId: "ttc" }]);
  });

  it("maps upstream bus-station names to the provider schematic vocabulary", () => {
    expect(
      stationsFromSeededTables(
        "fixture-bus",
        [
          { table: "routes", rows: [{ id: "bus", route_type: 3 }] },
          {
            table: "stops",
            rows: [
              {
                id: "central-platform",
                name: "CENTRAL GO BUS TERMINAL PLATFORM 2",
                lat: 44,
                lon: -76,
                routes_json: '["bus"]',
              },
            ],
          },
        ],
        [{ id: "central", name: "Central" }],
      ),
    ).toEqual([
      {
        agencyId: "fixture-bus",
        id: "central-platform",
        schematicId: "central",
        boardingStopIds: ["central-platform"],
        name: "Central",
        lat: 44,
        lon: -76,
      },
    ]);
  });

  it("emits repository station ids from feed-owned groups and preserves them through overrides", () => {
    const stations = [
      {
        agencyId: "go",
        id: "go-union-feed",
        schematicId: "union",
        name: "Union",
        lat: 43.645,
        lon: -79.38,
      },
      {
        agencyId: "ttc",
        id: "ttc-union-feed",
        schematicId: "union",
        name: "Union",
        lat: 43.645,
        lon: -79.38,
      },
    ];

    const compiled = compileInterchangeArtifact(
      stations,
      {
        hubs: [
          {
            id: "reviewed-union",
            endpoints: [
              { agencyId: "ttc", stationId: "union", stationName: "Union" },
              { agencyId: "go", stationId: "union", stationName: "Union" },
            ],
            badgeOffsets: { go: { dx: 14, dy: 20 } },
          },
        ],
        exclusions: [],
      },
      new Map([
        ["go", placementSchematic],
        ["ttc", placementSchematic],
      ]),
    );

    expect(compiled).toMatchObject([
      {
        id: "reviewed-union",
        endpoints: [
          { agencyId: "ttc", stationId: "union" },
          { agencyId: "go", stationId: "union" },
        ],
        badgeOffsets: {
          go: { dx: 14, dy: 20 },
          ttc: { dx: 0, dy: 28 },
        },
      },
    ]);
  });

  it("matches bus stations against regional peer-agency vocabulary when missing from own schematic", () => {
    expect(
      stationsFromSeededTables(
        "go",
        [
          { table: "routes", rows: [{ id: "bus", route_type: 3 }] },
          {
            table: "stops",
            rows: [
              {
                id: "finch-go-bus",
                name: "Finch Bus Terminal",
                lat: 43.782,
                lon: -79.415,
                routes_json: '["bus"]',
              },
            ],
          },
        ],
        [
          { id: "union", name: "Union" },
          { id: "exhibition", name: "Exhibition" },
        ], // GO schematic only has heavy rail stations
        [{ id: "finch", name: "Finch" }], // Regional schematic has Finch from TTC
      ),
    ).toEqual([
      {
        agencyId: "go",
        id: "finch-go-bus",
        feedStopIds: ["finch-go-bus"],
        name: "Finch",
        lat: 43.782,
        lon: -79.415,
      },
    ]);
  });

  it("lets explicit hubs replace discovered pairs and exclusions remove false positives", () => {
    const discovered = discoverInterchanges([
      { agencyId: "go", id: "bloor-go", name: "Bloor", lat: 43.657, lon: -79.45 },
      { agencyId: "ttc", id: "bloor-ttc", name: "Bloor", lat: 43.657, lon: -79.45 },
      { agencyId: "go", id: "union-go", name: "Union", lat: 43.645, lon: -79.38 },
      { agencyId: "ttc", id: "union-ttc", name: "Union", lat: 43.645, lon: -79.38 },
    ]);

    expect(
      mergeInterchanges(discovered, {
        hubs: [
          {
            id: "go-ttc-bloor",
            endpoints: [
              { agencyId: "go", stationName: "Bloor" },
              { agencyId: "ttc", stationName: "Dundas West" },
            ],
            badgeOffsets: { ttc: { dx: 4, dy: -10 } },
          },
        ],
        exclusions: [
          {
            left: { agencyId: "go", stationName: "Union" },
            right: { agencyId: "ttc", stationName: "Union" },
          },
        ],
      }),
    ).toEqual([
      {
        id: "go-ttc-bloor",
        endpoints: [
          { agencyId: "go", stationName: "Bloor" },
          { agencyId: "ttc", stationName: "Dundas West" },
        ],
        badgeOffsets: { ttc: { dx: 4, dy: -10 } },
      },
    ]);
  });

  it("preserves a multi-agency hub while excluding one peer pair", () => {
    const discovered = discoverInterchanges([
      { agencyId: "go", id: "union-go", name: "Union", lat: 43.645, lon: -79.38 },
      { agencyId: "ttc", id: "union-ttc", name: "Union", lat: 43.645, lon: -79.38 },
      { agencyId: "yrt", id: "union-yrt", name: "Union", lat: 43.645, lon: -79.38 },
    ]);

    const hubs = mergeInterchanges(discovered, {
      hubs: [],
      exclusions: [
        {
          left: { agencyId: "go", stationName: "Union" },
          right: { agencyId: "ttc", stationName: "Union" },
        },
      ],
    });

    expect(hubs).toEqual([
      {
        id: "go-ttc-yrt-union",
        endpoints: [
          { agencyId: "go", stationName: "Union" },
          { agencyId: "ttc", stationName: "Union" },
          { agencyId: "yrt", stationName: "Union" },
        ],
        excludedPairs: [
          {
            left: { agencyId: "go", stationName: "Union" },
            right: { agencyId: "ttc", stationName: "Union" },
          },
        ],
      },
    ]);
  });

  it("applies exclusions after ID-only overrides are materialized", () => {
    const stations = [
      { agencyId: "go", id: "union-go", name: "Union", lat: 43.645, lon: -79.38 },
      { agencyId: "ttc", id: "union-ttc", name: "Union", lat: 43.645, lon: -79.38 },
      { agencyId: "yrt", id: "union-yrt", name: "Union", lat: 43.645, lon: -79.38 },
    ];

    expect(
      mergeInterchanges(
        [],
        {
          hubs: [{ id: "go-ttc-yrt-union" }],
          exclusions: [
            {
              left: { agencyId: "go", stationName: "Union" },
              right: { agencyId: "ttc", stationName: "Union" },
            },
          ],
        },
        stations,
      ),
    ).toEqual([
      {
        id: "go-ttc-yrt-union",
        endpoints: [
          { agencyId: "go", stationName: "Union" },
          { agencyId: "ttc", stationName: "Union" },
          { agencyId: "yrt", stationName: "Union" },
        ],
        excludedPairs: [
          {
            left: { agencyId: "go", stationName: "Union" },
            right: { agencyId: "ttc", stationName: "Union" },
          },
        ],
      },
    ]);
  });

  it("does not compile a two-agency hub when its peer pair is excluded", () => {
    expect(
      mergeInterchanges(
        [
          {
            id: "go-ttc-union",
            endpoints: [
              { agencyId: "go", stationName: "Union" },
              { agencyId: "ttc", stationName: "Union" },
            ],
          },
        ],
        {
          hubs: [],
          exclusions: [
            {
              left: { agencyId: "go", stationName: "Union" },
              right: { agencyId: "ttc", stationName: "Union" },
            },
          ],
        },
      ),
    ).toEqual([]);
  });

  it("matches explicit overrides to discovered endpoints after name normalization", () => {
    const discovered = discoverInterchanges([
      { agencyId: "go", id: "union-go", name: "Union Station GO", lat: 43.645, lon: -79.38 },
      { agencyId: "ttc", id: "union-ttc", name: "Union", lat: 43.645, lon: -79.38 },
    ]);

    expect(
      mergeInterchanges(discovered, {
        hubs: [
          {
            id: "ttc-go-union",
            endpoints: [
              { agencyId: "ttc", stationName: "Union" },
              { agencyId: "go", stationName: "Union" },
            ],
          },
        ],
        exclusions: [],
      }),
    ).toEqual([
      {
        id: "ttc-go-union",
        endpoints: [
          { agencyId: "ttc", stationName: "Union" },
          { agencyId: "go", stationName: "Union" },
        ],
      },
    ]);
  });

  it("compiles nearby alias hubs without manual hub declarations", () => {
    const stations = [
      { agencyId: "go", id: "bloor-go", name: "Bloor", lat: 43.657, lon: -79.45 },
      { agencyId: "go", id: "danforth-go", name: "Danforth", lat: 43.69, lon: -79.3 },
      { agencyId: "go", id: "oriole-go", name: "Oriole", lat: 43.75, lon: -79.35 },
      { agencyId: "ttc", id: "dundas-west-ttc", name: "Dundas West", lat: 43.657, lon: -79.45 },
      { agencyId: "ttc", id: "main-street-ttc", name: "Main Street", lat: 43.69, lon: -79.3 },
      { agencyId: "ttc", id: "leslie-ttc", name: "Leslie", lat: 43.75, lon: -79.35 },
    ];

    const hubs = compileInterchanges(stations, { hubs: [], exclusions: [] });

    expect(hubs.map(({ id, endpoints }) => ({ id, endpoints }))).toEqual([
      {
        id: "go-ttc-bloor",
        endpoints: [
          { agencyId: "go", stationName: "Bloor" },
          { agencyId: "ttc", stationName: "Dundas West" },
        ],
      },
      {
        id: "go-ttc-danforth",
        endpoints: [
          { agencyId: "go", stationName: "Danforth" },
          { agencyId: "ttc", stationName: "Main Street" },
        ],
      },
      {
        id: "go-ttc-oriole",
        endpoints: [
          { agencyId: "go", stationName: "Oriole" },
          { agencyId: "ttc", stationName: "Leslie" },
        ],
      },
    ]);
  });

  it("compiles discovery and overrides through the public pipeline", () => {
    const compiled = compileInterchanges(
      [
        { agencyId: "go", id: "union-go", name: "Union", lat: 43.645, lon: -79.38 },
        { agencyId: "ttc", id: "union-ttc", name: "Union", lat: 43.645, lon: -79.38 },
      ],
      { hubs: [], exclusions: [] },
    );

    expect(compiled[0]?.endpoints).toHaveLength(2);
  });

  it("calculates missing agency offsets during static compilation while preserving overrides", () => {
    const compiled = compileInterchanges(
      [
        {
          agencyId: "go",
          id: "union-go",
          schematicId: "union",
          name: "Union",
          lat: 43.645,
          lon: -79.38,
        },
        {
          agencyId: "ttc",
          id: "union-ttc",
          schematicId: "union",
          name: "Union",
          lat: 43.645,
          lon: -79.38,
        },
      ],
      {
        hubs: [
          {
            id: "go-ttc-union",
            badgeOffsets: { go: { dx: 40, dy: 0 } },
          },
        ],
        exclusions: [],
      },
      new Map([
        ["go", placementSchematic],
        ["ttc", placementSchematic],
      ]),
    );

    expect(compiled[0]?.badgeOffsets).toEqual({
      go: { dx: 40, dy: 0 },
      ttc: { dx: 0, dy: 28 },
    });
  });

  it("merges partial overrides with discovered hubs without requiring endpoints", () => {
    const discovered = discoverInterchanges([
      { agencyId: "go", id: "union-go", name: "Union", lat: 43.645, lon: -79.38 },
      { agencyId: "ttc", id: "union-ttc", name: "Union", lat: 43.645, lon: -79.38 },
    ]);

    expect(
      mergeInterchanges(discovered, {
        hubs: [
          {
            id: "go-ttc-union",
            badgeOffsets: { ttc: { dx: -50, dy: 50 } },
          },
        ],
        exclusions: [],
      }),
    ).toEqual([
      {
        id: "go-ttc-union",
        endpoints: [
          { agencyId: "go", stationName: "Union" },
          { agencyId: "ttc", stationName: "Union" },
        ],
        badgeOffsets: { ttc: { dx: -50, dy: 50 } },
      },
    ]);
  });
});

describe("interchange dataset schema", () => {
  it("preserves a reviewed walking node and boarding identities through compilation", () => {
    const stations = [
      {
        agencyId: "local",
        id: "stop-a",
        schematicId: "union",
        name: "Union",
        lat: 43,
        lon: -80,
        feedStopIds: ["stop-a"],
      },
      {
        agencyId: "regional",
        id: "stop-b",
        schematicId: "union",
        name: "Union",
        lat: 43.001,
        lon: -80,
        feedStopIds: ["stop-b"],
      },
    ];
    const overrides = decodeInterchangeOverrides({
      hubs: [
        {
          id: "walking-hub",
          endpoints: [
            { agencyId: "local", stationId: "union", stationName: "Union" },
            {
              agencyId: "regional",
              stationId: "union",
              stationName: "Union",
              walkingMarkers: { local: { dx: -40, dy: 50, label: "Regional Union" } },
            },
          ],
        },
      ],
      exclusions: [],
    });
    const hubs = decodeInterchangeDataset(
      compileInterchanges(
        stations,
        overrides,
        new Map([
          ["local", placementSchematic],
          ["regional", placementSchematic],
        ]),
      ),
    );
    expect(hubs).toHaveLength(1);
    expect(hubs[0]?.endpoints).toEqual([
      { agencyId: "local", stationId: "union", stationName: "Union", feedStopIds: ["stop-a"] },
      {
        agencyId: "regional",
        stationId: "union",
        stationName: "Union",
        feedStopIds: ["stop-b"],
        walkingMarkers: { local: { dx: -40, dy: 50, label: "Regional Union" } },
      },
    ]);
  });

  it("accepts a multi-agency hub with visual metadata", () => {
    const hub = Schema.decodeUnknownSync(InterchangeHubSchema)({
      id: "ttc-go-yrt-union",
      endpoints: [
        { agencyId: "ttc", stationId: "union", stationName: "Union" },
        { agencyId: "go", stationId: "union", stationName: "Union", badgeLabel: "GO Rail" },
        { agencyId: "yrt", stationId: "union", stationName: "Union" },
      ],
      badgeOffsets: {
        ttc: { dx: 8, dy: -24 },
        go: { dx: 12, dy: 0 },
      },
      badgeLabel: "GO",
    });

    expect(hub.endpoints).toHaveLength(3);
    expect(hub.badgeOffsets?.go).toEqual({ dx: 12, dy: 0 });
    expect(hub.endpoints[1]?.badgeLabel).toBe("GO Rail");
    expect(hub.endpoints.map((endpoint) => endpoint.stationId)).toEqual([
      "union",
      "union",
      "union",
    ]);
  });

  it("rejects malformed schematic station IDs while keeping agency scope explicit", () => {
    expect(() =>
      Schema.decodeUnknownSync(InterchangeHubSchema)({
        id: "broken",
        endpoints: [
          { agencyId: "ttc", stationId: "Union", stationName: "Union" },
          { agencyId: "go", stationId: "union", stationName: "Union" },
        ],
      }),
    ).toThrow();
  });

  it("rejects a malformed hub instead of allowing startup to continue", () => {
    expect(() => decodeInterchangeDataset([{ id: "broken", endpoints: [] }])).toThrow();
    expect(() =>
      decodeInterchangeDataset([
        {
          id: "broken",
          endpoints: [
            { agencyId: "ttc", stationName: "Union" },
            { agencyId: "go", stationName: "Union" },
          ],
          badgeOffsets: { ttc: { dx: "not-a-number", dy: 0 } },
        },
      ]),
    ).toThrow();
  });

  it("picks the closest station when an agency has multiple candidates in clustering radius", () => {
    const stations = [
      {
        agencyId: "go",
        id: "HA",
        schematicId: "hamilton",
        name: "Hamilton",
        lat: 43.252945,
        lon: -79.869586,
      },
      {
        agencyId: "hamilton",
        id: "355432",
        schematicId: "hamilton-go-centre",
        name: "Hamilton GO Centre",
        lat: 43.252665,
        lon: -79.869522,
      },
      {
        agencyId: "hamilton",
        id: "356196",
        schematicId: "frank-a-cooke-terminal",
        name: "Frank A. Cooke Terminal",
        lat: 43.256002,
        lon: -79.870947,
      },
    ];

    const hubs = discoverInterchanges(stations);
    expect(hubs).toHaveLength(1);
    expect(hubs[0]!.endpoints).toEqual([
      { agencyId: "go", stationId: "hamilton", stationName: "Hamilton" },
      { agencyId: "hamilton", stationId: "hamilton-go-centre", stationName: "Hamilton GO Centre" },
    ]);
  });

  it("keeps the closest name-only Burlington candidate without promoting it to a drawable station", () => {
    const compiled = compileInterchanges(
      [
        {
          agencyId: "hamilton",
          id: "1964",
          name: "King at James",
          lat: 43.256,
          lon: -79.869,
        },
        {
          agencyId: "burlington",
          id: "827",
          name: "King",
          lat: 43.25601,
          lon: -79.869,
        },
        {
          agencyId: "burlington",
          id: "679",
          schematicId: "hamilton-king-james",
          name: "Hamilton, King at James",
          lat: 43.2562,
          lon: -79.8692,
        },
      ],
      { hubs: [], exclusions: [] },
    );

    expect(compiled).toHaveLength(1);
    expect(compiled[0]?.endpoints).toEqual([
      { agencyId: "burlington", stationName: "King" },
      { agencyId: "hamilton", stationName: "King at James" },
    ]);
  });

  it("keeps the geographically closest name-only GO Richmond Hill Centre endpoint", () => {
    const compiled = compileInterchanges(
      [
        {
          agencyId: "go",
          id: "richmond-hill-centre-go",
          name: "Richmond Hill Centre",
          lat: 43.840199,
          lon: -79.425598,
        },
        {
          agencyId: "go",
          id: "langstaff-go",
          schematicId: "langstaff",
          name: "Langstaff",
          lat: 43.8427,
          lon: -79.425598,
        },
        {
          agencyId: "yrt",
          id: "richmond-hill-centre-yrt",
          schematicId: "richmond-hill-centre",
          name: "Richmond Hill Centre",
          lat: 43.840199,
          lon: -79.425598,
        },
      ],
      { hubs: [], exclusions: [] },
    );

    expect(compiled).toHaveLength(1);
    expect(compiled[0]?.endpoints).toEqual([
      { agencyId: "go", stationName: "Richmond Hill Centre" },
      { agencyId: "yrt", stationId: "richmond-hill-centre", stationName: "Richmond Hill Centre" },
    ]);
    expect(compiled[0]?.endpoints).not.toContainEqual(
      expect.objectContaining({ stationId: "langstaff" }),
    );
  });

  it("adds the reviewed Burlington King at James hub without duplicating generic King at Bay", () => {
    const compiled = compileInterchanges(
      [
        {
          agencyId: "hamilton",
          id: "1964",
          name: "King at James",
          lat: 43.256,
          lon: -79.869,
        },
        {
          agencyId: "burlington",
          id: "827",
          name: "King",
          lat: 43.25601,
          lon: -79.869,
        },
        {
          agencyId: "burlington",
          id: "679",
          schematicId: "hamilton-king-james",
          name: "Hamilton, King at James",
          lat: 43.2562,
          lon: -79.8692,
        },
      ],
      {
        hubs: [
          {
            id: "burlington-hamilton-king-at-james",
            endpoints: [
              {
                agencyId: "burlington",
                stationId: "hamilton-king-james",
                stationName: "Hamilton, King at James",
              },
              { agencyId: "hamilton", stationName: "King at James" },
            ],
          },
        ],
        exclusions: [],
      },
    );

    expect(compiled).toContainEqual({
      id: "burlington-hamilton-king-at-james",
      endpoints: [
        {
          agencyId: "burlington",
          stationId: "hamilton-king-james",
          stationName: "Hamilton, King at James",
        },
        { agencyId: "hamilton", stationName: "King at James" },
      ],
    });
    expect(compiled).toContainEqual({
      id: "burlington-hamilton-kingatjames",
      endpoints: [
        { agencyId: "burlington", stationName: "King" },
        { agencyId: "hamilton", stationName: "King at James" },
      ],
    });
    expect(
      compiled
        .flatMap((hub) => hub.endpoints)
        .filter((endpoint) => endpoint.stationName === "King"),
    ).toHaveLength(1);
  });

  it("omits candidate edges matching configured exclusions during discovery", () => {
    const stations = [
      {
        agencyId: "go",
        id: "HA",
        schematicId: "hamilton",
        name: "Hamilton",
        lat: 43.252945,
        lon: -79.869586,
      },
      {
        agencyId: "hamilton",
        id: "356196",
        schematicId: "frank-a-cooke-terminal",
        name: "Frank A. Cooke Terminal",
        lat: 43.256002,
        lon: -79.870947,
      },
    ];

    const exclusions = [
      {
        left: { agencyId: "go", stationId: "hamilton", stationName: "Hamilton" },
        right: {
          agencyId: "hamilton",
          stationId: "frank-a-cooke-terminal",
          stationName: "Frank A. Cooke Terminal",
        },
      },
    ];

    const hubs = discoverInterchanges(stations, 350, exclusions);
    expect(hubs).toHaveLength(0);
  });

  it("infers endpoints for an ID override whose station name contains agency identifier tokens", () => {
    const stations = [
      {
        agencyId: "go",
        id: "HA",
        schematicId: "hamilton",
        name: "Hamilton",
        lat: 43.252945,
        lon: -79.869586,
      },
      {
        agencyId: "hamilton",
        id: "355432",
        schematicId: "hamilton-go-centre",
        name: "Hamilton GO Centre",
        lat: 43.252665,
        lon: -79.869522,
      },
    ];

    const merged = mergeInterchanges(
      discoverInterchanges(stations),
      {
        hubs: [
          {
            id: "go-hamilton-hamilton-go-centre",
            badgeOffsets: { hamilton: { dx: 40, dy: 40 } },
          },
        ],
        exclusions: [],
      },
      stations,
    );

    expect(merged).toEqual([
      {
        id: "go-hamilton-hamilton-go-centre",
        endpoints: [
          { agencyId: "go", stationId: "hamilton", stationName: "Hamilton" },
          {
            agencyId: "hamilton",
            stationId: "hamilton-go-centre",
            stationName: "Hamilton GO Centre",
          },
        ],
        badgeOffsets: { hamilton: { dx: 40, dy: 40 } },
      },
    ]);
  });
});

it("discovers station forecourts geographically without matching station names", () => {
  const stops = stationsFromSeededTables(
    "fixture-bus",
    [
      { table: "routes", rows: [{ id: "11", route_type: 3 }] },
      {
        table: "stops",
        rows: [
          { id: "forecourt", name: "Station Forecourt", lat: 44, lon: -76, routes_json: '["11"]' },
        ],
      },
    ],
    [],
    [{ id: "central", name: "Central" }],
  );
  const hubs = discoverInterchanges([
    ...stops,
    {
      agencyId: "fixture-rail",
      id: "central",
      schematicId: "central",
      name: "Central",
      lat: 44,
      lon: -76,
    },
  ]);
  expect(hubs[0]?.endpoints.find((e) => e.agencyId === "fixture-bus")?.feedStopIds).toEqual([
    "forecourt",
  ]);
});

it("ignores ambiguous regional station names hundreds of kilometres from a local stop", () => {
  const stations = stationsFromSeededTables(
    "fixture-bus",
    [
      { table: "routes", rows: [{ id: "42", route_type: 3 }] },
      {
        table: "stops",
        rows: [{ id: "local", name: "Central", lat: 45, lon: -76, routes_json: '["42"]' }],
      },
    ],
    [],
    [
      { id: "central", name: "Central", lat: 43, lon: -79 },
      { id: "central", name: "Central Station", lat: 44, lon: -79 },
    ],
  );
  expect(stations[0]).toMatchObject({ name: "Central", feedStopIds: ["local"] });
  expect(stations[0]?.schematicId).toBeUndefined();
});

it("retains both unparented forecourt bays without joining nearby stations", () => {
  const hubs = discoverInterchanges([
    { agencyId: "rail", id: "one", schematicId: "one", name: "One", lat: 44, lon: -76 },
    { agencyId: "rail", id: "two", schematicId: "two", name: "Two", lat: 44.005, lon: -76 },
    {
      agencyId: "bus",
      id: "east",
      name: "East forecourt",
      feedStopIds: ["east"],
      roadside: true,
      lat: 44.0001,
      lon: -76,
    },
    {
      agencyId: "bus",
      id: "west",
      name: "West forecourt",
      feedStopIds: ["west"],
      roadside: true,
      lat: 44.0002,
      lon: -76,
    },
    {
      agencyId: "bus",
      id: "road",
      name: "Between stations",
      feedStopIds: ["road"],
      roadside: true,
      lat: 44.0024,
      lon: -76,
    },
  ]);
  expect(hubs).toHaveLength(1);
  expect(hubs[0]?.endpoints.find((e) => e.agencyId === "bus")?.feedStopIds).toEqual([
    "east",
    "road",
    "west",
  ]);
  expect(hubs[0]?.endpoints.find((e) => e.agencyId === "rail")?.stationId).toBe("one");
});

it("joins two kerb pairs at the same drawn stations into one hub", () => {
  const kerb = (agencyId: string, id: string, schematicId: string, lat: number) => ({
    agencyId,
    id,
    schematicId,
    name: schematicId,
    feedStopIds: [id],
    lat,
    lon: -76,
  });
  const hubs = discoverInterchanges([
    kerb("town", "town-north", "college", 44),
    kerb("coach", "coach-north", "terminal", 44.0001),
    kerb("town", "town-south", "college", 44.006),
    kerb("coach", "coach-south", "terminal", 44.0061),
  ]);

  expect(hubs).toHaveLength(1);
  expect(hubs[0]?.endpoints).toEqual([
    expect.objectContaining({
      agencyId: "coach",
      stationId: "terminal",
      feedStopIds: ["coach-north", "coach-south"],
    }),
    expect.objectContaining({
      agencyId: "town",
      stationId: "college",
      feedStopIds: ["town-north", "town-south"],
    }),
  ]);
});

it("rejects conflicting stop-code identities within one station group", () => {
  expect(() =>
    stationsFromSeededTables(
      "bus",
      [
        { table: "routes", rows: [{ id: "2", route_type: 3 }] },
        {
          table: "stops",
          rows: ["A", "B"].map((code) => ({
            id: code,
            code,
            name: "Forecourt",
            parent_station: "parent",
            lat: 44,
            lon: -76,
            routes_json: '["2"]',
          })),
        },
      ],
      [
        { id: "one", name: "One" },
        { id: "two", name: "Two" },
      ],
      [],
      { "code:A": "one", "code:B": "two" },
    ),
  ).toThrow("Ambiguous");
});

it("preserves a new operator when an existing hub has reviewed endpoints", () => {
  const endpoints = ["local", "regional", "intercity"].map((agencyId) => ({
    agencyId,
    stationId: "central",
    stationName: "Central",
  }));
  const hubs = mergeInterchanges([{ id: "local-regional-central", endpoints }], {
    hubs: [{ id: "local-regional-central", endpoints: endpoints.slice(0, 2) }],
    exclusions: [],
  });
  expect(hubs[0]?.endpoints).toEqual(endpoints);
});

it("assigns distinct identities to disjoint same-named transfer hubs", () => {
  const stations = [44, 45].flatMap((lat) => [
    {
      agencyId: "rail",
      id: `rail-${lat}`,
      name: "Main Street",
      feedStopIds: [`rail-${lat}`],
      lat,
      lon: -76,
    },
    {
      agencyId: "bus",
      id: `bus-${lat}`,
      name: "Main Street",
      feedStopIds: [`bus-${lat}`],
      lat,
      lon: -76,
    },
  ]);
  const hubs = compileInterchanges(stations, { hubs: [], exclusions: [] });
  expect(hubs).toHaveLength(2);
  expect(new Set(hubs.map((h) => h.id)).size).toBe(2);
  expect(
    compileInterchanges([...stations].reverse(), { hubs: [], exclusions: [] })
      .map((h) => h.id)
      .sort(),
  ).toEqual(hubs.map((h) => h.id).sort());
  expect(() =>
    decodeInterchangeDataset([{ ...hubs[0]! }, { ...hubs[1]!, id: hubs[0]!.id }]),
  ).toThrow("unique");
});

it("keeps a distant same-name stop separate from the drawn station", () => {
  const stations = stationsFromSeededTables(
    "fixture-bus",
    [
      { table: "routes", rows: [{ id: "bus", route_type: 3 }] },
      {
        table: "stops",
        rows: [
          { id: "near", name: "Central Station", lat: 44, lon: -76, routes_json: '["bus"]' },
          { id: "far", name: "Central GO Station", lat: 44.04, lon: -76, routes_json: '["bus"]' },
        ],
      },
    ],
    [{ id: "central", name: "Central Station", lat: 44, lon: -76 }],
  );
  expect(stations.find(({ id }) => id === "near")?.schematicId).toBe("central");
  expect(stations.find(({ id }) => id === "far")).toMatchObject({
    feedStopIds: ["far"],
    name: "Central GO Station",
  });
  expect(stations.find(({ id }) => id === "far")?.schematicId).toBeUndefined();
});

it("preserves all canonical boarding platforms when augmenting a station with nearby stops", () => {
  const stations = stationsFromSeededTables(
    "fixture-bus",
    [
      { table: "routes", rows: [{ id: "bus", route_type: 3 }] },
      {
        table: "stops",
        rows: [
          { id: "north", name: "Central Station", lat: 44, lon: -76, routes_json: '["bus"]' },
          { id: "south", name: "Central Station", lat: 44.004, lon: -76, routes_json: '["bus"]' },
          { id: "forecourt", name: "Forecourt", lat: 44.0001, lon: -76, routes_json: '["bus"]' },
        ],
      },
    ],
    [{ id: "central", name: "Central", lat: 44, lon: -76, platformIds: ["north", "south"] }],
  );
  const hubs = discoverInterchanges([
    ...stations,
    {
      agencyId: "fixture-rail",
      id: "central",
      schematicId: "central",
      name: "Central",
      lat: 44,
      lon: -76,
    },
  ]);
  expect(hubs[0]?.endpoints.find((e) => e.agencyId === "fixture-bus")?.feedStopIds).toEqual([
    "forecourt",
    "north",
    "south",
  ]);
});

it("discovers a connection between feed-only light rail stations", () => {
  const tables = [
    { table: "routes", rows: [{ id: "lrt", route_type: 0 }] },
    {
      table: "stops",
      rows: [{ id: "platform", name: "Central Quai 2", lat: 45, lon: -73, routes_json: '["lrt"]' }],
    },
  ];
  expect(
    compileInterchanges(
      [
        ...stationsFromSeededTables("alpha", tables, [], [{ id: "elsewhere", name: "Elsewhere" }]),
        ...stationsFromSeededTables("beta", tables, [], [{ id: "elsewhere", name: "Elsewhere" }]),
      ],
      { hubs: [], exclusions: [] },
    ),
  ).toMatchObject([{ endpoints: [{ agencyId: "alpha" }, { agencyId: "beta" }] }]);
});
