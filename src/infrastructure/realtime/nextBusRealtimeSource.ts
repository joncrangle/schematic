import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { RealtimeFeedConfig } from "~/agencies/types";
import type { RouteInterpretationConfig } from "~/agencies/types";
import type { StaticSnapshot } from "~/domain/surface/topologySource";
import type { ArrivalPrediction, LiveVehiclePosition } from "~/domain/surface/types";
import type { RealtimeFetchOptions } from "~/domain/surface/realtimeSource";
import { parseNextBusPredictions, parseNextBusVehicles } from "~/domain/nextbus/parseRealtime";
import { fetchDecodedFeeds } from "./fetchDecodedFeeds";

const NEXTBUS_QUERY_CONCURRENCY = 8;

export interface NextBusRealtimeSnapshot {
  readonly arrivals: readonly ArrivalPrediction[];
  readonly vehicles: readonly LiveVehiclePosition[];
  readonly arrivalsAvailable: boolean;
  readonly vehiclesAvailable: boolean;
}

export interface NextBusRealtimeOptions {
  readonly agencyId: string;
  readonly feeds: readonly RealtimeFeedConfig[];
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly getSecret?: (name: string) => string | undefined;
  readonly devProxyOrigin?: string;
  readonly routeInterpretation?: RouteInterpretationConfig;
  readonly topology: StaticSnapshot;
  readonly fetchOptions?: RealtimeFetchOptions;
  readonly includeArrivals: boolean;
  readonly includeVehicles: boolean;
}

type NextBusJsonRequestResult<T> = {
  readonly usable: readonly T[];
  readonly firstError?: Error;
};

