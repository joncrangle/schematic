import { describe, expect, it } from "vitest";
import {
  excludeByIds,
  isCoLocatedService,
  NEARBY_BUCKET_METERS,
  nearbyBucket,
  routeArrivalEqual,
  sortFavouritesByAgency,
  sortNearbyByRanking,
  stationArrivalEqual,
} from "~/domain/nearbyStability";
import type {
  NearbyDirectionInfo,
  NearbyRouteArrival,
  NearbyStationArrival,
} from "~/domain/surface/types";
import type { AgencyAlert } from "~/agencies/types";

function alertFixture(id: string, updatedAt: number): AgencyAlert {
  return {
    id,
    kind: "delay",
    severity: "normal",
    lifecycle: "active",
    scope: "network",
    title: "Delay on route",
    startsAt: 1_000,
    updatedAt,
  };
}

function routeFixture(): NearbyRouteArrival {
  return {
    id: "21-0-1234",
    routeId: "21",
    routeShortName: "21",
    routeLongName: "Crosstown",
    routeType: "bus",
    agencyId: "sample",
    directionId: 0,
    headsign: "Eastbound",
    stopId: "1234",
    stopName: "Main St at First Ave",
    stopLat: 43.67,
    stopLon: -79.38,
    distanceMeters: 120,
    walkingMinutes: 2,
    arrivals: [1_000, 2_000, 3_000],
    directions: [
      {
        directionId: 0,
        headsign: "Eastbound",
        label: "Eastbound",
        destination: "Northgate",
        stopId: "1234",
        stopName: "Main St at First Ave",
        stopLat: 43.67,
        stopLon: -79.38,
        distanceMeters: 120,
        walkingMinutes: 2,
        arrivals: [1_000, 2_000],
      },
    ],
    alerts: [alertFixture("alert-1", 100)],
  };
}

function stationFixture(): NearbyStationArrival {
  return {
    id: "99999",
    stationName: "Central",
    lineIds: ["1", "2"],
    agencyId: "sample",
    distanceMeters: 320,
    walkingMinutes: 4,
    arrivals: [
      { directionId: 1, label: "Southbound", times: [5_000, 6_000] },
      { directionId: 0, label: "Northbound", times: [7_000] },
    ],
  };
}

describe("routeArrivalEqual", () => {
  it("treats fresh-but-field-identical payloads as equal", () => {
    expect(routeArrivalEqual(routeFixture(), structuredClone(routeFixture()))).toBe(true);
  });

  // One changed value per NearbyRouteArrival key. `satisfies` turns a new
  // interface field into a type error until it is listed here, and the cases
  // below then require the comparator to notice a change to it.
  const routeFieldChanges = {
    id: "other-id",
    routeId: "300",
    routeShortName: "21A",
    routeLongName: "Different long name",
    routeType: "streetcar",
    agencyId: "regional",
    directionId: 1,
    headsign: "Westbound",
    stopId: "9999",
    stopName: "Other Stop",
    stopLat: 43.8,
    stopLon: -79.5,
    distanceMeters: 121,
    walkingMinutes: 3,
    arrivals: [],
    directions: undefined,
    alerts: [],
    arrivalsStale: true,
    routeColor: "#0066cc",
    routeTextColor: "#ffffff",
  } satisfies Record<keyof NearbyRouteArrival, unknown>;

  it.each(Object.entries(routeFieldChanges))(
    "breaks equality when the $0 field changes",
    (field, value) => {
      const base = routeFixture();
      const changed = { ...base, [field]: value } as NearbyRouteArrival;
      expect(routeArrivalEqual(base, changed)).toBe(false);
    },
  );

  it("compares arrival timestamps elementwise, not just by count", () => {
    const retimed = { ...routeFixture(), arrivals: [1_000, 2_000, 3_500] };
    expect(routeArrivalEqual(routeFixture(), retimed)).toBe(false);
  });

  it("compares directions elementwise including their nested arrivals", () => {
    const base = routeFixture();
    const firstDirection = base.directions![0]!;

    expect(
      routeArrivalEqual(base, {
        ...base,
        directions: [structuredClone(firstDirection)],
      }),
    ).toBe(true);
    expect(
      routeArrivalEqual(base, { ...base, directions: [{ ...firstDirection, label: "Westbound" }] }),
    ).toBe(false);
    expect(
      routeArrivalEqual(base, {
        ...base,
        directions: [{ ...firstDirection, arrivals: [1_000, 2_500] }],
      }),
    ).toBe(false);
  });

  // One changed value per NearbyDirectionInfo key, compared through the route
  // card that holds the direction. See the route table above.
  const directionFieldChanges = {
    directionId: 1,
    headsign: "Westbound",
    label: "Westbound",
    generatedLabel: "westbound",
    destination: "Eastern Terminal",
    directionInferred: true,
    stopId: "9999",
    stopName: "Other Stop",
    stopLat: 43.8,
    stopLon: -79.5,
    distanceMeters: 121,
    walkingMinutes: 3,
    arrivals: [1_000],
  } satisfies Record<keyof NearbyDirectionInfo, unknown>;

  it.each(Object.entries(directionFieldChanges))(
    "breaks equality when a direction's $0 field changes",
    (field, value) => {
      const base = routeFixture();
      const changed = {
        ...base,
        directions: [{ ...base.directions![0]!, [field]: value } as NearbyDirectionInfo],
      };
      expect(routeArrivalEqual(base, changed)).toBe(false);
    },
  );

  it("does not equate absent directions with present ones", () => {
    const bare = { ...routeFixture(), directions: undefined };
    expect(routeArrivalEqual(routeFixture(), bare)).toBe(false);
  });

  it("compares alerts elementwise on content — count alone never suffices", () => {
    const base = routeFixture();

    // Same content, newer fetch-clock stamp: a re-poll, not a change, so the
    // card keeps its identity (decoders stamp updatedAt from the fetch clock
    // when the wire carries no timestamp).
    const restamped = { ...base, alerts: [alertFixture("alert-1", 200)] };
    expect(routeArrivalEqual(base, restamped)).toBe(true);

    // Same id and stamp but changed content: a real update.
    const edited = {
      ...base,
      alerts: [{ ...alertFixture("alert-1", 100), title: "Different title" }],
    };
    expect(routeArrivalEqual(base, edited)).toBe(false);

    // Different alert id entirely.
    const replaced = { ...base, alerts: [alertFixture("alert-2", 100)] };
    expect(routeArrivalEqual(base, replaced)).toBe(false);

    // Count changed.
    const extra = { ...base, alerts: [...base.alerts, alertFixture("alert-2", 300)] };
    expect(routeArrivalEqual(base, extra)).toBe(false);
  });
});

