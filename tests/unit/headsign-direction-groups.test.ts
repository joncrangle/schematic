import { describe, expect, it } from "vitest";

import { projectGtfsTopology } from "~/infrastructure/gtfs/staticTopology";
import type { GtfsProjectionConfig } from "~/infrastructure/gtfs/config";
import { gtfsZip } from "../helpers/gtfsArchive";

/**
 * A direction is a way of travel, not a destination.
 *
 * A rider standing at a station waits for the next train going one way and the
 * next going the other. Grouping seeded rows per headsign gave one row per
 * destination instead, so a GO station offered eight rows on a single line and
 * a bus route offered one per branch with the same terminal repeated. Grouping
 * is per `direction_id`, which is what the operator states as the direction of
 * travel; the headsign names the group.
 */
const config: GtfsProjectionConfig = {
  id: "test",
  routeTypes: new Set([3]),
  routeIdField: "short_name",
  defaultColor: "#000",
  defaultTextColor: "#fff",
};

const csv = (rows: readonly (readonly string[])[]) =>
  rows.map((row) => row.join(",")).join("\n") + "\n";

const STOPS = csv([
  ["stop_id", "stop_name", "stop_lat", "stop_lon"],
  ["A", "A", "43.5", "-80.5"],
  ["B", "B", "43.6", "-80.5"],
  ["C", "C", "43.7", "-80.5"],
]);

const route = (id: string) =>
  csv([
    ["route_id", "route_type", "route_short_name"],
    [id, "3", id],
  ]);

const shape = (id: string, lats: readonly string[]) =>
  csv([
    ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"],
    ...lats.map((lat, i) => [id, lat, "-80.5", String(i + 1)]),
  ]);

const stopsFor = (trips: readonly (readonly [string, readonly string[]])[]) =>
  csv([
    ["trip_id", "stop_id", "stop_sequence"],
    ...trips.flatMap(([tripId, stopIds]) =>
      stopIds.map((stopId, i) => [tripId, stopId, String(i + 1)]),
    ),
  ]);

