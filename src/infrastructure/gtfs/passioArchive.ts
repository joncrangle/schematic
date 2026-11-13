import * as Schema from "effect/Schema";
import type { StaticGtfsFeed } from "~/agencies/types";
import { writeStoredArchive } from "./archiveWriter";
import { readVendorDocument } from "../realtime/vendorDocument";

const id = Schema.Union([Schema.String, Schema.Number]);
const topologySchema = Schema.Struct({
  stops: Schema.Record(
    Schema.String,
    Schema.Struct({ id, name: Schema.String, latitude: Schema.Number, longitude: Schema.Number }),
  ),
  routes: Schema.Record(Schema.String, Schema.Array(Schema.Unknown)),
  routePoints: Schema.Record(
    Schema.String,
    Schema.Array(Schema.Array(Schema.Struct({ lat: Schema.String, lng: Schema.String }))),
  ),
  routeShortNames: Schema.Record(Schema.String, Schema.String),
});
const csv = (rows: readonly (readonly (string | number)[])[]) =>
  rows.map((row) => row.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(",")).join("\n") +
  "\n";
export function decodePassioTopology(body: unknown) {
  const data = Schema.decodeUnknownSync(topologySchema)(body);
  const routeMap: Record<string, string> = {},
    stopRoutes: Record<string, string[]> = {};
  const routes: (string | number)[][] = [],
    trips: (string | number)[][] = [],
    calls: (string | number)[][] = [],
    shapes: (string | number)[][] = [];
  const stops = new Map(Object.values(data.stops).map((s) => [String(s.id), s]));
  for (const [pattern, values] of Object.entries(data.routes).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const [name, color, , ...patternStops] = values;
    const shortName = data.routeShortNames[pattern];
    if (typeof name !== "string" || typeof color !== "string" || !shortName || !patternStops.length)
      throw new Error("Invalid Passio route pattern");
    const routeId = shortName.split(/\s+/)[0];
    routeMap[pattern] = routeId;
    routes.push([pattern, "1", routeId, name, 3, color.replace("#", ""), "000000"]);
    trips.push([pattern, "TOPOLOGY", pattern, "", 0, pattern]);
    for (const ref of patternStops) {
      if (!Array.isArray(ref) || !stops.has(String(ref[1])) || !Number.isFinite(Number(ref[0])))
        throw new Error("Unknown Passio pattern stop");
      const stopId = String(ref[1]);
      calls.push([pattern, "00:00:00", "00:00:00", stopId, Number(ref[0])]);
      const ids = (stopRoutes[stopId] ??= []);
      if (!ids.includes(pattern)) ids.push(pattern);
    }
    const points = data.routePoints[pattern]?.flat();
    if (!points?.length) throw new Error("Missing Passio pattern geometry");
    points.forEach((p, i) => {
      if (!Number.isFinite(Number(p.lat)) || !Number.isFinite(Number(p.lng)))
        throw new Error("Invalid Passio geometry");
      shapes.push([pattern, Number(p.lat), Number(p.lng), i + 1]);
    });
  }
  if (!routes.length || !stops.size) throw new Error("Empty Passio topology");
  return {
    routeMap,
    stopRoutes,
    routes,
    trips,
    calls,
    shapes,
    stops: [...stops.values()].filter((s) => stopRoutes[String(s.id)]),
  };
}
export async function fetchPassioTopology(
  feed: { readonly url: string; readonly passio: { readonly userId: string } },
  fetch: typeof globalThis.fetch,
) {
  const url = new URL(feed.url);
  for (const [k, v] of Object.entries({
    getStops: "2",
    deviceId: "0",
    withOutdated: "1",
    wBounds: "1",
  }))
    url.searchParams.set(k, v);
  return decodePassioTopology(
    await readVendorDocument({ fetch }, url.href, {
      form: new URLSearchParams({
        json: JSON.stringify({ sA: 1, s0: Number(feed.passio.userId) }),
      }).toString(),
      interval: 3600,
    }),
  );
}
/** Pattern-only archives carry no service calendar and never manufacture departures. */
export async function buildPassioArchive(options: {
  readonly feed: Pick<StaticGtfsFeed, "url" | "name"> & {
    readonly passio: { readonly userId: string; readonly timeZone: string };
  };
  readonly fetch: typeof fetch;
}): Promise<Uint8Array> {
  const { feed } = options;
  const data = await fetchPassioTopology(feed, options.fetch);
  return writeStoredArchive({
    "agency.txt": csv([
      ["agency_id", "agency_name", "agency_url", "agency_timezone"],
      ["1", feed.name ?? "Passio", new URL(feed.url).origin, feed.passio.timeZone],
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
      ...data.routes,
    ]),
    "trips.txt": csv([
      ["route_id", "service_id", "trip_id", "trip_headsign", "direction_id", "shape_id"],
      ...data.trips,
    ]),
    "stop_times.txt": csv([
      ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"],
      ...data.calls,
    ]),
    "stops.txt": csv([
      ["stop_id", "stop_code", "stop_name", "stop_lat", "stop_lon"],
      ...data.stops.map((s) => [s.id, s.id, s.name, s.latitude, s.longitude]),
    ]),
    "shapes.txt": csv([
      ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"],
      ...data.shapes,
    ]),
  });
}
