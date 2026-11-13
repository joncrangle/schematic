import type { TripTerminal } from "~/domain/surface/boarding";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { clampProximityRadius } from "~/domain/proximity";
import { filterNearbyStops } from "~/domain/surface/revalidation";
import type {
  NearbyStopResult,
  RouteDetails,
  SurfaceRoute,
  SurfaceStop,
} from "~/domain/surface/types";
import { compareRouteShortNames } from "../surfaceRowMappers";

const DEFAULT_PROXIMITY_RADIUS_METERS = 500;

export interface SurfaceStoreKernelCapabilities {
  /** Candidate stops, optionally pre-filtered by a storage-specific index. */
  readonly readNearbyCandidates: (
    lat: number,
    lon: number,
    radiusMeters: number,
  ) => Effect.Effect<readonly SurfaceStop[], unknown>;
  /** Cache lookup with storage-specific row mapping or indexing. */
  readonly readRouteDirectionIds: (routeId: string) => Effect.Effect<readonly number[], unknown>;
  readonly readTripTerminals: (
    routeId: string,
    tripIds: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, TripTerminal>, unknown>;

  readonly readDirectionsForTrips: (
    routeId: string,
    tripIds: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, number>, unknown>;
  readonly readCachedRouteDetails: (
    routeId: string,
    directionId: number,
  ) => Effect.Effect<Option.Option<RouteDetails>, unknown>;
  readonly readRouteRow: (routeId: string) => Effect.Effect<Option.Option<SurfaceRoute>, unknown>;
  readonly readAllRouteRows: () => Effect.Effect<readonly SurfaceRoute[], unknown>;
  readonly readStopsForRoutes: (
    routeIds: readonly string[],
  ) => Effect.Effect<readonly SurfaceStop[], unknown>;
  readonly readStopsByIds: (
    stopIds: readonly string[],
  ) => Effect.Effect<readonly SurfaceStop[], unknown>;
}

export interface SurfaceStoreKernel {
  readonly findNearbyStops: (
    lat: number,
    lon: number,
    radiusMeters?: number,
  ) => Effect.Effect<readonly NearbyStopResult[], unknown>;
  readonly getRouteDirectionIds: (routeId: string) => Effect.Effect<readonly number[], unknown>;
  readonly getTripTerminals: (
    routeId: string,
    tripIds: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, TripTerminal>, unknown>;

  readonly getDirectionsForTrips: (
    routeId: string,
    tripIds: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, number>, unknown>;
  readonly getRouteDetails: (
    routeId: string,
    directionId: number,
  ) => Effect.Effect<Option.Option<RouteDetails>, unknown>;
  readonly getRoute: (routeId: string) => Effect.Effect<Option.Option<SurfaceRoute>, unknown>;
  readonly getAllRoutes: () => Effect.Effect<readonly SurfaceRoute[], unknown>;
  readonly getStopsForRoutes: (
    routeIds: readonly string[],
  ) => Effect.Effect<readonly SurfaceStop[], unknown>;
  readonly getStopsByIds: (
    stopIds: readonly string[],
  ) => Effect.Effect<readonly SurfaceStop[], unknown>;
}

/**
 * Shared SurfaceDataStore read policy.
 *
 * Every read serves existing topology: no route-config fetcher, no
 * revalidation scheduling, no persistence, no cooldown or in-flight state.
 * A cache miss is a legitimate Option.none / empty result, never a fetch.
 * Topology mutation is explicit-only via the crawl/topology-source seam
 * (`crawl.crawlTopology`, `topology.createD1TopologySource`,
 * `SurfaceTopologyWriter.reconcileRoute`), sequenced by SurfaceTopologyRefresh.
 * Storage adapters supply only candidate and cache reads.
 */
export function makeSurfaceStoreKernel(
  capabilities: SurfaceStoreKernelCapabilities,
): SurfaceStoreKernel {
  const findNearbyStops = (
    lat: number,
    lon: number,
    radiusMeters = DEFAULT_PROXIMITY_RADIUS_METERS,
  ) => {
    const effectiveRadius = clampProximityRadius(radiusMeters);
    return Effect.map(capabilities.readNearbyCandidates(lat, lon, effectiveRadius), (candidates) =>
      filterNearbyStops(candidates, lat, lon, effectiveRadius),
    );
  };

  const getRouteDirectionIds = (routeId: string) => capabilities.readRouteDirectionIds(routeId);

  const getTripTerminals = (routeId: string, tripIds: readonly string[]) =>
    capabilities.readTripTerminals(routeId, tripIds);

  const getDirectionsForTrips = (routeId: string, tripIds: readonly string[]) =>
    capabilities.readDirectionsForTrips(routeId, tripIds);

  const getRouteDetails = (routeId: string, directionId: number) =>
    capabilities.readCachedRouteDetails(routeId, directionId);

  const getRoute = (routeId: string) => capabilities.readRouteRow(routeId);

  const getAllRoutes = () =>
    Effect.map(capabilities.readAllRouteRows(), (rows) => [...rows].sort(compareRouteShortNames));

  const getStopsForRoutes = (routeIds: readonly string[]) => {
    if (routeIds.length === 0) return Effect.succeed([] as readonly SurfaceStop[]);
    const normalized = routeIds.map((id) => id.trim()).filter((id) => id !== "");
    if (normalized.length === 0) return Effect.succeed([] as readonly SurfaceStop[]);
    return capabilities.readStopsForRoutes(normalized);
  };

  const getStopsByIds = (stopIds: readonly string[]) => {
    if (stopIds.length === 0) return Effect.succeed([] as readonly SurfaceStop[]);
    return Effect.map(capabilities.readStopsByIds(stopIds), (rows) => {
      const byId = new Map<string, SurfaceStop>();
      for (const stop of rows) byId.set(stop.id, stop);
      const ordered: SurfaceStop[] = [];
      for (const id of stopIds) {
        const found = byId.get(id);
        if (found) ordered.push(found);
      }
      return ordered;
    });
  };

  return {
    findNearbyStops,
    getRouteDirectionIds,
    getTripTerminals,
    getDirectionsForTrips,
    getRouteDetails,
    getRoute,
    getAllRoutes,
    getStopsForRoutes,
    getStopsByIds,
  };
}
