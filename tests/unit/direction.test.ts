import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDirectionLabels,
  statedCompassLabel,
  buildDirectionOptions,
  COLLAPSED_TRACKING_MAX_AGE_MS,
  deriveApproachingVehicleEtas,
  directionLabelFor,
  directionSemanticForPath,
  enrichRouteDirections,
  getDirectionCompassMeta,
  getRouteDirections,
  getRouteDirectionsForRoute,
  inferRouteHeadsign,
  oppositeDirectionLabel,
  parseHeadsign,
  resolveDirectionAxis,
  resolveDirectionId,
  scheduledHeadsignDestination,
} from "~/domain/surface/direction";
import { inferDestination } from "~/domain/surface/direction/options";
import type { RouteInterpretationConfig } from "~/agencies";
import {
  inferDirectionFromBearing,
  inferRouteType,
  isExpressRoute,
  type RouteDetails,
} from "~/domain/surface/types";

describe("getRouteDirections", () => {
  // Direction ids are structural (always 0/1); labels vary by route type.
  it.each([
    ["streetcar", "Eastbound", "Westbound"],
    ["rail", "Outbound", "Inbound"],
    ["bus", "Northbound", "Southbound"],
    ["express", "Northbound", "Southbound"],
    [undefined, "Northbound", "Southbound"],
  ])("returns %s directions (%s/%s)", (routeType, first, second) => {
    const dirs = getRouteDirections(routeType as Parameters<typeof getRouteDirections>[0]);
    expect(dirs.length).toBe(2);
    expect(dirs[0].directionId).toBe(0);
    expect(dirs[0].label).toBe(first);
    expect(dirs[1].directionId).toBe(1);
    expect(dirs[1].label).toBe(second);
    expect(dirs[0].destination).toBe("");
  });

  it("marks canonical fallbacks by semantic identity", () => {
    expect(getRouteDirections("rail").map((direction) => direction.generatedLabel)).toEqual([
      "outbound",
      "inbound",
    ]);
    expect(getRouteDirections("streetcar").map((direction) => direction.generatedLabel)).toEqual([
      "eastbound",
      "westbound",
    ]);
  });

  it("does not mark an operator label just because it matches English fallback text", () => {
    const [north] = buildDirectionOptions({
      base: getRouteDirections("bus"),
      directionLabels: {
        0: { label: "Northbound", destination: "Operator Terminal" },
      },
    });

    expect(north).toMatchObject({ label: "Northbound", destination: "Operator Terminal" });
    expect(north).not.toHaveProperty("generatedLabel");
  });
});

describe("parseHeadsign", () => {
  // Separator grammar matrix: dash/em-dash separators, to/towards destination
  // words, and dash-without-destination. Without a separator no label is
  // inferred (behavior freeze) — a bare compass word alone parses to nothing.
  it.each([
    ["North - 97 Yonge to Steeles Ave", "Northbound", "Steeles Ave"],
    ["North \u2014 97 Yonge to Steeles Ave", "Northbound", "Steeles Ave"],
    ["South - 510 Spadina towards Union Station", "Southbound", "Union Station"],
    ["East - 504 King", "Eastbound", ""],
    ["North", "", ""],
  ])("parses %j", (headsign, label, destination) => {
    expect(parseHeadsign(headsign)).toEqual({ label, destination });
  });

  it("returns empty strings for empty input", () => {
    expect(parseHeadsign("")).toEqual({ label: "", destination: "" });
  });

  // Separator-required grammar (behavior freeze): without a
  // " - "/" — " separator no label is inferred — the whole string
  // participates only in destination extraction, so a leading compass word
  // alone does not name the direction.
  it("extracts only the destination from no-separator sentences", () => {
    expect(parseHeadsign("North to Steeles Ave")).toEqual({
      label: "",
      destination: "Steeles Ave",
    });
    expect(parseHeadsign("97 Yonge to Steeles Ave")).toEqual({
      label: "",
      destination: "Steeles Ave",
    });
  });

  it("still yields empty output when there is nothing parseable", () => {
    expect(parseHeadsign("Some Random Headsign")).toEqual({ label: "", destination: "" });
  });

  // Relocated from route-tracking-helpers: direction-token behaviors
  // unique to these input shapes. Canonical home for all parseHeadsign cases.
  it.each([
    ["north - 510 Spadina towards Spadina", "Northbound", "Spadina"], // case-insensitive compass
    ["Northbound - 510 Spadina towards Union", "Northbound", "Union"], // full Xbound word as token
    ["South - 504 King towards Broadview towards Queen", "Southbound", "Queen"], // last towards wins
    ["Up - 510 Spadina towards Union", "", "Union"], // unrecognized direction → empty label
  ])("parses direction-token edge case %j", (headsign, label, destination) => {
    expect(parseHeadsign(headsign)).toEqual({ label, destination });
  });
});

