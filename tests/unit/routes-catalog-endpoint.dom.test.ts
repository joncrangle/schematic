vi.mock("~/agencies/agencyCatalog", async () => {
  const { testAgencyCatalog } = await import("../helpers/agency-fixtures");
  return { agencyCatalog: testAgencyCatalog };
});
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RouteMeta } from "~/services/surface/SurfaceClient";
import {
  handleRoutesCatalogGet,
  handleRoutesCatalogHead,
  ROUTES_CATALOG_BROWSER_CACHE,
  ROUTES_CATALOG_EDGE_CACHE,
} from "~/services/RoutesCatalogEndpoint";

const catalog = (ids: readonly string[]): readonly RouteMeta[] =>
  ids.map((id) => ({ id, shortName: id, longName: `Route ${id}`, routeType: "bus" }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/routes-catalog/:agencyId", () => {
  it("returns the catalog JSON for a known provider", async () => {
    const response = await handleRoutesCatalogGet("sample", async () => catalog(["504", "501"]));

    expect(response.status).toBe(200);
    const body = (await response.json()) as readonly RouteMeta[];
    expect(body.map((r) => r.id)).toEqual(["504", "501"]);
  });

  it("emits the split browser/edge policy on success", async () => {
    const response = await handleRoutesCatalogGet("sample", async () => catalog(["504"]));

    expect(response.headers.get("Cache-Control")).toBe(ROUTES_CATALOG_BROWSER_CACHE);
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe(ROUTES_CATALOG_EDGE_CACHE);
  });

  it("unknown agency IDs return 404 and never fall back to the active provider", async () => {
    const response = await handleRoutesCatalogGet("no-such-agency");

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/Unknown agency/);
  });

  it.each(["", "   ", undefined, 42])(
    "malformed agency ID %p returns 400 no-store",
    async (bad) => {
      const response = await handleRoutesCatalogGet(bad);
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    },
  );

  it("store failures return 503 no-store so errors are never cached", async () => {
    const response = await handleRoutesCatalogGet("sample", async () => {
      throw new Error("d1 down");
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/d1 down/);
  });

  it("HEAD mirrors GET status and headers with no body", async () => {
    const response = await handleRoutesCatalogHead("sample", async () => catalog(["504"]));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(ROUTES_CATALOG_BROWSER_CACHE);
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe(ROUTES_CATALOG_EDGE_CACHE);
    expect(await response.text()).toBe("");
  });

  it("HEAD mirrors the 404 for unknown agencies", async () => {
    const response = await handleRoutesCatalogHead("no-such-agency");

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });
});
