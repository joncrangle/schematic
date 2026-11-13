import { describe, expect, it } from "vitest";
import {
  ensureSurfaceSchema,
  SURFACE_SCHEMA_OBJECT_NAMES,
  SURFACE_SCHEMA_STATEMENTS,
  CREATE_SURFACE_TABLES_SQL,
} from "~/infrastructure/storage/surfaceStore/schema";
import { TRANSIT_SEED_SCHEMA_STATEMENTS } from "../../scripts/lib/gtfs-seeder-core";
import {
  createSyncSqliteBinding,
  type D1DatabaseBinding,
  type SqliteDatabaseLike,
} from "~/infrastructure/storage/RuntimeBindings";
import { loadDatabaseSync } from "../helpers/sqlite-fixture";

const DatabaseSync = await loadDatabaseSync();
const sqliteAvailable = DatabaseSync !== null;

function makeMemoryBinding(): { raw: SqliteDatabaseLike; binding: D1DatabaseBinding } {
  const raw = new DatabaseSync!(":memory:") as unknown as SqliteDatabaseLike;
  const binding = createSyncSqliteBinding(raw);
  return { raw, binding };
}

interface TableColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface IndexInfo {
  name: string;
  tbl_name: string;
}

const EXPECTED_SURFACE_TABLES = [
  "routes",
  "stops",
  "route_shapes",
  "route_stops",
  "stop_routes",
  "topology_meta",
] as const;

