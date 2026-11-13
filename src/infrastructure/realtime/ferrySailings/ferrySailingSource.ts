import * as Effect from "effect/Effect";
import type { RealtimeFeedConfig, SchematicStationIndexEntry } from "~/agencies/types";
import { RealtimeError, type RealtimeSource } from "~/domain/surface/realtimeSource";
import { StationsError, type StationsSource } from "~/domain/surface/stationsSource";
import type { NearbyStationArrival } from "~/domain/surface/types";
import { calculateHaversineMeters } from "~/domain/map/MapGeometry";
import { calculateWalkingMinutes } from "~/domain/proximity";
import { fetchDecodedFeeds } from "../fetchDecodedFeeds";
import { decodeFerrySailingBoard, type FerrySailing } from "./ferrySailingBoardDecoder";

export type FerrySailingBoardsFeed = Extract<RealtimeFeedConfig, { kind: "ferry_sailing_boards" }>;
type Board = FerrySailingBoardsFeed["boards"][number];
interface SourceOptions {
  readonly agencyId: string;
  readonly feed: FerrySailingBoardsFeed;
  /** Expected to be the provider's polling fetch, which owns the publisher's cadence. */
  readonly fetch: typeof fetch;
  readonly now?: () => number;
  readonly getSecret?: (name: string) => string | undefined;
  readonly devProxyOrigin?: string;
}
interface BoardRead {
  readonly sailings: readonly FerrySailing[];
  readonly stale: boolean;
}

const lastGood = new Map<string, readonly FerrySailing[]>();
// Retain a delayed sailing that has not left, but never a forgotten one from hours ago.
const MAX_OVERDUE_MS = 3 * 60 * 60_000;

function boardUrl(feed: FerrySailingBoardsFeed, board: Board): string {
  return feed.url
    .replace("{terminal}", encodeURIComponent(board.terminal.toLowerCase()))
    .replace("{board}", encodeURIComponent(board.board));
}

/** Reads only the boards a query needs; a failed board reuses its last good read as stale. */
async function readBoards(
  options: SourceOptions,
  boards: readonly Board[],
): Promise<readonly BoardRead[]> {
  const { feed } = options;
  return Promise.all(
    boards.map(async (board) => {
      const url = boardUrl(feed, board);
      const key = JSON.stringify([options.agencyId, url]);
      const result = await Effect.runPromise(
        fetchDecodedFeeds(
          [
            {
              url,
              auth: feed.auth,
              devProxyPrefix: feed.devProxyPrefix,
              format: "json",
              decode: (bytes) =>
                Effect.try(() =>
                  decodeFerrySailingBoard(bytes, {
                    ...board,
                    terminals: feed.terminals,
                    legs: feed.legs,
                    terminalNames: feed.terminalNames,
                    timeZone: feed.timeZone,
                  }),
                ),
              mapError: (cause) => cause,
            },
          ],
          {
            fetch: options.fetch,
            getSecret: options.getSecret,
            devProxyOrigin: options.devProxyOrigin,
            attempts: 2,
            timeoutMs: 8_000,
          },
        ),
      );
      const sailings = result.usable[0];
      if (sailings) {
        lastGood.set(key, sailings);
        return { sailings, stale: false };
      }
      const previous = lastGood.get(key);
      if (previous) return { sailings: previous, stale: true };
      throw result.firstError ?? new Error(`Sailing board ${board.terminal}/${board.board} failed`);
    }),
  );
}

function boardsServing(feed: FerrySailingBoardsFeed, stopIds: ReadonlySet<string>) {
  return feed.boards.filter((board) => stopIds.has(feed.terminals[board.terminal]));
}

function upcoming(sailings: readonly FerrySailing[], now: number) {
  return sailings.filter((sailing) => sailing.scheduledTime >= now - MAX_OVERDUE_MS);
}

