import * as Data from "effect/Data";

/**
 * Single runtime storage-binding seam.
 *
 * Owns ALL SQL binding plumbing for SurfaceDataStore and
 * SubscriptionRepository:
 *
 * - the D1 binding structural types,
 * - the Bun/node synchronous SQLite adapters,
 * - ONE election ladder (`resolveRuntimeBinding`) consulted by every storage
 *   consumer, memoized per binding name as a promise with
 *   evict-on-failure retry,
 * - a loud refusal error, misconfiguration NEVER silently degrades to an
 *   in-memory store in production paths.
 */

/**
 * Cloudflare D1 interface types for Worker binding runtime.
 */
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run(): Promise<{ success: boolean; error?: string }>;
  all<T = unknown>(): Promise<{ results: T[]; success: boolean }>;
}

export interface D1DatabaseBinding {
  prepare(query: string): D1PreparedStatement;
  exec(query: string): Promise<unknown>;
  /**
   * Executes every statement as one atomic unit. Mirrors Cloudflare D1's
   * native `batch()`, which runs the sequence as a SQL transaction: a
   * failure aborts/rolls back the entire sequence. Satisfied structurally
   * by real D1Database bindings; local SQLite adapters implement it via
   * BEGIN/COMMIT.
   */
  batch(statements: D1PreparedStatement[]): Promise<unknown>;
}

/**
 * Structural subset of `bun:sqlite`'s Database and `node:sqlite`'s
 * DatabaseSync that the shared binding adapter below actually uses. Both
 * runtimes expose the same synchronous exec/prepare/get/all/run surface.
 */
export interface SqliteDatabaseLike {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...values: unknown[]): unknown;
    get(...values: unknown[]): unknown;
    all(...values: unknown[]): unknown[];
  };
}

/** Create the canonical DATA_DIR hierarchy before opening a SQLite file. */
async function ensureSqliteParentDirectory(dbPath: string): Promise<void> {
  // Opaque specifiers (same trick as the node:sqlite arm below): a literal
  // "node:fs" is statically resolved by the worker bundler into an unenv
  // stub whose mkdirSync throws at runtime ("[unenv] fs.mkdirSync is not
  // implemented yet!"). The assembled specifier keeps the import out of
  // static analysis so Bun/Node/workerd load their real fs at runtime.
  // This helper only runs on server SQLite arms, never in browser bundles.
  const fs = await import(/* @vite-ignore */ "node:" + "fs");
  const path = await import(/* @vite-ignore */ "node:" + "path");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

/**
 * Single adapter turning a synchronous SQLite database handle into a
 * D1DatabaseBinding-compatible object (WAL journaling, lazy statement
 * execution, D1-shaped results). Used by both the Bun and node:sqlite
 * flavors so their semantics can never drift.
 *
 * Foreign-key enforcement is required for D1-compatible delete behavior.
 * Journal mode and synchronous settings are best-effort because some
 * embedded builds reject those performance pragmas while remaining usable.
 */
export function createSyncSqliteBinding(db: SqliteDatabaseLike): D1DatabaseBinding {
  db.exec("PRAGMA foreign_keys = ON;");
  for (const pragma of ["PRAGMA journal_mode = WAL;", "PRAGMA synchronous = NORMAL;"]) {
    try {
      db.exec(pragma);
    } catch {
      // Ignore, see doc comment above.
    }
  }

  let bindingUnavailable = false;
  const assertBindingAvailable = () => {
    if (bindingUnavailable) {
      throw new Error("SQLite binding is unavailable after a failed transaction rollback");
    }
  };

  let queue: Promise<void> = Promise.resolve();
  const enqueue = <T>(operation: () => T | PromiseLike<T>): Promise<T> => {
    const result = queue.then(operation) as Promise<T>;
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  // A batch may only execute statements prepared by this connection. Capture
  // their bindings before queueing, then run the entire transaction synchronously.
  const batchExecutions = new WeakMap<D1PreparedStatement, () => () => void>();

  const makePreparedStatement = (query: string): D1PreparedStatement => {
    let boundValues: readonly unknown[] = [];
    const statement: D1PreparedStatement = {
      bind: (...values) => {
        boundValues = [...values];
        return statement;
      },
      first: <T>() => {
        const values = [...boundValues];
        return enqueue(() => {
          assertBindingAvailable();
          return (db.prepare(query).get(...values) ?? null) as T | null;
        });
      },
      all: <T>() => {
        const values = [...boundValues];
        return enqueue(() => {
          assertBindingAvailable();
          return {
            results: db.prepare(query).all(...values) as T[],
            success: true,
          };
        });
      },
      run: () => {
        const values = [...boundValues];
        return enqueue(() => {
          assertBindingAvailable();
          db.prepare(query).run(...values);
          return { success: true };
        });
      },
    };
    batchExecutions.set(statement, () => {
      const values = [...boundValues];
      return () => {
        db.prepare(query).run(...values);
      };
    });
    return statement;
  };

  return {
    prepare: (query: string) => makePreparedStatement(query),
    exec: (query: string) =>
      enqueue(() => {
        assertBindingAvailable();
        return db.exec(query);
      }),
    batch: (statements) => {
      const executions = statements.map((statement) => batchExecutions.get(statement)?.());
      return enqueue(() => {
        assertBindingAvailable();
        if (executions.some((execute) => !execute)) {
          throw new Error("SQLite batch statements must be prepared by the same binding");
        }
        db.exec("BEGIN");
        try {
          for (const execute of executions) execute!();
          db.exec("COMMIT");
        } catch (err) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // Preserve the statement or commit failure that triggered rollback.
            bindingUnavailable = true;
          }
          throw err;
        }
      });
    },
  };
}

