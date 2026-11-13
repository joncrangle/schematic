import { expect, it, vi } from "vitest";
import type { AgencyProvider } from "~/agencies";
import { assignTopologyWeekdays } from "~/domain/surface/topologySchedule";
import { refreshRemoteScheduledTopologies } from "../../scripts/lib/remote-topology-refresh";
import { runTopologyRefreshCli } from "../../scripts/refresh-topology";
import { deriveAgencySeedConfig } from "../../scripts/lib/gtfs-seeder-core";
import {
  hashGtfsArchives,
  projectGtfsTopology,
  type GtfsTopology,
} from "~/infrastructure/gtfs/staticTopology";
import { gtfsZip, topologyArchive } from "../helpers/gtfsArchive";
import { readFileSync, existsSync } from "node:fs";
import { Effect } from "effect";
import { refreshScheduledTopologies } from "~/services/surface/SurfaceTopologyRefresh";
import type { D1DatabaseBinding } from "~/infrastructure/storage/RuntimeBindings";
import { SURFACE_SCHEMA_STATEMENTS } from "~/infrastructure/storage/surfaceStore/schema";

function provider(id: string): AgencyProvider {
  return {
    manifest: { id, name: id, modes: ["bus"] },
    staticTopology: {
      source: "seed",
      feeds: [{ url: `https://example.test/${id}.zip`, cacheFileName: `${id}.zip` }],
    },
    createTopologySource: () => {
      throw new Error("Remote refresh must not build an app runtime");
    },
  } as unknown as AgencyProvider;
}

function assignedTime(ids: string[], id = ids[0]): number {
  return Date.parse("2026-09-27T04:00:00Z") + assignTopologyWeekdays(ids).get(id)! * 86400_000;
}

const configJson = JSON.stringify({
  d1_databases: [
    {
      binding: "DB_TRANSIT",
      database_name: "transit",
      database_id: "01234567-89ab-4cde-8123-456789abcdef",
    },
  ],
});
const quietLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

async function remoteFixture(providers: AgencyProvider[]) {
  const topology = new Map<string, GtfsTopology>();
  const hashes = new Map<string, string>();
  for (const p of providers) {
    const config = deriveAgencySeedConfig(p);
    topology.set(p.manifest.id, await projectGtfsTopology([topologyArchive()], config));
    hashes.set(p.manifest.id, await hashGtfsArchives([topologyArchive()], config));
  }
  const imports: Array<{ path: string; sql: string }> = [];
  const runner = vi.fn(async (args: readonly string[]) => {
    expect(args).toContain("--remote");
    expect(args).toContain("--yes");
    expect(args.slice(args.indexOf("--config"), args.indexOf("--config") + 2)).toEqual([
      "--config",
      "/runner/topology.json",
    ]);
    if (args.includes("--file")) {
      const path = args[args.indexOf("--file") + 1];
      imports.push({ path, sql: readFileSync(path, "utf8") });
      return "";
    }
    expect(args).toContain("--json");
    const sql = args[args.indexOf("--command") + 1];
    const id = /agency_id = '([^']+)'/.exec(sql)?.[1];
    const table = /FROM (\w+)/.exec(sql)![1];
    let rows: unknown[];
    if (table === "sqlite_master")
      rows = [
        "routes",
        "stops",
        "route_shapes",
        "route_stops",
        "route_trip_terminals",
        "route_trip_headsigns",
        "stop_routes",
        "topology_meta",
        "seed_topology_meta",
        ...SURFACE_SCHEMA_STATEMENTS.flatMap((sql) => {
          const name = /^CREATE INDEX IF NOT EXISTS (\w+)/.exec(sql)?.[1];
          return name ? [name] : [];
        }),
      ].map((name) => ({ name }));
    else if (table === "topology_meta") rows = []; // Missing stamp is due, without a metadata write.
    else if (table === "seed_topology_meta")
      rows = [{ feed_hash: hashes.get(id!), table_hashes_json: "{}" }];
    else rows = [...(topology.get(id!)?.[table] ?? [])];
    return JSON.stringify([{ success: true, results: rows }]);
  });
  return { runner, imports };
}

