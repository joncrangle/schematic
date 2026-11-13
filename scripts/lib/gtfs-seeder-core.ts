import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { AgencyProvider, AgencyScope } from "~/agencies/types";
import { allProviders } from "~/agencies/registry";
import {
  TRANSIT_BINDING_NAME,
  createSyncSqliteBinding,
  type D1DatabaseBinding,
} from "~/infrastructure/storage/RuntimeBindings";
import { agencyStoragePath } from "~/domain/agencyStoragePath";
import { SURFACE_SCHEMA_STATEMENTS } from "~/infrastructure/storage/surfaceStore/schema";
import {
  syncSeedTopology,
  reconcileSeedTopology,
  createD1SeedSyncStore,
  SEED_TABLES,
  type SeedRow,
  type SeedSyncResult,
  type SeedTable,
} from "~/infrastructure/storage/surfaceStore/seedSync";
import { deriveGtfsProjectionConfig } from "~/infrastructure/gtfs/config";
import type { GtfsTopology } from "~/infrastructure/gtfs/staticTopology";
import { assertGtfsArchiveSize, readGtfsArchiveResponse } from "~/infrastructure/gtfs/archive";
import { buildStationTimetableArchive } from "~/infrastructure/gtfs/stationTimetableArchive";
import type { StaticGtfsFeed } from "~/agencies/types";
import { createRemoteSeedSyncStore } from "./remote-seed-store";
export { modesToGtfsRouteTypes, deriveDirectionLabel } from "~/infrastructure/gtfs/staticTopology";
export { escapeSqlValue } from "./remote-seed-store";

/**
 * Shared multi-agency GTFS seeder core library.
 *
 * Provides agency-agnostic GTFS ETL pipelines: archive retrieval/caching,
 * CSV streaming, canonical shape calculation, polyline compression,
 * and SQLite / Cloudflare D1 synchronization.
 *
 * All agency configurations are derived dynamically from registered
 * AgencyProvider manifests (ADR-0007).
 */

/** Resolved D1 seeding destination under the per-agency binding convention. */
export interface SeedD1Target {
  readonly agencyId: string;
  readonly bindingName: string;
}

/**
 * Resolves the agency/binding pair the D1 seeder writes to: `--agency=<id>`
 * defaults to the shared `DB_TRANSIT` binding (ADR-0009); `--binding=<name>`
 * overrides explicitly.
 */
export function resolveSeedD1Target(args: readonly string[]): SeedD1Target {
  let agencyId = "ttc";
  let bindingName: string | undefined;
  for (const arg of args) {
    const agency = /^--agency=(.*)$/.exec(arg);
    if (agency) {
      if (!agency[1]) {
        throw new Error("Empty --agency value. Usage: --agency=<agency-id> e.g. --agency=go.");
      }
      agencyId = agency[1];
    }
    const binding = /^--binding=(.+)$/.exec(arg);
    if (binding) {
      bindingName = binding[1];
    }
  }
  return { agencyId, bindingName: bindingName ?? TRANSIT_BINDING_NAME };
}

export interface GtfsFeedSource {
  readonly name?: string;
  readonly url: string;
  readonly cacheFileName: string;
  readonly zenbus?: StaticGtfsFeed["zenbus"];
  readonly passio?: StaticGtfsFeed["passio"];
  readonly samsaraStations?: StaticGtfsFeed["samsaraStations"];
  readonly stationTimetables?: StaticGtfsFeed["stationTimetables"];
}

export interface AgencySeedConfig {
  readonly routeDirectionIds?: Readonly<Record<string, 0 | 1>>;
  readonly feedIdentities?: readonly import("~/infrastructure/gtfs/feedIdentity").FeedIdentity[];
  readonly id: string;
  readonly name: string;
  readonly defaultUrl: string;
  readonly cacheFileName: string;
  readonly feeds: readonly GtfsFeedSource[];
  readonly routeTypes: Set<number>;
  readonly defaultColor: string;
  readonly defaultTextColor: string;
  readonly routeIdField: "id" | "short_name";
  readonly sourceAgencyIds?: readonly string[];
  readonly excludedRouteIds?: readonly string[];
  readonly routeShortNames?: Readonly<Record<string, string>>;
  /** Canonical database filename within `scopePath`. */
  readonly dbFileName: string;
  /** Canonical agency path, e.g. `ca/on/ttc` or `intl/eurostar`. */
  readonly scopePath: string;
  readonly scope: AgencyScope;
  readonly jurisdiction?: {
    readonly country: string;
    readonly region?: string;
  };
  readonly bindingName: string;
}

