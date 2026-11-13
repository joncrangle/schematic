import { afterEach, describe, expect, it, vi } from "vitest";
import type { StartMiddleware } from "@solidjs/vite-plugin";

import middleware from "~/middleware";
import { REQUEST_RATE_LIMIT_BINDING_NAME } from "~/infrastructure/http/requestRateLimiter";
import {
  accountRequestQueries,
  REQUEST_QUERY_BUDGET,
} from "~/infrastructure/storage/requestQueryBudget";
import type { D1DatabaseBinding } from "~/infrastructure/storage/RuntimeBindings";
import { handleSnapshotGet } from "~/services/SnapshotEndpoint";
import { handleDeparturesGet } from "~/services/StationDeparturesEndpoint";
import { handleRoutesCatalogGet } from "~/services/RoutesCatalogEndpoint";

const STUB_SPLIT = vi.hoisted<Record<"snapshot" | "departures" | "catalog", HeadersInit>>(() => ({
  snapshot: {
    "Cache-Control": "public, max-age=0",
    "cloudflare-cdn-cache-control":
      "public, max-age=15, stale-while-revalidate=15, stale-if-error=60",
  },
  departures: {
    "Cache-Control": "public, max-age=0",
    "cloudflare-cdn-cache-control": "public, max-age=20, stale-if-error=0",
  },
  catalog: {
    "Cache-Control": "public, max-age=0",
    "cloudflare-cdn-cache-control":
      "public, max-age=3600, stale-while-revalidate=86400, stale-if-error=86400",
  },
}));

vi.mock("~/services/SnapshotEndpoint", () => ({
  handleSnapshotGet: vi.fn(async (agencyId: string) =>
    Response.json({ path: "snapshot", agencyId }, { status: 200, headers: STUB_SPLIT.snapshot }),
  ),
  handleSnapshotHead: vi.fn(async () => new Response(null, { status: 200 })),
}));

vi.mock("~/services/StationDeparturesEndpoint", () => ({
  createStationDeparturesGetter: vi.fn(() => vi.fn(async () => [])),
  handleDeparturesGet: vi.fn(async (agencyId: string, stationId: string) =>
    Response.json(
      { path: "departures", agencyId, stationId },
      { status: 200, headers: STUB_SPLIT.departures },
    ),
  ),
  handleDeparturesHead: vi.fn(async () => new Response(null, { status: 200 })),
}));

vi.mock("~/services/RoutesCatalogEndpoint", () => ({
  handleRoutesCatalogGet: vi.fn(async (agencyId: string) =>
    Response.json({ path: "catalog", agencyId }, { status: 200, headers: STUB_SPLIT.catalog }),
  ),
  handleRoutesCatalogHead: vi.fn(async () => new Response(null, { status: 200 })),
}));

type Next = () => Promise<Response>;
type MiddlewareEvent = Parameters<StartMiddleware>[0];

async function dispatch(
  target: string,
  init?: RequestInit,
  terminal?: (request: Request) => Response | Promise<Response>,
): Promise<{ response: Response; seen: Request[] }> {
  const seen: Request[] = [];
  // The plugin seeds the request on the event, and a bare next() continues with
  // the same event, so the terminal reads event.request like the framework does.
  const event = { request: new Request(target, init) } as MiddlewareEvent;
  const end: Next = async () => {
    seen.push(event.request);
    return terminal ? terminal(event.request) : new Response("no-route", { status: 404 });
  };
  const chained = (middleware as StartMiddleware[]).reduceRight<Next>(
    (next, fn) => () => Promise.resolve(fn(event, next)),
    end,
  );
  return { response: await chained(), seen };
}

const apiPaths = [
  { path: "/api/snapshot/ttc", marker: "snapshot" },
  { path: "/api/departures/ttc/union", marker: "departures" },
  { path: "/api/routes-catalog/ttc", marker: "catalog" },
] as const;

