import { describe, expect, it } from "vitest";
import { deriveGtfsProjectionConfig } from "~/infrastructure/gtfs/config";
import { hashGtfsArchives, projectGtfsTopology } from "~/infrastructure/gtfs/staticTopology";
import { gtfsZip } from "../helpers/gtfsArchive";

const archive = gtfsZip({
  "routes.txt": "route_id,route_type,route_short_name\nopaque-a,3,\nopaque-b,3,B\n",
  "trips.txt": "route_id,service_id,trip_id\nopaque-a,s,trip-a\nopaque-b,s,trip-b\n",
  "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\nstop,Terminal,44,-78\n",
  "stop_times.txt": "trip_id,stop_id,stop_sequence\ntrip-a,stop,1\ntrip-b,stop,1\n",
});
const config = (routeShortNames?: Readonly<Record<string, string>>) =>
  deriveGtfsProjectionConfig({ id: "fictional", modes: ["bus"], routeShortNames }, {});

describe("declared public route labels", () => {
  it("uses verified labels without changing canonical routes or trip membership", async () => {
    const topology = await projectGtfsTopology([archive], config({ "opaque-a": "A" }));

    expect(topology.routes.map(({ id, short_name }) => [id, short_name])).toEqual([
      ["opaque-a", "A"],
      ["opaque-b", "B"],
    ]);
    expect(topology.route_direction_trips.map(({ route_id }) => route_id)).toEqual([
      "opaque-a",
      "opaque-b",
    ]);
  });

  it("keys labels by canonical identity after short-name folding", async () => {
    const topology = await projectGtfsTopology([archive], {
      ...config({ B: "Bee" }),
      routeIdField: "short_name",
    });

    expect(topology.routes.map(({ id, short_name }) => [id, short_name])).toEqual([
      ["opaque-a", "opaque-a"],
      ["B", "Bee"],
    ]);
  });

  it("refreshes stored topology when a declared public label changes", async () => {
    expect(await hashGtfsArchives([archive], config({ "opaque-a": "A" }))).not.toEqual(
      await hashGtfsArchives([archive], config({ "opaque-a": "A1" })),
    );
  });
});
