import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { RouteDetails, SurfaceRoute, SurfaceStop } from "~/domain/surface/types";
import { buildDirectionLabels } from "~/domain/surface/direction";
import type { SurfaceStoreKernelCapabilities } from "./readPolicy";

/**
 * Static topology is much slower-moving than arrivals. Keep the hot request
 * path in process memory so a warm Worker can answer 15-second arrival polls
 * without reopening the D1 read path.
 *
 * This cache sits below the read-policy kernel. That distinction matters:
 * the kernel is a pure read fan-out, it never fetches, revalidates,
 * or persists, so only the underlying static read is served from memory.
 * Topology repair is explicit-only (seed/crawl seam), never request-driven.
 *
 * Explicit DB writes (SurfaceTopologyWriter.reconcileRoute, crawl/topology
 * sync) go straight to D1 and do NOT auto-refresh this warm cache. A warm
 * read stays stale for up to the TTL below after an explicit write lands;
 * only expiry/eviction re-reads the store. `rememberRouteDetails` and
 * `invalidateStopTopology` are manual hooks the explicit seam may invoke,
 * but no production explicit-write path calls them today. Shared warm-cache
 * invalidation stays out of scope. Never wire fetch/scheduler/writer
 * into the read path to close that window.
 */
export const ROUTE_TOPOLOGY_CACHE_TTL_MS = 10 * 60_000;
// Stop membership and coordinates are repaired by the explicit crawl/seed
// seam, so keep the nearby index on the same warm cadence.
// This makes a stationary panel's 15-second polls arrival-only for the full
// normal topology window.
export const NEARBY_TOPOLOGY_CACHE_TTL_MS = ROUTE_TOPOLOGY_CACHE_TTL_MS;

const MAX_NEARBY_CACHE_ENTRIES = 64;
const MAX_ROUTE_CACHE_ENTRIES = 256;

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

