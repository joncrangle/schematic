import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { RealtimeFeedConfig } from "~/agencies/types";
import { RealtimeError, type RealtimeSource } from "~/domain/surface/realtimeSource";
import type { ArrivalPrediction, LiveVehiclePosition } from "~/domain/surface/types";
import { fetchDecodedFeeds } from "../fetchDecodedFeeds";
import { createFeedPollingFetch } from "../feedPolling";

type Feed = Extract<RealtimeFeedConfig, { kind: "transloc" }>;
interface Options {
  readonly agencyId: string;
  readonly fetch: typeof fetch;
  readonly now?: () => number;
  readonly getSecret?: (name: string) => string | undefined;
  readonly devProxyOrigin?: string;
}
const arrivalsSchema = Schema.Array(
  Schema.Struct({
    RouteId: Schema.Number,
    StopId: Schema.Number,
    RouteStopId: Schema.optional(Schema.Number),
    Times: Schema.Array(
      Schema.Struct({
        EstimateTime: Schema.NullOr(Schema.String),
        VehicleId: Schema.NullOr(Schema.Number),
        IsDeparted: Schema.optional(Schema.Boolean),
      }),
    ),
  }),
);
const vehiclesSchema = Schema.Array(
  Schema.Struct({
    VehicleID: Schema.Number,
    RouteID: Schema.Number,
    Latitude: Schema.Number,
    Longitude: Schema.Number,
    Heading: Schema.Number,
    GroundSpeed: Schema.Number,
    Seconds: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
    IsOnRoute: Schema.Boolean,
  }),
);
function epoch(value: string): number {
  const match = /^\/Date\((\d+)(?:[+-]\d{4})?\)\/$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error("Invalid TransLoc epoch");
  return Number(match[1]);
}
async function poll<T>(
  feed: Feed,
  path: string,
  schema: Schema.Codec<T, unknown, never, never>,
  options: Options,
): Promise<{ data: T; observedAt: number }> {
  const url = `${feed.url.replace(/\/+$/, "")}/${path}`;
  let observedAt = (options.now ?? Date.now)();
  const pollingFetch = createFeedPollingFetch(
    [{ ...feed, url, pollIntervalSeconds: feed.pollIntervalSeconds ?? 30 }],
    { fetch: options.fetch, now: options.now, devProxyOrigin: options.devProxyOrigin },
  );
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
              Schema.decodeUnknownSync(schema)(JSON.parse(new TextDecoder().decode(bytes))),
            ),
          mapError: (cause) => cause,
        },
      ],
      {
        fetch: (async (input, init) => {
          const response = await pollingFetch(input, init);
          const date = Date.parse(response.headers.get("Date") ?? "");
          observedAt = Number.isFinite(date) ? date : (options.now ?? Date.now)();
          return response;
        }) as typeof fetch,
        getSecret: options.getSecret,
        devProxyOrigin: options.devProxyOrigin,
        attempts: 1,
        timeoutMs: 8000,
      },
    ),
  );
  if (!result.usable.length) throw result.firstError;
  return { data: result.usable[0], observedAt };
}
export async function fetchTranslocArrivals(
  feed: Feed,
  options: Options & {
    readonly stopIds?: ReadonlySet<string>;
    readonly routeIds?: ReadonlySet<string>;
    readonly stopIdsByRoute?: ReadonlyMap<string, ReadonlySet<string>>;
    readonly maxSubrequests?: number;
  },
): Promise<{ arrivals: ArrivalPrediction[]; partial: boolean }> {
  if (options.maxSubrequests !== undefined && options.maxSubrequests < 1)
    return { arrivals: [], partial: true };
  const { data: rows } = await poll(
    feed,
    `GetStopArrivalTimes?routeIds=${feed.routeIds.map(encodeURIComponent).join(",")}&version=2`,
    arrivalsSchema,
    options,
  );
  const now = (options.now ?? Date.now)();
  if (
    feed.emptyArrivals === "error" &&
    !rows.some(
      (row) =>
        feed.routeIds.includes(String(row.RouteId)) &&
        row.Times.some(
          (time) =>
            (time.VehicleId ?? 0) > 0 &&
            time.EstimateTime !== null &&
            !time.IsDeparted &&
            epoch(time.EstimateTime) >= now,
        ),
    )
  )
    throw new Error("TransLoc live estimates unavailable");
  const arrivals: ArrivalPrediction[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!feed.routeIds.includes(String(row.RouteId))) continue;
    const routeId = `${feed.idPrefix ?? ""}${row.RouteId}`;
    const nativeStopId = row[feed.stopIdField ?? "StopId"];
    if (!Number.isSafeInteger(nativeStopId)) throw new Error("Missing TransLoc stop identity");
    const stopId = `${feed.idPrefix ?? ""}${nativeStopId}`;
    const stops = options.stopIdsByRoute?.get(routeId) ?? options.stopIds;
    if (
      (options.routeIds?.size && !options.routeIds.has(routeId)) ||
      (stops?.size && !stops.has(stopId))
    )
      continue;
    for (const time of row.Times) {
      if (time.IsDeparted || (time.VehicleId ?? 0) <= 0 || time.EstimateTime === null) continue;
      const predictedTime = epoch(time.EstimateTime);
      if (predictedTime < now) continue;
      const identity = JSON.stringify([routeId, stopId, time.VehicleId, predictedTime]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      arrivals.push({
        tripId: `transloc:${row.RouteId}:${time.VehicleId}`,
        routeId,
        stopId,
        vehicleId: String(time.VehicleId),
        directionId: 0,
        directionInferred: true,
        stopSequence: 0,
        predictedTime,
        delaySeconds: 0,
        scheduleRelationship: "SCHEDULED",
        isRealtime: true,
      });
    }
  }
  return { arrivals, partial: false };
}
export function createTranslocRealtimeSource(
  options: Options & { readonly feed: Feed },
): RealtimeSource {
  const { feed } = options;
  return {
    fetchRealtime: (_topology, filter) =>
      Effect.tryPromise({
        try: async () => {
          const budget = Math.max(0, Math.floor(filter?.maxSubrequests ?? 40));
          const [positions, predictions] = await Promise.allSettled([
            budget > 1
              ? poll(feed, "GetMapVehiclePoints?isPublicMap=true", vehiclesSchema, options)
              : Promise.reject(new Error("Vehicle request budget exhausted")),
            fetchTranslocArrivals(feed, {
              ...options,
              ...filter,
              maxSubrequests: Math.min(1, budget),
            }),
          ]);
          if (positions.status === "rejected" && predictions.status === "rejected")
            throw predictions.reason;
          const now = (options.now ?? Date.now)();
          const vehicles: LiveVehiclePosition[] = [];
          if (positions.status === "fulfilled")
            for (const v of positions.value.data) {
              // Vendor epochs can drift by hours; GPS age is anchored to the cached HTTP observation.
              const timestamp = positions.value.observedAt - v.Seconds * 1000;
              const routeId = `${feed.idPrefix ?? ""}${v.RouteID}`;
              if (
                !v.IsOnRoute ||
                !feed.routeIds.includes(String(v.RouteID)) ||
                (filter?.routeIds?.size && !filter.routeIds.has(routeId)) ||
                now - timestamp > 300_000 ||
                timestamp > now + 60_000 ||
                Math.abs(v.Latitude) > 90 ||
                Math.abs(v.Longitude) > 180
              )
                continue;
              vehicles.push({
                vehicleId: String(v.VehicleID),
                routeId,
                directionId: 0,
                latitude: v.Latitude,
                longitude: v.Longitude,
                bearing: v.Heading,
                speed: v.GroundSpeed,
                timestamp,
              });
            }
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
            message: "TransLoc realtime unavailable",
            cause,
          }),
      }),
  };
}
