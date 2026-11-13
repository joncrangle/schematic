import { isTerminatingPrediction } from "~/domain/surface/boarding";
import * as Context from "effect/Context";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import {
  type BoundingBox,
  type GetNearbyTransitInput,
  type NearbyDirectionInfo,
  type NearbyRouteArrival,
  type RouteDetails,
  type RouteTrackingData,
  type ArrivalPrediction,
  type LiveVehiclePosition,
  type SurfaceTransitState,
  type VehicleFeedFreshness,
  inferRouteType,
} from "~/domain/surface/types";
import type { SurfaceStop } from "~/domain/surface/types";
import { SurfaceDataStore } from "~/infrastructure/storage/SurfaceDataStore";
import { clampProximityRadius, WALKING_METERS_PER_MINUTE } from "~/domain/proximity";
import { getAgencyById } from "~/agencies";
import type { AgencySnapshot, RouteIdNormalization } from "~/agencies/types";
import { resolveContentLocale, type UiLocale } from "~/domain/locale";
import {
  buildDirectionLabels,
  deriveApproachingVehicleEtas,
  getRouteDirectionsForRoute,
  inferRouteHeadsign,
  isNorthSouthDirectionIdsInverted,
  resolveDirectionAxis,
} from "~/domain/surface/direction";
import { orderStopsAlongCorridor } from "~/domain/surface/corridor/index";
import { matchAlertsForRoute } from "~/domain/surface/surfaceAlerts";
import { isEquivalentNearbyStop } from "~/domain/surface/revalidation";
import { logger } from "~/infrastructure/logging/logger";
import { calculateHaversineMeters, decodePolyline, encodePolyline } from "~/domain/map/MapGeometry";
import { routeIdsMatch } from "~/domain/surface/routeIds";
import { RealtimeError } from "~/domain/surface/realtimeSource";
import type {
  RealtimeFetchOptions,
  RealtimeSnapshot,
  RealtimeSource,
} from "~/domain/surface/realtimeSource";
import type { StaticSnapshot } from "~/domain/surface/topologySource";
import { makeRequestScopedEffectCache } from "~/domain/requestScopedEffectCache";
import type { RequestScopedEffectCache } from "~/domain/requestScopedEffectCache";

/**
 * NearbyTransit deep module (C1), single owner of selection→fetch→fuse→stale.
 *
 * Collapses the 7-file vertical slice (realtime state + domain seams + DataStore)
 * into one deep module. Callers
 * learn one method set; freshness owns arrivalsStale privately; direction labels
 * delegate to domain buildDirectionLabels at a single site; approaching-vehicle
 * derivation lives solely here server-side (RouteArrivalCard retains a
 * presentation-only fallback for collapsed-row stale cache reads, see its
 * header comment; NearbyTransit remains sole authoritative server call site).
 *
 * Failure semantics: no swallow-points, DB or realtime failures
 * propagate through Effect error channel. Legitimate empties stay results.
 * Agency scoping: every method takes agencyId in request; per-agency
 * operational defaults arrive via SurfaceAgencyDefaults layer derived once
 * from manifestFocus/manifestFallbackBounds at layer build.
 */

/**
 * Internal realtime state adapter for NearbyTransit. It owns only the mutable
 * last-good cache needed to turn an upstream failure into stale data; callers
 * use NearbyTransit rather than this implementation seam.
 */
export interface NearbyRealtimeStateApi {
  readonly getState: Effect.Effect<SurfaceTransitState>;
  readonly isArrivalsStale: Effect.Effect<boolean>;
  readonly getStopArrivals: (input: {
    readonly agencyId: string;
    readonly stopId: string;
    readonly routeId: string;
    readonly snapshot?: Effect.Effect<RealtimeSnapshot, RealtimeError>;
  }) => Effect.Effect<readonly ArrivalPrediction[], unknown>;
  readonly getRouteVehicles: (input: {
    readonly agencyId: string;
    readonly routeId: string;
    readonly directionId?: number;
    readonly snapshot?: Effect.Effect<RealtimeSnapshot, RealtimeError>;
  }) => Effect.Effect<readonly LiveVehiclePosition[], unknown>;
  readonly getRealtimeSnapshot: (
    agencyId: string,
    options?: RealtimeFetchOptions,
  ) => Effect.Effect<RealtimeSnapshot, RealtimeError>;
  readonly refreshOnce: Effect.Effect<void>;
}

/** @internal Test-only injection seam for the NearbyTransit deep module. */
export class NearbyRealtimeState extends Context.Service<
  NearbyRealtimeState,
  NearbyRealtimeStateApi
>()("NearbyTransitRealtimeState") {}

export interface NearbyRealtimeStateOptions {
  readonly realtimeByAgencyId?: ReadonlyMap<string, RealtimeSource>;
  readonly topologyByAgencyId?: ReadonlyMap<string, StaticSnapshot>;
  readonly getTopologyForAgency?: (
    agencyId: string,
    options?: RealtimeFetchOptions,
  ) => Effect.Effect<StaticSnapshot, unknown>;
}

const initialSurfaceState: SurfaceTransitState = {
  generatedAt: Date.now(),
  feedTimestamp: Date.now(),
  stopArrivals: new Map(),
  routeVehicles: new Map(),
  activeTripCount: 0,
  etags: {},
};

type RealtimeCacheItem = { readonly freshness?: VehicleFeedFreshness };

// The browser polls every 15 seconds. Keep one decoded snapshot across two
// polls so nearby-panel requests do not repeatedly refetch and decode both
// full surface feeds. Arrival timestamps continue counting down on the client.
export const REALTIME_SNAPSHOT_DEDUP_WINDOW_MS = 30_000;
export const MAX_RESOLVED_REALTIME_SNAPSHOTS = 128;

// Alerts change much less frequently than vehicle arrivals. Nearby surface
// requests share this resolved snapshot data so alert feed parsing is not
// repeated for every 15-second panel refresh.
export const AGENCY_SNAPSHOT_CACHE_TTL_MS = 30_000;

const fetchWithLastGood = <T extends RealtimeCacheItem>(
  getSnapshot: () => Effect.Effect<RealtimeSnapshot, RealtimeError>,
  key: string,
  select: (snapshot: RealtimeSnapshot) => readonly T[],
  cacheRef: Ref.Ref<Map<string, readonly T[]>>,
  degradedRef: Ref.Ref<boolean>,
): Effect.Effect<readonly T[], RealtimeError> =>
  getSnapshot().pipe(
    Effect.flatMap((snapshot) =>
      Effect.gen(function* () {
        const partial = snapshot.partial === true;
        yield* Ref.set(degradedRef, partial);
        const fresh = select(snapshot);
        // Partial data serves this request but never replaces the last complete snapshot.
        if (!partial) {
          yield* Ref.update(cacheRef, (map) => {
            map.set(key, fresh);
            return map;
          });
        }
        return fresh;
      }),
    ),
    Effect.catch((err: RealtimeError) =>
      Effect.gen(function* () {
        yield* Ref.set(degradedRef, true);
        const map = yield* Ref.get(cacheRef);
        const lastGood = map.get(key);
        if (!lastGood || lastGood.length === 0) return yield* Effect.fail(err);
        return yield* Effect.succeed(
          lastGood.map((item) => ({ ...item, freshness: "stale" as const })),
        );
      }),
    ),
  );

