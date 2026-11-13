import { describe, expect, it } from "vitest";
import {
  filterStationAlerts,
  getStationServiceAlertGroups,
  getStationOverallStatus,
  resolveAgencyStationReference,
  resolveSchematicStationIdFromFeedId,
  resolveStationNameFromId,
} from "~/domain/stationAlerts";

const stationIndex = [
  {
    id: "feed-union",
    schematicId: "union",
    name: "Union",
    lat: 43.645,
    lon: -79.38,
    lines: ["1"],
    platformIds: ["feed-union-north", "feed-union-south"],
  },
] as const;

const maplessStationIndex = [
  {
    id: "feed-mapless",
    name: "Mapless Stop",
    lat: 43.65,
    lon: -79.38,
    lines: ["1"],
    platformIds: [],
  },
] as const;

describe("station identity resolution", () => {
  it("links feed and platform IDs to schematic IDs while retaining display names", () => {
    expect(resolveSchematicStationIdFromFeedId("feed-union", stationIndex)).toBe("union");
    expect(resolveSchematicStationIdFromFeedId("feed-union-south", stationIndex)).toBe("union");
    expect(resolveStationNameFromId("feed-union-south", stationIndex)).toBe("Union");
  });

  it("does not invent a schematic identity for an unmatched feed ID", () => {
    expect(resolveSchematicStationIdFromFeedId("unknown", stationIndex)).toBeUndefined();
  });

  it.each([
    ["feed-union", { stationId: "union", stationName: "Union" }],
    ["feed-union-south", { stationId: "union", stationName: "Union" }],
    ["Union", { stationId: "union", stationName: "Union" }],
    ["unknown stop", { stationName: "unknown stop" }],
  ] as const)("resolves %s into an explicit station reference", (value, expected) => {
    expect(resolveAgencyStationReference(value, { stationIndex })).toEqual(expected);
  });

  it("keeps an indexed feed-only station name-only when no schematic link exists", () => {
    expect(
      resolveAgencyStationReference("feed-mapless", { stationIndex: maplessStationIndex }),
    ).toEqual({ stationName: "Mapless Stop" });
  });

  it("falls back to an unambiguous name when an alias has no known target", () => {
    expect(
      resolveAgencyStationReference("Union", {
        stationIndex,
        stationAliases: { Union: "missing" },
      }),
    ).toEqual({ stationId: "union", stationName: "Union" });
  });

  it("resolves a configured alias only when its schematic target is unambiguous", () => {
    expect(
      resolveAgencyStationReference("Dundas", {
        stationAliases: { dundas: "tmu" },
        schematicStations: [{ id: "tmu", name: "TMU" }],
      }),
    ).toEqual({ stationId: "tmu", stationName: "TMU" });

    expect(
      resolveAgencyStationReference("Central", {
        schematicStations: [
          { id: "central-east", name: "Central" },
          { id: "central-west", name: "Central" },
        ],
      }),
    ).toEqual({ stationName: "Central" });
  });
});

