import type { TrainMapGtfsIndex } from "~/agencies/types";
import { processArchiveCsv, readGtfsArchive } from "./archive";

/** Trains keep only route and direction because one number can end at several terminals. */
export async function buildTrainMapGtfsIndex(
  archives: readonly Uint8Array[],
  sourceAgencyIds?: readonly string[],
): Promise<TrainMapGtfsIndex> {
  const stops: Record<string, TrainMapGtfsIndex["stops"][string]> = {};
  const trains: Record<string, TrainMapGtfsIndex["trains"][string]> = {};
  for (const bytes of archives) {
    const archive = readGtfsArchive(bytes);
    let agencyTimeZone = "";
    if (archive.has("agency.txt"))
      await processArchiveCsv(archive, "agency.txt", ["agency_timezone"], (get) => {
        agencyTimeZone ||= get("agency_timezone");
      });
    const railRoutes = new Set<string>();
    await processArchiveCsv(archive, "routes.txt", ["route_id", "route_type"], (get) => {
      if (sourceAgencyIds && !sourceAgencyIds.includes(get("agency_id"))) return;
      if (get("route_type") === "2") railRoutes.add(get("route_id"));
    });
    const codeByStopId = new Map<string, string>();
    await processArchiveCsv(archive, "stops.txt", ["stop_id", "stop_code", "stop_name"], (get) => {
      const code = get("stop_code"),
        stopId = get("stop_id");
      if (!code || !stopId) return;
      const stop = {
        stopId,
        name: get("stop_name"),
        timeZone: get("stop_timezone") || agencyTimeZone,
      };
      if (!stop.timeZone) throw new Error(`Station ${code} has no time zone`);
      codeByStopId.set(stopId, code);
      const previous = stops[code];
      if (previous && previous.stopId !== stopId)
        throw new Error(`Ambiguous GTFS station code: ${code}`);
      stops[code] = stop;
    });
    const headsignByTrip = new Map<string, string>();
    await processArchiveCsv(archive, "trips.txt", ["route_id", "trip_short_name"], (get) => {
      // Through services may append the connecting operator's train number.
      const routeId = get("route_id"),
        number = get("trip_short_name").split("-")[0];
      if (!railRoutes.has(routeId) || !number) return;
      const headsign = get("trip_headsign").trim();
      if (headsign) headsignByTrip.set(get("trip_id"), headsign);
      const direction = get("direction_id");
      if (direction !== "" && direction !== "0" && direction !== "1")
        throw new Error(`Unsupported train direction: ${number}`);
      const trip = { routeId, directionId: direction === "1" ? (1 as const) : (0 as const) };
      const previous = trains[number];
      if (previous && (previous.routeId !== routeId || previous.directionId !== trip.directionId))
        throw new Error(`Ambiguous GTFS train number: ${number}`);
      trains[number] = trip;
    });
    const terminals = new Map<string, { stopId: string; sequence: number }>();
    await processArchiveCsv(
      archive,
      "stop_times.txt",
      ["trip_id", "stop_id", "stop_sequence"],
      (get) => {
        const tripId = get("trip_id");
        if (!headsignByTrip.has(tripId)) return;
        const sequence = Number(get("stop_sequence"));
        const current = terminals.get(tripId);
        if (!current || sequence > current.sequence)
          terminals.set(tripId, { stopId: get("stop_id"), sequence });
      },
    );
    const headsigns = new Map<string, Set<string>>();
    for (const [tripId, { stopId }] of terminals) {
      const code = codeByStopId.get(stopId);
      if (!code) continue;
      const set = headsigns.get(code) ?? new Set<string>();
      set.add(headsignByTrip.get(tripId)!);
      headsigns.set(code, set);
    }
    for (const [code, set] of headsigns) {
      const stop = stops[code];
      if (stop && set.size === 1) stops[code] = { ...stop, headsign: [...set][0]! };
    }
  }
  if (!Object.keys(stops).length || !Object.keys(trains).length)
    throw new Error("GTFS produced no station codes or train numbers");
  return { stops, trains };
}