describe("direction groups are ways of travel", () => {
  it("gives one row per direction even when a direction has many branches", async () => {
    // GO's shape: route 18 runs several branch variants, all of them either
    // toward Union or toward Hamilton. A rider at a station on this line wants
    // one row each way, not twelve.
    const topology = await projectGtfsTopology(
      [
        gtfsZip({
          "routes.txt": route("18"),
          "trips.txt": csv([
            ["route_id", "service_id", "trip_id", "trip_headsign", "direction_id", "shape_id"],
            ["18", "1", "t1", "18A - Union Station", "0", "s0"],
            ["18", "1", "t2", "18B - Union Station", "0", "s1"],
            ["18", "1", "t3", "18E - Union Station", "0", "s2"],
            ["18", "1", "t4", "18C - Hamilton GO", "1", "s3"],
            ["18", "1", "t5", "18H - Hamilton GO", "1", "s4"],
          ]),
          "stops.txt": STOPS,
          "stop_times.txt": stopsFor([
            ["t1", ["A", "B"]],
            ["t2", ["A", "B"]],
            ["t3", ["A", "B"]],
            ["t4", ["B", "C"]],
            ["t5", ["B", "C"]],
          ]),
          "shapes.txt": [
            shape("s0", ["43.5", "43.6"]),
            shape("s1", ["43.5", "43.6"]),
            shape("s2", ["43.5", "43.6"]),
            shape("s3", ["43.6", "43.7"]),
            shape("s4", ["43.6", "43.7"]),
          ].join(""),
        }),
      ],
      config,
    );

    const shapes = topology.route_shapes ?? [];

    // Two rows: the direction of travel, not the branch.
    expect(shapes).toHaveLength(2);
    expect(shapes.map((s) => s.direction_id).sort()).toEqual([0, 1]);
    // Each is named for the headsign most of its trips state.
    expect(shapes.map((s) => s.headsign).sort()).toEqual([
      "18A - Union Station",
      "18C - Hamilton GO",
    ]);
  });

  it("keeps a group labelled by its own trips when a direction has no majority", async () => {
    // An even split has no dominant headsign, so the label must still be one of
    // the operator's own words rather than a compass word we invented.
    const topology = await projectGtfsTopology(
      [
        gtfsZip({
          "routes.txt": route("7"),
          "trips.txt": csv([
            ["route_id", "service_id", "trip_id", "trip_headsign", "direction_id", "shape_id"],
            ["7", "1", "t1", "Conestoga Station", "0", "s0"],
            ["7", "1", "t2", "Fairway Station", "0", "s0"],
            ["7", "1", "t3", "Fairway Station", "1", "s1"],
          ]),
          "stops.txt": STOPS,
          "stop_times.txt": stopsFor([
            ["t1", ["A", "B"]],
            ["t2", ["A", "B"]],
            ["t3", ["B", "C"]],
          ]),
          "shapes.txt": [shape("s0", ["43.5", "43.6"]), shape("s1", ["43.6", "43.7"])].join(""),
        }),
      ],
      config,
    );

    const headsigns = (topology.route_shapes ?? []).map((s) => s.headsign);

    expect(headsigns.length).toBe(2);
    for (const headsign of headsigns) expect(headsign).not.toBe("");
  });

  it("records every trip of a direction so arrivals can be attributed", async () => {
    // This table is the only join that resolves direction for a feed publishing
    // no direction_id, so a missing trip means a departure loses its direction.
    const topology = await projectGtfsTopology(
      [
        gtfsZip({
          "routes.txt": route("1"),
          "trips.txt": csv([
            ["route_id", "service_id", "trip_id", "trip_headsign", "shape_id"],
            ["1", "1", "trip-a", "Montreal Street", "s0"],
            ["1", "1", "trip-b", "Montreal Street", "s1"],
          ]),
          "stops.txt": STOPS,
          "stop_times.txt": stopsFor([
            ["trip-a", ["A", "B"]],
            ["trip-b", ["A", "B"]],
          ]),
          "shapes.txt": [shape("s0", ["43.5", "43.6"]), shape("s1", ["43.5", "43.6"])].join(""),
        }),
      ],
      config,
    );

    const tripRows = topology.route_direction_trips ?? [];

    // Both trips share one direction, so they share one row carrying both ids.
    // One row per trip instead would cost 386k writes across eleven agencies
    // against 1.4k here, and would re-pay that weekly as trip ids churn.
    expect(tripRows).toHaveLength(1);
    expect(JSON.parse(String(tripRows[0]!.trip_ids))).toEqual(["trip-a", "trip-b"]);
    expect(new Set(tripRows.map((r) => r.direction_id)).size).toBe(1);
  });
});

describe("feeds that state no direction_id", () => {
  it("splits trips whose shapes run opposite ways into two directions", async () => {
    // One route runs both ways under one name, as an evening routing does, and
    // the feed publishes no direction_id. One group would put northbound and
    // southbound departures in a single row labelled by whichever shape won.
    const topology = await projectGtfsTopology(
      [
        gtfsZip({
          "routes.txt": route("30"),
          "trips.txt": csv([
            ["route_id", "service_id", "trip_id", "trip_headsign", "shape_id"],
            ["30", "1", "up-1", "Uptown", "north"],
            ["30", "1", "up-2", "Uptown", "north"],
            ["30", "1", "down-1", "Downtown", "south"],
          ]),
          "stops.txt": STOPS,
          "stop_times.txt": stopsFor([
            ["up-1", ["A", "C"]],
            ["up-2", ["A", "C"]],
            ["down-1", ["C", "A"]],
          ]),
          "shapes.txt": [
            shape("north", ["43.5", "43.7"]),
            shape("south", ["43.7", "43.5"]).split("\n").slice(1).join("\n"),
          ].join(""),
        }),
      ],
      config,
    );

    const directions = Object.fromEntries(
      (topology.route_direction_trips ?? []).map((row) => [
        row.direction_id,
        JSON.parse(String(row.trip_ids)),
      ]),
    );
    expect(directions).toEqual({ 0: ["up-1", "up-2"], 1: ["down-1"] });
    expect(
      (topology.route_shapes ?? []).map((row) => [row.direction_id, row.headsign]).sort(),
    ).toEqual([
      [0, "Uptown"],
      [1, "Downtown"],
    ]);
  });

  it("keeps a loop that returns to its start as one direction", async () => {
    const topology = await projectGtfsTopology(
      [
        gtfsZip({
          "routes.txt": route("10"),
          "trips.txt": csv([
            ["route_id", "service_id", "trip_id", "trip_headsign", "shape_id"],
            ["10", "1", "loop-1", "Heights", "loop"],
            ["10", "1", "loop-2", "Heights", "loop"],
          ]),
          "stops.txt": STOPS,
          "stop_times.txt": stopsFor([
            ["loop-1", ["A", "C", "A"]],
            ["loop-2", ["A", "C", "A"]],
          ]),
          "shapes.txt": shape("loop", ["43.5", "43.7", "43.5"]),
        }),
      ],
      config,
    );

    expect((topology.route_direction_trips ?? []).map((row) => row.direction_id)).toEqual([0]);
  });
});

