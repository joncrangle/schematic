import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  bboxFor,
  clampProximityRadius,
  MAX_PROXIMITY_RADIUS_METERS,
  metersPerDegreeLat,
  metersPerDegreeLon,
} from "~/domain/proximity";
import { SurfaceDataStore } from "~/infrastructure/storage/SurfaceDataStore";
import { buildDataStoreService } from "~/infrastructure/storage/memorySurfaceDataStore";
import { createD1SurfaceDataStore } from "~/infrastructure/storage/d1SurfaceDataStore";
import type { D1DatabaseBinding } from "~/infrastructure/storage/RuntimeBindings";
import { withNoopBatch } from "../helpers/d1-binding";
import type { NearbyStopResult, SurfaceStop } from "~/domain/surface/types";

/**
 * Single source of truth for the 1.5 km nearby-search clamp (docs/development.md#nearby-search):
 * the constant and helper are the ONLY place the 1500 m ceiling lives, and
 * both storage adapters must clamp identically through them.
 */
describe("Proximity radius clamp single source of truth", () => {
  const QUERY = { lat: 43.65, lon: -79.38 };

  // Stop A sits ~556 m north of the query point (inside any radius);
  // Stop B sits ~1668 m north — only returned when the clamp is broken.
  const stopA: SurfaceStop = {
    id: "stop-a",
    code: "A",
    name: "Queen St West at Claremont",
    lat: 43.655,
    lon: -79.38,
    wheelchair: 1,
    routes: ["501"],
  };
  const stopB: SurfaceStop = {
    id: "stop-b",
    code: "B",
    name: "Queen St West at Ossington",
    lat: 43.665,
    lon: -79.38,
    wheelchair: 1,
    routes: ["501"],
  };

  const memoryLayer = buildDataStoreService({
    stops: [stopA, stopB],
    shapes: [],
    routes: [],
    routeStops: [],
  });

  function makeStubDb(): D1DatabaseBinding {
    // Rows are shaped like real SQLite rows (routes_json column) so the D1
    // adapter's deserialization pipeline is exercised faithfully.
    const allRows = [stopA, stopB].map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      wheelchair: s.wheelchair,
      parent_station: null,
      routes_json: JSON.stringify(s.routes ?? []),
    }));
    return withNoopBatch({
      prepare: (query: string) => {
        let bound: number[] = [];
        const stmt = {
          bind: (...values: unknown[]) => {
            bound = values as number[];
            return stmt;
          },
          first: async () => null,
          all: async <T>() => {
            if (query.includes("FROM stops") && query.includes("BETWEEN ? AND ?")) {
              const [minLat, maxLat, minLon, maxLon] = bound;
              const matched = allRows.filter(
                (s) => s.lat >= minLat && s.lat <= maxLat && s.lon >= minLon && s.lon <= maxLon,
              );
              return { results: matched as T[], success: true };
            }
            return { results: [] as T[], success: true };
          },
          run: async () => ({ success: true }),
        };
        return stmt;
      },
      exec: async () => ({}),
    });
  }

  it("exposes the 1.5 km ceiling as one exported constant + helper", () => {
    expect(MAX_PROXIMITY_RADIUS_METERS).toBe(1500);
    expect(clampProximityRadius(5000)).toBe(1500);
    expect(clampProximityRadius(1500)).toBe(1500);
    expect(clampProximityRadius(250)).toBe(250);
  });

  it("clamps identically in the memory adapter", async () => {
    const nearby = await Effect.runPromise(memoryLayer.findNearbyStops(QUERY.lat, QUERY.lon, 5000));
    expect(nearby.map((r) => r.stop.id)).toEqual(["stop-a"]);
    expect(nearby[0].distanceMeters).toBeLessThanOrEqual(1500);
  });

  it("clamps identically in the D1/SQLite adapter", async () => {
    const d1Layer = createD1SurfaceDataStore(makeStubDb());
    const nearby = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* SurfaceDataStore;
        return yield* store.findNearbyStops(QUERY.lat, QUERY.lon, 5000);
      }).pipe(Effect.provide(d1Layer)),
    );
    expect(nearby.map((r) => r.stop.id)).toEqual(["stop-a"]);
    expect(nearby[0].distanceMeters).toBeLessThanOrEqual(1500);
  });

  it("produces byte-identical results across adapters for the same data", async () => {
    const d1Layer = createD1SurfaceDataStore(makeStubDb());
    const fromMemory: readonly NearbyStopResult[] = await Effect.runPromise(
      memoryLayer.findNearbyStops(QUERY.lat, QUERY.lon, 5000),
    );
    const fromD1: readonly NearbyStopResult[] = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* SurfaceDataStore;
        return yield* store.findNearbyStops(QUERY.lat, QUERY.lon, 5000);
      }).pipe(Effect.provide(d1Layer)),
    );
    expect(fromD1).toEqual(fromMemory);
  });
});

describe("latitude-aware proximity bounding boxes", () => {
  it("derives meters-per-degree from spherical geometry, not city anchors", () => {
    // Independent reference points: ~110.57 km/deg lat at the equator,
    // ~111.32 km/deg lon at the equator, ~78.85 km/deg lon at 45°N.
    expect(metersPerDegreeLat(0)).toBeCloseTo(110574.27, 0);
    expect(metersPerDegreeLon(0)).toBeCloseTo(111319.46, 0);
    expect(metersPerDegreeLon(45)).toBeCloseTo(78846.81, 0);
    expect(metersPerDegreeLat(45)).toBeCloseTo(111131.74, 0);
  });

  it("builds the latitude-aware 1,120 m bounding box around Toronto", () => {
    const box = bboxFor(43.65, -79.38, 1110);

    expect(box.minLat).toBeCloseTo(43.6399, 4);
    expect(box.maxLat).toBeCloseTo(43.6601, 4);
    expect(box.minLon).toBeCloseTo(-79.3939, 4);
    expect(box.maxLon).toBeCloseTo(-79.3661, 4);
  });

  it("widens the longitude span as the query moves poleward", () => {
    const torontoBox = bboxFor(43.65, 0, 1500);
    const reykjavikBox = bboxFor(64, 0, 1500);
    expect(reykjavikBox.maxLon - reykjavikBox.minLon).toBeGreaterThan(
      torontoBox.maxLon - torontoBox.minLon,
    );
  });

  it("clamps oversized radii at the 1.5 km nearby-search ceiling before computing deltas", () => {
    const box = bboxFor(43.65, -79.38, 5000);

    expect(box.maxLat - box.minLat).toBeCloseTo(0.027183, 5);
  });
});
