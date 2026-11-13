import { expect, it, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import {
  createRemoteSeedSyncStore,
  formatWranglerFailure,
  renderSeedStatement,
} from "../../scripts/lib/remote-seed-store";
import { assertSqlIdentifier } from "../../scripts/lib/gtfs-seeder-core";
import {
  reconcileSeedTopology,
  type SeedRow,
} from "~/infrastructure/storage/surfaceStore/seedSync";
import { projectGtfsTopology } from "~/infrastructure/gtfs/staticTopology";
import { topologyArchive } from "../helpers/gtfsArchive";
import { SURFACE_SCHEMA_STATEMENTS } from "~/infrastructure/storage/surfaceStore/schema";

const config = {
  id: "sample",
  routeTypes: new Set([3]),
  routeIdField: "id" as const,
  defaultColor: "#123456",
  defaultTextColor: "#FFFFFF",
};

it.each([false, true])("remote destination applies only the delta, moved=%s", async (moved) => {
  const before = await projectGtfsTopology([topologyArchive()], config);
  const sqlFiles: string[] = [],
    paths: string[] = [],
    remoteCalls: (readonly string[])[] = [],
    topologyQueries: string[] = [];
  const runner = vi.fn(async (args: readonly string[]) => {
    const fileIndex = args.indexOf("--file");
    if (fileIndex >= 0) {
      paths.push(args[fileIndex + 1]);
      sqlFiles.push(readFileSync(args[fileIndex + 1], "utf8"));
      return "";
    }
    remoteCalls.push(args);
    const sql = args[args.indexOf("--command") + 1];
    let rows: readonly SeedRow[];
    if (sql.includes("sqlite_master"))
      rows = [
        ...Object.keys(before).map((name) => ({ name })),
        ...SURFACE_SCHEMA_STATEMENTS.flatMap((sql) => {
          const name = /^CREATE INDEX IF NOT EXISTS (\w+)/.exec(sql)?.[1];
          return name ? [{ name }] : [];
        }),
      ];
    else {
      topologyQueries.push(sql);
      const table = /FROM (\w+)/.exec(sql)![1];
      rows = before[table];
    }
    return JSON.stringify([{ success: true, results: rows }]);
  });
  const store = createRemoteSeedSyncStore({
    bindingName: "DB_TRANSIT",
    schema: SURFACE_SCHEMA_STATEMENTS,
    commandRunner: runner,
  });
  const result = await reconcileSeedTopology({
    agencyId: "sample",
    topology: await projectGtfsTopology([topologyArchive({ moved })], config),
    feedHash: "new",
    store,
    now: () => 1234,
  });
  expect(result.writes).toBe(moved ? 3 : 0);
  expect(sqlFiles).toHaveLength(moved ? 1 : 0);
  expect(remoteCalls.length).toBeGreaterThan(0);
  expect(remoteCalls.every((args) => args.includes("--remote") && args.includes("--json"))).toBe(
    true,
  );
  expect(topologyQueries.length).toBeGreaterThan(0);
  expect(topologyQueries.every((sql) => sql.includes("WHERE agency_id = 'sample'"))).toBe(true);
  const deltaSql = sqlFiles[0] ?? "";
  expect(deltaSql.includes("INSERT INTO stops")).toBe(moved);
  expect(deltaSql).not.toMatch(/INSERT INTO routes|DELETE FROM/);
  expect(deltaSql.match(/INSERT INTO/g) ?? []).toHaveLength(moved ? 3 : 0);
  expect(paths.map((path) => existsSync(path))).toEqual(moved ? [false] : []);
});

it("remote command failure propagates with no write retry and cleans up the SQL file", async () => {
  let path = "";
  const runner = vi.fn(async (args: readonly string[]) => {
    path = args.at(-1)!;
    throw new Error("import rolled back");
  });
  const store = createRemoteSeedSyncStore({
    bindingName: "DB_TRANSIT",
    schema: [],
    commandRunner: runner,
  });
  await expect(
    store.commit([
      { sql: "DELETE FROM stops WHERE agency_id = ? AND id = ?", values: ["sample", "a"] },
    ]),
  ).rejects.toThrow("import rolled back");
  expect(runner).toHaveBeenCalledTimes(1);
  expect(existsSync(path)).toBe(false);
});

it.each(["not json", "[]", "null", '{"routes":false}'])(
  "treats malformed remote hash metadata %s as missing",
  async (tableHashesJson) => {
    const runner = vi.fn(async (args: readonly string[]) => {
      const sql = args[args.indexOf("--command") + 1];
      const results = sql.includes("sqlite_master")
        ? [{ name: "seed_topology_meta" }]
        : [{ feed_hash: "feed-hash", table_hashes_json: tableHashesJson }];
      return JSON.stringify([{ success: true, results }]);
    });
    const store = createRemoteSeedSyncStore({
      bindingName: "DB_TRANSIT",
      schema: [],
      commandRunner: runner,
    });

    await expect(store.readMeta("sample")).resolves.toBeNull();
  },
);

it("delta SQL escapes quotes and physical newlines without interpreting data as parameters", () => {
  expect(
    renderSeedStatement({
      sql: "INSERT INTO feed_metadata (agency_id, key, value) VALUES (?, ?, ?)",
      values: ["sample", "key", "what? 'quoted'\nnext"],
    }),
  ).toBe(
    "INSERT INTO feed_metadata (agency_id, key, value) VALUES ('sample', 'key', 'what? ''quoted''' || char(10) || 'next');",
  );
});

it("rejects unknown seed tables before building or running SQL", async () => {
  const runner = vi.fn(async () => "[]");
  const store = createRemoteSeedSyncStore({
    bindingName: "DB_TRANSIT",
    schema: [],
    commandRunner: runner,
  });

  await expect(store.readTable("stops; DROP TABLE routes", "fictional-agency")).rejects.toThrow(
    "Unknown seed table stops; DROP TABLE routes",
  );
  expect(runner).not.toHaveBeenCalled();
});

it("rejects remote command results marked unsuccessful", async () => {
  const runner = vi.fn(async () =>
    JSON.stringify([{ success: false, results: [], error: "denied" }]),
  );
  const store = createRemoteSeedSyncStore({
    bindingName: "DB_TRANSIT",
    schema: [],
    commandRunner: runner,
  });

  await expect(store.readLastSync("fictional-agency")).rejects.toThrow("Remote seed query failed");
  expect(runner).toHaveBeenCalledTimes(1);
});

it("passes the configured Wrangler file to each remote query", async () => {
  const runner = vi.fn(async (args: readonly string[]) => {
    const sql = args[args.indexOf("--command") + 1];
    const results = sql.includes("sqlite_master")
      ? [{ name: "topology_meta" }]
      : [{ last_sync: 42 }];
    return JSON.stringify([{ success: true, results }]);
  });
  const store = createRemoteSeedSyncStore({
    bindingName: "DB_TRANSIT",
    schema: [],
    commandRunner: runner,
    configPath: "./wrangler.example.toml",
  });

  expect(await store.readLastSync("fictional-agency")).toBe(42);
  expect(runner).toHaveBeenCalledTimes(2);
  expect(runner.mock.calls.map(([args]) => args)).toEqual([
    expect.arrayContaining(["--config", "./wrangler.example.toml"]),
    expect.arrayContaining(["--config", "./wrangler.example.toml"]),
  ]);
});

it("refreshes the remote table cache after a successful commit", async () => {
  let tableReads = 0;
  const runner = vi.fn(async (args: readonly string[]) => {
    if (args.includes("--file")) return "";
    const sql = args[args.indexOf("--command") + 1];
    if (sql.includes("sqlite_master")) {
      tableReads += 1;
      const results = tableReads === 1 ? [] : [{ name: "topology_meta" }];
      return JSON.stringify([{ success: true, results }]);
    }
    return JSON.stringify([{ success: true, results: [{ last_sync: 77 }] }]);
  });
  const store = createRemoteSeedSyncStore({
    bindingName: "DB_TRANSIT",
    schema: [],
    commandRunner: runner,
  });

  expect(await store.readLastSync("fictional-agency")).toBeNull();
  await store.commit([
    {
      sql: "INSERT INTO topology_meta (agency_id, last_sync) VALUES (?, ?)",
      values: ["fictional-agency", 77],
    },
  ]);
  expect(await store.readLastSync("fictional-agency")).toBe(77);
  expect(tableReads).toBe(2);
});

it.each([
  ["table_name", "table_name"],
  ["seed_topology_meta", "seed_topology_meta"],
])("accepts safe SQL identifier %s", (input, expected) => {
  expect(assertSqlIdentifier(input)).toBe(expected);
});

it.each(["stops; DROP TABLE routes", "9starts", "has whitespace", "name-with-dash"])(
  "rejects unsafe SQL identifier %s",
  (input) => {
    expect(() => assertSqlIdentifier(input)).toThrow(/Unsafe SQL identifier/);
  },
);

it("rejects a remote delta whose table and index writes exceed the batch budget", async () => {
  const runner = vi.fn(async () => "");
  const store = createRemoteSeedSyncStore({
    bindingName: "DB_TRANSIT",
    schema: SURFACE_SCHEMA_STATEMENTS,
    commandRunner: runner,
    maxEstimatedWrites: 3,
  });
  await expect(
    store.commit([
      { sql: "INSERT INTO stops (agency_id, id) VALUES (?, ?)", values: ["sample", "a"] },
    ]),
  ).rejects.toThrow(/estimated.*4.*budget.*3/i);
  expect(runner).not.toHaveBeenCalled();
});

it("rejects an unbudgeted index build over an existing remote table", async () => {
  const runner = vi.fn(async (args: readonly string[]) =>
    JSON.stringify([
      {
        success: true,
        results: args[args.indexOf("--command") + 1].includes("type = 'table'")
          ? [{ name: "stops" }]
          : [],
      },
    ]),
  );
  const store = createRemoteSeedSyncStore({
    bindingName: "DB_TRANSIT",
    schema: SURFACE_SCHEMA_STATEMENTS,
    commandRunner: runner,
  });
  await expect(
    store.commit([
      { sql: "INSERT INTO stops (agency_id, id) VALUES (?, ?)", values: ["sample", "a"] },
    ]),
  ).rejects.toThrow(/Budget this index migration separately/);
  expect(runner.mock.calls.some(([args]) => args.includes("--file"))).toBe(false);
});

it("reports Wrangler import errors printed on stdout", () => {
  const message = formatWranglerFailure(1, "✘ [ERROR] D1_ERROR: too many SQL variables\n", "");
  expect(message).toBe(
    "Wrangler exited with code 1\nstdout:\n✘ [ERROR] D1_ERROR: too many SQL variables",
  );
});

it("keeps the tail of long Wrangler output with stderr first", () => {
  const message = formatWranglerFailure(2, `${"x".repeat(5_000)}END`, "auth expired");
  expect(message.startsWith("Wrangler exited with code 2\nstderr:\nauth expired\nstdout:\n")).toBe(
    true,
  );
  expect(message.endsWith("END")).toBe(true);
  expect(message.length).toBeLessThan(4_100);
});
