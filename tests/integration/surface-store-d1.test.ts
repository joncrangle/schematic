import { describe, expect, it } from "vitest";
import { Effect, Option } from "effect";
import { buildDataStoreService } from "~/infrastructure/storage/memorySurfaceDataStore";
import { makeD1SurfaceDataStoreService } from "~/infrastructure/storage/d1SurfaceDataStore";
import { createD1TopologySource } from "~/infrastructure/storage/surfaceStore/topology";
import {
  createNodeSqliteBinding,
  type D1DatabaseBinding,
} from "~/infrastructure/storage/RuntimeBindings";
import { makeSurfaceTopologyWriter } from "~/infrastructure/storage/SurfaceStoreWriter";
import { loadDatabaseSync, makeTempDbPath } from "../helpers/sqlite-fixture";
import type {
  RouteDetails,
  SurfaceRoute,
  SurfaceStop,
  SurfaceRouteType,
} from "~/domain/surface/types";

// Canonical D1 homes: every D1-backed case moved out of
// tests/unit (surfaceStore.test.ts, surface-store-kernel-contract.test.ts) so
// the unit tier stays memory+fakes with no SQLite engine. Memory/D1 pairs are
// it.each matrices over the backend — one home per behavior.

const DatabaseSync = await loadDatabaseSync();
const sqliteAvailable = DatabaseSync !== null;

const FALLBACK_BOUNDS = { minLat: 43.6, maxLat: 43.8, minLon: -79.5, maxLon: -79.3 };

function makeRoute(
  id: string,
  shortName: string,
  routeType: SurfaceRouteType = "bus",
  longName?: string,
): SurfaceRoute {
  return {
    id,
    shortName,
    longName: longName ?? `Route ${shortName}`,
    routeType,
    color: "#DA251D",
    textColor: "#FFFFFF",
  };
}

function makeStop(
  id: string,
  lat: number,
  lon: number,
  routes: readonly string[],
  name?: string,
): SurfaceStop {
  return { id, code: id, name: name ?? `Stop ${id}`, lat, lon, wheelchair: 1, routes: [...routes] };
}

function makeDetails(
  route: SurfaceRoute,
  directionId: number,
  headsign: string,
  polyline: string,
  stops: readonly SurfaceStop[],
): RouteDetails {
  return {
    route,
    shape: {
      id: `${route.id}_${directionId}_test`,
      routeId: route.id,
      directionId,
      headsign,
      polyline,
      minLat: 43.6,
      maxLat: 43.8,
      minLon: -79.5,
      maxLon: -79.3,
      pointCount: stops.length,
    },
    stops: [...stops],
  };
}

function routeFixture(id: string, shortName: string): SurfaceRoute {
  return makeRoute(id, shortName);
}

function stopFixture(id: string, routeIds: readonly string[]): SurfaceStop {
  return makeStop(id, 43.65, -79.38, routeIds);
}

function shapeFixture(routeId: string, directionId: number) {
  return {
    id: `${routeId}_${directionId}`,
    routeId,
    directionId,
    headsign: `Headsign ${directionId}`,
    polyline: "poly",
    minLat: 43.6,
    maxLat: 43.8,
    minLon: -79.5,
    maxLon: -79.3,
    pointCount: 1,
    directionLabel: directionId === 0 ? "Northbound" : "Southbound",
  };
}

async function reconcileDetails(
  db: D1DatabaseBinding,
  details: RouteDetails,
  allStops: readonly SurfaceStop[] = details.stops,
  agencyId = "ttc",
) {
  return Effect.runPromise(
    makeSurfaceTopologyWriter({ agencyId, db }).reconcileRoute({
      routeId: details.route.id,
      detailsByDirection: new Map([[details.shape.directionId, details]]),
      allStops,
    }),
  );
}

const ROUTE_X = makeRoute("rX", "X");
const ROUTE_2 = makeRoute("r2", "2");
const ROUTE_10 = makeRoute("r10", "10");

