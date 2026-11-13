import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import {
  projectGtfsTopology,
  TRIP_IDS_PER_PART,
  type GtfsRow,
} from "~/infrastructure/gtfs/staticTopology";
import type { GtfsProjectionConfig } from "~/infrastructure/gtfs/config";
import { makeD1Reads } from "~/infrastructure/storage/surfaceStore/reads";
import { gtfsZip } from "../helpers/gtfsArchive";
import { createMemoryD1 } from "../helpers/memoryD1";

/**
 * A direction group is stored as one row holding every trip id it owns, rather
 * than one row per trip. That shape reduces the write cost of trip membership, and it is also the only join that
 * resolves direction for a feed publishing no `direction_id`, so a group that
 * loses or gains a trip id silently costs a rider their direction.
 *
 * Fixtures are shaped like real operator feeds: two directions on one route,
 * each with several trips.
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

/** One route, two directions, several trips each. */
async function twoDirectionTopology() {
  return projectGtfsTopology(
    [
      gtfsZip({
        "routes.txt": route("1"),
        "trips.txt": csv([
          ["route_id", "service_id", "trip_id", "trip_headsign", "direction_id", "shape_id"],
          ["1", "1", "outbound-1", "Mount Pleasant", "0", "s0"],
          ["1", "1", "outbound-2", "Mount Pleasant", "0", "s0"],
          ["1", "1", "inbound-1", "Longbranch", "1", "s1"],
          ["1", "1", "inbound-2", "Longbranch", "1", "s1"],
        ]),
        "stops.txt": STOPS,
        "stop_times.txt": stopsFor([
          ["outbound-1", ["A", "B"]],
          ["outbound-2", ["A", "B"]],
          ["inbound-1", ["B", "C"]],
          ["inbound-2", ["B", "C"]],
        ]),
        "shapes.txt": [shape("s0", ["43.5", "43.6"]), shape("s1", ["43.6", "43.7"])].join(""),
      }),
    ],
    config,
  );
}

const tripIdsOf = (row: GtfsRow): string[] => {
  const parsed: unknown = JSON.parse(String(row.trip_ids));
  expect(Array.isArray(parsed)).toBe(true);
  return parsed as string[];
};

