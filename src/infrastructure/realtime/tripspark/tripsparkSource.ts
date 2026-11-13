import { inferVehicleDirectionFromTopology } from "~/domain/surface/topologyDirection";
import * as Effect from "effect/Effect";
import type { SourceAgencyScope, SourceAgencyScopeLookup } from "~/domain/surface/boarding";
import type { ArrivalPrediction, LiveVehiclePosition } from "~/domain/surface/types";
import {
  RealtimeError,
  type RealtimeSource,
  type RealtimeFetchOptions,
} from "~/domain/surface/realtimeSource";
import type { RouteTopology } from "~/domain/surface/topologySource";
import { decodeMappedStationDepartures } from "../mappedStationDepartures";
import { parseWallClock } from "../wallClock";
import {
  requestTripSparkJson,
  type TripSparkFeed,
  type TripSparkHttpOptions,
} from "./tripsparkHttp";
interface Options extends TripSparkHttpOptions {
  readonly agencyId: string;
  readonly getSourceAgencyScope?: SourceAgencyScopeLookup;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid TripSpark record");
  return value as Record<string, unknown>;
}
function rows(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid TripSpark array");
  return value;
}
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
function routeId(raw: string, scope: Omit<SourceAgencyScope, "agencyIds">): string | undefined {
  const ids = scope.routesByShortName?.get(raw);
  return ids?.length === 1 ? ids[0] : scope.routeIds.has(raw) ? raw : undefined;
}
function scopeFor(options: Options) {
  if (!options.getSourceAgencyScope) throw new Error("TripSpark pinned identities unavailable");
  return Effect.runPromise(options.getSourceAgencyScope());
}
const mapping = {
  routesPath: "routeStopSchedules",
  routeIdField: "routeNumber",
  departuresField: "stopTimes",
  timeField: "estimatedDepartTimeUtc",
  realtimeField: "isRealtime",
  cancelledField: "isCancelled",
  offRouteField: "isOffRoute",
  terminalField: "isLastPoint",
  tripIdField: "tripPointId",
  directionField: "directionName",
};
export async function fetchTripSparkArrivals(
  feed: TripSparkFeed,
  options: Options & RealtimeFetchOptions,
  routes: readonly RouteTopology[] = [],
): Promise<{ arrivals: readonly ArrivalPrediction[]; partial: boolean }> {
  if (!options.stopIds?.size && !options.stopIdsByRoute?.size)
    return { arrivals: [], partial: false };
  const scope = await scopeFor(options),
    codes = new Map<string, string>();
  for (const [code, ids] of scope.stopsByCode ?? [])
    if (ids.length === 1) {
      const previous = codes.get(ids[0]);
      if (previous && previous !== code) throw new Error("Ambiguous TripSpark stop code");
      codes.set(ids[0], code);
    }
  const requested = new Set([
    ...(options.stopIds ?? []),
    ...[...(options.stopIdsByRoute?.values() ?? [])].flatMap((ids) => [...ids]),
  ]);
  const jobs = [...requested].map((stopId) => {
    const code = codes.get(stopId);
    if (!code || !scope.stopIds.has(stopId)) throw new Error("Missing TripSpark public stop code");
    return { stopId, code };
  });
  const selected = jobs.slice(
    0,
    Math.max(0, Math.min(37, Math.floor(options.maxSubrequests ?? 37))),
  );
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: feed.dateTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date((options.now ?? Date.now)()));
  const arrivals: ArrivalPrediction[] = [];
  let failed = 0;
  for (let i = 0; i < selected.length; i += 4) {
    const results = await Promise.allSettled(
      selected.slice(i, i + 4).map(async ({ stopId, code }) => {
        const payload = await requestTripSparkJson(feed, "/Schedule/GetStopEstimates", options, {
          stopCode: code,
          date,
        });
        return decodeMappedStationDepartures(payload, stopId, mapping, undefined)
          .filter((a) => a.isRealtime)
          .flatMap((a) => {
            const id = routeId(a.routeId, scope);
            if (
              !id ||
              (options.routeIds?.size && !options.routeIds.has(id)) ||
              (options.stopIdsByRoute?.has(id) && !options.stopIdsByRoute.get(id)!.has(stopId))
            )
              return [];
            const candidates = routes.filter(
                (r) => r.routeId === id && r.stops.some((s) => s.id === stopId),
              ),
              directions = new Set(candidates.map((r) => r.directionId));
            return [
              {
                ...a,
                routeId: id,
                tripId: "tripspark:" + a.tripId,
                directionId: directions.size === 1 ? [...directions][0] : a.directionId,
                rawEntityId: "tripspark:" + a.rawEntityId,
              },
            ];
          });
      }),
    );
    for (const result of results)
      if (result.status === "fulfilled") arrivals.push(...result.value);
      else failed++;
  }
  if (selected.length && failed === selected.length)
    throw new Error("All TripSpark stop boards failed");
  return { arrivals, partial: failed > 0 || selected.length < jobs.length };
}
async function vehicles(
  feed: TripSparkFeed,
  options: Options,
  scope: Omit<SourceAgencyScope, "agencyIds">,
  routes: readonly RouteTopology[],
  filter?: RealtimeFetchOptions,
): Promise<LiveVehiclePosition[]> {
  const base = record(await requestTripSparkJson(feed, "/RouteMap/GetBaseData/", options, {})),
    keyToId = new Map<string, string>();
  for (const item of rows(base.routes)) {
    const route = record(item),
      id = routeId(text(route.shortName), scope),
      key = text(route.key);
    if (!key || !text(route.shortName)) throw new Error("Invalid TripSpark route identity");
    if (id && (!filter?.routeIds?.size || filter.routeIds.has(id))) keyToId.set(key, id);
  }
  if (!keyToId.size) return [];
  const body = new URLSearchParams();
  for (const key of keyToId.keys()) body.append("routeKeys", key);
  const payload = await requestTripSparkJson(feed, "/RouteMap/GetVehicles/", options, body),
    found = new Map<string, LiveVehiclePosition>();
  for (const groupValue of rows(payload)) {
    const group = record(groupValue),
      id = keyToId.get(text(group.routeKey));
    if (!id) continue;
    for (const directionValue of rows(group.vehiclesByDirections))
      for (const value of rows(record(directionValue).vehicles)) {
        const vehicle = record(value);
        if (vehicle.location == null) continue;
        const location = record(vehicle.location),
          vehicleId = text(vehicle.key),
          latitude = Number(location.latitude),
          longitude = Number(location.longitude),
          stamp = text(location.lastGpsDate),
          bearing = Number(location.heading);
        if (
          !vehicleId ||
          !Number.isFinite(latitude) ||
          !Number.isFinite(longitude) ||
          Math.abs(latitude) > 90 ||
          Math.abs(longitude) > 180 ||
          !stamp
        )
          throw new Error("Invalid TripSpark vehicle fix");
        const timestamp = /(?:Z|[+-]\d{2}:\d{2})$/u.test(stamp)
          ? Date.parse(stamp)
          : parseWallClock(stamp.replace("T", " "), feed.vehicleTimeZone);
        if (!Number.isFinite(timestamp) || timestamp > (options.now ?? Date.now)() + 60_000)
          throw new Error("Invalid TripSpark GPS timestamp");
        const directions = new Set(
          routes.filter((r) => r.routeId === id).map((r) => r.directionId),
        );
        const position: LiveVehiclePosition = {
          vehicleId,
          routeId: id,
          latitude,
          longitude,
          timestamp,
          directionId:
            directions.size === 1
              ? [...directions][0]
              : inferVehicleDirectionFromTopology(
                  routes,
                  id,
                  latitude,
                  longitude,
                  Number.isFinite(bearing) ? bearing : undefined,
                ),
          ...(Number.isFinite(bearing) && bearing >= 0 && bearing <= 360 ? { bearing } : {}),
        };
        if (!found.has(vehicleId) || found.get(vehicleId)!.timestamp < timestamp)
          found.set(vehicleId, position);
      }
  }
  return [...found.values()];
}
export function createTripSparkRealtimeSource(
  options: Options & { readonly feed: TripSparkFeed },
): RealtimeSource {
  return {
    fetchRealtime: (topology, filter) =>
      Effect.tryPromise({
        try: async () => {
          const scope = await scopeFor(options),
            budget = Math.max(0, Math.min(40, Math.floor(filter?.maxSubrequests ?? 40)));
          if (budget < 3)
            return {
              agencyId: options.agencyId,
              updatedAt: (options.now ?? Date.now)(),
              arrivals: [],
              vehicles: [],
              partial: true,
            };
          const [fixes, calls] = await Promise.allSettled([
            vehicles(options.feed, options, scope, topology.routes, filter),
            filter?.vehiclesOnly
              ? Promise.resolve({ arrivals: [], partial: false })
              : fetchTripSparkArrivals(
                  options.feed,
                  { ...options, ...filter, maxSubrequests: budget - 3 },
                  topology.routes,
                ),
          ]);
          if (fixes.status === "rejected" && calls.status === "rejected")
            throw new Error("TripSpark live source unavailable");
          return {
            agencyId: options.agencyId,
            updatedAt: (options.now ?? Date.now)(),
            vehicles: fixes.status === "fulfilled" ? fixes.value : [],
            arrivals: calls.status === "fulfilled" ? calls.value.arrivals : [],
            partial:
              fixes.status === "rejected" ||
              calls.status === "rejected" ||
              (calls.status === "fulfilled" && calls.value.partial),
          };
        },
        catch: (cause) =>
          new RealtimeError({
            agencyId: options.agencyId,
            message: "TripSpark realtime unavailable",
            cause,
          }),
      }),
  };
}
