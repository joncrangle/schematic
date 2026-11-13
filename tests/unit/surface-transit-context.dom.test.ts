vi.mock("~/agencies/agencyCatalog", async () => {
  const { testAgencyCatalog } = await import("../helpers/agency-fixtures");
  return { agencyCatalog: testAgencyCatalog };
});
// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { Context, Effect, Layer, Option } from "effect";
import { SurfaceDataStore } from "~/infrastructure/storage/SurfaceDataStore";
import { makeSurfaceStoreKernel } from "~/infrastructure/storage/surfaceStore/readPolicy";
import {
  createSurfaceTopologyReadCache,
  type SurfaceTopologyReadCapabilities,
} from "~/infrastructure/storage/surfaceStore/topologyCache";
import type { AgencySnapshot } from "~/agencies/types";
import type { SurfaceRoute, SurfaceStop } from "~/domain/surface/types";
import type { RealtimeSource } from "~/domain/surface/realtimeSource";
import {
  handleFetchNearbyTransit,
  handleFetchRoutesMetadata,
} from "~/services/surface/SurfaceServer";
import { makeLiveSurfaceTransitLayer } from "~/services/surface/SurfaceTransit";

/**
 * Shared per-agency Surface Transit composition: one store instance
 * serves both the retained SurfaceDataStore tag and NearbyTransit, so a
 * metadata-warmed topology is reused by arrival assembly without another
 * underlying read, and agencies stay isolated.
 *
 * Only underlying topology reads are counted — cache TTL/capacities stay
 * hidden behind the storage adapter. Generic memo behavior (single-flight,
 * evict-on-failure) lives canonically in
 * tests/unit/memoized-layer-context.test.ts.
 */

const route97: SurfaceRoute = {
  id: "97",
  shortName: "97",
  longName: "Yonge",
  routeType: "bus",
  color: "#DA251D",
  textColor: "#FFFFFF",
};

const stop97: SurfaceStop = {
  id: "s-97",
  code: "s-97",
  name: "Stop s-97",
  lat: 43.6709,
  lon: -79.3857,
  wheelchair: 1,
  routes: ["97"],
};

const emptySnapshot = (agencyId: string): AgencySnapshot => ({
  agencyId,
  generatedAt: 0,
  freshness: "live",
  alerts: [],
});

/** Production cache + kernel over a source that counts underlying reads. */
function makeCountedStore() {
  let routeRowReads = 0;
  const source: SurfaceTopologyReadCapabilities = {
    readTripTerminals: () => Effect.succeed(new Map()),
    readDirectionsForTrips: () => Effect.succeed(new Map<string, number>()),
    readRouteDirectionIds: () => Effect.succeed([0]),
    readNearbyCandidates: () => Effect.succeed([stop97]),
    readCachedRouteDetails: () => Effect.succeed(Option.none()),
    readRouteRow: (routeId) =>
      Effect.sync(() => {
        routeRowReads += 1;
        return routeId === route97.id ? Option.some(route97) : Option.none();
      }),
    readAllRouteRows: () => Effect.succeed([route97]),
    readStopsForRoutes: () => Effect.succeed([]),
    readStopsByIds: () => Effect.succeed([]),
  };
  const cache = createSurfaceTopologyReadCache(source);
  const kernel = makeSurfaceStoreKernel({ ...cache.readers });
  const service = SurfaceDataStore.of({
    findNearbyStops: kernel.findNearbyStops,
    getRouteDirectionIds: kernel.getRouteDirectionIds,
    getTripTerminals: () => Effect.succeed(new Map()),
    getDirectionsForTrips: kernel.getDirectionsForTrips,
    getRouteDetails: kernel.getRouteDetails,
    getRoute: kernel.getRoute,
    getAllRoutes: kernel.getAllRoutes,
    getStopsForRoutes: kernel.getStopsForRoutes,
    getStopsByIds: kernel.getStopsByIds,
  });
  return {
    layer: Layer.succeed(SurfaceDataStore, service),
    service,
    routeRowReads: () => routeRowReads,
  };
}

function buildTestContext(agencyId: string, store: ReturnType<typeof makeCountedStore>) {
  return Effect.runPromise(
    Effect.scoped(
      Layer.build(
        makeLiveSurfaceTransitLayer(agencyId, {
          storeLayer: store.layer,
          realtimeByAgencyId: new Map<string, RealtimeSource>(),
          snapshot: Effect.succeed(emptySnapshot(agencyId)),
        }),
      ),
    ),
  );
}

describe("SurfaceTransit shared composition", () => {
  it("provides the exact store instance under the SurfaceDataStore tag", async () => {
    const store = makeCountedStore();
    const ctx = await buildTestContext("sample", store);

    expect(Context.get(ctx, SurfaceDataStore)).toBe(store.service);
  });

  it("reuses metadata-warmed topology for Nearby Transit without another underlying read", async () => {
    const store = makeCountedStore();
    const ctx = await buildTestContext("sample", store);
    const getContext = () => Promise.resolve(ctx);

    const metadata = await handleFetchRoutesMetadata(
      { agencyId: "sample", routeIds: ["97"] },
      getContext,
    );
    expect(metadata).toEqual([{ id: "97", shortName: "97", longName: "Yonge", routeType: "bus" }]);
    expect(store.routeRowReads()).toBe(1);

    const nearby = await handleFetchNearbyTransit(
      { agencyId: "sample", lat: 43.6709, lon: -79.3857, radius: 500 },
      getContext,
    );
    expect(nearby).toHaveLength(1);
    expect(nearby[0]?.routeId).toBe("97");
    expect(store.routeRowReads()).toBe(1);
  });

  it("isolates stores and results across agencies", async () => {
    const ttcStore = makeCountedStore();
    const yrtStore = makeCountedStore();
    const ttcCtx = await buildTestContext("sample", ttcStore);
    const yrtCtx = await buildTestContext("metro", yrtStore);

    expect(Context.get(ttcCtx, SurfaceDataStore)).toBe(ttcStore.service);
    expect(Context.get(yrtCtx, SurfaceDataStore)).toBe(yrtStore.service);
    expect(Context.get(ttcCtx, SurfaceDataStore)).not.toBe(Context.get(yrtCtx, SurfaceDataStore));

    const nearby = await handleFetchNearbyTransit(
      { agencyId: "metro", lat: 43.6709, lon: -79.3857, radius: 500 },
      () => Promise.resolve(yrtCtx),
    );
    expect(nearby).toHaveLength(1);
    expect(nearby[0]?.agencyId).toBe("metro");
  });

  it("rejects layer construction for an unknown agency instead of using the active provider", () => {
    expect(() => makeLiveSurfaceTransitLayer("unknown-agency")).toThrow(
      'SurfaceTransit: unknown agency "unknown-agency"',
    );
  });
});
