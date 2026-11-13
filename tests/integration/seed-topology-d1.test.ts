import { expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import {
  createD1SeedSyncStore,
  syncSeedTopology,
  type SeedSyncStore,
} from "~/infrastructure/storage/surfaceStore/seedSync";
import { CREATE_SURFACE_TABLES_SQL } from "~/infrastructure/storage/surfaceStore/schema";
import type {
  D1DatabaseBinding,
  D1PreparedStatement,
} from "~/infrastructure/storage/RuntimeBindings";
import { topologyArchive } from "../helpers/gtfsArchive";
import { createD1TopologySource } from "~/infrastructure/storage/surfaceStore/topology";
import { Effect } from "effect";
import { TOPOLOGY_TTL_MS } from "~/domain/surface/topologySource";

/**
 * Yields a macrotask before every store call. Miniflare reuses proxy sockets and
 * closes them after 1s idle, but seed diffing can block the event loop past
 * workerd's 5s idle close on slow runners, so the next call would land on a
 * dead socket. Yielding lets the overdue idle timer run first.
 */
function yieldingStore(store: SeedSyncStore): SeedSyncStore {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    hasTopology: async (id) => (await settle(), store.hasTopology(id)),
    readLastSync: async (id) => (await settle(), store.readLastSync(id)),
    readMeta: async (id) => (await settle(), store.readMeta(id)),
    readTable: async (table, id) => (await settle(), store.readTable(table, id)),
    commit: async (statements) => (await settle(), store.commit(statements)),
  };
}

it("repairs a damaged row when stored D1 hash metadata is malformed", async () => {
  const proxy = await getPlatformProxy({ configPath: "wrangler.sample.jsonc", persist: false });
  try {
    const db = proxy.env.DB_TRANSIT as D1DatabaseBinding;
    await db.exec(CREATE_SURFACE_TABLES_SQL);
    const store = createD1SeedSyncStore(db);
    const config = {
      id: "sample",
      routeTypes: new Set([3]),
      routeIdField: "id" as const,
      defaultColor: "#123456",
      defaultTextColor: "#FFFFFF",
    };
    const run = (allowInitialSeed = false) =>
      syncSeedTopology({
        config,
        store,
        now: () => 1234,
        allowInitialSeed,
        archives: async () => [topologyArchive()],
      });

    expect(await run(true)).toMatchObject({ outcome: "updated" });
    await db.exec(
      "UPDATE seed_topology_meta SET table_hashes_json = 'INVALID JSON' WHERE agency_id = 'sample'; UPDATE stops SET name = 'Damaged' WHERE agency_id = 'sample' AND id = '1'",
    );

    expect(await run()).toMatchObject({ outcome: "updated", writes: 3 });
    expect((await store.readTable("stops", "sample")).find((row) => row.id === "1")?.name).toBe(
      "Stop 1",
    );
    expect(await store.readMeta("sample")).toMatchObject({
      tableHashes: { stops: expect.any(String) },
    });
  } finally {
    await proxy.dispose();
  }
});

it("rolls back the entire seed delta when a statement after the former chunk boundary fails", async () => {
  const proxy = await getPlatformProxy({ configPath: "wrangler.sample.jsonc", persist: false });
  try {
    const db = proxy.env.DB_TRANSIT as D1DatabaseBinding;
    await db.exec(CREATE_SURFACE_TABLES_SQL);
    const store = createD1SeedSyncStore(db);
    await expect(
      store.commit([
        ...Array.from({ length: 90 }, (_, i) => ({
          sql: "INSERT INTO topology_meta (agency_id, last_sync) VALUES (?, ?)",
          values: [`sample-${i}`, 1234],
        })),
        { sql: "INSERT INTO missing_table (id) VALUES (?)", values: [1] },
      ]),
    ).rejects.toThrow();
    expect(await db.prepare("SELECT COUNT(*) AS count FROM topology_meta").first()).toEqual({
      count: 0,
    });
  } finally {
    await proxy.dispose();
  }
});

