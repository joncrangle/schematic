import type { SchematicStationIndexEntry } from "~/agencies/types";
import type { RealtimeSource } from "~/domain/surface/realtimeSource";
import type { StationsSource } from "~/domain/surface/stationsSource";
import {
  createNetworkTrainsRealtimeSource,
  createNetworkTrainsStationsSource,
  type NetworkTrainProtocol,
} from "../networkTrains";
import { decodeStationTimetablesDocument } from "./stationTimetablesDecoder";
import {
  boardUrl,
  TIMETABLE_BOARDS,
  type StationTimetablesFeed,
} from "./stationTimetablesProtocol";

interface SourceOptions {
  readonly agencyId: string;
  readonly feed: StationTimetablesFeed;
  readonly fetch: typeof fetch;
  readonly now?: () => number;
  readonly getSecret?: (name: string) => string | undefined;
  readonly devProxyOrigin?: string;
}

const HOUR_MS = 3_600_000;

const protocol = (feed: StationTimetablesFeed): NetworkTrainProtocol => ({
  wireFormat: "json",
  // Whole-hour windows keep consecutive refreshes asking for the same boards.
  requestUrls: (now) => {
    const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
    const from = hour - feed.lookbackHours * HOUR_MS;
    const to = hour + (feed.lookaheadHours + 1) * HOUR_MS;
    return feed.stations.flatMap((station) =>
      TIMETABLE_BOARDS.map((board) => boardUrl(feed.url, station, board, from, to)),
    );
  },
  decode: (bytes, now) => decodeStationTimetablesDocument(bytes, feed, now),
  label: (arrival) => `${arrival.routeId} → ${arrival.headsign}`,
});

export function createStationTimetablesRealtimeSource(options: SourceOptions): RealtimeSource {
  return createNetworkTrainsRealtimeSource({ ...options, protocol: protocol(options.feed) });
}

export function createStationTimetablesStationsSource(
  options: SourceOptions & {
    readonly stations: readonly SchematicStationIndexEntry[];
    readonly routeLineMap?: Readonly<Record<string, string>>;
  },
): StationsSource {
  return createNetworkTrainsStationsSource({ ...options, protocol: protocol(options.feed) });
}
