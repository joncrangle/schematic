import * as Schema from "effect/Schema";
import type { StaticGtfsFeed } from "~/agencies/types";
import { readVendorDocument } from "../realtime/vendorDocument";
import { writeStoredArchive } from "./archiveWriter";

const rosterSchema = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      attributes: Schema.Struct({
        Name: Schema.String,
        Timezone: Schema.Literals(["CT", "ET"]),
        Coordinates: Schema.Struct({
          Latitude: Schema.NullOr(Schema.String),
          Longitude: Schema.NullOr(Schema.String),
        }),
        Schedule: Schema.Array(
          Schema.Struct({
            Route: Schema.String,
            Stop_No: Schema.NullOr(Schema.Number),
          }),
        ),
        routes: Schema.Struct({
          data: Schema.Array(
            Schema.Struct({
              attributes: Schema.Struct({ Name: Schema.String }),
            }),
          ),
        }),
      }),
    }),
  ),
  meta: Schema.Struct({ pagination: Schema.Struct({ total: Schema.Number }) }),
});
export function decodeSamsaraStations(
  body: unknown,
  coordinateOverrides: Readonly<
    Record<string, { readonly lat: number; readonly lon: number }>
  > = {},
  routeAliases: Readonly<Record<string, string>> = {},
) {
  const data = Schema.decodeUnknownSync(rosterSchema)(body);
  if (!data.data.length || data.data.length !== data.meta.pagination.total)
    throw new Error("Incomplete station roster");
  const stations: Record<string, { name: string; lat: number; lon: number; routeIds: string[] }> =
    {};
  const stops: (string | number)[][] = [],
    calls: (string | number)[][] = [];
  const routes = new Set<string>();
  for (const { id, attributes: station } of data.data) {
    if (station.Coordinates.Latitude === null || station.Coordinates.Longitude === null) {
      if (!station.routes.data.length && !station.Schedule.length) continue;
      throw new Error("Serving station coordinates missing");
    }
    const lat = coordinateOverrides[String(id)]?.lat ?? Number(station.Coordinates.Latitude),
      lon = coordinateOverrides[String(id)]?.lon ?? Number(station.Coordinates.Longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
      throw new Error("Invalid station coordinates");
    const related = station.routes.data.map((r) => r.attributes.Name);
    const routeIds = [
      ...new Set([...related, ...station.Schedule.map((s) => routeAliases[s.Route] ?? s.Route)]),
    ];
    stations[String(id)] = { name: station.Name, lat, lon, routeIds };
    stops.push([
      id,
      id,
      station.Name,
      lat,
      lon,
      station.Timezone === "CT" ? "America/Winnipeg" : "America/Toronto",
    ]);
    for (const routeId of routeIds) {
      routes.add(routeId);
      const schedule = station.Schedule.find((s) => (routeAliases[s.Route] ?? s.Route) === routeId);
      // Unordered source relations establish membership without inventing a route geometry.
      const trip = schedule?.Stop_No == null ? `${routeId}:${id}` : routeId;
      calls.push([trip, "00:00:00", "00:00:00", id, (schedule?.Stop_No ?? 0) + 1]);
    }
  }
  return { stations, stops, routes: [...routes].sort(), calls };
}
export async function fetchSamsaraStations(
  url: string,
  fetch: typeof globalThis.fetch,
  coordinateOverrides?: Readonly<Record<string, { readonly lat: number; readonly lon: number }>>,
  routeAliases?: Readonly<Record<string, string>>,
) {
  return decodeSamsaraStations(
    await readVendorDocument({ fetch }, url, { interval: 3600 }),
    coordinateOverrides,
    routeAliases,
  );
}
const csv = (rows: readonly (readonly (string | number)[])[]) =>
  rows.map((row) => row.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(",")).join("\n") +
  "\n";
export async function buildSamsaraStationsArchive(options: {
  readonly feed: Pick<StaticGtfsFeed, "url" | "name"> & {
    readonly samsaraStations: NonNullable<StaticGtfsFeed["samsaraStations"]>;
  };
  readonly fetch: typeof fetch;
}): Promise<Uint8Array> {
  const { feed } = options,
    data = await fetchSamsaraStations(
      feed.url,
      options.fetch,
      feed.samsaraStations.coordinateOverrides,
      feed.samsaraStations.routeAliases,
    );
  const trips = new Map<string, string>();
  for (const [trip] of data.calls) {
    const tripId = String(trip);
    const routeId = data.routes.find((r) => tripId === r || tripId.startsWith(`${r}:`));
    if (!routeId) throw new Error("Unknown native route");
    trips.set(tripId, routeId);
  }
  return writeStoredArchive({
    "agency.txt": csv([
      ["agency_id", "agency_name", "agency_url", "agency_timezone"],
      ["1", feed.name ?? "Station boards", new URL(feed.url).origin, feed.samsaraStations.timeZone],
    ]),
    "routes.txt": csv([
      ["route_id", "agency_id", "route_short_name", "route_long_name", "route_type"],
      ...data.routes.map((id) => [id, "1", id, id, 3]),
    ]),
    "stops.txt": csv([
      ["stop_id", "stop_code", "stop_name", "stop_lat", "stop_lon", "stop_timezone"],
      ...data.stops,
    ]),
    "trips.txt": csv([
      ["route_id", "service_id", "trip_id", "trip_headsign", "direction_id"],
      ...[...trips].map(([trip, route]) => [
        route,
        "TOPOLOGY",
        trip,
        route.split(" - ").at(-1)!,
        0,
      ]),
    ]),
    "stop_times.txt": csv([
      ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"],
      ...data.calls,
    ]),
  });
}
