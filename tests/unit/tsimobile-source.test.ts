import { readFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import gtfsIndexRaw from "../fixtures/realtime/tsimobile/gtfs-index.json";
import { TsimobileGtfsIndexSchema } from "~/agencies/types";
import { createGenericGtfsRealtimeSource } from "~/infrastructure/realtime/genericGtfsRealtimeSource";
import { createAgencyProvider } from "~/agencies/createAgencyProvider";
import { fetchFeedStationDepartures } from "~/services/FeedStationDepartures";
import { buildDataStoreService } from "~/infrastructure/storage/memorySurfaceDataStore";
import { makeTestManifest, makeStationSchematic } from "../helpers/agency-fixtures";

const wire = readFileSync(
  new URL("../fixtures/realtime/tsimobile/daytime.json", import.meta.url),
  "utf8",
);
const now = Date.parse("2026-10-07T00:35:00Z");
const gtfsIndex = Schema.decodeUnknownSync(TsimobileGtfsIndexSchema)(gtfsIndexRaw);
const feed = {
  kind: "tsimobile" as const,
  url: "https://example.test/trains",
  format: "json" as const,
  pollIntervalSeconds: 300,
  gtfsIndex,
};
// Authored identities for shared filtering, provider and station-card behavior.
// Recorded operator IDs stay confined to the wire-format regression cases.
const fixtureIndex = {
  stops: { CENT: "fixture-central", NORT: "fixture-north" },
  trains: {
    "901": { routeId: "fixture-route", directionId: 0 as const, headsign: "North Town" },
    "902": { routeId: "other-route", directionId: 1 as const, headsign: "South Town" },
  },
};
const fixtureDeparture = now + 120_000;
const fixtureWire = JSON.stringify(
  Object.fromEntries(
    ["901", "902"].map((number) => [
      number,
      {
        instance: "2026-10-07",
        departed: true,
        arrived: false,
        from: "Central",
        to: "North Town",
        lat: 44,
        lng: -76,
        speed: 40,
        poll: new Date(now - 30_000).toISOString(),
        times: ["CENT", "NORT"].map((code, index) => {
          const time = new Date(fixtureDeparture + index * 60_000).toISOString();
          return {
            station: code === "CENT" ? "Central" : "North Town",
            code,
            tz: "UTC",
            scheduled: time,
            estimated: time,
            eta: "2 min",
            departure: { scheduled: time, estimated: time },
          };
        }),
      },
    ]),
  ),
);
const fixtureFeed = { ...feed, gtfsIndex: fixtureIndex };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("projects recorded trains onto GTFS identities, retaining fix time and converting speed", async () => {
  const fetch = vi.fn(async () => new Response(wire));
  const source = createGenericGtfsRealtimeSource({
    agencyId: "intercity",
    feeds: [feed],
    fetch,
    now: () => now,
  });
  const result = await Effect.runPromise(
    source.fetchRealtime({ agencyId: "intercity", generatedAt: now, routes: [] }),
  );
  const vehicle = result.vehicles.find((v) => v.vehicleId === "1:2026-10-04");
  expect(vehicle).toMatchObject({
    routeId: "8-119",
    directionId: 1,
    timestamp: Date.parse("2026-10-07T00:34:30Z"),
    speed: 42 / 3.6,
  });
  expect(result.vehicles.some((v) => v.vehicleId === "2:2026-10-02")).toBe(false);
  expect(result.arrivals.every((a) => Number.isFinite(a.predictedTime))).toBe(true);
  expect(result.arrivals.some((a) => a.stopId === "TRTO")).toBe(false);
});

it("retries a torn read and preserves honest failure after persistent decode errors", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response('{"1":'))
    .mockImplementation(async () => new Response(wire));
  const source = createGenericGtfsRealtimeSource({
    agencyId: "torn-read",
    feeds: [feed],
    fetch,
    now: () => now,
  });
  const topology = { agencyId: "torn-read", generatedAt: now, routes: [] };
  expect((await Effect.runPromise(source.fetchRealtime(topology))).vehicles.length).toBeGreaterThan(
    0,
  );
  expect(fetch).toHaveBeenCalledTimes(2);
  const broken = createGenericGtfsRealtimeSource({
    agencyId: "broken-read",
    feeds: [feed],
    fetch: vi.fn(async () => new Response("<html>upstream error</html>")),
    now: () => now,
  });
  await expect(Effect.runPromise(broken.fetchRealtime(topology))).rejects.toThrow(
    "Network train feed unavailable",
  );
});

