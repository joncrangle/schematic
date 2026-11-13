import {
  readLiveStopUpdate,
  liveStopPrediction,
  type PredictionIdentityOptions,
} from "./scheduledPredictions";
import { namespaceFeedId } from "../gtfs/feedIdentity";
import type { TripRoute } from "~/domain/surface/boarding";
import { decodeTripDescriptor, cancelledTripIds } from "./gtfsTripDescriptor";
import type { ArrivalPrediction } from "~/domain/surface/types";
import { ProtobufReader } from "./ProtobufReader";
import { walkFeedMessage } from "./feedMessageWalk";

/**
 * Minimal GTFS-RT TripUpdate decoder for station panels.
 *
 * The general decoder also materializes vehicles, alerts, and a validated
 * generic feed envelope. Station panels need none of those values; keeping
 * this path narrow is important on Workers Free, where a cold full decode can
 * exceed the 10 ms CPU budget before the response is assembled.
 */
export function decodeStationTripUpdates(
  bytes: Uint8Array,
  relevantStopIds?: ReadonlySet<string>,
  tripRoutes?: ReadonlyMap<string, TripRoute>,
  options: PredictionIdentityOptions = {},
): readonly ArrivalPrediction[] {
  const arrivals: ArrivalPrediction[] = [];

  walkFeedMessage(bytes, {
    onEntity: (entity) => {
      // Commit only a fully parsed entity, so a malformed one adds no arrivals.
      const entityArrivals: ArrivalPrediction[] = [];
      decodeEntity(entity, entityArrivals, relevantStopIds, tripRoutes, options);
      arrivals.push(...entityArrivals);
    },
  });

  const cancelled = cancelledTripIds(bytes, options.idNamespace);
  return arrivals.filter((arrival) => !cancelled.has(arrival.tripId));
}

function decodeEntity(
  reader: ProtobufReader,
  arrivals: ArrivalPrediction[],
  relevantStopIds: ReadonlySet<string> | undefined,
  tripRoutes?: ReadonlyMap<string, TripRoute>,
  options: PredictionIdentityOptions = {},
): void {
  let entityId = "";

  while (reader.hasMore()) {
    const tag = reader.readTag();
    if (!tag) break;
    const [fieldNum, wireType] = tag;
    if (fieldNum === 1 && wireType === 2) {
      entityId = namespaceFeedId(reader.readString(), options.idNamespace);
    } else if (fieldNum === 3 && wireType === 2) {
      decodeTripUpdate(
        reader.readSubReader(),
        entityId,
        arrivals,
        relevantStopIds,
        tripRoutes,
        options,
      );
    } else {
      reader.skip(wireType);
    }
  }
}

function decodeTripUpdate(
  reader: ProtobufReader,
  entityId: string,
  arrivals: ArrivalPrediction[],
  relevantStopIds: ReadonlySet<string> | undefined,
  tripRoutes?: ReadonlyMap<string, TripRoute>,
  options: PredictionIdentityOptions = {},
): void {
  let tripId = entityId;
  let routeId = "";
  let directionId: number | undefined;
  let canceled = false;
  const stopUpdates: ReturnType<typeof readLiveStopUpdate>[] = [];
  let descriptor: ReturnType<typeof decodeTripDescriptor> | undefined;

  while (reader.hasMore()) {
    const tag = reader.readTag();
    if (!tag) break;
    const [fieldNum, wireType] = tag;
    if (fieldNum === 1 && wireType === 2) {
      const value = decodeTripDescriptor(
        reader.readSubReader(),
        tripRoutes,
        options.idNamespace,
        options.tripDirectionExtension,
      );
      descriptor = value;
      tripId = value.tripId ?? tripId;
      routeId = value.routeId ?? routeId;
      directionId = value.directionId;
      canceled = value.canceled;
    } else if (fieldNum === 2 && wireType === 2) {
      const stopUpdate = readLiveStopUpdate(reader.readSubReader(), options);
      if (stopUpdate) stopUpdates.push(stopUpdate);
    } else {
      reader.skip(wireType);
    }
  }

  const normalizedTripId = tripId.trim();
  const normalizedRouteId = routeId.trim();
  if (canceled || !normalizedTripId || !normalizedRouteId) return;

  const resolvedDirectionId = (directionId === 0 || directionId === 1 ? directionId : 0) as 0 | 1;
  const rawDirection = entityId.split("|").at(-1)?.trim().toLowerCase();
  const hasEntityDirection =
    rawDirection === "north" ||
    rawDirection === "south" ||
    rawDirection === "east" ||
    rawDirection === "west";
  const directionInferred = directionId === undefined && !hasEntityDirection;

  for (const stop of stopUpdates) {
    const prediction = descriptor && liveStopPrediction(stop, descriptor, options);
    if (
      !prediction ||
      (relevantStopIds && (!prediction.stopId || !relevantStopIds.has(prediction.stopId)))
    )
      continue;
    arrivals.push({
      tripId: normalizedTripId,
      routeId: normalizedRouteId,
      directionId: resolvedDirectionId,
      stopSequence: stop.stopSequence,
      ...prediction,
      scheduleRelationship: stop.relationship,
      isRealtime: true,
      rawEntityId: entityId.trim() || undefined,
      ...(directionInferred ? { directionInferred: true } : {}),
      ...(stop.headsign === undefined ? {} : { headsign: stop.headsign }),
    });
  }
}