/**
 * Creates a D1DatabaseBinding-compatible adapter from a local SQLite database via `bun:sqlite`.
 */
export async function createBunSqliteBinding(dbPath: string): Promise<D1DatabaseBinding> {
  // Opaque specifier (same bundler reason as above); reached only when
  // globalThis.Bun exists, i.e. the self-hosted Bun runtime.
  const { Database } = await import(/* @vite-ignore */ "bun:" + "sqlite");
  await ensureSqliteParentDirectory(dbPath);
  return createSyncSqliteBinding(new Database(dbPath));
}

/**
 * Creates a D1DatabaseBinding-compatible adapter from node:sqlite's
 * DatabaseSync via the shared synchronous-SQLite binding adapter.
 */
export async function createNodeSqliteBinding(
  dbPath: string,
  DatabaseCtor: new (path: string) => SqliteDatabaseLike,
): Promise<D1DatabaseBinding> {
  await ensureSqliteParentDirectory(dbPath);
  return createSyncSqliteBinding(new DatabaseCtor(dbPath));
}

export const TRANSIT_BINDING_NAME = "DB_TRANSIT";
export const NOTIFICATIONS_BINDING_NAME = "DB_NOTIFICATIONS";

/**
 * Thrown when no storage backend can be elected for a D1 binding. Production
 * paths must fail LOUDLY here, there is no implicit in-memory fallback
 * outside explicit test-tier constructions.
 */
export class StorageBindingRefusedError extends Data.TaggedError("StorageBindingRefusedError")<{
  readonly bindingName: string;
}> {
  get message(): string {
    return `No storage backend available for D1 binding "${this.bindingName}". Add a wrangler D1 binding named "${this.bindingName}" (wrangler.jsonc d1_databases) or set DATA_DIR to a SQLite database directory. In-memory storage is disabled outside tests.`;
  }
}

// One elected-backend promise per binding name. The PROMISE is cached so
// concurrent/repeat callers share a single elected backend instance; a
// rejection evicts the key so the next caller retries the whole ladder
// (evict-on-failure). Tests isolate via vi.resetModules(), no reset export.
const resolvedBindings = new Map<string, Promise<D1DatabaseBinding>>();

