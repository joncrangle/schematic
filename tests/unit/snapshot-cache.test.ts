import { describe, expect, it, vi } from "vitest";

import {
  createSnapshotCache,
  SNAPSHOT_CACHE_STALE_GRACE_MS,
} from "~/infrastructure/realtime/snapshotCache";

interface TestSnapshot {
  readonly generatedAt: number;
  readonly payload: string;
}

const snapshot = (payload: string): TestSnapshot => ({
  generatedAt: Date.now(),
  payload,
});

describe("createSnapshotCache portable semantics", () => {
  it("cold request performs one refresh and reports MISS with zero age", async () => {
    const refresh = vi.fn(async () => snapshot("v1"));
    const cache = createSnapshotCache<TestSnapshot>({ label: "test", refresh });

    const result = await cache.get();

    expect(result.value.payload).toBe("v1");
    expect(result.status).toBe("MISS");
    expect(result.ageSeconds).toBe(0);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("concurrent cold requests share one refresh", async () => {
    let fetches = 0;
    const cache = createSnapshotCache<TestSnapshot>({
      label: "test",
      refresh: async () => {
        fetches += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return snapshot("v1");
      },
    });

    const [a, b] = await Promise.all([cache.get(), cache.get()]);

    expect(fetches).toBe(1);
    expect(a.value).toEqual(b.value);
    expect(a.status).toBe("MISS");
    expect(b.status).toBe("MISS");
  });

  it("warm request within TTL does not refresh and reports HIT", async () => {
    let now = 1_000_000;
    const refresh = vi.fn(async () => snapshot("v1"));
    const cache = createSnapshotCache<TestSnapshot>({
      label: "test",
      ttlMs: 15_000,
      now: () => now,
      refresh,
    });

    await cache.get();
    now += 5_000;
    const hit = await cache.get();

    expect(hit.status).toBe("HIT");
    expect(hit.value.payload).toBe("v1");
    expect(hit.ageSeconds).toBe(5);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("expired concurrent requests join one refresh and receive the new snapshot", async () => {
    let now = 2_000_000;
    let fetches = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cache = createSnapshotCache<TestSnapshot>({
      label: "test",
      ttlMs: 15_000,
      now: () => now,
      refresh: async () => {
        fetches += 1;
        if (fetches === 1) return snapshot("v1");
        await gate;
        return snapshot("v1-refresh");
      },
    });

    await cache.get();
    expect(fetches).toBe(1);

    now += 16_000;
    const aPromise = cache.get();
    const bPromise = cache.get();
    let settled = false;
    void aPromise.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(settled).toBe(false);
    expect(fetches).toBe(2);

    release();
    const [a, b] = await Promise.all([aPromise, bPromise]);

    expect(a.value.payload).toBe("v1-refresh");
    expect(b.value.payload).toBe("v1-refresh");
    expect(a.status).toBe("HIT");
    expect(b.status).toBe("HIT");
    expect(a.ageSeconds).toBe(0);
  });

  it("successful refresh replaces the cached snapshot and resets its age", async () => {
    let now = 3_000_000;
    let version = 0;
    const cache = createSnapshotCache<TestSnapshot>({
      label: "test",
      ttlMs: 15_000,
      now: () => now,
      refresh: async () => {
        version += 1;
        return snapshot(`v${version}`);
      },
    });

    await cache.get();
    now += 16_000;
    const fresh = await cache.get();
    expect(fresh.value.payload).toBe("v2");
    expect(fresh.status).toBe("HIT");
    expect(fresh.ageSeconds).toBe(0);
  });

  it("failed cold refresh rejects instead of serving an empty all-clear", async () => {
    const boom = new Error("upstream down");
    const cache = createSnapshotCache<TestSnapshot>({
      label: "test",
      refresh: async () => {
        throw boom;
      },
    });

    await expect(cache.get()).rejects.toBe(boom);
    expect(cache.peek()).toBeNull();
  });

  it("failed warm refresh retains the last valid snapshot", async () => {
    let now = 4_000_000;
    let shouldFail = false;
    const cache = createSnapshotCache<TestSnapshot>({
      label: "test",
      ttlMs: 15_000,
      now: () => now,
      refresh: async () => {
        if (shouldFail) throw new Error("upstream down");
        return snapshot("good");
      },
    });

    await cache.get();
    shouldFail = true;
    now += 16_000;

    const stale = await cache.get();
    expect(stale.status).toBe("STALE");
    expect(stale.value.payload).toBe("good");

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cache.peek()?.payload).toBe("good");
  });

  it("cools down repeated warm failures, retries, and recovers without losing the last-good value", async () => {
    const startAt = 6_000_000;
    let shouldFail = false;
    let attempts = 0;
    vi.useFakeTimers();
    vi.setSystemTime(startAt);
    try {
      const cache = createSnapshotCache<TestSnapshot>({
        label: "snapshot-cooldown-test",
        ttlMs: 100,
        failureTtlMs: 500,
        refresh: async () => {
          attempts += 1;
          if (shouldFail) throw new Error("provider unavailable");
          return snapshot(attempts === 1 ? "last-good" : "recovered");
        },
      });

      const initial = await cache.get();
      expect(initial.value.payload).toBe("last-good");
      expect(initial.status).toBe("MISS");

      shouldFail = true;
      vi.advanceTimersByTime(101);
      const stale = await cache.get();
      expect(stale.value.payload).toBe("last-good");
      expect(stale.status).toBe("STALE");
      expect(attempts).toBe(2);

      const cooledDown = await cache.get();
      expect(cooledDown.value.payload).toBe("last-good");
      expect(cooledDown.status).toBe("STALE");
      expect(attempts).toBe(2);

      vi.advanceTimersByTime(501);
      const staleAfterRetry = await cache.get();
      expect(staleAfterRetry.value.payload).toBe("last-good");
      expect(staleAfterRetry.status).toBe("STALE");
      expect(attempts).toBe(3);

      shouldFail = false;
      vi.advanceTimersByTime(501);
      const recovered = await cache.get();
      expect(recovered.value.payload).toBe("recovered");
      expect(recovered.status).toBe("HIT");
      expect(attempts).toBe(4);
      expect(cache.peek()?.payload).toBe("recovered");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps cold provider failures visible while cooling down retries", async () => {
    const startAt = 7_000_000;
    const unavailable = new Error("provider unavailable");
    const refresh = vi.fn(async () => {
      throw unavailable;
    });
    vi.useFakeTimers();
    vi.setSystemTime(startAt);
    try {
      const cache = createSnapshotCache<TestSnapshot>({
        label: "cold-snapshot-cooldown-test",
        failureTtlMs: 500,
        refresh,
      });

      await expect(cache.get()).rejects.toBe(unavailable);
      await expect(cache.get()).rejects.toBe(unavailable);
      expect(cache.peek()).toBeNull();
      expect(refresh).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(501);
      await expect(cache.get()).rejects.toBe(unavailable);
      expect(cache.peek()).toBeNull();
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops serving stale data after the stale-on-error grace period", async () => {
    let now = 5_000_000;
    let attempts = 0;
    const cache = createSnapshotCache<TestSnapshot>({
      label: "stale-grace-test",
      ttlMs: 15_000,
      now: () => now,
      refresh: async () => {
        attempts += 1;
        if (attempts > 1) throw new Error("upstream down");
        return snapshot("good");
      },
    });

    await cache.get();
    now += 16_000;
    const stale = await cache.get();
    expect(stale.status).toBe("STALE");

    now += SNAPSHOT_CACHE_STALE_GRACE_MS + 1;

    await expect(cache.get()).rejects.toThrow("upstream down");
    // A subsequent cooldown hit must not restart the stale grace period.
    await expect(cache.get()).rejects.toThrow("upstream down");
    expect(cache.peek()?.payload).toBe("good");
    expect(attempts).toBe(3);
  });
});

it("replaces an abandoned refresh and ignores its late completion", async () => {
  let now = 1_000;
  let release!: (value: TestSnapshot) => void;
  const abandoned = new Promise<TestSnapshot>((resolve) => {
    release = resolve;
  });
  const refresh = vi
    .fn()
    .mockReturnValueOnce(abandoned)
    .mockResolvedValueOnce(snapshot("recovered"));
  const cache = createSnapshotCache<TestSnapshot>({ label: "abandoned", now: () => now, refresh });
  const first = cache.get();
  now += 31_000;
  const next = cache.get();
  expect(refresh).toHaveBeenCalledTimes(2);
  expect((await next).value.payload).toBe("recovered");
  release(snapshot("obsolete"));
  expect((await first).value.payload).toBe("recovered");
  expect(cache.peek()?.payload).toBe("recovered");
});