function readCache<T>(cache: Map<string, CacheEntry<T>>, key: string, now: number): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return undefined;
  }

  // LRU touch: a frequently used agency/viewport survives bounded eviction.
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function writeCache<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  ttlMs: number,
  maxEntries: number,
  now: number,
): void {
  cache.delete(key);
  cache.set(key, { value, expiresAt: now + ttlMs });
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function coordinateKey(value: number): string {
  // Five decimal places is roughly one metre. This absorbs normal GPS jitter
  // while exact Haversine filtering still runs on every cached candidate read.
  return value.toFixed(5);
}

function normalizeRouteDetails(details: RouteDetails): RouteDetails {
  if (details.shape.directionLabel?.trim()) return details;
  const label = buildDirectionLabels(
    new Map([[details.shape.directionId, details]]),
    details.route.shortName,
  )[details.shape.directionId]?.label;
  return label ? { ...details, shape: { ...details.shape, directionLabel: label } } : details;
}

export type SurfaceTopologyReadCapabilities = Pick<
  SurfaceStoreKernelCapabilities,
  | "readNearbyCandidates"
  | "readRouteDirectionIds"
  | "readDirectionsForTrips"
  | "readTripTerminals"
  | "readCachedRouteDetails"
  | "readRouteRow"
  | "readAllRouteRows"
  | "readStopsForRoutes"
  | "readStopsByIds"
>;

export interface SurfaceTopologyReadCache {
  readonly readers: SurfaceTopologyReadCapabilities;
  /**
   * Manual hook: replace route entries after an explicit topology write has
   * landed. Not auto-invoked, explicit DB writes bypass the warm cache, so
   * a warm read stays stale up to the TTL unless the explicit seam calls this.
   */
  readonly rememberRouteDetails: (details: RouteDetails) => void;
  /**
   * Manual hook: drop stop-derived entries after explicit route
   * membership/topology changes. Not auto-invoked; same staleness window as
   * above. Shared warm-cache invalidation stays out of scope.
   */
  readonly invalidateStopTopology: () => void;
}

/** Adds a bounded in-memory layer around static topology readers. */
export function createSurfaceTopologyReadCache(
  source: SurfaceTopologyReadCapabilities,
  now: () => number = Date.now,
): SurfaceTopologyReadCache {
  const nearbyCache = new Map<string, CacheEntry<readonly SurfaceStop[]>>();
  const routeDetailsCache = new Map<string, CacheEntry<Option.Option<RouteDetails>>>();
  const routeCache = new Map<string, CacheEntry<Option.Option<SurfaceRoute>>>();
  const allRoutesCache = new Map<string, CacheEntry<readonly SurfaceRoute[]>>();
  const stopsForRoutesCache = new Map<string, CacheEntry<readonly SurfaceStop[]>>();
  const stopsByIdsCache = new Map<string, CacheEntry<readonly SurfaceStop[]>>();

  const rememberRouteDetails = (details: RouteDetails): void => {
    const normalized = normalizeRouteDetails(details);
    const at = now();
    writeCache(
      routeDetailsCache,
      `${normalized.route.id}:${normalized.shape.directionId}`,
      Option.some(normalized),
      ROUTE_TOPOLOGY_CACHE_TTL_MS,
      MAX_ROUTE_CACHE_ENTRIES,
      at,
    );
    writeCache(
      routeCache,
      normalized.route.id,
      Option.some(normalized.route),
      ROUTE_TOPOLOGY_CACHE_TTL_MS,
      MAX_ROUTE_CACHE_ENTRIES,
      at,
    );
    allRoutesCache.clear();
  };

  const invalidateStopTopology = (): void => {
    nearbyCache.clear();
    stopsForRoutesCache.clear();
    stopsByIdsCache.clear();
  };

  const readers: SurfaceTopologyReadCapabilities = {
    readNearbyCandidates: (lat, lon, radiusMeters) => {
      const key = `${coordinateKey(lat)}:${coordinateKey(lon)}:${radiusMeters}`;
      const cached = readCache(nearbyCache, key, now());
      if (cached !== undefined) return Effect.succeed(cached);
      return source
        .readNearbyCandidates(lat, lon, radiusMeters)
        .pipe(
          Effect.tap((stops) =>
            Effect.sync(() =>
              writeCache(
                nearbyCache,
                key,
                stops,
                NEARBY_TOPOLOGY_CACHE_TTL_MS,
                MAX_NEARBY_CACHE_ENTRIES,
                now(),
              ),
            ),
          ),
        );
    },

    readRouteDirectionIds: (routeId) => source.readRouteDirectionIds(routeId),
    readTripTerminals: (routeId, tripIds) => source.readTripTerminals(routeId, tripIds),
    readDirectionsForTrips: (routeId, tripIds) => source.readDirectionsForTrips(routeId, tripIds),

    readCachedRouteDetails: (routeId, directionId) => {
      const key = `${routeId}:${directionId}`;
      const cached = readCache(routeDetailsCache, key, now());
      if (cached !== undefined) return Effect.succeed(cached);
      return source
        .readCachedRouteDetails(routeId, directionId)
        .pipe(
          Effect.tap((details) =>
            Effect.sync(() =>
              writeCache(
                routeDetailsCache,
                key,
                details,
                ROUTE_TOPOLOGY_CACHE_TTL_MS,
                MAX_ROUTE_CACHE_ENTRIES,
                now(),
              ),
            ),
          ),
        );
    },

    readRouteRow: (routeId) => {
      const cached = readCache(routeCache, routeId, now());
      if (cached !== undefined) return Effect.succeed(cached);
      return source
        .readRouteRow(routeId)
        .pipe(
          Effect.tap((route) =>
            Effect.sync(() =>
              writeCache(
                routeCache,
                routeId,
                route,
                ROUTE_TOPOLOGY_CACHE_TTL_MS,
                MAX_ROUTE_CACHE_ENTRIES,
                now(),
              ),
            ),
          ),
        );
    },

    readAllRouteRows: () => {
      const key = "all";
      const cached = readCache(allRoutesCache, key, now());
      if (cached !== undefined) return Effect.succeed(cached);
      return source
        .readAllRouteRows()
        .pipe(
          Effect.tap((routes) =>
            Effect.sync(() =>
              writeCache(allRoutesCache, key, routes, ROUTE_TOPOLOGY_CACHE_TTL_MS, 1, now()),
            ),
          ),
        );
    },

    readStopsForRoutes: (routeIds) => {
      const key = routeIds.join("\u001f");
      const cached = readCache(stopsForRoutesCache, key, now());
      if (cached !== undefined) return Effect.succeed(cached);
      return source
        .readStopsForRoutes(routeIds)
        .pipe(
          Effect.tap((stops) =>
            Effect.sync(() =>
              writeCache(
                stopsForRoutesCache,
                key,
                stops,
                NEARBY_TOPOLOGY_CACHE_TTL_MS,
                MAX_NEARBY_CACHE_ENTRIES,
                now(),
              ),
            ),
          ),
        );
    },

    readStopsByIds: (stopIds) => {
      const key = stopIds.join("\u001f");
      const cached = readCache(stopsByIdsCache, key, now());
      if (cached !== undefined) return Effect.succeed(cached);
      return source
        .readStopsByIds(stopIds)
        .pipe(
          Effect.tap((stops) =>
            Effect.sync(() =>
              writeCache(
                stopsByIdsCache,
                key,
                stops,
                NEARBY_TOPOLOGY_CACHE_TTL_MS,
                MAX_NEARBY_CACHE_ENTRIES,
                now(),
              ),
            ),
          ),
        );
    },
  };

  return { readers, rememberRouteDetails, invalidateStopTopology };
}
