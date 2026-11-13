import { makeTestProvider } from "../helpers/agency-fixtures";
import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { createGenericGtfsRealtimeSource } from "~/infrastructure/realtime/genericGtfsRealtimeSource";
import { createGenericStationsSource } from "~/infrastructure/realtime/genericStationsSource";
import type { RealtimeFeedConfig } from "~/agencies/types";
import type { StaticSnapshot } from "~/domain/surface/topologySource";

const now = Date.now();
const topology: StaticSnapshot = {
  agencyId: "sample",
  generatedAt: now,
  routes: [
    {
      routeId: "r1",
      shortName: "Route A",
      longName: "Airport",
      color: "#000000",
      textColor: "#FFFFFF",
      routeType: "bus",
      polyline: "",
      directionId: 0,
      headsign: "Airport",
      stops: [{ id: "s1", name: "Hub", lat: 45, lon: -63 }],
    },
  ],
};
const prediction = { time: now / 1000 + 120, vehicleId: "12", tripId: "t1", departure: true };
function setup(rows: readonly unknown[] = [prediction]) {
  const feed: RealtimeFeedConfig = {
    kind: "swiftly",
    url: `https://vendor.example/real-time/${crypto.randomUUID()}`,
    format: "json",
    pollIntervalSeconds: 10,
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = String(input);
    const data = url.includes("/info/")
      ? {
          routes: [
            {
              id: "r1",
              shortName: "Route A",
              directions: [{ id: "0", stops: [{ id: "s1", code: 123 }] }],
            },
          ],
        }
      : url.includes("/vehicles")
        ? {
            vehicles: [
              {
                id: "12",
                routeId: "r1",
                tripId: "t1",
                directionId: "0",
                loc: { lat: 45, lon: -63, time: now / 1000 },
              },
            ],
          }
        : {
            predictionsData: [
              {
                routeId: "r1",
                stopId: "s1",
                destinations: [{ directionId: "0", headsign: "Airport", predictions: rows }],
              },
            ],
          };
    return Response.json({ success: true, data });
  });
  const options = { agencyId: "sample", feeds: [feed], fetch, now: () => now };
  return { fetch, options, source: createGenericGtfsRealtimeSource(options) };
}

describe("Swiftly JSON through Core ports", () => {
  it("uses literal route names and stop codes, keeps live estimates, and shares polls", async () => {
    const { source, fetch } = setup();
    const result = await Effect.runPromise(source.fetchRealtime(topology));
    expect(result.arrivals).toEqual([
      expect.objectContaining({
        routeId: "r1",
        stopId: "s1",
        predictedTime: prediction.time * 1000,
        isRealtime: true,
      }),
    ]);
    expect(result.vehicles).toHaveLength(1);
    expect(
      fetch.mock.calls
        .map(([url]) => String(url))
        .some((url) => url.includes("route=Route+A&stop=123")),
    ).toBe(true);
    await Effect.runPromise(source.fetchRealtime(topology));
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("excludes schedule-only and final arrival calls", async () => {
    const { source } = setup([
      { ...prediction, scheduleBased: true },
      { ...prediction, atEndOfTrip: true, departure: undefined },
    ]);
    expect((await Effect.runPromise(source.fetchRealtime(topology))).arrivals).toEqual([]);
  });
  it("rejects malformed successful responses rather than claiming an empty fleet", async () => {
    const { source, fetch } = setup();
    fetch.mockResolvedValue(Response.json({ success: true, data: {} }));
    await expect(Effect.runPromise(source.fetchRealtime(topology))).rejects.toThrow();
  });
  it("bounds prediction fanout and marks truncated coverage partial", async () => {
    const { source } = setup();
    const result = await Effect.runPromise(source.fetchRealtime(topology, { maxSubrequests: 2 }));
    expect(result.partial).toBe(true);
  });
  it("labels station departures with the operator destination", async () => {
    const { options } = setup();
    const source = createGenericStationsSource({
      ...options,
      routeType: "bus",
      stations: [
        {
          id: "hub",
          schematicId: "hub",
          name: "Hub",
          lat: 45,
          lon: -63,
          lines: ["r1"],
          platformIds: ["s1"],
          departureRouteIds: ["r1"],
        },
      ],
    });
    const cards = await Effect.runPromise(source.fetchByIds({ stationIds: ["hub"] }));
    expect(cards[0].arrivals).toContainEqual(
      expect.objectContaining({ label: "→ Airport", times: [prediction.time * 1000] }),
    );
  });
  it("keeps a confirmed loop departure at a known terminal platform", async () => {
    const { options } = setup();
    const source = createGenericStationsSource({
      ...options,
      routeType: "bus",
      getTripTerminals: () => Effect.succeed(new Map([["t1", { stopId: "s1", stopSequence: 55 }]])),
      stations: [
        {
          id: "hub",
          schematicId: "hub",
          name: "Hub",
          lat: 45,
          lon: -63,
          lines: ["r1"],
          platformIds: ["s1"],
          departureRouteIds: ["r1"],
        },
      ],
    });
    const cards = await Effect.runPromise(source.fetchByIds({ stationIds: ["hub"] }));
    expect(cards[0].arrivals.flatMap((arrival) => arrival.times)).toContain(prediction.time * 1000);
  });
  it("polls later routes when a large first route exceeds the work budget", async () => {
    const { source, fetch } = setup();
    fetch.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/info/"))
        return Response.json({
          success: true,
          data: {
            routes: ["r1", "r2"].map((id) => ({
              id,
              shortName: id,
              directions: [
                {
                  id: "0",
                  stops: Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, code: i })),
                },
              ],
            })),
          },
        });
      if (url.pathname.endsWith("/vehicles"))
        return Response.json({ success: true, data: { vehicles: [] } });
      return Response.json({
        success: true,
        data: {
          predictionsData: [
            {
              routeId: url.searchParams.get("route"),
              stopId: `s${url.searchParams.get("stop")}`,
              destinations: [{ directionId: "0", headsign: "Hub", predictions: [prediction] }],
            },
          ],
        },
      });
    });
    const routes = ["r1", "r2"].map((routeId) => ({
      ...topology.routes[0],
      routeId,
      stops: Array.from({ length: 40 }, (_, i) => ({
        ...topology.routes[0].stops[0],
        id: `s${i}`,
      })),
    }));
    const result = await Effect.runPromise(source.fetchRealtime({ ...topology, routes }));
    expect(new Set(result.arrivals.map((a) => a.routeId))).toEqual(new Set(["r1", "r2"]));
    expect(result.partial).toBe(true);
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(40);
  });

  it.each([0, 1, 2])("respects a subrequest budget of %i", async (maxSubrequests) => {
    const { source, fetch } = setup();
    const result = await Effect.runPromise(source.fetchRealtime(topology, { maxSubrequests }));
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(maxSubrequests);
    expect(result.partial).toBe(true);
  });

  it("polls through the registered provider without joining its own pending request", async () => {
    const { options, fetch } = setup();
    const provider = makeTestProvider({ id: "sample", realtime: { feeds: options.feeds } });
    const source = provider.createRealtimeSource!({ fetch });
    const result = await Effect.runPromise(source.fetchRealtime(topology));
    expect(result.arrivals).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(3);
  }, 1500);
});
