import {
  contentHash,
  hashGtfsArchives,
  projectGtfsTopology,
  type GtfsTopology,
  type GtfsProjectionConfig,
} from "~/infrastructure/gtfs/staticTopology";
import type { D1DatabaseBinding } from "../RuntimeBindings";
import { SURFACE_SCHEMA_STATEMENTS } from "./schema";
import { TOPOLOGY_TTL_MS } from "~/domain/surface/topologySource";

export const SEED_TABLES = {
  routes: {
    keys: ["id"],
    columns: ["id", "short_name", "long_name", "route_type", "color", "text_color"],
  },
  stops: {
    keys: ["id"],
    columns: ["id", "code", "name", "lat", "lon", "wheelchair", "parent_station", "routes_json"],
  },
  route_shapes: {
    keys: ["id"],
    columns: [
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
    ],
  },
  route_stops: {
    keys: ["route_id", "direction_id", "stop_sequence"],
    columns: ["route_id", "direction_id", "stop_sequence", "stop_id"],
  },
  route_direction_trips: {
    // part is part of the key because one direction group may be spread over
    // several rows when it holds more trips than a single statement can carry.
    keys: ["route_id", "direction_id", "part"],
    columns: ["route_id", "direction_id", "part", "trip_ids"],
  },
  route_trip_terminals: {
    keys: ["route_id", "direction_id", "terminal_stop_id", "terminal_stop_sequence", "part"],
    columns: [
      "route_id",
      "direction_id",
      "terminal_stop_id",
      "terminal_stop_sequence",
      "part",
      "trip_ids",
    ],
  },
  route_trip_headsigns: {
    keys: ["route_id", "headsign", "part"],
    columns: ["route_id", "headsign", "part", "trip_ids"],
  },
  stop_routes: { keys: ["route_id", "stop_id"], columns: ["route_id", "stop_id"] },
  feed_metadata: { keys: ["key"], columns: ["key", "value"] },
} as const;
export type SeedTable = keyof typeof SEED_TABLES;

function tableDefinition(table: string) {
  if (!Object.hasOwn(SEED_TABLES, table)) throw new Error(`Unknown seed table ${table}`);
  return SEED_TABLES[table as SeedTable];
}

