import { handleFetchAllRoutesCatalog } from "~/services/surface/SurfaceServer";
import type { RouteMeta } from "~/services/surface/SurfaceClient";
import {
  endpointErrorMessage,
  headFromGet,
  isKnownAgency,
  noStoreJson,
  parseAgencyIdParam,
} from "~/services/apiEndpoint";

/**
 * Stable routes-catalog HTTP composition, same pattern as SnapshotEndpoint
 *.
 *
 * Serves the surface routes catalog (static GTFS between crawls) through
 * `GET /api/routes-catalog/:agencyId` (plus HEAD with identical
 * status/headers and no body). Provider lookup and agency identity stay at
 * this boundary.
 *
 * The catalog is static GTFS between crawls and shared across users, so
 * successful responses carry a split browser/edge cache. Browsers always
 * revalidate (`max-age=0`) while the edge holds the long 1h/24h window the
 * client already assumes, with the error window bounded to match. Leaving
 * `stale-if-error` unset would serve stale topology indefinitely whenever
 * the origin fails.
 * Errors (400/404/503) stay `no-store` and are never negatively
 * cached. There is no worker-level cache seam. Edge hits absorb all but one
 * D1 read per hour per edge.
 */

/** Browsers always revalidate; the edge owns freshness. */
export const ROUTES_CATALOG_BROWSER_CACHE = "public, max-age=0";

/** Edge policy: 1h fresh / 24h stale-while-revalidate / 24h stale-if-error. */
export const ROUTES_CATALOG_EDGE_CACHE =
  "public, max-age=3600, stale-while-revalidate=86400, stale-if-error=86400";

export type RoutesCatalogGetter = (agencyId: string) => Promise<readonly RouteMeta[]>;

const defaultCatalogGetter: RoutesCatalogGetter = (agencyId) =>
  handleFetchAllRoutesCatalog({ agencyId });

/**
 * Core GET logic returning a Response. Unknown agencies are explicit 404s;
 * malformed ids are 400; store failures are 503. All three errors are
 * `no-store`. Successful 200 responses carry the long public cache.
 */
export async function handleRoutesCatalogGet(
  agencyIdRaw: unknown,
  getCatalog: RoutesCatalogGetter = defaultCatalogGetter,
): Promise<Response> {
  let agencyId: string;
  try {
    agencyId = parseAgencyIdParam(agencyIdRaw);
  } catch (error) {
    return noStoreJson(400, { error: endpointErrorMessage(error, "Missing or invalid agencyId") });
  }

  if (!isKnownAgency(agencyId)) {
    return noStoreJson(404, { error: `Unknown agency "${agencyId}"` });
  }

  try {
    const routes = await getCatalog(agencyId);
    return Response.json(routes, {
      status: 200,
      headers: {
        "Cache-Control": ROUTES_CATALOG_BROWSER_CACHE,
        "cloudflare-cdn-cache-control": ROUTES_CATALOG_EDGE_CACHE,
      },
    });
  } catch (error) {
    return noStoreJson(503, { error: endpointErrorMessage(error, "Routes catalog unavailable") });
  }
}

/** HEAD mirrors GET status/headers with no response body. */
export async function handleRoutesCatalogHead(
  agencyIdRaw: unknown,
  getCatalog: RoutesCatalogGetter = defaultCatalogGetter,
): Promise<Response> {
  return headFromGet(await handleRoutesCatalogGet(agencyIdRaw, getCatalog));
}