it("fresh remote topology performs read-only checks without fetching or importing SQL", async () => {
  const time = assignedTime(["sample"]);
  const fetchArchive = vi.fn();
  const runner = vi.fn(async (args: readonly string[]) => {
    expect(args).toContain("--remote");
    expect(args).toContain("--yes");
    expect(args.slice(args.indexOf("--config"), args.indexOf("--config") + 2)).toEqual([
      "--config",
      "/runner/topology.json",
    ]);
    expect(args).toContain("--json");
    expect(args).not.toContain("--file");
    const sql = args[args.indexOf("--command") + 1];
    const rows = sql.includes("sqlite_master")
      ? [{ name: "routes" }, { name: "topology_meta" }]
      : sql.includes("last_sync")
        ? [{ last_sync: time - 1 }]
        : [{ id: "r" }];
    return JSON.stringify([{ success: true, results: rows }]);
  });
  const now = vi.fn(() => time);
  const log = quietLog();
  expect(
    await runTopologyRefreshCli(["--config=/runner/topology.json"], {
      readConfig: async () => configJson,
      now,
      log,
      providers: () => [provider("sample")],
      commandRunner: runner,
      fetchArchive,
    }),
  ).toBe(0);
  expect(now).toHaveBeenCalledTimes(1);
  expect(log.info).toHaveBeenCalledWith(
    "Remote topology cycle completed",
    expect.objectContaining({
      skippedAgencyIds: ["sample"],
      refreshedAgencyIds: [],
      failedAgencyIds: [],
    }),
  );
  expect(fetchArchive).not.toHaveBeenCalled();
});

it.each([false, true])(
  "scheduled remote sync forwards explicit config and preserves hash gating, moved=%s",
  async (moved) => {
    const providers = [provider("sample")];
    const { runner, imports } = await remoteFixture(providers);
    const log = quietLog();
    const result = await refreshRemoteScheduledTopologies({
      configPath: "/runner/topology.json",
      scheduledTime: assignedTime(["sample"]),
      providers: () => providers,
      commandRunner: runner,
      log,
      fetchArchive: async () => topologyArchive({ moved }),
    });
    expect(result.failedAgencyIds).toEqual([]);
    expect(result.updatedAgencyIds).toEqual(moved ? ["sample"] : []);
    expect(result.unchangedAgencyIds).toEqual(moved ? [] : ["sample"]);
    expect(imports).toHaveLength(moved ? 1 : 0);
    const importedSql = imports[0]?.sql ?? "";
    expect(importedSql.match(/INSERT INTO/g) ?? []).toHaveLength(moved ? 4 : 0);
    expect(importedSql.includes("INSERT INTO stops")).toBe(moved);
    expect(importedSql).not.toMatch(/INSERT INTO routes|DELETE FROM|BEGIN|COMMIT/);
    expect(imports.map(({ path }) => existsSync(path))).toEqual(moved ? [false] : []);
    expect(runner.mock.calls.some(([args]) => args.some((arg) => arg.startsWith("SELECT *")))).toBe(
      moved,
    );
    const movementWarning = [
      expect.stringContaining("Stops moved"),
      expect.objectContaining({
        commands: [
          "bun scripts/seed.ts --agency=sample --db=sqlite",
          "bun scripts/seed.ts --interchange-only",
        ],
      }),
    ];
    expect(log.warn.mock.calls).toEqual(moved ? [movementWarning] : []);
  },
);

it.each([false, true])(
  "an empty remote destination is needs-seed without feeds or lazy DDL, schema=%s",
  async (schema) => {
    const fetchArchive = vi.fn();
    const runner = vi.fn(async (args: readonly string[]) => {
      expect(args).not.toContain("--file");
      const sql = args[args.indexOf("--command") + 1];
      return JSON.stringify([
        {
          success: true,
          results: schema && sql.includes("sqlite_master") ? [{ name: "routes" }] : [],
        },
      ]);
    });
    const result = await refreshRemoteScheduledTopologies({
      configPath: "/runner/topology.json",
      scheduledTime: assignedTime(["sample"]),
      providers: () => [provider("sample")],
      commandRunner: runner,
      fetchArchive,
      log: quietLog(),
    });
    expect(result.needsSeedAgencyIds).toEqual(["sample"]);
    expect(result.refreshedAgencyIds).toEqual([]);
    expect(result.failedAgencyIds).toEqual([]);
    expect(fetchArchive).not.toHaveBeenCalled();
  },
);

