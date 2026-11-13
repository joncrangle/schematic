import * as Schema from "effect/Schema";
import type { RealtimeFeedConfig, StationTimetablesSource } from "~/agencies/types";

/** Departure and arrival boards; the API refuses windows longer than 36 hours. */
export const TIMETABLE_BOARDS = ["departures", "arrivals"] as const;
export const MAX_BOARD_WINDOW_MS = 36 * 3_600_000;

const OptionalText = Schema.optional(Schema.NullOr(Schema.String));
const DeviationSchema = Schema.Struct({
  deviation_timestamp: OptionalText,
  deviation_seconds: Schema.optional(Schema.NullOr(Schema.Number)),
  deviation_class: OptionalText,
  deviation_type: OptionalText,
  updated_at: OptionalText,
});
const EventSchema = Schema.Struct({
  scheduled: OptionalText,
  deviation: Schema.optional(Schema.NullOr(DeviationSchema)),
});
const CoordinatesSchema = Schema.Struct({ latitude: Schema.Number, longitude: Schema.Number });

export const CallSchema = Schema.Struct({
  sequence: Schema.Number,
  stop: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    code: OptionalText,
    city: Schema.optional(Schema.NullOr(Schema.Struct({ name: Schema.String }))),
    location: CoordinatesSchema,
  }),
  arrival: Schema.optional(Schema.NullOr(EventSchema)),
  departure: Schema.optional(Schema.NullOr(EventSchema)),
});
export type TimetableCall = Schema.Schema.Type<typeof CallSchema>;

export const RideSchema = Schema.Struct({
  id: Schema.String,
  line: Schema.Struct({
    code: Schema.String,
    name: Schema.String,
    direction: OptionalText,
  }),
  vehicle: Schema.optional(Schema.NullOr(Schema.Struct({ id: OptionalText }))),
  location: Schema.optional(
    Schema.NullOr(Schema.Struct({ coordinates: CoordinatesSchema, updated_at: OptionalText })),
  ),
  calls: Schema.Array(CallSchema),
});
export type TimetableRide = Schema.Schema.Type<typeof RideSchema>;

/** A board must at least carry its ride list; each ride is decoded on its own. */
export const BoardSchema = Schema.Struct({ rides: Schema.Array(Schema.Unknown) });

export function boardUrl(
  template: string,
  station: string,
  board: (typeof TIMETABLE_BOARDS)[number],
  from: number,
  to: number,
): string {
  const iso = (time: number) => new Date(time).toISOString().replace(/\.\d{3}Z$/u, "Z");
  return template
    .replace("{station}", encodeURIComponent(station))
    .replace("{board}", board)
    .replace("{from}", encodeURIComponent(iso(from)))
    .replace("{to}", encodeURIComponent(iso(to)));
}

/** Stop ownership comes from the region code ending the published city name, such as `ON`. */
export function ownsStop(call: TimetableCall, source: StationTimetablesSource): boolean {
  // Some cities spell the code with periods, such as `Washington, D.C.`.
  const region = /,\s*((?:[A-Za-z]\.?){2})\s*$/u
    .exec(call.stop.city?.name ?? "")?.[1]
    ?.replace(/\./gu, "")
    .toUpperCase();
  return region !== undefined && source.cityRegions.includes(region);
}

/** Decodes every ride on the given boards once, keeping the first copy of a ride seen twice. */
export function boardRides(boards: readonly unknown[]): {
  readonly rides: readonly TimetableRide[];
  readonly malformed: readonly unknown[];
} {
  const rides = new Map<string, TimetableRide>();
  const malformed: unknown[] = [];
  for (const raw of boards) {
    for (const entry of Schema.decodeUnknownSync(BoardSchema)(raw).rides) {
      try {
        const ride = Schema.decodeUnknownSync(RideSchema)(entry);
        if (!rides.has(ride.id)) rides.set(ride.id, ride);
      } catch (cause) {
        malformed.push(cause);
      }
    }
  }
  return { rides: [...rides.values()], malformed };
}

export type StationTimetablesFeed = Extract<RealtimeFeedConfig, { kind: "station_timetables" }>;

/** Route and headsign as both the archive and the decoder key them, so directions join. */
export function rideLine(ride: TimetableRide): {
  readonly routeId: string;
  readonly headsign: string;
} {
  return {
    routeId: ride.line.code.replace(/^\[(.+)\]$/u, "$1"),
    headsign: ride.line.direction?.trim() || ride.line.name.trim(),
  };
}