describe("stationArrivalEqual", () => {
  it("treats fresh-but-field-identical payloads as equal", () => {
    expect(stationArrivalEqual(stationFixture(), structuredClone(stationFixture()))).toBe(true);
  });

  // One changed value per NearbyStationArrival key; see the route table above.
  const stationFieldChanges = {
    livePredictionsOnly: true,
    trackingRouteId: "1-tracking",
    id: "99998",
    stationName: "Harbour",
    lineIds: ["1"],
    lineName: "Main Line",
    agencyId: "regional",
    routeType: "subway",
    lat: 43.6,
    lon: -79.3,
    distanceMeters: 340,
    walkingMinutes: 5,
    arrivals: [],
    arrivalsStale: true,
  } satisfies Record<keyof NearbyStationArrival, unknown>;

  it.each(Object.entries(stationFieldChanges))(
    "breaks equality when the $0 field changes",
    (field, value) => {
      const base = stationFixture();
      const changed = { ...base, [field]: value } as NearbyStationArrival;
      expect(stationArrivalEqual(base, changed)).toBe(false);
    },
  );

  it.each([
    ["lineId", "2"],
    ["generatedLabel", "southbound"],
  ] as const)("breaks equality when a direction group's $0 changes", (field, value) => {
    const base = stationFixture();
    const [first, ...rest] = base.arrivals;
    const changed = {
      ...base,
      arrivals: [{ ...first!, [field]: value }, ...rest],
    } as NearbyStationArrival;
    expect(stationArrivalEqual(base, changed)).toBe(false);
  });

  it("compares lineIds elementwise", () => {
    const fewerLines = { ...stationFixture(), lineIds: ["1"] };
    expect(stationArrivalEqual(stationFixture(), fewerLines)).toBe(false);
  });

  it("compares direction groups elementwise", () => {
    const relabelled = {
      ...stationFixture(),
      arrivals: [
        { directionId: 1 as const, label: "Northbound", times: [5_000, 6_000] },
        stationFixture().arrivals[1]!,
      ],
    };
    expect(stationArrivalEqual(stationFixture(), relabelled)).toBe(false);
  });

  it("compares group departure times elementwise", () => {
    const retimed = {
      ...stationFixture(),
      arrivals: [
        { directionId: 1 as const, label: "Southbound", times: [5_001, 6_000] },
        ...stationFixture().arrivals.slice(1),
      ],
    };
    expect(stationArrivalEqual(stationFixture(), retimed)).toBe(false);
  });
});