export function matchesAgencyScope(config: AgencySeedConfig, requested: string): boolean {
  const value = requested
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, "");
  if (!value) return false;
  return (
    config.scopePath === value ||
    config.scope === value ||
    (value === "intl" && config.scope === "international") ||
    (value === "nat" && config.scope === "national") ||
    config.scopePath.startsWith(`${value}/`)
  );
}

export function deriveAgencySeedConfig(provider: AgencyProvider): AgencySeedConfig {
  const manifest = provider.manifest;
  const topology = provider.staticTopology;

  const feeds: GtfsFeedSource[] = (topology.feeds ?? []).map((feed, idx) => ({
    name: feed.name || `${manifest.name} Feed ${idx + 1}`,
    url: feed.url,
    cacheFileName: feed.cacheFileName || `gtfs-${manifest.id}${idx > 0 ? `-${idx}` : ""}.zip`,
    ...(feed.zenbus ? { zenbus: feed.zenbus } : {}),
    ...(feed.passio ? { passio: feed.passio } : {}),
    ...(feed.samsaraStations ? { samsaraStations: feed.samsaraStations } : {}),
    ...(feed.stationTimetables ? { stationTimetables: feed.stationTimetables } : {}),
  }));

  const primary = feeds[0] ?? {
    name: manifest.name,
    url: "",
    cacheFileName: `gtfs-${manifest.id}.zip`,
  };

  return {
    ...deriveGtfsProjectionConfig(manifest, topology),
    name: manifest.name,
    defaultUrl: primary.url,
    cacheFileName: primary.cacheFileName,
    feeds,
    dbFileName: "transit.db",
    scopePath: agencyStoragePath(manifest),
    scope: manifest.scope ?? "regional",
    ...(manifest.jurisdiction
      ? {
          jurisdiction: {
            country: manifest.jurisdiction.country,
            ...(manifest.jurisdiction.region ? { region: manifest.jurisdiction.region } : {}),
          },
        }
      : {}),
    bindingName: TRANSIT_BINDING_NAME,
  };
}

export function getAgencySeedConfig(agencyId: string): AgencySeedConfig | undefined {
  const normalized = agencyId
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, "");
  return getAllAgencySeedConfigs().find(
    (config) => config.id === normalized || config.scopePath === normalized,
  );
}

export function getAllAgencySeedConfigs(): AgencySeedConfig[] {
  return allProviders()
    .filter((p) => p.staticTopology.feeds && p.staticTopology.feeds.length > 0)
    .map(deriveAgencySeedConfig)
    .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Tables seeded in parent->child order, read out of SQLite to seed D1.
 *
 * Derived from the reconciler's own `SEED_TABLES` rather than restated, in the
 * same order. A second hand-maintained copy is how `route_direction_trips` came
 * to be seeded into SQLite but silently skipped on the remote path: the
 * reconciler filters its table list by what the caller supplies, so a table
 * missing from this list is dropped without error and the seed still reports
 * success. One list cannot drift from the other.
 */
export const SEEDED_TABLES = Object.keys(SEED_TABLES) as readonly SeedTable[];

/**
 * Seed-only DDL: tables owned by the GTFS seeder. Surface Transit
 * tables and indexes live solely in
 * `src/infrastructure/storage/surfaceStore/schema.ts` (SURFACE_SCHEMA_STATEMENTS).
 * Each statement must stay on a SINGLE physical line because miniflare D1's
 * exec() splits input on newlines.
 */
export const TRANSIT_SEED_ONLY_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS feed_metadata (agency_id TEXT NOT NULL DEFAULT 'ttc', key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (agency_id, key))`,
  `CREATE TABLE IF NOT EXISTS transit_snapshots (agency_id TEXT NOT NULL DEFAULT 'ttc', id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (agency_id, id))`,
  `CREATE TABLE IF NOT EXISTS transit_network (agency_id TEXT NOT NULL DEFAULT 'ttc', id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (agency_id, id))`,
  `CREATE TABLE IF NOT EXISTS transit_upcoming (agency_id TEXT NOT NULL DEFAULT 'ttc', id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (agency_id, id))`,
  `CREATE INDEX IF NOT EXISTS idx_transit_snapshots_updated_at ON transit_snapshots(agency_id, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_transit_upcoming_updated_at ON transit_upcoming(agency_id, updated_at)`,
];

/**
 * Composed transit-seed schema: canonical surface DDL first with
 * seed-only tables appended. SQLite, local D1, and remote D1 seed flows all
 * consume this array so they create the same topology as the runtime
 * `ensureSurfaceSchema` path (ADR-0009 lazy provisioning — the
 * seeder materializes stop_routes directly).
 */
export const TRANSIT_SEED_SCHEMA_STATEMENTS = [
  ...SURFACE_SCHEMA_STATEMENTS,
  ...TRANSIT_SEED_ONLY_STATEMENTS,
];

export function assertSqlIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe SQL identifier: "${name}"`);
  }
  return name;
}