function nextBusUrl(
  baseUrl: string,
  command: string,
  params: Readonly<Record<string, string>>,
): string {
  const url = new URL(baseUrl);
  url.searchParams.set("command", command);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function fetchNextBusJson<T>(
  feeds: readonly RealtimeFeedConfig[],
  command: string,
  params: Readonly<Record<string, string>>,
  decode: (payload: unknown) => T,
  options: Pick<NextBusRealtimeOptions, "fetch" | "getSecret" | "devProxyOrigin">,
): Effect.Effect<NextBusJsonRequestResult<T>, never> {
  return fetchDecodedFeeds(
    feeds.map((feed) => ({
      url: nextBusUrl(feed.url, command, params),
      auth: feed.auth,
      devProxyPrefix: feed.devProxyPrefix,
      format: feed.format,
      decode: (bytes: Uint8Array) =>
        Effect.try({
          try: () => decode(JSON.parse(new TextDecoder().decode(bytes)) as unknown),
          catch: (cause) => cause,
        }),
      mapError: (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
    })),
    {
      fetch: options.fetch,
      getSecret: options.getSecret,
      devProxyOrigin: options.devProxyOrigin,
    },
  );
}

function routeIdsFor(
  topology: StaticSnapshot,
  options: RealtimeFetchOptions | undefined,
): readonly string[] {
  const requested = options?.routeIds;
  const ids = new Set<string>();
  for (const route of topology.routes) {
    if (!requested || requested.has(route.routeId)) ids.add(route.routeId);
  }
  for (const routeId of requested ?? []) ids.add(routeId);
  return [...ids];
}

function routeStopsFor(
  topology: StaticSnapshot,
  routeId: string,
  requestedStopIds: ReadonlySet<string>,
  stopIdsByRoute: ReadonlyMap<string, ReadonlySet<string>> | undefined,
): readonly string[] {
  const routeScopedStopIds = stopIdsByRoute?.get(routeId);
  if (routeScopedStopIds) {
    return [...routeScopedStopIds].filter((stopId) => requestedStopIds.has(stopId));
  }

  const ids = new Set<string>();
  for (const route of topology.routes) {
    if (route.routeId !== routeId) continue;
    for (const stop of route.stops) {
      if (requestedStopIds.has(stop.id)) ids.add(stop.id);
    }
  }
  return [...ids];
}

/** Fetches a provider-declared NextBus realtime source without naming an agency. */
export function fetchNextBusRealtime(
  options: NextBusRealtimeOptions,
): Effect.Effect<NextBusRealtimeSnapshot, Error> {
  const nextBusFeeds = options.feeds.filter((feed) => feed.kind === "nextbus");
  const routeIds = routeIdsFor(options.topology, options.fetchOptions);
  const requestedStopIds = options.fetchOptions?.stopIds;

  const arrivalQueries =
    options.includeArrivals && requestedStopIds && requestedStopIds.size > 0
      ? routeIds.flatMap((routeId) =>
          routeStopsFor(
            options.topology,
            routeId,
            requestedStopIds,
            options.fetchOptions?.stopIdsByRoute,
          ).map((stopId) => ({ routeId, stopId })),
        )
      : [];
  const vehicleQueries = options.includeVehicles ? routeIds : [];

  return Effect.gen(function* () {
    if (nextBusFeeds.length === 0) {
      return yield* Effect.fail(new Error(`Missing NextBus feed for ${options.agencyId}`));
    }
    if (arrivalQueries.length === 0 && vehicleQueries.length === 0) {
      return yield* Effect.fail(
        new Error(`NextBus realtime requires route or stop filters for ${options.agencyId}`),
      );
    }

    const arrivals = yield* Effect.all(
      arrivalQueries.map(({ routeId, stopId }) =>
        fetchNextBusJson(
          nextBusFeeds,
          "predictions",
          { stopId, r: routeId },
          (payload) =>
            parseNextBusPredictions(payload, {
              routeId,
              stopId,
              now: options.now(),
              routeInterpretation: options.routeInterpretation,
            }),
          options,
        ).pipe(Effect.exit),
      ),
      { concurrency: NEXTBUS_QUERY_CONCURRENCY },
    );
    const vehicles = yield* Effect.all(
      vehicleQueries.map((routeId) =>
        fetchNextBusJson(
          nextBusFeeds,
          "vehicleLocations",
          { r: routeId, t: "0" },
          (payload) =>
            parseNextBusVehicles(payload, {
              routeId,
              now: options.now(),
              routeInterpretation: options.routeInterpretation,
            }),
          options,
        ).pipe(Effect.exit),
      ),
      { concurrency: NEXTBUS_QUERY_CONCURRENCY },
    );

    // fetchDecodedFeeds returns transport/decode failures in firstError and
    // never fails its Effect. Reachability therefore means at least one
    // request produced a usable decoded result.
    const arrivalResults = arrivals.flatMap((exit) =>
      Exit.isSuccess(exit) && exit.value.usable.length > 0 ? [exit.value] : [],
    );
    const vehicleResults = vehicles.flatMap((exit) =>
      Exit.isSuccess(exit) && exit.value.usable.length > 0 ? [exit.value] : [],
    );
    const arrivalError = arrivals.flatMap((exit) =>
      Exit.isSuccess(exit) && exit.value.firstError ? [exit.value.firstError] : [],
    )[0];
    const vehicleError = vehicles.flatMap((exit) =>
      Exit.isSuccess(exit) && exit.value.firstError ? [exit.value.firstError] : [],
    )[0];

    if (options.includeArrivals && arrivalQueries.length > 0 && arrivalResults.length === 0) {
      return yield* Effect.fail(arrivalError ?? new Error("NextBus predictions unavailable"));
    }
    if (options.includeVehicles && vehicleQueries.length > 0 && vehicleResults.length === 0) {
      return yield* Effect.fail(vehicleError ?? new Error("NextBus vehicles unavailable"));
    }

    return {
      arrivals: arrivalResults.flatMap((result) => result.usable).flat(),
      vehicles: vehicleResults.flatMap((result) => result.usable).flat(),
      arrivalsAvailable:
        !options.includeArrivals || arrivalQueries.length === 0 || arrivalResults.length > 0,
      vehiclesAvailable:
        !options.includeVehicles || vehicleQueries.length === 0 || vehicleResults.length > 0,
    };
  });
}