const STOP_A = makeStop("SA", 43.65, -79.38, ["r10", "r2"], "Stop A");
const STOP_B = makeStop("SB", 43.651, -79.381, ["r10"], "Stop B");
const STOP_C = makeStop("SC", 43.66, -79.39, ["r2"], "Stop C");

// Bus dir0 with a west compass headsign: C1 Direction must preserve the
// compass word (Westbound), not the canonical bus dir0 literal (Northbound).
const DETAILS_10_WEST = makeDetails(ROUTE_10, 0, "West — 10 Test to Terminal", "poly-10", [
  STOP_A,
  STOP_B,
]);
const DETAILS_2_NORTH = makeDetails(ROUTE_2, 0, "North — 2 Test to End", "poly-2", [STOP_C]);
const DETAILS_X_EAST = makeDetails(ROUTE_X, 0, "East — X Test to End", "poly-x", [STOP_A]);

function throwingFetch(): typeof fetch {
  return ((_input: unknown) => {
    throw new Error("network leak: global fetch touched in test");
  }) as unknown as typeof fetch;
}

describe.skipIf(!sqliteAvailable)("surfaceStore D1 backend — ordering matrices", () => {
  it("D1: getAllRoutes returns canonical CAST order (X, 2, 10)", async () => {
    const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    for (const details of [DETAILS_10_WEST, DETAILS_X_EAST, DETAILS_2_NORTH]) {
      await reconcileDetails(db, details);
    }
    const routes = await Effect.runPromise(makeD1SurfaceDataStoreService(db).getAllRoutes());
    expect(routes.map((r) => r.shortName)).toEqual(["X", "2", "10"]);
  });

  it("D1: getStopsByIds restores input order (reversed)", async () => {
    const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    await reconcileDetails(db, DETAILS_10_WEST);
    const reversed = await Effect.runPromise(
      makeD1SurfaceDataStoreService(db).getStopsByIds(["SB", "SA"]),
    );
    expect(reversed.map((s) => s.id)).toEqual(["SB", "SA"]);
  });

  it("D1-vs-memory: getRouteDetails agrees on shape, stops, label", async () => {
    const memory = buildDataStoreService({
      stops: [STOP_A, STOP_B],
      shapes: [{ ...DETAILS_10_WEST.shape, directionLabel: "Westbound" }],
      routes: [ROUTE_10],
      routeStops: [
        { routeId: "r10", directionId: 0, stopSequence: 0, stopId: "SA" },
        { routeId: "r10", directionId: 0, stopSequence: 1, stopId: "SB" },
      ],
    });
    const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    await reconcileDetails(db, DETAILS_10_WEST);
    const d1 = makeD1SurfaceDataStoreService(db);

    const fromMemory = Option.getOrThrow(await Effect.runPromise(memory.getRouteDetails("r10", 0)));
    const fromD1 = Option.getOrThrow(await Effect.runPromise(d1.getRouteDetails("r10", 0)));

    expect(fromD1.shape.polyline).toBe(fromMemory.shape.polyline);
    expect(fromD1.stops.map((s) => s.id)).toEqual(fromMemory.stops.map((s) => s.id));
    expect(fromD1.shape.directionLabel).toBe("Westbound");
    expect(fromD1.shape.directionLabel).toBe(fromMemory.shape.directionLabel);
  });

  it("prefers the canonical shape when legacy direction rows coexist", async () => {
    const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    await reconcileDetails(db, DETAILS_10_WEST);
    await db
      .prepare(
        "INSERT INTO route_shapes (agency_id, id, route_id, direction_id, headsign, polyline, min_lat, max_lat, min_lon, max_lon, point_count, direction_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        "ttc",
        "r10_0_live",
        "r10",
        0,
        "Legacy shape",
        "legacy-polyline",
        43.6,
        43.8,
        -79.5,
        -79.3,
        2,
        "Westbound",
      )
      .run();

    const details = Option.getOrThrow(
      await Effect.runPromise(makeD1SurfaceDataStoreService(db).getRouteDetails("r10", 0)),
    );
    expect(details.shape.id).toBe("r10_0_canonical");
    expect(details.shape.polyline).toBe(DETAILS_10_WEST.shape.polyline);
  });

  it("D1-vs-memory: findNearbyStops agrees on hits", async () => {
    const memory = buildDataStoreService({
      stops: [STOP_A, STOP_B, STOP_C],
      shapes: [],
      routes: [],
      routeStops: [],
    });
    const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    await reconcileDetails(db, DETAILS_10_WEST, [STOP_A, STOP_B, STOP_C]);
    const d1 = makeD1SurfaceDataStoreService(db);

    const fromMemory = await Effect.runPromise(memory.findNearbyStops(43.65, -79.38, 500));
    const fromD1 = await Effect.runPromise(d1.findNearbyStops(43.65, -79.38, 500));
    expect(fromD1.map((h) => h.stop.id).sort()).toEqual(fromMemory.map((h) => h.stop.id).sort());
  });

  it("D1-vs-memory: getStopsForRoutes matches json_each membership", async () => {
    const route10Stops = [
      { ...STOP_A, routes: ["r10"] },
      { ...STOP_B, routes: ["r10"] },
      { ...STOP_C, routes: ["r10"] },
    ];
    const memory = buildDataStoreService({
      stops: route10Stops,
      shapes: [],
      routes: [],
      routeStops: [],
    });
    const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    await reconcileDetails(db, DETAILS_10_WEST, route10Stops);
    const d1 = makeD1SurfaceDataStoreService(db);

    const fromMemory = await Effect.runPromise(memory.getStopsForRoutes(["r10"]));
    const fromD1 = await Effect.runPromise(d1.getStopsForRoutes(["r10"]));
    expect(fromD1.map((s) => s.id).sort()).toEqual(fromMemory.map((s) => s.id).sort());
  });

  it("reuses warm topology without new D1 reads across polling-shaped calls", async () => {
    const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    await reconcileDetails(db, DETAILS_10_WEST, [STOP_A, STOP_B]);

    let prepareCount = 0;
    let batchCount = 0;
    const countedDb: D1DatabaseBinding = {
      prepare(query) {
        prepareCount++;
        return db.prepare(query);
      },
      exec: (query) => db.exec(query),
      batch: async (statements) => {
        batchCount++;
        return db.batch(statements);
      },
    };
    const store = makeD1SurfaceDataStoreService(countedDb);

    const readRound = async () => ({
      nearby: await Effect.runPromise(store.findNearbyStops(STOP_A.lat, STOP_A.lon, 500)),
      route: await Effect.runPromise(store.getRoute("r10")),
      details: await Effect.runPromise(store.getRouteDetails("r10", 0)),
      stops: await Effect.runPromise(store.getStopsForRoutes(["r10"])),
    });

    const firstRound = await readRound();
    const afterWarmup = prepareCount;
    const secondRound = await readRound();

    expect(secondRound).toEqual(firstRound);
    expect(prepareCount).toBe(afterWarmup);
    // Polling-shaped reads never persist: zero write batches across both rounds.
    expect(batchCount).toBe(0);
  });
});

