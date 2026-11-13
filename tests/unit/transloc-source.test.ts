import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { createGenericGtfsRealtimeSource } from "~/infrastructure/realtime/genericGtfsRealtimeSource";
import type { StaticSnapshot } from "~/domain/surface/topologySource";

const now = 1_800_000_000_000;
const topology: StaticSnapshot = { agencyId: "sample", routes: [], generatedAt: now };
const feed = {
  kind: "transloc" as const,
  format: "json" as const,
  url: "https://sample.test/Services/JSONPRelay.svc",
  idPrefix: "TL-",
  routeIds: ["7"],
};
const board = [
  {
    RouteId: 7,
    StopId: 12,
    Times: [
      { EstimateTime: `/Date(${now + 60_000})/`, VehicleId: 4, IsDeparted: false },
      { EstimateTime: `/Date(${now + 90_000})/`, VehicleId: 0 },
      { EstimateTime: null, VehicleId: null },
      { EstimateTime: `/Date(${now + 120_000})/`, VehicleId: 5, IsDeparted: true },
    ],
  },
];
const vehicle = {
  VehicleID: 4,
  RouteID: 7,
  Latitude: 60,
  Longitude: -135,
  Heading: 90,
  GroundSpeed: 3,
  TimeStamp: `/Date(${now + 21600_000}-0600)/`,
  Seconds: 10,
  IsOnRoute: true,
};
let sequence = 0;
function source(
  arrivals: unknown = board,
  vehicles: unknown = [vehicle],
  stopIdField: "StopId" | "RouteStopId" = "StopId",
) {
  return createGenericGtfsRealtimeSource({
    agencyId: "sample",
    feeds: [{ ...feed, stopIdField, url: `${feed.url}/${++sequence}` }],
    now: () => now,
    fetch: (async (input) =>
      Response.json(
        String(input).includes("GetMapVehiclePoints") ? vehicles : arrivals,
      )) as typeof fetch,
  });
}
describe("TransLoc realtime", () => {
  it("joins vendor identities and retains only vehicle-assigned live departures", async () => {
    const result = await Effect.runPromise(source().fetchRealtime(topology));
    expect(result.arrivals).toMatchObject([
      {
        routeId: "TL-7",
        stopId: "TL-12",
        vehicleId: "4",
        predictedTime: now + 60_000,
        isRealtime: true,
      },
    ]);
    expect(result.arrivals).toHaveLength(1);
    expect(result.vehicles).toMatchObject([
      { vehicleId: "4", routeId: "TL-7", timestamp: now - 10_000, speed: 3 },
    ]);
  });
  it("keeps an empty off-hours board live", async () => {
    expect(await Effect.runPromise(source([], []).fetchRealtime(topology))).toMatchObject({
      arrivals: [],
      vehicles: [],
      partial: false,
    });
  });
  it("rejects malformed documents rather than reporting no service", async () => {
    await expect(Effect.runPromise(source({}, {}).fetchRealtime(topology))).rejects.toThrow();
  });
  it("marks a failed departure feed partial while keeping vehicles", async () => {
    expect(await Effect.runPromise(source({}).fetchRealtime(topology))).toMatchObject({
      partial: true,
      vehicles: [{ vehicleId: "4" }],
    });
  });
  it("retains departures when vehicle decoding fails", async () => {
    expect(
      await Effect.runPromise(source(board, [{ ...vehicle, Seconds: -1 }]).fetchRealtime(topology)),
    ).toMatchObject({ partial: true, arrivals: [{ stopId: "TL-12" }], vehicles: [] });
  });
  it("filters requested route and stop identities", async () => {
    const result = await Effect.runPromise(
      source().fetchRealtime(topology, { stopIds: new Set(["TL-other"]) }),
    );
    expect(result.arrivals).toEqual([]);
  });
});

