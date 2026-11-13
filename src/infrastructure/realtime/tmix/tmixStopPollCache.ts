import type { AnyRideProfile, FeedAuth } from "~/agencies/types";

/** Identity of one AnyRide GetCalls answer within a request-scoped cache. */
export function tmixStopPollKey(
  feed: {
    readonly url: string;
    readonly profile?: AnyRideProfile | undefined;
    readonly auth?: FeedAuth | undefined;
    readonly devProxyPrefix?: string | undefined;
    readonly format?: string | undefined;
  },
  stopId: string,
): string {
  return JSON.stringify([
    "tmix-getcalls-v1",
    feed.url,
    feed.profile?.data ?? null,
    feed.profile?.display ?? null,
    feed.auth ?? null,
    feed.devProxyPrefix ?? null,
    // The transport defaults AnyRide requests to JSON, so an omitted manifest
    // format and an explicit `json` declaration identify the same poll.
    feed.format?.trim().toLowerCase() || "json",
    stopId,
  ]);
}
