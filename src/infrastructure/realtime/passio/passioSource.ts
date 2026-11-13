import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { RealtimeFeedConfig } from "~/agencies/types";
import {
  RealtimeError,
  type RealtimeSource,
  type RealtimeFetchOptions,
} from "~/domain/surface/realtimeSource";
import type { ArrivalPrediction, LiveVehiclePosition } from "~/domain/surface/types";
import { parseWallClock } from "../wallClock";
import { readVendorDocument, type VendorOptions } from "../vendorDocument";

type Feed = Extract<RealtimeFeedConfig, { kind: "passio" }>;
const identity = Schema.Union([Schema.String, Schema.Number]);
const etaSchema = Schema.Struct({
  ETAs: Schema.Record(
    Schema.String,
    Schema.Array(
      Schema.Struct({
        busId: Schema.Number,
        tripId: identity,
        routeId: identity,
        etaUtc: Schema.Number,
        created: Schema.String,
        outdated: identity,
        OOS: identity,
        error: Schema.Unknown,
        theStop: Schema.Struct({ stopId: identity }),
      }),
    ),
  ),
});
export function decodePassioEtas(
  body: unknown,
  routeMap: Readonly<Record<string, string>>,
  timeZone: string,
  now: number,
): ArrivalPrediction[] {
  const data = Schema.decodeUnknownSync(etaSchema)(body);
  const arrivals: ArrivalPrediction[] = [];
  for (const [stopId, rows] of Object.entries(data.ETAs))
    for (const row of rows) {
      const routeId = routeMap[String(row.routeId)];
      const updated = parseWallClock(row.created, timeZone);
      if (
        !routeId ||
        row.error != null ||
        Number(row.outdated) !== 0 ||
        Number(row.OOS) !== 0 ||
        now - updated > 180000 ||
        updated > now + 60000 ||
        row.etaUtc * 1000 < now
      )
        continue;
      if (String(row.theStop.stopId) !== stopId)
        throw new Error("Passio response stop identity mismatch");
      arrivals.push({
        tripId: String(row.tripId),
        routeId,
        stopId,
        vehicleId: String(row.busId),
        directionId: 0,
        directionInferred: true,
        stopSequence: 0,
        predictedTime: row.etaUtc * 1000,
        delaySeconds: 0,
        scheduleRelationship: "SCHEDULED",
        isRealtime: true,
      });
    }
  return [
    ...new Map(
      arrivals.map((a) => [JSON.stringify([a.tripId, a.stopId, a.predictedTime]), a]),
    ).values(),
  ];
}
export async function fetchPassioArrivals(
  feed: Feed,
  options: VendorOptions & RealtimeFetchOptions,
): Promise<{ arrivals: ArrivalPrediction[]; partial: boolean }> {
  const requests = Object.entries(feed.stopRoutes)
    .filter(
      ([stopId, patterns]) =>
        (!options.stopIds?.size || options.stopIds.has(stopId)) &&
        patterns.some((pattern) => {
          const routeId = feed.routeMap[pattern];
          return (
            routeId &&
            (!options.routeIds?.size || options.routeIds.has(routeId)) &&
            (!options.stopIdsByRoute?.get(routeId)?.size ||
              options.stopIdsByRoute.get(routeId)!.has(stopId))
          );
        }),
    )
    .map(([stopId]) => stopId);
  const selected = requests.slice(0, Math.max(0, Math.floor(options.maxSubrequests ?? 40)));
  const arrivals: ArrivalPrediction[] = [];
  let failed = 0;
  for (const request of selected) {
    try {
      const url = new URL(feed.url);
      // Omitting routeId asks the public board for every live pattern serving this stop.
      for (const [key, value] of Object.entries({
        eta: "3",
        deviceId: "0",
        stopIds: request,
        userId: feed.userId,
      }))
        url.searchParams.set(key, value);
      const data = await readVendorDocument(options, url.href, {
        interval: feed.pollIntervalSeconds ?? 30,
      });
      const decoded = Schema.decodeUnknownSync(etaSchema)(data);
      const now = (options.now ?? Date.now)();
      const unusable = Object.values(decoded.ETAs)
        .flat()
        .some((row) => {
          const timestamp = parseWallClock(row.created, feed.timeZone);
          return (
            !feed.routeMap[String(row.routeId)] ||
            row.error != null ||
            Number(row.outdated) !== 0 ||
            Number(row.OOS) !== 0 ||
            now - timestamp > 180000 ||
            timestamp > now + 60000
          );
        });
      const predictions = decodePassioEtas(data, feed.routeMap, feed.timeZone, now);
      if (unusable) failed++;
      arrivals.push(
        ...predictions.filter(
          (a) =>
            a.stopId === request &&
            (!options.routeIds?.size || options.routeIds.has(a.routeId)) &&
            (!options.stopIdsByRoute?.get(a.routeId)?.size ||
              options.stopIdsByRoute.get(a.routeId)!.has(a.stopId!)),
        ),
      );
    } catch {
      failed++;
    }
  }
  if (selected.length && failed === selected.length && arrivals.length === 0)
    throw new Error("Passio departure boards unavailable");
  return {
    arrivals: [
      ...new Map(
        arrivals.map((a) => [JSON.stringify([a.tripId, a.stopId, a.predictedTime]), a]),
      ).values(),
    ],
    partial: failed > 0 || selected.length < requests.length,
  };
}
const busSchema = Schema.Struct({
  buses: Schema.Record(
    Schema.String,
    Schema.Array(
      Schema.Struct({
        busId: Schema.Number,
        userId: identity,
        routeId: identity,
        tripId: identity,
        latitude: Schema.String,
        longitude: Schema.String,
        calculatedCourse: Schema.String,
        created: Schema.String,
        outdated: identity,
        outOfService: identity,
      }),
    ),
  ),
});
async function vehicles(
  feed: Feed,
  options: VendorOptions,
  filter?: RealtimeFetchOptions,
): Promise<LiveVehiclePosition[]> {
  const data = Schema.decodeUnknownSync(busSchema)(
    await readVendorDocument(options, `${feed.url}?getBuses=1&deviceId=0`, {
      form: new URLSearchParams({
        json: JSON.stringify({ s0: Number(feed.userId), sA: 1 }),
      }).toString(),
      interval: feed.pollIntervalSeconds ?? 30,
    }),
  );
  const now = (options.now ?? Date.now)();
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: feed.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const unique = new Map<string, LiveVehiclePosition>();
  for (const rows of Object.values(data.buses))
    for (const row of rows) {
      const routeId = feed.routeMap[String(row.routeId)];
      if (
        String(row.userId) !== feed.userId ||
        !routeId ||
        Number(row.outdated) ||
        Number(row.outOfService) ||
        (filter?.routeIds?.size && !filter.routeIds.has(routeId))
      )
        continue;
      const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/.exec(row.created);
      if (!match) throw new Error("Invalid Passio vehicle observation time");
      const hour = (Number(match[1]) % 12) + (match[3] === "PM" ? 12 : 0);
      let timestamp = parseWallClock(
        `${date} ${String(hour).padStart(2, "0")}:${match[2]}:00`,
        feed.timeZone,
      );
      if (timestamp > now + 12 * 3600000) timestamp -= 86400000;
      const latitude = Number(row.latitude),
        longitude = Number(row.longitude);
      if (
        now - timestamp > 180000 ||
        timestamp > now + 60000 ||
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        Math.abs(latitude) > 90 ||
        Math.abs(longitude) > 180
      )
        continue;
      const vehicleId = String(row.busId);
      const previous = unique.get(vehicleId);
      if (!previous || previous.timestamp < timestamp)
        unique.set(vehicleId, {
          vehicleId,
          tripId: String(row.tripId),
          routeId,
          directionId: 0,
          latitude,
          longitude,
          bearing: Number(row.calculatedCourse),
          timestamp,
        });
    }
  return [...unique.values()];
}
export function createPassioRealtimeSource(
  options: VendorOptions & { readonly agencyId: string; readonly feed: Feed },
): RealtimeSource {
  return {
    fetchRealtime: (_topology, filter) =>
      Effect.tryPromise({
        try: async () => {
          const budget = Math.max(0, Math.floor(filter?.maxSubrequests ?? 12));
          const [v, a] = await Promise.allSettled([
            budget > 0
              ? vehicles(options.feed, options, filter)
              : Promise.reject(new Error("Vehicle budget exhausted")),
            filter?.vehiclesOnly
              ? Promise.resolve({ arrivals: [], partial: false })
              : fetchPassioArrivals(options.feed, {
                  ...options,
                  ...filter,
                  maxSubrequests: Math.max(0, budget - 1),
                }),
          ]);
          if (v.status === "rejected" && a.status === "rejected") throw a.reason;
          return {
            agencyId: options.agencyId,
            updatedAt: (options.now ?? Date.now)(),
            vehicles: v.status === "fulfilled" ? v.value : [],
            arrivals: a.status === "fulfilled" ? a.value.arrivals : [],
            partial: v.status === "rejected" || a.status === "rejected" || a.value.partial,
          };
        },
        catch: (cause) =>
          new RealtimeError({
            agencyId: options.agencyId,
            message: "Passio realtime unavailable",
            cause,
          }),
      }),
  };
}