it("remote and self-hosted wrappers select the same UTC weekday from the full eligible registry", async () => {
  const ids = Array.from({ length: 15 }, (_, i) => `sample-${i}`);
  const providers = ids.map(provider);
  const nextbus = {
    ...provider("nextbus"),
    staticTopology: { source: "nextbus" },
  } as AgencyProvider;
  const schedule = assignTopologyWeekdays(ids);
  const time = Date.parse("2026-09-27T23:30:00-07:00"); // Monday UTC, Sunday at this offset.
  const due = ids.filter((id) => schedule.get(id) === 1);
  expect(due.length).toBeGreaterThanOrEqual(2);
  const checked: string[] = [];
  const runner = vi.fn(async (args: readonly string[]) => {
    const sql = args[args.indexOf("--command") + 1];
    const id = /agency_id = '([^']+)'/.exec(sql)?.[1];
    let rows: unknown[];
    if (sql.includes("sqlite_master")) rows = [{ name: "routes" }, { name: "topology_meta" }];
    else if (sql.includes("last_sync")) rows = [{ last_sync: time }];
    else {
      checked.push(id!);
      rows = id === due[0] ? [] : [{ id: "r" }];
    }
    return JSON.stringify([{ success: true, results: rows }]);
  });
  const fetchArchive = vi.fn();
  const remote = await refreshRemoteScheduledTopologies({
    configPath: "/runner/topology.json",
    scheduledTime: time,
    providers: () => [...providers, nextbus],
    commandRunner: runner,
    fetchArchive,
    log: quietLog(),
  });
  const selfHosted = await refreshScheduledTopologies(time, {
    providers: () => [
      ...providers.map((p) => ({
        ...p,
        createTopologySource: () => ({
          fetchTopology: () => Effect.die("not a topology read"),
          shouldRefreshTopology: () => Effect.succeed(false),
          syncTopology: () => Effect.die("fresh or empty agencies must not sync"),
        }),
      })),
      nextbus,
    ],
    resolveBinding: async () =>
      ({
        prepare: () => {
          let id = "";
          const statement = {
            bind: (value: string) => {
              id = value;
              return statement;
            },
            all: async () => ({ success: true, results: [{ name: "routes" }] }),
            first: async () => (id === due[0] ? null : { id: "r" }),
          };
          return statement;
        },
      }) as unknown as D1DatabaseBinding,
  });
  expect([...new Set(checked)]).toEqual(due);
  expect(remote).toEqual(selfHosted);
  expect(remote.needsSeedAgencyIds).toEqual([due[0]]);
  expect(remote.skippedAgencyIds).toEqual(due.slice(1));
  expect(fetchArchive).not.toHaveBeenCalled();
});

