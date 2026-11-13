import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { RealtimeFeedConfig } from "~/agencies/types";
import { processArchiveCsv, readGtfsArchive } from "~/infrastructure/gtfs/archive";
import {
  buildStationTimetableArchive,
  stationTimetableDirections,
} from "~/infrastructure/gtfs/stationTimetableArchive";
import { decodeStationTimetablesDocument } from "~/infrastructure/realtime/stationTimetables/stationTimetablesDecoder";
import { createStationTimetablesStationsSource } from "~/infrastructure/realtime/stationTimetables/stationTimetablesSource";

type Feed = Extract<RealtimeFeedConfig, { kind: "station_timetables" }>;

const now = Date.parse("2026-07-01T15:00:00Z");
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const URL_TEMPLATE = "https://boards.example.test/{station}/{board}?from={from}&to={to}&key=public";

const feed: Feed = {
  kind: "station_timetables",
  url: URL_TEMPLATE,
  format: "json",
  stations: ["hub-a", "hub-b"],
  cityRegions: ["ON", "DC"],
  lookbackHours: 2,
  lookaheadHours: 2,
  directions: { L1: { "North Town": 0, "South Port": 1 } },
};

interface CallFixture {
  readonly stop: string;
  readonly city: string;
  readonly departure?: { readonly scheduled: string; readonly deviation?: Record<string, unknown> };
  readonly arrival?: { readonly scheduled: string; readonly deviation?: Record<string, unknown> };
}

const estimated = (
  minutes: number,
  updatedMinutesAgo = 2,
  extra: Record<string, unknown> = {},
) => ({
  deviation_timestamp: at(minutes),
  deviation_seconds: 120,
  deviation_class: "LATE",
  deviation_type: "ESTIMATED",
  updated_at: at(-updatedMinutesAgo),
  ...extra,
});

function ride(
  id: string,
  calls: readonly CallFixture[],
  options: { line?: string; direction?: string; fixMinutesAgo?: number } = {},
) {
  return {
    id,
    line: {
      code: options.line ?? "[L1]",
      name: "Fixture Line",
      direction: options.direction ?? "North Town",
    },
    vehicle: { id: `${id}-bus` },
    location:
      options.fixMinutesAgo === undefined
        ? null
        : {
            coordinates: { latitude: 43.6, longitude: -79.4 },
            updated_at: at(-options.fixMinutesAgo),
          },
    calls: calls.map((call, index) => ({
      sequence: index + 1,
      stop: {
        id: call.stop,
        name: `${call.stop} stop`,
        code: call.stop.toUpperCase(),
        city: { name: call.city },
        location: { latitude: 43 + index / 10, longitude: -79 },
      },
      arrival: call.arrival ?? null,
      departure: call.departure ?? null,
    })),
  };
}

const decode = (boards: readonly unknown[]) =>
  decodeStationTimetablesDocument(new TextEncoder().encode(JSON.stringify(boards)), feed, now);

describe("station timetables decoder", () => {
  it("predicts only estimated future departures at owned stops", () => {
    const snapshot = decode([
      {
        rides: [
          ride("r1", [
            {
              stop: "foreign",
              city: "Elsewhere, NY",
              departure: { scheduled: at(5), deviation: estimated(7) },
            },
            {
              stop: "owned",
              city: "Lakeside, ON",
              departure: { scheduled: at(28), deviation: estimated(30) },
            },
            { stop: "planned", city: "Lakeside, ON", departure: { scheduled: at(60) } },
            {
              stop: "capital",
              city: "Washington, D.C.",
              departure: { scheduled: at(88), deviation: estimated(90) },
            },
            {
              stop: "end",
              city: "Lakeside, ON",
              arrival: { scheduled: at(120), deviation: estimated(122) },
            },
          ]),
        ],
      },
    ]);

    expect(snapshot.arrivals).toEqual([
      expect.objectContaining({
        tripId: "r1",
        vehicleId: "r1-bus",
        routeId: "L1",
        directionId: 0,
        stopId: "owned",
        stopSequence: 2,
        predictedTime: now + 30 * 60_000,
        delaySeconds: 120,
        headsign: "North Town",
      }),
      expect.objectContaining({ stopId: "capital", predictedTime: now + 90 * 60_000 }),
    ]);
  });

  it.each([
    ["a cancelled call", estimated(30, 2, { deviation_class: "CANCELLED" })],
    ["an estimate older than an hour", estimated(30, 61)],
    ["a departure already made", estimated(-1)],
    ["an actual time rather than an estimate", estimated(30, 2, { deviation_type: "ACTUAL" })],
  ])("skips %s", (_case, deviation) => {
    const snapshot = decode([
      {
        rides: [
          ride("r1", [
            { stop: "owned", city: "Lakeside, ON", departure: { scheduled: at(28), deviation } },
          ]),
        ],
      },
    ]);

    expect(snapshot.arrivals).toEqual([]);
  });

  it("places a coach only with a current fix on a ride that serves an owned stop", () => {
    const owned = { stop: "owned", city: "Lakeside, ON", departure: { scheduled: at(30) } };
    const snapshot = decode([
      {
        rides: [
          ride("fresh", [owned], { fixMinutesAgo: 3, direction: "South Port" }),
          ride("stale", [owned], { fixMinutesAgo: 11 }),
          ride("foreign", [{ ...owned, city: "Elsewhere, NY" }], { fixMinutesAgo: 1 }),
        ],
      },
    ]);

    expect(snapshot.vehicles).toEqual([
      expect.objectContaining({
        vehicleId: "fresh-bus",
        tripId: "fresh",
        routeId: "L1",
        directionId: 1,
        latitude: 43.6,
        longitude: -79.4,
      }),
    ]);
  });

  it("keeps decoding when one ride is malformed", () => {
    const snapshot = decode([
      {
        rides: [
          { id: "broken" },
          ride("r1", [
            {
              stop: "owned",
              city: "Lakeside, ON",
              departure: { scheduled: at(28), deviation: estimated(30) },
            },
          ]),
        ],
      },
    ]);

    expect(snapshot.arrivals).toHaveLength(1);
  });

  it("fails a read whose boards list no rides at all", () => {
    expect(() => decode([{ rides: [] }, { rides: [] }])).toThrow("No rides");
  });
});