it("filters frozen train fixes without discarding live multi-day instances", async () => {
  const document = JSON.parse(wire);
  document["1 (10-04)"].poll = "2026-10-06T00:00:00Z";
  const source = createGenericGtfsRealtimeSource({
    agencyId: "ghosts",
    feeds: [feed],
    fetch: vi.fn(async () => new Response(JSON.stringify(document))),
    now: () => now,
  });
  const result = await Effect.runPromise(
    source.fetchRealtime({ agencyId: "ghosts", generatedAt: now, routes: [] }),
  );
  expect(result.vehicles.some((v) => v.tripId === "1:2026-10-04")).toBe(false);
  expect(result.arrivals.some((a) => a.tripId === "1:2026-10-04")).toBe(false);
  expect(result.vehicles.some((v) => v.tripId === "2:2026-10-05")).toBe(true);
});

it("does not turn missing departure estimates or terminal arrivals into boarding rows", async () => {
  const document = JSON.parse(wire);
  const train = document["668"];
  const stop = train.times.find((stop: { code: string }) => stop.code === "KGON");
  stop.departure.estimated = null;
  const source = createGenericGtfsRealtimeSource({
    agencyId: "missing-estimate",
    feeds: [feed],
    fetch: vi.fn(async () => new Response(JSON.stringify({ "668": train }))),
    now: () => now,
  });
  const result = await Effect.runPromise(
    source.fetchRealtime({ agencyId: "missing-estimate", generatedAt: now, routes: [] }),
  );
  expect(result.vehicles.length).toBe(1);
  expect(result.arrivals.some((arrival) => arrival.stopId === gtfsIndex.stops.KGON)).toBe(false);
  expect(result.arrivals.some((arrival) => arrival.stopId === gtfsIndex.stops.MTRL)).toBe(false);
  expect(result.arrivals.length).toBeGreaterThan(0);
});

it("accepts completed-only documents as quiet and rejects an unobserved empty document", async () => {
  const document = JSON.parse(wire);
  for (const train of Object.values(document) as { arrived: boolean }[]) train.arrived = true;
  const source = createGenericGtfsRealtimeSource({
    agencyId: "quiet",
    feeds: [feed],
    fetch: vi.fn(async () => new Response(JSON.stringify(document))),
    now: () => now,
  });
  const topology = { agencyId: "quiet", generatedAt: now, routes: [] };
  const result = await Effect.runPromise(source.fetchRealtime(topology));
  expect(result.vehicles).toEqual([]);
  expect(result.arrivals).toEqual([]);
  const empty = createGenericGtfsRealtimeSource({
    agencyId: "empty",
    feeds: [feed],
    fetch: vi.fn(async () => new Response("{}")),
    now: () => now,
  });
  await expect(Effect.runPromise(empty.fetchRealtime(topology))).rejects.toThrow(
    "Network train feed unavailable",
  );
});

