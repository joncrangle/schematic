import { describe, expect, it } from "vitest";
import { makeAgencyAlert } from "../helpers/fixtures";
import {
  bucketForKind,
  compareByFavouriteLine,
  toServiceAlerts,
  toUpcomingClosures,
} from "~/domain/serviceAlerts";
import type { AgencyAlert, Schematic } from "~/agencies/types";

const defaultSchematic = {
  viewBoxWidth: 100,
  viewBoxHeight: 100,
  lines: [
    { id: "1", name: "Alpha Line", color: "#aa0000", points: [] },
    { id: "2", name: "Bravo Line", color: "#bb1111", points: [] },
    { id: "4", name: "Delta Line", color: "#cc2222", points: [] },
    { id: "5", name: "Echo Line", color: "#dd3333", points: [] },
    { id: "6", name: "Foxtrot Line", color: "#ee4444", points: [] },
  ],
  stations: [
    { id: "woodbine", name: "Woodbine", x: 10, y: 10, lines: ["6"] },
    { id: "broadview", name: "Broadview", x: 30, y: 10, lines: ["2"] },
    { id: "st-george", name: "St. George", x: 50, y: 10, lines: ["1", "2", "4"] },
  ],
  viewport: { bounds: { minX: 0, maxX: 100, minY: 0, maxY: 100 }, minZoom: 0.5, maxZoom: 4 },
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
} satisfies Schematic;

const formatAlerts = (alerts: readonly AgencyAlert[], schematic: Schematic = defaultSchematic) =>
  toServiceAlerts(alerts, schematic);
const formatClosures = (alerts: readonly AgencyAlert[], schematic: Schematic = defaultSchematic) =>
  toUpcomingClosures(alerts, schematic, { locale: "en-US" });