describe.skipIf(!sqliteAvailable)(
  "surfaceStore D1 backend — label authority (C1 Direction)",
  () => {
    it.each(["memory", "d1"] as const)(
      "bus dir0 keeps the headsign compass word via %s",
      async (backend) => {
        const details = await (async () => {
          if (backend === "memory") {
            return Option.getOrThrow(
              await Effect.runPromise(
                buildDataStoreService({
                  stops: [STOP_A, STOP_B],
                  shapes: [{ ...DETAILS_10_WEST.shape, directionLabel: "Westbound" }],
                  routes: [ROUTE_10],
                  routeStops: [
                    { routeId: "r10", directionId: 0, stopSequence: 0, stopId: "SA" },
                    { routeId: "r10", directionId: 0, stopSequence: 1, stopId: "SB" },
                  ],
                }).getRouteDetails("r10", 0),
              ),
            );
          }
          const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
          await reconcileDetails(db, DETAILS_10_WEST);
          return Option.getOrThrow(
            await Effect.runPromise(makeD1SurfaceDataStoreService(db).getRouteDetails("r10", 0)),
          );
        })();
        // Canonical bus dir0 would be "Northbound" — the compass word wins.
        expect(details.shape.directionLabel).toBe("Westbound");
      },
    );
  },
);

