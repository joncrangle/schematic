import * as Schema from "effect/Schema";
import type { TsimobileGtfsIndex } from "~/agencies/types";
import type { ArrivalPrediction, LiveVehiclePosition } from "~/domain/surface/types";
import { calculateFreshness } from "~/domain/freshness";

const TimeSchema = Schema.Struct({
  scheduled: Schema.String,
  estimated: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
});
const StopSchema = Schema.Struct({
  station: Schema.String,
  code: Schema.String,
  tz: Schema.String,
  scheduled: Schema.String,
  estimated: Schema.String,
  eta: Schema.String,
  arrival: Schema.optional(TimeSchema),
  departure: Schema.optional(TimeSchema),
  diff: Schema.optional(
    Schema.Union([Schema.Literal("goo"), Schema.Literal("med"), Schema.Literal("bad")]),
  ),
  diffMin: Schema.optional(Schema.Number),
  cancelled: Schema.optional(Schema.Boolean),
  replaced: Schema.optional(Schema.Unknown),
});
const TrainSchema = Schema.Struct({
  instance: Schema.String,
  departed: Schema.Boolean,
  arrived: Schema.Boolean,
  from: Schema.String,
  to: Schema.String,
  times: Schema.Array(StopSchema),
  lat: Schema.optional(Schema.Union([Schema.Number, Schema.Null, Schema.String])),
  lng: Schema.optional(Schema.Union([Schema.Number, Schema.Null, Schema.String])),
  speed: Schema.optional(Schema.Number),
  direction: Schema.optional(Schema.Union([Schema.Number, Schema.Null])),
  poll: Schema.optional(Schema.String),
  pollMin: Schema.optional(Schema.Number),
});
const DocumentSchema = Schema.Record(Schema.String, TrainSchema).check(
  Schema.makeFilter((document) =>
    Object.keys(document).length > 0
      ? undefined
      : "Empty network document has not been established as a valid quiet feed",
  ),
);

export interface TsimobileSnapshot {
  readonly vehicles: readonly LiveVehiclePosition[];
  readonly arrivals: readonly ArrivalPrediction[];
}

function epoch(value: string): number | undefined {
  if (value === "&mdash;") return undefined;
  // The wire includes an offset. Never reinterpret a stop in the server zone.
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value))
    throw new Error(`Invalid tsimobile time: ${value}`);
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`Invalid tsimobile time: ${value}`);
  return time;
}

/** Wire decoding only: source timestamps, GTFS identities, and boarding times. */
export function decodeTsimobileDocument(
  bytes: Uint8Array,
  index: TsimobileGtfsIndex,
  now: number,
): TsimobileSnapshot {
  const document = Schema.decodeUnknownSync(DocumentSchema)(
    JSON.parse(new TextDecoder().decode(bytes)),
  );
  const vehicles: LiveVehiclePosition[] = [];
  const arrivals: ArrivalPrediction[] = [];
  for (const [key, train] of Object.entries(document)) {
    const match = /^(\d+)(?: \(\d{2}-\d{2}\))?$/.exec(key);
    if (!match || !/^\d{4}-\d{2}-\d{2}$/.test(train.instance))
      throw new Error(`Invalid tsimobile train identity: ${key}`);
    if (!train.departed || train.arrived) continue;
    const number = match[1];
    const timestamp = train.poll ? epoch(train.poll) : undefined;
    // Missing fixes and frozen retained instances cannot establish live predictions.
    if (timestamp === undefined || now - timestamp > 15 * 60_000 || timestamp > now + 60_000)
      continue;
    const trip = index.trains[number];
    if (!trip)
      throw new Error(`Active train ${number} is missing from the GTFS index; reseed topology`);
    const identity = `${number}:${train.instance}`;
    const freshness = calculateFreshness(now, timestamp).state;
    if (typeof train.lat === "number" && typeof train.lng === "number") {
      if (
        !Number.isFinite(train.lat) ||
        !Number.isFinite(train.lng) ||
        Math.abs(train.lat) > 90 ||
        Math.abs(train.lng) > 180
      )
        throw new Error(`Invalid train position: ${key}`);
      vehicles.push({
        vehicleId: identity,
        tripId: identity,
        routeId: trip.routeId,
        directionId: trip.directionId,
        latitude: train.lat,
        longitude: train.lng,
        bearing: train.direction ?? undefined,
        speed: train.speed === undefined ? undefined : train.speed / 3.6,
        timestamp,
        freshness: freshness === "unavailable" ? "stale" : freshness,
      });
    }
    for (const [sequence, stop] of train.times.entries()) {
      if (!stop.departure || stop.cancelled || stop.replaced || stop.eta === "ARR") continue;
      const predictedTime = stop.departure.estimated ? epoch(stop.departure.estimated) : undefined;
      if (predictedTime === undefined || predictedTime <= now) continue;
      const stopId = index.stops[stop.code];
      if (!stopId)
        throw new Error(
          `Station code ${stop.code} is missing from the GTFS index; reseed topology`,
        );
      const scheduled = epoch(stop.departure.scheduled);
      if (scheduled === undefined) throw new Error(`Missing scheduled departure: ${stop.code}`);
      arrivals.push({
        tripId: identity,
        vehicleId: identity,
        routeId: trip.routeId,
        directionId: trip.directionId,
        stopSequence: sequence + 1,
        stopId,
        predictedTime,
        delaySeconds: (predictedTime - scheduled) / 1000,
        scheduleRelationship: "SCHEDULED",
        isRealtime: true,
        headsign: trip.headsign,
        freshness: freshness === "unavailable" ? "stale" : freshness,
      });
    }
  }
  return { vehicles, arrivals };
}
