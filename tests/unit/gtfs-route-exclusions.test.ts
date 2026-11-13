import { describe, expect, it } from "vitest";
import { deriveGtfsProjectionConfig } from "~/infrastructure/gtfs/config";
import { hashGtfsArchives, projectGtfsTopology } from "~/infrastructure/gtfs/staticTopology";
import { gtfsZip } from "../helpers/gtfsArchive";

const archive = gtfsZip({
  "routes.txt": "route_id,route_type,route_short_name\npublic,3,1\nprivate,3,50\n",
  "trips.txt": "route_id,service_id,trip_id,direction_id\npublic,s,p,0\nprivate,s,x,0\n",
  "stops.txt":
    "stop_id,stop_name,stop_lat,stop_lon\nshared,Terminal,44,-78\nprivate-only,Depot,44.1,-78.1\n",
  "stop_times.txt": "trip_id,stop_id,stop_sequence\np,shared,1\nx,shared,1\nx,private-only,2\n",
});
const config = (excludedRouteIds?: readonly string[]) =>
  deriveGtfsProjectionConfig(
    { id: "fictional", modes: ["bus"] },
    { routeIdField: "short_name", excludedRouteIds },
  );

describe("GTFS route exclusions", () => {
  it("excludes raw route IDs before folding and removes their exclusive topology", async () => {
    const topology = await projectGtfsTopology([archive], config(["private"]));
    expect(topology.routes.map((r) => r.id)).toEqual(["1"]);
    expect(topology.stops.map((s) => s.id)).toEqual(["shared"]);
    expect(
      topology.route_direction_trips.flatMap((row) => JSON.parse(String(row.trip_ids))),
    ).toEqual(["p"]);
    expect(
      topology.route_trip_terminals.flatMap((row) => JSON.parse(String(row.trip_ids))),
    ).toEqual(["p"]);
  });

  it("invalidates the archive gate when route scope changes", async () => {
    expect(await hashGtfsArchives([archive], config(["private"]))).not.toEqual(
      await hashGtfsArchives([archive], config()),
    );
  });
});
