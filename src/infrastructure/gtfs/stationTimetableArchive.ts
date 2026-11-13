import type { StaticGtfsFeed } from "~/agencies/types";
import {
  boardRides,
  boardUrl,
  ownsStop,
  rideLine,
  MAX_BOARD_WINDOW_MS,
  TIMETABLE_BOARDS,
  type TimetableCall,
  type TimetableRide,
} from "~/infrastructure/realtime/stationTimetables/stationTimetablesProtocol";
import { processArchiveCsv, readGtfsArchive } from "./archive";
import { writeStoredArchive } from "./archiveWriter";

type BoardFeed = StaticGtfsFeed & {
  readonly stationTimetables: NonNullable<StaticGtfsFeed["stationTimetables"]>;
};
export type StationDirections = Record<string, Record<string, 0 | 1>>;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const csv = (rows: readonly (readonly (string | number)[])[]) =>
  rows
    .map((row) =>
      row
        .map((value) => {
          const text = String(value);
          return /[",\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
        })
        .join(","),
    )
    .join("\n") + "\n";

function hash(text: string): string {
  let value = 5381;
  for (let index = 0; index < text.length; index += 1)
    value = ((value << 5) + value + text.charCodeAt(index)) >>> 0;
  return value.toString(16).padStart(8, "0");
}

/** Seconds since local midnight of `day`, which may pass 24:00 for overnight calls. */
function localClock(time: number, timeZone: string): { day: number; seconds: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(time)
      .map(({ type, value }) => [type, Number(value)]),
  );
  return {
    day: Date.UTC(parts.year, parts.month - 1, parts.day) / DAY_MS,
    seconds: parts.hour * 3600 + parts.minute * 60 + parts.second,
  };
}

const gtfsTime = (seconds: number) =>
  [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");

const scheduledAt = (call: TimetableCall, prefer: "arrival" | "departure") => {
  const first = prefer === "arrival" ? call.arrival : call.departure;
  const second = prefer === "arrival" ? call.departure : call.arrival;
  const time = Date.parse(first?.scheduled ?? second?.scheduled ?? "");
  return Number.isFinite(time) ? time : undefined;
};

interface Pattern {
  readonly routeId: string;
  readonly headsign: string;
  readonly stops: readonly string[];
  /** Every call of the ride, foreign stops included, so cross-border lines still orient. */
  readonly route: readonly string[];
  readonly ride: TimetableRide;
  readonly calls: readonly TimetableCall[];
  readonly start: number;
}

/** Orients each published direction label against the line's longest stop pattern. */
function directionsOf(patterns: readonly Pattern[]): StationDirections {
  const byRoute = new Map<string, Pattern[]>();
  for (const pattern of patterns)
    byRoute.set(pattern.routeId, [...(byRoute.get(pattern.routeId) ?? []), pattern]);
  const directions: StationDirections = {};
  for (const [routeId, routePatterns] of [...byRoute].sort(([a], [b]) => a.localeCompare(b))) {
    const reference = [...routePatterns].sort(
      (a, b) => b.route.length - a.route.length || a.route.join().localeCompare(b.route.join()),
    )[0]!.route;
    const votes = new Map<string, number>();
    for (const pattern of routePatterns) {
      const positions = pattern.route.map((stop) => reference.indexOf(stop)).filter((i) => i >= 0);
      const vote = positions.length > 1 ? Math.sign(positions.at(-1)! - positions[0]!) : 0;
      votes.set(pattern.headsign, (votes.get(pattern.headsign) ?? 0) + (vote || 1));
    }
    directions[routeId] = Object.fromEntries(
      [...votes]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([label, vote]) => [label, vote >= 0 ? 0 : 1]),
    );
  }
  return directions;
}

