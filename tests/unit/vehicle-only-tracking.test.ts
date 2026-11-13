import * as Layer from "effect/Layer";
import { RealtimeError, type RealtimeSource } from "~/domain/surface/realtimeSource";
import { afterEach, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { createMemorySurfaceDataStore } from "~/infrastructure/storage/memorySurfaceDataStore";
import { makeLiveSurfaceTransitLayer } from "~/services/surface/SurfaceTransit";
import { NearbyTransit } from "~/services/surface/NearbyTransit";

vi.mock("~/agencies/agencyCatalog", async () => {
  const { makeTestManifest, makeTestSchematic } = await import("../helpers/agency-fixtures");
  return {
    agencyCatalog: [
      {
        manifest: makeTestManifest({
          staticTopology: {
            source: "seed",
            feeds: [{ url: "https://example.test/gtfs.zip" }],
            vehicleOnlyRoutes: [{ id: "R", shortName: "R", longName: "Rural buses" }],
          },
        }),
        schematic: makeTestSchematic(),
      },
    ],
  };
});

function fixture(outage = false) {
  const vehicle = {
    vehicleId: "bus",
    routeId: "R",
    directionId: 0,
    latitude: 43.5,
    longitude: -79.5,
    timestamp: Date.now(),
  };
  const fetchRealtime = vi.fn<RealtimeSource["fetchRealtime"]>(() =>
    outage
      ? Effect.fail(new RealtimeError({ agencyId: "sample", message: "Fleet outage" }))
      : Effect.succeed({
          agencyId: "sample",
          updatedAt: Date.now(),
          vehicles: [vehicle],
          arrivals: [],
        }),
  );
  const layer = makeLiveSurfaceTransitLayer("sample", {
    storeLayer: createMemorySurfaceDataStore({
      routes: [
        {
          id: "R",
          shortName: "R",
          longName: "Rural buses",
          routeType: "bus",
          color: "#000000",
          textColor: "#FFFFFF",
        },
      ],
      stops: [],
      shapes: [],
      routeStops: [],
    }),
    realtimeByAgencyId: new Map([["sample", { fetchRealtime }]]),
    snapshot: Effect.succeed({
      agencyId: "sample",
      generatedAt: Date.now(),
      freshness: "unavailable",
      alerts: [],
    }),
  });
  return { layer, vehicle, fetchRealtime };
}
const read = Effect.gen(function* () {
  const service = yield* NearbyTransit;
  return Option.getOrThrow(
    yield* service.getRouteTracking({ agencyId: "sample", routeId: "R", directionId: 0 }),
  );
});
afterEach(() => vi.useRealTimers());

it("serves vehicle-only tracking from the registered surface composition with real catalog topology", async () => {
  const { layer, vehicle, fetchRealtime } = fixture();
  const result = await Effect.runPromise(read.pipe(Effect.provide(layer)));
  expect(result.vehiclePositionsOnly).toBe(true);
  expect(result.vehiclePositionsFreshness).toBe("live");
  expect(result.availableDirectionIds).toEqual([0]);
  expect(result.vehicles).toEqual([vehicle]);
  expect(result.stops).toEqual([]);
  expect(result.shape.polyline).toBe("");
  expect(result.shape.headsign).toBe("");
  expect(fetchRealtime.mock.calls[0][0].routes.map((route) => route.routeId)).toEqual(["R"]);
});
it("reports an unavailable fleet on first failure instead of claiming zero active vehicles", async () => {
  const { layer } = fixture(true);
  const result = await Effect.runPromise(read.pipe(Effect.provide(layer)));
  expect(result.vehiclePositionsFreshness).toBe("unavailable");
  expect(result.vehicles).toEqual([]);
});
it("reports omitted coverage as unavailable instead of a healthy empty fleet", async () => {
  const { layer, fetchRealtime } = fixture();
  fetchRealtime.mockImplementation(() =>
    Effect.succeed({
      agencyId: "sample",
      updatedAt: Date.now(),
      vehicles: [],
      arrivals: [],
      partial: true,
    }),
  );
  const result = await Effect.runPromise(read.pipe(Effect.provide(layer)));
  expect(result.vehiclePositionsFreshness).toBe("unavailable");
});

it("marks last-known positions stale after a failed refresh", async () => {
  vi.useFakeTimers();
  const { layer, fetchRealtime } = fixture();
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(layer);
        yield* read.pipe(Effect.provide(context));
        fetchRealtime.mockImplementation(() =>
          Effect.fail(new RealtimeError({ agencyId: "sample", message: "Fleet outage" })),
        );
        vi.advanceTimersByTime(31_000);
        return yield* read.pipe(Effect.provide(context));
      }),
    ),
  );
  expect(result.vehiclePositionsFreshness).toBe("stale");
  expect(result.vehicles[0].freshness).toBe("stale");
});