it("honors the network cadence across repeated requests and rejects a failed refresh", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const fetch = vi.fn(async () => new Response(fixtureWire));
  const source = createGenericGtfsRealtimeSource({
    agencyId: "cadence",
    feeds: [fixtureFeed],
    fetch,
    now: Date.now,
  });
  const topology = { agencyId: "cadence", generatedAt: now, routes: [] };
  await Effect.runPromise(source.fetchRealtime(topology));
  vi.setSystemTime(now + 60_000);
  await Effect.runPromise(source.fetchRealtime(topology));
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockImplementation(async () => new Response("unavailable", { status: 429 }));
  vi.setSystemTime(now + 300_000);
  await expect(Effect.runPromise(source.fetchRealtime(topology))).rejects.toThrow(
    "Network train feed unavailable",
  );
  expect(fetch).toHaveBeenCalledTimes(2);
  vi.setSystemTime(now + 315_000);
  await expect(Effect.runPromise(source.fetchRealtime(topology))).rejects.toThrow(
    "Network train feed unavailable",
  );
  expect(fetch).toHaveBeenCalledTimes(2);
  fetch.mockImplementation(async () => new Response(fixtureWire));
  vi.setSystemTime(now + 600_000);
  await Effect.runPromise(source.fetchRealtime(topology));
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("filters predictions by the route's stops without making another upstream request", async () => {
  const fetch = vi.fn(async () => new Response(fixtureWire));
  const source = createGenericGtfsRealtimeSource({
    agencyId: "scoped-stops",
    feeds: [fixtureFeed],
    fetch,
    now: () => now,
  });
  const topology = { agencyId: "scoped-stops", generatedAt: now, routes: [] };
  const all = await Effect.runPromise(source.fetchRealtime(topology));
  expect(
    all.arrivals.some(
      (arrival) =>
        arrival.routeId === "fixture-route" && arrival.stopId === fixtureIndex.stops.CENT,
    ),
  ).toBe(true);
  const filtered = await Effect.runPromise(
    source.fetchRealtime(topology, {
      routeIds: new Set(["fixture-route"]),
      stopIdsByRoute: new Map([["fixture-route", new Set([fixtureIndex.stops.CENT])]]),
    }),
  );
  expect(filtered.arrivals.length).toBeGreaterThan(0);
  expect(
    filtered.arrivals.every(
      (arrival) =>
        arrival.routeId === "fixture-route" && arrival.stopId === fixtureIndex.stops.CENT,
    ),
  ).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("makes no network request for stations absent from its index", async () => {
  const fetch = vi.fn(async () => new Response(fixtureWire));
  const provider = createAgencyProvider({
    manifest: makeTestManifest({
      id: "no-station",
      modes: ["rail"],
      stationService: { routeType: "rail" },
      alerts: undefined,
      realtime: { feeds: [fixtureFeed] },
    }),
    schematic: makeStationSchematic(["Central"]),
  });
  const source = provider.createStationsSource!({ fetch, now: () => now });
  expect(await Effect.runPromise(source.fetchByIds({ stationIds: ["other-town"] }))).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});

it("serves station departures and vehicles from one network poll", async () => {
  const fetch = vi.fn(async () => new Response(fixtureWire));
  const provider = createAgencyProvider({
    manifest: makeTestManifest({
      id: "intercity-board",
      modes: ["rail"],
      stationService: { routeType: "rail" },
      alerts: undefined,
      realtime: { feeds: [fixtureFeed] },
      alertInterpretation: { lineIds: ["corridor"], routeLineMap: { "fixture-route": "corridor" } },
    }),
    schematic: {
      ...makeStationSchematic(["Central"], "corridor"),
      stationIndex: [
        {
          id: fixtureIndex.stops.CENT,
          schematicId: "central",
          name: "Central",
          lat: 44,
          lon: -76,
          lines: ["corridor"],
          platformIds: [fixtureIndex.stops.CENT],
        },
      ],
    },
  });
  const stations = provider.createStationsSource!({ fetch, now: () => now });
  const realtime = provider.createRealtimeSource!({ fetch, now: () => now });
  const [cards] = await Promise.all([
    Effect.runPromise(stations.fetchByIds({ stationIds: ["central"] })),
    Effect.runPromise(
      realtime.fetchRealtime({ agencyId: "intercity-board", generatedAt: now, routes: [] }),
    ),
  ]);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(cards[0].trackingRouteId).toBe("fixture-route");
  expect(cards[0].arrivals).toContainEqual(
    expect.objectContaining({
      label: "Train 901 → North Town",
      times: [fixtureDeparture],
    }),
  );
});

it("serves a feed-only interchange through the network adapter with exact GTFS route mapping", async () => {
  const provider = createAgencyProvider({
    manifest: makeTestManifest({
      id: "feed-only-board",
      modes: ["rail"],
      stationService: { routeType: "rail" },
      alerts: undefined,
      realtime: { feeds: [fixtureFeed] },
      alertInterpretation: { lineIds: ["corridor"], routeLineMap: { "fixture-route": "corridor" } },
    }),
  });
  const store = buildDataStoreService({
    stops: [
      {
        id: fixtureIndex.stops.CENT,
        name: "Central",
        lat: 43,
        lon: -79,
        wheelchair: 0,
        routes: ["fixture-route"],
      },
    ],
    routes: [
      {
        id: "fixture-route",
        shortName: "Northern",
        longName: "Northern Rail",
        routeType: "rail",
        color: "ffcb06",
        textColor: "000000",
      },
    ],
    shapes: [],
    routeStops: [],
  });
  const cards = await Effect.runPromise(
    fetchFeedStationDepartures(
      {
        agencyId: "feed-only-board",
        stationId: "interchange:central",
        stationName: "Central",
        stopIds: [fixtureIndex.stops.CENT],
      },
      {
        provider,
        store,
        identities: { hasTripIdentities: false, getRoutesForTrips: () => Effect.succeed(new Map()) },
        fetch: vi.fn(async () => new Response(fixtureWire)),
        now: () => now,
      },
    ),
  );
  expect(cards[0].lineIds).toEqual(["corridor"]);
  expect(cards[0].livePredictionsOnly).toBe(true);
  expect(cards[0].arrivals).toContainEqual(
    expect.objectContaining({
      label: "Train 901 → North Town",
      times: [fixtureDeparture],
    }),
  );
});

it("shares a public document across cold sources without resetting its polling age", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const entries = new Map<string, Response>();
  vi.stubGlobal("caches", {
    default: {
      match: async (request: Request) => entries.get(request.url)?.clone(),
      put: async (request: Request, response: Response) => {
        entries.set(request.url, response.clone());
      },
    },
  });
  const fetch = vi.fn(async () => new Response(fixtureWire));
  const source = createGenericGtfsRealtimeSource({
    agencyId: "edge-shared",
    feeds: [fixtureFeed],
    fetch,
    now: Date.now,
  });
  const topology = { agencyId: "edge-shared", generatedAt: now, routes: [] };
  await Effect.runPromise(source.fetchRealtime(topology));
  vi.setSystemTime(now + 60_000);
  vi.resetModules();
  const { createTsimobileRealtimeSource } =
    await import("~/infrastructure/realtime/tsimobile/tsimobileSource");
  const cold = createTsimobileRealtimeSource({
    agencyId: "edge-shared",
    feed: fixtureFeed,
    fetch,
    now: Date.now,
  });
  expect((await Effect.runPromise(cold.fetchRealtime(topology))).vehicles.length).toBeGreaterThan(
    0,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  vi.setSystemTime(now + 300_000);
  await Effect.runPromise(cold.fetchRealtime(topology));
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([
  ["malformed", () => new Response('{"901":')],
  ["incompatible", () => new Response('{"901":{}}')],
  [
    "unreadable",
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("Cache body unavailable"));
          },
        }),
      ),
  ],
] as const)(
  "recovers from %s edge documents without entering failure cooldown",
  async (kind, response) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const cached = response();
    cached.headers.set("X-Schematic-Observed-At", String(now));
    vi.stubGlobal("caches", {
      default: {
        match: async () => cached,
        put: async () => {},
      },
    });
    const fetch = vi.fn(async () => new Response(fixtureWire));
    const agencyId = `edge-${kind}`;
    const source = createGenericGtfsRealtimeSource({
      agencyId,
      feeds: [fixtureFeed],
      fetch,
      now: Date.now,
    });
    const topology = { agencyId, generatedAt: now, routes: [] };
    for (let request = 0; request < 2; request += 1) {
      const result = await Effect.runPromise(source.fetchRealtime(topology));
      expect(result.vehicles.map((vehicle) => vehicle.vehicleId)).toEqual([
        "901:2026-10-07",
        "902:2026-10-07",
      ]);
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it("ignores frozen unknown trains before joining current GTFS identities", async () => {
  const train = JSON.parse(wire)["668"];
  train.poll = "2026-10-06T00:00:00Z";
  const source = createGenericGtfsRealtimeSource({
    agencyId: "frozen-unmapped",
    feeds: [feed],
    fetch: vi.fn(async () => new Response(JSON.stringify({ "999999": train }))),
    now: () => now,
  });
  const result = await Effect.runPromise(
    source.fetchRealtime({ agencyId: "frozen-unmapped", generatedAt: now, routes: [] }),
  );
  expect(result.vehicles).toEqual([]);
  expect(result.arrivals).toEqual([]);
});