describe("middleware edge-cache guards", () => {
  it.each(apiPaths)(
    "passes $path through with its split policy untouched",
    async ({ path, marker }) => {
      const { response } = await dispatch(`https://x.test${path}`);

      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("public, max-age=0");
      expect(response.headers.get("cloudflare-cdn-cache-control")).toMatch(/^public, /);
      expect(((await response.json()) as { path: string }).path).toBe(marker);
    },
  );

  it.each(apiPaths)(
    "rejects unknown query parameters on $path without invoking a handler",
    async ({ path }) => {
      const endpoints = [
        vi.mocked(handleSnapshotGet),
        vi.mocked(handleDeparturesGet),
        vi.mocked(handleRoutesCatalogGet),
      ];
      const callsBefore = endpoints.map((endpoint) => endpoint.mock.calls.length);
      const { response } = await dispatch(`https://x.test${path}?utm_source=x&b=2`);

      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("cloudflare-cdn-cache-control")).toBeNull();
      expect(endpoints.map((endpoint) => endpoint.mock.calls.length)).toEqual(callsBefore);
    },
  );

  it.each([
    "/api/snapshot/%E0%A4%A",
    "/api/routes-catalog/%E0%A4%A",
    "/api/departures/ttc/%E0%A4%A",
  ])("returns 400 for malformed path encoding in %s", async (path) => {
    const { response } = await dispatch(`https://x.test${path}`);

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it.each(["GET", "HEAD"])(
    "prevents CDN script injection into %s HTML responses",
    async (method) => {
      const { response, seen } = await dispatch(
        "https://x.test/",
        { method },
        async () =>
          new Response("<html></html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store, no-transform");
      expect(response.headers.get("Content-Type")).toBe("text/html");
      expect(await response.text()).toBe("<html></html>");
      expect(seen).toHaveLength(1);
    },
  );

  it("forces no-store on fall-through GET even with a downstream cache policy", async () => {
    const { response } = await dispatch(
      "https://x.test/",
      { method: "GET" },
      async () =>
        new Response("ok", {
          status: 200,
          headers: {
            "Cache-Control": "public, max-age=60",
            "cloudflare-cdn-cache-control": "public, max-age=60",
          },
        }),
    );

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBeNull();
    expect(await response.text()).toBe("ok");
  });

  it("leaves non-GET fall-through responses alone", async () => {
    const { response } = await dispatch(
      "https://x.test/_server",
      { method: "POST" },
      async () => new Response("ok", { status: 200 }),
    );

    expect(response.headers.get("Cache-Control")).toBeNull();
  });

  it("preserves the snapshot response when Authorization and Cookie headers are present", async () => {
    const anon = await dispatch(`https://x.test/api/snapshot/ttc`);
    const anonBody = await anon.response.text();

    const { response } = await dispatch(`https://x.test/api/snapshot/ttc`, {
      headers: { Authorization: "Bearer x", Cookie: "a=b" },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(anonBody);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=0");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toMatch(/^public, /);
  });

  it("keeps the split cache policy for a single locale-specific snapshot URL", async () => {
    const { response } = await dispatch("https://x.test/api/snapshot/ttc?locale=fr-CA");

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=0");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toMatch(/^public, /);
  });

  it("keeps the split cache policy for a single locale-specific departures URL", async () => {
    const { response } = await dispatch("https://x.test/api/departures/ttc/union?locale=fr-CA");

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=0");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toMatch(/^public, /);
  });

  it("answers non-GET on API paths with 405 and no cache headers", async () => {
    const { response } = await dispatch(`https://x.test/api/snapshot/ttc`, { method: "POST" });

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD");
    expect(response.headers.get("Cache-Control")).toBeNull();
  });
});

describe("middleware request guard", () => {
  afterEach(() => {
    delete (globalThis as { env?: unknown }).env;
  });

  function installRateLimitBinding(success: boolean) {
    const limit = vi.fn(async (_options: { key: string }) => ({ success }));
    (globalThis as { env?: unknown }).env = { [REQUEST_RATE_LIMIT_BINDING_NAME]: { limit } };
    return limit;
  }

  it("refuses a limited client network with an uncached 429 before any handler runs", async () => {
    const limit = installRateLimitBinding(false);
    const terminal = vi.fn(() => new Response("rendered"));

    const { response } = await dispatch(
      "https://x.test/_server",
      { method: "POST", headers: { "x-forwarded-for": "203.0.113.9" } },
      terminal,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(limit).toHaveBeenCalledWith({ key: "203.0.113.9" });
    expect(terminal).not.toHaveBeenCalled();
  });

  it("admits the request when the limiter check itself fails", async () => {
    (globalThis as { env?: unknown }).env = {
      [REQUEST_RATE_LIMIT_BINDING_NAME]: {
        limit: async () => {
          throw new Error("limiter offline");
        },
      },
    };

    const { response } = await dispatch("https://x.test/", undefined, () => new Response("ok"));

    expect(await response.text()).toBe("ok");
  });

  it("bounds the transit queries one admitted request can issue", async () => {
    installRateLimitBinding(true);
    const raw: D1DatabaseBinding = {
      prepare: () => ({
        bind() {
          return this;
        },
        first: async () => null,
        all: async () => ({ results: [], success: true }),
        run: async () => ({ success: true }),
      }),
      exec: async () => undefined,
      batch: async () => [],
    };
    const db = accountRequestQueries(raw);

    const { response } = await dispatch("https://x.test/", undefined, async () => {
      for (let query = 0; query < REQUEST_QUERY_BUDGET; query += 1)
        await db.prepare("SELECT 1").first();
      try {
        await db.prepare("SELECT 1").first();
        return new Response("unbounded");
      } catch (error) {
        return new Response((error as { _tag?: string })._tag);
      }
    });

    expect(await response.text()).toBe("InvocationBudgetExceeded");
    await expect(db.prepare("SELECT 1").first()).resolves.toBeNull();
  });
});