describe.skipIf(!sqliteAvailable)("surfaceStore D1 backend — read semantics", () => {
  it("D1: getStopsForRoutes returns a both-directions stop once", async () => {
    const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    const allRouteStops = [STOP_A, STOP_B];
    await reconcileDetails(db, DETAILS_10_WEST, allRouteStops);
    const eastbound = makeDetails(ROUTE_10, 1, "East — 10 Test to Terminal", "poly-10-e", [STOP_A]);
    await reconcileDetails(db, eastbound, allRouteStops);

    const svc = makeD1SurfaceDataStoreService(db);
    const stops = await Effect.runPromise(svc.getStopsForRoutes(["r10"]));
    // STOP_A has two junction rows (one per direction); callers expect one entry per stop.
    expect(stops.map((s) => s.id).sort()).toEqual(["SA", "SB"]);
  });

  it("D1 miss returns none (never fabricates topology, never fetches)", async () => {
    const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    const svc = makeD1SurfaceDataStoreService(db);
    expect(Option.isNone(await Effect.runPromise(svc.getRouteDetails("r10", 0)))).toBe(true);
    expect(Option.isNone(await Effect.runPromise(svc.getRoute("r10")))).toBe(true);
  });

  it("D1: getStopsForRoutes([]) and getStopsByIds([]) return [] without DB touch", async () => {
    const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    const svc = makeD1SurfaceDataStoreService(db);
    // getAllRoutes to create tables, then test empty
    await Effect.runPromise(
      svc.getAllRoutes().pipe(Effect.catch(() => Effect.succeed([] as never[]))),
    );
    let prepareCalls = 0;
    const spyingDb = {
      ...db,
      prepare: (query: string) => {
        prepareCalls++;
        return db.prepare(query);
      },
      batch: db.batch.bind(db),
      exec: db.exec.bind(db),
    } as unknown as typeof db;
    const spyingSvc = makeD1SurfaceDataStoreService(spyingDb);
    prepareCalls = 0;
    const empty1 = await Effect.runPromise(spyingSvc.getStopsForRoutes([]));
    expect(empty1).toEqual([]);
    expect(prepareCalls).toBe(0);
    prepareCalls = 0;
    const empty2 = await Effect.runPromise(spyingSvc.getStopsByIds([]));
    expect(empty2).toEqual([]);
    expect(prepareCalls).toBe(0);
  });

  it("exposes writer-seeded route and stop topology through the D1 read port", async () => {
    const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    const route = routeFixture("501", "501");
    const stop = stopFixture("S1", ["501"]);
    await reconcileDetails(db, { route, shape: shapeFixture("501", 0), stops: [stop] }, [stop]);

    const svc = makeD1SurfaceDataStoreService(db);
    const first = Option.getOrThrow(await Effect.runPromise(svc.getRoute("501")));
    const second = Option.getOrThrow(await Effect.runPromise(svc.getRoute("501")));

    expect(second).toEqual(first);
    expect(first.id).toBe("501");
    expect(await Effect.runPromise(svc.getStopsForRoutes(["501"]))).toMatchObject([{ id: "S1" }]);
  });
});

describe("surfaceStore D1 backend — failure semantics (fake binding, no SQLite engine)", () => {
  type Store = ReturnType<typeof makeD1SurfaceDataStoreService>;
  type StoreRead = (store: Store) => Effect.Effect<unknown, unknown>;

  it.each([
    ["findNearbyStops", (store: Store) => store.findNearbyStops(43.65, -79.38)],
    ["getRouteDetails", (store: Store) => store.getRouteDetails("501", 0)],
    ["getRoute", (store: Store) => store.getRoute("501")],
    ["getAllRoutes", (store: Store) => store.getAllRoutes()],
    ["getStopsForRoutes", (store: Store) => store.getStopsForRoutes(["501"])],
    ["getStopsByIds", (store: Store) => store.getStopsByIds(["S1"])],
  ] as [string, StoreRead][])("%s rejects when the database is down", async (_name, read) => {
    const dbDown: D1DatabaseBinding = {
      prepare: () => {
        throw new Error("database unavailable");
      },
      exec: async () => {
        throw new Error("database unavailable");
      },
      batch: async () => {
        throw new Error("database unavailable");
      },
    };

    await expect(
      Effect.runPromise(read(makeD1SurfaceDataStoreService(dbDown))),
    ).rejects.toMatchObject({
      cause: { message: "database unavailable" },
    });
  });
});

