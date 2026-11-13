import { describe, expect, it } from "vitest";
import type { Schematic } from "~/agencies/types";
import {
  buildSubwayStationIndex,
  findMissingPopularRoutes,
  findStationsWithoutPlatforms,
  mergeStationIndex,
  parseGtfsRouteIds,
  parseGtfsStopRows,
} from "../../scripts/lib/subway-stations";
import { compileStationIndexArtifact } from "../../scripts/seed";

const genericSubwaySchematic: Schematic = {
  viewBoxWidth: 100,
  viewBoxHeight: 100,
  lines: [
    { id: "1", name: "Fixture Line 1", color: "#111111", points: [{ x: 10, y: 10 }] },
    { id: "2", name: "Fixture Line 2", color: "#222222", points: [{ x: 20, y: 20 }] },
    { id: "4", name: "Fixture Line 4", color: "#444444", points: [{ x: 40, y: 40 }] },
    { id: "5", name: "Fixture Line 5", color: "#555555", points: [{ x: 50, y: 50 }] },
  ],
  stations: [
    { id: "bloor-yonge", name: "Bloor-Yonge", x: 10, y: 10, lines: ["1", "2"] },
    { id: "tmu", name: "TMU", x: 20, y: 20, lines: ["1"] },
    { id: "mount-dennis", name: "Mount Dennis", x: 30, y: 30, lines: ["5"] },
  ],
  sequences: {
    "1": ["bloor-yonge", "tmu"],
    "2": ["bloor-yonge"],
    "4": [],
    "5": ["mount-dennis"],
  },
  stationAliases: {
    DUNDAS: "tmu",
  },
  viewport: {
    bounds: { minX: 0, maxX: 100, minY: 0, maxY: 100 },
    minZoom: 0.5,
    maxZoom: 4,
  },
  geoProjection: {
    refLonWest: -80,
    refLonEast: -79,
    refXWest: 0,
    refXEast: 100,
    refLatNorth: 44,
    refLatSouth: 43,
    refYNorth: 0,
    refYSouth: 100,
  },
};

const lineSequences = genericSubwaySchematic.sequences as Record<string, string[]>;
const stationAliases = genericSubwaySchematic.stationAliases as Record<string, string>;
const stationNames = new Map(
  genericSubwaySchematic.stations.map((station) => [station.id, station.name]),
);

const terminalFixtureSchematic: Schematic = {
  viewBoxWidth: 100,
  viewBoxHeight: 100,
  lines: [
    {
      id: "fixture-line",
      name: "Fixture Line",
      color: "#000000",
      points: [
        { x: 10, y: 10 },
        { x: 90, y: 90 },
      ],
    },
  ],
  stations: [
    {
      id: "fixture-terminal",
      name: "Fixture Terminal",
      x: 10,
      y: 10,
      lines: ["fixture-line"],
      terminal: true,
    },
  ],
  sequences: { "fixture-line": ["fixture-terminal"] },
  stationAliases: {
    "FIXTURE TERMINAL": "fixture-terminal",
    "FIXTURE TERMINAL PLATFORM 1": "fixture-terminal",
    "FIXTURE TERMINAL PLATFORM 2": "fixture-terminal",
  },
  viewport: {
    bounds: { minX: 0, maxX: 100, minY: 0, maxY: 100 },
    minZoom: 0.5,
    maxZoom: 4,
  },
  geoProjection: {
    refLonWest: -80,
    refLonEast: -79,
    refXWest: 0,
    refXEast: 100,
    refLatNorth: 44,
    refLatSouth: 43,
    refYNorth: 0,
    refYSouth: 100,
  },
};

/**
 * Synthetic stops.txt exercising: parent stations (location_type=1), child
 * platforms via parent_station, canonical-name mapping for an interchange,
 * alias normalization ("Dundas" → "TMU"), and non-subway stations whose
 * platforms must be flagged unmatched rather than silently dropped.
 */
const SYNTHETIC_STOPS_TXT = [
  "stop_id,stop_code,stop_name,stop_desc,stop_lat,stop_lon,zone_id,stop_url,location_type,parent_station,wheelchair_boarding",
  "99999,,Bloor-Yonge Station,,,,,,1,,",
  "13755,13755,Bloor-Yonge Northbound Platform,,43.6712,-79.3858,,,,99999,1",
  "13863,13863,Bloor-Yonge Eastbound Platform,,43.6708,-79.3860,,,,99999,1",
  "30001,,Dundas Station,,,,,,1,,",
  "13731,13731,Dundas Southbound Platform,,43.6533,-79.3801,,,,30001,1",
  "16001,,Mount Dennis Station,,,,,,1,,",
  "16067,16067,Mount Dennis Eastbound Platform,,43.6524,-79.5357,,,,16001,1",
  "90001,,Finch Bus Terminal,,,,,,1,,",
  "33322,33322,Finch Bus Terminal Platform 12,,43.7808,-79.4156,,,,90001,1",
].join("\n");

