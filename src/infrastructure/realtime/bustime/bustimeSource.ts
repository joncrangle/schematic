import { inferVehicleDirectionFromTopology } from "~/domain/surface/topologyDirection";
import * as Effect from "effect/Effect";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { RealtimeFeedConfig } from "~/agencies/types";
import type { SourceAgencyScopeLookup } from "~/domain/surface/boarding";
import type { ArrivalPrediction, LiveVehiclePosition } from "~/domain/surface/types";
import {
  RealtimeError,
  type RealtimeSource,
  type RealtimeFetchOptions,
} from "~/domain/surface/realtimeSource";
import type { RouteTopology } from "~/domain/surface/topologySource";
import { createFeedPollingFetch } from "../feedPolling";
import { fetchDecodedFeeds } from "../fetchDecodedFeeds";

type Feed = Extract<RealtimeFeedConfig, { kind: "bustime" }>;
interface Options {
  readonly agencyId: string;
  readonly fetch: typeof fetch;
  readonly now?: () => number;
  readonly getSecret?: (name: string) => string | undefined;
  readonly devProxyOrigin?: string;
  readonly getSourceAgencyScope?: SourceAgencyScopeLookup;
}
type RecordValue = Record<string, unknown>;
const parser = new XMLParser({
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => name === "bus" || name === "pre",
});
function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid BusTime document");
  return value as RecordValue;
}
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
function xml(bytes: Uint8Array): RecordValue {
  const source = new TextDecoder().decode(bytes);
  if (XMLValidator.validate(source) !== true || /<!DOCTYPE/iu.test(source))
    throw new Error("Invalid BusTime XML");
  return record(parser.parse(source));
}
async function poll(feed: Feed, path: string, options: Options) {
  const url = `${feed.url.replace(/\/+$/u, "")}/${path}`;
  const now = options.now ?? Date.now;
  let observedAt = now();
  const pollingFetch = createFeedPollingFetch(
    [{ ...feed, url, pollIntervalSeconds: feed.pollIntervalSeconds ?? 30 }],
    {
      now,
      devProxyOrigin: options.devProxyOrigin,
      fetch: (async (input, init) => {
        const response = await options.fetch(input, init);
        if (Number.isFinite(Date.parse(response.headers.get("Date") ?? ""))) return response;
        const headers = new Headers(response.headers);
        headers.set("Date", new Date(now()).toUTCString());
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }) as typeof fetch,
    },
  );
  const result = await Effect.runPromise(
    fetchDecodedFeeds(
      [
        {
          url,
          auth: feed.auth,
          format: "xml",
          devProxyPrefix: feed.devProxyPrefix,
          decode: (bytes) => Effect.try(() => ({ document: xml(bytes), observedAt })),
          mapError: (cause) => cause,
        },
      ],
      {
        fetch: (async (input, init) => {
          const response = await pollingFetch(input, init);
          observedAt = Date.parse(response.headers.get("Date")!);
          return response;
        }) as typeof fetch,
        getSecret: options.getSecret,
        devProxyOrigin: options.devProxyOrigin,
        attempts: 1,
        timeoutMs: 8000,
      },
    ),
  );
  if (!result.usable.length) throw result.firstError ?? new Error("BusTime poll failed");
  return result.usable[0];
}
const COMPASS = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
];
async function vehicles(
  feed: Feed,
  options: Options,
  routes: readonly RouteTopology[],
  allowed: ReadonlySet<string>,
): Promise<LiveVehiclePosition[]> {
  const { document, observedAt } = await poll(feed, "getBusesForRouteAll.jsp?key=", options);
  if (document.buses === "") return [];
  const root = record(document.buses);
  if (root.error !== undefined) throw new Error("BusTime vehicle error");
  const rows = root.bus;
  if (!Array.isArray(rows)) throw new Error("Invalid BusTime vehicle array");
  const result: LiveVehiclePosition[] = [];
  for (const value of rows) {
    const row = record(value),
      routeId = text(row.rt);
    if (!allowed.has(routeId)) continue;
    const vehicleId = text(row.id),
      latitude = Number(row.lat),
      longitude = Number(row.lon);
    if (
      !vehicleId ||
      !text(row.lat) ||
      !text(row.lon) ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    )
      throw new Error("Invalid BusTime vehicle fix");
    const compass = COMPASS.indexOf(text(row.dn)),
      bearing = compass < 0 ? undefined : compass * 22.5;
    result.push({
      vehicleId,
      routeId,
      latitude,
      longitude,
      bearing,
      directionId: inferVehicleDirectionFromTopology(routes, routeId, latitude, longitude, bearing),
      timestamp: observedAt,
    });
  }
  return [...new Map(result.map((vehicle) => [vehicle.vehicleId, vehicle])).values()];
}
export async function fetchBusTimeArrivals(
  feed: Feed,
  options: Options & RealtimeFetchOptions,
  routes: readonly RouteTopology[] = [],
): Promise<{ arrivals: ArrivalPrediction[]; partial: boolean }> {
  const requested =
    options.stopIds ??
    new Set([...(options.stopIdsByRoute?.values() ?? [])].flatMap((ids) => [...ids]));
  if (!requested.size) return { arrivals: [], partial: false };
  if (!options.getSourceAgencyScope) throw new Error("BusTime static stop identities unavailable");
  const scope = await Effect.runPromise(options.getSourceAgencyScope());
  const codes = new Map<string, string>();
  for (const [code, ids] of scope.stopsByCode ?? []) if (ids.length === 1) codes.set(ids[0], code);
  const jobs = [...requested]
    .map((stopId) => {
      const code = codes.get(stopId);
      if (!code) throw new Error("BusTime stop code is missing or ambiguous");
      const routeIds = routes.length
        ? [
            ...new Set(
              routes
                .filter(
                  (route) =>
                    route.stops.some((stop) => stop.id === stopId) &&
                    (!options.routeIds?.size || options.routeIds.has(route.routeId)) &&
                    (!options.stopIdsByRoute?.size ||
                      options.stopIdsByRoute.get(route.routeId)?.has(stopId)),
                )
                .map((route) => route.routeId),
            ),
          ]
        : [...(options.routeIds ?? [])].filter((id) => scope.routeIds.has(id));
      return { stopId, code, routeIds };
    })
    .filter((job) => job.routeIds.length);
  const selected = jobs.slice(
    0,
    Math.max(0, Math.min(40, Math.floor(options.maxSubrequests ?? 40))),
  );
  const arrivals: ArrivalPrediction[] = [];
  let failed = 0;
  for (let i = 0; i < selected.length; i += 4) {
    const results = await Promise.allSettled(
      selected.slice(i, i + 4).map(async ({ stopId, code, routeIds }) => {
        const { document, observedAt } = await poll(
          feed,
          `getStopPredictions.jsp?stop=${encodeURIComponent(code)}&route=${routeIds.map(encodeURIComponent).join(",")}&key=`,
          options,
        );
        const root = record(document.stop);
        if (root.error !== undefined || text(root.id) !== code)
          throw new Error("Invalid BusTime stop board");
        const rows = root.pre ?? [];
        if (!Array.isArray(rows)) throw new Error("Invalid BusTime prediction array");
        if (rows.length === 0 && text(root.noPredictionMessage) !== "No arrival times")
          throw new Error("Unrecognized empty BusTime board");
        const found: ArrivalPrediction[] = [];
        for (const value of rows) {
          const row = record(value),
            scheduled = text(row.scheduled);
          if (scheduled === "true") continue;
          if (scheduled !== "false") throw new Error("Missing BusTime live flag");
          const label = text(row.pt),
            countdown = /^(\d+) MIN$/u.exec(label),
            minutes = label === "DUE" ? 0 : countdown ? Number(countdown[1]) : NaN;
          const routeId = text(row.rn),
            vehicleId = text(row.v);
          if (!Number.isFinite(minutes) || !vehicleId || vehicleId === "SCH")
            throw new Error("Invalid BusTime live countdown");
          if (!routeIds.includes(routeId)) continue;
          const candidates = routes.filter(
            (route) => route.routeId === routeId && route.stops.some((stop) => stop.id === stopId),
          );
          const directionIds = new Set(candidates.map((route) => route.directionId));
          found.push({
            tripId: `bustime:${routeId}:${vehicleId}`,
            routeId,
            stopId,
            vehicleId,
            directionId: directionIds.size === 1 ? [...directionIds][0] : 0,
            directionInferred: true,
            stopSequence: 0,
            // DUE remains imminent for one poll interval, without advancing on cache hits.
            predictedTime: observedAt + (label === "DUE" ? 30_000 : minutes * 60_000),
            delaySeconds: 0,
            scheduleRelationship: "SCHEDULED",
            isRealtime: true,
            headsign: text(row.fd) || undefined,
          });
        }
        return found;
      }),
    );
    for (const result of results)
      if (result.status === "fulfilled") arrivals.push(...result.value);
      else failed++;
  }
  if (selected.length && failed === selected.length)
    throw new Error("All BusTime stop boards failed");
  return { arrivals, partial: failed > 0 || selected.length < jobs.length };
}
export function createBusTimeRealtimeSource(
  options: Options & { readonly feed: Feed },
): RealtimeSource {
  return {
    fetchRealtime: (topology, filter) =>
      Effect.tryPromise({
        try: async () => {
          if (!options.getSourceAgencyScope)
            throw new Error("BusTime static identities unavailable");
          const scope = await Effect.runPromise(options.getSourceAgencyScope());
          const allowed = new Set(
            [...scope.routeIds].filter((id) => !filter?.routeIds?.size || filter.routeIds.has(id)),
          );
          const budget = Math.max(0, Math.min(40, Math.floor(filter?.maxSubrequests ?? 40)));
          const results = await Promise.allSettled([
            budget > 0
              ? vehicles(options.feed, options, topology.routes, allowed)
              : Promise.reject(new Error("BusTime vehicle budget exhausted")),
            filter?.vehiclesOnly
              ? Promise.resolve({ arrivals: [], partial: false })
              : fetchBusTimeArrivals(
                  options.feed,
                  { ...options, ...filter, maxSubrequests: Math.max(0, budget - 1) },
                  topology.routes,
                ),
          ]);
          const [fixes, calls] = results;
          if (fixes.status === "rejected" && calls.status === "rejected") throw calls.reason;
          return {
            agencyId: options.agencyId,
            updatedAt: (options.now ?? Date.now)(),
            vehicles: fixes.status === "fulfilled" ? fixes.value : [],
            arrivals: calls.status === "fulfilled" ? calls.value.arrivals : [],
            partial:
              fixes.status === "rejected" ||
              calls.status === "rejected" ||
              (calls.status === "fulfilled" && calls.value.partial),
          };
        },
        catch: (cause) =>
          new RealtimeError({
            agencyId: options.agencyId,
            message: "BusTime realtime unavailable",
            cause,
          }),
      }),
  };
}