describe("Surface Store Schema", () => {
  describe("wire-format regression guard", () => {
    it("keeps every statement on one physical line in the Miniflare bootstrap", () => {
      expect(CREATE_SURFACE_TABLES_SQL).toBe(`${SURFACE_SCHEMA_STATEMENTS.join(";\n")};`);
      for (const statement of SURFACE_SCHEMA_STATEMENTS) {
        expect(statement).not.toMatch(/[\r\n]/);
      }
    });
  });

  describe("cold-isolate probe", () => {
    it("names an object for every schema statement so none escapes the probe", () => {
      expect(SURFACE_SCHEMA_OBJECT_NAMES).toHaveLength(SURFACE_SCHEMA_STATEMENTS.length);
    });
  });

  describe.skipIf(!sqliteAvailable)("canonical schema behavior matrix", () => {
    const setupBootstrap = async () => {
      const { raw, binding } = makeMemoryBinding();
      await ensureSurfaceSchema(binding);
      return { raw, binding };
    };

    const setupSeeder = async () => {
      const { raw, binding } = makeMemoryBinding();
      await binding.exec(`${TRANSIT_SEED_SCHEMA_STATEMENTS.join(";\n")};`);
      return { raw, binding };
    };

    const targets = [
      ["runtime bootstrap", setupBootstrap],
      ["seeder schema execution", setupSeeder],
    ] as const;

    it.each(targets)("provisions all surface topology tables via %s", async (_name, setup) => {
      const { binding } = await setup();
      const tablesResult = await binding
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all<{ name: string }>();
      const tableNames = tablesResult.results.map((r) => r.name);

      for (const expectedTable of EXPECTED_SURFACE_TABLES) {
        expect(tableNames).toContain(expectedTable);
      }
    });

    it.each(targets)(
      "establishes identical table columns and primary keys via %s",
      async (_name, setup) => {
        const { raw } = await setup();

        const getColumns = (table: string): TableColumnInfo[] =>
          raw.prepare(`PRAGMA table_info(${table})`).all() as TableColumnInfo[];

        const routesCols = getColumns("routes");
        expect(routesCols.map((c) => c.name)).toEqual([
          "agency_id",
          "id",
          "short_name",
          "long_name",
          "route_type",
          "color",
          "text_color",
        ]);
        expect(routesCols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(["agency_id", "id"]);

        const stopsCols = getColumns("stops");
        expect(stopsCols.map((c) => c.name)).toEqual([
          "agency_id",
          "id",
          "code",
          "name",
          "lat",
          "lon",
          "wheelchair",
          "parent_station",
          "routes_json",
        ]);
        expect(stopsCols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(["agency_id", "id"]);

        const shapesCols = getColumns("route_shapes");
        expect(shapesCols.map((c) => c.name)).toEqual([
          "agency_id",
          "id",
          "route_id",
          "direction_id",
          "headsign",
          "polyline",
          "min_lat",
          "max_lat",
          "min_lon",
          "max_lon",
          "point_count",
          "direction_label",
        ]);
        expect(shapesCols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(["agency_id", "id"]);

        const routeStopsCols = getColumns("route_stops");
        expect(routeStopsCols.map((c) => c.name)).toEqual([
          "agency_id",
          "route_id",
          "direction_id",
          "stop_sequence",
          "stop_id",
        ]);
        expect(routeStopsCols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual([
          "agency_id",
          "route_id",
          "direction_id",
          "stop_sequence",
        ]);

        const stopRoutesCols = getColumns("stop_routes");
        expect(stopRoutesCols.map((c) => c.name)).toEqual(["agency_id", "stop_id", "route_id"]);
        const stopRoutesPk = Object.fromEntries(stopRoutesCols.map((c) => [c.name, c.pk]));
        expect(stopRoutesPk).toEqual({ agency_id: 1, route_id: 2, stop_id: 3 });

        const topologyMetaCols = getColumns("topology_meta");
        expect(topologyMetaCols.map((c) => c.name)).toEqual(["agency_id", "last_sync"]);
        expect(topologyMetaCols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(["agency_id"]);
      },
    );

    it.each(targets)(
      "establishes required indexes on surface tables via %s",
      async (_name, setup) => {
        const { raw } = await setup();
        const indexes = raw
          .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index'")
          .all() as IndexInfo[];
        const indexNames = indexes.map((i) => i.name);

        expect(indexNames).toContain("idx_stops_agency_lat_lon");
        expect(indexNames).toContain("idx_stops_agency_code");
        expect(indexNames).toContain("idx_route_shapes_route");
        expect(indexNames).toContain("idx_route_stops_stop");
      },
    );

    it.each(targets)(
      "accepts representative surface inserts and indexed reads via %s",
      async (_name, setup) => {
        const { binding } = await setup();

        await binding
          .prepare(
            "INSERT INTO routes (agency_id, id, short_name, long_name, route_type, color, text_color) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .bind("ttc", "501", "501", "Queen", 0, "DA251D", "FFFFFF")
          .run();

        await binding
          .prepare(
            "INSERT INTO stops (agency_id, id, code, name, lat, lon, wheelchair, parent_station, routes_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .bind("ttc", "s1", "14330", "Queen & Yonge", 43.652, -79.379, 1, null, '["501"]')
          .run();

        await binding
          .prepare(
            "INSERT INTO route_shapes (agency_id, id, route_id, direction_id, headsign, polyline, min_lat, max_lat, min_lon, max_lon, point_count, direction_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(
            "ttc",
            "shape_501_0",
            "501",
            0,
            "Eastbound",
            "abcd",
            43.6,
            43.7,
            -79.4,
            -79.3,
            10,
            "East",
          )
          .run();

        await binding
          .prepare(
            "INSERT INTO route_stops (agency_id, route_id, direction_id, stop_sequence, stop_id) VALUES (?, ?, ?, ?, ?)",
          )
          .bind("ttc", "501", 0, 1, "s1")
          .run();

        await binding
          .prepare("INSERT INTO stop_routes (agency_id, stop_id, route_id) VALUES (?, ?, ?)")
          .bind("ttc", "s1", "501")
          .run();

        await binding
          .prepare("INSERT INTO topology_meta (agency_id, last_sync) VALUES (?, ?)")
          .bind("ttc", 1700000000)
          .run();

        // Indexed read on stops by (agency_id, lat, lon)
        const stopsGeo = await binding
          .prepare(
            "SELECT id, name FROM stops WHERE agency_id = ? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
          )
          .bind("ttc", 43.65, 43.66, -79.38, -79.37)
          .all<{ id: string; name: string }>();
        expect(stopsGeo.results).toEqual([{ id: "s1", name: "Queen & Yonge" }]);

        // Indexed read on stops by (agency_id, code)
        const stopByCode = await binding
          .prepare("SELECT id FROM stops WHERE agency_id = ? AND code = ?")
          .bind("ttc", "14330")
          .first<{ id: string }>();
        expect(stopByCode).toEqual({ id: "s1" });

        // Indexed read on route_shapes by (agency_id, route_id, direction_id)
        const shape = await binding
          .prepare(
            "SELECT id, direction_label FROM route_shapes WHERE agency_id = ? AND route_id = ? AND direction_id = ?",
          )
          .bind("ttc", "501", 0)
          .first<{ id: string; direction_label: string }>();
        expect(shape).toEqual({ id: "shape_501_0", direction_label: "East" });

        // Indexed read on route_stops by (agency_id, stop_id)
        const routeStops = await binding
          .prepare("SELECT route_id FROM route_stops WHERE agency_id = ? AND stop_id = ?")
          .bind("ttc", "s1")
          .all<{ route_id: string }>();
        expect(routeStops.results).toEqual([{ route_id: "501" }]);

        // Indexed read on stop_routes by (agency_id, route_id) (prefix match on composite PK)
        const stopRoutes = await binding
          .prepare("SELECT stop_id FROM stop_routes WHERE agency_id = ? AND route_id = ?")
          .bind("ttc", "501")
          .all<{ stop_id: string }>();
        expect(stopRoutes.results).toEqual([{ stop_id: "s1" }]);

        // Read topology_meta
        const meta = await binding
          .prepare("SELECT last_sync FROM topology_meta WHERE agency_id = ?")
          .bind("ttc")
          .first<{ last_sync: number }>();
        expect(meta).toEqual({ last_sync: 1700000000 });
      },
    );
  });

  describe.skipIf(!sqliteAvailable)("runtime bootstrap behavior", () => {
    it("is idempotent when called multiple times on the same binding", async () => {
      const { binding } = makeMemoryBinding();
      await ensureSurfaceSchema(binding);
      // Second call should resolve without error
      await expect(ensureSurfaceSchema(binding)).resolves.toBeUndefined();
    });

    it("costs one read and no DDL for a cold isolate on a fully provisioned database", async () => {
      const { binding } = makeMemoryBinding();
      await ensureSurfaceSchema(binding);
      const queries: string[] = [];
      const execs: string[] = [];
      const coldIsolate: D1DatabaseBinding = {
        prepare: (sql) => {
          queries.push(sql);
          return binding.prepare(sql);
        },
        exec: (sql) => {
          execs.push(sql);
          return binding.exec(sql);
        },
        batch: binding.batch,
      };

      await ensureSurfaceSchema(coldIsolate);

      expect(queries).toHaveLength(1);
      expect(execs).toEqual([]);
    });

    it("re-runs the DDL when any schema object is missing", async () => {
      const { binding } = makeMemoryBinding();
      await ensureSurfaceSchema(binding);
      await binding.exec("DROP INDEX idx_stops_agency_code");
      const execs: string[] = [];
      const coldIsolate: D1DatabaseBinding = {
        prepare: binding.prepare,
        exec: (sql) => {
          execs.push(sql);
          return binding.exec(sql);
        },
        batch: binding.batch,
      };

      await ensureSurfaceSchema(coldIsolate);

      expect(execs).toEqual([CREATE_SURFACE_TABLES_SQL]);
      const restored = await binding
        .prepare("SELECT name FROM sqlite_master WHERE name = 'idx_stops_agency_code'")
        .first();
      expect(restored).not.toBeNull();
    });

    it("coalesces concurrent bootstrap calls into a single flight", async () => {
      const { binding } = makeMemoryBinding();
      const p1 = ensureSurfaceSchema(binding);
      const p2 = ensureSurfaceSchema(binding);
      expect(p1).toBe(p2);
      await Promise.all([p1, p2]);
    });

    it("evicts failed bootstrap so subsequent calls retry", async () => {
      const { binding } = makeMemoryBinding();
      const originalExec = binding.exec;
      let shouldFail = true;
      binding.exec = async (sql: string) => {
        if (shouldFail) {
          throw new Error("synthetic disk full");
        }
        return originalExec(sql);
      };

      await expect(ensureSurfaceSchema(binding)).rejects.toThrow("synthetic disk full");

      shouldFail = false;
      await expect(ensureSurfaceSchema(binding)).resolves.toBeUndefined();
    });
  });
});
