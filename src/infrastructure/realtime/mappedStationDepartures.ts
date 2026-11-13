import * as Effect from "effect/Effect";
import type { RealtimeFeedConfig, StationDeparturesResponseMapping } from "~/agencies/types";
import type { ArrivalPrediction } from "~/domain/surface/types";
import { directionIdForLabel, directionLabelFor } from "~/domain/surface/direction";
import { routeIdsMatch } from "~/domain/surface/routeIds";
import { parseWallClock } from "./wallClock";
import { fetchDecodedFeeds } from "./fetchDecodedFeeds";
import { RealtimeError, type RealtimeSource } from "~/domain/surface/realtimeSource";
import type { GenericGtfsRealtimeSourceOptions } from "./genericGtfsRealtimeSource";

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim() || undefined
    : undefined;
}
function mappedFlag(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}
function departureTime(value: string, timeZone?: string, localTimeNow?: number): number {
  if (localTimeNow !== undefined) {
    if (!timeZone || !/^\d{2}:\d{2}:\d{2}$/.test(value))
      throw new Error("Invalid local departure time");
    const [hour, minute, second] = value.split(":").map(Number);
    if (hour > 47 || minute > 59 || second > 59) throw new Error("Invalid local departure time");
    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(localTimeNow);
    const midnight = Date.parse(`${date}T00:00:00Z`);
    let day = Math.floor(hour / 24);
    const clock = `${String(hour % 24).padStart(2, "0")}:${value.slice(3)}`;
    const resolve = () =>
      parseWallClock(
        `${new Date(midnight + day * 86400000).toISOString().slice(0, 10)} ${clock}`,
        timeZone,
      );
    let result = resolve();
    if (result < localTimeNow - 6 * 3600000) {
      day += 1;
      result = resolve();
    } else if (result > localTimeNow + 18 * 3600000) {
      day -= 1;
      result = resolve();
    }
    return result;
  }
  if (timeZone && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value))
    return parseWallClock(value.slice(0, 19).replace("T", " "), timeZone);
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(value))
    throw new Error("Departure timestamp requires an offset or declared time zone");
  return Date.parse(value);
}
function mappedField(value: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  if (path === "$") return value;
  return path
    .split(".")
    .reduce<unknown>(
      (current, key) =>
        typeof current === "object" && current !== null
          ? (current as Record<string, unknown>)[key]
          : undefined,
      value,
    );
}

/**
 * Single place that decides both the direction index and whether the operator
 * stated it. Compass words/abbreviations, inbound/outbound literals, and
 * numeric 0/1 all count as stated; anything else falls back to 0 and is
 * marked inferred so schematic endpoint geometry must not replace it.
 */
function classifyMappedDirection(direction: unknown): {
  readonly directionId: number;
  readonly directionAuthoritative: boolean;
  readonly rawDirection: string | undefined;
} {
  const rawDirection = trimmedString(direction)?.toLowerCase();
  const compassLabel = rawDirection ? directionLabelFor(rawDirection) : "";
  const directionId = compassLabel
    ? (directionIdForLabel(compassLabel) ?? 0)
    : direction === 1 || direction === "1"
      ? 1
      : 0;
  const directionAuthoritative =
    Boolean(compassLabel) ||
    rawDirection === "outbound" ||
    rawDirection === "inbound" ||
    direction === 0 ||
    direction === "0" ||
    direction === 1 ||
    direction === "1";
  return { directionId, directionAuthoritative, rawDirection };
}

