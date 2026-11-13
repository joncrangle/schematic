import { afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqliteDatabaseLike } from "~/infrastructure/storage/RuntimeBindings";

/**
 * node:sqlite availability varies by runner (Bun shims it only in recent
 * versions); sqlite-backed cases self-skip when the module cannot be loaded
 * rather than failing unrelated environments.
 */
export async function loadDatabaseSync(): Promise<
  (new (path: string) => SqliteDatabaseLike) | null
> {
  try {
    // Opaque specifier (same trick as RuntimeBindings' election ladder and
    // memoryD1): a literal "node:sqlite" is treated as bundle-able by Vite's
    // client-environment import analysis (happy-dom test transforms) and
    // rejected with "Cannot bundle Node.js built-in". The assembled specifier
    // keeps the import out of static analysis; vitest's module runner still
    // loads it natively at runtime under Node/Bun.
    const sqliteSpecifier = "node:" + "sqlite";
    const mod = await import(/* @vite-ignore */ sqliteSpecifier);
    return mod.DatabaseSync;
  } catch {
    return null;
  }
}

// CI sets this flag so missing SQLite support fails during collection instead
// of reporting every dependent suite as skipped. Local optional environments
// retain the existing skip behavior.
if (process.env.CI && !(await loadDatabaseSync())) {
  throw new Error("SQLite integration tests require a Node runtime with node:sqlite support");
}

const tempDbDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDbDirs) rmSync(dir, { force: true, recursive: true });
});

/** Creates a unique temp directory for a test database, cleaned up after the suite. */
export function makeTempDbPath(prefix = "ttc-sqlite-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDbDirs.push(dir);
  return join(dir, "test.db");
}