describe("excludeByIds", () => {
  it("drops items whose key is in the set and keeps the rest in order with identity intact", () => {
    const a = { key: "a" };
    const b = { key: "b" };
    const c = { key: "c" };

    const result = excludeByIds([a, b, c], new Set(["b"]), (item) => item.key);

    expect(result).toEqual([a, c]);
    expect(result[0]).toBe(a);
    expect(result[1]).toBe(c);
  });

  it("keeps everything when no key matches", () => {
    const items = [{ key: "a" }, { key: "b" }];
    expect(excludeByIds(items, new Set(["z"]), (item) => item.key)).toEqual(items);
  });
});

describe("isCoLocatedService", () => {
  const baseStation: NearbyStationArrival = {
    id: "station-1",
    stationName: "Test Station",
    lineIds: ["31"],
    agencyId: "sample",
    routeType: "bus",
    lat: 43.9436,
    lon: -78.8955,
    distanceMeters: 0,
    walkingMinutes: 0,
    arrivals: [],
  };

  const baseRoute: NearbyRouteArrival = {
    id: "31-0-1234",
    routeId: "31",
    routeShortName: "31",
    routeLongName: "Crosstown Express",
    routeType: "bus",
    agencyId: "sample",
    directionId: 0,
    headsign: "Southbound",
    stopId: "1234",
    stopName: "Grand Ave @ Mill Rd",
    stopLat: 43.942,
    stopLon: -78.896,
    distanceMeters: 200,
    walkingMinutes: 2,
    arrivals: [],
    alerts: [],
  };

  it("matches bus stations and routes within 350m for the same line", () => {
    expect(isCoLocatedService(baseStation, baseRoute)).toBe(true);
  });

  it("rejects bus stations and routes beyond 350m", () => {
    const distantRoute: NearbyRouteArrival = {
      ...baseRoute,
      stopLat: 43.93,
      stopLon: -78.89,
    };
    expect(isCoLocatedService(baseStation, distantRoute)).toBe(false);
  });

  it("matches rail services within 150m and rejects beyond 150m", () => {
    const railStation: NearbyStationArrival = {
      ...baseStation,
      agencyId: "regional",
      lineIds: ["EL"],
      routeType: "rail",
      lat: 43.67,
      lon: -79.38,
    };
    const nearRailRoute: NearbyRouteArrival = {
      ...baseRoute,
      agencyId: "regional",
      routeId: "EL",
      routeType: "rail",
      stopLat: 43.67,
      stopLon: -79.38 + 0.0011, // ~88m
    };
    const farRailRoute: NearbyRouteArrival = {
      ...baseRoute,
      agencyId: "regional",
      routeId: "EL",
      routeType: "rail",
      stopLat: 43.67,
      stopLon: -79.38 + 0.002, // ~161m
    };
    expect(isCoLocatedService(railStation, nearRailRoute)).toBe(true);
    expect(isCoLocatedService(railStation, farRailRoute)).toBe(false);
  });

  it("does not collapse multi-line interchange stations into a single route", () => {
    const multiLineStation: NearbyStationArrival = {
      ...baseStation,
      lineIds: ["32", "31"],
    };
    expect(isCoLocatedService(multiLineStation, baseRoute)).toBe(false);
  });

  it("rejects when agencyId differs", () => {
    expect(isCoLocatedService({ ...baseStation, agencyId: "metro" }, baseRoute)).toBe(false);
  });

  it("rejects when routeId does not match station lineIds", () => {
    expect(isCoLocatedService(baseStation, { ...baseRoute, routeId: "33" })).toBe(false);
  });
});

function rankingRoute(
  routeId: string,
  agencyId: string,
  meters: number,
  routeType: NearbyRouteArrival["routeType"] = "bus",
): NearbyRouteArrival {
  return {
    id: routeId,
    routeId,
    routeShortName: routeId,
    routeLongName: `Route ${routeId}`,
    routeType,
    agencyId,
    directionId: 0,
    headsign: "Eastbound",
    stopId: `${routeId}-stop`,
    stopName: `${routeId} Stop`,
    stopLat: 43.67,
    stopLon: -79.38,
    distanceMeters: meters,
    walkingMinutes: 1,
    arrivals: [],
    alerts: [],
  };
}

function rankingStation(id: string, agencyId: string, meters: number): NearbyStationArrival {
  return {
    id,
    stationName: `Station ${id}`,
    lineIds: ["1"],
    agencyId,
    distanceMeters: meters,
    walkingMinutes: 1,
    arrivals: [],
  };
}

describe("nearbyBucket", () => {
  it("uses 75 m buckets", () => {
    expect(NEARBY_BUCKET_METERS).toBe(75);
  });

  it.each([
    [0, 0],
    [74, 0],
    [75, 1],
    [149, 1],
    [150, 2],
    [250, 3],
    [500, 6],
  ])("maps %i m → bucket %i", (meters, bucket) => {
    expect(nearbyBucket(meters)).toBe(bucket);
  });
});

