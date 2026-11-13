import type { TsimobileGtfsIndex } from "~/agencies/types";
import { processArchiveCsv, readGtfsArchive } from "./archive";

/** The wire speaks station codes and train numbers, never GTFS stop/trip IDs. */
export async function buildTsimobileGtfsIndex(
  archives: readonly Uint8Array[],
): Promise<TsimobileGtfsIndex> {
  const stops: Record<string, string> = {};
  const trains: Record<string, TsimobileGtfsIndex["trains"][string]> = {};
  for (const bytes of archives) {
    const archive = readGtfsArchive(bytes);
    const railRoutes = new Set<string>();
    await processArchiveCsv(archive, "routes.txt", ["route_id", "route_type"], (get) => {
      if (get("route_type") === "2") railRoutes.add(get("route_id"));
    });
    await processArchiveCsv(archive, "stops.txt", ["stop_id", "stop_code"], (get) => {
      const code = get("stop_code"),
        id = get("stop_id");
      if (!code || !id) return;
      if (stops[code] !== undefined && stops[code] !== id)
        throw new Error(`Ambiguous GTFS station code: ${code}`);
      stops[code] = id;
    });
    await processArchiveCsv(
      archive,
      "trips.txt",
      ["route_id", "trip_short_name", "trip_headsign"],
      (get) => {
        // Through services may append the connecting operator's train number.
        const routeId = get("route_id"),
          number = get("trip_short_name").split("-")[0];
        if (!railRoutes.has(routeId) || !number) return;
        const direction = get("direction_id");
        if (direction !== "" && direction !== "0" && direction !== "1")
          throw new Error(`Unsupported train direction: ${number}`);
        const trip = {
          routeId,
          directionId: direction === "1" ? (1 as const) : (0 as const),
          headsign: get("trip_headsign"),
        };
        if (!trip.headsign) throw new Error(`Missing GTFS train headsign: ${number}`);
        const previous = trains[number];
        if (
          previous &&
          (previous.routeId !== routeId ||
            previous.directionId !== trip.directionId ||
            previous.headsign !== trip.headsign)
        )
          throw new Error(`Ambiguous GTFS train number: ${number}`);
        trains[number] = trip;
      },
    );
  }
  if (!Object.keys(stops).length || !Object.keys(trains).length)
    throw new Error("GTFS produced no station codes or train numbers");
  return { stops, trains };
}
