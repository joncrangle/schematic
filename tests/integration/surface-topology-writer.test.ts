import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type {
  D1DatabaseBinding,
  D1PreparedStatement,
} from "~/infrastructure/storage/RuntimeBindings";
import {
  makeSurfaceTopologyWriter,
  type FetchedRouteTopology,
} from "~/infrastructure/storage/SurfaceStoreWriter";
import type { RouteDetails, SurfaceRoute, SurfaceStop } from "~/domain/surface/types";
import { createNodeSqliteBinding } from "~/infrastructure/storage/RuntimeBindings";
import { CREATE_SURFACE_TABLES_SQL } from "~/infrastructure/storage/surfaceStore/schema";
import { loadDatabaseSync, makeTempDbPath } from "../helpers/sqlite-fixture";
import { withD1ParameterLimit } from "../helpers/d1-limit-binding";

const DatabaseSync = await loadDatabaseSync();

const ROUTE: SurfaceRoute = {
  id: "501",
  shortName: "501",
  longName: "Queen",
  routeType: "streetcar",
  color: "#DA251D",
  textColor: "#FFFFFF",
};

const STOPS: readonly SurfaceStop[] = [
  {
    id: "s1",
    code: "s1",
    name: "Queen & Yonge",
    lat: 43.65,
    lon: -79.38,
    wheelchair: 1,
    routes: ["501"],
  },
];

const STOP_2: SurfaceStop = {
  id: "s2",
  code: "s2",
  name: "Queen & Bay",
  lat: 43.651,
  lon: -79.381,
  wheelchair: 1,
  routes: ["501"],
};

const STOP_3: SurfaceStop = {
  id: "s3",
  code: "s3",
  name: "Queen & Church",
  lat: 43.652,
  lon: -79.382,
  wheelchair: 1,
  routes: ["501"],
};

const DETAILS: RouteDetails = {
  route: ROUTE,
  shape: {
    id: "501_0_live",
    routeId: "501",
    directionId: 0,
    headsign: "East — 501 Queen to Neville Park",
    polyline: "polyline",
    minLat: 43.6,
    maxLat: 43.8,
    minLon: -79.5,
    maxLon: -79.3,
    pointCount: 1,
  },
  stops: STOPS,
};

