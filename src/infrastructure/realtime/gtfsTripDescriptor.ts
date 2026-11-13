import { namespaceFeedId } from "../gtfs/feedIdentity";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { TripRoute, TripRouteLookup } from "~/domain/surface/boarding";
import { ProtobufReader } from "./ProtobufReader";
import { walkFeedMessage } from "./feedMessageWalk";

/** Standard TripDescriptor, including the ModifiedTripSelector introduced in GTFS-RT. */
export function decodeTripDescriptor(
  reader: ProtobufReader,
  tripRoutes?: ReadonlyMap<string, TripRoute>,
  idNamespace?: string,
) {
  let tripId: string | undefined;
  let affectedTripId: string | undefined;
  let routeId: string | undefined;
  let directionId: number | undefined;
  let canceled = false;
  let startDate: string | undefined, startTime: string | undefined;
  while (reader.hasMore()) {
    const tag = reader.readTag();
    if (!tag) break;
    const [field, wire] = tag;
    if (field === 1 && wire === 2) tripId = reader.readString().trim() || undefined;
    else if (field === 2 && wire === 2) startTime = reader.readString().trim() || undefined;
    else if (field === 3 && wire === 2) startDate = reader.readString().trim() || undefined;
    else if (field === 5 && wire === 2) routeId = reader.readString().trim() || undefined;
    else if (field === 6 && wire === 0) directionId = reader.readVarint();
    else if (field === 4 && wire === 0) canceled = reader.readVarint() === 3;
    else if (field === 7 && wire === 2) {
      const selector = reader.readSubReader();
      while (selector.hasMore()) {
        const nested = selector.readTag();
        if (!nested) break;
        if (nested[0] === 2 && nested[1] === 2)
          affectedTripId = selector.readString().trim() || undefined;
        else selector.skip(nested[1]);
      }
    } else reader.skip(wire);
  }
  tripId ??= affectedTripId;
  tripId = tripId ? namespaceFeedId(tripId, idNamespace) : undefined;
  routeId = routeId ? namespaceFeedId(routeId, idNamespace) : undefined;
  affectedTripId = affectedTripId ? namespaceFeedId(affectedTripId, idNamespace) : undefined;
  const joined = tripId ? tripRoutes?.get(tripId) : undefined;
  return {
    tripId,
    routeId: routeId ?? joined?.routeId,
    directionId: joined?.directionId ?? directionId,
    canceled,
    affectedTripId,
    startDate,
    startTime,
  };
}

