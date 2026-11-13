import {
  createVersionedAssetCache,
  type VersionedAssetCache,
} from "../staticAssets/versionedAssetCache";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  SourceAgencyScopeLookup,
  TripDirectionLookup,
  TripRoute,
  TripRouteLookup,
} from "~/domain/surface/boarding";
import {
  AlertIdentityCatalogSchema,
  ScopeArtifactSchema,
  TripArtifactSchema,
  alertIdentityAssetPath,
  alertTripBucket,
} from "./alertIdentityArtifacts";

export class AlertIdentityUnavailable extends Data.TaggedError("AlertIdentityUnavailable")<{
  readonly agencyId: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}
export interface AlertIdentityLookups {
  readonly identityGeneration: string;
  readonly getSourceAgencyScope: SourceAgencyScopeLookup;
  readonly getRoutesForTrips: TripRouteLookup;
  /** Whether the deployment carries trip shards; otherwise trip lookups always fail. */
  readonly hasTripIdentities: boolean;
  /** Same trip index as {@link getRoutesForTrips}, narrowed to one route's direction groups. */
  readonly getDirectionsForTrips: TripDirectionLookup;
}
/** Static, content-verified identity lookups with bounded shared caching and no database fallback. */
export function createStaticAlertIdentityResolver(options: {
  readonly catalog: unknown;
  readonly readAsset: (path: string, signal: AbortSignal) => Promise<Response>;
  readonly now?: () => number;
  readonly cache?: VersionedAssetCache;
}): (agencyId: string) => AlertIdentityLookups {
  const catalog = Schema.decodeUnknownSync(AlertIdentityCatalogSchema)(options.catalog);
  const { load } = options.cache ?? createVersionedAssetCache(options);
  return (agencyId) => {
    const unavailable = (cause: unknown) =>
      new AlertIdentityUnavailable({
        agencyId,
        message: "Static alert identities unavailable",
        cause,
      });
    const agency = () => {
      if (!Object.hasOwn(catalog.agencies, agencyId))
        throw new Error("No alert identity generation for agency");
      return catalog.agencies[agencyId]!;
    };
    const getRoutesForTrips: TripRouteLookup = (ids) => lookupTrips(ids);
    return {
      hasTripIdentities: Object.hasOwn(catalog.agencies, agencyId) && !!agency().trips,
      getDirectionsForTrips: (routeId, ids) =>
        getRoutesForTrips(ids).pipe(
          Effect.map((trips) => {
            const directions = new Map<string, number>();
            for (const [tripId, trip] of trips)
              if (trip.routeId === routeId) directions.set(tripId, trip.directionId);
            return directions;
          }),
        ),
      identityGeneration: Object.hasOwn(catalog.agencies, agencyId)
        ? catalog.agencies[agencyId]!.generation
        : "missing",
      getSourceAgencyScope: () =>
        Effect.tryPromise({
          try: async () => {
            const ref = agency().scope;
            if (!ref) throw new Error("Missing scope artifact");
            return load(alertIdentityAssetPath(agencyId, "scope", ref.hash), ref, (value) => {
              const data = Schema.decodeUnknownSync(ScopeArtifactSchema)(value);
              if (data.agencyId !== agencyId || !data.routes.length)
                throw new Error("Invalid alert identity scope");
              const routesByShortName = new Map<string, string[]>(),
                stopsByCode = new Map<string, string[]>();
              for (const [id, name] of data.routes) {
                const ids = routesByShortName.get(name) ?? [];
                if (!ids.includes(id)) ids.push(id);
                routesByShortName.set(name, ids);
              }
              for (const [id, code] of data.stops) {
                if (!code) continue;
                const ids = stopsByCode.get(code) ?? [];
                if (!ids.includes(id)) ids.push(id);
                stopsByCode.set(code, ids);
              }
              return {
                routeIds: new Set(data.routes.map(([id]) => id)),
                stopIds: new Set(data.stops.map(([id]) => id)),
                routesByShortName,
                stopsByCode,
                directionsByRoute: new Map(
                  data.directions.map(([route, word, direction]) => [
                    `${route}|${word}`,
                    direction,
                  ]),
                ),
              };
            });
          },
          catch: unavailable,
        }),
      getRoutesForTrips,
    };
    function lookupTrips(ids: readonly string[]) {
      return Effect.gen(function* () {
        const result = new Map<string, TripRoute>();
        if (!ids.length) return result;
        const buckets = new Set(ids.map(alertTripBucket));
        const shards = yield* Effect.forEach(
          [...buckets],
          (bucket) =>
            Effect.tryPromise({
              try: async () => {
                const refs = agency().trips;
                if (!refs) throw new Error("Missing trip artifacts");
                const ref = refs[String(bucket)];
                if (!ref) return new Map<string, TripRoute>();
                return load(alertIdentityAssetPath(agencyId, bucket, ref.hash), ref, (value) => {
                  const data = Schema.decodeUnknownSync(TripArtifactSchema)(value);
                  if (data.agencyId !== agencyId || data.bucket !== bucket)
                    throw new Error("Invalid trip artifact scope");
                  const trips = new Map<string, TripRoute>();
                  for (const [routeId, directionId, tripIds] of data.groups)
                    for (const tripId of tripIds) {
                      if (alertTripBucket(tripId) !== bucket)
                        throw new Error("Invalid trip artifact partition");
                      const old = trips.get(tripId);
                      if (old && (old.routeId !== routeId || old.directionId !== directionId))
                        throw new Error("Ambiguous trip identity");
                      trips.set(tripId, { routeId, directionId });
                    }
                  return trips;
                });
              },
              catch: unavailable,
            }),
          { concurrency: 4 },
        );
        const byBucket = new Map([...buckets].map((bucket, index) => [bucket, shards[index]!]));
        for (const id of ids) {
          const trip = byBucket.get(alertTripBucket(id))?.get(id);
          if (trip) result.set(id, trip);
        }
        return result;
      });
    }
  };
}
