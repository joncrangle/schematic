vi.mock("~/agencies/agencyCatalog", async () => {
  const { testAgencyCatalog } = await import("../helpers/agency-fixtures");
  return { agencyCatalog: testAgencyCatalog };
});
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";

/**
 * Tests for the single runtime storage-binding seam.
 *
 * The seam owns the whole election ladder (globalThis.env → cloudflare:workers
 * → Bun sqlite → node:sqlite → loud refusal) and memoizes the elected backend
 * PER BINDING NAME as a promise, evicting on failure so a later caller retries.
 * There is deliberately no reset export — suites isolate via vi.resetModules()
 * plus a dynamic import of the module under test.
 */

type RuntimeBindingsModule = typeof import("~/infrastructure/storage/RuntimeBindings");

async function loadSeam(): Promise<RuntimeBindingsModule> {
  return await import("~/infrastructure/storage/RuntimeBindings");
}

const originalGlobalEnv = (globalThis as { env?: unknown }).env;
const originalDataDir = process.env.DATA_DIR;

function setGlobalEnv(env: Record<string, unknown> | undefined): void {
  (globalThis as { env?: Record<string, unknown> }).env = env;
}

function removeDatabasePath(): void {
  delete process.env.DATA_DIR;
}

beforeEach(() => {
  // Fresh memo map per test: the seam has no reset export by design.
  vi.resetModules();
});