describe("toServiceAlerts", () => {
  it("keeps distinct stop-only placeholder incidents visible", () => {
    const alerts = formatAlerts(["Elm", "Oak"].map(name => makeAgencyAlert({id: name, title: "Transit Alert", description: undefined, scope: "station", kind: "suspension", affectedStations: [{stationName: name}]})));
    expect(alerts.map(alert => alert.description)).toEqual(["Elm", "Oak"]);
  });
  it("does not label an unattributed stop closure as systemwide", () => {
    const alerts = formatAlerts([makeAgencyAlert({ scope: "station", affectedLineIds: [], affectedRouteIds: [], affectedStations: [{stationName: "Elm at Main"}], title: "Transit Alert", description: undefined, kind: "suspension", severity: "severe" })]);
    expect(alerts[0]?.lineName).not.toBe("Systemwide");
    expect(alerts[0]?.title).not.toBe("Transit Alert");
  });
  it("keeps only active, non-upcoming alerts", () => {
    const alerts: AgencyAlert[] = [
      makeAgencyAlert({ id: "active", title: "Signal problem at Bloor" }),
      makeAgencyAlert({ id: "upcoming-lifecycle", lifecycle: "upcoming", title: "Planned work" }),
      makeAgencyAlert({ id: "upcoming-kind", kind: "upcoming", title: "Future night closure" }),
      makeAgencyAlert({ id: "expired", lifecycle: "expired", title: "Old news" }),
    ];

    expect(formatAlerts(alerts).map((a) => a.id)).toEqual(["active"]);
  });

  it("does not resurrect an expired alert whose kind is upcoming", () => {
    const alerts = formatClosures([
      makeAgencyAlert({ id: "expired", kind: "upcoming", lifecycle: "expired" }),
    ]);

    expect(alerts).toEqual([]);
  });

  it("does not put surface-route alerts into the subway upcoming-work panel", () => {
    const alerts = formatClosures([
      makeAgencyAlert({
        id: "future-streetcar",
        kind: "upcoming",
        lifecycle: "upcoming",
        affectedRouteIds: ["506"],
      }),
    ]);

    expect(alerts).toEqual([]);
  });

  it("does not bucket a surface reduced-service alert as a subway slow zone", () => {
    const alerts = formatAlerts([
      makeAgencyAlert({
        id: "surface-reduced-service",
        kind: "slow-service",
        affectedRouteIds: ["506"],
      }),
    ]);

    expect(alerts).toEqual([]);
  });

  it("carries domain severity and kind through untouched (no invented vocabulary)", () => {
    const [formatted] = formatAlerts([
      makeAgencyAlert({ id: "a", kind: "slow-service", severity: "degraded" }),
    ]);

    expect(formatted?.severity).toBe("degraded");
    expect(formatted?.kind).toBe("slow-service");
  });

  it.each([
    ["delay", "delays"],
    ["slow-service", "rsz"],
    ["suspension", "delays"],
    ["accessibility", "accessibility"],
    ["information", "delays"],
  ] as const)("buckets %s-kind alerts under the %s filter", (kind, expectedBucket) => {
    expect(bucketForKind(kind)).toBe(expectedBucket);
  });

  it.each([
    ["attributed line", { affectedLineIds: ["4"] }, "Delta Line"],
    ["attributed surface route", { affectedRouteIds: ["506"] }, "506"],
    [
      "unattributed accessibility",
      { affectedLineIds: undefined, kind: "accessibility" },
      "Accessibility",
    ],
    [
      "multi-route accessibility",
      {
        affectedLineIds: undefined,
        affectedRouteIds: ["1,2,19,97,300,320"],
        kind: "accessibility",
      },
      "Accessibility",
    ],
    ["unattributed systemwide", { affectedLineIds: undefined, kind: "delay" }, "Systemwide"],
  ] as const)("%s alert renders line name %s", (_label, overrides, expectedLineName) => {
    const [formatted] = formatAlerts([makeAgencyAlert({ title: "Advisory", ...overrides })]);
    expect(formatted?.lineName).toBe(expectedLineName);
  });

  it("cleans leading dashes and punctuation from alert titles", () => {
    const [dashTitle, hyphenTitle] = formatAlerts([
      makeAgencyAlert({ id: "a", title: "– Route change due to construction" }),
      makeAgencyAlert({ id: "b", title: "- Delay at Broadview" }),
    ]);

    expect(dashTitle?.title).toBe("Route change due to construction");
    expect(hyphenTitle?.title).toBe("Delay at Broadview");
  });

  it("never claims Line 1 for systemwide alerts", () => {
    const [systemwide, attributed] = formatAlerts([
      makeAgencyAlert({ id: "sys", title: "System advisory", affectedLineIds: undefined }),
      makeAgencyAlert({ id: "l1", title: "Line 1 delay", affectedLineIds: ["1"] }),
    ]);

    // Keep systemwide alerts from inheriting a line's identity or color.
    expect(systemwide?.scope).toBe("systemwide");
    expect(systemwide?.lineId).toBeUndefined();
    expect(systemwide?.lineColor).toBeUndefined();

    expect(attributed?.scope).toBe("line");
    expect(attributed?.lineId).toBe("1");
    expect(attributed?.lineColor).toBeDefined();
  });

  it("falls back to the title when no description ships", () => {
    const [withDescription, withoutDescription] = formatAlerts([
      makeAgencyAlert({ id: "a", title: "Delay at Bay", description: "Signal issue" }),
      makeAgencyAlert({ id: "b", title: "Delay at Yonge", description: undefined }),
    ]);

    expect(withDescription?.description).toBe("Signal issue");
    expect(withoutDescription?.description).toBe("Delay at Yonge");
  });

  it("deduplicates identical active alerts with same id or content signature", () => {
    const alerts: AgencyAlert[] = [
      makeAgencyAlert({ id: "dup-1", title: "Signal issue at St George", affectedLineIds: ["1"] }),
      makeAgencyAlert({ id: "dup-1", title: "Signal issue at St George", affectedLineIds: ["1"] }),
      makeAgencyAlert({ id: "dup-2", title: "Signal issue at St George", affectedLineIds: ["1"] }),
      makeAgencyAlert({ id: "unique", title: "Track work at Bloor", affectedLineIds: ["2"] }),
    ];

    expect(formatAlerts(alerts).map((a) => a.id)).toEqual(["dup-1", "unique"]);
  });
});