it("real local D1 writes scale with changed keys, never with the 1160-stop agency", async () => {
  const proxy = await getPlatformProxy({ configPath: "wrangler.sample.jsonc", persist: false });
  try {
    const d1 = proxy.env.DB_TRANSIT as D1DatabaseBinding;
    await d1.exec(CREATE_SURFACE_TABLES_SQL);
    const batches: D1PreparedStatement[][] = [],
      nativeChanges: number[] = [],
      nativeWrites: number[] = [];
    let failBatch = false;
    const db: D1DatabaseBinding = {
      prepare: (sql) => d1.prepare(sql),
      exec: (sql) => d1.exec(sql),
      batch: async (statements) => {
        batches.push(statements);
        const result = (await d1.batch(
          failBatch
            ? [...statements, d1.prepare("INSERT INTO missing_table (id) VALUES (1)")]
            : statements,
        )) as Array<{ meta: { changes: number; rows_written: number } }>;
        nativeChanges.push(result.reduce((sum, item) => sum + item.meta.changes, 0));
        nativeWrites.push(result.reduce((sum, item) => sum + item.meta.rows_written, 0));
        return result;
      },
    };
    const config = {
      id: "sample",
      routeTypes: new Set([3]),
      routeIdField: "id" as const,
      defaultColor: "#123456",
      defaultTextColor: "#FFFFFF",
    };
    const store = yieldingStore(createD1SeedSyncStore(db));
    const run = (moved = false, removed = false, marker = "first archive", initial = false) =>
      syncSeedTopology({
        config,
        store,
        now: () => 1234,
        allowInitialSeed: initial,
        archives: async () => [
          topologyArchive({ count: 1160, routeCount: 35, moved, removed, marker }),
        ],
      });
    expect(await run(false, false, undefined, true)).toMatchObject({ outcome: "updated" });
    const routesBefore = await store.readTable("routes", "sample");
    expect(routesBefore).toHaveLength(35);
    batches.length = 0;
    nativeChanges.length = 0;
    nativeWrites.length = 0;
    expect(await run()).toEqual({ outcome: "unchanged", writes: 0 });
    expect(await run(false, false, "repacked")).toEqual({ outcome: "unchanged", writes: 0 });
    expect(batches).toHaveLength(0);
    expect(await run(true)).toMatchObject({ outcome: "updated", writes: 3 });
    expect(nativeChanges).toEqual([3]);
    expect(nativeWrites[0]).toBeLessThanOrEqual(8);
    expect(await store.readTable("routes", "sample")).toEqual(routesBefore);
    const stationIndex = [
      Object.freeze({
        id: "parent",
        schematicId: "curated-station",
        name: "Curated station label",
        lat: 42,
        lon: -80,
        lines: ["A"],
        platformIds: ["1"],
        directionTermini: { "0": "Curated terminus" },
      }),
    ];
    const source = createD1TopologySource({
      d1: db,
      agencyId: "sample",
      source: "seed",
      stationIndex,
      now: () => 1234,
    });
    expect(await Effect.runPromise(source.shouldRefreshTopology())).toBe(false);
    const snapshot = await Effect.runPromise(source.fetchTopology());
    expect(
      snapshot.routes.flatMap((route) => route.stops).find((stop) => stop.id === "1"),
    ).toMatchObject({
      lat: 44,
      parentStation: "Curated station label",
      parentStationId: "curated-station",
    });
    expect(stationIndex[0]).toMatchObject({
      name: "Curated station label",
      schematicId: "curated-station",
      platformIds: ["1"],
      directionTermini: { "0": "Curated terminus" },
    });
    expect(
      await Effect.runPromise(
        createD1TopologySource({
          d1: db,
          agencyId: "sample",
          source: "seed",
          now: () => 1234 + TOPOLOGY_TTL_MS,
        }).shouldRefreshTopology(),
      ),
    ).toBe(true);
    expect(await run(true, true)).toMatchObject({ outcome: "updated", writes: 7 });
    expect(nativeChanges).toEqual([3, 7]);
    const rows = await store.readTable("stops", "sample");
    expect(rows).toHaveLength(1159);
    expect(rows.find((row) => row.id === "1")?.lat).toBe(44);
    failBatch = true;
    await expect(run(false, true)).rejects.toThrow();
    expect(await store.readTable("stops", "sample")).toEqual(rows);
    expect(
      await db.prepare("SELECT last_sync FROM topology_meta WHERE agency_id = 'sample'").first(),
    ).toEqual({ last_sync: 1234 });
  } finally {
    await proxy.dispose();
  }
}, 120_000);
