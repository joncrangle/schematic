import type { RealtimeFeedConfig } from "~/agencies/types";

export type NetworkDocumentFeed = Extract<
  RealtimeFeedConfig,
  {
    kind:
      | "zenbus"
      | "tsimobile"
      | "train_map"
      | "station_timetables"
      | "ferry_sailing_boards"
      | "swiftly"
      | "samsara_boards"
      | "cityway"
      | "passio"
      | "hubup"
      | "transloc"
      | "bustime"
      | "tripspark";
  }
>;

/** A network document owns departures; supplemental fleet feeds may add vehicle-only services. */
export function resolveNetworkDocumentFeed(
  feeds: readonly RealtimeFeedConfig[],
): NetworkDocumentFeed | undefined {
  const networkFeed = feeds.map(networkDocumentFeed).find((feed) => feed !== undefined);
  if (networkFeed && feeds.filter((feed) => feed.kind !== "fleet_integrations").length !== 1)
    throw new Error("A network document must be the sole realtime feed");
  return networkFeed;
}

/** Exhaustive format routing: a new kind must get a Core owner before it compiles. */
export function networkDocumentFeed(feed: RealtimeFeedConfig): NetworkDocumentFeed | undefined {
  switch (feed.kind) {
    case "zenbus":
    case "tsimobile":
    case "train_map":
    case "station_timetables":
    case "swiftly":
    case "samsara_boards":
    case "cityway":
    case "passio":
    case "hubup":
    case "transloc":
    case "bustime":
    case "tripspark":
    case "ferry_sailing_boards":
      return feed;
    case "vehicle_positions":
    case "trip_updates":
    case "station_trip_updates":
    case "station_departures":
    case "nextbus":
    case "fleet_integrations":
    case "tmix_anyride":
      return undefined;
    default: {
      const unsupported: never = feed;
      throw new Error(`Unsupported realtime feed: ${String(unsupported)}`);
    }
  }
}