describe("enrichRouteDirections", () => {
  const base = [
    { directionId: 0, label: "Northbound", destination: "" },
    { directionId: 1, label: "Southbound", destination: "" },
  ] as const;

  it("takes a supplied direction as authoritative in both fields", () => {
    const enriched = enrichRouteDirections(base, {
      0: { label: "Northbound", destination: "Steeles Ave" },
      1: { label: "Southbound", destination: "Union Station" },
    });
    expect(enriched[0]).toEqual({
      directionId: 0,
      label: "Northbound",
      destination: "Steeles Ave",
    });
    expect(enriched[1]).toEqual({
      directionId: 1,
      label: "Southbound",
      destination: "Union Station",
    });

    // An empty label is a decision, not a gap. The operator stated a terminal
    // and no bearing, so backfilling the base label would reintroduce the very
    // compass word the empty label exists to withhold.
    const statedTerminalOnly = enrichRouteDirections(base, {
      0: { label: "", destination: "Steeles Ave" },
    });
    expect(statedTerminalOnly[0].label).toBe("");
    expect(statedTerminalOnly[0].destination).toBe("Steeles Ave");
    expect(statedTerminalOnly[1]).toEqual(base[1]);
  });

  it("adds a direction the base pair does not contain", () => {
    // A route can declare a group per headsign, so more than two directions
    // exist and the canonical pair cannot enumerate them.
    const extended = enrichRouteDirections(base, {
      0: { label: "", destination: "Aldershot GO" },
      1: { label: "", destination: "Union Station" },
      2: { label: "", destination: "West Harbour GO" },
    });

    expect(extended.map((d) => d.directionId)).toEqual([0, 1, 2]);
    expect(extended[2]).toEqual({
      directionId: 2,
      label: "",
      destination: "West Harbour GO",
    });
  });

  it("returns a fresh copy of base when no (or an empty) direction labels map is given", () => {
    const withoutMap = enrichRouteDirections(base, undefined);
    expect(withoutMap).toEqual([...base]);
    expect(withoutMap).not.toBe(base);

    expect(enrichRouteDirections(base, {})).toEqual([...base]);
  });
});

describe("directionLabelFor", () => {
  it("maps compass words and Xbound forms to canonical labels", () => {
    expect(directionLabelFor("north")).toBe("Northbound");
    expect(directionLabelFor("NORTHBOUND")).toBe("Northbound");
    expect(directionLabelFor("south")).toBe("Southbound");
    expect(directionLabelFor("east")).toBe("Eastbound");
    expect(directionLabelFor("westbound")).toBe("Westbound");
  });

  it("returns empty string for non-compass words", () => {
    expect(directionLabelFor("97 yonge")).toBe("");
    expect(directionLabelFor("")).toBe("");
  });
});

describe("oppositeDirectionLabel", () => {
  it("swaps each directional label and returns empty for unknowns", () => {
    expect(oppositeDirectionLabel("Northbound")).toBe("Southbound");
    expect(oppositeDirectionLabel("Eastbound")).toBe("Westbound");
    expect(oppositeDirectionLabel("")).toBe("");
    expect(oppositeDirectionLabel("Sideways")).toBe("");
  });
});

describe("buildDirectionOptions", () => {
  const base = [
    { directionId: 0, label: "Northbound", destination: "" },
    { directionId: 1, label: "Southbound", destination: "" },
  ];

  it("prefers the per-direction labels map via enrichRouteDirections", () => {
    const options = buildDirectionOptions({
      base,
      directionLabels: { 1: { label: "Southbound", destination: "Union Station" } },
      headsign: "North to Steeles Ave",
      activeDirectionId: 0,
    });

    expect(options[0]).toEqual({ directionId: 0, label: "Northbound", destination: "" });
    expect(options[1]).toEqual({
      directionId: 1,
      label: "Southbound",
      destination: "Union Station",
    });
  });

  it("falls back to single-headsign enrichment with opposite inference when asked", () => {
    const options = buildDirectionOptions({
      base,
      headsign: "North - 97 Yonge to Steeles Ave",
      activeDirectionId: 0,
      inferOppositeDirection: true,
    });

    expect(options[0]).toEqual({ directionId: 0, label: "Northbound", destination: "Steeles Ave" });
    expect(options[1]).toEqual({
      directionId: 1,
      label: "Southbound",
      destination: "",
      generatedLabel: "southbound",
    });
  });

  // Only the direction the parsed headsign speaks for gets enriched; the
  // other keeps its base label — with or without opposite inference asked.
  it("enriches only the intended direction and holds base labels elsewhere", () => {
    const withoutInference = buildDirectionOptions({
      base,
      headsign: "North - 97 Yonge to Steeles Ave",
      activeDirectionId: 0,
    });
    expect(withoutInference[0]).toEqual({
      directionId: 0,
      label: "Northbound",
      destination: "Steeles Ave",
    });
    expect(withoutInference[1]).toEqual(base[1]);

    // A separator-less headsign parses to nothing under the
    // separator-required grammar (behavior freeze), so base passes through
    // untouched even for a bare compass word.
    const labelOnly = buildDirectionOptions({
      base,
      headsign: "North",
      activeDirectionId: 1,
    });
    expect(labelOnly[0]).toEqual(base[0]);
    expect(labelOnly[1]).toEqual(base[1]);
  });
});

