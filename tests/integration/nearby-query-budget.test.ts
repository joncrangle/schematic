import { describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import { createInvocationBudget } from "~/infrastructure/http/InvocationIo";
import { makeD1SurfaceDataStoreService } from "~/infrastructure/storage/d1SurfaceDataStore";
import {
  REQUEST_QUERY_BUDGET,
  runWithRequestQueryBudget,
} from "~/infrastructure/storage/requestQueryBudget";
import {
  createSyncSqliteBinding,
  type SqliteDatabaseLike,
} from "~/infrastructure/storage/RuntimeBindings";
import { SurfaceDataStore } from "~/infrastructure/storage/SurfaceDataStore";
import { makeD1Reads } from "~/infrastructure/storage/surfaceStore/reads";
import { SURFACE_SCHEMA_STATEMENTS } from "~/infrastructure/storage/surfaceStore/schema";
import {
  NearbySnapshotSource,
  NearbyTransit,
  NearbyTransitLive,
  SurfaceAgencyDefaults,
  createRealtimeCacheLayer,
} from "~/services/surface/NearbyTransit";
import { loadDatabaseSync } from "../helpers/sqlite-fixture";

const DatabaseSync = await loadDatabaseSync();
const agencyId = "sample";
const now = Date.now();

type Sqlite = SqliteDatabaseLike & { close(): void };

function openDatabase(): Sqlite {
  const sqlite = new DatabaseSync!(":memory:") as Sqlite;
  sqlite.exec(`PRAGMA foreign_keys = OFF;${SURFACE_SCHEMA_STATEMENTS.join(";")}`);
  return sqlite;
}

function insert(sqlite: Sqlite, table: string, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  sqlite
    .prepare(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    )
    .run(...(Object.values(row) as never[]));
}

const insertRoute = (sqlite: Sqlite, id: string) =>
  insert(sqlite, "routes", {
    agency_id: agencyId,
    id,
    short_name: id,
    long_name: `Route ${id}`,
    route_type: 3,
  });

const insertStop = (sqlite: Sqlite, id: string, routes: readonly string[]) =>
  insert(sqlite, "stops", {
    agency_id: agencyId,
    id,
    name: `Stop ${id}`,
    lat: 43.65,
    lon: -79.38,
    routes_json: JSON.stringify(routes),
  });

const insertShape = (sqlite: Sqlite, id: string, routeId: string, directionId: number) =>
  insert(sqlite, "route_shapes", {
    agency_id: agencyId,
    id,
    route_id: routeId,
    direction_id: directionId,
    headsign: `To ${id}`,
    polyline: "",
    min_lat: 43,
    max_lat: 44,
    min_lon: -80,
    max_lon: -79,
    point_count: 2,
  });

const insertRouteStop = (
  sqlite: Sqlite,
  routeId: string,
  directionId: number,
  stopSequence: number,
  stopId: string,
) =>
  insert(sqlite, "route_stops", {
    agency_id: agencyId,
    route_id: routeId,
    direction_id: directionId,
    stop_sequence: stopSequence,
    stop_id: stopId,
  });

const insertDirectionTrips = (
  sqlite: Sqlite,
  routeId: string,
  directionId: number,
  tripIds: readonly string[],
) =>
  insert(sqlite, "route_direction_trips", {
    agency_id: agencyId,
    route_id: routeId,
    direction_id: directionId,
    trip_ids: JSON.stringify(tripIds),
  });

describe.skipIf(!DatabaseSync)("batched surface reads", () => {
  it("returns the same route topology as per-route reads", async () => {
    const sqlite = openDatabase();
    try {
      for (const routeId of ["canonical", "fallback"]) insertRoute(sqlite, routeId);
      insertStop(sqlite, "first", ["canonical"]);
      insertStop(sqlite, "second", ["canonical"]);
      insertShape(sqlite, "a-shape", "canonical", 0);
      insertShape(sqlite, "canonical_0_canonical", "canonical", 0);
      insertShape(sqlite, "return", "canonical", 1);
      insertShape(sqlite, "z-shape", "fallback", 0);
      insertShape(sqlite, "b-shape", "fallback", 0);
      insertShape(sqlite, "orphan", "without-route", 0);
      insertRouteStop(sqlite, "canonical", 0, 2, "second");
      insertRouteStop(sqlite, "canonical", 0, 1, "first");
      const reads = makeD1Reads(createSyncSqliteBinding(sqlite), { agencyId });
      const routeIds = ["canonical", "fallback", "without-route", "unknown"];

      const bundles = await Effect.runPromise(reads.readRouteTopologies(routeIds));

      for (const routeId of routeIds) {
        const bundle = bundles.get(routeId)!;
        const directionIds = await Effect.runPromise(reads.readRouteDirectionIds(routeId));
        expect(bundle.directionIds).toEqual(directionIds);
        expect(bundle.route).toEqual(await Effect.runPromise(reads.readRouteRow(routeId)));
        for (const directionId of directionIds) {
          expect(bundle.details.get(directionId)).toEqual(
            await Effect.runPromise(reads.readCachedRouteDetails(routeId, directionId)),
          );
        }
      }
    } finally {
      sqlite.close();
    }
  });

  it("returns the same trip facts as per-route reads", async () => {
    const sqlite = openDatabase();
    try {
      insertDirectionTrips(sqlite, "one", 0, ["shared", "only-one"]);
      insertDirectionTrips(sqlite, "two", 1, ["shared", "not-requested"]);
      insert(sqlite, "route_trip_terminals", {
        agency_id: agencyId,
        route_id: "one",
        direction_id: 0,
        terminal_stop_id: "end-one",
        terminal_stop_sequence: 8,
        trip_ids: JSON.stringify(["shared"]),
      });
      insert(sqlite, "route_trip_terminals", {
        agency_id: agencyId,
        route_id: "two",
        direction_id: 1,
        terminal_stop_id: "end-two",
        terminal_stop_sequence: 9,
        trip_ids: JSON.stringify(["shared", "not-requested"]),
      });
      insert(sqlite, "route_trip_headsigns", {
        agency_id: agencyId,
        route_id: "two",
        headsign: "Downtown",
        trip_ids: JSON.stringify(["shared"]),
      });
      const reads = makeD1Reads(createSyncSqliteBinding(sqlite), { agencyId });
      const requested = new Map([
        ["one", ["shared", "only-one", "unknown"]],
        ["two", ["shared"]],
      ]);

      const facts = await Effect.runPromise(reads.readTripFactsForRoutes(requested));

      for (const [routeId, tripIds] of requested) {
        expect(facts.get(routeId)).toEqual({
          terminals: await Effect.runPromise(reads.readTripTerminals(routeId, tripIds)),
          directions: await Effect.runPromise(reads.readDirectionsForTrips(routeId, tripIds)),
        });
      }
    } finally {
      sqlite.close();
    }
  });

  it("answers a many-route nearby request and repeat topology reads within the budget", async () => {
    const sqlite = openDatabase();
    try {
      const routeIds = Array.from({ length: 60 }, (_, index) => `route-${index}`);
      insertStop(sqlite, "hub", routeIds);
      insertStop(sqlite, "next", routeIds);
      for (const routeId of routeIds) {
        insertRoute(sqlite, routeId);
        for (const directionId of [0, 1]) {
          insertShape(sqlite, `${routeId}_${directionId}_canonical`, routeId, directionId);
          insertRouteStop(sqlite, routeId, directionId, 1, "hub");
          insertRouteStop(sqlite, routeId, directionId, 2, "next");
          insertDirectionTrips(sqlite, routeId, directionId, [`${routeId}-${directionId}`]);
        }
      }
      const store = makeD1SurfaceDataStoreService(createSyncSqliteBinding(sqlite), { agencyId });
      const arrivals = routeIds.map((routeId) => ({
        tripId: `${routeId}-1`,
        routeId,
        directionId: 1,
        stopId: "hub",
        stopSequence: 1,
        predictedTime: now + 60_000,
        delaySeconds: 0,
        scheduleRelationship: "SCHEDULED" as const,
        isRealtime: true,
      }));
      const layer = Layer.provide(
        NearbyTransitLive,
        Layer.mergeAll(
          Layer.succeed(SurfaceDataStore, store),
          createRealtimeCacheLayer(
            {},
            {
              realtimeByAgencyId: new Map([
                [
                  agencyId,
                  {
                    fetchRealtime: () =>
                      Effect.succeed({ agencyId, updatedAt: now, vehicles: [], arrivals }),
                  },
                ],
              ]),
            },
          ),
          Layer.succeed(NearbySnapshotSource, {
            getSnapshot: Effect.succeed({
              agencyId,
              generatedAt: now,
              freshness: "live" as const,
              alerts: [],
            }),
          }),
          Layer.succeed(SurfaceAgencyDefaults, {
            agencyId,
            focus: { lat: 43.65, lon: -79.38 },
            fallbackBounds: { minLat: 43, maxLat: 44, minLon: -80, maxLon: -79 },
          }),
        ),
      );
      const budget = createInvocationBudget(REQUEST_QUERY_BUDGET);

      const result = await runWithRequestQueryBudget(
        () =>
          Effect.runPromise(
            Effect.gen(function* () {
              const service = yield* NearbyTransit;
              return yield* service.getNearbyTransit({
                agencyId,
                lat: 43.65,
                lon: -79.38,
                radius: 500,
              });
            }).pipe(Effect.provide(layer)),
          ),
        budget,
      );

      expect(new Set(result.map((row) => row.routeId)).size).toBe(routeIds.length);
      expect(REQUEST_QUERY_BUDGET - budget.remaining).toBeLessThanOrEqual(8);

      const beforeRepeatRead = budget.remaining;
      await runWithRequestQueryBudget(
        () =>
          Effect.runPromise(
            Effect.all([
              store.getRoute("route-0"),
              store.getRouteDirectionIds("route-0"),
              store.getRouteDetails("route-0", 1),
            ]).pipe(
              Effect.tap(([route]) => Effect.sync(() => expect(Option.isSome(route)).toBe(true))),
            ),
          ),
        budget,
      );
      expect(budget.remaining).toBe(beforeRepeatRead);
    } finally {
      sqlite.close();
    }
  });
});