describe("station status display", () => {
  it("filters a station by its targeted route instead of the alert-wide route union", () => {
    const alerts = [
      {
        id: "route-specific-station",
        scope: "station" as const,
        kind: "suspension" as const,
        severity: "severe" as const,
        lifecycle: "active" as const,
        affectedRouteIds: ["2", "7", "N1"],
        affectedStations: [{ stationId: "bus-terminal", stationName: "Bus Terminal" }],
        targets: [
          {
            routeId: "7",
            station: { stationId: "bus-terminal", stationName: "Bus Terminal" },
          },
        ],
        title: "Transit Alert",
        startsAt: 0,
        updatedAt: 0,
      },
    ];

    expect(filterStationAlerts(alerts, "bus-terminal", "Bus Terminal", ["2"])).toEqual([]);
  });

  it("includes a station identified only by a structured target", () => {
    const alerts = [
      {
        id: "target-only-station",
        scope: "station" as const,
        kind: "delay" as const,
        severity: "degraded" as const,
        lifecycle: "active" as const,
        affectedRouteIds: ["2"],
        targets: [
          {
            routeId: "2",
            station: { stationId: "bus-terminal", stationName: "Bus Terminal" },
          },
        ],
        title: "Service delay",
        startsAt: 0,
        updatedAt: 0,
      },
    ];

    expect(filterStationAlerts(alerts, "bus-terminal", "Bus Terminal", ["2"])).toHaveLength(1);
  });

  it("uses the matching target route when deriving a multi-line station status", () => {
    expect(
      getStationOverallStatus(
        [
          {
            id: "targeted-line-severe",
            scope: "station",
            kind: "suspension",
            severity: "severe",
            lifecycle: "active",
            affectedRouteIds: ["2", "7"],
            targets: [
              {
                routeId: "7",
                station: { stationId: "bus-terminal", stationName: "Bus Terminal" },
              },
            ],
            title: "Route 7 service suspended",
            startsAt: 0,
            updatedAt: 0,
          },
        ],
        ["2", "7"],
        "bus-terminal",
      ),
    ).toMatchObject({ text: "Service Delay" });
  });

  it("uses agency-neutral wording for severe station alerts", () => {
    expect(
      getStationOverallStatus([
        {
          id: "go-severe",
          scope: "network",
          kind: "delay",
          severity: "severe",
          lifecycle: "active",
          title: "GO train service suspended",
          startsAt: 0,
          updatedAt: 0,
        },
      ]),
    ).toMatchObject({ text: "No Service" });
  });

  it("reports Service Delay when only one line of a multi-line hub has a severe disruption", () => {
    expect(
      getStationOverallStatus(
        [
          {
            id: "line-2-severe",
            scope: "line",
            kind: "suspension",
            severity: "severe",
            lifecycle: "active",
            affectedLineIds: ["2"],
            title: "Line 2 service suspended",
            startsAt: 0,
            updatedAt: 0,
          },
        ],
        ["1", "2"],
      ),
    ).toMatchObject({ text: "Service Delay" });
  });

  it("reports No Service when all lines of a multi-line hub have severe disruptions", () => {
    expect(
      getStationOverallStatus(
        [
          {
            id: "line-1-severe",
            scope: "line",
            kind: "suspension",
            severity: "severe",
            lifecycle: "active",
            affectedLineIds: ["1"],
            title: "Line 1 service suspended",
            startsAt: 0,
            updatedAt: 0,
          },
          {
            id: "line-2-severe",
            scope: "line",
            kind: "suspension",
            severity: "severe",
            lifecycle: "active",
            affectedLineIds: ["2"],
            title: "Line 2 service suspended",
            startsAt: 0,
            updatedAt: 0,
          },
        ],
        ["1", "2"],
      ),
    ).toMatchObject({ text: "No Service" });
  });

  it("reports No Service for station-wide severe disruptions without line attribution", () => {
    expect(
      getStationOverallStatus(
        [
          {
            id: "station-evac",
            scope: "station",
            kind: "suspension",
            severity: "severe",
            lifecycle: "active",
            title: "Station closed due to emergency",
            startsAt: 0,
            updatedAt: 0,
          },
        ],
        ["1", "2"],
      ),
    ).toMatchObject({ text: "No Service" });
  });
});

describe("station service alert grouping", () => {
  it("collapses same-line directional advisories while preserving their details", () => {
    const alerts = [
      {
        id: "south-1",
        scope: "station" as const,
        kind: "slow-service" as const,
        severity: "degraded" as const,
        lifecycle: "active" as const,
        affectedLineIds: ["1"],
        affectedStations: [{ stationId: "union", stationName: "Union" }],
        title: "Line 1 Yonge-University: slower southbound from Wellesley to College",
        startsAt: 0,
        updatedAt: 10,
      },
      {
        id: "south-2",
        scope: "station" as const,
        kind: "slow-service" as const,
        severity: "degraded" as const,
        lifecycle: "active" as const,
        affectedLineIds: ["1"],
        affectedStations: [{ stationId: "union", stationName: "Union" }],
        title: "Line 1 Yonge-University: slower southbound from College to TMU",
        startsAt: 0,
        updatedAt: 20,
      },
      {
        id: "north-1",
        scope: "station" as const,
        kind: "slow-service" as const,
        severity: "degraded" as const,
        lifecycle: "active" as const,
        affectedLineIds: ["1"],
        affectedStations: [{ stationId: "union", stationName: "Union" }],
        title: "Line 1 Yonge-University: slower northbound from TMU to College",
        startsAt: 0,
        updatedAt: 30,
      },
    ];

    const groups = getStationServiceAlertGroups(alerts);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.alerts.map((alert) => alert.id)).toEqual(["north-1", "south-2", "south-1"]);
    expect(groups[0]?.representative.id).toBe("north-1");
  });
});

