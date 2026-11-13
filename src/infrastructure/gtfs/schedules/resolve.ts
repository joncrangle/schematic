import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  scheduledStopKey,
  type ScheduledStopLookup,
  type ScheduledStopRequest,
  type ScheduledStopTime,
} from "~/domain/surface/scheduledStopTimes";
import {
  ScheduleArtifactSchema,
  ScheduleCatalogSchema,
  scheduleAssetPath,
  scheduleBucket,
  gtfsSeconds,
  type ServiceCalendar,
  type ScheduleVariant,
} from "./artifacts";
import type { VersionedAssetCache } from "../../staticAssets/versionedAssetCache";

function dateId(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}
function dateValue(id: string): Date | undefined {
  if (!/^\d{8}$/.test(id)) return undefined;
  const date = new Date(`${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && dateId(date) === id ? date : undefined;
}
function active(calendar: ServiceCalendar, id: string): boolean {
  const date = dateValue(id);
  if (!date) return false;
  const exception = calendar.exceptions[id];
  if (exception) return exception === 1;
  return (
    !!calendar.start &&
    !!calendar.end &&
    id >= calendar.start &&
    id <= calendar.end &&
    calendar.days[(date.getUTCDay() + 6) % 7] === "1"
  );
}
/** GTFS service-day seconds use local noon minus twelve hours, including DST days. */
function serviceEpoch(id: string, timezone: string): number {
  const utc = dateValue(id);
  if (!utc) throw new Error("Invalid service date");
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  let noon = utc.getTime();
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(noon).map((p) => [p.type, p.value]));
    const local = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    noon += utc.getTime() - local;
  }
  return noon - 12 * 3600000;
}
function frequencyOffset(
  variant: ScheduleVariant,
  request: ScheduledStopRequest,
): number | undefined {
  if (!variant.frequencies.length) return 0;
  const start = request.startTime ? gtfsSeconds(request.startTime) : undefined;
  const first = variant.calls[0]?.[3] ?? variant.calls[0]?.[2];
  if (start === undefined || first === undefined || first === null) return undefined;
  return variant.frequencies.some(
    ([from, to, step, exact]) =>
      start >= from && start < to && (!exact || (start - from) % step === 0),
  )
    ? start - first
    : undefined;
}
export function createStaticScheduleResolver(options: {
  catalog: unknown;
  cache: VersionedAssetCache;
}): (agencyId: string, timezone: string, now: () => number) => ScheduledStopLookup {
  const catalog = Schema.decodeUnknownSync(ScheduleCatalogSchema)(options.catalog);
  return (agencyId, timezone, now) => (requests) =>
    Effect.tryPromise(async () => {
      const agency = catalog.agencies[agencyId];
      if (!agency) throw new Error("Static schedule generation missing");
      const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
        .format(now())
        .replaceAll("-", "");
      const day = dateValue(today)!;
      day.setUTCDate(day.getUTCDate() - 1);
      const defaults = [today, dateId(day)];
      const result = new Map<string, ScheduledStopTime>();
      // Group reads so one feed cannot start an unbounded number of asset operations.
      const groups = new Map<
        string,
        {
          ref: { hash: string; bytes: number };
          route: string;
          bucket: number;
          requests: ScheduledStopRequest[];
        }
      >();
      for (const request of requests) {
        if (!Object.hasOwn(agency.routes, request.routeId)) continue;
        const refs = agency.routes[request.routeId];
        if (!refs?.length) continue;
        const bucket = scheduleBucket(request.tripId, refs.length),
          ref = refs[bucket],
          path = scheduleAssetPath(agencyId, ref.hash);
        const group = groups.get(path) ?? {
          ref,
          route: request.routeId,
          bucket,
          requests: [] as ScheduledStopRequest[],
        };
        group.requests.push(request);
        groups.set(path, group);
      }
      const pending = [...groups.entries()];
      // Asset binding reads share the internal-services budget, separate from upstream HTTP fetches.
      if (pending.length > 256) throw new Error("Static schedule request exceeds shard budget");
      await Promise.all(
        Array.from({ length: Math.min(4, pending.length) }, async () => {
          while (pending.length) {
            const [path, group] = pending.pop()!;
            const data = await options.cache.load(path, group.ref, (value) => {
              const artifact = Schema.decodeUnknownSync(ScheduleArtifactSchema)(value);
              if (
                artifact.agencyId !== agencyId ||
                artifact.routeId !== group.route ||
                artifact.bucket !== group.bucket
              )
                throw new Error("Static schedule scope mismatch");
              return artifact;
            });
            for (const request of group.requests) {
              const matches: ScheduledStopTime[] = [];
              for (const variant of Object.hasOwn(data.trips, request.tripId)
                ? data.trips[request.tripId]
                : []) {
                const offset = frequencyOffset(variant, request);
                if (offset === undefined) continue;
                const call = variant.calls.find(
                  (c) =>
                    c[0] === request.stopSequence && (!request.stopId || c[1] === request.stopId),
                );
                if (!call || !call[4]) continue;
                for (const date of request.startDate ? [request.startDate] : defaults) {
                  if (
                    !data.services[variant.service] ||
                    !active(data.services[variant.service], date)
                  )
                    continue;
                  const epoch = serviceEpoch(date, timezone);
                  const arrivalTime =
                    call[2] === null ? undefined : epoch + (call[2] + offset) * 1000;
                  const departureTime =
                    call[3] === null ? undefined : epoch + (call[3] + offset) * 1000;
                  if (
                    !request.startDate &&
                    Math.abs((departureTime ?? arrivalTime ?? 0) - now()) > 12 * 3600000
                  )
                    continue;
                  matches.push({ stopId: call[1], arrivalTime, departureTime });
                }
              }
              if (matches.length === 1) result.set(scheduledStopKey(request), matches[0]);
            }
          }
        }),
      );
      return result;
    });
}