describe("deriveApproachingVehicleEtas", () => {
  // Corridor fixture shapes mirror real SurfaceStop usage: id + code + lat/lon.
  const corridorStops = [
    { id: "1001", code: "4471", name: "Stop 1", lat: 43.65, lon: -79.38 },
    { id: "1002", code: "4472", name: "Stop 2", lat: 43.66, lon: -79.39 },
    { id: "1003", code: "4473", name: "Stop 3", lat: 43.67, lon: -79.4 },
    { id: "1004", code: "4474", name: "Stop 4", lat: 43.68, lon: -79.41 },
    { id: "1005", code: "4475", name: "Stop 5", lat: 43.69, lon: -79.42 },
  ];

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives a vehicle at the rider stop an ETA of now + 30_000ms", () => {
    const now = 1_700_000_000_000;
    const etas = deriveApproachingVehicleEtas({
      stops: corridorStops,
      vehicles: [{ currentStopSequence: 3, latitude: 43.67, longitude: -79.4 }],
      riderStop: { id: "1003" },
      now,
    });

    expect(etas).toEqual([now + 30_000]);
  });

  it("adds 120_000ms for each stop of distance beyond the boarding stop", () => {
    const now = 1_700_000_000_000;
    const etas = deriveApproachingVehicleEtas({
      stops: corridorStops,
      vehicles: [
        // Rider at stop index 2 ("1003"); vehicle at sequence 2 → 1 stop away
        { currentStopSequence: 2, latitude: 43.66, longitude: -79.39 },
        // Vehicle at sequence 1 → 2 stops away
        { currentStopSequence: 1, latitude: 43.65, longitude: -79.38 },
      ],
      riderStop: { id: "1003" },
      now,
    });

    expect(etas).toContain(now + 120_000);
    expect(etas).toContain(now + 240_000);
    expect(etas).toHaveLength(2);
  });

  it("sorts derived ETAs in ascending order regardless of vehicle order", () => {
    const now = 1_700_000_000_000;
    const etas = deriveApproachingVehicleEtas({
      stops: corridorStops,
      vehicles: [
        { currentStopSequence: 1, latitude: 43.65, longitude: -79.38 }, // farthest
        { currentStopSequence: 3, latitude: 43.67, longitude: -79.4 }, // at stop
        { currentStopSequence: 2, latitude: 43.66, longitude: -79.39 }, // middle
      ],
      riderStop: { id: "1003" },
      now,
    });

    expect(etas).toEqual([now + 30_000, now + 120_000, now + 240_000]);
  });

  // Approaching vehicles are capped at maxResults (default 3), soonest first.
  it.each([
    [undefined, [120_000, 240_000, 360_000]],
    [2, [120_000, 240_000]],
  ])("caps results at maxResults %s", (maxResults, expectedOffsets) => {
    const now = 1_700_000_000_000;
    const etas = deriveApproachingVehicleEtas({
      stops: corridorStops,
      vehicles: [
        { currentStopSequence: 1, latitude: 43.65, longitude: -79.38 },
        { currentStopSequence: 2, latitude: 43.66, longitude: -79.39 },
        { currentStopSequence: 3, latitude: 43.67, longitude: -79.4 },
        { currentStopSequence: 4, latitude: 43.68, longitude: -79.41 },
      ],
      riderStop: { id: "1005" },
      now,
      ...(maxResults === undefined ? {} : { maxResults }),
    });

    expect(etas).toEqual(expectedOffsets.map((offset) => now + offset));
  });

  it("filters out vehicles travelling in other directions", () => {
    const now = 1_700_000_000_000;
    const etas = deriveApproachingVehicleEtas({
      stops: corridorStops,
      vehicles: [
        { currentStopSequence: 1, directionId: 0, latitude: 43.65, longitude: -79.38 },
        { currentStopSequence: 2, directionId: 1, latitude: 43.66, longitude: -79.39 },
      ],
      riderStop: { id: "1003" },
      directionId: 0,
      now,
    });

    expect(etas).toEqual([now + 240_000]);
  });

  it("excludes vehicles that already passed the rider stop", () => {
    const now = 1_700_000_000_000;
    const etas = deriveApproachingVehicleEtas({
      stops: corridorStops,
      vehicles: [{ currentStopSequence: 4, latitude: 43.68, longitude: -79.41 }],
      riderStop: { id: "1002" },
      now,
    });

    expect(etas).toEqual([]);
  });

  it("resolves the rider stop by code when ids do not match", () => {
    const now = 1_700_000_000_000;
    const etas = deriveApproachingVehicleEtas({
      stops: corridorStops,
      vehicles: [{ currentStopSequence: 2, latitude: 43.66, longitude: -79.39 }],
      riderStop: { code: "4473" },
      now,
    });

    expect(etas).toEqual([now + 120_000]);
  });

  it("defaults `now` to Date.now() under fake timers", () => {
    const frozenNow = 1_700_000_123_456;
    vi.useFakeTimers({ now: frozenNow });

    const etas = deriveApproachingVehicleEtas({
      stops: corridorStops,
      vehicles: [{ currentStopSequence: 3, latitude: 43.67, longitude: -79.4 }],
      riderStop: { id: "1003" },
    });

    expect(etas).toEqual([frozenNow + 30_000]);
  });

  it("derives as before when every vehicle timestamp is within the freshness window", () => {
    const now = 1_700_000_000_000;
    const etas = deriveApproachingVehicleEtas({
      stops: corridorStops,
      vehicles: [
        {
          currentStopSequence: 1,
          latitude: 43.65,
          longitude: -79.38,
          timestamp: now - 60_000, // exactly at the cutoff → still fresh
        },
        { currentStopSequence: 2, latitude: 43.66, longitude: -79.39, timestamp: now - 5_000 },
      ],
      riderStop: { id: "1003" },
      now,
      maxVehicleAgeMs: 60_000,
    });

    expect(etas).toEqual([now + 120_000, now + 240_000]);
  });

  it("excludes only the stale vehicles when the fleet mixes fresh and stale positions", () => {
    const now = 1_700_000_000_000;
    const etas = deriveApproachingVehicleEtas({
      stops: corridorStops,
      vehicles: [
        {
          currentStopSequence: 1,
          latitude: 43.65,
          longitude: -79.38,
          timestamp: now - 60_001, // one ms past the cutoff → stale
        },
        {
          currentStopSequence: 2,
          latitude: 43.66,
          longitude: -79.39,
          timestamp: now - 300_000, // deeply stale
        },
        { currentStopSequence: 3, latitude: 43.67, longitude: -79.4, timestamp: now - 10_000 },
      ],
      riderStop: { id: "1003" },
      now,
      maxVehicleAgeMs: 60_000,
    });

    // Only the fresh vehicle (at the rider stop) derives an ETA
    expect(etas).toEqual([now + 30_000]);
  });

  it("returns no ETAs when every vehicle position is staler than the freshness window", () => {
    const now = 1_700_000_000_000;
    const etas = deriveApproachingVehicleEtas({
      stops: corridorStops,
      vehicles: [
        { currentStopSequence: 2, latitude: 43.66, longitude: -79.39, timestamp: now - 60_001 },
        { currentStopSequence: 3, latitude: 43.67, longitude: -79.4, timestamp: now - 600_000 },
      ],
      riderStop: { id: "1003" },
      now,
      maxVehicleAgeMs: 60_000,
    });

    expect(etas).toEqual([]);
  });

  // No 60s dedup here by design (R2): ETAs derive from distinct corridor
  // vehicles and are only sorted + capped — near-duplicate collapsing lives
  // in the stations fold (genericStationsSource grouping), pinned by its
  // compass/dedup seam test. Identical ETAs from distinct vehicles survive.
  it("does not dedup identical ETAs from distinct vehicles", () => {
    const now = 1_700_000_000_000;
    const etas = deriveApproachingVehicleEtas({
      stops: corridorStops,
      vehicles: [
        { currentStopSequence: 3, latitude: 43.67, longitude: -79.4 },
        { currentStopSequence: 3, latitude: 43.67, longitude: -79.4 },
      ],
      riderStop: { id: "1003" },
      now,
    });

    expect(etas).toEqual([now + 30_000, now + 30_000]);
  });

  it("stays age-blind when maxVehicleAgeMs is explicitly undefined (server path)", () => {
    const now = 1_700_000_000_000;
    const etas = deriveApproachingVehicleEtas({
      stops: corridorStops,
      vehicles: [
        {
          currentStopSequence: 3,
          latitude: 43.67,
          longitude: -79.4,
          timestamp: now - 3_600_000, // an hour old, but no gate requested
        },
      ],
      riderStop: { id: "1003" },
      now,
      // Explicit `undefined` is the server's age-blind opt-out — distinct
      // from omission (see the `in`-based default in eta.ts).
      maxVehicleAgeMs: undefined,
    });

    expect(etas).toEqual([now + 30_000]);
  });

  it("takes the COLLAPSED_TRACKING_MAX_AGE_MS default when maxVehicleAgeMs is omitted", () => {
    const now = 1_700_000_000_000;
    const stale = deriveApproachingVehicleEtas({
      stops: corridorStops,
      vehicles: [
        {
          currentStopSequence: 3,
          latitude: 43.67,
          longitude: -79.4,
          timestamp: now - COLLAPSED_TRACKING_MAX_AGE_MS - 1,
        },
      ],
      riderStop: { id: "1003" },
      now,
    });
    expect(stale).toEqual([]);

    const fresh = deriveApproachingVehicleEtas({
      stops: corridorStops,
      vehicles: [
        {
          currentStopSequence: 3,
          latitude: 43.67,
          longitude: -79.4,
          timestamp: now - COLLAPSED_TRACKING_MAX_AGE_MS,
        },
      ],
      riderStop: { id: "1003" },
      now,
    });
    expect(fresh).toEqual([now + 30_000]);
  });
});

