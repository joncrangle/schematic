import type { StartMiddleware } from "@solidjs/vite-plugin";
import { handleSnapshotGet, handleSnapshotHead } from "~/services/SnapshotEndpoint";
import { handleRoutesCatalogGet, handleRoutesCatalogHead } from "~/services/RoutesCatalogEndpoint";
import {
  createStationDeparturesGetter,
  handleDeparturesGet,
  handleDeparturesHead,
} from "~/services/StationDeparturesEndpoint";
import { interchanges } from "~/agencies/interchanges";
import { logger } from "~/infrastructure/logging/logger";
import {
  requestRateLimitKey,
  resolveRequestRateLimiter,
  type RequestRateLimiter,
} from "~/infrastructure/http/requestRateLimiter";
import { runWithRequestQueryBudget } from "~/infrastructure/storage/requestQueryBudget";

const getStationDepartures = createStationDeparturesGetter(interchanges);

// Edge cache policy, Worker-wide. Path scoping lives only in Cache-Control: each
// API branch below returns the split browser/edge policy from its endpoint
// module, and noStoreFallthrough overrides every other GET and HEAD response.
// Only GET and HEAD can be cached, so the 405 branches carry no cache headers.

// Every entry is a `StartMiddleware`: the request event arrives first, the
// request itself at `event.request`, and `next()` takes no arguments.

// Handlers read agency and station ids only, never the request, so responses
// cannot vary by user. The edge checks the cache before the Worker runs, so
// rebuilding the request here cannot turn a bypass into a hit. Authed reads
// share the public, cookie-free entry. Fall through keeps the original request
// because SSR needs cookies, and those responses are no-store.

/** Returns the same body, status and headers with caching switched off. */
function toNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  // Keep the app document intact at the CDN. Cloudflare otherwise injects its
  // analytics beacon, which fails CORS/SRI checks when blocked by clients.
  const isHtml = headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() === "text/html";
  headers.set("Cache-Control", isHtml ? "no-store, no-transform" : "no-store");
  headers.delete("cloudflare-cdn-cache-control");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function badRequest(): Response {
  return toNoStore(new Response("Bad Request", { status: 400 }));
}

function decodePathSegments(...segments: string[]): string[] | null {
  try {
    return segments.map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

/**
 * Known locale parameters are part of the edge key for snapshots and departures.
 * Rejecting other query shapes before the handler stops cache key variations
 * from forcing uncached feed or database reads.
 */
async function guardSnapshotLocaleQuery(
  url: URL,
  respond: () => Promise<Response>,
): Promise<Response> {
  if (url.search.length === 0) return respond();
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== "locale" || url.searchParams.getAll("locale").length !== 1) {
    return badRequest();
  }
  return respond();
}

/**
 * Static assets and edge-cache hits never reach the Worker, so every request
 * here is billed work: rate-limit it per client network, then give it a
 * transit query budget. Server functions run through this chain too.
 */
const requestGuard: StartMiddleware = async (event, next) => {
  let limiter: RequestRateLimiter;
  try {
    limiter = resolveRequestRateLimiter();
  } catch (error) {
    logger.error("Request rate limiter misconfigured", { cause: String(error) });
    return toNoStore(new Response("Service Unavailable", { status: 503 }));
  }
  // A transient limiter fault admits the request rather than taking the site down.
  const admitted = await limiter.admit(requestRateLimitKey(event.request)).catch((error) => {
    logger.warn("Request rate limiter check failed; admitting", { cause: String(error) });
    return true;
  });
  if (!admitted) {
    return new Response("Too Many Requests", {
      status: 429,
      headers: { "Cache-Control": "no-store", "Retry-After": "60" },
    });
  }
  return runWithRequestQueryBudget(() => next());
};

// No filesystem routing, so /api/snapshot is answered here. Delegates keep their
// own status and headers; everything else falls through.
const snapshotApi: StartMiddleware = async (event, next) => {
  const request = event.request;
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/snapshot\/([^/]+)$/);
  if (match) {
    const [agencyId] = decodePathSegments(match[1]) ?? [];
    if (agencyId === undefined) return badRequest();
    const locale = url.searchParams.get("locale") ?? undefined;
    if (request.method === "GET") {
      return guardSnapshotLocaleQuery(url, () => handleSnapshotGet(agencyId, undefined, locale));
    }
    if (request.method === "HEAD") {
      return guardSnapshotLocaleQuery(url, () => handleSnapshotHead(agencyId, undefined, locale));
    }
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }
  return next();
};

const routesCatalogApi: StartMiddleware = async (event, next) => {
  const request = event.request;
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/routes-catalog\/([^/]+)$/);
  if (match) {
    const [agencyId] = decodePathSegments(match[1]) ?? [];
    if (agencyId === undefined || url.search.length > 0) return badRequest();
    if (request.method === "GET") {
      return handleRoutesCatalogGet(agencyId);
    }
    if (request.method === "HEAD") {
      return handleRoutesCatalogHead(agencyId);
    }
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }
  return next();
};

const stationDeparturesApi: StartMiddleware = async (event, next) => {
  const request = event.request;
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/departures\/([^/]+)\/([^/]+)$/);
  if (match) {
    const [agencyId, stationId] = decodePathSegments(match[1], match[2]) ?? [];
    if (agencyId === undefined || stationId === undefined) return badRequest();
    const locale = url.searchParams.get("locale") ?? undefined;
    if (request.method === "GET") {
      return guardSnapshotLocaleQuery(url, () =>
        handleDeparturesGet(agencyId, stationId, getStationDepartures, locale),
      );
    }
    if (request.method === "HEAD") {
      return guardSnapshotLocaleQuery(url, () =>
        handleDeparturesHead(agencyId, stationId, getStationDepartures, locale),
      );
    }
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }
  return next();
};

/**
 * Stamps no-store on every fall-through GET and HEAD response, overriding any
 * cacheable policy from downstream. Body, status and other headers pass through
 * untouched, and other methods are untouched. This runs last. The API branches
 * above return before next, so they never see it.
 */
const noStoreFallthrough: StartMiddleware = async (event, next) => {
  const request = event.request;
  const response = await next();
  if (request.method !== "GET" && request.method !== "HEAD") return response;
  return toNoStore(response);
};

export default [
  requestGuard,
  snapshotApi,
  routesCatalogApi,
  stationDeparturesApi,
  noStoreFallthrough,
] satisfies StartMiddleware[];