/** One trip per stop pattern keeps the archive stable; any failed board fails the build. */
export async function buildStationTimetableArchive(options: {
  readonly feed: BoardFeed;
  readonly fetch: typeof fetch;
  readonly now: number;
}): Promise<Uint8Array> {
  const { feed } = options;
  const source = feed.stationTimetables;
  // One maximal window per board keeps a Workers refresh to two requests per hub.
  const start = Math.floor(options.now / HOUR_MS) * HOUR_MS;
  const urls = source.stations.flatMap((station) =>
    TIMETABLE_BOARDS.map((board) =>
      boardUrl(feed.url, station, board, start, start + MAX_BOARD_WINDOW_MS),
    ),
  );
  const boards: unknown[] = [];
  for (const url of urls) {
    const response = await options.fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching station board`);
    boards.push(await response.json());
  }
  const { rides } = boardRides(boards);
  if (rides.length === 0) throw new Error("Station boards listed no rides");

  const patterns = new Map<string, Pattern>();
  const stops = new Map<string, TimetableCall["stop"]>();
  const routes = new Map<string, string>();
  for (const ride of rides) {
    const calls = [...ride.calls]
      .filter((call) => ownsStop(call, source))
      .sort((a, b) => a.sequence - b.sequence);
    const first = calls[0] && scheduledAt(calls[0], "departure");
    if (first === undefined) continue;
    const { routeId, headsign } = rideLine(ride);
    routes.set(routeId, ride.line.name.trim());
    for (const call of calls) stops.set(call.stop.id, call.stop);
    const stopIds = calls.map((call) => call.stop.id);
    const key = [routeId, headsign, ...stopIds].join("\u0000");
    const clock = localClock(first, source.timeZone).seconds;
    const current = patterns.get(key);
    const currentClock = current && localClock(current.start, source.timeZone).seconds;
    if (!current || clock < currentClock! || (clock === currentClock && ride.id < current.ride.id))
      patterns.set(key, {
        routeId,
        headsign,
        stops: stopIds,
        route: [...ride.calls].sort((a, b) => a.sequence - b.sequence).map((call) => call.stop.id),
        ride,
        calls,
        start: first,
      });
  }
  const directions = directionsOf([...patterns.values()]);

  const tripRows: (string | number)[][] = [];
  const stopTimeRows: (string | number)[][] = [];
  for (const pattern of [...patterns.values()].sort(
    (a, b) => a.routeId.localeCompare(b.routeId) || a.stops.join().localeCompare(b.stops.join()),
  )) {
    const tripId = `${pattern.routeId}:${hash([pattern.headsign, ...pattern.stops].join(","))}`;
    tripRows.push([
      pattern.routeId,
      "ALL",
      tripId,
      pattern.headsign,
      directions[pattern.routeId]![pattern.headsign]!,
    ]);
    const base = localClock(pattern.start, source.timeZone).day;
    const clockOf = (time: number | undefined) => {
      if (time === undefined) return "";
      const local = localClock(time, source.timeZone);
      return gtfsTime((local.day - base) * 86_400 + local.seconds);
    };
    for (const call of pattern.calls)
      stopTimeRows.push([
        tripId,
        clockOf(scheduledAt(call, "arrival")),
        clockOf(scheduledAt(call, "departure")),
        call.stop.id,
        call.sequence,
      ]);
  }
  const origin = new URL(feed.url).origin;
  return writeStoredArchive({
    "agency.txt": csv([
      ["agency_id", "agency_name", "agency_url", "agency_timezone"],
      ["1", feed.name ?? origin, origin, source.timeZone],
    ]),
    "routes.txt": csv([
      ["route_id", "agency_id", "route_short_name", "route_long_name", "route_type"],
      ...[...routes]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, name]) => [id, "1", id, name, 3]),
    ]),
    "stops.txt": csv([
      ["stop_id", "stop_code", "stop_name", "stop_lat", "stop_lon"],
      ...[...stops.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((stop) => [
          stop.id,
          stop.code ?? "",
          stop.name.trim(),
          stop.location.latitude,
          stop.location.longitude,
        ]),
    ]),
    "calendar.txt": csv([
      [
        "service_id",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
        "start_date",
        "end_date",
      ],
      ["ALL", 1, 1, 1, 1, 1, 1, 1, "20000101", "20991231"],
    ]),
    "trips.txt": csv([
      ["route_id", "service_id", "trip_id", "trip_headsign", "direction_id"],
      ...tripRows,
    ]),
    "stop_times.txt": csv([
      ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"],
      ...stopTimeRows,
    ]),
  });
}

/** Reads the direction each line's label was given, for the realtime feed's index. */
export async function stationTimetableDirections(archive: Uint8Array): Promise<StationDirections> {
  const directions: StationDirections = {};
  await processArchiveCsv(
    readGtfsArchive(archive),
    "trips.txt",
    ["route_id", "trip_headsign", "direction_id"],
    (get) => {
      (directions[get("route_id")] ??= {})[get("trip_headsign")] =
        get("direction_id") === "1" ? 1 : 0;
    },
  );
  return directions;
}