describe("parseHeadsign arrow separator (inferRouteHeadsign grammar)", () => {
  it("treats ' → ' as direction/destination separator", () => {
    expect(parseHeadsign("North → North Terminal")).toEqual({
      label: "Northbound",
      destination: "North Terminal",
    });
  });

  it("handles a dangling arrow with no destination", () => {
    expect(parseHeadsign("East → ")).toEqual({ label: "Eastbound", destination: "" });
  });
});

/**
 * Single direction grammar: resolveDirectionId owns the 3-tier
 * NextBus tag/compass resolution; no caller keeps its own parser tiers.
 */
describe("resolveDirectionId", () => {
  // Tier 1: structured NextBus tags.
  it.each([
    ["504_0_504A", 0],
    ["504_1_BRDW", 1],
    ["97_0_yonge", 0],
    ["0_standalone", 0],
    ["1_standalone", 1],
    ["97_d0", 0],
    ["dir0suffix", 0],
    ["x?dir=1", 1],
  ])("resolves structured tag %s to %i", (tag, expected) => {
    expect(resolveDirectionId(tag, "ambiguous title", 1)).toBe(expected);
  });

  // Tier 2: leading compass prefix on title/name text.
  it.each([
    ["East - 504a King", 0],
    ["North - 97 Yonge", 0],
    ["West - 504b King", 1],
    ["South - 510 Spadina", 1],
  ])("resolves compass-prefixed title %q to %i", (title, expected) => {
    expect(resolveDirectionId(undefined, title, 1)).toBe(expected);
  });

  // Tier 3: unopposed word-boundary scan wins; conflicts fall back.
  it.each([
    ["to Steeles Ave westbound platform", 1],
    ["east end terminal", 0],
  ])("word-scans %q", (title, expected) => {
    expect(resolveDirectionId(undefined, title, 1)).toBe(expected);
  });

  it("lets a leading compass prefix win over conflicting words deeper in the text", () => {
    expect(resolveDirectionId(undefined, "east or west depending on sign", 1)).toBe(0);
  });

  it("falls back to the provided index when nothing resolves", () => {
    expect(resolveDirectionId(undefined, "", 0)).toBe(0);
    expect(resolveDirectionId(undefined, "", 1)).toBe(1);
    expect(resolveDirectionId(undefined, undefined, 1)).toBe(1);
  });
});

