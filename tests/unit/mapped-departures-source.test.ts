import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { createGenericGtfsRealtimeSource } from "~/infrastructure/realtime/genericGtfsRealtimeSource";
import type { RealtimeFeedConfig } from "~/agencies/types";

const now = Date.parse("2026-10-28T21:00:00Z");
const feed: RealtimeFeedConfig = {
  kind: "station_departures",
  format: "json",
  url: "https://sample.test/stops/{stopId}.json",
  pollIntervalSeconds: 60,
  requestsPerMinute: 2,
  responseMapping: {
    routesPath: "board.routes",
    routeIdField: "route.key",
    departuresField: "calls",
    timeField: "estimated",
    scheduledTimeField: "scheduled",
    timeZone: "America/Chicago",
    directionField: "variant",
    directionPattern: "^[^-]+-([01])-",
    headsignField: "destination",
    cancelledField: "cancelled",
    realtimePresenceField: "bus.key",
  },
};
const call = {
  variant: "A1-1-E",
  trip: 123,
  estimated: "2026-10-28T16:05:00",
  scheduled: "2026-10-28T16:03:00",
  destination: "East Hub",
  cancelled: "false",
  bus: { key: 4 },
};
const topology = {
  agencyId: "sample",
  generatedAt: now,
  routes: [
    {
      routeId: "A1",
      shortName: "A1",
      longName: "Trunk",
      color: "000000",
      textColor: "FFFFFF",
      routeType: "bus" as const,
      polyline: "",
      directionId: 0,
      headsign: "East",
      stops: [
        { id: "s1", name: "Hub", lat: 40, lon: -90 },
        { id: "s2", name: "Next", lat: 40.1, lon: -90 },
      ],
    },
  ],
};
function makeSource(calls: unknown[] = [call]) {
  const fetcher = vi.fn(async (_url: RequestInfo | URL) =>
    Response.json({ board: { routes: [{ route: { key: "A1" }, calls }] } }),
  );
  return {
    fetcher,
    source: createGenericGtfsRealtimeSource({
      agencyId: "sample",
      feeds: [feed],
      fetch: fetcher,
      now: () => now,
    }),
  };
}
it("serves scoped live surface predictions with local times, per-call destinations and string cancellations", async () => {
  const { source, fetcher } = makeSource([
    call,
    { ...call, cancelled: "true" },
    { ...call, bus: undefined },
  ]);
  const result = await Effect.runPromise(
    source.fetchRealtime(topology, { stopIds: new Set(["s1"]) }),
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(String(fetcher.mock.calls[0]?.[0])).toContain("s1");
  expect(result.arrivals).toEqual([
    expect.objectContaining({
      routeId: "A1",
      stopId: "s1",
      directionId: 1,
      headsign: "East Hub",
      predictedTime: Date.parse("2026-10-28T21:05:00Z"),
      delaySeconds: 120,
      isRealtime: true,
    }),
  ]);
});
it("shares per-stop reads and refuses an unbounded network sweep", async () => {
  const { source, fetcher } = makeSource();
  const options = { stopIds: new Set(["s1"]) };
  await Promise.all([
    Effect.runPromise(source.fetchRealtime(topology, options)),
    Effect.runPromise(source.fetchRealtime(topology, options)),
  ]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(Effect.runPromise(source.fetchRealtime(topology))).rejects.toThrow();
});
it("reports truncated fan-out as partial and rejects malformed reads", async () => {
  const { source } = makeSource();
  const result = await Effect.runPromise(
    source.fetchRealtime(topology, { stopIds: new Set(["s1", "s2"]), maxSubrequests: 1 }),
  );
  expect(result.partial).toBe(true);
  const bad = makeSource([{ ...call, estimated: "not a timestamp" }]);
  await expect(
    Effect.runPromise(bad.source.fetchRealtime(topology, { stopIds: new Set(["s1"]) })),
  ).rejects.toThrow();
});

it("does not poll a stop-only API just to draw vehicles in targeted route mode", async () => {
  const { source, fetcher } = makeSource();
  const result = await Effect.runPromise(
    source.fetchRealtime(topology, { vehiclesOnly: true, stopIds: new Set(["s1", "s2"]) }),
  );
  expect(result).toMatchObject({ vehicles: [], arrivals: [] });
  expect(fetcher).not.toHaveBeenCalled();
});

it("serves flat countdown boards across midnight and refuses stale live estimates", async () => {
  const clock = Date.parse("2026-11-10T03:29:30Z");
  let timestamp = "2026-11-09T23:59:30.123";
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("Referer")).toBe("https://sample.test/board");
    return Response.json([
      {
        route: "A1",
        updated: timestamp,
        countdown: 90,
        live: true,
        delay: 30,
        trip: "run",
        sequence: 4,
      },
      { route: "A1", updated: timestamp, countdown: 180, live: false },
    ]);
  });
  const source = createGenericGtfsRealtimeSource({
    agencyId: "sample",
    now: () => clock,
    fetch: fetcher,
    feeds: [
      {
        kind: "station_departures",
        format: "json",
        url: "https://sample.test/{stopId}",
        headers: { Referer: "https://sample.test/board" },
        responseMapping: {
          routesPath: "$",
          departuresField: "$",
          routeIdField: "route",
          timeField: "countdown",
          timeFormat: "countdown-seconds",
          updatedAtField: "updated",
          timeZone: "America/St_Johns",
          maxAgeSeconds: 120,
          realtimeField: "live",
          realtimeOnly: true,
          delaySecondsField: "delay",
          tripIdField: "trip",
          stopSequenceField: "sequence",
        },
      },
    ],
  });
  const result = await Effect.runPromise(
    source.fetchRealtime(topology, { stopIds: new Set(["s1"]) }),
  );
  expect(result.arrivals).toEqual([
    expect.objectContaining({
      predictedTime: Date.parse("2026-11-10T03:31:00Z"),
      tripId: "run",
      stopSequence: 4,
      delaySeconds: 30,
    }),
  ]);
  timestamp = "2026-11-09T23:50:00";
  const staleSource = createGenericGtfsRealtimeSource({
    agencyId: "sample",
    now: () => clock,
    fetch: async (input, init) => fetcher(input, init),
    feeds: [
      {
        ...feed,
        headers: { Referer: "https://sample.test/board" },
        responseMapping: {
          routesPath: "$",
          departuresField: "$",
          routeIdField: "route",
          timeField: "countdown",
          timeFormat: "countdown-seconds",
          updatedAtField: "updated",
          timeZone: "America/St_Johns",
          maxAgeSeconds: 120,
          realtimeField: "live",
          realtimeOnly: true,
        },
      },
    ],
  });
  await expect(
    Effect.runPromise(staleSource.fetchRealtime(topology, { stopIds: new Set(["s1"]) })),
  ).rejects.toThrow();
});