describe("seed transform: GTFS stops.txt → subway station geo index", () => {
  it.each([
    { coordinates: "43.666447,-79.411186", lat: 43.666447, lon: -79.411186 },
    { coordinates: ",", lat: 43.665649, lon: -79.41229 },
  ])(
    "retains live platforms and curated identity via parent stop_code with coordinates '$coordinates'",
    ({ coordinates, lat, lon }) => {
      const schematic: Schematic = {
        ...terminalFixtureSchematic,
        lines: genericSubwaySchematic.lines.filter((line) => line.id === "2"),
        stations: [{ id: "bathurst", name: "Bathurst", x: 10, y: 10, lines: ["2"] }],
        sequences: { "2": ["bathurst"] },
        stationAliases: {},
        stationIndex: [
          {
            id: "43286",
            schematicId: "bathurst",
            name: "Bathurst Station",
            lat: 43,
            lon: -79,
            lines: ["2"],
            platformIds: ["13759"],
            directionTermini: { west: "Kipling" },
          },
        ],
      };
      const rows = parseGtfsStopRows(
        [
          "stop_id,stop_code,stop_name,stop_lat,stop_lon,location_type,parent_station",
          `43286,76,Bathurst,${coordinates},1,`,
          "13759,13759,Bathurst Station - Westbound Platform,43.665649,-79.41229,0,76",
        ].join("\n"),
      );

      const artifact = compileStationIndexArtifact(schematic, rows);
      const merged = mergeStationIndex(
        schematic.stationIndex!,
        artifact.stations,
        schematic.sequences,
      );

      expect(artifact.unmatchedPlatforms).toEqual([]);
      expect(merged).toEqual([
        {
          id: "43286",
          schematicId: "bathurst",
          name: "Bathurst Station",
          lat,
          lon,
          lines: ["2"],
          platformIds: ["13759"],
          directionTermini: { west: "Kipling" },
        },
      ]);
    },
  );

  it.each(["Fixture Terminal", "Outside Schematic"])(
    "rejects ambiguous parent stop_code even when the other parent is '%s'",
    (otherParentName) => {
      const rows = parseGtfsStopRows(
        [
          "stop_id,stop_code,stop_name,stop_lat,stop_lon,location_type,parent_station",
          "TERM,CODE,Fixture Terminal,43.1,-80.1,1,",
          `OTHER,CODE,${otherParentName},43.2,-80.2,1,`,
          "CHILD,,Fixture Terminal Platform 1,43.1,-80.1,0,CODE",
        ].join("\n"),
      );

      expect(() => compileStationIndexArtifact(terminalFixtureSchematic, rows)).toThrow(
        /Ambiguous.*parent_station.*CODE.*TERM.*OTHER/,
      );
    },
  );

  it.each([
    {
      kind: "indexed parent",
      referencedRow: "REF,,Referenced Terminal,43.1,-80.1,1,",
      membership: { "fixture-terminal": [], "referenced-terminal": ["CHILD"] },
      unmatchedIds: [],
    },
    {
      kind: "non-parent stop",
      referencedRow: "REF,,Unrelated Stop,43.1,-80.1,0,",
      membership: { "fixture-terminal": [] },
      unmatchedIds: ["CHILD"],
    },
    {
      kind: "out-of-scope parent",
      referencedRow: "REF,,Outside Schematic,43.1,-80.1,1,",
      membership: { "fixture-terminal": [] },
      unmatchedIds: ["CHILD"],
    },
  ])(
    "honors exact stop_id before ambiguous stop_code for a $kind anywhere in the input",
    ({ referencedRow, membership, unmatchedIds }) => {
      const rows = parseGtfsStopRows(
        [
          "stop_id,stop_code,stop_name,stop_lat,stop_lon,location_type,parent_station",
          "TERM,REF,Fixture Terminal,43.1,-80.1,1,",
          "OTHER,REF,Outside Schematic,43.2,-80.2,1,",
          "CHILD,,Fixture Terminal Platform 1,43.1,-80.1,0,REF",
          referencedRow,
        ].join("\n"),
      );

      const artifact = compileStationIndexArtifact(
        {
          ...terminalFixtureSchematic,
          stations: [
            ...terminalFixtureSchematic.stations,
            {
              id: "referenced-terminal",
              name: "Referenced Terminal",
              x: 90,
              y: 90,
              lines: ["fixture-line"],
            },
          ],
          sequences: { "fixture-line": ["fixture-terminal", "referenced-terminal"] },
        },
        rows,
      );

      expect(
        Object.fromEntries(
          artifact.stations.map((station) => [station.schematicId, station.platformIds]),
        ),
      ).toEqual(membership);
      expect(artifact.unmatchedPlatforms.map((platform) => platform.stopId)).toEqual(unmatchedIds);
    },
  );

  it("does not guess a parent from a child name or a non-parent stop_code", () => {
    const rows = parseGtfsStopRows(
      [
        "stop_id,stop_code,stop_name,stop_lat,stop_lon,location_type,parent_station",
        "TERM,,Fixture Terminal,43.1,-80.1,1,",
        "SIDE,CODE,Unrelated Stop,43.1,-80.1,0,",
        "CHILD,,Fixture Terminal Platform 1,43.1,-80.1,0,CODE",
      ].join("\n"),
    );

    const artifact = compileStationIndexArtifact(terminalFixtureSchematic, rows);

    expect(artifact.stations[0].platformIds).toEqual([]);
    expect(artifact.unmatchedPlatforms).toEqual([
      {
        stopId: "CHILD",
        name: "Fixture Terminal Platform 1",
        parentStation: "CODE",
        knownParent: false,
      },
    ]);
  });

  it("maps parent stations onto canonical Line 1/2/4 names with their platform ids, flagging non-subway platforms", () => {
    const rows = parseGtfsStopRows(SYNTHETIC_STOPS_TXT);
    expect(rows).toHaveLength(9);

    const artifact = buildSubwayStationIndex(
      rows,
      lineSequences,
      ["1", "2", "4"],
      stationAliases,
      stationNames,
    );

    // Interchange mapped to every serving line under its canonical name
    const bloorYonge = artifact.stations.find((s) => s.name === "Bloor-Yonge");
    expect(bloorYonge).toBeDefined();
    expect(bloorYonge!.schematicId).toBe("bloor-yonge");
    expect(bloorYonge!.lines).toEqual(["1", "2"]);
    expect(bloorYonge!.platformIds).toEqual(["13755", "13863"]);
    expect(bloorYonge!.lat).toBeCloseTo(43.67099, 4);

    // Alias normalization lands feed names on network.json spellings
    const tmu = artifact.stations.find((s) => s.name === "TMU");
    expect(tmu).toBeDefined();
    expect(tmu!.lines).toEqual(["1"]);
    expect(tmu!.platformIds).toEqual(["13731"]);

    // Non-Line-1/2/4 parents are skipped; their platforms are flagged loudly
    expect(artifact.stations.find((s) => s.name === "Mount Dennis")).toBeUndefined();
    const flaggedIds = artifact.unmatchedPlatforms.map((p) => p.stopId);
    expect(flaggedIds).toContain("16067");
    expect(flaggedIds).toContain("33322");
    expect(artifact.unmatchedPlatforms.find((p) => p.stopId === "16067")?.parentStation).toBe(
      "16001",
    );
  });

  it("maps a local parent terminal and child platforms through curated aliases", () => {
    const rows = parseGtfsStopRows(
      [
        "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station",
        "TERM,Fixture Terminal,43.1,-80.1,1,",
        "TERM1,Fixture Terminal Platform 1,43.1,-80.1,0,TERM",
        "TERM2,Fixture Terminal Platform 2,43.1,-80.1,0,TERM",
      ].join("\n"),
    );

    const artifact = compileStationIndexArtifact(terminalFixtureSchematic, rows);

    expect(artifact.stations).toHaveLength(1);
    expect(artifact.stations[0]).toMatchObject({
      schematicId: "fixture-terminal",
      platformIds: ["TERM1", "TERM2"],
    });
    expect(artifact.unmatchedPlatforms).toEqual([]);
  });

  it("derives the indexed line set from the provider schematic by default", () => {
    const rows = parseGtfsStopRows(SYNTHETIC_STOPS_TXT);
    const artifact = buildSubwayStationIndex(
      rows,
      lineSequences,
      undefined,
      stationAliases,
      stationNames,
    );

    expect(artifact.stations.find((station) => station.name === "Mount Dennis")).toMatchObject({
      lines: ["5"],
      platformIds: ["16067"],
    });
    expect(artifact.unmatchedPlatforms.some((platform) => platform.stopId === "16067")).toBe(false);
  });

  it("indexes top-level rail stations whose feed names include a GO suffix", () => {
    const rows = parseGtfsStopRows(
      [
        "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station",
        "UN,Union Station GO,43.6452,-79.3806,0,",
      ].join("\n"),
    );
    const artifact = buildSubwayStationIndex(
      rows,
      { LW: ["union"] },
      undefined,
      {},
      new Map([["union", "Union"]]),
    );

    expect(artifact.stations).toEqual([
      {
        id: "UN",
        schematicId: "union",
        name: "Union",
        lat: 43.6452,
        lon: -79.3806,
        lines: ["LW"],
        platformIds: ["UN"],
      },
    ]);
  });

  it("fails loudly when a normalized feed name matches more than one schematic identity", () => {
    const rows = parseGtfsStopRows(
      [
        "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station",
        "DUP,Central,43.1,-79.1,0,",
      ].join("\n"),
    );

    expect(() =>
      buildSubwayStationIndex(
        rows,
        { A: ["central-a"], B: ["central-b"] },
        undefined,
        {},
        new Map([
          ["central-a", "Central"],
          ["central-b", "Central"],
        ]),
      ),
    ).toThrow(/Ambiguous feed station name/);
  });

  it("refreshes feed identity fields while retaining provider-curated labels", () => {
    const merged = mergeStationIndex(
      [
        {
          id: "UN",
          name: "Union Station GO",
          lat: 43,
          lon: -79,
          lines: ["LW"],
          platformIds: ["old-platform"],
        },
      ],
      [
        {
          id: "UN",
          name: "Union",
          lat: 43.6452,
          lon: -79.3806,
          lines: ["LW", "UP"],
          platformIds: ["UN"],
        },
      ],
    );

    expect(merged).toEqual([
      {
        id: "UN",
        name: "Union Station GO",
        lat: 43.6452,
        lon: -79.3806,
        lines: ["LW", "UP"],
        platformIds: ["UN"],
      },
    ]);
  });

  it("matches by schematicId when upstream feed stop ID differs, preserving curated name, id, and directionTermini", () => {
    const merged = mergeStationIndex(
      [
        {
          id: "cornell",
          schematicId: "cornell",
          name: "Cornell Terminal",
          directionTermini: { east: "Box Grove" },
          lat: 43.8,
          lon: -79.2,
          lines: ["purple"],
          platformIds: ["old-plat"],
        },
      ],
      [
        {
          id: "26",
          schematicId: "cornell",
          name: "Cornell",
          lat: 43.880877,
          lon: -79.231556,
          lines: ["purple"],
          platformIds: ["7335", "7336"],
        },
      ],
    );

    expect(merged).toEqual([
      {
        id: "cornell",
        schematicId: "cornell",
        name: "Cornell Terminal",
        directionTermini: { east: "Box Grove" },
        lat: 43.880877,
        lon: -79.231556,
        lines: ["purple"],
        platformIds: ["7335", "7336"],
      },
    ]);
  });

  it("preserves sequence stations with empty platformIds when feed has no stops", () => {
    const merged = mergeStationIndex(
      [
        {
          id: "future",
          schematicId: "future",
          name: "Future Station",
          lat: 43.7,
          lon: -79.3,
          lines: ["5"],
          platformIds: ["old-plat"],
        },
      ],
      [],
      { "5": ["future"] },
    );

    expect(merged).toEqual([
      {
        id: "future",
        schematicId: "future",
        name: "Future Station",
        lat: 43.7,
        lon: -79.3,
        lines: ["5"],
        platformIds: [],
      },
    ]);
  });

  it("aggregates top-level bus stops by schematic id instead of exploding per stop", () => {
    const rows = parseGtfsStopRows(
      [
        "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station",
        "S1,Bus Terminal,44.1,-76.1,0,",
        "S2,Bus Terminal,44.2,-76.2,0,",
      ].join("\n"),
    );
    const artifact = buildSubwayStationIndex(
      rows,
      { "2": ["bus-terminal"] },
      undefined,
      {},
      new Map([["bus-terminal", "Bus Terminal"]]),
    );

    expect(artifact.stations).toEqual([
      {
        id: "bus-terminal",
        schematicId: "bus-terminal",
        name: "Bus Terminal",
        lat: 44.1,
        lon: -76.1,
        lines: ["2"],
        platformIds: ["S1", "S2"],
      },
    ]);
  });

  it("ignores top-level direct-name matches when parents exist, unless alias-resolved", () => {
    const rows = parseGtfsStopRows(
      [
        "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station",
        "P1,Glencairn,43.7,-79.4,1,",
        "E1,Glencairn Station,43.71,-79.44,0,",
        "B1,Yonge / Bernard,43.8,-79.45,0,",
      ].join("\n"),
    );
    const build = (aliases: Record<string, string>) =>
      buildSubwayStationIndex(
        rows,
        { "1": ["glencairn"], blue: ["bernard"] },
        undefined,
        aliases,
        new Map([
          ["glencairn", "Glencairn"],
          ["bernard", "Bernard"],
        ]),
      );

    // Entrance-like direct match is skipped; alias-resolved on-street stop is kept.
    expect(
      build({ "yonge / bernard": "bernard" })
        .stations.map((s) => s.id)
        .sort(),
    ).toEqual(["B1", "P1"]);
    expect(build({}).stations.map((s) => s.id)).toEqual(["P1"]);
  });

  it("carries ID-based sequences and aliases through the top-level seed adapter deterministically", () => {
    const rows = parseGtfsStopRows(SYNTHETIC_STOPS_TXT);
    const first = compileStationIndexArtifact(genericSubwaySchematic, rows);
    const second = compileStationIndexArtifact(genericSubwaySchematic, rows);

    expect(first).toEqual(second);
    expect(first.stations.find((station) => station.name === "TMU")).toMatchObject({
      id: "30001",
      schematicId: "tmu",
      name: "TMU",
    });
  });

  it("proposes alias candidates for gated top-level direct matches", () => {
    const rows = parseGtfsStopRows(
      [
        "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station",
        "P1,Glencairn,43.7,-79.4,1,",
        "E1,Glencairn Station,43.71,-79.44,0,",
      ].join("\n"),
    );
    const artifact = buildSubwayStationIndex(
      rows,
      { "1": ["glencairn"] },
      undefined,
      {},
      new Map([["glencairn", "Glencairn"]]),
    );

    expect(artifact.stations.map((station) => station.id)).toEqual(["P1"]);
    expect(artifact.aliasCandidates).toEqual([
      { stopName: "Glencairn Station", schematicId: "glencairn" },
    ]);
  });

  it("flags sequence stations left with no feed platforms", () => {
    expect(
      findStationsWithoutPlatforms({ "1": ["a", "b"] }, [
        {
          id: "a",
          schematicId: "a",
          name: "A",
          lat: 1,
          lon: 1,
          lines: ["1"],
          platformIds: ["p1"],
        },
        {
          id: "b",
          schematicId: "b",
          name: "B",
          lat: 1,
          lon: 1,
          lines: ["1"],
          platformIds: [],
        },
      ]),
    ).toEqual(["b"]);
  });

  it("flags popular routes missing from the feed unless folded by the route line map", () => {
    const feed = ["501", "502"];
    expect(findMissingPopularRoutes(["501", "999"], feed, { "502": "501" })).toEqual(["999"]);
    expect(findMissingPopularRoutes(["501"], ["502"], { "502": "501" })).toEqual([]);
  });

  it("parses feed route ids from routes.txt preferring short names", () => {
    expect(
      parseGtfsRouteIds(
        ["route_id,route_short_name,route_long_name", "R1,501,Express", "R2,,Local"].join("\n"),
      ),
    ).toEqual(["501", "R2"]);
  });
});