it.each(["fetch", "parse", "write", "record-limit", "download-limit"])(
  "CLI isolates a %s failure, continues sequentially, and exits nonzero without leaking raw errors",
  async (failure) => {
    const ids = Array.from({ length: 15 }, (_, i) => `sample-${i}`);
    const providers = ids.map(provider);
    const time = assignedTime(ids);
    const due = ids.filter(
      (id) => assignTopologyWeekdays(ids).get(id) === new Date(time).getUTCDay(),
    );
    const { runner, imports } = await remoteFixture(providers);
    const log = quietLog();
    const events: string[] = [];
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetchArchive = vi.fn(async (url: string) => {
      const id = url.split("/").at(-1)!.replace(".zip", "");
      events.push(id);
      if (id === due[0]) {
        started();
        await held;
      }
      if (id === due[0] && failure === "parse") return new Uint8Array([1, 2, 3]);
      if (id === due[0] && failure === "record-limit")
        return gtfsZip(
          {
            "routes.txt": "route_id,route_type\nr,3\n",
            "trips.txt": "route_id,trip_id\nr,t\n",
            "stop_times.txt": "trip_id,stop_id,stop_sequence\nt,1,1\n",
            "stops.txt": `stop_id,stop_name,stop_lat,stop_lon\n1,${"x".repeat(1024 * 1024 + 1)},43,-79`,
          },
          true,
        );
      return topologyArchive({ moved: true });
    });
    const commandRunner = vi.fn(async (args: readonly string[]) => {
      const output = await runner(args);
      if (args.includes("--file") && imports.length === 1 && failure === "write")
        throw new Error("private-transport-secret");
      return output;
    });
    const pull = vi.fn((controller) => controller.close());
    const cancel = vi.fn();
    const fetch = vi.fn(async (url: RequestInfo | URL, options?: RequestInit) => {
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      const bytes = await fetchArchive(String(url));
      if (failure === "download-limit" && String(url).includes(`/${due[0]}.zip`))
        return new Response(
          new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }),
          { headers: { "content-length": "134217729" } },
        );
      return failure === "fetch" && String(url).includes(`/${due[0]}.zip`)
        ? new Response("unavailable", { status: 503 })
        : new Response(new Uint8Array(bytes));
    });
    const now = vi.fn(() => 1234);
    const run = runTopologyRefreshCli(
      ["--config=/runner/topology.json", `--scheduled-time=${new Date(time).toISOString()}`],
      {
        readConfig: async () => configJson,
        now,
        providers: () => providers,
        commandRunner,
        log,
        ...(failure === "fetch" || failure.endsWith("limit") ? { fetch } : { fetchArchive }),
      },
    );
    await firstStarted;
    expect(events).toEqual([due[0]]);
    release();
    const exitCode = await run;
    expect(exitCode).toBe(1);
    expect(now).toHaveBeenCalledTimes(1);
    expect(events).toEqual(due);
    expect(log.info).toHaveBeenCalledWith(
      "Remote topology cycle completed",
      expect.objectContaining({
        failedAgencyIds: [due[0]],
        updatedAgencyIds: due.slice(1),
      }),
    );
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("private-transport-secret");
    const expectedImportedIds = failure === "write" ? due : due.slice(1);
    expect(imports).toHaveLength(expectedImportedIds.length);
    expectedImportedIds.forEach((id, index) =>
      expect(imports[index]?.sql).toContain(`VALUES ('${id}'`),
    );
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(failure === "download-limit" ? 1 : 0);
    for (const entry of imports) expect(existsSync(entry.path)).toBe(false);
  },
);

it("a failed agency schema read does not poison the next agency's remote checks", async () => {
  const ids = Array.from({ length: 15 }, (_, i) => `sample-${i}`);
  const providers = ids.map(provider);
  const time = assignedTime(ids);
  const due = ids.filter(
    (id) => assignTopologyWeekdays(ids).get(id) === new Date(time).getUTCDay(),
  );
  const { runner } = await remoteFixture(providers);
  let fail = true;
  const commandRunner = async (args: readonly string[]) => {
    if (fail) {
      fail = false;
      throw new Error("first schema read unavailable");
    }
    return runner(args);
  };
  const result = await refreshRemoteScheduledTopologies({
    configPath: "/runner/topology.json",
    scheduledTime: time,
    providers: () => providers,
    commandRunner,
    fetchArchive: async () => topologyArchive(),
    log: quietLog(),
  });
  expect(result.failedAgencyIds).toEqual([due[0]]);
  expect(result.unchangedAgencyIds).toEqual(due.slice(1));
});

it.each([
  [["--config=/runner/topology.json", "--scheduled-time=not-a-time"], '{"d1_databases":[]}'],
  [
    ["--config=/runner/topology.json", "--scheduled-time=2026-02-30T04:00:00Z"],
    '{"d1_databases":[]}',
  ],
  [["--config=/runner/topology.json"], '{"d1_databases":[]}'],
  [
    ["--config=/runner/topology.json"],
    '{"d1_databases":[{"binding":"DB_TRANSIT","database_name":"transit","database_id":"11111111-1111-1111-1111-111111111111"}]}',
  ],
  [["--config=/runner/topology.json"], '{"secret":"must-not-appear",invalid-json}'],
  [[], "{}"],
])("invalid CLI input fails before Wrangler transport: %s", async (args, config) => {
  const commandRunner = vi.fn();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  expect(
    await runTopologyRefreshCli(args, {
      readConfig: async () => config,
      now: () => 1234,
      commandRunner,
      log,
    }),
  ).toBe(1);
  expect(commandRunner).not.toHaveBeenCalled();
  expect(JSON.stringify(log.error.mock.calls)).not.toContain("must-not-appear");
});