describe("inferRouteHeadsign", () => {
  // Canonical directions always match, so the terminal text comes from the
  // (empty) canonical destination — only the compass word survives.
  it.each([
    [0, "bus", "North → "],
    [1, "bus", "South → "],
    [0, "streetcar", "East → "],
    [1, "streetcar", "West → "],
  ])("infers a %s headsign for routeType %s", (directionId, routeType, expected) => {
    expect(inferRouteHeadsign(directionId, routeType as "bus" | "streetcar")).toBe(expected);
  });

  it("falls back to generic terminal text for an unmatched direction id", () => {
    expect(inferRouteHeadsign(2, "streetcar")).toBe("West → West Terminal");
    expect(inferRouteHeadsign(2, "bus")).toBe("South → South Terminal");
  });
});

function makeDetails(
  headsign: string,
  routeType: RouteDetails["route"]["routeType"] = "bus",
  directionId = 0,
): RouteDetails {
  return {
    route: {
      id: "501",
      shortName: "501",
      longName: "Queen",
      routeType,
      color: "#DA251D",
      textColor: "#FFFFFF",
    },
    shape: {
      id: `501_${directionId}_test`,
      routeId: "501",
      directionId,
      headsign,
      polyline: "",
      minLat: 43.6,
      maxLat: 43.7,
      minLon: -79.5,
      maxLon: -79.3,
      pointCount: 1,
    },
    stops: [],
  };
}