export interface SeedTableRows {
  readonly table: string;
  readonly rows: Array<Record<string, unknown>>;
}

interface CacheMetaEntry {
  etag?: string;
  lastModified?: string;
  size?: number;
  checkedAt?: number;
}

export function resolveDataDir(): string {
  const envDir = process.env.DATA_DIR;
  if (envDir) return resolve(envDir);
  const localDataDir = resolve(process.cwd(), "data");
  if (existsSync(localDataDir)) return localDataDir;
  return process.cwd();
}

export function resolveGtfsFeedCachePath(feed: GtfsFeedSource): string {
  const dataDir = resolveDataDir();
  return resolve(dataDir, feed.cacheFileName);
}

const CACHE_META_FILE = ".gtfs-cache-meta.json";

function getCacheMetaPath(): string {
  return resolve(resolveDataDir(), CACHE_META_FILE);
}

function loadCacheMeta(): Record<string, CacheMetaEntry> {
  const metaPath = getCacheMetaPath();
  if (!existsSync(metaPath)) return {};
  try {
    return JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {
    return {};
  }
}

function saveCacheMeta(cacheKey: string, entry: CacheMetaEntry): void {
  const metaPath = getCacheMetaPath();
  try {
    const dir = dirname(metaPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    // Feed downloads run concurrently. Merge against the latest on-disk state
    // at the synchronous write boundary so stale snapshots cannot erase peers.
    const current = loadCacheMeta();
    writeFileSync(metaPath, JSON.stringify({ ...current, [cacheKey]: entry }, null, 2) + "\n");
  } catch {
    // Ignore in read-only environment
  }
}

function readBoundedGtfsArchive(path: string): Buffer {
  assertGtfsArchiveSize(statSync(path).size);
  const bytes = readFileSync(path);
  assertGtfsArchiveSize(bytes.byteLength);
  return bytes;
}

/**
 * The cached archive, or `undefined` when there is none. An oversized file is
 * not a valid cache and the size guard still rejects it.
 */
function readCachedArchiveIfValid(path: string): Buffer | undefined {
  if (!existsSync(path)) return undefined;
  return readBoundedGtfsArchive(path);
}

/** Error name only. Feed URLs can carry credentials, and transport messages quote the URL. */
function describeFailure(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * One feed's download failed and the operator may just be down. Callers skip the
 * feed on this and carry on. The archive size guards still throw plain errors,
 * since a malformed body is a real defect.
 */
export class FeedFetchError extends Error {
  readonly agencyId: string;
  readonly feed: GtfsFeedSource;
  /** Credential-free cause: an HTTP status or an error name, never a raw message. */
  readonly reason: string;

  constructor(agencyId: string, feed: GtfsFeedSource, reason: string) {
    super(`[seed:${agencyId}] GTFS feed ${feed.cacheFileName} is unavailable (${reason})`);
    this.name = "FeedFetchError";
    this.agencyId = agencyId;
    this.feed = feed;
    this.reason = reason;
  }
}

/**
 * Falls back to the cache when a download produced no usable body, or throws
 * `FeedFetchError` when there is nothing to fall back on. Only ever reads the
 * cache, so a failed download cannot damage the last good archive.
 */
function cachedArchiveOrSkip(
  agencyId: string,
  feed: GtfsFeedSource,
  cachePath: string,
  reason: string,
): Buffer {
  const cached = readCachedArchiveIfValid(cachePath);
  if (cached) {
    console.warn(
      `[seed:${agencyId}] ${feed.cacheFileName} download failed (${reason}); seeding from the cached ${(cached.length / (1024 * 1024)).toFixed(1)} MB archive, left untouched on disk.`,
    );
    return cached;
  }
  console.warn(
    `[seed:${agencyId}] ${feed.cacheFileName} download failed (${reason}) and no usable cached archive exists — skipping this feed.`,
  );
  throw new FeedFetchError(agencyId, feed, reason);
}

export async function fetchFeedArchive(
  feed: GtfsFeedSource,
  agencyId: string,
  zipArg?: string,
): Promise<Buffer> {
  if (zipArg) {
    if (/^https?:\/\//i.test(zipArg)) {
      console.log(`[seed:${agencyId}] Downloading explicit feed from ${zipArg}...`);
      const res = await fetch(zipArg, { headers: { Accept: "*/*" } });
      if (!res.ok) throw new Error(`Failed to download GTFS feed: ${res.status} ${res.statusText}`);
      return Buffer.from(await readGtfsArchiveResponse(res));
    }
    const path = resolve(zipArg);
    if (!existsSync(path)) throw new Error(`[seed:${agencyId}] ZIP file not found at ${path}`);
    return readBoundedGtfsArchive(path);
  }

  const localCachePath = resolveGtfsFeedCachePath(feed);
  if (feed.samsaraStations) {
    const { buildSamsaraStationsArchive } = await import("../../src/infrastructure/gtfs/samsaraStationsArchive");
    const buffer = Buffer.from(await buildSamsaraStationsArchive({ feed: { ...feed, samsaraStations: feed.samsaraStations }, fetch }));
    assertGtfsArchiveSize(buffer.length);
    writeFileSync(localCachePath, buffer);
    return buffer;
  }
  if (feed.passio) {
    const { buildPassioArchive } = await import("../../src/infrastructure/gtfs/passioArchive");
    const bytes = await buildPassioArchive({ feed: { ...feed, passio: feed.passio }, fetch });
    const buffer = Buffer.from(bytes);
    assertGtfsArchiveSize(buffer.length);
    writeFileSync(localCachePath, buffer);
    return buffer;
  }
  if (feed.zenbus) {
    const { buildZenbusArchive } = await import("../../src/infrastructure/gtfs/zenbusArchive");
    const bytes = await buildZenbusArchive({
      feed: { ...feed, zenbus: feed.zenbus },
      fetch,
      now: Date.now(),
    });
    const buffer = Buffer.from(bytes);
    assertGtfsArchiveSize(buffer.length);
    writeFileSync(localCachePath, buffer);
    return buffer;
  }
  if (feed.stationTimetables) {
    const { stationTimetables } = feed;
    console.log(`[seed:${agencyId}] Building ${feed.cacheFileName} from station boards...`);
    let built: Uint8Array;
    try {
      built = await buildStationTimetableArchive({
        feed: { ...feed, stationTimetables },
        fetch,
        now: Date.now(),
      });
    } catch (err) {
      return cachedArchiveOrSkip(agencyId, feed, localCachePath, describeFailure(err));
    }
    const buffer = Buffer.from(built);
    assertGtfsArchiveSize(buffer.length);
    try {
      writeFileSync(localCachePath, buffer);
    } catch {
      // Ignore cache write error in read-only filesystems
    }
    return buffer;
  }
  const cacheMeta = loadCacheMeta();
  const entry = cacheMeta[feed.cacheFileName];

  if (existsSync(localCachePath)) {
    const localStat = statSync(localCachePath);
    assertGtfsArchiveSize(localStat.size);
    let useCache = false;

    try {
      const reqHeaders: Record<string, string> = { Accept: "*/*" };
      if (entry?.etag) reqHeaders["If-None-Match"] = entry.etag;
      if (entry?.lastModified) reqHeaders["If-Modified-Since"] = entry.lastModified;

      const headRes = await fetch(feed.url, {
        method: "HEAD",
        headers: reqHeaders,
        signal: AbortSignal.timeout(8000),
      });

      if (headRes.status === 304) {
        console.log(
          `[seed:${agencyId}] Local GTFS cache is up-to-date (${(localStat.size / (1024 * 1024)).toFixed(1)} MB)`,
        );
        cacheMeta[feed.cacheFileName] = {
          ...entry,
          checkedAt: Date.now(),
        };
        saveCacheMeta(feed.cacheFileName, cacheMeta[feed.cacheFileName]!);
        useCache = true;
      }

      if (headRes.ok) {
        const remoteEtag = headRes.headers.get("etag") ?? undefined;
        const remoteLastMod = headRes.headers.get("last-modified") ?? undefined;
        const remoteLength = headRes.headers.get("content-length")
          ? parseInt(headRes.headers.get("content-length")!, 10)
          : undefined;

        const isIdentical =
          remoteLength !== undefined &&
          remoteLength === localStat.size &&
          ((remoteEtag && remoteEtag === entry?.etag) ||
            (remoteLastMod && remoteLastMod === entry?.lastModified));

        if (isIdentical) {
          console.log(
            `[seed:${agencyId}] Local GTFS cache is identical to remote (${(localStat.size / (1024 * 1024)).toFixed(1)} MB)`,
          );
          cacheMeta[feed.cacheFileName] = {
            etag: remoteEtag,
            lastModified: remoteLastMod,
            size: localStat.size,
            checkedAt: Date.now(),
          };
          saveCacheMeta(feed.cacheFileName, cacheMeta[feed.cacheFileName]!);
          useCache = true;
        }

        if (!isIdentical)
          console.log(
            `[seed:${agencyId}] Remote GTFS feed has updated — downloading fresh dataset...`,
          );
      }
    } catch (err) {
      console.warn(
        `[seed:${agencyId}] Could not verify remote feed freshness (${err instanceof Error ? err.message : String(err)}) — using local cache.`,
      );
      useCache = true;
    }
    // File validation is outside the freshness catch, including a file changed after stat.
    if (useCache) {
      const cached = readCachedArchiveIfValid(localCachePath);
      if (cached) return cached;
      // The probe above found it, so this is a vanished file, not a fetch failure.
      throw new Error(`[seed:${agencyId}] Cached GTFS archive disappeared: ${localCachePath}`);
    }
  } else {
    console.log(
      `[seed:${agencyId}] Fetching official ${feed.name ?? feed.cacheFileName} dataset...`,
    );
  }

  // Always try the latest archive first. A failure here is the operator being
  // down, so it falls back to cache or skips the feed; a body that breaks the
  // size guard is a different failure and keeps throwing.
  let res: Response;
  try {
    res = await fetch(feed.url, { headers: { Accept: "*/*" } });
  } catch (err) {
    return cachedArchiveOrSkip(
      agencyId,
      feed,
      localCachePath,
      `network request failed (${describeFailure(err)})`,
    );
  }
  if (!res.ok) {
    return cachedArchiveOrSkip(
      agencyId,
      feed,
      localCachePath,
      `HTTP ${res.status} ${res.statusText}`,
    );
  }

  const buffer = Buffer.from(await readGtfsArchiveResponse(res));
  const etag = res.headers.get("etag") ?? undefined;
  const lastModified = res.headers.get("last-modified") ?? undefined;

  console.log(
    `[seed:${agencyId}] Downloaded ${feed.cacheFileName} (${(buffer.length / (1024 * 1024)).toFixed(1)} MB)`,
  );

  try {
    writeFileSync(localCachePath, buffer);
    cacheMeta[feed.cacheFileName] = {
      etag,
      lastModified,
      size: buffer.length,
      checkedAt: Date.now(),
    };
    saveCacheMeta(feed.cacheFileName, cacheMeta[feed.cacheFileName]!);
  } catch {
    // Ignore cache write error in read-only filesystems
  }

  return buffer;
}

export async function fetchAgencyArchive(
  config: AgencySeedConfig,
  zipArg?: string,
): Promise<Buffer> {
  const primaryFeed = config.feeds[0];
  if (!primaryFeed && !zipArg) {
    throw new Error(`Agency ${config.id} has no declared static GTFS feeds`);
  }
  return fetchFeedArchive(
    primaryFeed ?? { url: "", cacheFileName: `gtfs-${config.id}.zip` },
    config.id,
    zipArg,
  );
}

export interface AgencyArchives {
  /** Feeds that downloaded or fell back to cache, in declared feed order. */
  readonly buffers: readonly Buffer[];
  /** Feeds the operator could not serve. */
  readonly failures: readonly FeedFetchError[];
}

/**
 * Every declared feed for one agency, partial results included. Settling each
 * feed keeps the good buffers and the failures side by side, so a caller seeds
 * what it can and reports the rest.
 */
export async function fetchAllAgencyArchives(
  config: AgencySeedConfig,
  zipArg?: string,
): Promise<AgencyArchives> {
  if (zipArg || config.feeds.length === 0) {
    const buf = await fetchAgencyArchive(config, zipArg);
    return { buffers: [buf], failures: [] };
  }
  const settled = await Promise.allSettled(
    config.feeds.map((feed) => fetchFeedArchive(feed, config.id, undefined)),
  );
  const buffers: Buffer[] = [];
  const failures: FeedFetchError[] = [];
  for (const outcome of settled) {
    if (outcome.status === "fulfilled") buffers.push(outcome.value);
    // Only an outage is skippable; anything else is a real defect.
    else if (outcome.reason instanceof FeedFetchError) failures.push(outcome.reason);
    else throw outcome.reason;
  }
  return { buffers, failures };
}

export function resolveAgencySqlitePath(_config?: AgencySeedConfig, dbPath?: string): string {
  if (dbPath) return dbPath;
  const dataDir = process.env.DATA_DIR;
  if (dataDir) return resolve(dataDir, "transit.db");
  return resolve(process.cwd(), "data", "transit.db");
}

export async function seedAgencySqlite(
  config: AgencySeedConfig,
  zipBuffer: Buffer | readonly Buffer[],
  dbPath?: string,
  topology?: GtfsTopology,
): Promise<string> {
  const buffers = Array.isArray(zipBuffer) ? zipBuffer : [zipBuffer];
  if (buffers.length !== config.feeds.length) {
    throw new Error(
      `[seed:${config.id}] Refusing topology sync: received ${buffers.length} archive(s) for ${config.feeds.length} declared feeds.`,
    );
  }

  const targetDbPath = resolveAgencySqlitePath(config, dbPath);
  const targetDir = dirname(targetDbPath);
  if (targetDir && targetDir !== "." && !existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Database } = require("bun:sqlite");
  const db = new Database(targetDbPath);
  try {
    const result = await syncSeedTopology({
      config,
      archives: async () => buffers,
      topology,
      store: createD1SeedSyncStore(createSyncSqliteBinding(db), TRANSIT_SEED_SCHEMA_STATEMENTS),
      allowInitialSeed: true,
      verifyDestination: true,
    });
    reportSeedResult(config.id, result);
  } finally {
    db.close();
  }

  const stats = statSync(targetDbPath);
  console.log(
    `[seed:${config.id}] Database created at ${targetDbPath} (${(stats.size / (1024 * 1024)).toFixed(2)} MB)`,
  );
  return targetDbPath;
}

export function readSeededTables(dbPath: string, agencyId?: string): SeedTableRows[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Database } = require("bun:sqlite");
  const db = new Database(dbPath, { readonly: true });
  try {
    return SEEDED_TABLES.map((table) => {
      const sqlIdentifier = assertSqlIdentifier(table);
      const exists = db
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      if (!exists) {
        if (table === "stop_routes") {
          const stops = agencyId
            ? db.query("SELECT * FROM stops WHERE agency_id = ?").all(agencyId)
            : db.query("SELECT * FROM stops").all();
          return {
            table,
            rows: stops.flatMap((stop: SeedRow) =>
              JSON.parse(String(stop.routes_json)).map((routeId: string) => ({
                agency_id: stop.agency_id,
                stop_id: stop.id,
                route_id: routeId,
              })),
            ),
          };
        }
        if (table === "feed_metadata") return { table, rows: [] };
        throw new Error(`Source SQLite is missing ${table}; seed SQLite first`);
      }
      const query = agencyId
        ? `SELECT * FROM ${sqlIdentifier} WHERE agency_id = ?`
        : `SELECT * FROM ${sqlIdentifier}`;
      const rows = (agencyId ? db.query(query).all(agencyId) : db.query(query).all()) as Array<
        Record<string, unknown>
      >;
      return {
        table,
        rows,
      };
    });
  } finally {
    db.close();
  }
}

export function readSeedFeedHash(dbPath: string, agencyId: string): string | null {
  const { Database } = require("bun:sqlite");
  const db = new Database(dbPath, { readonly: true });
  try {
    if (!db.query("SELECT name FROM sqlite_master WHERE name = 'seed_topology_meta'").get())
      return null;
    const row = db
      .query("SELECT feed_hash FROM seed_topology_meta WHERE agency_id = ?")
      .get(agencyId);
    return typeof row?.feed_hash === "string" ? row.feed_hash : null;
  } finally {
    db.close();
  }
}

function reportSeedResult(agencyId: string, result: SeedSyncResult): void {
  console.log(`[seed:${agencyId}] ${result.outcome}: ${result.writes} row mutations`);
  if (result.movedStops?.length)
    console.warn(
      `[seed:${agencyId}] Stops moved: ${JSON.stringify(result.movedStops)}. Run bun scripts/seed.ts --agency=${agencyId} --db=sqlite to regenerate stationIndex, then bun scripts/seed.ts --interchange-only; review and commit generated artifacts.`,
    );
}

export async function seedAgencyD1(config: AgencySeedConfig, sourceDbPath?: string): Promise<void> {
  const resolvedSource = resolveAgencySqlitePath(config, sourceDbPath);

  if (!existsSync(resolvedSource)) {
    throw new Error(
      `[seed:${config.id}:d1] Source SQLite database not found at ${resolvedSource}. Seed SQLite first.`,
    );
  }

  console.log(`[seed:${config.id}:d1] Reading seeded tables from ${resolvedSource}...`);
  const tablesWithRows = readSeededTables(resolvedSource, config.id);

  console.log(
    `[seed:${config.id}:d1] Connecting to local D1 binding ${config.bindingName} via platform proxy...`,
  );
  const { getPlatformProxy } = await import("wrangler");
  const proxy = await getPlatformProxy();

  try {
    const d1 = (proxy.env as Record<string, D1DatabaseBinding | undefined>)[config.bindingName];
    if (!d1) {
      throw new Error(
        `[seed:${config.id}:d1] No D1 binding "${config.bindingName}" found in platform proxy. Check wrangler.jsonc.`,
      );
    }

    const feedHash = readSeedFeedHash(resolvedSource, config.id);
    const result = await reconcileSeedTopology({
      agencyId: config.id,
      topology: Object.fromEntries(
        tablesWithRows.map(({ table, rows }) => [table, rows as SeedRow[]]),
      ),
      feedHash: feedHash ?? "legacy-sqlite",
      store: createD1SeedSyncStore(d1, TRANSIT_SEED_SCHEMA_STATEMENTS),
      verifyDestination: true,
    });
    reportSeedResult(config.id, result);

    console.log(
      `[seed:${config.id}:d1] Successfully synced tables to D1 binding ${config.bindingName}.`,
    );
  } finally {
    await proxy.dispose();
  }
}

/** Seeds the configured Cloudflare D1 database through Wrangler's remote API. */
export async function seedAgencyRemoteD1(
  config: AgencySeedConfig,
  sourceDbPath?: string,
): Promise<void> {
  const resolvedSource = resolveAgencySqlitePath(config, sourceDbPath);
  if (!existsSync(resolvedSource)) {
    throw new Error(
      `[seed:${config.id}:remote] Source SQLite database not found at ${resolvedSource}. Seed SQLite first.`,
    );
  }

  const feedHash = readSeedFeedHash(resolvedSource, config.id);
  const topology = Object.fromEntries(
    readSeededTables(resolvedSource, config.id).map(({ table, rows }) => [
      table,
      rows as SeedRow[],
    ]),
  );
  const result = await reconcileSeedTopology({
    agencyId: config.id,
    topology,
    feedHash: feedHash ?? "legacy-sqlite",
    store: createRemoteSeedSyncStore({
      bindingName: config.bindingName,
      schema: TRANSIT_SEED_SCHEMA_STATEMENTS,
    }),
    verifyDestination: true,
  });
  reportSeedResult(config.id, result);
}