it("groups each trip's own headsign by route, leaving unsigned trips out", async () => {
  const topology = await projectGtfsTopology(
    [
      gtfsZip({
        "routes.txt": route("BR"),
        "trips.txt":
          "route_id,trip_id,direction_id,shape_id,trip_headsign\nBR,short,0,s,Midtown\nBR,through,0,s,Uptown\nBR,through-copy,0,s,Uptown\nBR,unsigned,0,s,\n",
        "stops.txt": STOPS,
        "stop_times.txt":
          "trip_id,stop_id,stop_sequence\nshort,A,5\nshort,B,20\nthrough,A,5\nthrough,C,40\nthrough-copy,A,5\nthrough-copy,C,40\nunsigned,A,5\nunsigned,C,40\n",
        "shapes.txt": shape("s", ["43.5", "43.6", "43.7"]),
      }),
    ],
    config,
  );

  expect(topology.route_trip_headsigns).toEqual([
    { agency_id: "test", route_id: "BR", headsign: "Midtown", part: 0, trip_ids: '["short"]' },
    {
      agency_id: "test",
      route_id: "BR",
      headsign: "Uptown",
      part: 0,
      trip_ids: '["through","through-copy"]',
    },
  ]);
});

it("groups per-trip terminals independently of shape, headsign, and CSV row order", async () => {
  const topology = await projectGtfsTopology(
    [
      gtfsZip({
        "routes.txt": route("BR"),
        "trips.txt":
          "route_id,trip_id,direction_id,shape_id\nBR,short,0,s\nBR,through,0,s\nBR,through-copy,0,s\nBR,shapeless,0,\n",
        "stops.txt": STOPS,
        "stop_times.txt":
          "trip_id,stop_id,stop_sequence\nshort,B,20\nshort,A,5\nthrough,C,40\nthrough,B,20\nthrough,A,5\nthrough-copy,A,5\nthrough-copy,C,40\nshapeless,B,15\nshapeless,A,5\n",
        "shapes.txt": shape("s", ["43.5", "43.6", "43.7"]),
      }),
    ],
    config,
  );
  expect(topology.route_trip_terminals).toEqual([
    {
      agency_id: "test",
      route_id: "BR",
      direction_id: 0,
      terminal_stop_id: "B",
      terminal_stop_sequence: 20,
      part: 0,
      trip_ids: '["short"]',
    },
    {
      agency_id: "test",
      route_id: "BR",
      direction_id: 0,
      terminal_stop_id: "C",
      terminal_stop_sequence: 40,
      part: 0,
      trip_ids: '["through","through-copy"]',
    },
    {
      agency_id: "test",
      route_id: "BR",
      direction_id: 0,
      terminal_stop_id: "B",
      terminal_stop_sequence: 15,
      part: 0,
      trip_ids: '["shapeless"]',
    },
  ]);
});
