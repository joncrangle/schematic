import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { SchematicStationIndexEntry } from "~/agencies/types";
import { buildFerrySailingLegIndex } from "~/infrastructure/gtfs/ferrySailingLegIndex";
import { decodeFerrySailingBoard } from "~/infrastructure/realtime/ferrySailings/ferrySailingBoardDecoder";
import { parseWallClock } from "~/infrastructure/realtime/wallClock";
import { createFerrySailingStationsSource } from "~/infrastructure/realtime/ferrySailings/ferrySailingSource";
import { gtfsZip } from "../helpers/gtfsArchive";

// A zone with a DST transition; board times carry no offset.
const timeZone = "America/Toronto";
const terminals = { NTH: "north-terminal", STH: "south-terminal", EST: "east-terminal" };
const terminalNames = { NTH: "North Harbour", STH: "South Point", EST: "East Cove" };
const legs = {
  "NTH>STH": { routeId: "crossing", directionId: 1 as const, headsign: "South Point" },
};
const board = { terminal: "NTH", board: "route07", routeId: "crossing" };
const options = { ...board, terminals, legs, terminalNames, timeZone };

function sailing(overrides: Record<string, unknown> = {}) {
  return {
    dept: "NTH",
    dest: "STH",
    scheduledDeparture: "2026-07-01 09:00:00",
    actualDepartureTs: null,
    status: "S",
    departureStatus: "On time",
    ...overrides,
  };
}
function wire(sailings: readonly object[], cams: object | null = { route07: {} }) {
  return new TextEncoder().encode(
    JSON.stringify({ arrivalDepartures: sailings.length ? { route07: sailings } : {}, cams }),
  );
}

describe("ferry sailing board decoder", () => {
  it.each([
    ["daylight time", "2026-07-01 09:00:00", "2026-07-01T13:00:00Z"],
    ["standard time", "2026-12-01 09:00:00", "2026-12-01T14:00:00Z"],
  ])("resolves offset-free board times in the board zone during %s", (_, local, utc) => {
    expect(parseWallClock(local, timeZone)).toBe(Date.parse(utc));
  });

  it.each([
    ["skipped by the spring-forward transition", "2026-03-08 02:30:00"],
    ["outside the calendar", "2026-02-31 09:00:00"],
  ])("rejects a local time %s", (_, local) => {
    expect(() => parseWallClock(local, timeZone)).toThrow();
  });

  it("keeps scheduled sailings that have not left, with only informative status text", () => {
    const sailings = decodeFerrySailingBoard(
      wire([
        sailing({ actualDepartureTs: "2026-07-01 07:05:00", scheduledDeparture: "2026-07-01 07:00:00" }),
        sailing(),
        sailing({ scheduledDeparture: "2026-07-01 11:00:00", departureStatus: "Mechanical delay" }),
        sailing({ scheduledDeparture: "2026-07-01 13:00:00", departureStatus: "Sailing cancelled" }),
      ]),
      options,
    );
    expect(sailings.map(({ scheduledTime, status, directionId, headsign }) => ({
      scheduledTime,
      status,
      directionId,
      headsign,
    }))).toEqual([
      { scheduledTime: Date.parse("2026-07-01T13:00:00Z"), status: undefined, directionId: 1, headsign: "South Point" },
      { scheduledTime: Date.parse("2026-07-01T15:00:00Z"), status: "Mechanical delay", directionId: 1, headsign: "South Point" },
    ]);
  });

  it("keeps the board's route for a terminal pair the static feed lacks", () => {
    const [decoded] = decodeFerrySailingBoard(wire([sailing({ dest: "EST" })]), options);
    expect(decoded).toMatchObject({ routeId: "crossing", directionId: 0, headsign: "East Cove", stopId: "north-terminal" });
  });

  it("accepts an empty board the operator still recognizes", () => {
    expect(decodeFerrySailingBoard(wire([]), options)).toEqual([]);
  });

  it.each([
    ["an unrecognized board", wire([], null)],
    ["an undeclared terminal", wire([sailing({ dest: "WST" })])],
    ["a schema change", new TextEncoder().encode(JSON.stringify({ sailings: [] }))],
  ])("fails on %s instead of reporting no sailings", (_, bytes) => {
    expect(() => decodeFerrySailingBoard(bytes, options)).toThrow();
  });
});

