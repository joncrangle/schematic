import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { RealtimeFeedConfig } from "~/agencies/types";
import { RealtimeError, type RealtimeSource } from "~/domain/surface/realtimeSource";
import type { LiveVehiclePosition } from "~/domain/surface/types";
import { fetchDecodedFeeds } from "../fetchDecodedFeeds";
import { createFeedPollingFetch } from "../feedPolling";

const coordinate = Schema.Union([Schema.String, Schema.Number]);
const fleetSchema = Schema.Struct({
  status_code: Schema.Literal(200),
  data: Schema.Struct({
    results: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        route_name: Schema.String,
        gps: Schema.NullOr(
          Schema.Struct({
            time: Schema.String,
            latitude: coordinate,
            longitude: coordinate,
            headingDegrees: Schema.optional(coordinate),
            speedMilesPerHour: Schema.optional(coordinate),
          }),
        ),
      }),
    ),
  }),
});

/** The public fleet document contains positions, never stop-call predictions. */
export function createFleetIntegrationsSource(options: {
  readonly agencyId: string;
  readonly feed: Extract<RealtimeFeedConfig, { kind: "fleet_integrations" }>;
  readonly fetch: typeof fetch;
  readonly getSecret?: (name: string) => string | undefined;
  readonly devProxyOrigin?: string;
  readonly now?: () => number;
}): RealtimeSource {
  const { feed, agencyId } = options;
  const fetch = createFeedPollingFetch(
    [{ ...feed, pollIntervalSeconds: Math.max(10, feed.pollIntervalSeconds ?? 10) }],
    { fetch: options.fetch, devProxyOrigin: options.devProxyOrigin },
  );
  return {
    fetchRealtime: (topology, filter) =>
      Effect.gen(function* () {
        const routeIds = new Set(
          topology.routes
            .filter(
              (r) =>
                feed.routeIds.includes(r.routeId) &&
                (!filter?.routeIds?.size || filter.routeIds.has(r.routeId)),
            )
            .map((r) => r.routeId),
        );
        const updatedAt = (options.now ?? Date.now)();
        const empty = { agencyId, updatedAt, vehicles: [], arrivals: [] };
        if (routeIds.size === 0) return empty;
        if (filter?.maxSubrequests !== undefined && filter.maxSubrequests < 1)
          return { ...empty, partial: true };
        const result = yield* fetchDecodedFeeds(
          [
            {
              url: feed.url,
              auth: feed.auth,
              devProxyPrefix: feed.devProxyPrefix,
              format: "json",
              decode: (bytes) =>
                Effect.try({
                  try: () =>
                    Schema.decodeUnknownSync(fleetSchema)(
                      JSON.parse(new TextDecoder().decode(bytes)),
                    ),
                  catch: () => new Error("Invalid public fleet document"),
                }),
              mapError: (cause) =>
                new RealtimeError({ agencyId, message: "Fleet positions unavailable", cause }),
            },
          ],
          {
            fetch,
            getSecret: options.getSecret,
            devProxyOrigin: options.devProxyOrigin,
            attempts: 1,
            timeoutMs: 8000,
          },
        );
        if (!result.usable.length)
          return yield* Effect.fail(
            result.firstError ??
              new RealtimeError({ agencyId, message: "Fleet positions unavailable" }),
          );
        const vehicles = new Map<string, LiveVehiclePosition>();
        for (const record of result.usable[0].data.results) {
          if (!record.gps || !routeIds.has(record.route_name)) continue;
          const timestamp = Date.parse(record.gps.time);
          const latitude = Number(record.gps.latitude),
            longitude = Number(record.gps.longitude);
          if (
            !record.gps.latitude.toString().trim() ||
            !record.gps.longitude.toString().trim() ||
            !Number.isFinite(latitude) ||
            !Number.isFinite(longitude) ||
            Math.abs(latitude) > 90 ||
            Math.abs(longitude) > 180 ||
            !Number.isFinite(timestamp) ||
            updatedAt - timestamp > 300_000 ||
            timestamp > updatedAt + 60_000
          )
            continue;
          const bearing = Number(record.gps.headingDegrees);
          const speed = Number(record.gps.speedMilesPerHour) * 0.44704;
          const vehicle: LiveVehiclePosition = {
            vehicleId: record.name || record.id,
            routeId: record.route_name,
            directionId: 0,
            latitude,
            longitude,
            timestamp,
            ...(record.gps.headingDegrees !== undefined &&
            Number.isFinite(bearing) &&
            bearing >= 0 &&
            bearing <= 360
              ? { bearing }
              : {}),
            ...(record.gps.speedMilesPerHour !== undefined && Number.isFinite(speed) && speed >= 0
              ? { speed }
              : {}),
          };
          const previous = vehicles.get(vehicle.vehicleId);
          if (!previous || timestamp > previous.timestamp) vehicles.set(vehicle.vehicleId, vehicle);
        }
        return { ...empty, vehicles: [...vehicles.values()] };
      }),
  };
}
