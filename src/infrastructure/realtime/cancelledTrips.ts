import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { FeedAccept, FeedAuth } from "~/agencies/types";
import { alertEffectName } from "~/domain/alerts/rules";
import { logger } from "~/infrastructure/logging/logger";
import { redactFeedUrl } from "./feedAuth";
import { fetchDecodedFeeds, type FetchDecodedFeedsOptions } from "./fetchDecodedFeeds";
import { decodeGtfsRealtimeFeed, type DecodedFeed } from "./gtfsRealtimeDecoder";

/** The cancellation alerts feed could not be fetched or decoded. */
export class CancelledTripsFetchError extends Data.TaggedError("CancelledTripsFetchError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Where an agency's GTFS-RT alerts name the trips it has cancelled. */
export interface CancelledTripsSource {
  readonly url: string;
  readonly auth?: FeedAuth | undefined;
  readonly accept?: FeedAccept | undefined;
}

/** The cancellation sources the given trip feeds declare through `cancelledTripsFrom`. */
export function cancelledTripsSources(
  feeds: readonly {
    readonly cancelledTripsFrom?: string | undefined;
    readonly auth?: FeedAuth | undefined;
    readonly accept?: FeedAccept | undefined;
  }[],
): readonly CancelledTripsSource[] {
  return feeds.flatMap((feed) =>
    feed.cancelledTripsFrom
      ? [{ url: feed.cancelledTripsFrom, auth: feed.auth, accept: feed.accept }]
      : [],
  );
}

/**
 * The trips a decoded alerts feed cancels now: every trip named by an alert
 * whose effect is `NO_SERVICE` and which is in force at `now`. An operator whose
 * trip feed keeps predicting a trip its alerts have cancelled is the reason; the
 * standard `schedule_relationship: CANCELED` is handled by the trip decoders.
 */
export function activeCancelledTripIds(feed: DecodedFeed, now: number): ReadonlySet<string> {
  const cancelled = new Set<string>();
  for (const alert of feed.alerts) {
    if (alertEffectName(alert.effect) !== "NO_SERVICE") continue;
    // Only an alert in force now cancels: trip ids repeat across days, so one
    // published for tomorrow must not remove today's predictions.
    if (now < alert.startsAt || (alert.endsAt !== undefined && now >= alert.endsAt)) continue;
    for (const tripId of alert.tripIds ?? []) cancelled.add(tripId);
  }
  return cancelled;
}

/** Predictions with the cancelled trips removed. */
export function dropCancelledTrips<T extends { readonly tripId: string }>(
  predictions: readonly T[],
  cancelled: ReadonlySet<string>,
): readonly T[] {
  return cancelled.size === 0
    ? predictions
    : predictions.filter((prediction) => !cancelled.has(prediction.tripId));
}

/**
 * Reads the cancelled trips of every distinct source. This fails open: a source
 * that cannot be read contributes nothing and is logged, so predictions fall
 * back to the trip feed alone and a cancellation feed outage never takes
 * departures down with it.
 */
export function fetchCancelledTripIds(
  sources: readonly CancelledTripsSource[],
  options: FetchDecodedFeedsOptions,
  now: () => number,
): Effect.Effect<ReadonlySet<string>, never> {
  const distinct = [...new Map(sources.map((source) => [source.url, source])).values()];
  if (distinct.length === 0) return Effect.succeed(new Set<string>());
  return fetchDecodedFeeds(
    distinct.map((source) => ({
      url: source.url,
      auth: source.auth,
      format: "protobuf" as const,
      accept: source.accept,
      decode: (bytes: Uint8Array) =>
        decodeGtfsRealtimeFeed(bytes).pipe(
          Effect.tap((feed) =>
            Effect.sync(() => {
              if (feed.droppedEntities !== undefined) {
                logger.warn("cancelled-trip feed skipped malformed entities", {
                  source: redactFeedUrl(source.url),
                  droppedEntities: feed.droppedEntities,
                });
              }
            }),
          ),
          Effect.map((feed) => activeCancelledTripIds(feed, now())),
        ),
      mapError: (cause: unknown) =>
        new CancelledTripsFetchError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    })),
    options,
  ).pipe(
    Effect.map(({ usable, firstError }) => {
      if (firstError !== undefined) {
        logger.warn("cancelled-trip alerts unavailable; predictions are not filtered", {
          source: distinct.map((source) => redactFeedUrl(source.url)),
          cause: firstError.message,
        });
      }
      return new Set(usable.flatMap((tripIds) => [...tripIds]));
    }),
  );
}