describe("sortNearbyByRanking", () => {
  it("clusters distances within the same 75 m bucket via tier priority", () => {
    const sampleStation = rankingStation("harbour-sample", "sample", 35);
    const otherStation = rankingStation("harbour-regional", "regional", 15);
    const sorted = sortNearbyByRanking([otherStation, sampleStation], "sample");
    expect(
      sorted.map((i) =>
        "stationName" in i ? (i as NearbyStationArrival).id : (i as NearbyRouteArrival).routeId,
      ),
    ).toEqual(["harbour-sample", "harbour-regional"]);
  });

  it("preserves strict distance order across different buckets", () => {
    const lakesideStation = rankingStation("lakeside", "sample", 0);
    const firstRoute = rankingRoute("11", "sample", 20);
    const secondRoute = rankingRoute("12", "sample", 250);
    const otherHarbour = rankingStation("harbour-regional", "regional", 500);
    const sorted = sortNearbyByRanking(
      [otherHarbour, secondRoute, firstRoute, lakesideStation],
      "sample",
    );
    expect(
      sorted.map((i) =>
        "stationName" in i ? (i as NearbyStationArrival).id : (i as NearbyRouteArrival).routeId,
      ),
    ).toEqual(["lakeside", "11", "12", "harbour-regional"]);
  });

  it("gives selected agency stations (tier 1) priority over selected surface routes (tier 2) within the same bucket", () => {
    const sampleStation = rankingStation("central", "sample", 30);
    const sampleRoute = rankingRoute("21", "sample", 10);
    const sorted = sortNearbyByRanking([sampleRoute, sampleStation], "sample");
    expect(sorted[0]).toBe(sampleStation);
  });

  it("gives other-agency rail the same tier as other-agency stations (tier 3) ahead of other-agency buses (tier 4)", () => {
    const otherRail = rankingRoute("RL", "regional", 20, "rail");
    const otherBus = rankingRoute("41", "regional", 10, "bus");
    const otherStation = rankingStation("regional-harbour", "regional", 30);
    const sorted = sortNearbyByRanking([otherBus, otherRail, otherStation], "sample");
    expect(
      sorted
        .map((i) =>
          "stationName" in i
            ? (i as NearbyStationArrival).stationName
            : (i as NearbyRouteArrival).routeId,
        )
        .slice(0, 2),
    ).toEqual(expect.arrayContaining(["RL", "Station regional-harbour"]));
    expect((sorted[2] as NearbyRouteArrival).routeId).toBe("41");
    expect(sorted[0]).toEqual(expect.objectContaining({ distanceMeters: 20 }));
  });

  it("flips priority when the selected agency changes — the other agency leads", () => {
    const sampleStation = rankingStation("harbour-sample", "sample", 15);
    const otherRail = rankingRoute("RL", "regional", 35, "rail");
    const withSample = sortNearbyByRanking([otherRail, sampleStation], "sample");
    expect((withSample[0] as NearbyStationArrival).id).toBe("harbour-sample");
    const withOther = sortNearbyByRanking([otherRail, sampleStation], "regional");
    expect((withOther[0] as NearbyRouteArrival).routeId).toBe("RL");
  });

  it("breaks ties within tier by raw distance then stable identity", () => {
    const a = rankingRoute("21", "sample", 20);
    const b = rankingRoute("22", "sample", 20);
    const sorted = sortNearbyByRanking([b, a], "sample");
    expect(sorted.map((r) => (r as NearbyRouteArrival).routeId)).toEqual(["21", "22"]);
  });

  it("does not mutate the input array", () => {
    const one = rankingStation("a", "sample", 10);
    const two = rankingRoute("1", "regional", 10);
    const input = [two, one];
    const out = sortNearbyByRanking(input, "sample");
    expect(input).toEqual([two, one]);
    expect(out).not.toBe(input);
  });
});

describe("sortFavouritesByAgency", () => {
  it("lists selected agency favourites first, then nearest within each group", () => {
    const favs = [
      rankingRoute("41", "regional", 200, "bus"),
      rankingRoute("21", "sample", 300),
      rankingRoute("22", "sample", 100),
      rankingRoute("RL", "regional", 50, "rail"),
    ];
    const sorted = sortFavouritesByAgency(favs, "sample");
    expect(sorted.map((r) => (r as NearbyRouteArrival).routeId)).toEqual(["22", "21", "RL", "41"]);
  });

  it("works for stations as well", () => {
    const favs = [
      rankingStation("regional-1", "regional", 50),
      rankingStation("sample-1", "sample", 300),
      rankingStation("sample-2", "sample", 100),
    ];
    const sorted = sortFavouritesByAgency(favs, "sample");
    expect(sorted.map((s) => (s as NearbyStationArrival).id)).toEqual([
      "sample-2",
      "sample-1",
      "regional-1",
    ]);
  });
});
