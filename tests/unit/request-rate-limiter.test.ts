import { afterEach, describe, expect, it, vi } from "vitest";

const hosting = vi.hoisted(() => ({ target: "self-hosted" as "self-hosted" | "cloudflare" }));
vi.mock("~/infrastructure/env/hostingTarget", () => ({
  detectHostingTarget: () => hosting.target,
}));

import {
  createMemoryRateLimiter,
  RateLimitBindingRefusedError,
  REQUEST_RATE_LIMIT_BINDING_NAME,
  requestRateLimitKey,
  resetRequestRateLimiterForTesting,
  resolveRequestRateLimiter,
  UNKNOWN_CLIENT_KEY,
} from "~/infrastructure/http/requestRateLimiter";

afterEach(() => {
  delete (globalThis as { env?: unknown }).env;
  hosting.target = "self-hosted";
  resetRequestRateLimiterForTesting();
});

async function admitMany(admit: (key: string) => Promise<boolean>, key: string, count: number) {
  const results: boolean[] = [];
  for (let index = 0; index < count; index += 1) results.push(await admit(key));
  return results;
}

describe("memory rate limiter", () => {
  it("refuses requests past the limit until the window rolls over", async () => {
    let now = 0;
    const limiter = createMemoryRateLimiter({ limit: 2, windowMs: 1_000, now: () => now });

    expect(await admitMany(limiter.admit, "a", 3)).toEqual([true, true, false]);
    expect(await limiter.admit("b")).toBe(true);
    now = 1_000;
    expect(await limiter.admit("a")).toBe(true);
  });

  it("keeps at most maxKeys windows by evicting the oldest client", async () => {
    const limiter = createMemoryRateLimiter({
      limit: 1,
      windowMs: 60_000,
      maxKeys: 2,
      now: () => 0,
    });

    await limiter.admit("first");
    await limiter.admit("second");
    await limiter.admit("third");

    // The evicted client starts a fresh window; the retained ones stay limited.
    expect(await limiter.admit("first")).toBe(true);
    expect(await limiter.admit("third")).toBe(false);
  });
});

describe("request rate-limit key", () => {
  it.each<{ headers: Record<string, string>; key: string }>([
    { headers: { "x-forwarded-for": "198.51.100.7" }, key: "198.51.100.7" },
    { headers: { "x-forwarded-for": "2001:db8:1:2:aaaa::1" }, key: "2001:db8:1:2::/64" },
    { headers: {}, key: UNKNOWN_CLIENT_KEY },
    { headers: { "x-forwarded-for": "not-an-ip" }, key: UNKNOWN_CLIENT_KEY },
  ])("keys $headers as $key", ({ headers, key }) => {
    expect(requestRateLimitKey(new Request("https://x.test/", { headers }))).toBe(key);
  });
});

describe("rate limiter resolution", () => {
  it("uses the Workers binding when the environment declares it", async () => {
    const limit = vi.fn(async () => ({ success: false }));
    (globalThis as { env?: unknown }).env = { [REQUEST_RATE_LIMIT_BINDING_NAME]: { limit } };

    expect(await resolveRequestRateLimiter().admit("k")).toBe(false);
    expect(limit).toHaveBeenCalledWith({ key: "k" });
  });

  it("refuses a Cloudflare deployment that lacks the binding", () => {
    hosting.target = "cloudflare";

    expect(() => resolveRequestRateLimiter()).toThrow(RateLimitBindingRefusedError);
  });

  it("falls back to the configured in-process limiter when self-hosted", async () => {
    vi.stubEnv("REQUEST_RATE_LIMIT", "1");
    try {
      const limiter = resolveRequestRateLimiter();

      expect(await admitMany(limiter.admit, "k", 2)).toEqual([true, false]);
      expect(resolveRequestRateLimiter()).toBe(limiter);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
