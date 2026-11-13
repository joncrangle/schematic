import * as Option from "effect/Option";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { getAgencyById } from "~/agencies";
import type { AgencySnapshot } from "~/agencies/types";
import { manifestFallbackBounds, manifestFocus } from "~/domain/location/EffectiveAgency";
import { normalizeLocale } from "~/domain/locale";
import type { RealtimeSource } from "~/domain/surface/realtimeSource";
import { getFeedSecret } from "~/infrastructure/env/ServerEnv";
import { detectHostingTarget } from "~/infrastructure/env/hostingTarget";
import { TMIX_MAX_SUBREQUESTS } from "~/infrastructure/realtime/tmix/tmixRealtimeSource";
import { SurfaceDataStore } from "~/infrastructure/storage/SurfaceDataStore";
import { makeSurfaceDataStoreLayer } from "~/infrastructure/storage/d1SurfaceDataStore";
import { createServerAgencyRuntime } from "~/services/AgencyRuntimeServer";
import { getAlertIdentityLookups } from "~/services/AlertIdentityServer";
import { selectStationTripLookups } from "~/services/stationTripLookups";
import { memoizedLayerContext } from "~/services/memoizedLayerContext";
import {
  NearbyTransit,
  NearbyTransitLive,
  NearbySnapshotSource,
  SurfaceAgencyDefaults,
  createRealtimeCacheLayer,
} from "./NearbyTransit";

/**
 * Single per-agency Surface Transit composition.
 *
 * One composition owner of the request-path stack: the store layer is built
 * once per agency and that exact instance is both fed to NearbyTransitLive
 * and retained under the SurfaceDataStore tag, so route-metadata reads and
 * arrival assembly share one warm topology cache instead of two
 * store+cache instances. AgencyId stays plain request data validated at this
 * seam; per-agency isolation, single-flight, and evict-on-failure come from
 * the shared memoizedLayerContext getter below.
 *
 * Cache policy stays hidden: TTL/capacities/normalization live in the
 * storage adapter's topology cache, never surfaced here, no public
 * invalidate/clear/prime/stats/TTL/capacity/disposal seam.
 */

export type SurfaceTransitServices = NearbyTransit | SurfaceDataStore;
export type SurfaceTransitContext = Context.Context<SurfaceTransitServices>;
export type GetSurfaceTransitContext = (agencyId: string) => Promise<SurfaceTransitContext>;

export interface SurfaceTransitLayerOptions {
  readonly storeLayer?: Layer.Layer<SurfaceDataStore>;
  readonly realtimeByAgencyId?: ReadonlyMap<string, RealtimeSource>;
  readonly snapshot?: Effect.Effect<AgencySnapshot, unknown>;
}

/**
 * Agency-scoped Surface Transit stack. The caller resolves agencyId; operational
 * defaults derive once here from manifest, and the data store elects agency D1.
 */
