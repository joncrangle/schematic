import { expect, it } from "vitest";
import { buildTsimobileGtfsIndex } from "~/infrastructure/gtfs/tsimobileIndex";
import { gtfsZip } from "../helpers/gtfsArchive";

function archive(trips: string) {
  return gtfsZip({
    "routes.txt": "route_id,route_type\nrail,2\nbus,3\n",
    "stops.txt": "stop_id,stop_code\nopaque-station,CENT\n",
    "stop_times.txt": "trip_id,stop_id,stop_sequence\n",
    "trips.txt": "route_id,trip_short_name,trip_headsign,direction_id\n" + trips,
  });
}

it("joins station codes and connecting rail train numbers from GTFS, including blank directions", async () => {
  const index = await buildTsimobileGtfsIndex([
    archive("rail,97-64,North,\nrail,8,South,1\nbus,4,West,0\n"),
  ]);
  expect(index).toEqual({
    stops: { CENT: "opaque-station" },
    trains: {
      "97": { routeId: "rail", directionId: 0, headsign: "North" },
      "8": { routeId: "rail", directionId: 1, headsign: "South" },
    },
  });
});

it("rejects an ambiguous train join instead of choosing one route", async () => {
  await expect(
    buildTsimobileGtfsIndex([archive("rail,8,North,0\nrail,8,South,1\n")]),
  ).rejects.toThrow("Ambiguous GTFS train number: 8");
});