it("uses explicit stop-code aliases to distinguish stations with identical names", () => {
  const rows = parseGtfsStopRows(
    "stop_id,stop_code,stop_name,stop_lat,stop_lon,location_type,parent_station\nca,CAN,River Falls,44,-76,0,\nus,USA,River Falls,44,-75,0,",
  );
  const artifact = buildSubwayStationIndex(
    rows,
    { rail: ["river-ca"] },
    ["rail"],
    { "code:CAN": "river-ca" },
    new Map([["river-ca", "River Falls, ON"]]),
  );
  expect(artifact.stations).toMatchObject([{ schematicId: "river-ca", platformIds: ["ca"] }]);
  expect(artifact.stations).toHaveLength(1);
});

it("keeps identically named facilities separate using explicit feed-stop aliases", () => {
  const rows = parseGtfsStopRows(`stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station
west,Central,40,-74,1,
east,Central,40,-73.99,1,
west-platform,Central,40,-74,0,west
east-platform,Central,40,-73.99,0,east
`);
  const result = buildSubwayStationIndex(
    rows,
    { R: ["central-west", "central-east"] },
    ["R"],
    { "id:west": "central-west", "id:east": "central-east" },
    new Map([["central-west", "Central West"], ["central-east", "Central East"]]),
  );
  expect(result.stations.map(({ schematicId, platformIds }) => ({ schematicId, platformIds })).sort((a, b) => a.schematicId!.localeCompare(b.schematicId!)))
    .toEqual([
      { schematicId: "central-east", platformIds: ["east-platform"] },
      { schematicId: "central-west", platformIds: ["west-platform"] },
    ]);
});
