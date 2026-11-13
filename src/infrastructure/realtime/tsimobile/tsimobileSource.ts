import type { RealtimeFeedConfig, SchematicStationIndexEntry } from "~/agencies/types";
import type { RealtimeSource } from "~/domain/surface/realtimeSource";
import type { StationsSource } from "~/domain/surface/stationsSource";
import {
  createNetworkTrainsRealtimeSource,
  createNetworkTrainsStationsSource,
  type NetworkTrainProtocol,
} from "../networkTrains";
import { decodeTsimobileDocument } from "./tsimobileDecoder";

export type TsimobileFeed = Extract<RealtimeFeedConfig, { kind: "tsimobile" }>;
interface SourceOptions {
  readonly agencyId: string;
  readonly feed: TsimobileFeed;
  readonly fetch: typeof fetch;
  readonly now?: () => number;
  readonly getSecret?: (name: string) => string | undefined;
  readonly devProxyOrigin?: string;
}

const protocol = (feed: TsimobileFeed): NetworkTrainProtocol => ({
  wireFormat: "json",
  decode: (bytes, now) => decodeTsimobileDocument(bytes, feed.gtfsIndex, now),
});

export function createTsimobileRealtimeSource(options: SourceOptions): RealtimeSource {
  return createNetworkTrainsRealtimeSource({ ...options, protocol: protocol(options.feed) });
}

export function createTsimobileStationsSource(
  options: SourceOptions & {
    readonly stations: readonly SchematicStationIndexEntry[];
    readonly routeLineMap?: Readonly<Record<string, string>>;
  },
): StationsSource {
  return createNetworkTrainsStationsSource({ ...options, protocol: protocol(options.feed) });
}
