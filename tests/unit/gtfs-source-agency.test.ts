import { describe, expect, it } from "vitest";
import { deriveGtfsProjectionConfig } from "~/infrastructure/gtfs/config";
import { hashGtfsArchives, projectGtfsTopology } from "~/infrastructure/gtfs/staticTopology";
import { gtfsZip } from "../helpers/gtfsArchive";

const archive = gtfsZip({
  "routes.txt": "route_id,agency_id,route_type,route_short_name\nours,alpha,3,10\npartner,beta,3,10\n",
  "trips.txt": "route_id,service_id,trip_id,direction_id,shape_id\nours,s,a,0,sa\npartner,s,b,0,sb\n",
  "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\nshared,Terminal,44,-78\nforeign,Depot,44.1,-78.1\n",
  "stop_times.txt": "trip_id,stop_id,stop_sequence\na,shared,1\nb,shared,1\nb,foreign,2\n",
  "shapes.txt": "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nsa,44,-78,1\nsa,44.01,-78.01,2\nsb,44,-78,1\nsb,44.1,-78.1,2\n",
});
const config = (sourceAgencyIds?: readonly string[]) => deriveGtfsProjectionConfig(
  { id: "fictional", modes: ["bus"] }, { sourceAgencyIds },
);

describe("GTFS source agency selection", () => {
  it("projects only the selected operator's connected route graph, retaining shared stops", async () => {
    const topology = await projectGtfsTopology([archive], config(["alpha"]));
    expect(topology.routes.map(row => row.id)).toEqual(["ours"]);
    expect(topology.stops.map(row => row.id)).toEqual(["shared"]);
    expect(topology.route_direction_trips.flatMap(row => JSON.parse(String(row.trip_ids)))).toEqual(["a"]);
    expect(topology.route_shapes.map(row => row.route_id)).toEqual(["ours"]);
    expect(topology.route_trip_terminals.flatMap(row => JSON.parse(String(row.trip_ids)))).toEqual(["a"]);
  });
  it("keeps unfiltered archives unchanged", async () => {
    expect((await projectGtfsTopology([archive], config())).routes.map(row => row.id)).toEqual(["ours", "partner"]);
  });
  it("invalidates persisted hashes when operator selection changes", async () => {
    expect(await hashGtfsArchives([archive], config(["alpha"]))).not.toBe(await hashGtfsArchives([archive], config()));
  });
});
