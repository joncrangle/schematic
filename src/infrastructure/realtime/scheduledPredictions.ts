import * as Effect from "effect/Effect";
import type { SourceAgencyScopeLookup } from "~/domain/surface/boarding";
import {
  scheduledStopKey,
  type ScheduledStopLookup,
  type ScheduledStopTime,
  type ScheduledStopRequest,
} from "~/domain/surface/scheduledStopTimes";
import { namespaceFeedId } from "../gtfs/feedIdentity";
import { ProtobufReader } from "./ProtobufReader";
import { walkFeedMessage } from "./feedMessageWalk";
import { decodeTripDescriptor, decodeStopTimeEvent } from "./gtfsTripDescriptor";

export interface PredictionIdentityOptions {
  readonly tripDirectionExtension?: import("~/agencies/types").TripDirectionExtension;
  readonly idNamespace?: string;
  readonly stopAliases?: ReadonlyMap<string, string>;
  readonly scheduledStops?: ReadonlyMap<string, ScheduledStopTime>;
}
export function canonicalFeedStopId(value: string, options: PredictionIdentityOptions): string {
  const id = namespaceFeedId(value, options.idNamespace);
  return options.stopAliases?.get(id) ?? id;
}
export function readLiveStopUpdate(reader: ProtobufReader, options: PredictionIdentityOptions) {
  let stopSequence = 0,
    stopId: string | undefined,
    relationship: "SCHEDULED" | "SKIPPED" | "NO_DATA" = "SCHEDULED",
    headsign: string | undefined;
  let arrival: ReturnType<typeof decodeStopTimeEvent> | undefined, departure: typeof arrival;
  while (reader.hasMore()) {
    const tag = reader.readTag();
    if (!tag) break;
    const [field, wire] = tag;
    if (field === 1 && wire === 0) stopSequence = reader.readVarint();
    else if (field === 4 && wire === 2)
      stopId = canonicalFeedStopId(reader.readString(), options) || undefined;
    else if (field === 2 && wire === 2) arrival = decodeStopTimeEvent(reader.readSubReader());
    else if (field === 3 && wire === 2) departure = decodeStopTimeEvent(reader.readSubReader());
    else if (field === 5 && wire === 0) {
      const value = reader.readVarint();
      if (value === 1) relationship = "SKIPPED";
      else if (value === 2) relationship = "NO_DATA";
    } else if (field === 7 && wire === 2) headsign = reader.readString().trim() || undefined;
    else reader.skip(wire);
  }
  return { stopSequence, stopId, relationship, headsign, arrival, departure };
}
export function liveStopPrediction(
  stop: ReturnType<typeof readLiveStopUpdate>,
  trip: ReturnType<typeof decodeTripDescriptor>,
  options: PredictionIdentityOptions,
) {
  if (stop.relationship !== "SCHEDULED") return undefined;
  // Absolute times always win; departure wins over arrival regardless of field order.
  const absolute =
    stop.departure?.predictedTime !== undefined
      ? stop.departure
      : stop.arrival?.predictedTime !== undefined
        ? stop.arrival
        : undefined;
  if (absolute)
    return {
      predictedTime: absolute.predictedTime!,
      delaySeconds: absolute.delaySeconds,
      stopId: stop.stopId,
    };
  if (!trip.tripId || !trip.routeId) return undefined;
  const scheduled = options.scheduledStops?.get(
    scheduledStopKey({
      ...trip,
      tripId: trip.tripId,
      routeId: trip.routeId,
      stopSequence: stop.stopSequence,
      stopId: stop.stopId,
    }),
  );
  if (!scheduled || (stop.stopId && scheduled.stopId !== stop.stopId)) return undefined;
  const event =
    stop.departure?.hasDelay && scheduled.departureTime !== undefined
      ? { live: stop.departure, time: scheduled.departureTime }
      : stop.arrival?.hasDelay && scheduled.arrivalTime !== undefined
        ? { live: stop.arrival, time: scheduled.arrivalTime }
        : undefined;
  return event
    ? {
        predictedTime: event.time + event.live.delaySeconds * 1000,
        delaySeconds: event.live.delaySeconds,
        stopId: scheduled.stopId,
      }
    : undefined;
}
export interface SchedulePreparationOptions {
  readonly tripDirectionExtension?: import("~/agencies/types").TripDirectionExtension;
  readonly emptyTripUpdates?: "error";
  readonly tripRoutes?: ReadonlyMap<string, import("~/domain/surface/boarding").TripRoute>;
  readonly idNamespace?: string;
  readonly predictionTimeSource?: "static-with-delay";
  readonly stopIdAliases?: "static-code";
  readonly getScheduledStopTimes?: ScheduledStopLookup;
  readonly getSourceAgencyScope?: SourceAgencyScopeLookup;
  readonly stopIds?: ReadonlySet<string>;
  readonly routeIds?: ReadonlySet<string>;
}
/** Resolve only explicitly delayed calls at requested stops, before materializing arrivals. */
export function prepareScheduledPredictions(
  bytes: Uint8Array,
  options: SchedulePreparationOptions,
): Effect.Effect<PredictionIdentityOptions, unknown> {
  return Effect.gen(function* () {
    if (options.emptyTripUpdates === "error")
      yield* Effect.try({
        try: () => {
          let found = false;
          walkFeedMessage(bytes, {
            onEntity(entity) {
              while (entity.hasMore()) {
                const tag = entity.readTag();
                if (!tag) break;
                if (tag[0] === 3 && tag[1] === 2) {
                  entity.readSubReader();
                  found = true;
                } else entity.skip(tag[1]);
              }
            },
          });
          if (!found) throw new Error("Trip updates unavailable: upstream feed is empty");
        },
        catch: (cause) => cause,
      });
    const stopAliases = new Map<string, string>();
    if (options.stopIdAliases) {
      if (!options.getSourceAgencyScope)
        return yield* Effect.fail(new Error("Stop identity assets unavailable"));
      const scope = yield* options.getSourceAgencyScope();
      for (const [code, ids] of scope.stopsByCode ?? []) {
        const candidates = options.idNamespace
          ? ids.filter((id) => id.startsWith(options.idNamespace + ":"))
          : ids;
        const alias = namespaceFeedId(code, options.idNamespace);
        if (candidates.length === 1 && !scope.stopIds.has(alias))
          stopAliases.set(alias, candidates[0]);
      }
    }
    const identity = {
      idNamespace: options.idNamespace,
      stopAliases,
      tripDirectionExtension: options.tripDirectionExtension,
    };
    if (options.predictionTimeSource !== "static-with-delay") return identity;
    if (!options.getScheduledStopTimes)
      return yield* Effect.fail(new Error("Static schedule resolver unavailable"));
    const requests = yield* Effect.try(() => {
      const found = new Map<string, ScheduledStopRequest>();
      walkFeedMessage(bytes, {
        onEntity(entity) {
          const pending: ScheduledStopRequest[] = [];
          while (entity.hasMore()) {
            const tag = entity.readTag();
            if (!tag) break;
            if (tag[0] !== 3 || tag[1] !== 2) {
              entity.skip(tag[1]);
              continue;
            }
            const update = entity.readSubReader(),
              stops: ReturnType<typeof readLiveStopUpdate>[] = [];
            let trip: ReturnType<typeof decodeTripDescriptor> | undefined;
            while (update.hasMore()) {
              const field = update.readTag();
              if (!field) break;
              if (field[0] === 1 && field[1] === 2)
                trip = decodeTripDescriptor(
                  update.readSubReader(),
                  options.tripRoutes,
                  options.idNamespace,
                );
              else if (field[0] === 2 && field[1] === 2)
                stops.push(readLiveStopUpdate(update.readSubReader(), identity));
              else update.skip(field[1]);
            }
            if (
              !trip?.tripId ||
              !trip.routeId ||
              trip.canceled ||
              (options.routeIds && !options.routeIds.has(trip.routeId))
            )
              continue;
            for (const stop of stops) {
              if (
                stop.relationship !== "SCHEDULED" ||
                (!stop.arrival?.hasDelay && !stop.departure?.hasDelay) ||
                stop.arrival?.predictedTime !== undefined ||
                stop.departure?.predictedTime !== undefined
              )
                continue;
              if (options.stopIds && stop.stopId && !options.stopIds.has(stop.stopId)) continue;
              pending.push({
                ...trip,
                tripId: trip.tripId,
                routeId: trip.routeId,
                stopId: stop.stopId,
                stopSequence: stop.stopSequence,
              });
            }
          }
          for (const request of pending) found.set(scheduledStopKey(request), request);
        },
      });
      return [...found.values()];
    });
    const scheduledStops = requests.length
      ? yield* options.getScheduledStopTimes(requests)
      : new Map<string, ScheduledStopTime>();
    return { ...identity, scheduledStops };
  });
}
