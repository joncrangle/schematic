import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeD1SurfaceDataStoreService } from "~/infrastructure/storage/d1SurfaceDataStore";
import {
  createNodeSqliteBinding,
  type D1DatabaseBinding,
  type D1PreparedStatement,
} from "~/infrastructure/storage/RuntimeBindings";
import { CREATE_SURFACE_TABLES_SQL } from "~/infrastructure/storage/surfaceStore/schema";
import { loadDatabaseSync, makeTempDbPath } from "../helpers/sqlite-fixture";
import { withD1ParameterLimit } from "../helpers/d1-limit-binding";

const DatabaseSync = await loadDatabaseSync();

async function makeManyRouteStops(count: number) {
  const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
  await db.exec(CREATE_SURFACE_TABLES_SQL);

  const routeIds = Array.from({ length: count }, (_, index) => `fictional-route-${index}`);
  const stopIds = routeIds.map((_, index) => `fictional-stop-${index}`);
  const statements: D1PreparedStatement[] = [];
  for (let index = 0; index < count; index++) {
    const routeId = routeIds[index]!;
    const stopId = stopIds[index]!;
    statements.push(
      db
        .prepare(
          "INSERT INTO stops (agency_id, id, code, name, lat, lon, wheelchair, routes_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind("sample", stopId, stopId, `Stop ${index}`, 43.6, -79.5, 1, JSON.stringify([routeId])),
      db
        .prepare("INSERT INTO stop_routes (agency_id, stop_id, route_id) VALUES (?, ?, ?)")
        .bind("sample", stopId, routeId),
    );
  }
  await db.batch(statements);
  return { db, routeIds, stopIds };
}

function throughD1ParameterLimit(db: D1DatabaseBinding) {
  const limited = withD1ParameterLimit(db);
  return { ...limited, service: makeD1SurfaceDataStoreService(limited.db, { agencyId: "sample" }) };
}

describe.skipIf(!DatabaseSync)("surface-store queries respect D1's parameter limit", () => {
  it("reads stops for 150 routes in requested route order", async () => {
    const { db, routeIds, stopIds } = await makeManyRouteStops(150);
    const limited = throughD1ParameterLimit(db);
    const requestedRoutes = [...routeIds].reverse();

    const stops = await Effect.runPromise(limited.service.getStopsForRoutes(requestedRoutes));

    expect(stops.map((stop) => stop.id)).toEqual([...stopIds].reverse());
    expect(limited.getMaxBoundCount()).toBeLessThanOrEqual(100);
  });

  it("reads 150 stop ids and restores their requested order", async () => {
    const { db, stopIds } = await makeManyRouteStops(150);
    const limited = throughD1ParameterLimit(db);

    const stops = await Effect.runPromise(limited.service.getStopsByIds([...stopIds].reverse()));

    expect(stops.map((stop) => stop.id)).toEqual([...stopIds].reverse());
    expect(limited.getMaxBoundCount()).toBeLessThanOrEqual(100);
  });
});