function details(
  directionId: number,
  headsign: string,
  stops: readonly SurfaceStop[],
  route: SurfaceRoute = ROUTE,
  polyline = `polyline-${directionId}`,
): RouteDetails {
  return {
    route,
    shape: {
      id: `${route.id}_${directionId}_live`,
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
    stops,
  };
}

function fetched(
  routeId: string,
  detailsByDirection: ReadonlyMap<number, RouteDetails>,
  allStops: readonly SurfaceStop[],
): FetchedRouteTopology {
  return { routeId, detailsByDirection, allStops };
}

async function reconcile(
  db: D1DatabaseBinding,
  value: FetchedRouteTopology,
  agencyId = "ttc",
): Promise<Awaited<ReturnType<typeof Effect.runPromise>>> {
  return Effect.runPromise(makeSurfaceTopologyWriter({ agencyId, db }).reconcileRoute(value));
}

async function seedBothDirections(db: D1DatabaseBinding, agencyId = "ttc"): Promise<void> {
  await reconcile(
    db,
    fetched(
      ROUTE.id,
      new Map([
        [0, details(0, "East — 501 Queen to Neville Park", [STOPS[0]!, STOP_2])],
        [1, details(1, "West — 501 Queen to Long Branch", [STOP_2, STOPS[0]!])],
      ]),
      [STOPS[0]!, STOP_2],
    ),
    agencyId,
  );
}

function countedBinding(db: D1DatabaseBinding): {
  readonly db: D1DatabaseBinding;
  readonly getBatchCount: () => number;
  readonly getStatementCount: () => number;
  readonly getPreparedQueries: () => readonly string[];
} {
  let batchCount = 0;
  let statementCount = 0;
  const preparedQueries: string[] = [];
  const counted: D1DatabaseBinding = {
    prepare: (query) => {
      preparedQueries.push(query);
      return db.prepare(query);
    },
    exec: (query) => db.exec(query),
    batch: async (statements: D1PreparedStatement[]) => {
      batchCount++;
      statementCount += statements.length;
      return db.batch(statements);
    },
  };
  return {
    db: counted,
    getBatchCount: () => batchCount,
    getStatementCount: () => statementCount,
    getPreparedQueries: () => preparedQueries,
  };
}

describe.skipIf(!DatabaseSync)("SurfaceTopologyWriter", () => {
  it("reconciles 150 stops without exceeding D1's per-query parameter limit", async () => {
    const sqlite = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    const limited = withD1ParameterLimit(sqlite);
    const stops = Array.from({ length: 150 }, (_, index): SurfaceStop => ({
      id: `fictional-stop-${index}`,
      code: `fictional-stop-${index}`,
      name: `Stop ${index}`,
      lat: 43.6 + index / 100_000,
      lon: -79.5,
      wheelchair: 0,
      routes: [ROUTE.id],
    }));

    const first = await reconcile(
      limited.db,
      fetched(ROUTE.id, new Map([[0, details(0, "Eastbound", stops)]]), stops),
    );
    expect(first).toEqual({ outcome: "updated", routeId: ROUTE.id });

    const retained = stops.slice(0, 3);
    await reconcile(
      limited.db,
      fetched(ROUTE.id, new Map([[0, details(0, "Eastbound", retained)]]), retained),
    );
    const remaining = await sqlite
      .prepare("SELECT stop_id FROM stop_routes WHERE agency_id = ? AND route_id = ? ORDER BY stop_id")
      .bind("ttc", ROUTE.id)
      .all<{ stop_id: string }>();

    expect(remaining.results.map((row) => row.stop_id)).toEqual(
      retained.map((stop) => stop.id).sort(),
    );
    expect(limited.getMaxBoundCount()).toBeLessThanOrEqual(100);
  });

  it("returns unchanged without a topology batch for equivalent fetched topology", async () => {
    const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    const seedWriter = makeSurfaceTopologyWriter({ agencyId: "ttc", db });
    await Effect.runPromise(
      seedWriter.reconcileRoute({
        routeId: ROUTE.id,
        detailsByDirection: new Map([[DETAILS.shape.directionId, DETAILS]]),
        allStops: STOPS,
      }),
    );

    let batchCount = 0;
    const countedDb: D1DatabaseBinding = {
      prepare: (query) => db.prepare(query),
      exec: (query) => db.exec(query),
      batch: async (statements) => {
        batchCount++;
        return db.batch(statements);
      },
    };

    const outcome = await Effect.runPromise(
      makeSurfaceTopologyWriter({ agencyId: "ttc", db: countedDb }).reconcileRoute({
        routeId: ROUTE.id,
        detailsByDirection: new Map([[DETAILS.shape.directionId, DETAILS]]),
        allStops: STOPS,
      }),
    );

    expect(outcome).toEqual({ outcome: "unchanged", routeId: ROUTE.id });
    expect(batchCount).toBe(0);
  });

  it("updates route facts once without rewriting shapes or stops", async () => {
    const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    await seedBothDirections(db);
    const counted = countedBinding(db);
    const changedRoute = { ...ROUTE, longName: "Updated Queen" };
    const outcome = await reconcile(
      counted.db,
      fetched(
        ROUTE.id,
        new Map([
          [0, details(0, "East — 501 Queen to Neville Park", [STOPS[0]!, STOP_2], changedRoute)],
          [1, details(1, "West — 501 Queen to Long Branch", [STOP_2, STOPS[0]!], changedRoute)],
        ]),
        [STOPS[0]!, STOP_2],
      ),
    );

    expect(outcome).toEqual({ outcome: "updated", routeId: ROUTE.id });
    expect(counted.getBatchCount()).toBe(1);
    expect(counted.getStatementCount()).toBe(1);
    const row = await db
      .prepare("SELECT long_name FROM routes WHERE agency_id = ? AND id = ?")
      .bind("ttc", ROUTE.id)
      .first<{ long_name: string }>();
    expect(row?.long_name).toBe("Updated Queen");
  });

  it("updates one changed shape without rewriting route-wide stops", async () => {
    const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    await seedBothDirections(db);
    const counted = countedBinding(db);
    const changed = details(
      0,
      "East — 501 Queen to Woodbine",
      [STOPS[0]!, STOP_2],
      ROUTE,
      "polyline-0-new",
    );
    const outcome = await reconcile(
      counted.db,
      fetched(
        ROUTE.id,
        new Map([
          [0, changed],
          [1, details(1, "West — 501 Queen to Long Branch", [STOP_2, STOPS[0]!])],
        ]),
        [STOPS[0]!, STOP_2],
      ),
    );

    expect(outcome).toEqual({ outcome: "updated", routeId: ROUTE.id });
    expect(counted.getBatchCount()).toBe(1);
    expect(counted.getStatementCount()).toBe(1);
    const row = await db
      .prepare(
        "SELECT headsign, polyline FROM route_shapes WHERE agency_id = ? AND route_id = ? AND direction_id = ?",
      )
      .bind("ttc", ROUTE.id, 0)
      .first<{ headsign: string; polyline: string }>();
    expect(row).toEqual({ headsign: "East — 501 Queen to Woodbine", polyline: "polyline-0-new" });
  });

  it("reconciles changed stop facts and one direction sequence selectively", async () => {
    const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    await seedBothDirections(db);
    const changedStop = { ...STOP_2, name: "Queen & Bay Updated" };
    const counted = countedBinding(db);
    const outcome = await reconcile(
      counted.db,
      fetched(
        ROUTE.id,
        new Map([
          [0, details(0, "East — 501 Queen to Neville Park", [changedStop, STOPS[0]!])],
          [1, details(1, "West — 501 Queen to Long Branch", [changedStop, STOPS[0]!])],
        ]),
        [STOPS[0]!, changedStop],
      ),
    );

    expect(outcome).toEqual({ outcome: "updated", routeId: ROUTE.id });
    expect(counted.getBatchCount()).toBe(1);
    expect(counted.getStatementCount()).toBe(4);
    const sequence = await db
      .prepare(
        "SELECT stop_id FROM route_stops WHERE agency_id = ? AND route_id = ? AND direction_id = ? ORDER BY stop_sequence",
      )
      .bind("ttc", ROUTE.id, 0)
      .all<{ stop_id: string }>();
    expect(sequence.results.map((row) => row.stop_id)).toEqual(["s2", "s1"]);
    const stop = await db
      .prepare("SELECT name FROM stops WHERE agency_id = ? AND id = ?")
      .bind("ttc", STOP_2.id)
      .first<{ name: string }>();
    expect(stop?.name).toBe("Queen & Bay Updated");
  });

  it("writes both changed directions and route-wide memberships in one atomic batch", async () => {
    const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    await seedBothDirections(db);
    const counted = countedBinding(db);
    const outcome = await reconcile(
      counted.db,
      fetched(
        ROUTE.id,
        new Map([
          [0, details(0, "East — 501 Queen to Neville Park", [STOPS[0]!, STOP_3])],
          [1, details(1, "West — 501 Queen to Long Branch", [STOP_3, STOPS[0]!])],
        ]),
        [STOPS[0]!, STOP_3],
      ),
    );

    expect(outcome).toEqual({ outcome: "updated", routeId: ROUTE.id });
    expect(counted.getBatchCount()).toBe(1);
    const routeStops = await db
      .prepare(
        "SELECT stop_id FROM stop_routes WHERE agency_id = ? AND route_id = ? ORDER BY stop_id",
      )
      .bind("ttc", ROUTE.id)
      .all<{ stop_id: string }>();
    expect(routeStops.results.map((row) => row.stop_id)).toEqual(["s1", "s3"]);
    const stale = await db
      .prepare("SELECT routes_json FROM stops WHERE agency_id = ? AND id = ?")
      .bind("ttc", STOP_2.id)
      .first<{ routes_json: string }>();
    expect(stale?.routes_json).toBe("[]");
  });

  it("preserves stored geometry when an empty incoming polyline has other changes", async () => {
    const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    await seedBothDirections(db);
    const counted = countedBinding(db);
    const incoming = details(0, "East — Updated destination", [STOPS[0]!, STOP_2], ROUTE, "");
    const outcome = await reconcile(
      counted.db,
      fetched(
        ROUTE.id,
        new Map([
          [0, incoming],
          [1, details(1, "West — 501 Queen to Long Branch", [STOP_2, STOPS[0]!])],
        ]),
        [STOPS[0]!, STOP_2],
      ),
    );

    expect(outcome).toEqual({ outcome: "updated", routeId: ROUTE.id });
    const shape = await db
      .prepare(
        "SELECT headsign, polyline FROM route_shapes WHERE agency_id = ? AND route_id = ? AND direction_id = ?",
      )
      .bind("ttc", ROUTE.id, 0)
      .first<{ headsign: string; polyline: string }>();
    expect(shape).toEqual({ headsign: "East — Updated destination", polyline: "polyline-0" });
  });

  it("clears stored geometry when an empty shape changes the stop pattern", async () => {
    const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    await reconcile(
      db,
      fetched(
        ROUTE.id,
        new Map([[0, details(0, "East — 501 Queen to Neville Park", [STOPS[0]!, STOP_2])]]),
        [STOPS[0]!, STOP_2],
      ),
    );

    await reconcile(
      db,
      fetched(
        ROUTE.id,
        new Map([
          [0, details(0, "East — 501 Queen to Neville Park", [STOPS[0]!, STOP_3], ROUTE, "")],
        ]),
        [STOPS[0]!, STOP_3],
      ),
    );

    const shape = await db
      .prepare(
        "SELECT polyline FROM route_shapes WHERE agency_id = ? AND route_id = ? AND direction_id = ?",
      )
      .bind("ttc", ROUTE.id, 0)
      .first<{ polyline: string }>();
    const sequence = await db
      .prepare(
        "SELECT stop_id FROM route_stops WHERE agency_id = ? AND route_id = ? AND direction_id = ? ORDER BY stop_sequence",
      )
      .bind("ttc", ROUTE.id, 0)
      .all<{ stop_id: string }>();
    expect(shape?.polyline).toBe("");
    expect(sequence.results.map((row) => row.stop_id)).toEqual([STOPS[0]!.id, STOP_3.id]);
  });

  it("removes legacy duplicate shape rows while preserving the canonical row", async () => {
    const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    await reconcile(db, fetched(ROUTE.id, new Map([[0, DETAILS]]), STOPS));
    await db
      .prepare(
        "INSERT INTO route_shapes (agency_id, id, route_id, direction_id, headsign, polyline, min_lat, max_lat, min_lon, max_lon, point_count, direction_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        "ttc",
        "501_0_live",
        ROUTE.id,
        0,
        "Stale live shape",
        "stale-polyline",
        43.6,
        43.8,
        -79.5,
        -79.3,
        2,
        "Eastbound",
      )
      .run();

    await reconcile(db, fetched(ROUTE.id, new Map([[0, DETAILS]]), STOPS));

    const rows = await db
      .prepare(
        "SELECT id FROM route_shapes WHERE agency_id = ? AND route_id = ? AND direction_id = ?",
      )
      .bind("ttc", ROUTE.id, 0)
      .all<{ id: string }>();
    expect(rows.results.map((row) => row.id)).toEqual(["501_0_canonical"]);
  });

  it("does not erase a seeded parent-station feed id when a live refresh omits it", async () => {
    const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    await db.exec(CREATE_SURFACE_TABLES_SQL);
    await db
      .prepare(
        "INSERT INTO routes (agency_id, id, short_name, long_name, route_type, color, text_color) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind("ttc", "97", "97", "Yonge", 3, "#DA251D", "#FFFFFF")
      .run();
    await db
      .prepare(
        "INSERT INTO stops (agency_id, id, code, name, lat, lon, wheelchair, parent_station, routes_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        "ttc",
        "stop-1",
        "stop-1",
        "Yonge at Bathurst",
        43.666447,
        -79.411186,
        1,
        "99962",
        '["97"]',
      )
      .run();

    const route: SurfaceRoute = {
      id: "97",
      shortName: "97",
      longName: "Yonge",
      routeType: "bus",
      color: "#DA251D",
      textColor: "#FFFFFF",
    };
    const stop: SurfaceStop = {
      id: "stop-1",
      code: "stop-1",
      name: "Yonge at Bathurst",
      lat: 43.666447,
      lon: -79.411186,
      routes: ["97"],
      wheelchair: 1,
    };
    await reconcile(
      db,
      fetched(
        route.id,
        new Map([[0, details(0, "North - 97 Yonge to Steeles", [stop], route, "")]]),
        [stop],
      ),
    );

    const row = await db
      .prepare("SELECT parent_station FROM stops WHERE id = ?")
      .bind(stop.id)
      .first<{ parent_station: string | null }>();
    expect(row?.parent_station).toBe("99962");
  });

  it("preserves co-located route memberships when refreshing a shared stop", async () => {
    const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    const otherRoute = { ...ROUTE, id: "700", shortName: "700", longName: "Other route" };
    const sharedStop = { ...STOPS[0]!, routes: [ROUTE.id, otherRoute.id] };
    await reconcile(
      db,
      fetched(
        otherRoute.id,
        new Map([[0, details(0, "700 to Terminal", [sharedStop], otherRoute)]]),
        [sharedStop],
      ),
    );

    const refreshed = { ...sharedStop, name: "Updated Queen & Yonge", routes: [ROUTE.id] };
    await reconcile(
      db,
      fetched(
        ROUTE.id,
        new Map([[0, details(0, "East — 501 Queen to Neville Park", [refreshed])]]),
        [refreshed],
      ),
    );

    const memberships = await db
      .prepare(
        "SELECT route_id FROM stop_routes WHERE agency_id = ? AND stop_id = ? ORDER BY route_id",
      )
      .bind("ttc", sharedStop.id)
      .all<{ route_id: string }>();
    const stop = await db
      .prepare("SELECT routes_json FROM stops WHERE agency_id = ? AND id = ?")
      .bind("ttc", sharedStop.id)
      .first<{ routes_json: string }>();
    expect(memberships.results.map((row) => row.route_id)).toEqual([ROUTE.id, otherRoute.id]);
    expect(JSON.parse(stop!.routes_json).sort()).toEqual([ROUTE.id, otherRoute.id].sort());
  });

  it("does not index foreign route ids supplied on a live stop payload", async () => {
    const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    const misleadingStop = { ...STOPS[0]!, routes: [ROUTE.id, "700"] };

    await reconcile(
      db,
      fetched(ROUTE.id, new Map([[0, details(0, "East — 501 Queen", [misleadingStop])]]), [
        misleadingStop,
      ]),
    );

    const memberships = await db
      .prepare("SELECT route_id FROM stop_routes WHERE agency_id = ? AND stop_id = ?")
      .bind("ttc", misleadingStop.id)
      .all<{ route_id: string }>();
    const stop = await db
      .prepare("SELECT routes_json FROM stops WHERE agency_id = ? AND id = ?")
      .bind("ttc", misleadingStop.id)
      .first<{ routes_json: string }>();
    expect(memberships.results.map((row) => row.route_id)).toEqual([ROUTE.id]);
    expect(JSON.parse(stop!.routes_json)).toEqual([ROUTE.id]);
  });

  it("removes a refreshed route while preserving a co-located route", async () => {
    const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    const otherRoute = { ...ROUTE, id: "700", shortName: "700", longName: "Other route" };
    const sharedStop = { ...STOPS[0]!, routes: [ROUTE.id, otherRoute.id] };
    await reconcile(
      db,
      fetched(
        otherRoute.id,
        new Map([[0, details(0, "700 to Terminal", [sharedStop], otherRoute)]]),
        [sharedStop],
      ),
    );
    await reconcile(
      db,
      fetched(ROUTE.id, new Map([[0, details(0, "East — 501", [sharedStop, STOP_2])]]), [
        sharedStop,
        STOP_2,
      ]),
    );

    await reconcile(
      db,
      fetched(ROUTE.id, new Map([[0, details(0, "East — 501", [STOPS[0]!])]]), [sharedStop]),
    );

    const currentMemberships = await db
      .prepare(
        "SELECT route_id FROM stop_routes WHERE agency_id = ? AND stop_id = ? ORDER BY route_id",
      )
      .bind("ttc", STOPS[0]!.id)
      .all<{ route_id: string }>();
    const removedMemberships = await db
      .prepare("SELECT route_id FROM stop_routes WHERE agency_id = ? AND stop_id = ?")
      .bind("ttc", STOP_2.id)
      .all<{ route_id: string }>();
    expect(currentMemberships.results.map((row) => row.route_id)).toEqual([
      ROUTE.id,
      otherRoute.id,
    ]);
    expect(removedMemberships.results).toEqual([]);
  });

  it("removes every membership when a refreshed route has no stops", async () => {
    const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    await reconcile(
      db,
      fetched(ROUTE.id, new Map([[0, details(0, "East — 501", [STOPS[0]!, STOP_2])]]), [
        STOPS[0]!,
        STOP_2,
      ]),
    );

    await reconcile(db, fetched(ROUTE.id, new Map([[0, details(0, "East — 501", [])]]), []));

    const memberships = await db
      .prepare("SELECT stop_id FROM stop_routes WHERE agency_id = ? AND route_id = ?")
      .bind("ttc", ROUTE.id)
      .all<{ stop_id: string }>();
    expect(memberships.results).toEqual([]);
  });

  it("preserves stored shapes and memberships for a missing direction", async () => {
    const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    await seedBothDirections(db);
    const incoming = details(0, "East — 501 Queen to Neville Park", [STOPS[0]!]);
    const outcome = await reconcile(db, fetched(ROUTE.id, new Map([[0, incoming]]), [STOPS[0]!]));

    expect(outcome).toEqual({ outcome: "updated", routeId: ROUTE.id });
    const storedDirection = await db
      .prepare(
        "SELECT headsign FROM route_shapes WHERE agency_id = ? AND route_id = ? AND direction_id = ?",
      )
      .bind("ttc", ROUTE.id, 1)
      .first<{ headsign: string }>();
    expect(storedDirection?.headsign).toBe("West — 501 Queen to Long Branch");
    const memberships = await db
      .prepare(
        "SELECT stop_id FROM stop_routes WHERE agency_id = ? AND route_id = ? ORDER BY stop_id",
      )
      .bind("ttc", ROUTE.id)
      .all<{ stop_id: string }>();
    expect(memberships.results.map((row) => row.stop_id)).toEqual(["s1", "s2"]);
  });

  it("returns source-absent for an empty direction map without reading or writing", async () => {
    let prepareCount = 0;
    let batchCount = 0;
    const db: D1DatabaseBinding = {
      prepare: () => {
        prepareCount++;
        throw new Error("source-absent must not read");
      },
      exec: async () => {},
      batch: async () => {
        batchCount++;
      },
    };

    const outcome = await reconcile(db, fetched("501", new Map(), []));
    expect(outcome).toEqual({ outcome: "source-absent", routeId: "501" });
    expect(prepareCount).toBe(0);
    expect(batchCount).toBe(0);
  });

  it("reports a storage read failure with its agency, route, and phase", async () => {
    const db: D1DatabaseBinding = {
      prepare: () => {
        throw new Error("database unavailable");
      },
      exec: async () => {},
      batch: async () => {},
    };

    await expect(
      reconcile(db, fetched(ROUTE.id, new Map([[0, DETAILS]]), STOPS)),
    ).rejects.toMatchObject({
      agencyId: "ttc",
      routeId: ROUTE.id,
      phase: "read",
      cause: { message: "database unavailable" },
    });
  });

  it("scopes route, shape, stop, and membership writes to the bound agency", async () => {
    const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    await seedBothDirections(db, "ttc");
    await seedBothDirections(db, "go");

    await reconcile(
      db,
      fetched(
        ROUTE.id,
        new Map([
          [
            0,
            details(0, "East — 501 Queen to Updated Terminal", [STOPS[0]!, STOP_2], {
              ...ROUTE,
              longName: "TTC Queen",
            }),
          ],
          [
            1,
            details(1, "West — 501 Queen to Updated Terminal", [STOP_2, STOPS[0]!], {
              ...ROUTE,
              longName: "TTC Queen",
            }),
          ],
        ]),
        [STOPS[0]!, STOP_2],
      ),
      "ttc",
    );

    const goRoute = await db
      .prepare("SELECT long_name FROM routes WHERE agency_id = ? AND id = ?")
      .bind("go", ROUTE.id)
      .first<{ long_name: string }>();
    const ttcRoute = await db
      .prepare("SELECT long_name FROM routes WHERE agency_id = ? AND id = ?")
      .bind("ttc", ROUTE.id)
      .first<{ long_name: string }>();
    expect(goRoute?.long_name).toBe(ROUTE.longName);
    expect(ttcRoute?.long_name).toBe("TTC Queen");
  });

  it.each([
    {
      name: "a nonblank route id mismatch",
      value: fetched("different", new Map([[0, DETAILS]]), STOPS),
    },
    {
      name: "a direction map key mismatch",
      value: fetched(ROUTE.id, new Map([[1, DETAILS]]), STOPS),
    },
    {
      name: "inconsistent route facts",
      value: fetched(
        ROUTE.id,
        new Map([
          [0, DETAILS],
          [1, details(1, "West — 501 Queen to Long Branch", STOPS, { ...ROUTE, color: "#000000" })],
        ]),
        STOPS,
      ),
    },
    {
      name: "a directional stop absent from the union",
      value: fetched(ROUTE.id, new Map([[0, DETAILS]]), []),
    },
    {
      name: "conflicting duplicate stop facts",
      value: fetched(ROUTE.id, new Map([[0, DETAILS]]), [
        { ...STOPS[0]!, name: "Other stop" },
        STOPS[0]!,
      ]),
    },
  ])("rejects $name before mutation", async ({ value }) => {
    const db = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    await db.exec(
      "CREATE TABLE routes (agency_id TEXT NOT NULL, id TEXT NOT NULL, short_name TEXT NOT NULL, long_name TEXT NOT NULL, route_type INTEGER NOT NULL, color TEXT NOT NULL, text_color TEXT NOT NULL, PRIMARY KEY (agency_id, id))",
    );
    const counted = countedBinding(db);

    await expect(reconcile(counted.db, value)).rejects.toMatchObject({
      agencyId: "ttc",
      phase: "validation",
    });
    expect(counted.getBatchCount()).toBe(0);
    const rows = await db
      .prepare("SELECT COUNT(*) AS count FROM routes WHERE agency_id = ?")
      .bind("ttc")
      .first<{ count: number }>();
    expect(rows?.count).toBe(0);
  });

  it("reports a failed atomic batch and leaves no partial route topology", async () => {
    const base = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    const failingDb: D1DatabaseBinding = {
      prepare: (query) => base.prepare(query),
      exec: (query) => base.exec(query),
      batch: (statements) =>
        base.batch([
          ...statements,
          base.prepare("INSERT INTO table_that_does_not_exist (id) VALUES (?)").bind("boom"),
        ]),
    };

    await expect(
      reconcile(failingDb, fetched(ROUTE.id, new Map([[0, DETAILS]]), STOPS)),
    ).rejects.toMatchObject({
      agencyId: "ttc",
      routeId: ROUTE.id,
      phase: "commit",
    });
    const routes = await base
      .prepare("SELECT COUNT(*) AS count FROM routes WHERE agency_id = ?")
      .bind("ttc")
      .first<{ count: number }>();
    expect(routes?.count).toBe(0);
  });
});
