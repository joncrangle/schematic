import { expect, it } from "vitest";
import { gtfsZip } from "../helpers/gtfsArchive";
import { deriveGtfsProjectionConfig } from "~/infrastructure/gtfs/config";
import { projectGtfsTopology } from "~/infrastructure/gtfs/staticTopology";
const archive = gtfsZip({
  "routes.txt": "route_id,route_short_name,route_type\nBOARD261,1,3\n",
  "trips.txt":
    "route_id,service_id,trip_id,direction_id,shape_id\nBOARD261,BOARD26day,BOARD26trip,0,BOARD26shape\n",
  "stops.txt":
    "stop_id,stop_name,stop_lat,stop_lon,parent_station\nBOARD26stop,Stop,45,-73,BOARD26parent\nBOARD26parent,Station,45,-73,\n",
  "stop_times.txt": "trip_id,stop_id,stop_sequence\nBOARD26trip,BOARD26stop,1\n",
  "shapes.txt":
    "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nBOARD26shape,45,-73,1\nBOARD26shape,45.01,-73.01,2\n",
});
it("keeps colliding feeds distinct after stripping version prefixes", async () => {
  const config = deriveGtfsProjectionConfig(
    { id: "sample", modes: ["bus"] },
    {
      feeds: [
        {
          url: "https://sample.test/a.zip",
          stripIdPrefixPattern: "^BOARD26",
          idNamespace: "north",
        },
        {
          url: "https://sample.test/b.zip",
          stripIdPrefixPattern: "^BOARD26",
          idNamespace: "south",
        },
      ],
    },
  );
  const result = await projectGtfsTopology([archive, archive], config);
  expect(result.routes.map((r) => r.id)).toEqual(["north:1", "south:1"]);
  expect(result.stops.map((r) => r.id).sort()).toEqual(["north:stop", "south:stop"]);
  expect(
    result.route_direction_trips.flatMap((r) => JSON.parse(String(r.trip_ids))).sort(),
  ).toEqual(["north:trip", "south:trip"]);
  expect(result.stops.map((r) => r.parent_station).sort()).toEqual([
    "north:parent",
    "south:parent",
  ]);
  expect(result.route_stops.map((r) => r.stop_id).sort()).toEqual(["north:stop", "south:stop"]);
});

import { decodeGtfsRealtimeSync } from "~/infrastructure/realtime/gtfsRealtimeDecoder";
import { decodeStationTripUpdates } from "~/infrastructure/realtime/stationTripDecoder";
import {
  encodeFeed,
  encodeAlertEntity,
  encodeSubwayTripUpdateEntity,
} from "../helpers/gtfs-rt-binary";
it("namespaces live predictions and alert selectors consistently across both departure decoders", () => {
  const bytes = encodeFeed(1800000000, [
    encodeSubwayTripUpdateEntity({
      entityId: "event",
      tripId: "trip",
      routeId: "1",
      stopId: "stop",
      arrivalTimeSec: 1800000060,
    }),
    encodeAlertEntity({
      id: "notice",
      selectors: [{ routeId: "1", stopId: "stop", tripId: "trip" }],
      effect: 1,
    }),
  ]);
  const feed = decodeGtfsRealtimeSync(bytes, {
    idNamespace: "north",
    routeIds: new Set(["north:1"]),
    stopIds: new Set(["north:stop"]),
  });
  expect(feed.tripUpdates[0]).toMatchObject({
    tripId: "north:trip",
    routeId: "north:1",
    stopId: "north:stop",
  });
  expect(feed.alerts[0]).toMatchObject({
    id: "north:notice",
    tripIds: ["north:trip"],
    targets: [{ routeId: "north:1", stopId: "north:stop" }],
  });
  expect(
    decodeStationTripUpdates(bytes, new Set(["north:stop"]), undefined, {
      idNamespace: "north",
    })[0],
  ).toMatchObject({ tripId: "north:trip", routeId: "north:1", stopId: "north:stop" });
});

import { createStaticFeedIdentity } from "~/infrastructure/gtfs/feedIdentity";
it.each([
  "JANV",
  "FÉVR",
  "MARS",
  "AVRI",
  "MAI",
  "JUIN",
  "JUIL",
  "AOÛT",
  "SEPT",
  "OCTO",
  "NOVE",
  "DÉCE",
])(
  "strips the %s board prefix for every two-digit year without changing calendar identities",
  (month) => {
    const transform = createStaticFeedIdentity({ stripIdPrefixPattern: "^\\p{L}+[0-9]{2}" });
    for (let year = 0; year < 100; year++) {
      const prefix = month + String(year).padStart(2, "0");
      expect(transform("route_id", prefix + "12E")).toBe("12E");
      expect(transform("service_id", prefix + "DIM")).toBe(prefix + "DIM");
      expect(transform("stop_code", prefix + "123")).toBe(prefix + "123");
    }
  },
);
it.each([0, 10])(
  "accepts bounded ZIP padding (%s) while rejecting arbitrary trailing bytes",
  async (padding) => {
    const config = deriveGtfsProjectionConfig({ id: "sample", modes: ["bus"] }, {});
    const newline = new Uint8Array(archive.length + 1);
    newline.set(archive);
    newline[archive.length] = padding;
    expect((await projectGtfsTopology([newline], config)).routes).toHaveLength(1);
    newline[archive.length] = 65;
    await expect(projectGtfsTopology([newline], config)).rejects.toThrow(
      "Invalid GTFS ZIP directory",
    );
  },
);