describe("toUpcomingClosures", () => {
  it("selects upcoming alerts by lifecycle or kind and ignores active disruptions", () => {
    const alerts: AgencyAlert[] = [
      makeAgencyAlert({ id: "planned", lifecycle: "upcoming", title: "Nightly track work" }),
      makeAgencyAlert({ id: "future-closure", kind: "upcoming", title: "Weekend closure" }),
      makeAgencyAlert({ id: "active-delay", title: "Live signal problem" }),
      makeAgencyAlert({ id: "expired-plan", lifecycle: "expired", title: "Past work" }),
    ];

    expect(formatClosures(alerts).map((c) => c.id)).toEqual(["planned", "future-closure"]);
  });

  it("orders upcoming closures by soonest disruption first (ascending startsAt)", () => {
    const alerts: AgencyAlert[] = [
      makeAgencyAlert({ id: "later", lifecycle: "upcoming", startsAt: 2000 }),
      makeAgencyAlert({ id: "soonest", lifecycle: "upcoming", startsAt: 1000 }),
      makeAgencyAlert({ id: "unspecified", lifecycle: "upcoming", startsAt: 0 }),
    ];

    expect(formatClosures(alerts).map((c) => c.id)).toEqual(["soonest", "later", "unspecified"]);
  });

  it.each([
    [
      "ships a segment span",
      {
        fromStation: { stationId: "woodbine", stationName: "Woodbine" },
        toStation: { stationId: "broadview", stationName: "Broadview" },
      },
      "Woodbine to Broadview",
    ],
    ["has no endpoints", {}, "Transit Network"],
  ] as const)("%s -> segment '%s'", (_label, overrides, expectedSegment) => {
    const [closure] = formatClosures([
      makeAgencyAlert({ lifecycle: "upcoming", title: "Track work", ...overrides }),
    ]);

    expect(closure?.segment).toBe(expectedSegment);
  });

  it("keeps genuine line identity and never mints a Line 1 claim", () => {
    const closures = formatClosures([
      makeAgencyAlert({
        id: "attributed",
        lifecycle: "upcoming",
        title: "Line 2 weekend work",
        affectedLineIds: ["2"],
      }),
      makeAgencyAlert({
        id: "network-wide",
        lifecycle: "upcoming",
        title: "Systemwide maintenance",
        affectedLineIds: undefined,
      }),
    ]);

    const attributed = closures.find((c) => c.id === "attributed");
    const networkWide = closures.find((c) => c.id === "network-wide");

    expect(attributed?.lineId).toBe("2");
    expect(attributed?.lineName).toBe("Bravo Line");
    expect(attributed?.lineColor).toBe("#bb1111");

    expect(networkWide?.lineId).toBeUndefined();
    expect(networkWide?.lineName).toBe("Planned Work");
    expect(networkWide?.lineColor).toBeUndefined();
  });

  it("formats the actual effective time range for upcoming closures", () => {
    // 2026-08-29 14:00 UTC to 18:00 UTC
    const tStart = 1788012000000;
    const tEndSameDay = tStart + 4 * 3600_000;
    const tEndNextDay = tStart + 30 * 3600_000;

    const [sameDay, multiDay, startOnly, unspecific] = formatClosures([
      makeAgencyAlert({
        id: "same",
        lifecycle: "upcoming",
        startsAt: tStart,
        endsAt: tEndSameDay,
      }),
      makeAgencyAlert({
        id: "multi",
        lifecycle: "upcoming",
        startsAt: tStart,
        endsAt: tEndNextDay,
      }),
      makeAgencyAlert({
        id: "startOnly",
        lifecycle: "upcoming",
        startsAt: tStart,
        endsAt: undefined,
      }),
      makeAgencyAlert({
        id: "none",
        lifecycle: "upcoming",
        startsAt: 0,
      }),
    ]);

    expect(sameDay?.dateRange).toMatch(/\w+ \d+, \d{1,2}:\d{2} [AP]M – \d{1,2}:\d{2} [AP]M/);
    expect(multiDay?.dateRange).toMatch(
      /\w+ \d+, \d{1,2}:\d{2} [AP]M – \w+ \d+, \d{1,2}:\d{2} [AP]M/,
    );
    expect(startOnly?.dateRange).toMatch(/^Starts \w+ \d+, \d{1,2}:\d{2} [AP]M$/);
    expect(unspecific?.dateRange).toBe("Planned Service Adjustment");
  });

  it("omits redundant reason when description matches title or is missing", () => {
    const [withReason, withoutReason, withDuplicateReason] = formatClosures([
      makeAgencyAlert({
        id: "a",
        lifecycle: "upcoming",
        startsAt: 0,
        title: "Line 1 nightly work",
        description: "Shuttle buses operate",
      }),
      makeAgencyAlert({
        id: "b",
        lifecycle: "upcoming",
        startsAt: 0,
        title: "Line 2 weekend work",
        description: undefined,
      }),
      makeAgencyAlert({
        id: "c",
        lifecycle: "upcoming",
        startsAt: 0,
        title: "Line 2 weekend work",
        description: "Line 2 weekend work",
      }),
    ]);

    expect(withReason?.reason).toBe("Shuttle buses operate");
    expect(withReason?.dateRange).toBe("Planned Service Adjustment");
    expect(withoutReason?.reason).toBeUndefined();
    expect(withDuplicateReason?.reason).toBeUndefined();
  });

  it("uses the canonical display names carried by structured station references", () => {
    const [closure] = formatClosures(
      [
        makeAgencyAlert({
          id: "stop-id-closure",
          lifecycle: "upcoming",
          fromStation: { stationId: "broadview", stationName: "Broadview" },
          toStation: { stationId: "st-george", stationName: "St. George" },
          title: "Planned closure",
        }),
      ],
      defaultSchematic,
    );

    expect(closure?.segment).toBe("Broadview to St. George");
  });

  it("resolves line name and color from provider schematic when provided", () => {
    const schematic = {
      viewBoxWidth: 100,
      viewBoxHeight: 100,
      lines: [{ id: "LW", name: "Lakeshore West", color: "#8D0134", points: [] }],
      stations: [],
      viewport: { bounds: { minX: 0, maxX: 100, minY: 0, maxY: 100 }, minZoom: 0.5, maxZoom: 4 },
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

    const [alert] = formatAlerts(
      [makeAgencyAlert({ id: "go-alert", affectedLineIds: ["LW"] })],
      schematic,
    );
    expect(alert?.lineName).toBe("Lakeshore West");
    expect(alert?.lineColor).toBe("#8D0134");

    const [closure] = formatClosures(
      [makeAgencyAlert({ id: "go-upcoming", lifecycle: "upcoming", affectedLineIds: ["LW"] })],
      schematic,
    );
    expect(closure?.lineName).toBe("Lakeshore West");
    expect(closure?.lineColor).toBe("#8D0134");
  });
});

describe("compareByFavouriteLine", () => {
  // Sign-class assertions only: a valid comparator may return any negative or
  // positive magnitude, Array.sort only consumes the sign.
  const byFavourite = compareByFavouriteLine([{ agencyId: "ttc", lineId: "2" }], "ttc");

  it.each([
    ["favourited line outranks an unfavourited line", { lineId: "2" }, { lineId: "4" }, -1],
    ["unfavourited line falls behind a favourited line", { lineId: "4" }, { lineId: "2" }, 1],
    ["alert with no lineId counts as a non-favourite", { lineId: undefined }, { lineId: "2" }, 1],
    ["two favourites tie", { lineId: "2" }, { lineId: "2" }, 0],
    ["two non-favourites tie regardless of line", { lineId: "1" }, { lineId: "4" }, 0],
    ["no lineId ties with any non-favourite", { lineId: undefined }, { lineId: "1" }, 0],
  ] as const)("%s", (_label, a, b, expectedRank) => {
    expect(Math.sign(byFavourite(a, b))).toBe(expectedRank);
  });
});