it("serves live platform departures through the station port and marks failed refreshes stale", async () => {
  const { vi } = await import("vitest");
  const { createGenericStationsSource } =
    await import("~/infrastructure/realtime/genericStationsSource");
  vi.useFakeTimers();
  vi.setSystemTime(now);
  let fail = false;
  const source = createGenericStationsSource({
    agencyId: "sample",
    routeType: "bus",
    now: () => Date.now(),
    feeds: [{ ...feed, url: `${feed.url}/station-board` }],
    routeLineMap: { "TL-7": "loop" },
    lineMetadata: [{ id: "loop", name: "Town Loop", color: "#123456" }],
    stations: [
      {
        id: "hub",
        name: "Hub",
        lat: 60,
        lon: -135,
        lines: ["loop"],
        platformIds: ["TL-12"],
        departureRouteIds: ["TL-7"],
      },
    ],
    fetch: (async () => {
      if (fail) throw new Error("offline");
      return Response.json(board);
    }) as typeof fetch,
  });
  try {
    const [station] = await Effect.runPromise(source.fetchByIds({ stationIds: ["hub"] }));
    expect(station.lineIds).toEqual(["loop"]);
    expect(station.arrivals).toMatchObject([{ times: [now + 60_000] }]);
    fail = true;
    vi.setSystemTime(now + 31_000);
    const [stale] = await Effect.runPromise(source.fetchByIds({ stationIds: ["hub"] }));
    expect(stale.arrivalsStale).toBe(true);
    expect(stale.arrivals).toMatchObject([{ times: [now + 60_000] }]);
  } finally {
    vi.useRealTimers();
  }
});

it("joins and filters the declared route-stop identity instead of the separate physical stop", async () => {
  const result = await Effect.runPromise(
    source([{ ...board[0], RouteStopId: 99 }], [vehicle], "RouteStopId").fetchRealtime(topology, {
      stopIds: new Set(["TL-99"]),
    }),
  );
  expect(result.arrivals).toEqual([expect.objectContaining({ stopId: "TL-99", routeId: "TL-7" })]);
});

it("collapses identical vehicle estimates while preserving separate buses and later loop calls", async () => {
  const repeated = board[0].Times[0];
  const result = await Effect.runPromise(
    source([
      {
        ...board[0],
        Times: [
          repeated,
          repeated,
          { ...repeated, VehicleId: 8 },
          { ...repeated, EstimateTime: `/Date(${now + 300_000})/` },
        ],
      },
    ]).fetchRealtime(topology),
  );
  expect(result.arrivals.map((a) => [a.vehicleId, a.predictedTime])).toEqual([
    ["4", now + 60_000],
    ["8", now + 60_000],
    ["4", now + 300_000],
  ]);
});

it("marks an opted-in empty live estimate outage partial while retaining positions", async () => {
  const source = createGenericGtfsRealtimeSource({
    agencyId: "sample",
    feeds: [{ ...feed, emptyArrivals: "error" }],
    now: () => now,
    fetch: (async (input) =>
      Response.json(
        String(input).includes("GetMapVehiclePoints") ? [vehicle] : [],
      )) as typeof fetch,
  });
  expect(await Effect.runPromise(source.fetchRealtime(topology))).toMatchObject({
    partial: true,
    arrivals: [],
    vehicles: [{ vehicleId: "4" }],
  });
});

it("rejects an opted-in board whose vehicle estimates have all expired before stop filtering", async () => {
  const { fetchTranslocArrivals } =
    await import("~/infrastructure/realtime/transloc/translocSource");
  const options = {
    agencyId: "sample",
    now: () => now,
    fetch: (async () =>
      Response.json([
        { ...board[0], Times: [{ EstimateTime: `/Date(${now - 1})/`, VehicleId: 4 }] },
      ])) as typeof fetch,
  };
  await expect(
    fetchTranslocArrivals(
      { ...feed, url: feed.url + "/expired-check", emptyArrivals: "error" },
      options,
    ),
  ).rejects.toThrow("live estimates unavailable");
  const filtered = await fetchTranslocArrivals(
    { ...feed, url: feed.url + "/filtered-check", emptyArrivals: "error" },
    {
      ...options,
      stopIds: new Set(["other"]),
      fetch: (async () => Response.json(board)) as typeof fetch,
    },
  );
  expect(filtered).toEqual({ arrivals: [], partial: false });
});
