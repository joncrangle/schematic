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

type Feed = Extract<RealtimeFeedConfig, { kind: "hubup" }>;
const id = Schema.Union([Schema.String, Schema.Number]);
const tailsSchema = Schema.Array(
  Schema.Struct({
    user_id: id,
    company_tag: Schema.String,
    tail: Schema.Struct({
      lat: Schema.Number,
      lon: Schema.Number,
      unix: Schema.Number,
      fd_heading: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
      fg_next_rev_stop_time: Schema.optional(Schema.NullOr(id)),
      fg_lateness: Schema.optional(Schema.NullOr(Schema.Number)),
    }),
    theo_ref: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          real_trip_id: id,
          real_route_id: id,
          rev_trip_id: id,
        }),
      ),
    ),
  }),
);
const detailsSchema = Schema.Struct({
  rev_stop_times: Schema.Array(
    Schema.Struct({
      id,
      rev_trip_id: id,
      rev_stop_id: id,
      arrival_time: Schema.String,
      stop_sequence: id,
    }),
  ),
  rev_stops: Schema.Array(Schema.Struct({ id, stop_id: id })),
  stops: Schema.Array(Schema.Struct({ id, real_stop_id: id })),
});
function fresh(unix: number, now: number): boolean {
  return now - unix * 1000 <= 180000 && unix * 1000 <= now + 60000;
}
function callTime(clock: string, timestamp: number, timeZone: string): number {
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(clock);
  if (!match || Number(match[1]) > 47 || Number(match[2]) > 59 || Number(match[3]) > 59)
    throw new Error("Invalid Hubup call time");
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(timestamp);
  const day = new Date(
    Date.parse(`${date}T12:00:00Z`) + Math.floor(Number(match[1]) / 24) * 86400000,
  )
    .toISOString()
    .slice(0, 10);
  let result = parseWallClock(
    `${day} ${String(Number(match[1]) % 24).padStart(2, "0")}:${match[2]}:${match[3]}`,
    timeZone,
  );
  // Extended clocks belong to the service day that began before this overnight observation.
  if (Number(match[1]) >= 24 && result - timestamp > 18 * 3600000) {
    const previous = new Date(Date.parse(`${day}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
    result = parseWallClock(
      `${previous} ${String(Number(match[1]) % 24).padStart(2, "0")}:${match[2]}:${match[3]}`,
      timeZone,
    );
  }
  return result;
}
export function decodeHubupRealtime(
  body: unknown,
  detailBody: unknown,
  company: string,
  timeZone: string,
  now: number,
): { vehicles: LiveVehiclePosition[]; arrivals: ArrivalPrediction[] } {
  const tails = Schema.decodeUnknownSync(tailsSchema)(body).filter(
    (row) => row.company_tag.toLowerCase() === company.toLowerCase(),
  );
  if (tails.length && !tails.some((row) => fresh(row.tail.unix, now)))
    throw new Error("Hubup observations are stale");
  const details = Schema.decodeUnknownSync(detailsSchema)(detailBody);
  const realStops = new Map(details.stops.map((s) => [String(s.id), String(s.real_stop_id)]));
  const stops = new Map(
    details.rev_stops.map((s) => [String(s.id), realStops.get(String(s.stop_id))]),
  );
  const vehicles = new Map<string, LiveVehiclePosition>();
  const arrivals: ArrivalPrediction[] = [];
  for (const row of [...tails].sort((a, b) => b.tail.unix - a.tail.unix)) {
    const ref = row.theo_ref,
      tail = row.tail;
    if (!ref || !fresh(tail.unix, now) || Math.abs(tail.lat) > 90 || Math.abs(tail.lon) > 180)
      continue;
    const routeId = String(ref.real_route_id),
      tripId = String(ref.real_trip_id),
      vehicleId = String(row.user_id);
    const previous = vehicles.get(vehicleId);
    if (previous && previous.timestamp >= tail.unix * 1000) continue;
    vehicles.set(vehicleId, {
      vehicleId,
      tripId,
      routeId,
      directionId: 0,
      latitude: tail.lat,
      longitude: tail.lon,
      bearing: Number(tail.fd_heading) || 0,
      timestamp: tail.unix * 1000,
    });
    if (tail.fg_lateness == null || !tail.fg_next_rev_stop_time) continue;
    const calls = details.rev_stop_times.filter(
      (c) => String(c.rev_trip_id) === String(ref.rev_trip_id),
    );
    const next = calls.find((c) => String(c.id) === String(tail.fg_next_rev_stop_time));
    if (!next) throw new Error("Hubup next revised call is missing");
    for (const call of calls) {
      if (Number(call.stop_sequence) < Number(next.stop_sequence)) continue;
      const stopId = stops.get(String(call.rev_stop_id));
      if (!stopId) throw new Error("Hubup revised stop identity is missing");
      const predictedTime =
        callTime(call.arrival_time, tail.unix * 1000, timeZone) + tail.fg_lateness * 60000;
      if (predictedTime < now) continue;
      arrivals.push({
        tripId,
        vehicleId,
        routeId,
        stopId,
        directionId: 0,
        directionInferred: true,
        stopSequence: Number(call.stop_sequence),
        predictedTime,
        delaySeconds: tail.fg_lateness * 60,
        scheduleRelationship: "SCHEDULED",
        isRealtime: true,
      });
    }
  }
  return { vehicles: [...vehicles.values()], arrivals };
}
export async function fetchHubupRealtime(
  feed: Feed,
  options: VendorOptions & RealtimeFetchOptions,
) {
  const now = (options.now ?? Date.now)();
  const budget = Math.max(0, Math.floor(options.maxSubrequests ?? 12));
  if (budget < 1) return { arrivals: [], vehicles: [], partial: true };
  // A stable request body lets the shared cadence cache reuse this network read.
  const window = Math.floor(now / 30000) * 30 - 180;
  const raw = await readVendorDocument(options, feed.tailsUrl, {
    body: { company_tags: [feed.companyTag], min_unix: window },
    interval: feed.pollIntervalSeconds ?? 30,
  });
  const tails = Schema.decodeUnknownSync(tailsSchema)(raw);
  const scoped = tails.filter(
    (r) =>
      r.company_tag.toLowerCase() === feed.companyTag.toLowerCase() &&
      (!options.routeIds?.size ||
        !r.theo_ref ||
        options.routeIds.has(String(r.theo_ref.real_route_id))),
  );
  if (scoped.length && !scoped.some((r) => fresh(r.tail.unix, now)))
    throw new Error("Hubup observations are stale");
  const selected = scoped.filter(
    (r) =>
      r.company_tag.toLowerCase() === feed.companyTag.toLowerCase() &&
      r.theo_ref &&
      fresh(r.tail.unix, now) &&
      (!options.routeIds?.size || options.routeIds.has(String(r.theo_ref.real_route_id))),
  );
  const revIds = [
    ...new Set(
      selected
        .filter((r) => r.tail.fg_lateness != null && r.tail.fg_next_rev_stop_time)
        .map((r) => String(r.theo_ref!.rev_trip_id)),
    ),
  ];
  let details: unknown = { rev_stop_times: [], rev_stops: [], stops: [] };
  const incomplete = !options.vehiclesOnly && revIds.length > 0 && budget < 2;
  if (!options.vehiclesOnly && revIds.length && !incomplete)
    details = await readVendorDocument(
      options,
      `${feed.url}/exposed/gtfs/rev/trips/fetch/details`,
      { body: { rev_trip_ids: revIds }, interval: 300 },
    );
  const data = decodeHubupRealtime(
    options.vehiclesOnly || incomplete
      ? selected.map((r) => ({ ...r, tail: { ...r.tail, fg_lateness: null } }))
      : selected,
    details,
    feed.companyTag,
    feed.timeZone,
    now,
  );

  return {
    ...data,
    arrivals: data.arrivals.filter(
      (a) =>
        (!options.stopIds?.size || options.stopIds.has(a.stopId!)) &&
        (!options.stopIdsByRoute?.get(a.routeId)?.size ||
          options.stopIdsByRoute.get(a.routeId)!.has(a.stopId!)),
    ),
    partial: incomplete,
  };
}
export async function fetchHubupArrivals(
  feed: Feed,
  options: VendorOptions & RealtimeFetchOptions,
) {
  const { arrivals, partial } = await fetchHubupRealtime(feed, options);
  return { arrivals, partial };
}
export function createHubupRealtimeSource(
  options: VendorOptions & { readonly agencyId: string; readonly feed: Feed },
): RealtimeSource {
  return {
    fetchRealtime: (_topology, filter) =>
      Effect.tryPromise({
        try: async () => ({
          agencyId: options.agencyId,
          updatedAt: (options.now ?? Date.now)(),
          ...(await fetchHubupRealtime(options.feed, { ...options, ...filter })),
        }),
        catch: (cause) =>
          new RealtimeError({
            agencyId: options.agencyId,
            message: "Hubup realtime unavailable",
            cause,
          }),
      }),
  };
}
