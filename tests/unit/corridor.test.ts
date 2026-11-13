import { describe, expect, it } from "vitest";
import {
  calculateStopsAway,
  findClosestApproachingVehicle,
  findNearestStopIndex,
  findVehicleStopIndex,
  indexVehicleStops,
  orderStopsAlongCorridor,
  resolveStopIndex,
} from "~/domain/surface/corridor/index";
import { canonicalRouteId, routeIdsMatch } from "~/domain/surface/routeIds";

/**
 * Corridor geometry pins.
 *
 * Canonical home for stop-index resolution, vehicle indexing, corridor
 * ordering, and closest-vehicle selection. Migrated from route-facts.test.ts
 * (resolveStopIndex, findClosestApproachingVehicle, orderStopsAlongCorridor,
 * indexVehicleStops) and route-tracking-helpers.test.ts
 * (findNearestStopIndex, findVehicleStopIndex, calculateStopsAway) — no
 * behavior is asserted in more than one file.
 */

describe("findNearestStopIndex & findVehicleStopIndex", () => {
  const sampleStops = [
    { id: "1001", name: "Stop 1", lat: 43.65, lon: -79.38 },
    { id: "1002", name: "Stop 2", lat: 43.66, lon: -79.39 },
    { id: "1003", name: "Stop 3", lat: 43.67, lon: -79.4 },
  ];

  it("finds the nearest stop by geographic proximity", () => {
    const idx = findNearestStopIndex(43.661, -79.391, sampleStops);
    expect(idx).toBe(1);
  });

  it("breaks an exact distance tie by keeping the earlier stop (first wins)", () => {
    const tiedStops = [
      { id: "west", name: "West stop", lat: 43.65, lon: -79.3801 },
      { id: "east", name: "East stop", lat: 43.65, lon: -79.3799 },
    ];
    expect(findNearestStopIndex(43.65, -79.38, tiedStops)).toBe(0);
    expect(findNearestStopIndex(43.65, -79.38, [...tiedStops].reverse())).toBe(0);
  });

  it("resolves vehicle stop index using currentStopSequence", () => {
    const v = { currentStopSequence: 3, latitude: 0, longitude: 0 };
    expect(findVehicleStopIndex(v, sampleStops)).toBe(2);
  });

  it("resolves vehicle stop index using stopId match", () => {
    const v = { stopId: "1002", latitude: 0, longitude: 0 };
    expect(findVehicleStopIndex(v, sampleStops)).toBe(1);
  });

  it("treats currentStopSequence of 1 as unset and resolves geographically instead", () => {
    const v = { currentStopSequence: 1, latitude: 43.6705, longitude: -79.4005 };
    expect(findVehicleStopIndex(v, sampleStops)).toBe(2);
  });

  it("keeps exact sequence snapping above 1 even when geo disagrees", () => {
    const v = { currentStopSequence: 2, latitude: 43.6705, longitude: -79.4005 };
    expect(findVehicleStopIndex(v, sampleStops)).toBe(1);
  });
});

describe("calculateStopsAway", () => {
  it("calculates stops away accurately between vehicle and boarding stop", () => {
    expect(calculateStopsAway(1, 3)).toBe(2);
    expect(calculateStopsAway(3, 3)).toBe(0);
    expect(calculateStopsAway(4, 2)).toBe(-2);
  });
});

describe("resolveStopIndex", () => {
  const stops = [
    { id: "s1", code: "1001", lat: 43.65, lon: -79.38 },
    { id: "s2", code: "1002", lat: 43.66, lon: -79.39 },
    { id: "s3", code: "1003", lat: 43.67, lon: -79.4 },
  ];

  it("resolves by exact stop id first", () => {
    expect(resolveStopIndex({ id: "s2" }, stops)).toBe(1);
  });

  it("falls back to stop code when the id does not match", () => {
    expect(resolveStopIndex({ id: "missing", code: "1003" }, stops)).toBe(2);
  });

  it("falls back to geo-nearest when neither id nor code matches", () => {
    // Closest to s1's coordinates
    expect(resolveStopIndex({ lat: 43.6501, lon: -79.3801 }, stops)).toBe(0);
  });

  it("returns -1 when nothing can be resolved", () => {
    expect(resolveStopIndex({}, stops)).toBe(-1);
  });
});