export function createFerrySailingRealtimeSource(options: SourceOptions): RealtimeSource {
  const now = options.now ?? Date.now;
  return {
    fetchRealtime: (_topology, filter) =>
      Effect.tryPromise({
        try: async () => {
          const stopIds = new Set([
            ...(filter?.stopIds ?? []),
            ...[...(filter?.stopIdsByRoute?.values() ?? [])].flatMap((stops) => [...stops]),
          ]);
          // There are no vehicle positions, so an unscoped read has nothing to return.
          const reads = await readBoards(options, boardsServing(options.feed, stopIds));
          const matchesRoute = (id: string) => !filter?.routeIds?.size || filter.routeIds.has(id);
          return {
            agencyId: options.agencyId,
            updatedAt: now(),
            vehicles: [],
            arrivals: reads.flatMap(({ sailings, stale }) =>
              upcoming(sailings, now())
                .filter((sailing) => {
                  const stops = filter?.stopIdsByRoute?.get(sailing.routeId) ?? filter?.stopIds;
                  return (
                    matchesRoute(sailing.routeId) && (!stops?.size || stops.has(sailing.stopId))
                  );
                })
                .map((sailing) => ({
                  tripId: sailing.sailingId,
                  routeId: sailing.routeId,
                  directionId: sailing.directionId,
                  stopSequence: 1,
                  stopId: sailing.stopId,
                  predictedTime: sailing.scheduledTime,
                  delaySeconds: 0,
                  scheduleRelationship: "SCHEDULED" as const,
                  isRealtime: false,
                  headsign: sailing.headsign,
                  ...(stale ? { freshness: "stale" as const } : {}),
                })),
            ),
          };
        },
        catch: (cause) =>
          new RealtimeError({
            agencyId: options.agencyId,
            message: "Ferry sailing boards unavailable",
            cause,
          }),
      }),
  };
}

export function createFerrySailingStationsSource(
  options: SourceOptions & {
    readonly stations: readonly SchematicStationIndexEntry[];
    readonly routeLineMap?: Readonly<Record<string, string>>;
  },
): StationsSource {
  const now = options.now ?? Date.now;
  const lineOf = (routeId: string) => options.routeLineMap?.[routeId] ?? routeId;
  const cards = (stations: readonly SchematicStationIndexEntry[], lat?: number, lon?: number) =>
    Effect.tryPromise({
      try: async (): Promise<readonly NearbyStationArrival[]> => {
        if (stations.length === 0) return [];
        const boards = boardsServing(
          options.feed,
          new Set(stations.flatMap((station) => station.platformIds)),
        );
        const reads = await readBoards(options, boards);
        const terminalOf = new Map(boards.map((board, index) => [board, reads[index]]));
        return stations
          .map((station) => {
            const distanceMeters =
              lat === undefined || lon === undefined
                ? 0
                : calculateHaversineMeters(lat, lon, station.lat, station.lon);
            const stationReads = boards
              .filter((board) =>
                station.platformIds.includes(options.feed.terminals[board.terminal]),
              )
              .map((board) => terminalOf.get(board)!);
            const sailings = upcoming(
              stationReads.flatMap((read) => read.sailings),
              now(),
            ).sort((a, b) => a.scheduledTime - b.scheduledTime);
            // One row per destination and status, so a delay notice stays beside its sailing.
            const groups = new Map<string, FerrySailing[]>();
            for (const sailing of sailings) {
              const key = JSON.stringify([sailing.routeId, sailing.headsign, sailing.status]);
              groups.set(key, [...(groups.get(key) ?? []), sailing]);
            }
            return {
              id: station.schematicId ?? station.id,
              stationName: station.name,
              lineIds: station.lines,
              trackingRouteId: sailings[0]?.routeId,
              agencyId: options.agencyId,
              routeType: "ferry",
              lat: station.lat,
              lon: station.lon,
              distanceMeters,
              walkingMinutes: calculateWalkingMinutes(distanceMeters),
              arrivals: [...groups.values()].map((group) => ({
                directionId: group[0].directionId,
                label: group[0].status
                  ? `→ ${group[0].headsign} · ${group[0].status}`
                  : `→ ${group[0].headsign}`,
                lineId: lineOf(group[0].routeId),
                times: group.slice(0, 3).map((sailing) => sailing.scheduledTime),
              })),
              arrivalsStale: stationReads.some((read) => read.stale) ? true : undefined,
              // Some terminals publish no board, so an empty card is not a sailing-free day.
              livePredictionsOnly: true,
            } satisfies NearbyStationArrival;
          })
          .sort((a, b) => a.distanceMeters - b.distanceMeters);
      },
      catch: (cause) =>
        new StationsError({
          agencyId: options.agencyId,
          message: "Ferry sailing boards unavailable",
          cause,
        }),
    });
  return {
    fetchNearby: (query) =>
      cards(
        options.stations.filter(
          (station) =>
            calculateHaversineMeters(query.lat, query.lon, station.lat, station.lon) <=
            query.radiusMeters,
        ),
        query.lat,
        query.lon,
      ),
    fetchSaved: (query) =>
      cards(
        options.stations.filter((station) => query.stationNames.includes(station.name)),
        query.lat,
        query.lon,
      ),
    fetchByIds: (query) =>
      cards(
        options.stations.filter((station) =>
          query.stationIds.includes(station.schematicId ?? station.id),
        ),
        query.lat,
        query.lon,
      ),
  };
}
