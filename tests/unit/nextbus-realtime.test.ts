import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { parseNextBusPredictions, parseNextBusVehicles } from "~/domain/nextbus/parseRealtime";
import type { StaticSnapshot } from "~/domain/surface/topologySource";
import {
  fetchNextBusRealtime,
  type NextBusRealtimeOptions,
} from "~/infrastructure/realtime/nextBusRealtimeSource";

const now = 1_900_000_000_000;
const topology: StaticSnapshot = {
  agencyId: "fictional",
  generatedAt: now,
  routes: [
    {
      routeId: "R1",
      shortName: "1",
      longName: "Route 1",
      color: "#000000",
      textColor: "#FFFFFF",
      routeType: "bus",
      polyline: "",
      directionId: 0,
      headsign: "North",
      stops: [
        { id: "S1", code: "S1", name: "One", lat: 1, lon: 1 },
        { id: "S2", code: "S2", name: "Two", lat: 2, lon: 2 },
      ],
    },
  ],
};
const feeds = [
  { kind: "nextbus", url: "https://fictional.example.test/feed", format: "json" },
] as const;
const options = (
  fetch: typeof globalThis.fetch,
  overrides: Partial<NextBusRealtimeOptions> = {},
): NextBusRealtimeOptions => ({
  agencyId: "fictional",
  feeds,
  fetch,
  now: () => now,
  topology,
  includeArrivals: true,
  includeVehicles: false,
  fetchOptions: { routeIds: new Set(["R1"]), stopIds: new Set(["S1", "S2"]) },
  ...overrides,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("NextBus public realtime", () => {
  it("keeps a successful empty departure board available", async () => {
    const result = await Effect.runPromise(
      fetchNextBusRealtime(options(vi.fn(async () => json({ predictions: {} })))),
    );
    expect(result.arrivals).toEqual([]);
    expect(result.arrivalsAvailable).toBe(true);
  });
  it.each([
    { includeArrivals: true, includeVehicles: false },
    { includeArrivals: false, includeVehicles: true },
  ])("surfaces a total outage for %j", async (include) => {
    const fetch = vi.fn(async () => json({}, 503));
    await expect(Effect.runPromise(fetchNextBusRealtime(options(fetch, include)))).rejects.toThrow(
      /HTTP 503/,
    );
  });

  it("keeps successful per-stop arrivals when another stop fails", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) =>
      String(input).includes("stopId=S1")
        ? json({ predictions: { prediction: { seconds: "30" } } })
        : json({}, 503),
    );
    const result = await Effect.runPromise(fetchNextBusRealtime(options(fetch)));
    expect(result.arrivals).toHaveLength(1);
    expect(result.arrivals[0]).toMatchObject({ stopId: "S1", predictedTime: now + 30_000 });
    expect(result.arrivalsAvailable).toBe(true);
  });

  it("requires route or stop filters", async () => {
    await expect(
      Effect.runPromise(
        fetchNextBusRealtime(
          options(
            vi.fn(async () => json({})),
            {
              fetchOptions: undefined,
            },
          ),
        ),
      ),
    ).rejects.toThrow(/requires route or stop filters/);
  });
});

describe("NextBus parser", () => {
  it.each([
    ["epochTime takes priority", { epochTime: "1900000005000", seconds: "1" }, [1_900_000_005_000]],
    ["relative seconds", { seconds: "12" }, [now + 12_000]],
    ["negative seconds", { seconds: "-1" }, []],
    ["invalid seconds", { seconds: "NaN" }, []],
  ])("parses prediction times: %s", (_label, prediction, expected) => {
    const result = parseNextBusPredictions(
      { predictions: { prediction } },
      { routeId: "R1", stopId: "S1", now },
    );
    expect(result.map((item) => item.predictedTime)).toEqual(expected);
  });

  it("parses predictions without a direction wrapper", () => {
    expect(
      parseNextBusPredictions(
        { predictions: { prediction: { seconds: "5", dirTag: "R1_1" } } },
        { routeId: "R1", stopId: "S1", now },
      ),
    ).toMatchObject([{ directionId: 1, predictedTime: now + 5_000 }]);
  });

  it("maps compass prediction titles to an inverted north-south feed order", () => {
    const result = parseNextBusPredictions(
      {
        predictions: {
          direction: [
            { tag: "fixture-route_N", title: "Northbound", prediction: { seconds: "5" } },
            { tag: "fixture-route_S", title: "Southbound", prediction: { seconds: "10" } },
          ],
        },
      },
      {
        routeId: "fixture-route",
        stopId: "fixture-stop",
        now,
        routeInterpretation: {
          directionInference: {
            routeOverrides: { "fixture-route": "north-south" },
            invertNorthSouth: true,
          },
        },
      },
    );

    expect(result.map(({ directionId }) => directionId)).toEqual([1, 0]);
  });

  it.each([
    { lat: "NaN", lon: "1" },
    { lat: "43", lon: "NaN" },
    { lat: "Infinity", lon: "1" },
    { lat: "43", lon: "Infinity" },
  ])("drops non-finite vehicle coordinates: %j", (coordinates) => {
    expect(
      parseNextBusVehicles({ vehicle: { id: "bad", ...coordinates } }, { routeId: "R1", now }),
    ).toEqual([]);
  });
  it("accepts a vehicle without a heading", () => {
    const result = parseNextBusVehicles(
      { vehicle: { id: "valid", lat: "43", lon: "-79" } },
      { routeId: "R1", now },
    );
    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty("bearing");
  });

  it("throws on an in-band API error", () => {
    expect(() =>
      parseNextBusPredictions(
        { Error: { content: "maintenance" } },
        { routeId: "R1", stopId: "S1", now },
      ),
    ).toThrow(/maintenance/);
  });
});
