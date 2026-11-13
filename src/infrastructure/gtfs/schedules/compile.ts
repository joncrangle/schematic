import { readGtfsArchive, processArchiveCsv } from "../archive";
import type { FeedIdentity } from "../feedIdentity";
import {
  gtfsSeconds,
  type ScheduleArtifact,
  type ScheduleVariant,
  type ServiceCalendar,
} from "./artifacts";

/** Compiles calendar variants without putting stop_times in a database. */
export async function compileGtfsSchedules(
  bytes: readonly Uint8Array[],
  identities?: readonly FeedIdentity[],
): Promise<ReadonlyMap<string, ScheduleArtifact>> {
  const routes = new Map<
    string,
    { services: Record<string, ServiceCalendar>; trips: Record<string, ScheduleVariant[]> }
  >();
  for (const [source, buffer] of bytes.entries()) {
    const archive = readGtfsArchive(buffer, identities?.[source]);
    const services: Record<string, ServiceCalendar> = Object.create(null);
    const serviceKey = (id: string) => `${source}:${id}`;
    if (archive.has("calendar.txt"))
      await processArchiveCsv(
        archive,
        "calendar.txt",
        ["service_id", "start_date", "end_date"],
        (get) => {
          services[serviceKey(get("service_id"))] = {
            start: get("start_date"),
            end: get("end_date"),
            days: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
              .map((d) => (get(d) === "1" ? "1" : "0"))
              .join(""),
            exceptions: {},
          };
        },
      );
    if (archive.has("calendar_dates.txt"))
      await processArchiveCsv(
        archive,
        "calendar_dates.txt",
        ["service_id", "date", "exception_type"],
        (get) => {
          const key = serviceKey(get("service_id")),
            type = Number(get("exception_type"));
          if (type !== 1 && type !== 2) throw new Error("Invalid calendar exception");
          const old = services[key] ?? { days: "0000000", exceptions: {} };
          services[key] = { ...old, exceptions: { ...old.exceptions, [get("date")]: type } };
        },
      );
    const trips = new Map<
      string,
      {
        route: string;
        variant: {
          service: string;
          calls: ScheduleVariant["calls"][number][];
          frequencies: ScheduleVariant["frequencies"][number][];
        };
      }
    >();
    await processArchiveCsv(archive, "trips.txt", ["trip_id", "route_id", "service_id"], (get) => {
      const id = get("trip_id"),
        route = get("route_id"),
        service = serviceKey(get("service_id"));
      if (trips.has(id)) throw new Error("Duplicate trip identity within static board");
      if (!services[service]) return;
      trips.set(id, { route, variant: { service, calls: [], frequencies: [] } });
    });
    await processArchiveCsv(
      archive,
      "stop_times.txt",
      ["trip_id", "stop_id", "stop_sequence", "arrival_time", "departure_time"],
      (get) => {
        const trip = trips.get(get("trip_id"));
        if (!trip) return;
        trip.variant.calls.push([
          Number(get("stop_sequence")),
          get("stop_id"),
          gtfsSeconds(get("arrival_time")) ?? null,
          gtfsSeconds(get("departure_time")) ?? null,
          get("pickup_type") !== "1",
        ]);
      },
    );
    if (archive.has("frequencies.txt"))
      await processArchiveCsv(
        archive,
        "frequencies.txt",
        ["trip_id", "start_time", "end_time", "headway_secs"],
        (get) => {
          const trip = trips.get(get("trip_id"));
          if (!trip) return;
          const start = gtfsSeconds(get("start_time")),
            end = gtfsSeconds(get("end_time")),
            headway = Number(get("headway_secs"));
          if (
            start === undefined ||
            end === undefined ||
            !Number.isSafeInteger(headway) ||
            headway <= 0
          )
            throw new Error("Invalid frequency window");
          trip.variant.frequencies.push([start, end, headway, get("exact_times") === "1"]);
        },
      );
    for (const [id, { route, variant }] of trips) {
      variant.calls.sort((a, b) => a[0] - b[0]);
      const target = routes.get(route) ?? {
        services: Object.create(null),
        trips: Object.create(null),
      };
      target.services[variant.service] = services[variant.service];
      (target.trips[id] ??= []).push(variant);
      routes.set(route, target);
    }
  }
  return new Map(
    [...routes]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([routeId, data]) => [
        routeId,
        { version: 1 as const, agencyId: "pending", routeId, bucket: 0, ...data },
      ]),
  );
}
