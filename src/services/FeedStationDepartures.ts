import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { AgencyProvider } from "~/agencies";
import { StationsError } from "~/domain/surface/stationsSource";
import { selectStationTripLookups } from "~/services/stationTripLookups";
import type { NearbyStationArrival } from "~/domain/surface/types";
import type { AlertIdentityLookups } from "~/infrastructure/alerts/staticAlertIdentities";
import type { SurfaceDataStoreService } from "~/infrastructure/storage/SurfaceDataStore";

export interface FeedStationDeparturesInput {
  readonly agencyId: string;
  readonly stationId: string;
  readonly stationName: string;
  readonly stopIds: readonly string[];
}

/** Seeded boarding stops supply departures without inventing a map station. */
export function fetchFeedStationDepartures(
  input: FeedStationDeparturesInput,
  dependencies: {
    readonly provider: AgencyProvider;
    readonly store: SurfaceDataStoreService;
    /** Deployed trip index; trips it lacks, or all when it is absent, resolve in D1. */
    readonly identities: Pick<AlertIdentityLookups, "hasTripIdentities" | "getRoutesForTrips">;
    readonly fetch: typeof fetch;
    readonly now?: () => number;
    readonly getSecret?: (name: string) => string | undefined;
    readonly devProxyOrigin?: string;
  },
): Effect.Effect<readonly NearbyStationArrival[], StationsError> {
  const { provider, store } = dependencies;
  const tripLookups = selectStationTripLookups(
    input.agencyId,
    dependencies.identities,
    Effect.succeed(store),
  );
  return Effect.gen(function* () {
    const stops = yield* store.getStopsByIds(input.stopIds);
    if (stops.length !== new Set(input.stopIds).size) {
      return yield* Effect.fail(
        new StationsError({
          agencyId: input.agencyId,
          message: "Interchange boarding stops are missing from seeded topology",
        }),
      );
    }
    const routeIds = [...new Set(stops.flatMap((stop) => stop.routes))];
    const routeResults = yield* Effect.all(routeIds.map((id) => store.getRoute(id)));
    if (routeResults.some(Option.isNone)) {
      return yield* Effect.fail(
        new StationsError({
          agencyId: input.agencyId,
          message: "Interchange routes are missing from seeded topology",
        }),
      );
    }
    const routes = routeResults.flatMap((result) => (Option.isSome(result) ? [result.value] : []));
    const { createGenericStationsSource } = yield* Effect.tryPromise(
      () => import("~/infrastructure/realtime/genericStationsSource"),
    );
    const routeTypes = [...new Set(routes.map((route) => route.routeType))];
    const cards = yield* Effect.all(
      routeTypes.map((routeType) => {
        const modeRoutes = routes.filter((route) => route.routeType === routeType);
        const lineIdFor = (routeId: string) => {
          const stripped = routeId.slice(routeId.lastIndexOf("-") + 1);
          return (
            provider.manifest.alertInterpretation?.routeLineMap?.[routeId] ??
            provider.manifest.alertInterpretation?.routeLineMap?.[stripped] ??
            stripped
          );
        };
        const lines = modeRoutes.map((route) => lineIdFor(route.id));
        const source = createGenericStationsSource({
          agencyId: input.agencyId,
          stations: [
            {
              id: input.stationId,
              name: input.stationName,
              lat: stops[0]!.lat,
              lon: stops[0]!.lon,
              lines,
              platformIds: stops.map((stop) => stop.id),
            },
          ],
          feeds: provider.realtime?.feeds ?? [],
          fetch: dependencies.fetch,
          now: dependencies.now,
          getSecret: dependencies.getSecret,
          devProxyOrigin: dependencies.devProxyOrigin,
          routeType,
          splitByLine: true,
          lineMetadata: modeRoutes.map((route) => ({
            id: lineIdFor(route.id),
            name: route.longName,
            color: route.color,
          })),
          directionLiterals: provider.manifest.directionLiterals,
          routeInterpretation: provider.manifest.routeInterpretation,
          routeLineMap: provider.manifest.alertInterpretation?.routeLineMap,
          staticRouteIdField: provider.staticTopology.routeIdField,
          ...tripLookups,
        });
        return source.fetchByIds({ stationIds: [input.stationId] });
      }),
    );
    return cards.flat();
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof StationsError
        ? cause
        : new StationsError({
            agencyId: input.agencyId,
            message: "Interchange departure topology unavailable",
            cause,
          }),
    ),
  );
}
