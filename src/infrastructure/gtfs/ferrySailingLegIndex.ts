import type { FerrySailingLegIndex } from "~/agencies/types";
import { processArchiveCsv, readGtfsArchive } from "./archive";

/** Rider-facing terminal name without the facility suffix. */
export function terminalDisplayName(stopName: string): string {
  return stopName
    .replace(/\s*\b(?:Ferry\s+)?Terminal\b/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Boards name sailings by terminal pair, never by GTFS trip, so each ordered
 * pair a trip serves must resolve to exactly one route and direction.
 */
export async function buildFerrySailingLegIndex(
  archives: readonly Uint8Array[],
  terminals: Readonly<Record<string, string>>,
): Promise<{ legs: FerrySailingLegIndex; terminalNames: Record<string, string> }> {
  const codeByStation = new Map(Object.entries(terminals).map(([code, id]) => [id, code]));
  const legs: Record<string, FerrySailingLegIndex[string]> = {};
  const terminalNames: Record<string, string> = {};
  for (const bytes of archives) {
    const archive = readGtfsArchive(bytes);
    const parentOf = new Map<string, string>();
    const names = new Map<string, string>();
    await processArchiveCsv(archive, "stops.txt", ["stop_id", "stop_name"], (get) => {
      parentOf.set(get("stop_id"), get("parent_station") || get("stop_id"));
      names.set(get("stop_id"), get("stop_name"));
    });
    for (const [code, id] of Object.entries(terminals)) {
      const name = names.get(id);
      if (name) terminalNames[code] = terminalDisplayName(name);
    }
    const trips = new Map<string, { routeId: string; directionId: 0 | 1 }>();
    await processArchiveCsv(archive, "trips.txt", ["route_id", "trip_id"], (get) => {
      const direction = get("direction_id");
      if (direction !== "" && direction !== "0" && direction !== "1")
        throw new Error(`Unsupported sailing direction: ${get("trip_id")}`);
      trips.set(get("trip_id"), {
        routeId: get("route_id"),
        directionId: direction === "1" ? 1 : 0,
      });
    });
    const calls = new Map<string, { sequence: number; code: string }[]>();
    await processArchiveCsv(
      archive,
      "stop_times.txt",
      ["trip_id", "stop_id", "stop_sequence"],
      (get) => {
        const code = codeByStation.get(parentOf.get(get("stop_id")) ?? get("stop_id"));
        if (!code) return;
        const list = calls.get(get("trip_id")) ?? [];
        list.push({ sequence: Number(get("stop_sequence")), code });
        calls.set(get("trip_id"), list);
      },
    );
    for (const [tripId, list] of calls) {
      const trip = trips.get(tripId);
      if (!trip) continue;
      const ordered = list.sort((a, b) => a.sequence - b.sequence).map(({ code }) => code);
      for (let from = 0; from < ordered.length; from += 1) {
        for (let to = from + 1; to < ordered.length; to += 1) {
          if (ordered[from] === ordered[to]) continue;
          const key = `${ordered[from]}>${ordered[to]}`;
          const leg = { ...trip, headsign: terminalNames[ordered[to]] ?? ordered[to] };
          const previous = legs[key];
          if (
            previous &&
            (previous.routeId !== leg.routeId || previous.directionId !== leg.directionId)
          )
            throw new Error(`Ambiguous GTFS sailing leg: ${key}`);
          legs[key] = leg;
        }
      }
    }
  }
  if (!Object.keys(legs).length) throw new Error("GTFS produced no sailing legs");
  const missing = Object.keys(terminals).filter((code) => !terminalNames[code]);
  if (missing.length) throw new Error(`Terminal stops missing from GTFS: ${missing.join(", ")}`);
  const sorted = <T>(record: Record<string, T>) =>
    Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
  return { legs: sorted(legs), terminalNames: sorted(terminalNames) };
}