/**
 * Elects the storage backend for `name`, in order:
 *
 * 1. `globalThis.env[name]`, production Workers deploys (wrangler bindings).
 * 2. the workerd-only `cloudflare:workers` module env, production Workers AND
 *    local `vite dev` through @cloudflare/vite-plugin (miniflare serves the
 *    wrangler.jsonc D1 binding locally under .wrangler/state).
 * 3. `DATA_DIR` under the Bun runtime, self-hosted `bun`.
 * 4. `DATA_DIR` via `node:sqlite` DatabaseSync, plain Node / Docker.
 *    Loaded dynamically so environments without node:sqlite fail here instead
 *    of at module link time.
 * 5. loud refusal, no memory fallback, no silent nulls.
 *
 * Open/import failures of an ELECTED arm propagate (misconfiguration must be
 * visible), while absent arms fall through to the next candidate.
 */
async function electRuntimeBinding(name: string): Promise<D1DatabaseBinding> {
  // 1. Cloudflare D1 environment binding
  const hostEnv = (globalThis as { env?: Record<string, unknown> }).env;
  const hostCandidate = hostEnv?.[name];
  if (hostCandidate) {
    return hostCandidate as D1DatabaseBinding;
  }

  // 2. Cloudflare bindings via the cloudflare:workers module, present in
  // workerd runtimes: production Workers deploys AND local `vite dev` through
  // @cloudflare/vite-plugin (miniflare serves the wrangler.jsonc D1 binding
  // locally under .wrangler/state). This is what makes subscriptions persist
  // during development.
  try {
    // The specifier is assembled at runtime so vite/vitest's static
    // import-analysis never tries to resolve this workerd-only virtual
    // module; non-workerd runtimes simply throw here and fall through.
    const workersModuleSpecifier = "cloudflare" + ":workers";
    const { env: workersEnv } = await import(/* @vite-ignore */ workersModuleSpecifier);
    const candidate = (workersEnv as Record<string, unknown> | undefined)?.[name];
    if (candidate) {
      return candidate as D1DatabaseBinding;
    }
  } catch {
    // Not a workerd runtime (bun/node self-hosting), fall through.
  }

  // Self-hosting uses shared flat SQLite files in DATA_DIR. Agency identity
  // scopes rows in transit.db; it does not select a separate database path.
  const env =
    typeof process !== "undefined"
      ? (process.env as Record<string, string | undefined>)
      : undefined;

  let effectivePath: string | undefined;

  if (name === NOTIFICATIONS_BINDING_NAME) {
    effectivePath = env?.DATA_DIR
      ? `${env.DATA_DIR.replace(/\/+$/, "")}/push-notifications.db`
      : undefined;
  } else if (name === TRANSIT_BINDING_NAME) {
    effectivePath = env?.DATA_DIR ? `${env.DATA_DIR.replace(/\/+$/, "")}/transit.db` : undefined;
  }

  // 3. Bun SQLite (self-hosted Bun runtime)
  if (effectivePath && typeof globalThis.Bun !== "undefined") {
    return createBunSqliteBinding(effectivePath);
  }

  // 4. node:sqlite (vite-dev SSR / Node self-hosting)
  if (effectivePath) {
    // Same runtime-assembled specifier trick as the cloudflare:workers arm
    // above: a literal "node:sqlite" is treated as bundle-able by Vite's
    // client-environment import analysis (happy-dom test transforms) and
    // rejected with "Cannot bundle Node.js built-in". The opaque specifier
    // keeps the import out of static analysis; vitest's module runner still
    // loads it natively at runtime under Node.
    const nodeSqliteSpecifier = "node:" + "sqlite";
    const { DatabaseSync } = await import(/* @vite-ignore */ nodeSqliteSpecifier);
    return createNodeSqliteBinding(effectivePath, DatabaseSync);
  }

  // 5. Refuse loudly, no in-memory fallback outside explicit test tiers.
  throw new StorageBindingRefusedError({ bindingName: name });
}

export function resolveRuntimeBinding(name: string): Promise<D1DatabaseBinding> {
  const existing = resolvedBindings.get(name);
  if (existing) return existing;

  const elected = electRuntimeBinding(name).catch((err) => {
    resolvedBindings.delete(name); // evict-on-failure: next caller retries
    throw err;
  });
  resolvedBindings.set(name, elected);
  return elected;
}
