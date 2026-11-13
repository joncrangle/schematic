import { describe, expect, it } from "vitest";
import { Effect, Option } from "effect";
import { SurfaceDataStore } from "~/infrastructure/storage/SurfaceDataStore";
import { createMemorySurfaceDataStore } from "~/infrastructure/storage/memorySurfaceDataStore";

import {
  MOCK_SURFACE_STOPS,
  MOCK_SURFACE_ROUTES,
  MOCK_ROUTE_SHAPES,
  MOCK_ROUTE_STOPS,
} from "../helpers/mockSurfaceData";
import type { RouteDetails } from "~/domain/surface/types";
import { mapRowToStop, type SqliteStopRow } from "~/infrastructure/storage/surfaceRowMappers";

// SurfaceDataStore reads are structurally write-free: this suite pins
// the memory-backed stored-topology reads. Lazy fetch/revalidate/repair
// behaviors left with the deleted read-policy kernel — a miss is a legitimate
// empty, and topology repair belongs to the explicit writer seam. D1 failure
// and writer behavior live in the integration tier.

describe("SurfaceDataStore (Seam 1: Storage & Spatial Queries)", () => {
  const dataStoreLayer = createMemorySurfaceDataStore({
    stops: MOCK_SURFACE_STOPS,
    shapes: MOCK_ROUTE_SHAPES,
    routes: MOCK_SURFACE_ROUTES,
    routeStops: MOCK_ROUTE_STOPS,
  });

  it("finds stops within bounding box and sorts by distance", async () => {
    const program = Effect.gen(function* () {
      const store = yield* SurfaceDataStore;
      // Search from near Bloor-Yonge: 43.6709, -79.3857 (radius 500m)
      const nearby = yield* store.findNearbyStops(43.6709, -79.3857, 500);
      return nearby;
    }).pipe(Effect.provide(dataStoreLayer));

    const results = await Effect.runPromise(program);

    expect(results.length).toBe(1);
    expect(results[0].stop.id).toBe("14560");
    expect(results[0].stop.name).toBe("Yonge St at Bloor St East");
    expect(results[0].distanceMeters).toBeGreaterThan(0);
    expect(results[0].distanceMeters).toBeLessThan(500);
    expect(results[0].walkingMinutes).toBe(1);
  });

  it("filters out stops beyond the specified radius", async () => {
    const program = Effect.gen(function* () {
      const store = yield* SurfaceDataStore;
      // Search from Roncesvalles/Queen: 43.6395, -79.4465 (radius 300m)
      // Two stops at exact same coords: 14591 (501 Queen) + 14610 (504 King)
      const nearby = yield* store.findNearbyStops(43.6395, -79.4465, 300);
      return nearby;
    }).pipe(Effect.provide(dataStoreLayer));

    const results = await Effect.runPromise(program);

    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0].stop.id).toBe("14591"); // Queen St West at Roncesvalles Ave
  });

  it("retrieves route details including shape and stop sequence", async () => {
    const program = Effect.gen(function* () {
      const store = yield* SurfaceDataStore;
      return yield* store.getRouteDetails("506", 0);
    }).pipe(Effect.provide(dataStoreLayer));

    const result = await Effect.runPromise(program);

    expect(Option.isSome(result)).toBe(true);
    const details: RouteDetails = Option.getOrThrow(result);
    expect(details.route.id).toBe("506");
    expect(details.route.longName).toBe("Carlton");
    expect(details.shape.routeId).toBe("506");
    expect(details.stops.length).toBeGreaterThanOrEqual(1);
  });

  it("returns Option.none for unknown route or direction", async () => {
    const program = Effect.gen(function* () {
      const store = yield* SurfaceDataStore;
      return yield* store.getRouteDetails("999", 0);
    }).pipe(Effect.provide(dataStoreLayer));

    const result = await Effect.runPromise(program);
    expect(Option.isNone(result)).toBe(true);
  });

  it("retrieves all routes from the memory storage layer", async () => {
    const program = Effect.gen(function* () {
      const store = yield* SurfaceDataStore;
      return yield* store.getAllRoutes();
    }).pipe(Effect.provide(dataStoreLayer));

    const routes = await Effect.runPromise(program);
    expect(routes.length).toBe(MOCK_SURFACE_ROUTES.length);
    expect(routes.some((r) => r.id === "504")).toBe(true);
  });
});

describe("surface row station identity adapter", () => {
  const baseRow: SqliteStopRow = {
    id: "stop-1",
    code: "stop-1",
    name: "Bathurst Station Loop",
    lat: 43.666447,
    lon: -79.411186,
    wheelchair: 1,
    parent_station: "99962",
    routes_json: '["504"]',
  };

  it("maps the feed parent id to canonical display and schematic identities", () => {
    const stop = mapRowToStop(baseRow, [
      {
        id: "99962",
        schematicId: "bathurst",
        name: "Bathurst",
        lat: 43.666447,
        lon: -79.411186,
        lines: ["2"],
        platformIds: ["13759"],
      },
    ]);

    expect(stop).toMatchObject({
      parentStation: "Bathurst",
      parentStationId: "bathurst",
    });
  });

  it("does not infer a schematic identity from an unmatched feed value", () => {
    const stop = mapRowToStop({ ...baseRow, parent_station: "Bathurst" }, [
      {
        id: "99962",
        schematicId: "bathurst",
        name: "Bathurst",
        lat: 43.666447,
        lon: -79.411186,
        lines: ["2"],
        platformIds: ["13759"],
      },
    ]);

    expect(stop.parentStation).toBe("Bathurst");
    expect(stop.parentStationId).toBeUndefined();
  });
});