afterEach(() => {
  setGlobalEnv(originalGlobalEnv as Record<string, unknown> | undefined);
  if (originalDataDir === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = originalDataDir;
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("resolveRuntimeBinding", () => {
  it("elects one shared backend per binding name across concurrent and repeat resolves", async () => {
    const sentinel = { __sentinelD1: true };
    setGlobalEnv({ DB_TRANSIT: sentinel });
    removeDatabasePath();

    const { resolveRuntimeBinding } = await loadSeam();

    // Concurrent callers must share ONE election (and therefore ONE instance).
    const [concurrentA, concurrentB] = await Promise.all([
      resolveRuntimeBinding("DB_TRANSIT"),
      resolveRuntimeBinding("DB_TRANSIT"),
    ]);
    expect(concurrentA).toBe(sentinel);
    expect(concurrentB).toBe(sentinel);

    // A later resolve keeps returning the same elected backend — no re-election.
    const later = await resolveRuntimeBinding("DB_TRANSIT");
    expect(later).toBe(sentinel);
  });

  it.each(["DB_TRANSIT", "DB_NOTIFICATIONS"])(
    "refuses %s naming the binding and both remedies (no silent memory fallback)",
    async (bindingName) => {
      setGlobalEnv({});
      removeDatabasePath();

      const { resolveRuntimeBinding } = await loadSeam();

      let caught: unknown;
      try {
        await resolveRuntimeBinding(bindingName);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeDefined();
      expect((caught as { _tag?: string })._tag).toBe("StorageBindingRefusedError");
      const refusal = caught as Error & { bindingName: string };
      expect(refusal.bindingName).toBe(bindingName);
      expect(refusal.message).toContain(bindingName);
      expect(refusal.message).toContain("wrangler");
      expect(refusal.message).toContain("DATA_DIR");
    },
  );

  it("evicts a failed election so the next caller retries the ladder", async () => {
    // First election fails: DATA_DIR points into a directory that does
    // not exist, and the Bun arm is forced so the open error propagates.
    vi.stubGlobal("Bun", {});
    process.env.DATA_DIR = join(tmpdir(), `ttc-missing-${crypto.randomUUID()}`, "elected.db");

    const { resolveRuntimeBinding } = await loadSeam();
    await expect(resolveRuntimeBinding("DB_TRANSIT")).rejects.toThrow();

    // Misconfiguration fixed: the binding now arrives via globalThis.env. The
    // second resolve must retry the ladder instead of replaying the rejection.
    const sentinel = { __sentinelD1: true };
    setGlobalEnv({ DB_TRANSIT: sentinel });
    const db = await resolveRuntimeBinding("DB_TRANSIT");
    expect(db).toBe(sentinel);
  });
});

describe("workerd election arm (cloudflare:workers)", () => {
  // Per-test mock registration: a file-hoisted vi.mock would feed the
  // workers-env binding into every ladder test below it (refusal and eviction
  // both depend on this arm being absent).
  const WORKERS_SPECIFIER = "cloudflare:workers";

  afterEach(() => {
    vi.doUnmock(WORKERS_SPECIFIER);
  });

  it("elects one shared backend from the workers env when globalThis.env is empty", async () => {
    const sentinel = { __sentinelD1WorkersArm: true };
    setGlobalEnv({}); // arm 1 must miss so the ladder reaches cloudflare:workers
    removeDatabasePath();
    vi.doMock(WORKERS_SPECIFIER, () => ({ env: { DB_TRANSIT: sentinel } }));

    const { resolveRuntimeBinding } = await loadSeam();

    // Concurrent callers share ONE elected backend (memoized promise)...
    const [concurrentA, concurrentB] = await Promise.all([
      resolveRuntimeBinding("DB_TRANSIT"),
      resolveRuntimeBinding("DB_TRANSIT"),
    ]);
    expect(concurrentA).toBe(sentinel);
    expect(concurrentB).toBe(sentinel);

    // ...and the elected object came from the WORKERS env (arm 2), not
    // globalThis.env or a local SQLite arm — only the mocked module holds
    // the sentinel marker.
    const later = await resolveRuntimeBinding("DB_TRANSIT");
    expect(later).toBe(sentinel);
    expect((later as { __sentinelD1WorkersArm?: boolean }).__sentinelD1WorkersArm).toBe(true);
  });
});

// Probe once at collection time: without node:sqlite the file-backed suite
// reports as SKIPPED rather than silently passing with zero assertions
// (same shape as push-delivery-round-trip.test.ts). The specifier is
// assembled at runtime so Vite's client-environment import analysis
// (happy-dom) never tries to bundle the Node built-in (same trick as
// RuntimeBindings' election ladder and sqlite-fixture.ts).
const sqliteSpecifier = "node:" + "sqlite";
const databaseSync = await import(/* @vite-ignore */ sqliteSpecifier)
  .then((mod) => mod.DatabaseSync)
  .catch(() => null);

describe.skipIf(!databaseSync)("file-backed election via DATA_DIR", () => {
  const tempDirs: string[] = [];
  afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
  });

  it("elects transit and notifications SQLite bindings via DATA_DIR", async () => {
    setGlobalEnv({});
    removeDatabasePath();
    const dir = mkdtempSync(join(tmpdir(), "ttc-data-dir-"));
    tempDirs.push(dir);
    process.env.DATA_DIR = dir;

    const { resolveRuntimeBinding } = await loadSeam();

    const dbTransit = await resolveRuntimeBinding("DB_TRANSIT");
    const dbNotifications = await resolveRuntimeBinding("DB_NOTIFICATIONS");

    // Election-proof only: both bindings must expose the D1-shaped SQL surface.
    // Canonical round-trip coverage lives in node-sqlite-binding.test.ts.
    expect(dbTransit).toMatchObject({ exec: expect.any(Function), prepare: expect.any(Function) });
    expect(dbNotifications).toMatchObject({
      exec: expect.any(Function),
      prepare: expect.any(Function),
    });
  });
});

describe("storage layer factories", () => {
  async function buildRefused<A>(layer: Layer.Layer<A>): Promise<string> {
    let caught: unknown;
    try {
      await Effect.runPromise(Effect.scoped(Layer.build(layer)));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    return (caught as AggregateError).errors?.map(String).join(" ") ?? String(caught);
  }

  it("makeSurfaceDataStoreLayer elects under DB_TRANSIT and refuses naming it", async () => {
    setGlobalEnv({});
    const { makeSurfaceDataStoreLayer } =
      await import("~/infrastructure/storage/d1SurfaceDataStore");

    const refusal = await buildRefused(makeSurfaceDataStoreLayer("sample"));

    expect(refusal).toContain('"DB_TRANSIT"');
  });

  it("createLiveNotificationsRepositoryLayer elects under DB_NOTIFICATIONS and refuses naming it", async () => {
    setGlobalEnv({});
    const { createLiveNotificationsRepositoryLayer } =
      await import("~/infrastructure/storage/SubscriptionRepository");

    const refusal = await buildRefused(createLiveNotificationsRepositoryLayer());

    expect(refusal).toContain('"DB_NOTIFICATIONS"');
  });
});