/** @internal Public seam for composing and testing the realtime repository. */
export function createRealtimeCacheLayer(
  initialState: Partial<SurfaceTransitState> = {},
  options: NearbyRealtimeStateOptions = {},
): Layer.Layer<NearbyRealtimeState> {
  const mergedState: SurfaceTransitState = {
    ...initialSurfaceState,
    ...initialState,
    stopArrivals: initialState.stopArrivals ?? new Map(),
    routeVehicles: initialState.routeVehicles ?? new Map(),
  };

  return Layer.effect(
    NearbyRealtimeState,
    Effect.gen(function* () {
      const stateRef = yield* Ref.make<SurfaceTransitState>(mergedState);
      const degradedRef = yield* Ref.make(false);
      const lastGoodArrivalsRef = yield* Ref.make(new Map<string, readonly ArrivalPrediction[]>());
      const lastGoodVehiclesRef = yield* Ref.make(
        new Map<string, readonly LiveVehiclePosition[]>(),
      );

      const topologyFor = (agencyId: string): StaticSnapshot =>
        options.topologyByAgencyId?.get(agencyId) ?? { agencyId, generatedAt: 0, routes: [] };

      // Keep only resolved snapshots in shared state. Request callers supply
      // their own Effect Cache for in-flight deduplication so its Fiber cannot
      // cross a Worker request boundary.
      const resolvedSnapshots = new Map<
        string,
        { readonly snapshot: RealtimeSnapshot; readonly expiresAt: number }
      >();
      const fetchSnapshot = (
        agencyId: string,
        fetchOptions?: RealtimeFetchOptions,
      ): Effect.Effect<RealtimeSnapshot, RealtimeError> =>
        Effect.suspend(() => {
          const cacheKey = JSON.stringify([
            agencyId,
            fetchOptions?.routeIds ? [...fetchOptions.routeIds].sort() : null,
            fetchOptions?.vehiclesOnly ?? false,
            fetchOptions?.maxSubrequests ?? null,
            fetchOptions?.stopIds ? [...fetchOptions.stopIds].sort() : null,
            fetchOptions?.stopIdsByRoute
              ? [...fetchOptions.stopIdsByRoute.entries()]
                  .map(([routeId, stopIds]) => [routeId, [...stopIds].sort()] as const)
                  .sort(([left], [right]) => left.localeCompare(right))
              : null,
          ]);
          const now = Date.now();
          for (const [key, value] of resolvedSnapshots) {
            if (value.expiresAt <= now) resolvedSnapshots.delete(key);
          }
          const cached = resolvedSnapshots.get(cacheKey);
          if (cached) {
            // Map insertion order is the LRU order; refresh the hit's position.
            resolvedSnapshots.delete(cacheKey);
            resolvedSnapshots.set(cacheKey, cached);
            return Effect.succeed(cached.snapshot);
          }

          const source = options.realtimeByAgencyId?.get(agencyId);
          if (!source) {
            return Effect.fail(
              new RealtimeError({
                agencyId,
                message: `Missing realtime source for ${agencyId}`,
              }),
            );
          }
          return (
            options.getTopologyForAgency?.(agencyId, fetchOptions) ??
            Effect.succeed(topologyFor(agencyId))
          ).pipe(
            Effect.flatMap((topology) => source.fetchRealtime(topology, fetchOptions)),
            Effect.mapError((cause) =>
              cause instanceof RealtimeError
                ? cause
                : new RealtimeError({ agencyId, message: String(cause), cause }),
            ),
            Effect.tap((snapshot) =>
              snapshot.partial
                ? Effect.void
                : Effect.sync(() => {
                    const resolvedAt = Date.now();
                    for (const [key, value] of resolvedSnapshots) {
                      if (value.expiresAt <= resolvedAt) resolvedSnapshots.delete(key);
                    }
                    resolvedSnapshots.delete(cacheKey);
                    while (resolvedSnapshots.size >= MAX_RESOLVED_REALTIME_SNAPSHOTS) {
                      const leastRecentlyUsed = resolvedSnapshots.keys().next().value;
                      if (leastRecentlyUsed === undefined) break;
                      resolvedSnapshots.delete(leastRecentlyUsed);
                    }
                    resolvedSnapshots.set(cacheKey, {
                      snapshot,
                      expiresAt: resolvedAt + REALTIME_SNAPSHOT_DEDUP_WINDOW_MS,
                    });
                  }),
            ),
          );
        });

      return NearbyRealtimeState.of({
        getState: Ref.get(stateRef),
        isArrivalsStale: Ref.get(degradedRef),
        getRealtimeSnapshot: fetchSnapshot,
        getStopArrivals: (input: {
          readonly agencyId: string;
          readonly stopId: string;
          readonly routeId: string;
          readonly snapshot?: Effect.Effect<RealtimeSnapshot, RealtimeError>;
        }) =>
          Effect.gen(function* () {
            const source = options.realtimeByAgencyId?.get(input.agencyId);
            if (source) {
              return yield* fetchWithLastGood(
                () => input.snapshot ?? fetchSnapshot(input.agencyId),
                `${input.agencyId}:${input.routeId}:${input.stopId}`,
                (snapshot) =>
                  snapshot.arrivals.filter(
                    (prediction) =>
                      routeIdsMatch(prediction.routeId, input.routeId) &&
                      prediction.stopId === input.stopId,
                  ),
                lastGoodArrivalsRef,
                degradedRef,
              );
            }
            const state = yield* Ref.get(stateRef);
            return (state.stopArrivals.get(input.stopId) ?? []).filter(
              (prediction) => prediction.routeId === input.routeId,
            );
          }),
        getRouteVehicles: (input: {
          readonly agencyId: string;
          readonly routeId: string;
          readonly directionId?: number;
          readonly snapshot?: Effect.Effect<RealtimeSnapshot, RealtimeError>;
        }) =>
          Effect.gen(function* () {
            const source = options.realtimeByAgencyId?.get(input.agencyId);
            if (source) {
              const key = `${input.agencyId}:${input.routeId}`;
              const vehicles = yield* fetchWithLastGood(
                () => input.snapshot ?? fetchSnapshot(input.agencyId),
                key,
                (snapshot) =>
                  snapshot.vehicles.filter((vehicle) =>
                    routeIdsMatch(vehicle.routeId, input.routeId),
                  ),
                lastGoodVehiclesRef,
                degradedRef,
              );
              if (input.directionId === undefined) return vehicles;
              const filtered = vehicles.filter(
                (vehicle: LiveVehiclePosition) =>
                  vehicle.directionId === undefined || vehicle.directionId === input.directionId,
              );
              return filtered.length > 0 ? filtered : vehicles;
            }
            const state = yield* Ref.get(stateRef);
            const vehicles = state.routeVehicles?.get(input.routeId) ?? [];
            return input.directionId === undefined
              ? vehicles
              : vehicles.filter(
                  (vehicle: LiveVehiclePosition) => vehicle.directionId === input.directionId,
                );
          }),
        refreshOnce: Effect.void,
      });
    }),
  );
}

// ——————————————————————————————————————————————
// Public request shapes (agencyId is request data, never global)
// ——————————————————————————————————————————————

export interface NearbyTransitRequest extends GetNearbyTransitInput {
  readonly agencyId: string;
  readonly locale?: UiLocale;
}

export interface SavedTransitRequest {
  readonly agencyId: string;
  readonly favouriteRoutes: readonly string[];
  readonly lat?: number;
  readonly lon?: number;
  readonly locale?: UiLocale;
}

