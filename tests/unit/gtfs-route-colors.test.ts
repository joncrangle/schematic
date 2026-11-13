import { describe, expect, it } from "vitest";

import { projectGtfsTopology } from "~/infrastructure/gtfs/staticTopology";
import type { GtfsProjectionConfig } from "~/infrastructure/gtfs/config";
import { gtfsZip } from "../helpers/gtfsArchive";

const csv = (rows: readonly (readonly string[])[]) =>
  rows.map((row) => row.join(",")).join("\n") + "\n";

const archive = () =>
  gtfsZip({
    "routes.txt": csv([
      ["route_id", "route_type", "route_short_name", "route_color", "route_text_color"],
      ["7", "3", "7", "000000", "FFFFFF"],
    ]),
    "trips.txt": csv([
      ["route_id", "service_id", "trip_id", "trip_headsign", "shape_id"],
      ["7", "1", "t1", "Centre", "s0"],
    ]),
    "stops.txt": csv([
      ["stop_id", "stop_name", "stop_lat", "stop_lon"],
      ["A", "A", "43.5", "-80.5"],
    ]),
    "stop_times.txt": csv([
      ["trip_id", "stop_id", "stop_sequence"],
      ["t1", "A", "1"],
    ]),
    "shapes.txt": csv([
      ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"],
      ["s0", "43.5", "-80.5", "1"],
    ]),
  });

const config = (overrides: Partial<GtfsProjectionConfig> = {}): GtfsProjectionConfig => ({
  id: "test",
  routeTypes: new Set([3]),
  routeIdField: "id",
  defaultColor: "#123456",
  defaultTextColor: "#EEEEEE",
  ...overrides,
});

describe("static route colours", () => {
  it("keeps the feed's route colours by default", async () => {
    const topology = await projectGtfsTopology([archive()], config());

    expect(topology.routes[0]).toMatchObject({ color: "#000000", text_color: "#FFFFFF" });
  });

  it("uses the declared defaults when the agency ignores feed route colours", async () => {
    const topology = await projectGtfsTopology(
      [archive()],
      config({ ignoreFeedRouteColors: true }),
    );

    expect(topology.routes[0]).toMatchObject({ color: "#123456", text_color: "#EEEEEE" });
  });
});
