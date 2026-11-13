import "server-only";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { NearbyRouteArrival, RouteTrackingData } from "~/domain/surface/types";
import type { NearbyRpcInput } from "~/services/nearby/rpcInput";
import { NearbyTransit } from "./NearbyTransit";
import { SurfaceDataStore } from "~/infrastructure/storage/SurfaceDataStore";
import { getSurfaceTransitContext, type GetSurfaceTransitContext } from "./SurfaceTransit";
import { runRpc } from "~/services/runRpc";
import type {
  ParsedRouteTrackingInput,
  ParsedRoutesMetadataInput,
  ParsedSavedTransitInput,
  RouteMeta,
} from "./SurfaceClient";

// ---------------------------------------------------------------------------
// Server-only surface RPC implementations.
//
// Handler delegates beneath the "use server" wrappers in SurfaceClient, all
// routed through the shared runRpc runtime. This module is
// server-only (secret-touching Effect layers via SurfaceTransit); the shared
// SurfaceClient module keeps only validators, types, and the wrapper stubs
// whose bodies call in here.
//
// Delegates never catch on behalf of the client. A downstream failure
// rejects so TanStack Query surfaces real errors.
// The context getter is injectable purely for unit tests (keyed by the
// request's agencyId); production callers use the default per-agency shared
// Surface Transit context, which serves both NearbyTransit and
// SurfaceDataStore from one store instance.
// ---------------------------------------------------------------------------

export async function handleFetchNearbyTransit(
  data: NearbyRpcInput,
  getContext: GetSurfaceTransitContext = getSurfaceTransitContext,
): Promise<readonly NearbyRouteArrival[]> {
  return runRpc({ label: "fetchNearbyTransit", getContext: () => getContext(data.agencyId) }, () =>
    Effect.gen(function* () {
      const service = yield* NearbyTransit;
      return yield* service.getNearbyTransit(data);
    }),
  );
}

export async function handleFetchSavedTransit(
  data: ParsedSavedTransitInput,
  getContext: GetSurfaceTransitContext = getSurfaceTransitContext,
): Promise<readonly NearbyRouteArrival[]> {
  return runRpc({ label: "fetchSavedTransit", getContext: () => getContext(data.agencyId) }, () =>
    Effect.gen(function* () {
      const service = yield* NearbyTransit;
      return yield* service.getSavedTransit(data);
    }),
  );
}

export async function handleFetchRouteTracking(
  data: ParsedRouteTrackingInput,
  getContext: GetSurfaceTransitContext = getSurfaceTransitContext,
): Promise<RouteTrackingData | null> {
  return runRpc({ label: "fetchRouteTracking", getContext: () => getContext(data.agencyId) }, () =>
    Effect.gen(function* () {
      const service = yield* NearbyTransit;
      const opt = yield* service.getRouteTracking(data);
      // A resolved Option.none() (unknown route id) is a legitimate empty
      // result, not a failure, it stays a null payload.
      return Option.getOrNull(opt);
    }),
  );
}

export async function handleFetchRoutesMetadata(
  data: ParsedRoutesMetadataInput,
  getContext: GetSurfaceTransitContext = getSurfaceTransitContext,
): Promise<readonly RouteMeta[]> {
  return runRpc({ label: "fetchRoutesMetadata", getContext: () => getContext(data.agencyId) }, () =>
    Effect.gen(function* () {
      const store = yield* SurfaceDataStore;
      const routes: RouteMeta[] = [];
      for (const routeId of data.routeIds) {
        // Route metadata is a read-only app request served from existing
        // topology; the canonical read never fetches or persists,
        // so this endpoint cannot turn into a live topology write.
        // Topology repair belongs to the explicit crawl seam.
        const opt = yield* store.getRoute(routeId);
        if (Option.isSome(opt)) {
          routes.push({
            id: opt.value.id,
            shortName: opt.value.shortName,
            longName: opt.value.longName,
            routeType: opt.value.routeType,
          });
        }
      }
      return routes;
    }),
  );
}

export async function handleFetchAllRoutesCatalog(
  data: { readonly agencyId: string },
  getContext: GetSurfaceTransitContext = getSurfaceTransitContext,
): Promise<readonly RouteMeta[]> {
  return runRpc(
    { label: "fetchAllRoutesCatalog", getContext: () => getContext(data.agencyId) },
    () =>
      Effect.gen(function* () {
        const store = yield* SurfaceDataStore;
        const routes = yield* store.getAllRoutes();
        return routes
          .filter((r) => r.routeType !== "subway")
          .map((r) => ({
            id: r.id,
            shortName: r.shortName,
            longName: r.longName,
            routeType: r.routeType,
          }));
      }),
  );
}
