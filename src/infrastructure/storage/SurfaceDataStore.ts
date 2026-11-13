import type { TripTerminal, TripRouteLookup } from "~/domain/surface/boarding";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type {
  SurfaceStop,
  SurfaceRoute,
  RouteDetails,
  NearbyStopResult,
} from "~/domain/surface/types";

/**
 * Storage seam for surface topology data. This module is the contract
 * only: the in-memory adapter lives in `memorySurfaceDataStore.ts`, the SQL
 * adapter in `d1SurfaceDataStore.ts`.
 *
 * Read-only contract: every read serves existing topology and never
 * fetches, revalidates, or persists. Topology mutation is explicit-only via
 * the crawl/topology-source seam (`surfaceStore/crawl`,
 * `surfaceStore/topology`) sequenced by SurfaceTopologyRefresh, never via
 * request-path reads.
 *
 * Failure semantics: database failures are errors, not empty results.
 * Read methods propagate failures through the Effect error channel so callers
 * (and ultimately the RPC layer) can distinguish "DB down" from a legitimate
 * empty result. Absent rows still resolve to Option.none / empty arrays.
 */
export interface SurfaceDataStoreService {
  /** Resolve static route and direction membership for realtime trip identities. */
  readonly getRoutesForTrips?: TripRouteLookup;
  readonly findNearbyStops: (
    lat: number,
    lon: number,
    radiusMeters?: number,
  ) => Effect.Effect<readonly NearbyStopResult[], unknown>;

  /**
   * Every direction id the route declares, ascending. A route may declare more
   * than two (a feed publishing no `direction_id` files everything under 0), so
   * callers enumerate rather than
   * assuming the 0/1 pair.
   */
  readonly getRouteDirectionIds: (routeId: string) => Effect.Effect<readonly number[], unknown>;

  /**
   * Map each trip id to the direction group the seeder filed it under, so a
   * realtime departure can be attributed to a group on feeds that publish no
   * direction_id. Trips absent from the map are not in the table.
   */
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

export class SurfaceDataStore extends Context.Service<SurfaceDataStore, SurfaceDataStoreService>()(
  "SurfaceDataStore",
) {}