export function makeLiveSurfaceTransitLayer(
  agencyId: string,
  opts?: SurfaceTransitLayerOptions,
): Layer.Layer<SurfaceTransitServices, unknown> {
  const provider = getAgencyById(agencyId);
  if (!provider) {
    throw new Error(`SurfaceTransit: unknown agency "${agencyId}"`);
  }
  const manifest = provider.manifest;
  const hostingTarget = detectHostingTarget();
  const alertStops = (provider.alerts ?? []).reduce((total, source) => {
    if (
      source.type !== "anyride-messages" ||
      source.relay !== undefined ||
      source.enabled === false ||
      (source.runtimes && !source.runtimes.includes(hostingTarget)) ||
      (source.baseUrlSecretName && !getFeedSecret(source.baseUrlSecretName))
    ) {
      return total;
    }
    // Reserve the actual declared polls. A duplicate stop can be retried after
    // a failed/noncacheable response, so uniqueness does not bound POSTs.
    return total + (source.stops?.length ?? 0);
  }, 0);
  const realtimeMaxSubrequestsWhenAlertsFetch =
    alertStops > 0 ? Math.max(0, TMIX_MAX_SUBREQUESTS - alertStops) : undefined;
  const runtime = createServerAgencyRuntime(provider);

  const agencyDefaultsLayer = Layer.succeed(SurfaceAgencyDefaults, {
    agencyId: manifest.id,
    locale: normalizeLocale(manifest.locale),
    focus: manifestFocus(manifest),
    fallbackBounds: manifestFallbackBounds(manifest),
    vehicleOnlyRouteIds: new Set(
      provider.staticTopology.vehicleOnlyRoutes?.map((route) => route.id),
    ),
    routeIdNormalization: manifest.alertInterpretation?.routeIdNormalization,
    ...(realtimeMaxSubrequestsWhenAlertsFetch === undefined
      ? {}
      : { realtimeMaxSubrequestsWhenAlertsFetch }),
  });

  const repositoryLayer = Layer.unwrap(
    Effect.gen(function* () {
      const store = yield* SurfaceDataStore;
      const identities = getAlertIdentityLookups(manifest.id);
      const realtimeMap =
        opts?.realtimeByAgencyId ??
        new Map<string, RealtimeSource>([
          [
            manifest.id,
            createServerAgencyRuntime(provider, {
              fetch: ((...args: Parameters<typeof fetch>) =>
                globalThis.fetch(...args)) as typeof fetch,
              // Static trips avoid D1's agency-wide trip expansion when the deployment carries them.
              getRoutesForTrips:
                identities.hasTripIdentities || store.getRoutesForTrips
                  ? selectStationTripLookups(manifest.id, identities, Effect.succeed(store))
                      .getRoutesForTrips
                  : undefined,
            }).getRealtimeSource(),
          ],
        ]);
      return createRealtimeCacheLayer(
        {},
        {
          realtimeByAgencyId: realtimeMap,
          getTopologyForAgency: (agencyId, options) =>
            Effect.gen(function* () {
              const allRoutes = yield* store.getAllRoutes();
              const selected = allRoutes.filter(
                (route) => !options?.routeIds?.size || options.routeIds.has(route.id),
              );
              const groups = yield* Effect.forEach(
                selected,
                (route) =>
                  Effect.gen(function* () {
                    const directions = yield* store.getRouteDirectionIds(route.id);
                    const details = yield* Effect.forEach(
                      directions,
                      (direction) => store.getRouteDetails(route.id, direction),
                      { concurrency: 2 },
                    );
                    const found = details.flatMap((detail) =>
                      Option.isSome(detail) ? [detail.value] : [],
                    );
                    const base = {
                      routeId: route.id,
                      shortName: route.shortName,
                      longName: route.longName,
                      color: route.color,
                      textColor: route.textColor,
                      routeType: route.routeType,
                    };
                    return found.length
                      ? found.map((detail) => ({
                          ...base,
                          directionId: detail.shape.directionId,
                          headsign: detail.shape.headsign,
                          polyline: detail.shape.polyline,
                          stops: detail.stops,
                        }))
                      : [{ ...base, directionId: 0, headsign: "", polyline: "", stops: [] }];
                  }),
                { concurrency: 2 },
              );
              return { agencyId, generatedAt: Date.now(), routes: groups.flat() };
            }),
        },
      );
    }),
  );

  const snapshotSourceLayer = Layer.succeed(
    NearbySnapshotSource,
    NearbySnapshotSource.of({
      getSnapshot: (locale, requestCache) =>
        opts?.snapshot ??
        Effect.tryPromise({
          try: () => {
            return runtime.getSnapshot(locale, requestCache);
          },
          catch: (cause) => cause,
        }),
    }),
  );

  const storeLayer = opts?.storeLayer ?? makeSurfaceDataStoreLayer(manifest.id);
  const transitLayer = NearbyTransitLive.pipe(
    Layer.provide(repositoryLayer),
    Layer.provide(snapshotSourceLayer),
    Layer.provide(agencyDefaultsLayer),
  );
  // provideMerge feeds the same storeLayer instance to NearbyTransitLive and
  // retains it under SurfaceDataStore, so both tags resolve to one store
  // (Effect memoizes the shared instance to a single build).
  return Layer.provideMerge(transitLayer, storeLayer);
}

/** Per-agency singleton Surface Transit context. */
export const getSurfaceTransitContext: GetSurfaceTransitContext = memoizedLayerContext(
  makeLiveSurfaceTransitLayer,
);