function normalizedRows(
  table: string,
  rows: readonly SeedRow[],
  agencyId: string,
): Map<string, SeedRow> {
  const definition = tableDefinition(table);
  const result = new Map<string, SeedRow>();
  for (const input of rows) {
    if (input.agency_id !== agencyId) throw new Error(`Unscoped seed row in ${table}`);
    const row: SeedRow = { agency_id: agencyId };
    for (const column of definition.columns) {
      const value = input[column] ?? null;
      if (typeof value === "number" && !Number.isFinite(value))
        throw new Error(`Invalid ${table}.${column}`);
      row[column] = value;
    }
    if (table === "stops") {
      const routes: unknown = JSON.parse(String(row.routes_json));
      if (!Array.isArray(routes) || !routes.every((id) => typeof id === "string"))
        throw new Error("Invalid stop membership");
      row.routes_json = JSON.stringify([...new Set(routes)].sort());
    }
    for (const key of definition.keys)
      if (row[key] === null || row[key] === "") throw new Error(`Invalid key in ${table}`);
    result.set(JSON.stringify(definition.keys.map((key) => row[key])), row);
  }
  return new Map([...result].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** One canonical keyed comparison, used by every destination. Last duplicate key wins. */
export function compareSeedRows(
  table: string,
  stored: readonly SeedRow[],
  incoming: readonly SeedRow[],
  agencyId: string,
): {
  upserts: SeedRow[];
  deletes: SeedRow[];
} {
  const old = normalizedRows(table, stored, agencyId),
    next = normalizedRows(table, incoming, agencyId);
  return {
    upserts: [...next]
      .filter(([key, row]) => JSON.stringify(old.get(key)) !== JSON.stringify(row))
      .map(([, row]) => row),
    deletes: [...old].filter(([key]) => !next.has(key)).map(([, row]) => row),
  };
}

export type SeedRow = Record<string, string | number | null>;
export interface SeedSyncMeta {
  readonly feedHash: string;
  readonly tableHashes: Readonly<Record<string, string>>;
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

/** Corrupt persisted hashes are a cache miss; callers verify destination rows. */
export function parseSeedSyncMeta(
  feedHash: unknown,
  tableHashesJson: unknown,
): SeedSyncMeta | null {
  if (typeof feedHash !== "string" || typeof tableHashesJson !== "string") return null;
  let tableHashes: unknown;
  try {
    tableHashes = JSON.parse(tableHashesJson);
  } catch {
    return null;
  }
  return isStringRecord(tableHashes) ? { feedHash, tableHashes } : null;
}

function normalizeSeedSyncMeta(meta: unknown): SeedSyncMeta | null {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
  const candidate = meta as { feedHash?: unknown; tableHashes?: unknown };
  return typeof candidate.feedHash === "string" && isStringRecord(candidate.tableHashes)
    ? { feedHash: candidate.feedHash, tableHashes: candidate.tableHashes }
    : null;
}

export interface SeedStatement {
  readonly sql: string;
  readonly values: readonly (string | number | null)[];
}
export interface SeedSyncStore {
  hasTopology(agencyId: string): Promise<boolean>;
  readLastSync(agencyId: string): Promise<number | null>;
  readMeta(agencyId: string): Promise<SeedSyncMeta | null>;
  readTable(table: string, agencyId: string): Promise<SeedRow[]>;
  commit(statements: readonly SeedStatement[]): Promise<void>;
}
export interface SeedSyncResult {
  readonly outcome: "unchanged" | "updated" | "needs-seed";
  readonly writes: number;
  readonly movedStops?: readonly {
    id: string;
    before: readonly [number, number];
    after: readonly [number, number];
  }[];
}
export async function syncSeedTopology(input: {
  readonly config: GtfsProjectionConfig;
  readonly archives: () => Promise<readonly Uint8Array[]>;
  /** A projection already computed from these archives by the seed CLI. */
  readonly topology?: GtfsTopology;
  readonly store: SeedSyncStore;
  readonly now?: () => number;
  readonly allowInitialSeed?: boolean;
  /** Manual seeds compare destination rows even when archive and table hashes match. */
  readonly verifyDestination?: boolean;
}): Promise<SeedSyncResult> {
  const { config, store } = input;
  const hasTopology = await store.hasTopology(config.id);
  if (!input.allowInitialSeed && !hasTopology) return { outcome: "needs-seed", writes: 0 };
  const meta =
    !input.verifyDestination && hasTopology
      ? normalizeSeedSyncMeta(await store.readMeta(config.id))
      : null;
  const archives = await input.archives();
  const feedHash = await hashGtfsArchives(archives, config);
  if (!input.verifyDestination && feedHash === meta?.feedHash)
    return { outcome: "unchanged", writes: 0 };
  const topology = input.topology ?? (await projectGtfsTopology(archives, config));
  return reconcileSeedTopology({
    agencyId: config.id,
    topology,
    feedHash,
    store,
    meta,
    now: input.now,
    verifyDestination: input.verifyDestination,
  });
}

/** Accept a complete, validated projection. An effective no-op does not even backfill metadata. */
export async function reconcileSeedTopology(input: {
  readonly agencyId: string;
  readonly topology: GtfsTopology;
  readonly feedHash: string;
  readonly store: SeedSyncStore;
  readonly meta?: SeedSyncMeta | null;
  readonly now?: () => number;
  /** Manual transfers verify actual rows rather than trusting persisted table hashes. */
  readonly verifyDestination?: boolean;
}): Promise<SeedSyncResult> {
  const { agencyId, store, topology } = input;
  for (const table of ["routes", "stops", "route_shapes", "route_stops", "stop_routes"]) {
    if (!Object.hasOwn(topology, table)) throw new Error(`Missing topology table ${table}`);
  }
  if (!topology.routes.length || !topology.stops.length)
    throw new Error("Empty source topology; seed the source agency first");
  const routeIds = new Set(topology.routes.map((row) => row.id));
  const stopIds = new Set(topology.stops.map((row) => row.id));
  for (const row of [
    ...topology.route_shapes,
    ...topology.route_stops,
    ...topology.stop_routes,
    ...(topology.route_trip_terminals ?? []),
    ...(topology.route_trip_headsigns ?? []),
  ]) {
    if (!routeIds.has(row.route_id))
      throw new Error(`Invalid topology route reference ${row.route_id}`);
  }
  for (const row of [...topology.route_stops, ...topology.stop_routes]) {
    if (!stopIds.has(row.stop_id))
      throw new Error(`Invalid topology stop reference ${row.stop_id}`);
  }
  const meta = input.verifyDestination
    ? null
    : normalizeSeedSyncMeta(input.meta === undefined ? await store.readMeta(agencyId) : input.meta);
  const tableHashes: Record<string, string> = {};
  const upserts: SeedStatement[] = [],
    deletes: SeedStatement[] = [];
  const movedStops: Array<{ id: string; before: [number, number]; after: [number, number] }> = [];
  let topologyChanged = false;
  // Compute all hashes and validate all incoming rows before any destination read or write.
  const tables = Object.keys(SEED_TABLES).filter((table) => Object.hasOwn(topology, table));
  for (const table of tables) {
    tableHashes[table] = await contentHash(
      new TextEncoder().encode(
        JSON.stringify([...normalizedRows(table, topology[table], agencyId).values()]),
      ),
    );
  }
  for (const table of tables) {
    if (!input.verifyDestination && meta?.tableHashes[table] === tableHashes[table]) continue;
    const old = await store.readTable(table, agencyId);
    const oldStops = table === "stops" ? new Map(old.map((row) => [row.id, row])) : undefined;
    const delta = compareSeedRows(table, old, topology[table], agencyId);
    if (table !== "feed_metadata" && (delta.upserts.length || delta.deletes.length))
      topologyChanged = true;
    const definition = tableDefinition(table);
    const columns = ["agency_id", ...definition.columns];
    const keys = ["agency_id", ...definition.keys];
    const updates = definition.columns.filter(
      (column) => !(definition.keys as readonly string[]).includes(column),
    );
    for (const row of delta.upserts) {
      upserts.push({
        sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ON CONFLICT (${keys.join(", ")}) ${updates.length ? `DO UPDATE SET ${updates.map((column) => `${column} = excluded.${column}`).join(", ")}` : "DO NOTHING"}`,
        values: columns.map((column) => row[column]),
      });
      if (table === "stops") {
        const previous = oldStops?.get(row.id);
        if (previous && (previous.lat !== row.lat || previous.lon !== row.lon))
          movedStops.push({
            id: String(row.id),
            before: [Number(previous.lat), Number(previous.lon)],
            after: [Number(row.lat), Number(row.lon)],
          });
      }
    }
    const tableDeletes = delta.deletes.map((row) => ({
      sql: `DELETE FROM ${table} WHERE ${keys.map((column) => `${column} = ?`).join(" AND ")}`,
      values: keys.map((column) => row[column]),
    }));
    deletes.unshift(...tableDeletes);
  }
  const changes = [...upserts, ...deletes];
  if (!changes.length) return { outcome: "unchanged", writes: 0 };
  if (topologyChanged)
    changes.push(
      {
        sql: "INSERT INTO seed_topology_meta (agency_id, feed_hash, table_hashes_json) VALUES (?, ?, ?) ON CONFLICT (agency_id) DO UPDATE SET feed_hash = excluded.feed_hash, table_hashes_json = excluded.table_hashes_json",
        values: [agencyId, input.feedHash, JSON.stringify(tableHashes)],
      },
      {
        sql: "INSERT INTO topology_meta (agency_id, last_sync) VALUES (?, ?) ON CONFLICT (agency_id) DO UPDATE SET last_sync = excluded.last_sync",
        values: [agencyId, (input.now ?? Date.now)()],
      },
    );
  await store.commit(changes);
  return { outcome: "updated", writes: changes.length, movedStops };
}

/** A read-only freshness probe, including databases that have never been seeded. */
export async function shouldRefreshSeedTopology(
  store: SeedSyncStore,
  agencyId: string,
  now: number,
): Promise<boolean> {
  if (!(await store.hasTopology(agencyId))) return true;
  const lastSync = await store.readLastSync(agencyId);
  const refreshThreshold = Math.max(0, TOPOLOGY_TTL_MS - 24 * 60 * 60_000);
  return lastSync === null || !Number.isFinite(lastSync) || now - lastSync >= refreshThreshold;
}

export async function probeSeedTopologyFreshness(
  db: D1DatabaseBinding,
  agencyId: string,
  now: () => number,
): Promise<boolean> {
  return shouldRefreshSeedTopology(createD1SeedSyncStore(db), agencyId, now());
}

/** Missing legacy tables are read as empty, without lazy DDL on a no-op refresh. */
export function createD1SeedSyncStore(
  db: D1DatabaseBinding,
  schema: readonly string[] = SURFACE_SCHEMA_STATEMENTS,
): SeedSyncStore {
  let knownTables: Promise<Set<string>> | undefined;
  const hasTable = async (name: string): Promise<boolean> => {
    knownTables ??= db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all<{ name: string }>()
      .then((result) => {
        if (!result.success) throw new Error("Seed schema read failed");
        return new Set(result.results.map((row) => row.name));
      });
    return (await knownTables).has(name);
  };
  return {
    hasTopology: async (id) => {
      if (!(await hasTable("routes"))) return false;
      return (
        (await db.prepare("SELECT id FROM routes WHERE agency_id = ? LIMIT 1").bind(id).first()) !==
        null
      );
    },
    readLastSync: async (id) => {
      if (!(await hasTable("topology_meta"))) return null;
      const row = await db
        .prepare("SELECT last_sync FROM topology_meta WHERE agency_id = ?")
        .bind(id)
        .first<{ last_sync: number }>();
      return row ? Number(row.last_sync) : null;
    },
    readMeta: async (id) => {
      if (!(await hasTable("seed_topology_meta"))) return null;
      const row = await db
        .prepare("SELECT feed_hash, table_hashes_json FROM seed_topology_meta WHERE agency_id = ?")
        .bind(id)
        .first<{ feed_hash: string; table_hashes_json: string }>();
      return row ? parseSeedSyncMeta(row.feed_hash, row.table_hashes_json) : null;
    },
    readTable: async (table, id) => {
      tableDefinition(table);
      if (!(await hasTable(table))) return [];
      const result = await db
        .prepare(`SELECT * FROM ${table} WHERE agency_id = ?`)
        .bind(id)
        .all<SeedRow>();
      if (!result.success) throw new Error(`Seed table read failed: ${table}`);
      return result.results;
    },
    commit: async (statements) => {
      if (!statements.length) return;
      // Keep schema, topology mutations, and metadata in one transaction.
      // Splitting the delta across batch calls leaves partial state on failure.
      const result = await db.batch([
        ...schema.map((sql) => db.prepare(sql)),
        ...statements.map((statement) => db.prepare(statement.sql).bind(...statement.values)),
      ]);
      if (Array.isArray(result) && result.some((item) => item?.success === false))
        throw new Error("Seed topology batch failed");
      knownTables = undefined;
    },
  };
}