export interface RouteTrackingRequest {
  readonly agencyId: string;
  readonly routeId: string;
  readonly directionId: number;
  readonly locale?: UiLocale;
}

// ——————————————————————————————————————————————
// Operational defaults (manifest-derived, per-agency layer)
// ——————————————————————————————————————————————

export interface AgencyOperationalDefaults {
  readonly agencyId: string;
  readonly locale?: UiLocale;
  readonly focus: { lat: number; lon: number };
  readonly fallbackBounds: BoundingBox;
  readonly routeIdNormalization?: RouteIdNormalization;
  /** Lower ceiling while an uncached AnyRide alert snapshot is polled. */
  readonly realtimeMaxSubrequestsWhenAlertsFetch?: number;
  readonly vehicleOnlyRouteIds?: ReadonlySet<string>;
}

export class SurfaceAgencyDefaults extends Context.Service<
  SurfaceAgencyDefaults,
  AgencyOperationalDefaults
>()("SurfaceAgencyDefaults") {}

interface NearbySnapshotSourceApi {
  readonly getSnapshot:
    | Effect.Effect<AgencySnapshot, unknown>
    | ((
        locale?: UiLocale,
        requestCache?: RequestScopedEffectCache,
      ) => Effect.Effect<AgencySnapshot, unknown>);
}

/** Internal adapter: the provider port is read directly at the composition root. */
export class NearbySnapshotSource extends Context.Service<
  NearbySnapshotSource,
  NearbySnapshotSourceApi
>()("NearbySnapshotSource") {}

// ——————————————————————————————————————————————
// Deep module constants (previously scattered across Service + Assembler)
// ——————————————————————————————————————————————

export const MAX_STOPS_PER_FAVOURITE_ROUTE = 2;
export const ROUTE_QUERY_CONCURRENCY = 8;
export const STOP_ARRIVALS_CONCURRENCY = "unbounded" as const;
export const MAX_STOPS_PER_ROUTE = 3;
export const ARRIVALS_PER_DIRECTION = 3;
export const PREDICTION_FRESHNESS_WINDOW_MS = 60_000;

const DIRECTION_IDS = [0, 1] as const;

export interface ProximateStopItem {
  readonly stop: SurfaceStop;
  readonly distanceMeters: number;
  readonly walkingMinutes: number;
}

interface AssembleRouteArrivalsInput {
  readonly agencyId: string;
  readonly locale: UiLocale;
  readonly stopItems: readonly ProximateStopItem[];
  /** Validate denormalized stop memberships only for ordinary nearby discovery. */
  readonly validateStopTopology: boolean;
}

/** Static corridors remain useful on failure; vehicle-only views must expose availability. */
const getRouteVehicleState = (
  repository: NearbyRealtimeStateApi,
  input: Parameters<NearbyRealtimeStateApi["getRouteVehicles"]>[0],
  vehiclePositionsOnly = false,
) =>
  repository.getRouteVehicles(input).pipe(
    Effect.flatMap((vehicles) =>
      Effect.gen(function* () {
        const degraded = vehiclePositionsOnly ? yield* repository.isArrivalsStale : false;
        const freshness =
          vehicles.some((vehicle) => vehicle.freshness === "stale") || degraded
            ? vehicles.length
              ? ("stale" as const)
              : ("unavailable" as const)
            : ("live" as const);
        return {
          vehicles,
          vehiclePositionsFreshness: vehiclePositionsOnly ? freshness : undefined,
        };
      }),
    ),
    Effect.orElseSucceed(() => ({
      vehicles: [],
      vehiclePositionsFreshness: vehiclePositionsOnly ? ("unavailable" as const) : undefined,
    })),
  );

// ——————————————————————————————————————————————
// Single-homed domain delegations (one textual call site each)
// ——————————————————————————————————————————————

/**
 * Single-homed direction-label resolver (D4): sole buildDirectionLabels
 * call site in this module. Every consumer (tracking + fuse) routes through
 * here so canonical literals never diverge.
 */
function resolveDirectionLabels(
  detailsByDir: ReadonlyMap<number, { shape: { headsign: string } }>,
  routeShortName?: string,
): Record<
  number,
  { label: string; destination: string; generatedLabel?: NearbyDirectionInfo["generatedLabel"] }
> {
  return buildDirectionLabels(detailsByDir, routeShortName);
}

/**
 * Single-homed arrivalsStale fold (C1): feedDegraded || predictionsStale ||
 * snapshotFailed. Every nearby card routes through here, the tracking path
 * degrades alerts only (no arrivalsStale), nearby retains stale.
 */
function foldArrivalsStale(
  feedDegraded: boolean,
  predictionsStale: boolean,
  snapshotFailed: boolean,
): true | undefined {
  return feedDegraded || predictionsStale || snapshotFailed ? true : undefined;
}

/**
 * Canonical endpoints suppress approximate vehicle ETAs when predictions are
 * absent. They cannot determine terminality for a live trip on a branch.
 */
function isTerminalRouteStop(details: RouteDetails | undefined, stop: SurfaceStop): boolean {
  if (!details || details.stops.length < 2) return false;
  const terminalStop = details?.stops.at(-1);
  return terminalStop !== undefined && isEquivalentNearbyStop(terminalStop, stop);
}

/**
 * Sole server-side deriveApproachingVehicleEtas call site (C1). Client
 * RouteArrivalCard retains a presentation-only fallback for non-reactive
 * collapsed-row cache reads (see its header doc); server remains authoritative.
 */
function deriveEtas(params: Parameters<typeof deriveApproachingVehicleEtas>[0]): number[] {
  return deriveApproachingVehicleEtas(params);
}

// ——————————————————————————————————————————————
// Public seam, one interface callers learn
// ——————————————————————————————————————————————

export interface NearbyTransitApi {
  readonly getNearbyTransit: (
    input: NearbyTransitRequest,
  ) => Effect.Effect<readonly NearbyRouteArrival[], unknown>;
  readonly getSavedTransit: (
    input: SavedTransitRequest,
  ) => Effect.Effect<readonly NearbyRouteArrival[], unknown>;
  readonly getRouteTracking: (
    input: RouteTrackingRequest,
  ) => Effect.Effect<Option.Option<RouteTrackingData>, unknown>;
}

export class NearbyTransit extends Context.Service<NearbyTransit, NearbyTransitApi>()(
  "NearbyTransit",
) {}

