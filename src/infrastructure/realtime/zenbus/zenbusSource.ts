import type { RealtimeFeedConfig, SchematicStationIndexEntry } from "~/agencies/types";
import {
  createNetworkTrainsRealtimeSource,
  createNetworkTrainsStationsSource,
  type NetworkTrainProtocol,
} from "../networkTrains";
import { decodeZenbusDocument } from "./zenbusDecoder";
type Feed = Extract<RealtimeFeedConfig, { kind: "zenbus" }>;
interface Options {
  readonly agencyId: string;
  readonly feed: Feed;
  readonly fetch: typeof fetch;
  readonly now?: () => number;
  readonly getSecret?: (name: string) => string | undefined;
  readonly devProxyOrigin?: string;
}
const protocol = (feed: Feed): NetworkTrainProtocol => ({
  routeType: "bus",
  decode: (bytes, now) => decodeZenbusDocument(bytes, feed.gtfsIndex, now),
  label: (arrival) => `${arrival.routeId} → ${arrival.headsign}`,
});
export function createZenbusRealtimeSource(options: Options) {
  return createNetworkTrainsRealtimeSource({ ...options, protocol: protocol(options.feed) });
}
export function createZenbusStationsSource(
  options: Options & {
    readonly stations: readonly SchematicStationIndexEntry[];
    readonly routeLineMap?: Readonly<Record<string, string>>;
  },
) {
  return createNetworkTrainsStationsSource({ ...options, protocol: protocol(options.feed) });
}
