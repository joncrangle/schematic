vi.mock("~/agencies/agencyCatalog", async () => {
  const { testAgencyCatalog } = await import("../helpers/agency-fixtures");
  return { agencyCatalog: testAgencyCatalog };
});
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgencySnapshot } from "~/agencies/types";
import { resetSnapshotCachesForTests } from "~/services/SnapshotClient";
import {
  handleSnapshotGet,
  handleSnapshotHead,
  SNAPSHOT_BROWSER_CACHE,
  SNAPSHOT_EDGE_CACHE,
} from "~/services/SnapshotEndpoint";

const fixture = (agencyId: string): AgencySnapshot => ({
  agencyId,
  generatedAt: Date.now(),
  freshness: "live",
  alerts: [],
});

beforeEach(() => {
  resetSnapshotCachesForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/snapshot/:agencyId", () => {
  it("returns the existing AgencySnapshot JSON for a known provider", async () => {
    const response = await handleSnapshotGet("sample", async () => fixture("sample"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as AgencySnapshot;
    expect(body.agencyId).toBe("sample");
    expect(Array.isArray(body.alerts)).toBe(true);
  });

  it("emits the split browser/edge policy with no origin diagnostics on success", async () => {
    const response = await handleSnapshotGet("sample", async () => fixture("sample"));

    expect(response.headers.get("Cache-Control")).toBe(SNAPSHOT_BROWSER_CACHE);
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe(SNAPSHOT_EDGE_CACHE);
    expect(response.headers.get("X-Schematic-Cache")).toBeNull();
    expect(response.headers.get("X-Schematic-Snapshot-Age")).toBeNull();
  });

  it("returns Content-Language and keeps snapshot caches separate by locale", async () => {
    const getter = vi.fn(async (locale: "en-CA" | "fr-CA") => ({
      ...fixture("sample"),
      generatedAt: locale === "fr-CA" ? 1 : 2,
    }));

    const french = await handleSnapshotGet("sample", getter, "fr-CA");
    await handleSnapshotGet("sample", getter, "fr-CA");
    const english = await handleSnapshotGet("sample", getter, "en-CA");

    expect(french.headers.get("Content-Language")).toBe("fr-CA");
    expect(english.headers.get("Content-Language")).toBe("en-CA");
    expect(getter).toHaveBeenCalledTimes(2);
    expect(getter).toHaveBeenNthCalledWith(1, "fr-CA");
    expect(getter).toHaveBeenNthCalledWith(2, "en-CA");
  });

  it("rejects unsupported snapshot locales without caching an error", async () => {
    const getter = vi.fn(async () => fixture("sample"));
    const response = await handleSnapshotGet("sample", getter, "de-DE");

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(getter).not.toHaveBeenCalled();
  });

  it("unknown agency IDs return 404 and never fall back to the active provider", async () => {
    const response = await handleSnapshotGet("no-such-agency");

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/Unknown agency/);
  });

  it.each(["", "   ", undefined, 42])(
    "malformed agency ID %p returns 400 no-store",
    async (bad) => {
      const response = await handleSnapshotGet(bad);
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    },
  );

  it("cold concurrent requests share one refresh", async () => {
    let fetches = 0;
    const getter = async () => {
      fetches += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return fixture("sample");
    };

    const [a, b] = await Promise.all([
      handleSnapshotGet("sample", getter),
      handleSnapshotGet("sample", getter),
    ]);

    expect(fetches).toBe(1);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });

  it("failed cold refresh returns 503 no-store and never an empty all-clear", async () => {
    const response = await handleSnapshotGet("sample", async () => {
      throw new Error("upstream down");
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBeTruthy();
    expect(body.alerts).toBeUndefined();
  });

  it("failed warm refresh keeps serving the last valid snapshot, never empty", async () => {
    const t0 = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
    let shouldFail = false;
    const getter = async () => {
      if (shouldFail) throw new Error("upstream down");
      return fixture("sample");
    };

    await handleSnapshotGet("sample", getter);
    shouldFail = true;
    clock.mockReturnValue(t0 + 16_000);

    const stale = await handleSnapshotGet("sample", getter);
    expect(stale.status).toBe(200);
    const body = (await stale.json()) as AgencySnapshot;
    expect(body.agencyId).toBe("sample");

    await new Promise((resolve) => setTimeout(resolve, 10));
    const retained = await handleSnapshotGet("sample", getter);
    expect(retained.status).toBe(200);
    expect((await retained.json()) as AgencySnapshot).toEqual(body);
  });
});

describe("HEAD /api/snapshot/:agencyId", () => {
  it("returns matching status and headers without a body", async () => {
    const getResponse = await handleSnapshotGet("sample", async () => fixture("sample"));
    const headResponse = await handleSnapshotHead("sample", async () => fixture("sample"));

    expect(headResponse.status).toBe(getResponse.status);
    expect(headResponse.headers.get("Cache-Control")).toBe(SNAPSHOT_BROWSER_CACHE);
    expect(headResponse.headers.get("cloudflare-cdn-cache-control")).toBe(SNAPSHOT_EDGE_CACHE);
    expect(headResponse.headers.get("X-Schematic-Cache")).toBeNull();
    expect(await headResponse.text()).toBe("");
  });

  it("unknown agency HEAD returns 404 with no body", async () => {
    const response = await handleSnapshotHead("no-such-agency");

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });
});