it("reads stop-code boards in the operator's date and excludes scheduled or arrival-only calls", async () => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL) =>
    Response.json([
      {
        route: { id: "A1", direction: "1" },
        arrivalsOnly: false,
        calls: [
          { at: "2026-10-28T21:05:00Z", live: true },
          { at: "2026-10-28T21:10:00Z", live: false },
        ],
      },
      {
        route: { id: "A1", direction: "0" },
        arrivalsOnly: true,
        calls: [{ at: "2026-10-28T21:15:00Z", live: true }],
      },
    ]),
  );
  const source = createGenericGtfsRealtimeSource({
    agencyId: "sample",
    now: () => now,
    fetch: fetcher,
    feeds: [
      {
        kind: "station_departures",
        format: "json",
        url: "https://board.test/{stopId}?date={date}",
        requestStopIdPattern: "^s(.+)$",
        dateTimezone: "America/Chicago",
        responseMapping: {
          routesPath: "$",
          routeIdField: "route.id",
          directionField: "route.direction",
          departuresField: "calls",
          timeField: "at",
          realtimeField: "live",
          realtimeOnly: true,
          terminalField: "arrivalsOnly",
        },
      },
    ],
  });
  const result = await Effect.runPromise(
    source.fetchRealtime(topology, { stopIds: new Set(["s1"]) }),
  );
  expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://board.test/1?date=20261028");
  expect(result.arrivals).toEqual([
    expect.objectContaining({ directionId: 1, isRealtime: true, predictedTime: now + 300000 }),
  ]);
});

it("reads numeric live flags and extended local departure times across midnight", async () => {
  const midnight = Date.parse("2026-11-12T05:10:00Z");
  const fetcher = vi.fn(async () =>
    Response.json([
      { route: "A1", at: "24:15:00", scheduled: "24:13:00", live: "1", arrivalOnly: "0" },
      { route: "A1", at: "00:20:00", scheduled: "00:20:00", live: "0", arrivalOnly: "0" },
      { route: "A1", at: "00:25:00", scheduled: "00:25:00", live: "1", arrivalOnly: "1" },
    ]),
  );
  const source = createGenericGtfsRealtimeSource({
    agencyId: "sample",
    now: () => midnight,
    fetch: fetcher,
    feeds: [
      {
        kind: "station_departures",
        format: "json",
        url: "https://board.test/{stopId}",
        responseMapping: {
          routesPath: "$",
          routeIdField: "route",
          departuresField: "$",
          timeField: "at",
          scheduledTimeField: "scheduled",
          timeFormat: "local-time",
          timeZone: "America/Toronto",
          realtimeField: "live",
          realtimeOnly: true,
          terminalField: "arrivalOnly",
        },
      },
    ],
  });
  const result = await Effect.runPromise(
    source.fetchRealtime(topology, { stopIds: new Set(["s1"]) }),
  );
  expect(result.arrivals).toEqual([
    expect.objectContaining({
      isRealtime: true,
      predictedTime: midnight + 300000,
      delaySeconds: 120,
    }),
  ]);
});
