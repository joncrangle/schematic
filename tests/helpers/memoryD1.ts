import type {
  D1DatabaseBinding,
  SqliteDatabaseLike,
} from "~/infrastructure/storage/RuntimeBindings";
import { createSyncSqliteBinding } from "~/infrastructure/storage/RuntimeBindings";
import { CREATE_SURFACE_TABLES_SQL } from "~/infrastructure/storage/surfaceStore/schema";

/**
 * In-memory D1 fixture shared by the topology suites: node:sqlite's
 * DatabaseSync pre-loaded with the canonical surface schema (single DDL
 * authority) and wrapped in the sync sqlite→D1 binding. The specifier is
 * assembled at runtime so Vite's import analysis never tries to bundle the
 * Node built-in (same trick as RuntimeBindings' election ladder). Row seeding
 * stays with each suite, issued through the returned binding's
 * prepare/bind/run surface.
 */

/** Raw node:sqlite handle, for fixtures that seed rows before wrapping. */
export async function openMemorySurfaceDb(): Promise<SqliteDatabaseLike> {
  const sqliteSpec = "node:" + "sqlite";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { DatabaseSync } = (await import(/* @vite-ignore */ sqliteSpec)) as any;
  const db = new DatabaseSync(":memory:") as unknown as SqliteDatabaseLike;
  db.exec(CREATE_SURFACE_TABLES_SQL);
  return db;
}

/** Surface-schema in-memory SQLite database wrapped as a D1DatabaseBinding. */
export async function createMemoryD1(): Promise<D1DatabaseBinding> {
  return createSyncSqliteBinding(await openMemorySurfaceDb());
}