describe("station timetables source", () => {
  it("polls both boards at every hub and labels rows with the line", async () => {
    const board = {
      rides: [
        ride("r1", [
          {
            stop: "owned",
            city: "Lakeside, ON",
            departure: { scheduled: at(28), deviation: estimated(30) },
          },
        ]),
      ],
    };
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(board),
    );
    const source = createStationTimetablesStationsSource({
      agencyId: "fixture-coach",
      feed,
      fetch,
      now: () => now,
      routeLineMap: { L1: "corridor" },
      stations: [
        {
          id: "OWNED",
          name: "Lakeside",
          lat: 43,
          lon: -79,
          lines: ["corridor"],
          platformIds: ["owned"],
        },
      ],
    });

    const [card] = await Effect.runPromise(source.fetchByIds({ stationIds: ["OWNED"] }));

    expect(fetch.mock.calls.map(([url]) => String(url).replace(/\?.*$/u, "")).sort()).toEqual([
      "https://boards.example.test/hub-a/arrivals",
      "https://boards.example.test/hub-a/departures",
      "https://boards.example.test/hub-b/arrivals",
      "https://boards.example.test/hub-b/departures",
    ]);
    expect(card).toMatchObject({
      livePredictionsOnly: true,
      arrivals: [{ label: "L1 → North Town", lineId: "corridor", times: [now + 30 * 60_000] }],
    });
  });
});

describe("station timetable archive", () => {
  const boards: Record<string, unknown> = {
    departures: {
      rides: [
        ride("out-1", [
          { stop: "a", city: "Lakeside, ON", departure: { scheduled: at(0) } },
          { stop: "b", city: "Midway, ON", departure: { scheduled: at(60) } },
          { stop: "x", city: "Elsewhere, NY", arrival: { scheduled: at(180) } },
        ]),
        ride("out-2", [
          { stop: "a", city: "Lakeside, ON", departure: { scheduled: at(120) } },
          { stop: "b", city: "Midway, ON", departure: { scheduled: at(180) } },
          { stop: "x", city: "Elsewhere, NY", arrival: { scheduled: at(300) } },
        ]),
      ],
    },
    arrivals: {
      rides: [
        ride(
          "back-1",
          [
            { stop: "x", city: "Elsewhere, NY", departure: { scheduled: at(0) } },
            { stop: "a", city: "Lakeside, ON", arrival: { scheduled: at(150) } },
          ],
          { direction: "South Port" },
        ),
      ],
    },
  };
  const archive = () =>
    buildStationTimetableArchive({
      feed: {
        name: "Fixture boards",
        url: URL_TEMPLATE,
        stationTimetables: {
          stations: ["hub-a"],
          cityRegions: ["ON"],
          timeZone: "America/Toronto",
        },
      },
      fetch: vi.fn(async (input: RequestInfo | URL) =>
        Response.json(boards[String(input).includes("/departures") ? "departures" : "arrivals"]),
      ) as typeof fetch,
      now,
    });

  const rows = async (bytes: Uint8Array, name: string, column: string) => {
    const values: string[] = [];
    await processArchiveCsv(readGtfsArchive(bytes), name, [column], (get) =>
      values.push(get(column)),
    );
    return values;
  };

  it("keeps owned stops and one trip per stop pattern", async () => {
    const bytes = await archive();

    expect(await rows(bytes, "routes.txt", "route_id")).toEqual(["L1"]);
    expect(await rows(bytes, "stops.txt", "stop_id")).toEqual(["a", "b"]);
    expect((await rows(bytes, "trips.txt", "trip_headsign")).sort()).toEqual([
      "North Town",
      "South Port",
    ]);
    expect(await rows(bytes, "stop_times.txt", "departure_time")).toContain("11:00:00");
  });

  it("orients a cross-border line by its full call order", async () => {
    expect(await stationTimetableDirections(await archive())).toEqual({
      L1: { "North Town": 0, "South Port": 1 },
    });
  });

  it("refuses to build from a partial board read", async () => {
    await expect(
      buildStationTimetableArchive({
        feed: {
          url: URL_TEMPLATE,
          stationTimetables: {
            stations: ["hub-a"],
            cityRegions: ["ON"],
            timeZone: "America/Toronto",
          },
        },
        fetch: vi.fn(async () => new Response("down", { status: 503 })) as typeof fetch,
        now,
      }),
    ).rejects.toThrow("HTTP 503");
  });
});
