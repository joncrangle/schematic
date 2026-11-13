import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  type D1DatabaseBinding,
  resolveRuntimeBinding,
  TRANSIT_BINDING_NAME,
} from "~/infrastructure/storage/RuntimeBindings";
import { getAgencyById } from "~/agencies";
import { accountRequestQueries } from "./requestQueryBudget";
import { makeD1Reads } from "./surfaceStore/reads";
import { makeSurfaceStoreKernel } from "./surfaceStore/readPolicy";
import {
  createSurfaceTopologyReadCache,
  type SurfaceTopologyReadCapabilities,
} from "./surfaceStore/topologyCache";
import type { SchematicStationIndexEntry } from "~/agencies/types";
import type { RouteInterpretationConfig } from "~/agencies/types";
import { SurfaceDataStore, type SurfaceDataStoreService } from "./SurfaceDataStore";

export interface D1SurfaceDataStoreOptions {
  readonly agencyId?: string;
  readonly stationIndex?: readonly SchematicStationIndexEntry[];
  readonly routeInterpretation?: RouteInterpretationConfig;
}

/**
 * Builds the SQL-backed SurfaceDataStore service over the surface store
 * seam. Reads run through the shared D1 read path
 * (`surfaceStore/reads`) and the shared read policy
 * (`surfaceStore/readPolicy`).
 *
 * Reads are charged to the active HTTP request's query budget.
 *
 * Read-only contract: every read serves existing topology and never
 * fetches, revalidates, or persists. A cache miss is a legitimate
 * Option.none / empty result, never a live fetch. Topology mutation is
 * explicit-only via the crawl/topology-source seam (`surfaceStore/crawl`,
 * `surfaceStore/topology`), sequenced by SurfaceTopologyRefresh; normal
 * request traffic never persists topology.
 *
 * Schema bootstrap is lazy and shared with the write paths: the CREATE TABLE
 * batch fires on the first operation against `db`, never at import or
 * layer-construction time.
 *
 * Failure semantics: database failures propagate through the error
 * channel, they are never collapsed into empty results. A missing
 * row is still a legitimate Option.none / empty array; an unreachable
 * database is an error.
 */
export function makeD1SurfaceDataStoreService(
  db: D1DatabaseBinding,
  opts?: D1SurfaceDataStoreOptions,
): SurfaceDataStoreService {
  const reads = makeD1Reads(accountRequestQueries(db), {
    agencyId: opts?.agencyId,
    stationIndex: opts?.stationIndex,
    routeInterpretation: opts?.routeInterpretation,
  });

  // Keep the cache below the read-policy kernel. The kernel is a pure read
  // fan-out, so the static read itself is served from memory on a warm
  // Worker while the underlying store remains the source of truth.
  const topologyReadSource: SurfaceTopologyReadCapabilities = {
    readNearbyCandidates: reads.readNearbyCandidates,
    readRouteDirectionIds: reads.readRouteDirectionIds,
    readTripTerminals: reads.readTripTerminals,
    readDirectionsForTrips: reads.readDirectionsForTrips,
    readCachedRouteDetails: reads.readCachedRouteDetails,
    readRouteRow: reads.readRouteRow,
    readAllRouteRows: reads.readAllRouteRows,
    readStopsForRoutes: reads.readStopsForRoutes,
    readStopsByIds: reads.readStopsByIds,
  };
  const topologyCache = createSurfaceTopologyReadCache(topologyReadSource);

  const kernel = makeSurfaceStoreKernel({
    ...topologyCache.readers,
  });

  return SurfaceDataStore.of({
    getRoutesForTrips: reads.readRoutesForTrips,
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
 * Creates a SurfaceDataStore layer backed by Cloudflare D1 / SQLite SQL persistence.
 * Explicit construction only, tests and the agency-scoped live factory below;
 * production code elects its binding through {@link makeSurfaceDataStoreLayer}.
 */
export function createD1SurfaceDataStore(
  db: D1DatabaseBinding,
  opts?: D1SurfaceDataStoreOptions,
): Layer.Layer<SurfaceDataStore> {
  return Layer.succeed(SurfaceDataStore, makeD1SurfaceDataStoreService(db, opts));
}

/**
 * Agency-scoped production SQL-backed SurfaceDataStore layer: replaces
 * the hardwired TTC singleton. The CALLER resolves the agency (AppShell /
 * composition root via resolveAgencySelection over getAgenciesForPoint); the
 * binding election then runs through the shared DB_TRANSIT binding (ADR-0009).
 *
 * The binding election happens lazily INSIDE the layer build (first
 * `Layer.build` / first program that provides it), never at module load, so
 * static layer compositions stay alive. A refused or failed election rejects
 * the build loudly (cached-context callers log via logger.error) and, because
 * the seam evicts failed elections, the next attempt retries the ladder.
 */
export function makeSurfaceDataStoreLayer(
  agencyId: string,
  opts?: Omit<D1SurfaceDataStoreOptions, "agencyId">,
): Layer.Layer<SurfaceDataStore> {
  return Layer.effect(
    SurfaceDataStore,
    Effect.gen(function* () {
      const provider = getAgencyById(agencyId);
      if (!provider) {
        throw new Error(`Unknown agency "${agencyId}"`);
      }
      const db = yield* Effect.promise(() => resolveRuntimeBinding(TRANSIT_BINDING_NAME));
      return makeD1SurfaceDataStoreService(db, {
        agencyId,
        ...opts,
        stationIndex: opts?.stationIndex ?? provider.schematic?.stationIndex,
        routeInterpretation: opts?.routeInterpretation ?? provider.manifest.routeInterpretation,
      });
    }),
  );
}