/** The trip lookup or the walk of the feed bytes behind an alert's trips failed. */
export class AlertTripRoutesError extends Data.TaggedError("AlertTripRoutesError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

type TripDescriptor = ReturnType<typeof decodeTripDescriptor>;

/**
 * Decodes every trip descriptor reached by the given field paths below a feed
 * entity, such as `[3, 1]` (TripUpdate.trip) or `[5, 5, 4]` (Alert
 * informed_entity.trip). One walk serves every consumer that needs trip ids.
 */
function collectTripDescriptors(
  bytes: Uint8Array,
  paths: readonly (readonly number[])[],
  idNamespace?: string,
): TripDescriptor[] {
  const descriptors: TripDescriptor[] = [];
  const walk = (
    reader: ProtobufReader,
    remaining: readonly (readonly number[])[],
    found: TripDescriptor[],
  ): void => {
    while (reader.hasMore()) {
      const tag = reader.readTag();
      if (!tag) break;
      const matching = remaining.filter((path) => path[0] === tag[0]);
      if (matching.length === 0 || tag[1] !== 2) {
        reader.skip(tag[1]);
        continue;
      }
      const sub = reader.readSubReader();
      const deeper = matching.map((path) => path.slice(1));
      if (deeper.some((path) => path.length === 0))
        found.push(decodeTripDescriptor(sub, undefined, idNamespace));
      else walk(sub, deeper, found);
    }
  };
  // An entity that fails to parse contributes no descriptors. Decoding the
  // feed itself reports the same entity, so this walk only has to be tolerant.
  walkFeedMessage(bytes, {
    onEntity: (entity) => {
      const found: TripDescriptor[] = [];
      walk(entity, paths, found);
      descriptors.push(...found);
    },
  });
  return descriptors;
}

/** Resolve missing modified routes and explicitly requested static trip directions. */
export function resolveTripRoutes(
  bytes: Uint8Array,
  lookup?: TripRouteLookup,
  tripDirectionSource?: "static",
  idNamespace?: string,
): Effect.Effect<ReadonlyMap<string, TripRoute> | undefined, unknown> {
  if (!lookup) return Effect.succeed(undefined);
  return Effect.try(() => {
    const ids = new Set<string>();
    for (const descriptor of collectTripDescriptors(
      bytes,
      [
        [3, 1],
        [4, 1],
      ],
      idNamespace,
    )) {
      if (
        descriptor.tripId &&
        !descriptor.canceled &&
        (tripDirectionSource === "static" || (descriptor.affectedTripId && !descriptor.routeId))
      )
        ids.add(descriptor.tripId);
    }
    return [...ids];
  }).pipe(
    Effect.flatMap((ids) =>
      ids.length > 0
        ? lookup(ids)
        : Effect.succeed(
            tripDirectionSource === "static" ? new Map<string, TripRoute>() : undefined,
          ),
    ),
  );
}

/**
 * Resolves the routes of trips that alerts name in `informed_entity.trip` without
 * a route of their own. Failures are `AlertTripRoutesError`, so the caller decides
 * whether an unattributed alert is acceptable.
 */
export function resolveAlertTripRoutes(
  bytes: Uint8Array,
  lookup?: TripRouteLookup,
  idNamespace?: string,
): Effect.Effect<ReadonlyMap<string, TripRoute> | undefined, AlertTripRoutesError> {
  if (!lookup) return Effect.succeed(undefined);
  const toError = (cause: unknown) =>
    new AlertTripRoutesError({
      message: cause instanceof Error ? cause.message : "Alert trip routes unavailable",
      cause,
    });
  return Effect.try({
    try: () => {
      const ids = new Set<string>();
      for (const trip of collectTripDescriptors(bytes, [[5, 5, 4]], idNamespace)) {
        if (trip.tripId && !trip.routeId) ids.add(trip.tripId);
      }
      return [...ids];
    },
    catch: toError,
  }).pipe(
    Effect.flatMap((ids) =>
      ids.length > 0 ? Effect.mapError(lookup(ids), toError) : Effect.succeed(undefined),
    ),
  );
}

/** Delay belongs to the selected event, even when arrival/departure fields are reordered. */
export function decodeStopTimeEvent(reader: ProtobufReader) {
  let time: number | undefined;
  let scheduledTime: number | undefined;
  let delay = 0;
  let hasDelay = false;
  while (reader.hasMore()) {
    const tag = reader.readTag();
    if (!tag) break;
    const [field, wire] = tag;
    if (field === 1 && wire === 0) {
      delay = reader.readInt32();
      hasDelay = true;
    } else if (field === 2 && wire === 0) {
      const value = reader.readInt64();
      if (value > 0) time = value;
    } else if (field === 4 && wire === 0) {
      const value = reader.readInt64();
      if (value > 0) scheduledTime = value;
    } else reader.skip(wire);
  }
  return {
    hasDelay,
    predictedTime: time === undefined ? undefined : time * 1000,
    delaySeconds: time !== undefined && scheduledTime !== undefined ? time - scheduledTime : delay,
  };
}

/** A cancellation wins across duplicate TripUpdate entities regardless of their order. */
export function cancelledTripIds(bytes: Uint8Array, idNamespace?: string): ReadonlySet<string> {
  return new Set(
    collectTripDescriptors(bytes, [[3, 1]], idNamespace)
      .filter((d) => d.canceled && d.tripId)
      .map((d) => d.tripId!),
  );
}