describe("buildDirectionLabels (single-homed)", () => {
  it("states no bearing for a rail headsign that names only a terminal", () => {
    // "Outbound"/"Inbound" is terminal vocabulary: away from a terminal it
    // means nothing, and a direction index does not say which end of the line a
    // rider is at. GO headsigns name the terminal and no bearing, so the
    // direction is omitted and the terminal stands alone.
    const result = buildDirectionLabels(
      new Map([
        [0, makeDetails("LW - Aldershot GO", "rail", 0)],
        [1, makeDetails("LW - Union Station GO", "rail", 1)],
      ]),
      "LW",
    );

    expect(result).toEqual({
      0: { label: "", destination: "Aldershot GO" },
      1: { label: "", destination: "Union Station GO" },
    });
  });

  it("still prefers a bearing the operator stated over the rail literal", () => {
    // A stated compass word is the operator's own claim and outranks the mode's
    // default, so it wins here as it does for every other route type.
    const result = buildDirectionLabels(
      new Map([
        [0, makeDetails("East to Appleby GO", "rail", 0)],
        [1, makeDetails("West to Hamilton", "rail", 1)],
      ]),
      "LW",
    );

    expect(result[0].label).toBe("Eastbound");
    expect(result[1].label).toBe("Westbound");
    expect(result[0].generatedLabel).toBeUndefined();
    expect(result[1].generatedLabel).toBeUndefined();
  });

  it.each([
    {
      name: "bus both present via headsign",
      routeType: "bus" as const,
      entries: [
        [0, "North — 97 Yonge to Steeles Ave"],
        [1, "South — 97 Yonge to Queens Quay"],
      ] as const,
      expect: {
        0: { label: "Northbound", destination: "Steeles Ave" },
        1: { label: "Southbound", destination: "Queens Quay" },
      },
    },
    {
      name: "streetcar both present via headsign",
      routeType: "streetcar" as const,
      entries: [
        [0, "East — 504 King to Broadview Station"],
        [1, "West — 504 King to Dundas West Station"],
      ] as const,
      expect: {
        0: { label: "Eastbound", destination: "Broadview Station" },
        1: { label: "Westbound", destination: "Dundas West Station" },
      },
    },
    {
      name: "bus partial dir0 present only",
      routeType: "bus" as const,
      entries: [[0, "North — 97 Yonge to Steeles Ave"]] as const,
      expect: {
        0: { label: "Northbound", destination: "Steeles Ave" },
        1: { label: "", destination: "" },
      },
    },
    {
      name: "streetcar partial dir1 present only",
      routeType: "streetcar" as const,
      entries: [[1, "West — 504 King to Dundas West Station"]] as const,
      expect: {
        0: { label: "", destination: "" },
        1: { label: "Westbound", destination: "Dundas West Station" },
      },
    },
    {
      name: "bus none present -> states no bearing",
      routeType: "bus" as const,
      entries: [] as const,
      expect: {
        0: { label: "", destination: "" },
        1: { label: "", destination: "" },
      },
    },
    {
      name: "streetcar none present -> states no bearing",
      routeType: "streetcar" as const,
      entries: [] as const,
      expect: {
        0: { label: "", destination: "" },
        1: { label: "", destination: "" },
      },
    },
    {
      name: "express none present -> states no bearing",
      routeType: "express" as const,
      entries: [] as const,
      expect: {
        0: { label: "", destination: "" },
        1: { label: "", destination: "" },
      },
    },
    {
      // The headsign states a terminal but no bearing, so no compass word is
      // derived for it. The undeclared opposite still reads the canonical
      // literal, since there is nothing stated to contradict.
      name: "bus headsign without a stated bearing states none",
      routeType: "bus" as const,
      entries: [[0, "97 Yonge to Steeles Ave"]] as const,
      expect: {
        0: { label: "", destination: "Steeles Ave" },
        1: { label: "", destination: "" },
      },
    },
    {
      name: "bus headsign stating a bearing but no destination",
      routeType: "bus" as const,
      entries: [[0, "East — 504 King"]] as const,
      expect: {
        0: { label: "Eastbound", destination: "" },
        1: { label: "", destination: "" },
      },
    },
    {
      name: "bus empty headsign states no bearing",
      routeType: "bus" as const,
      entries: [[0, ""]] as const,
      expect: {
        0: { label: "", destination: "" },
        1: { label: "", destination: "" },
      },
    },
  ])("builds $name", ({ routeType, entries, expect: expected }) => {
    const byDir = new Map<number, RouteDetails>();
    for (const [dirId, headsign] of entries as readonly [number, string][]) {
      byDir.set(dirId, makeDetails(headsign, routeType, dirId));
    }
    const result = buildDirectionLabels(byDir);
    expect(result).toEqual(expected);
  });
});