describe("findClosestApproachingVehicle", () => {
  const stops = [
    { id: "s1", lat: 43.65, lon: -79.38 },
    { id: "s2", lat: 43.66, lon: -79.39 },
    { id: "s3", lat: 43.67, lon: -79.4 },
  ];
  const at = (id: string) => ({ stopId: id, latitude: 0, longitude: 0 });

  it("picks the approaching vehicle with the fewest stops away", () => {
    const result = findClosestApproachingVehicle([at("s1"), at("s2")], stops, 2);
    expect(result?.vehicle.stopId).toBe("s2");
    expect(result?.stopIndex).toBe(1);
    expect(result?.stopsAway).toBe(1);
  });

  it("ignores vehicles that already passed the rider stop when others approach", () => {
    const result = findClosestApproachingVehicle([at("s3"), at("s1")], stops, 1);
    expect(result?.vehicle.stopId).toBe("s1");
    expect(result?.stopIndex).toBe(0);
    expect(result?.stopsAway).toBe(1);
  });

  it("falls back to the first vehicle with its real (negative) distance when none approach", () => {
    const result = findClosestApproachingVehicle([at("s3")], stops, 0);
    expect(result?.vehicle.stopId).toBe("s3");
    expect(result?.stopIndex).toBe(2);
    expect(result?.stopsAway).toBe(-2);
  });

  it("returns null for an empty vehicle list", () => {
    expect(findClosestApproachingVehicle([], stops, 0)).toBeNull();
  });

  it("returns null when the rider stop index is unresolvable", () => {
    expect(findClosestApproachingVehicle([at("s1")], stops, -1)).toBeNull();
  });
});

describe("orderStopsAlongCorridor", () => {
  it("passes through up to two stops, reversed for direction 1", () => {
    const stops = [
      { id: "a", lat: 0, lon: 1 },
      { id: "b", lat: 0, lon: 0 },
    ];
    expect(orderStopsAlongCorridor(stops, 0)).toEqual(stops);
    expect(orderStopsAlongCorridor(stops, 0)).not.toBe(stops);
    expect(orderStopsAlongCorridor(stops, 1).map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("orders an east-west corridor west-to-east for direction 0", () => {
    const stops = [
      { id: "a", lat: 0, lon: 2 },
      { id: "b", lat: 0, lon: 0 },
      { id: "c", lat: 0, lon: 1 },
    ];
    expect(orderStopsAlongCorridor(stops, 0).map((s) => s.id)).toEqual(["b", "c", "a"]);
  });

  it("reverses the corridor order for direction 1", () => {
    const stops = [
      { id: "a", lat: 0, lon: 2 },
      { id: "b", lat: 0, lon: 0 },
      { id: "c", lat: 0, lon: 1 },
    ];
    expect(orderStopsAlongCorridor(stops, 1).map((s) => s.id)).toEqual(["a", "c", "b"]);
  });

  it("orders a north-south corridor south-to-north for direction 0", () => {
    const stops = [
      { id: "n", lat: 2, lon: 0 },
      { id: "s", lat: 0, lon: 0 },
      { id: "m", lat: 1, lon: 0 },
    ];
    expect(orderStopsAlongCorridor(stops, 0).map((s) => s.id)).toEqual(["s", "m", "n"]);
  });
});

describe("indexVehicleStops", () => {
  const stops = [
    { id: "s1", lat: 0, lon: 0 },
    { id: "s2", lat: 0, lon: 1 },
    { id: "s3", lat: 0, lon: 2 },
  ];

  it("resolves every vehicle to its corridor stop once", () => {
    const indices = indexVehicleStops(
      [
        { vehicleId: "v1", currentStopSequence: 2, latitude: 9, longitude: 9 },
        { vehicleId: "v2", stopId: "s3", latitude: 9, longitude: 9 },
      ],
      stops,
    );

    expect(indices.size).toBe(2);
    expect(indices.get("v1")).toBe(1);
    expect(indices.get("v2")).toBe(2);
  });
});

describe("canonical realtime route IDs", () => {
  const routes = [
    { routeId: "LW", shortName: "LW" },
    { routeId: "BR", shortName: "BR" },
  ];

  it("maps versioned GTFS IDs to the stable static route ID", () => {
    expect(canonicalRouteId("06260926-LW", routes)).toBe("LW");
  });

  it("matches versioned feed IDs to a station line designator", () => {
    expect(routeIdsMatch("06260926-BR", "BR")).toBe(true);
  });
});
