import { decodeHTMLAttribute } from "entities";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { RealtimeFeedConfig } from "~/agencies/types";
import {
  RealtimeError,
  type RealtimeSource,
  type RealtimeFetchOptions,
} from "~/domain/surface/realtimeSource";
import type { ArrivalPrediction } from "~/domain/surface/types";
import { parseWallClock } from "../wallClock";
import { readVendorDocument, type VendorOptions } from "../vendorDocument";

type Feed = Extract<RealtimeFeedConfig, { kind: "cityway" }>;
export interface CitywayStopRequest {
  readonly logicalStopId: string;
  readonly physicalStopId: string;
  readonly lineId: string;
  readonly routeId: string;
  readonly direction: 1 | 2;
}
const timeSchema = Schema.Struct({
  TheoreticalTime: Schema.String,
  RealTime: Schema.NullOr(Schema.String),
  Restriction: Schema.optional(Schema.NullOr(Schema.String)),
});
const boardSchema = Schema.Array(
  Schema.Struct({
    VJourneyId: Schema.Number,
    JPatternName: Schema.String,
    VJourneyStatus: Schema.String,
    PassingTimes: Schema.Array(
      Schema.Struct({
        StopId: Schema.Number,
        Order: Schema.Number,
        Departure: Schema.NullOr(timeSchema),
      }),
    ),
  }),
);
export function decodeCitywayBoard(
  body: unknown,
  stopId: string,
  request: CitywayStopRequest,
  timeZone: string,
  now: number,
): ArrivalPrediction[] {
  const rows = Schema.decodeUnknownSync(boardSchema)(body);
  const arrivals: ArrivalPrediction[] = [];
  for (const row of rows) {
    if (row.VJourneyStatus === "Cancelled") continue;
    for (const call of row.PassingTimes) {
      const departure = call.Departure;
      if (
        String(call.StopId) !== request.physicalStopId ||
        !departure ||
        departure.Restriction === "EntryNotAllowed"
      )
        continue;
      const scheduled = parseWallClock(departure.TheoreticalTime.replace("T", " "), timeZone);
      const predictedTime =
        departure.RealTime === null
          ? scheduled
          : parseWallClock(departure.RealTime.replace("T", " "), timeZone);
      if (!Number.isFinite(predictedTime) || !Number.isFinite(scheduled))
        throw new Error("Invalid Cityway departure time");
      if (predictedTime < now) continue;
      arrivals.push({
        tripId: `cityway:${row.VJourneyId}`,
        routeId: request.routeId,
        stopId,
        directionId: request.direction - 1,
        directionAuthoritative: true,
        stopSequence: call.Order,
        predictedTime,
        delaySeconds: (predictedTime - scheduled) / 1000,
        scheduleRelationship: "SCHEDULED",
        isRealtime: departure.RealTime !== null,
        headsign: row.JPatternName,
      });
    }
  }
  return arrivals;
}

/** The operator publishes this key in its rider iframe; discover it again after redeploys. */
export async function citywayHeaders(
  feed: Pick<Feed, "riderPageUrl">,
  options: VendorOptions,
): Promise<Record<string, string>> {
  const page = await readVendorDocument(options, feed.riderPageUrl, { interval: 3600, text: true });
  const key = /[?&]apikey=([^&"\s<>]+)/i.exec(decodeHTMLAttribute(String(page)))?.[1];
  if (!key) throw new Error("Cityway rider page no longer publishes an API key");
  return { apikey: decodeURIComponent(key) };
}
export async function fetchCitywayArrivals(
  feed: Feed,
  options: VendorOptions & RealtimeFetchOptions,
): Promise<{ arrivals: ArrivalPrediction[]; partial: boolean }> {
  const wanted = Object.entries(feed.stopMap).flatMap(([stopId, requests]) =>
    requests
      .filter(
        (r) =>
          (!options.stopIds?.size || options.stopIds.has(stopId)) &&
          (!options.routeIds?.size || options.routeIds.has(r.routeId)) &&
          (!options.stopIdsByRoute?.get(r.routeId)?.size ||
            options.stopIdsByRoute.get(r.routeId)!.has(stopId)),
      )
      .map((request) => ({ stopId, request })),
  );
  const budget = Math.max(0, Math.floor(options.maxSubrequests ?? 40));
  if (!wanted.length) return { arrivals: [], partial: false };
  if (budget < 2) return { arrivals: [], partial: true };
  const headers = await citywayHeaders(feed, options);
  const selected = wanted.slice(0, budget - 1);
  const arrivals: ArrivalPrediction[] = [];
  let failed = 0;
  // Keep the vendor's stop-board fan-out sequential and bounded.
  for (const { stopId, request } of selected) {
    try {
      const url = `${feed.url}/tsvc/api/v5/timetable/byLogicalStop/${encodeURIComponent(request.logicalStopId)}?lineId=${encodeURIComponent(request.lineId)}&direction=${request.direction}&nbStopTimes=4`;
      const body = await readVendorDocument(options, url, {
        headers,
        interval: feed.pollIntervalSeconds ?? 60,
        requestsPerMinute: 60,
        emptyOn204: true,
      });
      arrivals.push(
        ...decodeCitywayBoard(body, stopId, request, feed.timeZone, (options.now ?? Date.now)()),
      );
    } catch {
      failed++;
    }
  }
  if (failed === selected.length) throw new Error("Cityway departure boards unavailable");
  const unique = new Map(
    arrivals.map((a) => [JSON.stringify([a.stopId, a.routeId, a.tripId, a.predictedTime]), a]),
  );
  return { arrivals: [...unique.values()], partial: failed > 0 || selected.length < wanted.length };
}
export function createCitywayRealtimeSource(
  options: VendorOptions & { readonly agencyId: string; readonly feed: Feed },
): RealtimeSource {
  return {
    fetchRealtime: (_topology, filter) =>
      Effect.tryPromise({
        try: async () => ({
          agencyId: options.agencyId,
          updatedAt: (options.now ?? Date.now)(),
          vehicles: [],
          ...(filter?.vehiclesOnly
            ? { arrivals: [], partial: false }
            : await fetchCitywayArrivals(options.feed, { ...options, ...filter })),
        }),
        catch: (cause) =>
          new RealtimeError({
            agencyId: options.agencyId,
            message: "Cityway realtime unavailable",
            cause,
          }),
      }),
  };
}
