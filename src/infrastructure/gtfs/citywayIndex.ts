import * as Schema from "effect/Schema";
import type { RealtimeFeedConfig } from "~/agencies/types";
import { citywayHeaders, type CitywayStopRequest } from "../realtime/cityway/citywaySource";
import { readVendorDocument } from "../realtime/vendorDocument";
import { processArchiveCsv, readGtfsArchive } from "./archive";
const linesSchema = Schema.Struct({
  Count: Schema.Number,
  Lines: Schema.Array(
    Schema.Struct({
      Id: Schema.Number,
      Number: Schema.String,
      LineDirections: Schema.Array(Schema.Struct({ Direction: Schema.Number })),
    }),
  ),
});
const stopsSchema = Schema.Array(
  Schema.Struct({
    Id: Schema.Number,
    Name: Schema.String,
    LogicalStopPointId: Schema.Number,
    Latitude: Schema.Number,
    Longitude: Schema.Number,
  }),
);
/** Pin vendor identities to actual GTFS stops at seed time, never fan out over the roster at runtime. */
export async function buildCitywayIndex(
  feed: Extract<RealtimeFeedConfig, { kind: "cityway" }>,
  archives: readonly Uint8Array[],
  fetch: typeof globalThis.fetch,
): Promise<Record<string, CitywayStopRequest[]>> {
  const known = new Map<string, { id: string; lat: number; lon: number }[]>(),
    named = new Map<string, { id: string; lat: number; lon: number }[]>(),
    routes = new Set<string>();
  for (const bytes of archives) {
    const archive = readGtfsArchive(bytes);
    await processArchiveCsv(archive, "stops.txt", ["stop_id", "stop_lat", "stop_lon"], (get) => {
      const code = get("stop_code") || get("stop_id");
      const rows = known.get(code) ?? [];
      rows.push({ id: get("stop_id"), lat: Number(get("stop_lat")), lon: Number(get("stop_lon")) });
      known.set(code, rows);
      const name = get("stop_name");
      const names = named.get(name) ?? [];
      names.push(rows.at(-1)!);
      named.set(name, names);
    });
    await processArchiveCsv(archive, "routes.txt", ["route_id"], (get) => {
      routes.add(get("route_id"));
    });
  }
  const options = { fetch },
    headers = await citywayHeaders(feed, options);
  const lines: Schema.Schema.Type<typeof linesSchema>["Lines"][number][] = [];
  for (let page = 1; page <= 20; page++) {
    const data = Schema.decodeUnknownSync(linesSchema)(
      await readVendorDocument(
        options,
        `${feed.url}/tsvc/api/v5/lines/byNetwork/${feed.networkId}?page=${page}&perPage=100`,
        { headers, interval: 3600 },
      ),
    );
    lines.push(...data.Lines);
    if (lines.length >= data.Count) break;
    if (!data.Lines.length || page === 20) throw new Error("Incomplete Cityway line roster");
  }
  const index: Record<string, CitywayStopRequest[]> = {};
  for (const line of lines) {
    if (!routes.has(line.Number)) throw new Error("Cityway route is missing from static feed");
    for (const direction of line.LineDirections) {
      if (direction.Direction !== 1 && direction.Direction !== 2)
        throw new Error("Invalid Cityway direction");
      const stops = Schema.decodeUnknownSync(stopsSchema)(
        await readVendorDocument(
          options,
          `${feed.url}/tsvc/api/v5/stops/byLine/${line.Id}/${direction.Direction}`,
          { headers, interval: 3600 },
        ),
      );
      for (const stop of stops) {
        const code = /^(\d+)\s*\|/.exec(stop.Name)?.[1];
        const candidates = (code ? known.get(code) : named.get(stop.Name))?.filter(
          (s) =>
            Math.hypot(
              (s.lat - stop.Latitude) * 111000,
              (s.lon - stop.Longitude) * 111000 * Math.cos((stop.Latitude * Math.PI) / 180),
            ) < 150,
        );
        if (!candidates?.length)
          throw new Error(`Cityway stop is missing from static feed: ${stop.Id} ${stop.Name}`);
        const request: CitywayStopRequest = {
          logicalStopId: String(stop.LogicalStopPointId),
          physicalStopId: String(stop.Id),
          lineId: String(line.Id),
          routeId: line.Number,
          direction: direction.Direction,
        };
        for (const candidate of candidates) {
          const list = (index[candidate.id] ??= []);
          if (!list.some((r) => JSON.stringify(r) === JSON.stringify(request))) list.push(request);
        }
      }
    }
  }
  return Object.fromEntries(Object.entries(index).sort(([a], [b]) => a.localeCompare(b)));
}
