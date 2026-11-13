import { describe, expect, it } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const bunAvailable = spawnSync("bun", ["--version"]).status === 0;
if (process.env.CI && !bunAvailable) {
  throw new Error("SQLite seeder integration tests require Bun in CI");
}

describe.skipIf(!bunAvailable)("manual Bun SQLite seeder", () => {
  it("initializes SQLite without a source checkout or generated artifact writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runtime-init-"));
    try {
      const { stdout } = await promisify(execFile)("bun", ["-e", `
        import { mock } from "bun:test";
        import { Database } from "bun:sqlite";
        import { readdirSync } from "node:fs";
        import { join } from "node:path";
        import assert from "node:assert/strict";
        import { testAgencyCatalog } from "./tests/helpers/agency-fixtures.ts";
        import { topologyArchive } from "./tests/helpers/gtfsArchive.ts";
        mock.module("./src/agencies/agencyCatalog.ts", () => ({ agencyCatalog: testAgencyCatalog }));
        const { runSeeder } = await import("./scripts/seed.ts");
        globalThis.fetch = async () => { throw new Error("network leak"); };
        const root = process.env.RUNTIME_INIT_TEST_ROOT;
        process.chdir(root);
        process.env.DATA_DIR = join(root, "data");
        const result = await runSeeder({
          agencies: ["sample"], dbTarget: "sqlite", databaseOnly: true,
          fetchArchives: async () => ({ buffers: [Buffer.from(topologyArchive())], failures: [] }),
        });
        assert.deepEqual(result.seededAgencyIds, ["sample"]);
        const db = new Database(join(root, "data/transit.db"), { readonly: true });
        assert.equal(db.query("SELECT count(*) AS n FROM routes WHERE agency_id = 'sample'").get().n, 1);
        db.close();
        assert.deepEqual(readdirSync(root), ["data"]);
        console.log("RUNTIME_INIT_OK");
      `], { env: { ...process.env, RUNTIME_INIT_TEST_ROOT: dir } });
      expect(stdout).toContain("RUNTIME_INIT_OK");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is incremental, agency-isolated, and preserves existing feed_metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seed-sqlite-"));
    try {
      const { stdout } = await promisify(execFile)(
        "bun",
        [
          "-e",
          `
        import { Database } from "bun:sqlite";
        import { seedAgencySqlite, deriveAgencySeedConfig, readSeededTables } from "./scripts/lib/gtfs-seeder-core.ts";
        import { projectGtfsTopology } from "./src/infrastructure/gtfs/staticTopology.ts";
        import { topologyArchive } from "./tests/helpers/gtfsArchive.ts";
        import assert from "node:assert/strict";
        globalThis.fetch = async () => { throw new Error("network leak"); };
        const path = process.env.SEED_TEST_DB_PATH;
        const { makeTestProvider } = await import("./tests/helpers/agency-fixtures.ts");
        const config = { ...deriveAgencySeedConfig(makeTestProvider({modes:["bus"],stationService:{routeType:"bus"}})), routeTypes: new Set([3]), routeIdField: "id" };
        const seed = async (options = {}) => {
          const archive = Buffer.from(topologyArchive(options));
          const topology = await projectGtfsTopology([archive], config);
          return seedAgencySqlite(config, archive, path, topology);
        };
        await seed();
        await seedAgencySqlite({ ...config, id: "other" }, Buffer.from(topologyArchive()), path);
        const db = new Database(path);
        db.exec("INSERT INTO feed_metadata (agency_id, key, value) VALUES ('sample', 'curated', 'keep me'); CREATE TABLE mutation_log (table_name TEXT NOT NULL)");
        for (const table of ["routes", "stops", "route_shapes", "route_stops", "stop_routes", "topology_meta", "seed_topology_meta"]) {
          for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
            const row = operation === "DELETE" ? "OLD" : "NEW";
            db.exec("CREATE TRIGGER audit_" + table + "_" + operation + " AFTER " + operation + " ON " + table + " WHEN " + row + ".agency_id = 'sample' BEGIN INSERT INTO mutation_log VALUES ('" + table + "'); END");
          }
        }
        await seed();
        await seed({ marker: "repacked" });
        assert.equal(db.query("SELECT COUNT(*) AS n FROM mutation_log").get().n, 0);
        const healthy = readSeededTables(path, "sample");
        const hashes = db.query("SELECT * FROM seed_topology_meta WHERE agency_id = 'sample'").get();
        db.exec("DELETE FROM stops WHERE agency_id = 'sample' AND id = '3'; UPDATE stops SET name = 'Damaged' WHERE agency_id = 'sample' AND id = '1'; DELETE FROM route_stops WHERE agency_id = 'sample' AND stop_sequence = 3; UPDATE route_stops SET stop_id = '2' WHERE agency_id = 'sample' AND stop_sequence = 1; DELETE FROM stop_routes WHERE agency_id = 'sample' AND stop_id = '3'");
        assert.deepEqual(db.query("SELECT * FROM seed_topology_meta WHERE agency_id = 'sample'").get(), hashes);
        db.exec("DELETE FROM mutation_log");
        await seed();
        assert.deepEqual(readSeededTables(path, "sample"), healthy);
        assert.deepEqual(db.query("SELECT table_name FROM mutation_log ORDER BY table_name").all().map(r => r.table_name), ["route_stops", "route_stops", "seed_topology_meta", "stop_routes", "stops", "stops", "topology_meta"]);
        db.exec("DELETE FROM mutation_log");
        await seed();
        assert.equal(db.query("SELECT COUNT(*) AS n FROM mutation_log").get().n, 0);
        db.exec("UPDATE seed_topology_meta SET table_hashes_json = 'INVALID JSON' WHERE agency_id = 'sample'; DELETE FROM mutation_log");
        await seed();
        assert.equal(db.query("SELECT COUNT(*) AS n FROM mutation_log").get().n, 0);
        assert.equal(db.query("SELECT table_hashes_json FROM seed_topology_meta WHERE agency_id = 'sample'").get().table_hashes_json, "INVALID JSON");
        await seed({ moved: true });
        assert.deepEqual(db.query("SELECT table_name FROM mutation_log ORDER BY table_name").all().map(r => r.table_name), ["seed_topology_meta", "stops", "topology_meta"]);
        db.exec("DELETE FROM mutation_log");
        await seed({ moved: true, removed: true });
        assert.deepEqual(db.query("SELECT table_name FROM mutation_log ORDER BY table_name").all().map(r => r.table_name), ["route_stops", "seed_topology_meta", "stop_routes", "stops", "topology_meta"]);
        assert.equal(db.query("SELECT COUNT(*) AS n FROM stops WHERE agency_id = 'other'").get().n, 3);
        const tables = readSeededTables(path, "sample");
        assert.equal(tables.find(t => t.table === "stop_routes").rows.length, 2);
        assert.deepEqual(tables.find(t => t.table === "feed_metadata").rows, [{ agency_id: "sample", key: "curated", value: "keep me" }]);
        db.close();
        console.log("SQLITE_INCREMENTAL_OK");
      `,
        ],
        { env: { ...process.env, SEED_TEST_DB_PATH: join(dir, "transit.db") } },
      );
      expect(stdout).toContain("SQLITE_INCREMENTAL_OK");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("preserves existing topology when a multi-feed refresh is incomplete", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seed-partial-multifeed-"));
    try {
      const { stdout } = await promisify(execFile)(
        "bun",
        [
          "-e",
          `
        import { Database } from "bun:sqlite";
        import { deriveAgencySeedConfig, seedAgencySqlite, readSeededTables } from "./scripts/lib/gtfs-seeder-core.ts";
        import { topologyArchive } from "./tests/helpers/gtfsArchive.ts";
        import assert from "node:assert/strict";
        const { makeTestProvider } = await import("./tests/helpers/agency-fixtures.ts");
        const provider = makeTestProvider({
          id: "fictional-multi-feed",
          modes: ["bus"],
          stationService: { routeType: "bus" },
          staticTopology: { source: "seed", feeds: [
            { url: "https://example.test/bus.zip", cacheFileName: "bus.zip" },
            { url: "https://example.test/rail.zip", cacheFileName: "rail.zip" },
          ] },
        });
        const config = { ...deriveAgencySeedConfig(provider), routeTypes: new Set([3]), routeIdField: "id" };
        const path = process.env.SEED_TEST_DB_PATH;
        const original = Buffer.from(topologyArchive());
        await seedAgencySqlite(config, [original, original], path);
        const before = readSeededTables(path, config.id);
        const db = new Database(path);
        db.exec("CREATE TABLE mutation_log (table_name TEXT NOT NULL)");
        for (const table of ["routes", "stops", "route_shapes", "route_stops", "stop_routes", "topology_meta", "seed_topology_meta"]) {
          for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
            const row = operation === "DELETE" ? "OLD" : "NEW";
            db.exec("CREATE TRIGGER audit_" + table + "_" + operation + " AFTER " + operation + " ON " + table + " WHEN " + row + ".agency_id = 'fictional-multi-feed' BEGIN INSERT INTO mutation_log VALUES ('" + table + "'); END");
          }
        }
        db.close();
        await assert.rejects(seedAgencySqlite(config, [original], path), /archive count.*1.*2|2.*declared feeds/i);
        const after = readSeededTables(path, config.id);
        assert.deepEqual(after, before);
        const verify = new Database(path);
        assert.equal(verify.query("SELECT COUNT(*) AS n FROM mutation_log").get().n, 0);
        verify.close();
        console.log("PARTIAL_MULTIFEED_PRESERVES_TOPOLOGY");
      `,
        ],
        { env: { ...process.env, SEED_TEST_DB_PATH: join(dir, "transit.db") } },
      );
      expect(stdout).toContain("PARTIAL_MULTIFEED_PRESERVES_TOPOLOGY");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects oversized explicit files and cached archives before a freshness request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seed-file-limit-"));
    try {
      const { stdout } = await promisify(execFile)(
        "bun",
        [
          "-e",
          `
        import { openSync, ftruncateSync, closeSync } from "node:fs";
        import { join } from "node:path";
        import { fetchFeedArchive } from "./scripts/lib/gtfs-seeder-core.ts";
        import assert from "node:assert/strict";
        const path = join(process.env.DATA_DIR, "oversized.zip");
        const fd = openSync(path, "w");
        ftruncateSync(fd, 128 * 1024 * 1024 + 1);
        closeSync(fd);
        let fetches = 0;
        globalThis.fetch = async () => { fetches++; throw new Error("network forbidden"); };
        const feed = { url: "https://example.test/gtfs.zip", cacheFileName: "oversized.zip" };
        await assert.rejects(fetchFeedArchive(feed, "sample", path), /archive.*limit/i);
        await assert.rejects(fetchFeedArchive(feed, "sample"), /archive.*limit/i);
        assert.equal(fetches, 0);
        console.log("LOCAL_ARCHIVE_LIMIT_OK");
      `,
        ],
        { env: { ...process.env, DATA_DIR: dir } },
      );
      expect(stdout).toContain("LOCAL_ARCHIVE_LIMIT_OK");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("manual remote transfer ignores invalid source and destination table-hash JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seed-metadata-repair-"));
    try {
      const { stdout } = await promisify(execFile)(
        "bun",
        [
          "-e",
          `
        import { Database } from "bun:sqlite";
        import { readFileSync } from "node:fs";
        import { seedAgencySqlite, seedAgencyRemoteD1, deriveAgencySeedConfig, readSeededTables } from "./scripts/lib/gtfs-seeder-core.ts";
        import { topologyArchive } from "./tests/helpers/gtfsArchive.ts";
        import assert from "node:assert/strict";
        globalThis.fetch = async () => { throw new Error("network forbidden"); };
        const path = process.env.SEED_TEST_DB_PATH;
        const { makeTestProvider } = await import("./tests/helpers/agency-fixtures.ts");
        const config = { ...deriveAgencySeedConfig(makeTestProvider({modes:["bus"],stationService:{routeType:"bus"}})), routeTypes: new Set([3]), routeIdField: "id" };
        await seedAgencySqlite(config, Buffer.from(topologyArchive()), path);
        const db = new Database(path);
        db.exec("UPDATE seed_topology_meta SET table_hashes_json = 'INVALID JSON' WHERE agency_id = 'sample'");
        const existingIndexes = db.query("SELECT name FROM sqlite_master WHERE type = 'index'").all();
        db.close();
        const topology = Object.fromEntries(readSeededTables(path, "sample").map(({ table, rows }) => [table, rows]));
        const imports = [];
        let repaired = false;
        const nativeSpawn = Bun.spawn;
        Bun.spawn = (args) => {
          assert.equal(args[0], "bunx");
          assert.equal(args[1], "wrangler");
          assert.ok(args.includes("--remote"));
          let output = "";
          if (args.includes("--file")) {
            imports.push(readFileSync(args[args.indexOf("--file") + 1], "utf8"));
            repaired = true;
          } else {
            const sql = args[args.indexOf("--command") + 1];
            const table = /FROM (\\w+)/.exec(sql)[1];
            let results;
            if (table === "sqlite_master") results = sql.includes("type = 'index'") ? existingIndexes : [...Object.keys(topology), "seed_topology_meta"].map(name => ({ name }));
            else if (table === "seed_topology_meta") throw new Error("Destination metadata must not be read");
            else results = topology[table].map(row => !repaired && table === "stops" && row.id === "1" ? { ...row, name: "Damaged" } : row);
            output = JSON.stringify([{ success: true, results }]);
          }
          return { stdout: new Blob([output]).stream(), stderr: new Blob([]).stream(), exited: Promise.resolve(0) };
        };
        try {
          await seedAgencyRemoteD1(config, path);
          assert.equal(imports.length, 1);
          assert.equal((imports[0].match(/INSERT INTO/g) || []).length, 3);
          assert.match(imports[0], /INSERT INTO stops/);
          await seedAgencyRemoteD1(config, path);
          assert.equal(imports.length, 1);
        } finally { Bun.spawn = nativeSpawn; }
        console.log("INVALID_METADATA_TRANSFER_OK");
      `,
        ],
        { env: { ...process.env, SEED_TEST_DB_PATH: join(dir, "transit.db") } },
      );
      expect(stdout).toContain("INVALID_METADATA_TRANSFER_OK");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