export const NearbyTransitLive = Layer.effect(
  NearbyTransit,
  Effect.gen(function* () {
    const dataStore = yield* SurfaceDataStore;
    const realtimeRepo = yield* NearbyRealtimeState;
    const snapshotSource = yield* NearbySnapshotSource;
    const agencyDefaults = yield* SurfaceAgencyDefaults;
    // Keep one resolved alert snapshot per UI locale across requests. The
    // in-flight cache is created inside assembleRouteArrivals below.
    const cachedSnapshots = new Map<
      UiLocale,
      { readonly snapshot: AgencySnapshot; readonly expiresAt: number }
    >();
    const loadSnapshot = (locale: UiLocale, requestCache?: RequestScopedEffectCache) =>
      Effect.suspend(() => {
        const cached = cachedSnapshots.get(locale);
        if (cached && cached.expiresAt > Date.now()) return Effect.succeed(cached.snapshot);
        const snapshotEffect =
          typeof snapshotSource.getSnapshot === "function"
            ? snapshotSource.getSnapshot(locale, requestCache)
            : snapshotSource.getSnapshot;
        return snapshotEffect.pipe(
          Effect.tap((snapshot) =>
            Effect.sync(() => {
              cachedSnapshots.set(locale, {
                snapshot,
                expiresAt: Date.now() + AGENCY_SNAPSHOT_CACHE_TTL_MS,
              });
            }),
          ),
        );
      });
    const realtimeOptionsDuringAlertFetch = (
      locale: UiLocale,
      options: RealtimeFetchOptions,
      requestCache: RequestScopedEffectCache,
    ): RealtimeFetchOptions => {
      const cached = cachedSnapshots.get(locale);
      const alertSnapshotCached = cached !== undefined && cached.expiresAt > Date.now();
      const maxSubrequests = agencyDefaults.realtimeMaxSubrequestsWhenAlertsFetch;
      return {
        ...options,
        requestCache,
        ...(!alertSnapshotCached && maxSubrequests !== undefined ? { maxSubrequests } : {}),
      };
    };

    // Arrival and tracking requests read static route metadata through the
    // canonical read path. Those reads are structurally write-free:
    // they serve existing topology and never fetch or persist, so the
    // 15-second polling path cannot turn into a topology write.
    const readRouteDetails = (routeId: string, directionId: number) =>
      dataStore.getRouteDetails(routeId, directionId);
    const readRouteDirectionIds = (routeId: string) => dataStore.getRouteDirectionIds(routeId);
    const readDirectionsForTrips = (routeId: string, tripIds: readonly string[]) =>
      dataStore.getDirectionsForTrips(routeId, tripIds);
    const readRoute = (routeId: string) => dataStore.getRoute(routeId);

    // ————————————————————————————————————————————
    // Private fuse: assembleRouteArrivals (coalesced from the former arrival-assembly service)
    // ————————————————————————————————————————————
    const assembleRouteArrivals = (
      input: AssembleRouteArrivalsInput,
    ): Effect.Effect<readonly NearbyRouteArrival[], unknown> =>
      Effect.gen(function* () {
        const { agencyId, stopItems } = input;
        if (stopItems.length === 0) {
          return [];
        }
        const requestCache = yield* makeRequestScopedEffectCache();

        const now = Date.now();
        const routeToStops = new Map<string, ProximateStopItem[]>();
        for (const item of stopItems) {
          for (const routeId of item.stop.routes) {
            const trimmed = routeId.trim();
            if (!trimmed) continue;
            let list = routeToStops.get(trimmed);
            if (!list) {
              list = [];
              routeToStops.set(trimmed, list);
            }
            if (list.length < MAX_STOPS_PER_ROUTE) {
              list.push(item);
            }
          }
        }
        const requestedRouteIds = new Set(routeToStops.keys());
        const requestedStopIds = new Set(
          [...routeToStops.values()].flatMap((items) => items.map((item) => item.stop.id)),
        );
        const stopIdsByRoute = new Map<string, ReadonlySet<string>>();
        for (const [routeId, items] of routeToStops) {
          stopIdsByRoute.set(routeId, new Set(items.map((item) => item.stop.id)));
        }
        const realtimeOptions = realtimeOptionsDuringAlertFetch(
          input.locale,
          {
            routeIds: requestedRouteIds,
            stopIds: requestedStopIds,
            stopIdsByRoute,
          },
          requestCache,
        );
        const snapshotCache = yield* Cache.makeWith(
          (locale: UiLocale) => loadSnapshot(locale, requestCache),
          {
            capacity: 2,
            timeToLive: (exit) =>
              Exit.isSuccess(exit) ? Duration.millis(AGENCY_SNAPSHOT_CACHE_TTL_MS) : Duration.zero,
          },
        );
        const getSnapshot = Cache.get(snapshotCache, input.locale);
        const realtimeSnapshotCache = yield* Cache.makeWith(
          (requestedAgencyId: string) =>
            realtimeRepo.getRealtimeSnapshot(requestedAgencyId, realtimeOptions),
          {
            capacity: 1,
            timeToLive: (exit) =>
              Exit.isSuccess(exit)
                ? Duration.millis(REALTIME_SNAPSHOT_DEDUP_WINDOW_MS)
                : Duration.zero,
          },
        );
        const realtimeSnapshot = Cache.get(realtimeSnapshotCache, agencyId);
        // Resolve both upstream snapshots once for this request. A failed
        // realtime cache entry has a zero TTL by design, so passing the cache
        // effect directly to every stop would retry the same outage for each
        // stop and vehicle fallback.
        const [snapshotExit, realtimeSnapshotExit] = yield* Effect.all(
          [Effect.exit(getSnapshot), Effect.exit(realtimeSnapshot)],
          { concurrency: 2 },
        );
        const snapshot =
          snapshotExit._tag === "Success"
            ? snapshotExit.value
            : {
                agencyId,
                generatedAt: now,
                freshness: "unavailable" as const,
                lines: [],
                alerts: [],
              };
        const snapshotFailed = snapshotExit._tag === "Failure";
        const realtimeSnapshotFailed = realtimeSnapshotExit._tag === "Failure";
        const realtimeSnapshotPartial =
          realtimeSnapshotExit._tag === "Success" && realtimeSnapshotExit.value.partial === true;
        const sharedRealtimeSnapshot: Effect.Effect<RealtimeSnapshot, RealtimeError> =
          realtimeSnapshotExit._tag === "Success"
            ? Effect.succeed(realtimeSnapshotExit.value)
            : Effect.failCause(realtimeSnapshotExit.cause);

        const feedDegraded =
          (yield* realtimeRepo.isArrivalsStale) ||
          realtimeSnapshotFailed ||
          realtimeSnapshotPartial;

        const routeTasks = Array.from(routeToStops.entries()).map(([routeId, stopsForRoute]) =>
          Effect.gen(function* () {
            const provider = getAgencyById(agencyId);
            // Route metadata is authoritative for modes such as TTC subway;
            // inferRouteType only covers the provider's declared surface rules.
            // The D1 adapter now serves this read from its warm topology cache
            // after the first request, so retaining the lookup does not put a
            // database read on the 15-second polling path.
            const routeRow = yield* readRoute(routeId);
            const inferredRouteType = inferRouteType(
              routeId,
              provider?.manifest.routeInterpretation,
            );
            const storedRouteType = Option.isSome(routeRow) ? routeRow.value.routeType : undefined;
            const knownRouteType = storedRouteType ?? inferredRouteType;
            if (knownRouteType === "subway") return null;
            if (
              provider?.manifest.modes &&
              !provider.manifest.modes.includes(knownRouteType as never)
            ) {
              return null;
            }

            // A route can declare more than two directions, so read every group
            // it declares rather than assuming 0/1. Grouping is by the
            // operator's stated way of travel, so two branches to different
            // terminals on the same bearing are one row, not two.
            const declaredDirectionIds = yield* readRouteDirectionIds(routeId);
            const liveConfigs = yield* Effect.forEach(
              declaredDirectionIds,
              (dirId) => readRouteDetails(routeId, dirId),
              { concurrency: "unbounded" },
            );
            const liveConfigByDirectionId = new Map<number, RouteDetails>();
            for (const [index, dirId] of declaredDirectionIds.entries()) {
              const details = liveConfigs[index];
              if (Option.isSome(details)) liveConfigByDirectionId.set(dirId, details.value);
            }
            const allDirectionDetails = [...liveConfigByDirectionId.values()];
            const routeDetails =
              allDirectionDetails[0]?.route ??
              (Option.isSome(routeRow) ? routeRow.value : undefined);
            const shortName = routeDetails?.shortName ?? routeId;
            const longName = routeDetails?.longName ?? `Route ${routeId}`;
            const routeType = routeDetails?.routeType ?? knownRouteType;
            if (
              routeType === "subway" ||
              (provider?.manifest.modes && !provider.manifest.modes.includes(routeType as never))
            ) {
              return null;
            }

            // Nearby stop rows carry a denormalized route membership index.
            // A stale membership must not make a route appear to serve a stop
            // it does not actually contain. The cached/live route topology is
            // already loaded for this route, so validate without another read.
            const topologyStops = allDirectionDetails.flatMap((details) => details.stops);

            const directionMap = new Map<number, NearbyDirectionInfo>();
            const terminatingDirectionKeys = new Set<string>();

            // Fetched before the membership filter, because the filter has to be
            // able to see whether a stop the topology omits has anything
            // actually arriving for this route.
            const predictionExits = yield* Effect.all(
              stopsForRoute.map((item) =>
                Effect.exit(
                  realtimeRepo.getStopArrivals({
                    agencyId,
                    stopId: item.stop.id,
                    routeId,
                    snapshot: sharedRealtimeSnapshot,
                  }),
                ),
              ),
              { concurrency: STOP_ARRIVALS_CONCURRENCY },
            );
            const fetchedPerStop = predictionExits.map((exit) =>
              Exit.isSuccess(exit)
                ? exit.value
                : ([] as readonly import("~/domain/surface/types").ArrivalPrediction[]),
            );

            // A stop is admitted on membership alone when the topology names it,
            // or on a live prediction for this route when it does not. The
            // prediction has to be one the render path would actually use: same
            // route, inside the same freshness window, not a cancelled trip. A
            // last-good entry re-served after a feed outage is flagged stale and
            // can be arbitrarily old, so without the window check a stale
            // membership row could re-admit a stop the topology correctly
            // removed and then win the anchor on its predictions.
            const isLiveForThisRoute = (prediction: ArrivalPrediction): boolean =>
              routeIdsMatch(prediction.routeId, routeId) &&
              prediction.predictedTime >= now - PREDICTION_FRESHNESS_WINDOW_MS &&
              prediction.scheduleRelationship !== "SKIPPED";

            const verifiedStopsForRoute =
              input.validateStopTopology && topologyStops.length > 0
                ? stopsForRoute.filter(
                    (item, index) =>
                      topologyStops.some((topologyStop) =>
                        isEquivalentNearbyStop(topologyStop, item.stop),
                      ) || (fetchedPerStop[index] ?? []).some(isLiveForThisRoute),
                  )
                : stopsForRoute;
            if (verifiedStopsForRoute.length === 0) return null;

            // `verifiedStopsForRoute` is a subset of `stopsForRoute`, so the two
            // are re-paired by stop id rather than by position.
            const fetchedByStopId = new Map<string, readonly ArrivalPrediction[]>();
            const failedStopIds = new Set<string>();
            stopsForRoute.forEach((item, index) => {
              const fetched = fetchedPerStop[index] ?? [];
              const existing = fetchedByStopId.get(item.stop.id);
              if (existing === undefined) fetchedByStopId.set(item.stop.id, fetched);
              else if (fetched.length > 0) {
                fetchedByStopId.set(item.stop.id, [...existing, ...fetched]);
              }
              if (Exit.isFailure(predictionExits[index])) failedStopIds.add(item.stop.id);
            });
            const predictionsPerStop = verifiedStopsForRoute.map(
              (item) => fetchedByStopId.get(item.stop.id) ?? [],
            );
            // A failed lookup only degrades the card when it was a stop the card
            // actually uses. The fetch now covers every candidate stop, and an
            // outage on a candidate the card discarded is not this card's outage.
            const predictionsFailed = verifiedStopsForRoute.some((item) =>
              failedStopIds.has(item.stop.id),
            );

            const matchingAlerts = matchAlertsForRoute(
              routeId,
              snapshot.alerts,
              agencyDefaults.routeIdNormalization,
            );

            const detailsByDirForLabels = new Map<number, { shape: { headsign: string } }>(
              liveConfigByDirectionId,
            );

            const predictionsStale = predictionsPerStop.some((preds) =>
              preds.some((p) => p.freshness === "stale"),
            );

            // Inferred-direction collapse, scoped to the agency opt-in below.
            // A compass word has two possible origins and only one of them is
            // ours: the operator's own static GTFS, or the canonical fallback
            // this app picks when the feed states nothing. So a silent wire is
            // never on its own enough to hide a direction, and every agency
            // without the opt-in keeps its two-direction behavior and its
            // compass words.
            const allRoutePreds = predictionsPerStop.flatMap((preds) =>
              preds.filter(
                (p) =>
                  routeIdsMatch(p.routeId, routeId) &&
                  p.predictedTime >= now - PREDICTION_FRESHNESS_WINDOW_MS,
              ),
            );
            // No compass word is ever derived from the direction index, so there
            // is no wrong bearing left to omit and no agency left to opt in.
            // What remains is attribution: a feed that names no direction on the
            // wire cannot say which of a route's declared groups a departure
            // belongs to, so those departures are held for the trip_id join below
            // rather than fanned across every group.
            const routeAllInferred =
              allRoutePreds.length > 0 && allRoutePreds.every((p) => p.directionInferred === true);
            // Route-wide RT headsign in time order: an operator stop_headsign
            // present at any stop for this route outranks an absent one.
            const routeWideHeadsign = [...allRoutePreds]
              .sort((a, b) => a.predictedTime - b.predictedTime)
              .map((p) => p.headsign?.trim())
              .find((headsign) => headsign && headsign.length > 0);

            // Axis-aware labels for feeds that publish no direction, where the
            // canonical routeType pair can be the wrong axis entirely. It only
            // ever fills a direction the feed states nothing about.
            const directionAxis = resolveDirectionAxis(
              routeId,
              provider?.manifest.routeInterpretation,
            );
            const invertNorthSouth = isNorthSouthDirectionIdsInverted(
              routeId,
              provider?.manifest.routeInterpretation,
            );
            const directionLabelsForAssembler = resolveDirectionLabels(
              detailsByDirForLabels,
              shortName,
            );
            const liveConfigByDir = new Map<
              number,
              {
                headsign: string;
                label: string;
                destination: string;
                generatedLabel?: NearbyDirectionInfo["generatedLabel"];
              }
            >();
            // 0/1 are present even when undeclared so a caller can always read a
            // canonical literal; the declared groups come first in index order.
            const labelDirIds = [
              ...liveConfigByDirectionId.keys(),
              ...DIRECTION_IDS.filter((dirId) => !liveConfigByDirectionId.has(dirId)),
            ];
            for (const dirId of labelDirIds) {
              const labels = directionLabelsForAssembler[dirId];
              const details = liveConfigByDirectionId.get(dirId);
              // Keep raw empty distinct: label stays compass separately,
              // headsign stays "" when unknown so `headsign !== label` can
              // distinguish none vs a real operator headsign.
              liveConfigByDir.set(dirId, {
                headsign: details?.shape.headsign ?? "",
                label: labels.label,
                destination: labels.destination,
                ...(labels.generatedLabel ? { generatedLabel: labels.generatedLabel } : {}),
              });
            }

            for (let i = 0; i < verifiedStopsForRoute.length; i++) {
              const item = verifiedStopsForRoute[i];
              const stop = item.stop;
              const predictions = predictionsPerStop[i] ?? [];

              const matchingPreds = predictions
                .filter(
                  (p) =>
                    routeIdsMatch(p.routeId, routeId) &&
                    p.predictedTime >= now - PREDICTION_FRESHNESS_WINDOW_MS &&
                    p.scheduleRelationship !== "SKIPPED",
                )
                .sort((a, b) => a.predictedTime - b.predictedTime);

              // Build only directions this route actually has. Seeding from the
              // static pair and always emitting both fabricated an opposite
              // row for a one-directional feed: Kingston declares direction 0
              // only, so direction 1 arrived with no static headsign and no
              // destination, yet the inferred fan-out below still handed it the
              // A group whose stop sequence does not include the stop the
              // rider is standing at cannot drop them anywhere, so it must not
              // get a row. This is decided per group rather than per route: GO's
              // LW is a single route whose branches do not all call at
              // Aldershot, and emitting the ones that do not showed a rider the
              // trains to Niagara Falls and West Harbour, which stop elsewhere
              // and which they cannot board. Serving the
              // anchored stop is the test, and it is per group because the
              // groups of one route serve different stops.
              const directionIds = new Set<number>();
              for (const [dirId, group] of liveConfigByDirectionId) {
                if (
                  group.stops.length > 0 &&
                  !group.stops.some((groupStop) => isEquivalentNearbyStop(groupStop, stop))
                )
                  continue;
                directionIds.add(dirId);
              }
              // Attribution: bucket each prediction by the group its own trip
              // belongs to, joined on trip_id, which every operator's feed
              // carries and which maps exactly onto the seeded groups.
              const tripTerminals = yield* dataStore.getTripTerminals(
                routeId,
                matchingPreds.map((p) => p.tripId),
              );
              const directionByTrip = yield* readDirectionsForTrips(
                routeId,
                matchingPreds.map((p) => p.tripId),
              );
              // A live call proves its trip serves this stop, even when the
              // representative static trip omits this branch. Prefer the
              // static trip's direction to the decoder's inferred sentinel.
              for (const p of matchingPreds) {
                directionIds.add(directionByTrip.get(p.tripId) ?? p.directionId ?? 0);
              }
              if (directionIds.size === 0) {
                for (const dirId of DIRECTION_IDS) directionIds.add(dirId);
              }
              // A prediction whose trip the join cannot resolve AND whose wire
              // named no direction has no direction we can honestly assign.
              // Fanning it across every declared group would show the same
              // departure under several terminals, so those collapse to one
              // bucket instead. A prediction the join does resolve is never
              // collapsed, which is what keeps a route's distinct destinations
              // in separate rows.
              const unattributed = matchingPreds.filter(
                (p) => directionByTrip.get(p.tripId) === undefined && p.directionInferred === true,
              );
              const collapseToOneBucket =
                unattributed.length > 0 && directionByTrip.size === 0 && directionIds.size > 1;
              const directionIdsToBuild = collapseToOneBucket
                ? [unattributed[0]!.directionId ?? 0]
                : [...directionIds];

              for (const directionId of directionIdsToBuild) {
                const directionDetails = liveConfigByDirectionId.get(directionId);
                const topologyEndsHere =
                  directionDetails !== undefined && isTerminalRouteStop(directionDetails, stop);
                const directionPredictions = matchingPreds.filter((p) => {
                  const joined = directionByTrip.get(p.tripId);
                  if (joined !== undefined && joined !== directionId) return false;
                  // Unattributable: the single collapsed bucket, or the
                  // prediction's own claimed direction.
                  if (joined === undefined) {
                    if (
                      !(p.directionInferred && collapseToOneBucket) &&
                      (p.directionId ?? 0) !== directionId
                    )
                      return false;
                  }
                  return true;
                });
                const boardable = directionPredictions.filter(
                  (p) => !isTerminatingPrediction(p, tripTerminals.get(p.tripId)),
                );
                const endsHere =
                  directionPredictions.length > 0 ? boardable.length === 0 : topologyEndsHere;
                const routePredictions = boardable
                  .map((p) => p.predictedTime)
                  .slice(0, ARRIVALS_PER_DIRECTION);

                const liveConfig = liveConfigByDir.get(directionId);
                // Headsign outranks the compass word: first live RT headsign
                // (stop_headsign) in time order route-wide, else per-stop
                // fallback, else the static raw headsign, else "". Never coerce
                // empty to compass.
                const perStopHeadsign = matchingPreds
                  .map((p) => p.headsign?.trim())
                  .find((headsign) => headsign && headsign.length > 0);
                const inferredHeadsign = routeWideHeadsign ?? perStopHeadsign;
                const headsign =
                  inferredHeadsign ??
                  liveConfig?.headsign ??
                  liveConfig?.label ??
                  inferRouteHeadsign(directionId, routeType, directionAxis, invertNorthSouth);
                const fallbackDirection = getRouteDirectionsForRoute(
                  routeType,
                  routeId,
                  provider?.manifest.routeInterpretation,
                ).find((direction) => direction.directionId === directionId);
                const label = liveConfig?.label ?? fallbackDirection?.label ?? "";
                const generatedLabel = liveConfig
                  ? liveConfig.generatedLabel
                  : fallbackDirection?.generatedLabel;
                const destination = liveConfig?.destination ?? "";
                const existing = directionMap.get(directionId);

                const shouldReplace =
                  !existing ||
                  (routePredictions.length > 0 && existing.arrivals.length === 0) ||
                  (item.distanceMeters < existing.distanceMeters &&
                    (routePredictions.length > 0 || existing.arrivals.length === 0));

                if (shouldReplace) {
                  const previous = directionMap.get(directionId);
                  if (previous) {
                    terminatingDirectionKeys.delete(`${directionId}:${previous.stopId}`);
                  }
                  directionMap.set(directionId, {
                    directionId,
                    headsign,
                    label,
                    ...(generatedLabel ? { generatedLabel } : {}),
                    destination,
                    // Flagged only where the wire named no direction, i.e. exactly
                    // the buckets whose direction is Core's inference rather than
                    // the operator's statement.
                    ...(routeAllInferred ? { directionInferred: true as const } : {}),
                    stopId: stop.id,
                    stopName: stop.name,
                    stopLat: stop.lat,
                    stopLon: stop.lon,
                    distanceMeters: item.distanceMeters,
                    walkingMinutes: item.walkingMinutes,
                    arrivals: routePredictions,
                  });
                  if (endsHere) {
                    terminatingDirectionKeys.add(`${directionId}:${stop.id}`);
                  }
                }
              }
            }

            let vehicleLookupFailed = false;
            for (const directionId of directionMap.keys()) {
              const dirInfo = directionMap.get(directionId);
              const isTerminatingAtAnchoredStop = dirInfo
                ? terminatingDirectionKeys.has(`${directionId}:${dirInfo.stopId}`)
                : false;
              if (dirInfo && dirInfo.arrivals.length === 0 && !isTerminatingAtAnchoredStop) {
                const detailsOpt = liveConfigByDirectionId.get(directionId);
                if (detailsOpt && detailsOpt.stops.length > 0) {
                  const vehicleExit = yield* Effect.exit(
                    realtimeRepo.getRouteVehicles({
                      agencyId,
                      routeId,
                      directionId,
                      snapshot: sharedRealtimeSnapshot,
                    }),
                  );
                  if (Exit.isFailure(vehicleExit)) {
                    vehicleLookupFailed = true;
                    continue;
                  }
                  const vehicles = vehicleExit.value;

                  if (vehicles.length > 0) {
                    const derivedTimes = deriveEtas({
                      stops: detailsOpt.stops,
                      vehicles,
                      riderStop: {
                        id: dirInfo.stopId,
                        lat: dirInfo.stopLat,
                        lon: dirInfo.stopLon,
                      },
                      directionId,
                      now,
                      maxResults: ARRIVALS_PER_DIRECTION,
                      // Explicit age-blind opt-out: the server owns
                      // selection→fetch→fuse→stale and renewal, so vehicle
                      // timestamps must not gate derivation. Omission would
                      // take the collapsed-card seam default instead.
                      maxVehicleAgeMs: undefined,
                    });

                    if (derivedTimes.length > 0) {
                      directionMap.set(directionId, {
                        ...dirInfo,
                        arrivals: derivedTimes,
                      });
                    }
                  }
                }
              }
            }

            const dirs = Array.from(directionMap.values()).sort(
              (a, b) => a.directionId - b.directionId,
            );
            if (dirs.length === 0) return null;

            // Keep empty non-terminal rows for the existing route-card
            // loading/empty presentation, but never expose a direction that ends
            // at the anchored stop as a departure row.
            //
            // "Ends here" is settled per trip above, so a direction qualifies
            // only when it has nothing boardable left to show. Where the stored
            // topology ends at the rider's stop while other trips run on past it,
            // those trips are what the rider is waiting for.
            const visibleDirs = dirs.filter(
              (direction) =>
                direction.arrivals.length > 0 ||
                !terminatingDirectionKeys.has(`${direction.directionId}:${direction.stopId}`),
            );
            const withArrivals = visibleDirs.filter((d) => d.arrivals.length > 0);
            const primary =
              withArrivals.length > 0
                ? withArrivals.sort((a, b) => a.distanceMeters - b.distanceMeters)[0]
                : (visibleDirs.sort((a, b) => a.distanceMeters - b.distanceMeters)[0] ??
                  dirs.sort((a, b) => a.distanceMeters - b.distanceMeters)[0]);

            const result: NearbyRouteArrival = {
              id: routeId,
              routeId,
              routeShortName: shortName,
              routeLongName: longName,
              routeType,
              agencyId,
              directionId: primary.directionId,
              headsign: primary.headsign,
              stopId: primary.stopId,
              stopName: primary.stopName,
              stopLat: primary.stopLat,
              stopLon: primary.stopLon,
              distanceMeters: primary.distanceMeters,
              walkingMinutes: primary.walkingMinutes,
              arrivals: primary.arrivals,
              directions: visibleDirs,
              alerts: matchingAlerts,
              routeColor: routeDetails?.color,
              routeTextColor: routeDetails?.textColor,
              arrivalsStale: foldArrivalsStale(
                feedDegraded,
                predictionsStale || predictionsFailed || vehicleLookupFailed,
                snapshotFailed,
              ),
            };

            return result;
          }),
        );

        const results = yield* Effect.all(routeTasks, { concurrency: ROUTE_QUERY_CONCURRENCY });
        const validResults = results.filter((r): r is NearbyRouteArrival => r !== null);
        validResults.sort((a, b) => a.distanceMeters - b.distanceMeters);
        return validResults;
      });

    return NearbyTransit.of({
      getNearbyTransit: (input: NearbyTransitRequest) =>
        Effect.gen(function* () {
          const locale = resolveContentLocale(input.locale, agencyDefaults.locale);
          const radius = clampProximityRadius(input.radius ?? 500);
          const nearbyStops = yield* dataStore.findNearbyStops(input.lat, input.lon, radius);

          if (nearbyStops.length === 0) {
            logger.debug("NearbyTransit: no stops found within radius", {
              agencyId: input.agencyId,
              radius,
            });
            return [];
          }

          const results = yield* assembleRouteArrivals({
            agencyId: input.agencyId,
            locale,
            stopItems: nearbyStops,
            validateStopTopology: true,
          });

          logger.info("NearbyTransit: proximity query complete", {
            agencyId: input.agencyId,
            resultCount: results.length,
          });

          return results;
        }),

      getSavedTransit: (input: SavedTransitRequest) =>
        Effect.gen(function* () {
          const locale = resolveContentLocale(input.locale, agencyDefaults.locale);
          const { favouriteRoutes, lat, lon } = input;
          const routeStops = yield* dataStore.getStopsForRoutes(favouriteRoutes);

          const focus = agencyDefaults.focus;
          const refLat = lat ?? focus.lat;
          const refLon = lon ?? focus.lon;

          const stopsByFavRoute = new Map<string, (typeof routeStops)[number][]>();
          for (const stop of routeStops) {
            for (const r of favouriteRoutes) {
              if (stop.routes.includes(r)) {
                let list = stopsByFavRoute.get(r);
                if (!list) {
                  list = [];
                  stopsByFavRoute.set(r, list);
                }
                list.push(stop);
              }
            }
          }

          const prioritizedRouteStops: (typeof routeStops)[number][] = [];
          for (const [, stops] of stopsByFavRoute) {
            const sorted = [...stops].sort((a, b) => {
              const distA = calculateHaversineMeters(refLat, refLon, a.lat, a.lon);
              const distB = calculateHaversineMeters(refLat, refLon, b.lat, b.lon);
              return distA - distB;
            });
            prioritizedRouteStops.push(...sorted.slice(0, MAX_STOPS_PER_FAVOURITE_ROUTE));
          }

          const seenStopIds = new Set<string>();
          const combinedStops: {
            stop: (typeof routeStops)[number];
            distanceMeters: number;
            walkingMinutes: number;
          }[] = [];

          for (const stop of prioritizedRouteStops) {
            if (!seenStopIds.has(stop.id)) {
              seenStopIds.add(stop.id);
              const distanceMeters =
                lat !== undefined && lon !== undefined
                  ? calculateHaversineMeters(lat, lon, stop.lat, stop.lon)
                  : 0;
              const walkingMinutes = Math.round(distanceMeters / WALKING_METERS_PER_MINUTE);
              combinedStops.push({
                stop,
                distanceMeters,
                walkingMinutes,
              });
            }
          }

          const results = yield* assembleRouteArrivals({
            agencyId: input.agencyId,
            locale,
            stopItems: combinedStops,
            validateStopTopology: false,
          });

          if (favouriteRoutes.length > 0) {
            const favSet = new Set(favouriteRoutes.map((r) => r.trim()));
            return results.filter((r) => favSet.has(r.routeId));
          }

          return results;
        }),

      getRouteTracking: (input: RouteTrackingRequest) =>
        Effect.gen(function* () {
          const locale = resolveContentLocale(input.locale, agencyDefaults.locale);
          const { routeId, directionId } = input;
          const vehiclePositionsOnly =
            agencyDefaults.vehicleOnlyRouteIds?.has(routeId) || undefined;
          const cachedAlertSnapshot = cachedSnapshots.get(locale);
          const alertSnapshotWasCached =
            cachedAlertSnapshot !== undefined && cachedAlertSnapshot.expiresAt > Date.now();
          const requestCache = yield* makeRequestScopedEffectCache();
          const routeRealtimeOptions = (options: RealtimeFetchOptions): RealtimeFetchOptions => {
            const maxSubrequests = agencyDefaults.realtimeMaxSubrequestsWhenAlertsFetch;
            return {
              ...options,
              requestCache,
              ...(!alertSnapshotWasCached && maxSubrequests !== undefined
                ? { maxSubrequests }
                : {}),
            };
          };
          const snapshotCache = yield* Cache.makeWith(
            (requestedLocale: UiLocale) => loadSnapshot(requestedLocale, requestCache),
            {
              capacity: 2,
              timeToLive: (exit) =>
                Exit.isSuccess(exit)
                  ? Duration.millis(AGENCY_SNAPSHOT_CACHE_TTL_MS)
                  : Duration.zero,
            },
          );
          const getSnapshot = Cache.get(snapshotCache, locale);
          const snapshotExit = yield* Effect.exit(getSnapshot);
          const snapshotAlerts = snapshotExit._tag === "Success" ? snapshotExit.value.alerts : [];
          const alerts = matchAlertsForRoute(
            routeId,
            snapshotAlerts,
            agencyDefaults.routeIdNormalization,
          );

          const declaredDirectionIds = yield* readRouteDirectionIds(routeId);
          const requestedIds = [...new Set([...declaredDirectionIds, directionId, 0, 1])];
          const detailOptions = yield* Effect.forEach(
            requestedIds,
            (id) => readRouteDetails(routeId, id),
            { concurrency: "unbounded" },
          );
          const byDir = new Map<number, RouteDetails>();
          for (const [index, id] of requestedIds.entries()) {
            const details = detailOptions[index];
            if (Option.isSome(details)) byDir.set(id, details.value);
          }
          const availableDirectionIds = vehiclePositionsOnly
            ? [0]
            : declaredDirectionIds.length > 0
              ? declaredDirectionIds
              : byDir.size > 0
                ? [...byDir.keys()]
                : [directionId];
          const detailsOpt = Option.fromUndefinedOr(byDir.get(directionId));

          let directionLabels: Record<
            number,
            {
              label: string;
              destination: string;
              generatedLabel?: NearbyDirectionInfo["generatedLabel"];
            }
          > = {};
          if (Option.isSome(detailsOpt)) {
            const details = detailsOpt.value;
            directionLabels = resolveDirectionLabels(byDir, details.route.shortName);

            // A per-stop vendor (AnyRide) locates vehicles through the stops it
            // is asked about, and the realtime source holds no topology of its
            // own, so name the route's stops here. Feeds that read a whole-network
            // document ignore the stop scope.
            const routeStopIds = new Set(
              [...byDir.values()].flatMap((direction) => direction.stops.map((stop) => stop.id)),
            );
            const stopScopedSnapshot = realtimeRepo.getRealtimeSnapshot(input.agencyId, {
              ...routeRealtimeOptions({
                vehiclesOnly: true,
                routeIds: new Set([routeId]),
                stopIdsByRoute: new Map([[routeId, routeStopIds]]),
              }),
            });
            const { vehicles, vehiclePositionsFreshness } = yield* getRouteVehicleState(
              realtimeRepo,
              {
                agencyId: input.agencyId,
                routeId,
                directionId,
                snapshot: stopScopedSnapshot,
              },
              vehiclePositionsOnly,
            );

            const trackingData: RouteTrackingData = {
              ...(vehiclePositionsOnly ? { vehiclePositionsOnly, vehiclePositionsFreshness } : {}),
              route: details.route,
              shape: details.shape,
              stops: details.stops,
              vehicles,
              alerts,
              directionLabels,
              availableDirectionIds,
            };

            return Option.some(trackingData);
          }

          const routeOpt = yield* readRoute(routeId);
          if (Option.isNone(routeOpt)) {
            return Option.none();
          }

          const route = routeOpt.value;
          const otherDirectionId = directionId === 0 ? 1 : 0;
          const otherDetailsOpt = Option.fromUndefinedOr(byDir.get(otherDirectionId));

          if (Option.isSome(otherDetailsOpt)) {
            const other = otherDetailsOpt.value;
            directionLabels = resolveDirectionLabels(byDir, route.shortName);

            const reversedStops = [...other.stops].reverse();
            const decodedPoints = decodePolyline(other.shape.polyline);
            const invertedPolyline =
              decodedPoints.length > 1
                ? encodePolyline([...decodedPoints].reverse())
                : other.shape.polyline;

            const fallbackShape = {
              id: `${routeId}_${directionId}_inverted`,
              routeId,
              directionId,
              headsign:
                directionLabels[directionId]?.destination ||
                inferRouteHeadsign(directionId, route.routeType),
              polyline: invertedPolyline,
              minLat: other.shape.minLat,
              maxLat: other.shape.maxLat,
              minLon: other.shape.minLon,
              maxLon: other.shape.maxLon,
              pointCount: other.shape.pointCount,
            };
            const routeStopIds = new Set(reversedStops.map((stop) => stop.id));
            const stopScopedSnapshot = realtimeRepo.getRealtimeSnapshot(input.agencyId, {
              ...routeRealtimeOptions({
                vehiclesOnly: true,
                routeIds: new Set([routeId]),
                stopIdsByRoute: new Map([[routeId, routeStopIds]]),
              }),
            });
            const { vehicles, vehiclePositionsFreshness } = yield* getRouteVehicleState(
              realtimeRepo,
              {
                agencyId: input.agencyId,
                routeId,
                directionId,
                snapshot: stopScopedSnapshot,
              },
              vehiclePositionsOnly,
            );
            return Option.some({
              route,
              ...(vehiclePositionsOnly ? { vehiclePositionsOnly, vehiclePositionsFreshness } : {}),
              shape: fallbackShape,
              stops: reversedStops,
              vehicles,
              alerts,
              directionLabels,
              availableDirectionIds,
            });
          }

          const rawStops = yield* dataStore.getStopsForRoutes([routeId]);
          const stops = orderStopsAlongCorridor(rawStops, directionId);
          const routeStopIds = new Set(stops.map((stop) => stop.id));
          const stopScopedSnapshot = realtimeRepo.getRealtimeSnapshot(input.agencyId, {
            ...routeRealtimeOptions({
              vehiclesOnly: true,
              routeIds: new Set([routeId]),
              stopIdsByRoute: new Map([[routeId, routeStopIds]]),
            }),
          });
          const { vehicles, vehiclePositionsFreshness } = yield* getRouteVehicleState(
            realtimeRepo,
            {
              agencyId: input.agencyId,
              routeId,
              directionId,
              snapshot: stopScopedSnapshot,
            },
            vehiclePositionsOnly,
          );
          const pointsFromStops: [number, number][] = stops.map((s) => [s.lat, s.lon]);
          const generatedPolyline =
            pointsFromStops.length > 1 ? encodePolyline(pointsFromStops) : "";

          const fallbackBounds = agencyDefaults.fallbackBounds;
          const fallbackShape = {
            id: `${routeId}_${directionId}_fallback`,
            routeId,
            directionId,
            headsign: vehiclePositionsOnly ? "" : inferRouteHeadsign(directionId, route.routeType),
            polyline: generatedPolyline,
            minLat: fallbackBounds.minLat,
            maxLat: fallbackBounds.maxLat,
            minLon: fallbackBounds.minLon,
            maxLon: fallbackBounds.maxLon,
            pointCount: stops.length,
          };

          return Option.some({
            route,
            ...(vehiclePositionsOnly ? { vehiclePositionsOnly, vehiclePositionsFreshness } : {}),
            shape: fallbackShape,
            stops,
            vehicles,
            alerts,
            directionLabels,
            availableDirectionIds,
          });
        }),
    });
  }),
);
