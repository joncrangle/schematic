import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { RealtimeFeedConfig } from "~/agencies/types";
import { RealtimeError, type RealtimeSource } from "~/domain/surface/realtimeSource";
import type { ArrivalPrediction, LiveVehiclePosition } from "~/domain/surface/types";
import { fetchDecodedFeeds } from "../fetchDecodedFeeds";
import { createFeedPollingFetch } from "../feedPolling";

export type SwiftlyFeed = Extract<RealtimeFeedConfig, { kind: "swiftly" }>;
interface Options {
  readonly agencyId: string;
  readonly fetch: typeof fetch;
  readonly getSecret?: (name: string) => string | undefined;
  readonly devProxyOrigin?: string;
  readonly now?: () => number;
}
const id = Schema.String;
const direction = Schema.Literals(["0", "1"]);
const predictionSchema = Schema.Struct({
  time: Schema.Number,
  vehicleId: id,
  tripId: id,
  scheduleBased: Schema.optional(Schema.Boolean),
  departure: Schema.optional(Schema.Boolean),
  atEndOfTrip: Schema.optional(Schema.Boolean),
});
const predictionsSchema = Schema.Struct({
  predictionsData: Schema.Array(
    Schema.Struct({
      routeId: id,
      stopId: id,
      destinations: Schema.Array(
        Schema.Struct({
          directionId: direction,
          headsign: id,
          predictions: Schema.Array(predictionSchema),
        }),
      ),
    }),
  ),
});
const vehiclesSchema = Schema.Struct({
  vehicles: Schema.Array(
    Schema.Struct({
      id,
      routeId: id,
      tripId: Schema.optional(id),
      directionId: direction,
      nextStopId: Schema.optional(id),
      loc: Schema.Struct({
        lat: Schema.Number,
        lon: Schema.Number,
        time: Schema.Number,
        heading: Schema.optional(Schema.Number),
      }),
    }),
  ),
});
const routesSchema = Schema.Struct({
  routes: Schema.Array(
    Schema.Struct({
      id,
      shortName: id,
      directions: Schema.Array(
        Schema.Struct({
          id: direction,
          stops: Schema.Array(
            Schema.Struct({ id, code: Schema.Union([Schema.String, Schema.Number]) }),
          ),
        }),
      ),
    }),
  ),
});
const envelope = Schema.Struct({ success: Schema.Literal(true), data: Schema.Unknown });

/** Share authenticated wire polls across station and surface consumers. */
async function poll<T>(
  feed: SwiftlyFeed,
  url: string,
  schema: Schema.Codec<T, unknown, never, never>,
  options: Options,
  ttlMs = Math.max(10, feed.pollIntervalSeconds ?? 10) * 1000,
): Promise<T> {
  const result = await Effect.runPromise(
    fetchDecodedFeeds(
      [
        {
          url,
          auth: feed.auth,
          format: "json",
          devProxyPrefix: feed.devProxyPrefix,
          decode: (bytes) =>
            Effect.try(() =>
              Schema.decodeUnknownSync(schema)(
                Schema.decodeUnknownSync(envelope)(JSON.parse(new TextDecoder().decode(bytes)))
                  .data,
              ),
            ),
          mapError: (cause) => cause,
        },
      ],
      {
        fetch: createFeedPollingFetch([{ ...feed, url, pollIntervalSeconds: ttlMs / 1000 }], {
          fetch: options.fetch,
          devProxyOrigin: options.devProxyOrigin,
        }),
        getSecret: options.getSecret,
        devProxyOrigin: options.devProxyOrigin,
        attempts: 1,
        timeoutMs: 8000,
      },
    ),
  );
  if (!result.usable.length) throw result.firstError;
  return result.usable[0];
}