export function decodeMappedStationDepartures(
  body: unknown,
  stopId: string,
  mapping: StationDeparturesResponseMapping,
  lineIds: readonly string[] | undefined,
  now = Date.now(),
): readonly ArrivalPrediction[] {
  const routes = mappedField(body, mapping.routesPath);
  if (!Array.isArray(routes)) throw new Error("Station departures routes were not an array");
  const arrivals: ArrivalPrediction[] = [];
  for (const [routeIndex, route] of routes.entries()) {
    const routeId = trimmedString(mappedField(route, mapping.routeIdField));
    const departures =
      mapping.departuresField === "$" ? [route] : mappedField(route, mapping.departuresField);
    if (!routeId || !Array.isArray(departures)) throw new Error("Invalid station departures route");
    if (lineIds?.length && !lineIds.some((id) => routeIdsMatch(routeId, id))) continue;
    if (
      mappedFlag(mappedField(route, mapping.stopClosedField)) ||
      mappedFlag(mappedField(body, mapping.stopClosedField)) ||
      mappedFlag(mappedField(route, mapping.terminalField))
    )
      continue;
    const direction =
      mappedField(route, mapping.directionField) ?? mappedField(body, mapping.directionField);
    const headsign = trimmedString(mappedField(route, mapping.headsignField));
    for (const [index, departure] of departures.entries()) {
      if (mapping.realtimeOnly && !mappedFlag(mappedField(departure, mapping.realtimeField)))
        continue;
      if (
        mappedFlag(mappedField(departure, mapping.cancelledField)) ||
        mappedFlag(mappedField(departure, mapping.offRouteField)) ||
        mappedFlag(mappedField(departure, mapping.stopClosedField)) ||
        mappedFlag(mappedField(departure, mapping.terminalField))
      )
        continue;
      if (
        mapping.realtimePresenceField &&
        mappedField(departure, mapping.realtimePresenceField) == null
      )
        continue;
      const departureDirection = mappedField(departure, mapping.directionField) ?? direction;
      const capturedDirection = mapping.directionPattern
        ? new RegExp(mapping.directionPattern, "u").exec(String(departureDirection))?.[1]
        : departureDirection;
      if (mapping.directionPattern && capturedDirection !== "0" && capturedDirection !== "1")
        throw new Error("Invalid mapped departure direction");
      const { directionId, directionAuthoritative, rawDirection } =
        classifyMappedDirection(capturedDirection);
      const time = mappedField(departure, mapping.timeField);
      const updatedAt = mapping.updatedAtField
        ? departureTime(String(mappedField(departure, mapping.updatedAtField)), mapping.timeZone)
        : undefined;
      if (
        updatedAt !== undefined &&
        (!Number.isFinite(updatedAt) ||
          updatedAt > now + 60_000 ||
          now - updatedAt > (mapping.maxAgeSeconds ?? 120) * 1000)
      )
        throw new Error("Stale station departure estimate");
      const predictedTime =
        mapping.timeFormat === "countdown-seconds"
          ? typeof time === "number" && Number.isFinite(time) && updatedAt !== undefined
            ? updatedAt + time * 1000
            : NaN
          : typeof time === "string"
            ? departureTime(
                time,
                mapping.timeZone,
                mapping.timeFormat === "local-time" ? now : undefined,
              )
            : NaN;
      if (!Number.isFinite(predictedTime))
        throw new Error("Invalid absolute station departure timestamp");
      const scheduledTime = mapping.scheduledTimeField
        ? departureTime(
            String(mappedField(departure, mapping.scheduledTimeField)),
            mapping.timeZone,
            mapping.timeFormat === "local-time" ? now : undefined,
          )
        : predictedTime;
      if (!Number.isFinite(scheduledTime)) throw new Error("Invalid scheduled departure timestamp");
      const departureHeadsign =
        trimmedString(mappedField(departure, mapping.headsignField)) ?? headsign;
      arrivals.push({
        tripId:
          trimmedString(mappedField(departure, mapping.tripIdField)) ??
          `station-${stopId}-${routeIndex}-${index}`,
        routeId,
        directionId,
        directionAuthoritative,
        directionInferred: !directionAuthoritative,
        stopId,
        stopSequence: mapping.stopSequenceField
          ? Number(mappedField(departure, mapping.stopSequenceField))
          : 0,
        predictedTime,
        delaySeconds: mapping.delaySecondsField
          ? Number(mappedField(departure, mapping.delaySecondsField))
          : (predictedTime - scheduledTime) / 1000,
        scheduleRelationship: "SCHEDULED",
        isRealtime:
          mapping.realtimePresenceField !== undefined ||
          mappedFlag(mappedField(departure, mapping.realtimeField)),
        rawEntityId: `station-${stopId}-${routeIndex}-${index}|${rawDirection ?? directionId}`,
        ...(departureHeadsign ? { headsign: departureHeadsign } : {}),
      });
    }
  }
  return arrivals;
}

type MappedFeed = Extract<RealtimeFeedConfig, { kind: "station_departures" }>;
type Options = Pick<
  GenericGtfsRealtimeSourceOptions,
  "agencyId" | "fetch" | "now" | "getSecret" | "devProxyOrigin"
>;
interface CachedRead {
  readonly expiresAt: number;
  readonly value: Promise<readonly ArrivalPrediction[]>;
}
const reads = new WeakMap<typeof fetch, Map<string, CachedRead>>();

