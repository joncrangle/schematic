import type { TripTerminal } from "~/domain/surface/boarding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type {
  SurfaceStop,
  SurfaceRoute,
  RouteShape,
  RouteDetails,
  RouteStopAssociation,
} from "~/domain/surface/types";
import { SurfaceDataStore, type SurfaceDataStoreService } from "./SurfaceDataStore";
import { makeSurfaceStoreKernel } from "./surfaceStore/readPolicy";
import {
  createSurfaceTopologyReadCache,
  type SurfaceTopologyReadCapabilities,
} from "./surfaceStore/topologyCache";

export interface MemorySurfaceDataStoreOptions {
  readonly tripTerminals?: ReadonlyMap<string, ReadonlyMap<string, TripTerminal>>;
  readonly stops: readonly SurfaceStop[];
  readonly shapes: readonly RouteShape[];
  readonly routes: readonly SurfaceRoute[];
  readonly routeStops: readonly RouteStopAssociation[];
}

/**
 * Builds a SurfaceDataStoreService from in-memory pre-loaded data.
 *
 * Read-only contract: every read serves existing topology and never
 * fetches, revalidates, or persists. A cache miss is a legitimate
 * Option.none / empty result. Topology changes arrive only through a
 * rebuilt service (explicit seed), never through request-path reads.
 */
export function buildDataStoreService(
  data: MemorySurfaceDataStoreOptions,
): SurfaceDataStoreService {
  const stopsById = new Map<string, SurfaceStop>();
  for (const s of data.stops) {
    stopsById.set(s.id, s);
  }

  const routesById = new Map<string, SurfaceRoute>();
  for (const r of data.routes) {
    routesById.set(r.id, r);
  }

  const shapesByKey = new Map<string, RouteShape>();
  for (const sh of data.shapes) {
    shapesByKey.set(`${sh.routeId}:${sh.directionId}`, sh);
  }

  // routeId:directionId -> sorted stop ids
  const stopsByRoutePattern = new Map<string, string[]>();
  const sortedRouteStops = [...data.routeStops].sort((a, b) => a.stopSequence - b.stopSequence);
  for (const rs of sortedRouteStops) {
    const key = `${rs.routeId}:${rs.directionId}`;
    let list = stopsByRoutePattern.get(key);
    if (!list) {
      list = [];
      stopsByRoutePattern.set(key, list);
    }
    list.push(rs.stopId);
  }

  function getCachedDetails(routeId: string, directionId: number): Option.Option<RouteDetails> {
    const route = routesById.get(routeId);
    const shape = shapesByKey.get(`${routeId}:${directionId}`);
    if (!route || !shape) return Option.none();
    const stopIds = stopsByRoutePattern.get(`${routeId}:${directionId}`) ?? [];
    const stops: SurfaceStop[] = [];
    for (const sid of stopIds) {
      const stop = stopsById.get(sid);
      if (stop) stops.push(stop);
    }
    return Option.some({ route, shape, stops });
  }

  const topologyReadSource: SurfaceTopologyReadCapabilities = {
    readNearbyCandidates: () => Effect.sync(() => Array.from(stopsById.values())),
    readTripTerminals: (routeId, tripIds) =>
      Effect.succeed(
        new Map(
          tripIds.flatMap((id) => {
            const terminal = data.tripTerminals?.get(routeId)?.get(id);
            return terminal ? [[id, terminal] as const] : [];
          }),
        ),
      ),
    readDirectionsForTrips: () => Effect.succeed(new Map<string, number>()),
    readRouteDirectionIds: (routeId) =>
      Effect.sync(() =>
        [...shapesByKey.keys()]
          .filter((key) => key.startsWith(`${routeId}:`))
          .map((key) => Number(key.slice(routeId.length + 1)))
          .filter((directionId) => Number.isInteger(directionId))
          .sort((a, b) => a - b),
      ),
    readCachedRouteDetails: (routeId, directionId) =>
      Effect.sync(() => getCachedDetails(routeId, directionId)),
    readRouteRow: (routeId) =>
      Effect.sync(() => {
        const route = routesById.get(routeId);
        return route ? Option.some(route) : Option.none();
      }),
    readAllRouteRows: () => Effect.sync(() => Array.from(routesById.values())),
    readStopsForRoutes: (routeIds) =>
      Effect.sync(() => {
        const routeSet = new Set(routeIds);
        const matched: SurfaceStop[] = [];
        for (const stop of stopsById.values()) {
          if (stop.routes.some((r) => routeSet.has(r))) {
            matched.push(stop);
          }
        }
        return matched;
      }),
    readStopsByIds: (stopIds) =>
      Effect.sync(() => {
        const idSet = new Set(stopIds);
        const matched: SurfaceStop[] = [];
        for (const stop of stopsById.values()) {
          if (idSet.has(stop.id)) matched.push(stop);
        }
        return matched;
      }),
  };
  const topologyCache = createSurfaceTopologyReadCache(topologyReadSource);

  const kernel = makeSurfaceStoreKernel({
    ...topologyCache.readers,
  });

  return SurfaceDataStore.of({
    findNearbyStops: kernel.findNearbyStops,
    getRouteDirectionIds: kernel.getRouteDirectionIds,
    getTripTerminals: kernel.getTripTerminals,
    getDirectionsForTrips: kernel.getDirectionsForTrips,
    getRouteDetails: kernel.getRouteDetails,
    getRoute: kernel.getRoute,
    getAllRoutes: kernel.getAllRoutes,
    getStopsForRoutes: kernel.getStopsForRoutes,
    getStopsByIds: kernel.getStopsByIds,
  });
}

/**
 * Creates an in-memory SurfaceDataStore layer from pre-loaded data.
 */
export function createMemorySurfaceDataStore(
  data: MemorySurfaceDataStoreOptions,
): Layer.Layer<SurfaceDataStore> {
  return Layer.succeed(SurfaceDataStore, buildDataStoreService(data));
}