describe("station alert filtering", () => {
  it("matches schematic IDs first and uses names only for name-only references", () => {
    const alerts = [
      {
        id: "known",
        scope: "segment" as const,
        kind: "delay" as const,
        severity: "degraded" as const,
        lifecycle: "active" as const,
        fromStation: { stationId: "union", stationName: "Renamed Union" },
        title: "Known station alert",
        startsAt: 0,
        updatedAt: 0,
      },
      {
        id: "name-only",
        scope: "station" as const,
        kind: "accessibility" as const,
        severity: "normal" as const,
        lifecycle: "active" as const,
        affectedStations: [{ stationName: "Union" }],
        title: "Mapless station alert",
        startsAt: 0,
        updatedAt: 0,
      },
    ];

    expect(filterStationAlerts(alerts, "union", "Union").map((alert) => alert.id)).toEqual([
      "known",
      "name-only",
    ]);
    expect(filterStationAlerts(alerts, "other", "Union").map((alert) => alert.id)).toEqual([
      "name-only",
    ]);
  });

  it("excludes route-attributed alerts that do not intersect the station's lines", () => {
    const alerts = [
      {
        id: "streetcar-closure",
        scope: "station" as const,
        kind: "suspension" as const,
        severity: "severe" as const,
        lifecycle: "active" as const,
        affectedRouteIds: ["510"],
        affectedStations: [{ stationId: "union", stationName: "Union" }],
        title: "510 Spadina: No service between Queens Quay and Union",
        startsAt: 0,
        updatedAt: 0,
      },
      {
        id: "subway-delay",
        scope: "station" as const,
        kind: "delay" as const,
        severity: "degraded" as const,
        lifecycle: "active" as const,
        affectedLineIds: ["1"],
        affectedStations: [{ stationId: "union", stationName: "Union" }],
        title: "Line 1 delay at Union",
        startsAt: 0,
        updatedAt: 0,
      },
      {
        id: "station-elevator",
        scope: "station" as const,
        kind: "accessibility" as const,
        severity: "normal" as const,
        lifecycle: "active" as const,
        affectedRouteIds: ["510"],
        affectedStations: [{ stationId: "union", stationName: "Union" }],
        title: "Union elevator out of service",
        startsAt: 0,
        updatedAt: 0,
      },
    ];

    const result = filterStationAlerts(alerts, "union", "Union", ["1"]);
    expect(result.map((alert) => alert.id)).toEqual(["subway-delay", "station-elevator"]);
  });

  it.each([
    {
      name: "upcoming lifecycle",
      alert: { lifecycle: "upcoming" as const, kind: "suspension" as const },
    },
    { name: "upcoming kind", alert: { lifecycle: "active" as const, kind: "upcoming" as const } },
    {
      name: "expired lifecycle",
      alert: { lifecycle: "expired" as const, kind: "suspension" as const },
    },
  ])("excludes $name from station cards", ({ alert }) => {
    const alerts = [
      {
        id: "closure",
        scope: "station" as const,
        severity: "severe" as const,
        affectedLineIds: ["1"],
        affectedStations: [{ stationId: "union", stationName: "Union" }],
        title: "Closure at Union",
        startsAt: 0,
        updatedAt: 0,
        ...alert,
      },
    ];

    expect(filterStationAlerts(alerts, "union", "Union", ["1"])).toEqual([]);
  });
});