/** Station and surface callers share one bounded read for each stop and credential. */
export function fetchMappedStationDepartures(
  opts: Options,
  feed: MappedFeed,
  stopId: string,
): Promise<readonly ArrivalPrediction[]> {
  const now = (opts.now ?? Date.now)();
  const requestedId = feed.requestStopIdPattern
    ? new RegExp(feed.requestStopIdPattern, "u").exec(stopId)?.[1]
    : stopId;
  if (!requestedId)
    return Promise.reject(new Error("Stop does not match request identity pattern"));
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: feed.dateTimezone ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(now)
    .replaceAll("-", "");
  const url = feed.url
    .replaceAll("{stopId}", encodeURIComponent(requestedId))
    .replaceAll("{date}", date);
  const key = JSON.stringify([
    opts.agencyId,
    url,
    feed.responseMapping,
    feed.lineIds,
    feed.pollIntervalSeconds,
    feed.auth,
    feed.headers,
    feed.emptyBoardIsError,
    feed.auth && "secretName" in feed.auth && feed.auth.secretName
      ? opts.getSecret?.(feed.auth.secretName)
      : undefined,
  ]);
  let cache = reads.get(opts.fetch);
  if (!cache) {
    cache = new Map();
    reads.set(opts.fetch, cache);
  }
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  if (cache.size >= 512) cache.delete(cache.keys().next().value!);
  const value = (async () => {
    const result = await Effect.runPromise(
      fetchDecodedFeeds(
        [
          {
            url,
            auth: feed.auth,
            headers: feed.headers,
            devProxyPrefix: feed.devProxyPrefix,
            format: "json",
            decode: (bytes) =>
              Effect.try({
                try: () => {
                  const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
                  if (feed.emptyBoardIsError && Array.isArray(payload) && payload.length === 0)
                    throw new Error("Empty departure board cannot establish service");
                  return decodeMappedStationDepartures(
                    payload,
                    stopId,
                    feed.responseMapping!,
                    feed.lineIds,
                    (opts.now ?? Date.now)(),
                  );
                },
                catch: (cause) => cause,
              }),
            mapError: (cause) => cause,
          },
        ],
        {
          fetch: opts.fetch,
          getSecret: opts.getSecret,
          devProxyOrigin: opts.devProxyOrigin,
          attempts: 1,
          timeoutMs: 8000,
        },
      ),
    );
    if (!result.usable.length) throw result.firstError ?? new Error("Departure read failed");
    return result.usable[0]!;
  })();
  cache.set(key, {
    value,
    expiresAt: now + Math.max(12000, (feed.pollIntervalSeconds ?? 12) * 1000),
  });
  return value;
}

/** Per-stop APIs only fetch requested nearby stops, never every stop on a route. */
export function createMappedDeparturesSource(
  opts: GenericGtfsRealtimeSourceOptions,
  feeds: readonly MappedFeed[],
): RealtimeSource {
  return {
    fetchRealtime: (topology, filter) =>
      Effect.tryPromise({
        try: async () => {
          if (filter?.vehiclesOnly)
            return {
              agencyId: opts.agencyId,
              updatedAt: (opts.now ?? Date.now)(),
              vehicles: [],
              arrivals: [],
            };
          if (!filter?.stopIds?.size && !filter?.stopIdsByRoute?.size)
            throw new Error("Per-stop departures require a stop allowlist");
          const requested = new Map<string, Set<string>>();
          for (const route of topology.routes) {
            if (filter.routeIds?.size && !filter.routeIds.has(route.routeId)) continue;
            const stops = filter.stopIdsByRoute?.get(route.routeId) ?? filter.stopIds;
            for (const stop of route.stops) {
              if (!stops?.has(stop.id)) continue;
              const routes = requested.get(stop.id) ?? new Set<string>();
              routes.add(route.routeId);
              requested.set(stop.id, routes);
            }
          }
          const jobs = [...requested].flatMap(([stopId, routeIds]) =>
            feeds
              .filter(
                (feed) => !feed.lineIds?.length || feed.lineIds.some((id) => routeIds.has(id)),
              )
              .map((feed) => ({ stopId, routeIds, feed })),
          );
          const selected = jobs.slice(0, Math.max(0, Math.min(40, filter.maxSubrequests ?? 40)));
          const results: PromiseSettledResult<readonly ArrivalPrediction[]>[] = [];
          for (let i = 0; i < selected.length; i += 4)
            results.push(
              ...(await Promise.allSettled(
                selected
                  .slice(i, i + 4)
                  .map(async ({ stopId, routeIds, feed }) =>
                    (await fetchMappedStationDepartures(opts, feed, stopId)).filter((arrival) =>
                      routeIds.has(arrival.routeId),
                    ),
                  ),
              )),
            );
          const successful = results.filter((r) => r.status === "fulfilled");
          if (results.length && !successful.length)
            throw new Error("All stop departure reads failed");
          return {
            agencyId: opts.agencyId,
            updatedAt: (opts.now ?? Date.now)(),
            vehicles: [],
            arrivals: successful.flatMap((r) => r.value),
            partial: successful.length < jobs.length,
          };
        },
        catch: (cause) =>
          new RealtimeError({
            agencyId: opts.agencyId,
            message: "Per-stop departures unavailable",
            cause,
          }),
      }),
  };
}