describe.skipIf(!sqliteAvailable)("surfaceStore D1 backend — topology (shared read path)", () => {
  it("fetchTopology materializes stop_sequence ASC with injected fetch only", async () => {
    const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    await reconcileDetails(db, DETAILS_10_WEST);
    // Re-insert associations in inverted physical order: seq can only come
    // from ORDER BY stop_sequence ASC, never insertion order.
    await db.prepare("DELETE FROM route_stops WHERE route_id = ?").bind("r10").run();
    await db
      .prepare(
        "INSERT INTO route_stops (agency_id, route_id, direction_id, stop_sequence, stop_id) VALUES (?, ?, ?, ?, ?)",
      )
      .bind("ttc", "r10", 0, 1, "SB")
      .run();
    await db
      .prepare(
        "INSERT INTO route_stops (agency_id, route_id, direction_id, stop_sequence, stop_id) VALUES (?, ?, ?, ?, ?)",
      )
      .bind("ttc", "r10", 0, 0, "SA")
      .run();
    const src = createD1TopologySource({
      d1: db,
      agencyId: "ttc",
      now: () => 424242,
      fetch: throwingFetch(),
      fallbackBounds: FALLBACK_BOUNDS,
    });
    const snapshot = await Effect.runPromise(src.fetchTopology());
    expect(snapshot.agencyId).toBe("ttc");
    expect(snapshot.generatedAt).toBe(424242);
    const route = snapshot.routes.find((r) => r.routeId === "r10")!;
    expect(route.stops.map((s) => s.id)).toEqual(["SA", "SB"]);
    expect(route.directionLabel).toBe("Westbound");
  });

  it("empty shapes emit a single canonical-label entry", async () => {
    const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    const streetcar = makeRoute("s1", "S1", "streetcar", "Streetcar 1");
    await reconcileDetails(
      db,
      makeDetails(streetcar, 0, "East — S1 Test to Terminal", "poly-s1", []),
      [],
    );
    // Remove the shape row so the route has no shapes.
    await db.prepare("DELETE FROM route_shapes WHERE route_id = ?").bind("s1").run();
    const src = createD1TopologySource({
      d1: db,
      agencyId: "ttc",
      fetch: throwingFetch(),
      fallbackBounds: FALLBACK_BOUNDS,
    });
    const snapshot = await Effect.runPromise(src.fetchTopology());
    const route = snapshot.routes.find((r) => r.routeId === "s1")!;
    expect(route.polyline).toBe("");
    expect(route.directionLabel).toBe("Eastbound");
  });

  it("syncTopology addresses NextBus with nextbusSlug over injected fetch", async () => {
    const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    const requestedUrls: string[] = [];
    const fetchMock = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("command=routeList")) {
        return new Response(JSON.stringify({ route: [{ tag: "r10" }] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          route: {
            tag: "r10",
            title: "10-Test",
            color: "DA251D",
            oppositeColor: "FFFFFF",
            latMin: "43.6",
            latMax: "43.8",
            lonMin: "-79.5",
            lonMax: "-79.3",
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const src = createD1TopologySource({
      d1: db,
      agencyId: "go-transit",
      nextbusSlug: "go",
      now: () => 1234,
      fetch: fetchMock,
      fallbackBounds: FALLBACK_BOUNDS,
    });
    await Effect.runPromise(src.syncTopology());
    const routeListUrls = requestedUrls.filter((u) => u.includes("command=routeList"));
    expect(routeListUrls).toHaveLength(1);
    expect(routeListUrls[0]).toContain("a=go&");
    expect(routeListUrls[0]).not.toContain("a=go-transit");
  });
});