function endpoint(feed: SwiftlyFeed, path: string): string {
  return `${feed.url.replace(/\/+$/, "")}/${path}`;
}
export async function fetchSwiftlyArrivals(
  feed: SwiftlyFeed,
  options: Options & {
    readonly stopIds: ReadonlySet<string>;
    readonly routeIds?: ReadonlySet<string>;
    readonly stopIdsByRoute?: ReadonlyMap<string, ReadonlySet<string>>;
    readonly maxSubrequests?: number;
  },
): Promise<{ arrivals: ArrivalPrediction[]; partial: boolean }> {
  if (options.maxSubrequests !== undefined && options.maxSubrequests <= 0)
    return { arrivals: [], partial: true };
  const directory = await poll(
    feed,
    endpoint(feed, "routes?verbose=true").replace("/real-time/", "/info/"),
    routesSchema,
    options,
    3600_000,
  );
  const groups = directory.routes.map((route) => {
    if (options.routeIds?.size && !options.routeIds.has(route.id)) return [];
    const stops = new Map(route.directions.flatMap((d) => d.stops).map((s) => [s.id, s]));
    const wanted = options.stopIdsByRoute?.get(route.id) ?? options.stopIds;
    return [...stops.values()].filter((s) => wanted.has(s.id)).map((stop) => ({ route, stop }));
  });
  const limit = Math.max(0, Math.min(38, (options.maxSubrequests ?? 39) - 1));
  const total = groups.reduce((sum, group) => sum + group.length, 0);
  // Rotate oversized boards, taking one stop per route before a second from any route.
  const offset =
    total > limit
      ? Math.floor(
          (options.now ?? Date.now)() / (Math.max(10, feed.pollIntervalSeconds ?? 10) * 1000),
        )
      : 0;
  const selected: (typeof groups)[number][number][] = [];
  for (
    let step = 0;
    selected.length < limit && step < Math.max(0, ...groups.map((g) => g.length));
    step++
  ) {
    for (const group of groups) {
      if (step < group.length && selected.length < limit)
        selected.push(group[(offset + step) % group.length]);
    }
  }
  const results = await Effect.runPromise(
    Effect.forEach(
      selected,
      ({ route, stop }) =>
        Effect.promise(async () => {
          const url = new URL(endpoint(feed, "predictions"));
          url.searchParams.set("route", route.shortName);
          url.searchParams.set("stop", String(stop.code));
          try {
            const data = await poll(feed, url.toString(), predictionsSchema, options);
            const arrivals: ArrivalPrediction[] = [];
            for (const board of data.predictionsData) {
              if (board.routeId !== route.id || board.stopId !== stop.id)
                throw new Error("Swiftly returned a different route or stop");
              for (const destination of board.destinations)
                for (const p of destination.predictions) {
                  if (
                    p.scheduleBased === true ||
                    p.vehicleId.endsWith("_schedBasedVehicle") ||
                    (p.atEndOfTrip === true && p.departure !== true)
                  )
                    continue;
                  if (!Number.isFinite(p.time) || p.time * 1000 < (options.now ?? Date.now)())
                    continue;
                  arrivals.push({
                    tripId: p.tripId,
                    routeId: route.id,
                    stopId: stop.id,
                    vehicleId: p.vehicleId,
                    directionId: Number(destination.directionId),
                    stopSequence: 0,
                    predictedTime: p.time * 1000,
                    delaySeconds: 0,
                    scheduleRelationship: "SCHEDULED",
                    isRealtime: true,
                    departureConfirmed: p.departure === true,
                    headsign: destination.headsign,
                    directionAuthoritative: true,
                    headsignPreferred: true,
                  });
                }
            }
            return { arrivals, failed: false };
          } catch (cause) {
            return { arrivals: [] as ArrivalPrediction[], failed: true, cause };
          }
        }),
      { concurrency: 4 },
    ),
  );
  if (results.length && results.every((r) => r.failed)) throw results[0].cause;
  return {
    arrivals: results.flatMap((r) => r.arrivals),
    partial: selected.length < total || results.some((r) => r.failed),
  };
}

export function createSwiftlyRealtimeSource(
  options: Options & { readonly feed: SwiftlyFeed },
): RealtimeSource {
  return {
    fetchRealtime: (topology, filter) =>
      Effect.tryPromise({
        try: async () => {
          const budget = Math.max(0, Math.min(40, Math.floor(filter?.maxSubrequests ?? 40)));
          if (budget === 0)
            return {
              agencyId: options.agencyId,
              updatedAt: (options.now ?? Date.now)(),
              vehicles: [],
              arrivals: [],
              partial: true,
            };
          const routes = topology.routes.filter(
            (r) => !filter?.routeIds?.size || filter.routeIds.has(r.routeId),
          );
          const stopIds =
            filter?.stopIds ?? new Set(routes.flatMap((r) => r.stops.map((s) => s.id)));
          const [positions, predictions] = await Promise.allSettled([
            poll(options.feed, endpoint(options.feed, "vehicles"), vehiclesSchema, options),
            fetchSwiftlyArrivals(options.feed, {
              ...options,
              stopIds,
              routeIds: new Set(routes.map((r) => r.routeId)),
              stopIdsByRoute: filter?.stopIdsByRoute,
              maxSubrequests: budget - 1,
            }),
          ]);
          if (positions.status === "rejected" && predictions.status === "rejected")
            throw positions.reason;
          const now = (options.now ?? Date.now)();
          const vehicles: LiveVehiclePosition[] =
            positions.status === "fulfilled"
              ? positions.value.vehicles
                  .filter(
                    (v) =>
                      routes.some((r) => r.routeId === v.routeId) &&
                      Number.isFinite(v.loc.time) &&
                      now - v.loc.time * 1000 <= 300_000 &&
                      v.loc.time * 1000 <= now + 60_000 &&
                      Math.abs(v.loc.lat) <= 90 &&
                      Math.abs(v.loc.lon) <= 180,
                  )
                  .map((v) => ({
                    vehicleId: v.id,
                    routeId: v.routeId,
                    tripId: v.tripId,
                    directionId: Number(v.directionId),
                    latitude: v.loc.lat,
                    longitude: v.loc.lon,
                    timestamp: v.loc.time * 1000,
                    bearing: v.loc.heading,
                    stopId: v.nextStopId,
                  }))
              : [];
          return {
            agencyId: options.agencyId,
            updatedAt: now,
            vehicles,
            arrivals: predictions.status === "fulfilled" ? predictions.value.arrivals : [],
            partial:
              positions.status === "rejected" ||
              predictions.status === "rejected" ||
              predictions.value.partial,
          };
        },
        catch: (cause) =>
          new RealtimeError({
            agencyId: options.agencyId,
            message: "Swiftly realtime unavailable",
            cause,
          }),
      }),
  };
}