describe("ferry sailing stations source", () => {
  const station: SchematicStationIndexEntry = {
    id: "north",
    name: "North Harbour",
    lat: 49,
    lon: -123,
    lines: ["crossing"],
    platformIds: ["north-terminal"],
  };
  const now = Date.parse("2026-07-01T12:00:00Z");
  const feed = {
    kind: "ferry_sailing_boards" as const,
    url: "https://example.test/boards/{terminal}/{board}",
    format: "json" as const,
    timeZone,
    terminals,
    terminalNames,
    legs,
    boards: [board, { terminal: "STH", board: "route07", routeId: "crossing" }],
  };
  function source(fetch: typeof globalThis.fetch, agencyId: string) {
    return createFerrySailingStationsSource({ agencyId, feed, fetch, now: () => now, stations: [station] });
  }
  const read = (agencyId: string, fetch: typeof globalThis.fetch) =>
    Effect.runPromise(source(fetch, agencyId).fetchByIds({ stationIds: ["north"] } as never));

  it("reads only the boards serving the requested terminals", async () => {
    const urls: string[] = [];
    const [card] = await read("fixture-only-needed", async (input) => {
      urls.push(String(input));
      return new Response(wire([sailing(), sailing({ scheduledDeparture: "2026-07-01 10:00:00" })]));
    });
    expect(urls).toEqual(["https://example.test/boards/nth/route07"]);
    expect(card.arrivals).toEqual([
      {
        directionId: 1,
        label: "→ South Point",
        lineId: "crossing",
        times: [Date.parse("2026-07-01T13:00:00Z"), Date.parse("2026-07-01T14:00:00Z")],
      },
    ]);
    expect(card.arrivalsStale).toBeUndefined();
  });

  it("re-serves the last good board as stale after a failed read", async () => {
    await read("fixture-stale", async () => new Response(wire([sailing()])));
    const [card] = await read("fixture-stale", async () => new Response("<html>error</html>"));
    expect(card.arrivalsStale).toBe(true);
    expect(card.arrivals[0].times).toEqual([Date.parse("2026-07-01T13:00:00Z")]);
  });

  it("fails rather than showing an empty board when no read has succeeded", async () => {
    await expect(read("fixture-never", async () => new Response("", { status: 503 }))).rejects.toThrow();
  });
});

describe("ferry sailing leg index", () => {
  function archive(trips: string, stopTimes: string) {
    return gtfsZip({
      "routes.txt": "route_id,route_type\ncrossing,4\na,4\nb,4\n",
      "stops.txt":
        "stop_id,stop_name,parent_station\nnorth-terminal,North Harbour Ferry Terminal,\nnorth-berth,North Harbour Berth 1,north-terminal\nsouth-terminal,South Point,\nkeats,Keats Landing,\n",
      "trips.txt": "route_id,trip_id,direction_id\n" + trips,
      "stop_times.txt": "trip_id,stop_id,stop_sequence\n" + stopTimes,
    });
  }

  it("indexes every ordered terminal pair a trip serves through its berths", async () => {
    const index = await buildFerrySailingLegIndex(
      [archive("crossing,t1,1\n", "t1,north-berth,1\nt1,keats,2\nt1,south-terminal,3\n")],
      { NTH: "north-terminal", STH: "south-terminal" },
    );
    expect(index).toEqual({
      legs: { "NTH>STH": { routeId: "crossing", directionId: 1, headsign: "South Point" } },
      terminalNames: { NTH: "North Harbour", STH: "South Point" },
    });
  });

  it("rejects a terminal pair served by two routes", async () => {
    await expect(
      buildFerrySailingLegIndex(
        [archive("a,t1,0\nb,t2,0\n", "t1,north-berth,1\nt1,south-terminal,2\nt2,north-terminal,1\nt2,south-terminal,2\n")],
        { NTH: "north-terminal", STH: "south-terminal" },
      ),
    ).rejects.toThrow("Ambiguous GTFS sailing leg: NTH>STH");
  });
});