/** The reader as callers see it, over a database holding the projected rows. */
async function readDirections(
  topology: Awaited<ReturnType<typeof twoDirectionTopology>>,
  routeId: string,
  tripIds: readonly string[],
): Promise<Map<string, number>> {
  const db = await createMemoryD1();
  // The table's foreign key onto routes is enforced, and the seeder always
  // writes routes first, so the fixture establishes that same parent row.
  for (const route of topology.routes ?? [])
    await db
      .prepare(
        "INSERT INTO routes (agency_id, id, short_name, long_name, route_type, color, text_color) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        route.agency_id,
        route.id,
        route.short_name,
        route.long_name,
        route.route_type,
        route.color,
        route.text_color,
      )
      .run();
  for (const row of topology.route_direction_trips ?? [])
    await db
      .prepare(
        "INSERT INTO route_direction_trips (agency_id, route_id, direction_id, part, trip_ids) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(row.agency_id, row.route_id, row.direction_id, row.part, row.trip_ids)
      .run();
  return Effect.runPromise(
    makeD1Reads(db, { agencyId: "test" }).readDirectionsForTrips(routeId, tripIds),
  );
}

describe("direction group trip membership", () => {
  it("stores every trip of a group on that group's single row", async () => {
    // Two trips share a direction, so both must survive on one row: this is
    // the compaction, and a trip dropped here is a departure that loses its
    // direction at the station.
    const topology = await twoDirectionTopology();

    const rows = topology.route_direction_trips ?? [];
    const byDirection = new Map(rows.map((r) => [Number(r.direction_id), tripIdsOf(r)] as const));

    expect(rows).toHaveLength(2);
    expect(byDirection.get(0)?.sort()).toEqual(["outbound-1", "outbound-2"]);
    expect(byDirection.get(1)?.sort()).toEqual(["inbound-1", "inbound-2"]);
  });

  it("resolves every trip of both directions from one reader call", async () => {
    // The public seam: callers ask about trips spanning several groups and get
    // each trip's own direction back.
    const topology = await twoDirectionTopology();

    const directions = await readDirections(topology, "1", [
      "outbound-1",
      "inbound-1",
      "outbound-2",
      "inbound-2",
    ]);

    expect(directions.get("outbound-1")).toBe(0);
    expect(directions.get("outbound-2")).toBe(0);
    expect(directions.get("inbound-1")).toBe(1);
    expect(directions.get("inbound-2")).toBe(1);
  });

  it("omits a trip that belongs to no group", async () => {
    // A realtime feed naming a trip static GTFS never published must leave the
    // caller to fall back, so an unknown trip has to be absent rather than
    // defaulted to some direction.
    const topology = await twoDirectionTopology();

    const directions = await readDirections(topology, "1", [
      "outbound-1",
      "added-after-publication",
    ]);

    expect(directions.has("added-after-publication")).toBe(false);
    expect(directions.get("outbound-1")).toBe(0);
  });

  it("spreads a huge group over several rows and still resolves every trip", async () => {
    // A group's trips travel as one JSON array, so a group with very many trips
    // makes one very large INSERT. D1 rejects any single statement over roughly
    // 100KB with SQLITE_TOOBIG, which is how GO's UP line failed to seed with
    // 14,125 trips in one direction group. The group is therefore split into
    // parts, and the reader must still answer for every trip across all of them.
    const tripCount = 4_500;
    const trips: [string, string[]][] = Array.from({ length: tripCount }, (_, i) => [
      `t${i}`,
      ["A", "B"],
    ]);
    const topology = await projectGtfsTopology(
      [
        gtfsZip({
          "routes.txt": route("1"),
          "trips.txt": csv([
            ["route_id", "service_id", "trip_id", "trip_headsign", "direction_id", "shape_id"],
            ...trips.map(([id]) => ["1", "1", id!, "Mount Pleasant", "0", "s0"]),
          ]),
          "stops.txt": STOPS,
          "stop_times.txt": stopsFor(trips),
          "shapes.txt": shape("s0", ["43.5", "43.6"]),
        }),
      ],
      config,
    );

    const rows = topology.route_direction_trips ?? [];
    // Parts are numbered from zero and the key stays unique.
    expect(new Set(rows.map((r) => r.part)).size).toBe(rows.length);

    // The cap is what keeps each statement small enough for D1, so the test pins
    // the cap's own value rather than only the ceiling it protects. Deriving the
    // expectation from the same constant would be tautological: halving the cap
    // would halve the expectation too and the suite would stay green while
    // quietly multiplying GO's row count on every reseed.
    expect(TRIP_IDS_PER_PART).toBe(2_000);
    expect(rows).toHaveLength(3); // 4,500 trips at 2,000 per part
    for (const row of rows) {
      expect(JSON.parse(String(row.trip_ids)).length).toBeLessThanOrEqual(2_000);
      // 2,000 ids of ~16 characters is ~34KB, well under D1's ~100KB statement
      // limit, so a part at the cap can never be what fails a seed.
      expect(String(row.trip_ids).length).toBeLessThan(100_000);
    }

    // The point of splitting: no trip is lost, so every one still resolves.
    const ids = Array.from({ length: tripCount }, (_, i) => `t${i}`);
    const directions = await readDirections(topology, "1", ids);
    expect(directions.size).toBe(tripCount);
    expect(directions.get("t0")).toBe(0);
    expect(directions.get(`t${tripCount - 1}`)).toBe(0);
  });

  it("returns nothing for a route that has no groups", async () => {
    // Directions are keyed by route, so another route's groups must not answer
    // for a route this agency never seeded.
    const topology = await twoDirectionTopology();

    expect(await readDirections(topology, "99", ["outbound-1", "inbound-1"])).toEqual(
      new Map<string, number>(),
    );
  });
});

it("resolves requested trips to canonical routes and directions within one agency", async () => {
  const db = await createMemoryD1();
  for (const agency of ["sample", "other"]) {
    await db
      .prepare(
        "INSERT INTO routes (agency_id, id, short_name, long_name, route_type, color, text_color) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(agency, "R", "R", "Route", "bus", "#000", "#fff")
      .run();
    await db
      .prepare(
        "INSERT INTO route_direction_trips (agency_id, route_id, direction_id, part, trip_ids) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        agency,
        "R",
        agency === "sample" ? 1 : 0,
        0,
        JSON.stringify(["modified-trip", "unrequested"]),
      )
      .run();
  }
  const routes = await Effect.runPromise(
    makeD1Reads(db, { agencyId: "sample" }).readRoutesForTrips(["modified-trip", "missing"]),
  );
  expect([...routes]).toEqual([["modified-trip", { routeId: "R", directionId: 1 }]]);
});
