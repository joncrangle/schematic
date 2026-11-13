import type { RealtimeFeedConfig, SchematicStationIndexEntry } from "~/agencies/types";
import type { RealtimeSource } from "~/domain/surface/realtimeSource";
import type { StationsSource } from "~/domain/surface/stationsSource";
import {
  createNetworkTrainsRealtimeSource,
  createNetworkTrainsStationsSource,
  type NetworkTrainProtocol,
} from "../networkTrains";
import { decodeTrainMapDocument, decryptTrainMapDocument } from "./trainMapDecoder";

export type TrainMapFeed = Extract<RealtimeFeedConfig, { kind: "train_map" }>;
interface SourceOptions {
  readonly agencyId: string;
  readonly feed: TrainMapFeed;
  readonly fetch: typeof fetch;
  readonly now?: () => number;
  readonly getSecret?: (name: string) => string | undefined;
  readonly devProxyOrigin?: string;
}

const protocol = (feed: TrainMapFeed): NetworkTrainProtocol => ({
  prepare: (wire) => decryptTrainMapDocument(wire, feed.decryption),
  decode: (bytes, now) => decodeTrainMapDocument(bytes, feed.gtfsIndex, feed.recordTimeZone, now),
});

export function createTrainMapRealtimeSource(options: SourceOptions): RealtimeSource {
  return createNetworkTrainsRealtimeSource({ ...options, protocol: protocol(options.feed) });
}

export function createTrainMapStationsSource(
  options: SourceOptions & {
    readonly stations: readonly SchematicStationIndexEntry[];
    readonly routeLineMap?: Readonly<Record<string, string>>;
  },
): StationsSource {
  return createNetworkTrainsStationsSource({ ...options, protocol: protocol(options.feed) });
}
