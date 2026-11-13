import type { StaticGtfsFeed } from "~/agencies/types";
import type { ZenbusIndex } from "../realtime/zenbus/zenbusDecoder";
import {
  decodeZenbusStatic,
  type ZenbusItinerary,
  type ZenbusLine,
  type ZenbusShape,
  type ZenbusStop,
} from "../realtime/zenbus/zenbusProtocol";
import { writeStoredArchive } from "./archiveWriter";
import { processArchiveCsv, readGtfsArchive } from "./archive";

const csv = (rows: readonly (readonly (string | number)[])[]) =>
  rows
    .map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","))
    .join("\n") + "\n";

/** Source-native stop patterns, across a week, are topology only, never live departures. */
export async function buildZenbusArchive(options: {
  readonly feed: Pick<StaticGtfsFeed, "url" | "name"> & {
    readonly zenbus: { readonly timeZone: string };
  };
  readonly fetch: typeof fetch;
  readonly now: number;
}): Promise<Uint8Array> {
  const { feed } = options;
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: feed.zenbus.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(options.now);
  const start = Date.parse(`${date}T12:00:00Z`);
  const lines = new Map<string, ZenbusLine>(),
    stops = new Map<string, ZenbusStop>(),
    itineraries = new Map<string, ZenbusItinerary>(),
    shapes = new Map<string, ZenbusShape>();
  for (let day = 0; day < 7; day++) {
    const url = new URL(feed.url);
    url.searchParams.set(
      "yyyymmdd",
      new Date(start + day * 86400000).toISOString().slice(0, 10).replaceAll("-", ""),
    );
    const response = await options.fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching Zenbus topology`);
    const data = decodeZenbusStatic(new Uint8Array(await response.arrayBuffer()));
    for (const item of data.shapes) shapes.set(item.id, item);
    for (const item of data.lines) lines.set(item.id, item);
    for (const item of data.stops) stops.set(item.id, item);
    for (const item of data.itineraries) {
      for (const ref of item.stops) if (ref.stop) stops.set(ref.stop.id, ref.stop);
      if (item.line) lines.set(item.line.id, item.line);
      const previous = itineraries.get(item.id);
      if (previous && JSON.stringify(previous.stops) !== JSON.stringify(item.stops))
        throw new Error("Zenbus itinerary changed identity during topology capture");
      itineraries.set(item.id, item);
    }
  }
  const trips: (string | number)[][] = [],
    calls: (string | number)[][] = [];
  for (const itinerary of [...itineraries.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const line = lines.get(itinerary.lineId ?? itinerary.line!.id);
    if (!line) throw new Error("Unknown Zenbus line");
    const ids = itinerary.stops.map((ref) => ref.id ?? ref.stop?.id ?? "");
    const first = stops.get(ids[0]),
      last = stops.get(ids.at(-1)!);
    if (!first || !last || ids.some((id) => !stops.has(id))) throw new Error("Unknown Zenbus stop");
    const direction = last.center.latitude < first.center.latitude ? 1 : 0;
    const shape = [...shapes.values()]
      .filter((s) => s.itineraryId === itinerary.id && (s.points?.points.length ?? 0) >= 2)
      .sort(
        (a, b) =>
          (b.points?.points.length ?? 0) - (a.points?.points.length ?? 0) ||
          a.id.localeCompare(b.id),
      )[0];
    trips.push([line.code, "TOPOLOGY", itinerary.id, last.name, direction, shape?.id ?? ""]);
    ids.forEach((id, i) => calls.push([itinerary.id, "00:00:00", "00:00:00", id, i + 1]));
  }
  return writeStoredArchive({
    "agency.txt": csv([
      ["agency_id", "agency_name", "agency_url", "agency_timezone"],
      ["1", feed.name ?? "Zenbus", new URL(feed.url).origin, feed.zenbus.timeZone],
    ]),
    "routes.txt": csv([
      [
        "route_id",
        "agency_id",
        "route_short_name",
        "route_long_name",
        "route_type",
        "route_color",
        "route_text_color",
      ],
      ...[...lines.values()]
        .sort((a, b) => a.code.localeCompare(b.code))
        .map((l) => [
          l.code,
          "1",
          l.code,
          l.name,
          3,
          (l.color ?? "64748B").replace("#", ""),
          (l.textColor ?? "FFFFFF").replace("#", ""),
        ]),
    ]),
    "stops.txt": csv([
      ["stop_id", "stop_code", "stop_name", "stop_lat", "stop_lon", "wheelchair_boarding"],
      ...[...stops.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((s) => [
          s.id,
          s.code ?? "",
          s.name,
          s.center.latitude,
          s.center.longitude,
          s.wheelchair ?? 0,
        ]),
    ]),
    "trips.txt": csv([
      ["route_id", "service_id", "trip_id", "trip_headsign", "direction_id", "shape_id"],
      ...trips,
    ]),
    "stop_times.txt": csv([
      ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"],
      ...calls,
    ]),
    "shapes.txt": csv([
      ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"],
      ...[...shapes.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .flatMap((s) =>
          (s.points?.points ?? []).map((p, i) => [s.id, p.latitude, p.longitude, i + 1]),
        ),
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
      ["TOPOLOGY", 1, 1, 1, 1, 1, 1, 1, "20000101", "20991231"],
    ]),
  });
}

export async function buildZenbusIndex(archives: readonly Uint8Array[]): Promise<ZenbusIndex> {
  const index: Record<
    string,
    { routeId: string; headsign: string; directionId: 0 | 1; stopIds: string[] }
  > = {};
  for (const bytes of archives) {
    const archive = readGtfsArchive(bytes);
    const calls = new Map<string, { id: string; sequence: number }[]>();
    await processArchiveCsv(
      archive,
      "stop_times.txt",
      ["trip_id", "stop_id", "stop_sequence"],
      (get) => {
        const id = get("trip_id");
        const rows = calls.get(id) ?? [];
        rows.push({ id: get("stop_id"), sequence: Number(get("stop_sequence")) });
        calls.set(id, rows);
      },
    );
    await processArchiveCsv(
      archive,
      "trips.txt",
      ["trip_id", "route_id", "trip_headsign", "direction_id"],
      (get) => {
        const id = get("trip_id");
        const stopIds = calls
          .get(id)
          ?.sort((a, b) => a.sequence - b.sequence)
          .map((s) => s.id);
        if (!stopIds || stopIds.length < 2 || index[id])
          throw new Error("Invalid Zenbus topology index");
        index[id] = {
          routeId: get("route_id"),
          headsign: get("trip_headsign"),
          directionId: get("direction_id") === "1" ? 1 : 0,
          stopIds,
        };
      },
    );
  }
  if (!Object.keys(index).length) throw new Error("Empty Zenbus topology index");
  return index;
}

export async function buildZenbusStopCodeMap(
  archives: readonly Uint8Array[],
): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const bytes of archives)
    await processArchiveCsv(
      readGtfsArchive(bytes),
      "stops.txt",
      ["stop_id", "stop_code"],
      (get) => {
        const code = get("stop_code"),
          id = get("stop_id");
        if (!code) return;
        if (map[code] && map[code] !== id) throw new Error("Ambiguous Zenbus stop code");
        map[code] = id;
      },
    );
  return map;
}
