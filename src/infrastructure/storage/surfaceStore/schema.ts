/**
 * Surface store schema.
 *
 * Single canonical home for the surface D1 DDL + lazy per-binding bootstrap.
 *
 * IMPORTANT: each statement must live on a SINGLE physical line joined
 * by ";\n". Local miniflare D1's exec() splits input on newlines, so embedded
 * newlines inside a statement are parsed as statement terminators
 * ("incomplete input" errors). Remote D1 and bun/node sqlite accept this form
 * identically. Same convention as subscriptionSchema.ts.
 */
import type { D1DatabaseBinding } from "../RuntimeBindings";

export const SURFACE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS routes (agency_id TEXT NOT NULL, id TEXT NOT NULL, short_name TEXT NOT NULL, long_name TEXT NOT NULL, route_type INTEGER NOT NULL, color TEXT NOT NULL DEFAULT '#64748B', text_color TEXT NOT NULL DEFAULT 'FFFFFF', PRIMARY KEY (agency_id, id))`,
  `CREATE TABLE IF NOT EXISTS stops (agency_id TEXT NOT NULL, id TEXT NOT NULL, code TEXT, name TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, wheelchair INTEGER NOT NULL DEFAULT 0, parent_station TEXT, routes_json TEXT NOT NULL, PRIMARY KEY (agency_id, id))`,
  `CREATE INDEX IF NOT EXISTS idx_stops_agency_lat_lon ON stops (agency_id, lat, lon)`,
  `CREATE INDEX IF NOT EXISTS idx_stops_agency_code ON stops (agency_id, code)`,
  `CREATE TABLE IF NOT EXISTS route_shapes (agency_id TEXT NOT NULL, id TEXT NOT NULL, route_id TEXT NOT NULL, direction_id INTEGER NOT NULL, headsign TEXT NOT NULL, polyline TEXT NOT NULL, min_lat REAL NOT NULL, max_lat REAL NOT NULL, min_lon REAL NOT NULL, max_lon REAL NOT NULL, point_count INTEGER NOT NULL, direction_label TEXT, PRIMARY KEY (agency_id, id), FOREIGN KEY (agency_id, route_id) REFERENCES routes(agency_id, id))`,
  `CREATE INDEX IF NOT EXISTS idx_route_shapes_route ON route_shapes (agency_id, route_id, direction_id)`,
  `CREATE TABLE IF NOT EXISTS route_stops (agency_id TEXT NOT NULL, route_id TEXT NOT NULL, direction_id INTEGER NOT NULL, stop_sequence INTEGER NOT NULL, stop_id TEXT NOT NULL, PRIMARY KEY (agency_id, route_id, direction_id, stop_sequence), FOREIGN KEY (agency_id, route_id) REFERENCES routes(agency_id, id), FOREIGN KEY (agency_id, stop_id) REFERENCES stops(agency_id, id))`,
  `CREATE INDEX IF NOT EXISTS idx_route_stops_stop ON route_stops (agency_id, stop_id)`,
  // One row per direction group, not one per trip: the trip ids a group owns
  // travel together as a JSON array. D1 charges a written row per index entry,
  // so the per-trip form cost ~386k writes for 11 agencies against ~1.4k here,
  // and because trip_id churns across feed updates it re-paid that cost weekly.
  // The primary key is the whole key: the only read filters agency_id and
  // route_id, which is exactly this key's prefix, so a secondary index would
  // double the write cost to serve a lookup the primary key already answers.
  // `part` is part of the key because a direction group holding more trips than
  // one statement can carry is spread over several rows. `part` is 0 for every
  // group small enough to fit in one row, which is all of them outside GO's UP
  // line, and it keeps the key unique for the parts of the groups that do not.
  `CREATE TABLE IF NOT EXISTS route_direction_trips (agency_id TEXT NOT NULL, route_id TEXT NOT NULL, direction_id INTEGER NOT NULL, part INTEGER NOT NULL DEFAULT 0, trip_ids TEXT NOT NULL, PRIMARY KEY (agency_id, route_id, direction_id, part), FOREIGN KEY (agency_id, route_id) REFERENCES routes(agency_id, id))`,
  // Additive upgrade: no existing keys or tables change. Unseeded trip ids
  // remain unknown until the next seed, rather than borrowing another trip's end.
  `CREATE TABLE IF NOT EXISTS route_trip_terminals (agency_id TEXT NOT NULL, route_id TEXT NOT NULL, direction_id INTEGER NOT NULL, terminal_stop_id TEXT NOT NULL, terminal_stop_sequence INTEGER NOT NULL, part INTEGER NOT NULL DEFAULT 0, trip_ids TEXT NOT NULL, PRIMARY KEY (agency_id, route_id, direction_id, terminal_stop_id, terminal_stop_sequence, part), FOREIGN KEY (agency_id, route_id) REFERENCES routes(agency_id, id))`,
  // Additive upgrade, like trip terminals: one row per route and headsign.
  `CREATE TABLE IF NOT EXISTS route_trip_headsigns (agency_id TEXT NOT NULL, route_id TEXT NOT NULL, headsign TEXT NOT NULL, part INTEGER NOT NULL DEFAULT 0, trip_ids TEXT NOT NULL, PRIMARY KEY (agency_id, route_id, headsign, part), FOREIGN KEY (agency_id, route_id) REFERENCES routes(agency_id, id))`,
  `CREATE TABLE IF NOT EXISTS stop_routes (agency_id TEXT NOT NULL, stop_id TEXT NOT NULL, route_id TEXT NOT NULL, PRIMARY KEY (agency_id, route_id, stop_id))`,
  `CREATE TABLE IF NOT EXISTS topology_meta (agency_id TEXT PRIMARY KEY, last_sync INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS seed_topology_meta (agency_id TEXT PRIMARY KEY, feed_hash TEXT NOT NULL, table_hashes_json TEXT NOT NULL)`,
];

export const CREATE_SURFACE_TABLES_SQL = `${SURFACE_SCHEMA_STATEMENTS.join(";\n")};`;

/** Table and index names the probe checks; a test requires every statement to yield one. */
export const SURFACE_SCHEMA_OBJECT_NAMES = SURFACE_SCHEMA_STATEMENTS.flatMap((statement) => {
  const name = /^CREATE (?:TABLE|INDEX) IF NOT EXISTS (\w+)/.exec(statement)?.[1];
  return name === undefined ? [] : [name];
});

const SURFACE_SCHEMA_PROBE_SQL = `SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN (${SURFACE_SCHEMA_OBJECT_NAMES.map(() => "?").join(", ")})`;

/** One read replaces the DDL batch on a cold isolate; the schema is CREATE-only, so presence proves it is current. */
async function surfaceSchemaExists(db: D1DatabaseBinding): Promise<boolean> {
  const row = await db
    .prepare(SURFACE_SCHEMA_PROBE_SQL)
    .bind(...SURFACE_SCHEMA_OBJECT_NAMES)
    .first<{ n: number }>();
  return row?.n === SURFACE_SCHEMA_OBJECT_NAMES.length;
}

/**
 * Unified schema-bootstrap canonical, one WeakMap for all D1 bindings.
 * The probe (and, when objects are missing, the CREATE batch) fires on the
 * first operation against `db`, never at import or layer-construction time.
 * Executed exactly once per binding, coalesced single-flight, evict-on-failure.
 */
const schemaBootstrapByBinding = new WeakMap<D1DatabaseBinding, Promise<void>>();

export function ensureSurfaceSchema(db: D1DatabaseBinding): Promise<void> {
  const existing = schemaBootstrapByBinding.get(db);
  if (existing) return existing;
  const bootstrapPromise = (async () => {
    if (await surfaceSchemaExists(db)) return;
    await db.exec(CREATE_SURFACE_TABLES_SQL);
  })().catch((e) => {
    schemaBootstrapByBinding.delete(db);
    throw e;
  });
  schemaBootstrapByBinding.set(db, bootstrapPromise);
  return bootstrapPromise;
}