describe("operator destination fixtures", () => {
  const details = (dirId: number, headsign: string) => [dirId, { shape: { headsign } }] as const;
  it("keeps a branch-letter headsign whole instead of stripping the branch off", () => {
    // GO names the route "18" but headsigns its branches "18A - Union
    // Station". The letter belongs to the name, so stripping the short name
    // there produced the destination "A - Union Station" for 180 GO shapes.
    const labels = buildDirectionLabels(
      new Map([
        details(0, "18 - Aldershot GO"),
        details(1, "18A - Union Station"),
        details(2, "18N - West Harbour GO"),
      ]),
      "18",
    );

    expect(labels[0].destination).toBe("Aldershot GO");
    expect(labels[1].destination).toBe("Union Station");
    expect(labels[2].destination).toBe("West Harbour GO");
  });

  it("labels every direction a route declares, not just the 0/1 pair", () => {
    const labels = buildDirectionLabels(
      new Map([
        details(0, "Conestoga Station"),
        details(1, "Fairway Station"),
        details(2, "Frederick Station"),
      ]),
      "7",
    );

    expect(
      Object.keys(labels)
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual([0, 1, 2]);
    expect(labels[2]).toEqual({ label: "", destination: "Frederick Station" });
  });
  it("separates a feed's stated bearings from its stated terminals", () => {
    // The label is the operator's own claim and nothing else. A compass word
    // derived from a direction index is the claim that put a wrong bearing on a
    // real bus, so it is never produced for a terminal-only headsign.
    expect(statedCompassLabel("North to Steeles Ave")).toBe("Northbound");
    expect(statedCompassLabel("Westbound to Brampton")).toBe("Westbound");
    expect(statedCompassLabel("Fairway Station")).toBe("");
    expect(statedCompassLabel("51 HEREFORD EAST")).toBe("");

    const labels = buildDirectionLabels(
      new Map([
        [0, { shape: { headsign: "51 HEREFORD EAST" } }],
        [1, { shape: { headsign: "51 HEREFORD WEST" } }],
      ]),
      "51",
    );

    expect(labels[0]).toEqual({ label: "", destination: "HEREFORD EAST" });
    expect(labels[1]).toEqual({ label: "", destination: "HEREFORD WEST" });
  });
});

describe("getDirectionCompassMeta", () => {
  it("returns correct compass angle and abbreviation for cardinal and ordinal directions", () => {
    expect(getDirectionCompassMeta("Northbound")).toEqual({ angle: 0, shortCode: "N" });
    expect(getDirectionCompassMeta("Eastbound")).toEqual({ angle: 90, shortCode: "E" });
    expect(getDirectionCompassMeta("Southbound")).toEqual({ angle: 180, shortCode: "S" });
    expect(getDirectionCompassMeta("Westbound")).toEqual({ angle: 270, shortCode: "W" });
    expect(getDirectionCompassMeta("Northeastbound")).toEqual({ angle: 45, shortCode: "NE" });
  });

  it("falls back to a derived short code for non-compass labels", () => {
    expect(getDirectionCompassMeta("Outbound")).toEqual({ angle: 0, shortCode: "OU" });
    expect(getDirectionCompassMeta("")).toEqual({ angle: 0, shortCode: "DIR" });
  });
});

describe("surface route interpretation", () => {
  it("uses generic fallback when no provider route policy is supplied", () => {
    expect(inferRouteType("510")).toBe("bus");
    expect(
      isExpressRoute({
        id: "900",
        routeType: "bus",
        shortName: "900",
        longName: "Airport corridor",
      }),
    ).toBe(false);
  });

  it("applies provider-declared route ranges and bearing overrides", () => {
    const policy = {
      routeTypeRules: [
        { routeType: "streetcar" as const, minId: 700, maxId: 714 },
        { routeType: "express" as const, minId: 950, maxId: 999 },
      ],
      directionInference: {
        routeOverrides: { fixture510: "north-south" as const },
      },
    };

    expect(inferRouteType("710", policy)).toBe("streetcar");
    expect(inferRouteType("950", policy)).toBe("express");
    expect(inferRouteType("710", policy)).not.toBe("bus");
    expect(inferDirectionFromBearing("fixture510", 270, policy)).toBe(0);
    expect(inferDirectionFromBearing("fixture510", 270)).toBe(1);
  });

  it("uses Core north/south IDs and applies a declared inverted feed order", () => {
    const policy: RouteInterpretationConfig = {
      directionInference: {
        routeOverrides: { "fixture-510": "north-south" },
        invertNorthSouth: true,
      },
    };

    expect(inferDirectionFromBearing("fixture-510", 0, policy)).toBe(1);
    expect(inferDirectionFromBearing("fixture-510", 180, policy)).toBe(0);
    expect(inferDirectionFromBearing("fixture-510", 89, policy)).toBe(1);
    expect(inferDirectionFromBearing("fixture-510", 91, policy)).toBe(0);
    const canonicalPolicy: RouteInterpretationConfig = {
      directionInference: { default: "north-south" },
    };
    expect(inferDirectionFromBearing("fixture-511", 0, canonicalPolicy)).toBe(0);
    expect(inferDirectionFromBearing("fixture-511", 180, canonicalPolicy)).toBe(1);
    expect(inferDirectionFromBearing("fixture-511", 89, canonicalPolicy)).toBe(0);
    expect(inferDirectionFromBearing("fixture-511", 91, canonicalPolicy)).toBe(1);
  });

  it("keeps canonical fallback labels aligned with inverted north/south feed IDs", () => {
    const policy: RouteInterpretationConfig = {
      directionInference: {
        routeOverrides: { "fixture-510": "north-south" },
        invertNorthSouth: true,
      },
    };
    const directions = getRouteDirectionsForRoute("streetcar", "fixture-510", policy);

    expect(directions).toEqual([
      { directionId: 0, label: "Southbound", destination: "", generatedLabel: "southbound" },
      { directionId: 1, label: "Northbound", destination: "", generatedLabel: "northbound" },
    ]);
    expect(inferRouteHeadsign(0, "streetcar", "north-south", true)).toBe("South → ");
  });

  it("applies feed polarity to inferred compass text while preserving structured IDs", () => {
    expect(
      resolveDirectionId(undefined, "Northbound to Terminal", 0, { invertNorthSouth: true }),
    ).toBe(1);
    expect(
      resolveDirectionId(undefined, "Southbound to Terminal", 0, { invertNorthSouth: true }),
    ).toBe(0);
    expect(
      resolveDirectionId("fixture_0_direction", "Northbound", 1, { invertNorthSouth: true }),
    ).toBe(0);
  });
});

describe("compass geometry at Toronto latitude", () => {
  const pathAtBearing = (
    bearing: number,
  ): readonly [readonly [number, number], readonly [number, number]] => {
    const radians = (bearing * Math.PI) / 180;
    const startLat = 43.7;
    const latitudeDelta = Math.cos(radians) * 0.1;
    const meanLatitude = startLat + latitudeDelta / 2;
    const longitudeDelta = (Math.sin(radians) * 0.1) / Math.cos((meanLatitude * Math.PI) / 180);
    return [
      [startLat, -79.4],
      [startLat + latitudeDelta, -79.4 + longitudeDelta],
    ];
  };

  it.each([
    [44, "northbound"],
    [46, "eastbound"],
    [134, "eastbound"],
    [136, "southbound"],
  ] as const)("classifies a true %i° bearing as %s", (bearing, expected) => {
    expect(directionSemanticForPath(pathAtBearing(bearing))).toBe(expected);
  });
});

describe("direction axis (agency directionInference policy)", () => {
  // New coverage for the axis-aware direction-label feature: the agency's
  // directionInference policy selects the compass pair per route, and the
  // domain helpers thread it through labels and headsigns.
  const policy: RouteInterpretationConfig = {
    directionInference: {
      default: "east-west",
      routeOverrides: { "301": "north-south", "302": "east-west" },
    },
  };

  it.each([
    ["301", "north-south"],
    ["302", "east-west"],
    ["unlisted-route", "east-west"],
  ] as const)("resolves route %s to the %s axis", (routeId, expected) => {
    expect(resolveDirectionAxis(routeId, policy)).toBe(expected);
  });

  it("returns undefined without a policy", () => {
    expect(resolveDirectionAxis("7")).toBeUndefined();
    expect(resolveDirectionAxis("7", {})).toBeUndefined();
  });

  it.each([
    ["bus", "east-west", "Eastbound", "Westbound"],
    ["bus", "north-south", "Northbound", "Southbound"],
    ["streetcar", "north-south", "Northbound", "Southbound"],
    ["rail", "east-west", "Eastbound", "Westbound"],
  ] as const)("returns the %s pair for %s routes on %s", (routeType, axis, first, second) => {
    const dirs = getRouteDirections(routeType, axis);
    expect(dirs.map((direction) => direction.label)).toEqual([first, second]);
  });

  it("states no direction when the feed offers neither a bearing nor geometry", () => {
    // An empty headsign and no shape is nothing to read a direction from. The
    // axis pair is the manifest's guess about an axis the operator never named,
    // so it does not fill the label.
    const result = buildDirectionLabels(
      new Map([
        [0, makeDetails("", "bus", 0)],
        [1, makeDetails("", "bus", 1)],
      ]),
      "7",
    );
    expect(result).toEqual({
      0: { label: "", destination: "" },
      1: { label: "", destination: "" },
    });
  });

  it("reads the direction of travel from the shape when the headsign states none", () => {
    // A shape runs first point to last point in the direction the vehicle
    // travels, so its endpoint bearing is the operator's own statement of which
    // way the trip goes. These two encoded shapes run east and west respectively
    // (encoded from two points sharing a latitude, with longitude increasing and
    // then decreasing).
    const result = buildDirectionLabels(
      new Map([
        [0, { shape: { headsign: "LW - Aldershot GO", polyline: "_bohG~sijN?_pR" } }],
        [1, { shape: { headsign: "LW - Union Station GO", polyline: "_bohG~bviN?~oR" } }],
      ]),
      "LW",
    );
    expect(result[0].label).toBe("Eastbound");
    expect(result[1].label).toBe("Westbound");
    expect(result[0].generatedLabel).toBe("eastbound");
    expect(result[1].generatedLabel).toBe("westbound");
    // The destination is still the operator's terminal, not a derived guess.
    expect(result[0].destination).toBe("Aldershot GO");
  });

  it("prefers a stated bearing over the shape's own bearing", () => {
    const result = buildDirectionLabels(
      new Map([[0, { shape: { headsign: "West to Dundas West", polyline: "_bohG~sijN?_pR" } }]]),
      "504",
    );
    expect(result[0].label).toBe("Westbound");
  });

  it.each([
    [0, "bus", "east-west", "East → "],
    [1, "bus", "north-south", "South → "],
  ] as const)("infers the %s headsign for %s on %s", (directionId, routeType, axis, expected) => {
    expect(inferRouteHeadsign(directionId, routeType, axis)).toBe(expected);
  });

  it.each([
    ["301 Conestoga", "301", "Conestoga"],
    ["7 King", "7", "King"],
    ["Fairway Station", "7", "Fairway Station"],
    ["", "7", ""],
  ] as const)("infers the destination %j from %j", (headsign, shortName, expected) => {
    expect(inferDestination(headsign, shortName)).toBe(expected);
  });
});

describe("scheduledHeadsignDestination", () => {
  it.each([
    ["Uptown Terminal", "4", "Uptown Terminal"],
    ["4 Uptown Terminal", "4", "Uptown Terminal"],
    ["4 Harbour Loop to Uptown Terminal", "4", "Uptown Terminal"],
    ["UPTOWN TERMINAL", "4", "UPTOWN TERMINAL"],
    ["45 Uptown Terminal", "10045", "Uptown Terminal"],
    ["9A Park Side", "9A", "Park Side"],
    ["Fin de service", "4", undefined],
    ["Southbound", "4", undefined],
    ["Sud", "4", undefined],
    ["1", "4", undefined],
    ["4", "4", undefined],
    ["  ", "4", undefined],
    [undefined, "4", undefined],
  ])("reads %j on route %s as %j", (headsign, routeId, expected) => {
    expect(scheduledHeadsignDestination(headsign, routeId)).toBe(expected);
  });
});
