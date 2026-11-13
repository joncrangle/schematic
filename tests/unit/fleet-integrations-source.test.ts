import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { createGenericGtfsRealtimeSource } from "~/infrastructure/realtime/genericGtfsRealtimeSource";
import { makeTestProvider } from "../helpers/agency-fixtures";
import type { RealtimeFeedConfig } from "~/agencies/types";
import type { StaticSnapshot } from "~/domain/surface/topologySource";

const now = Date.now();
const topology: StaticSnapshot = {
  agencyId: "sample",
  generatedAt: now,
  routes: ["A", "B"].map((routeId) => ({
    routeId,
    shortName: routeId,
    longName: "Rural bus",
    color: "#000000",
    textColor: "#FFFFFF",
    routeType: "bus",
    directionId: 0,
    headsign: "",
    polyline: "",
    stops: [],
  })),
};
const vehicle = (name: string, route: string, age = 0) => ({
  id: `upstream-${name}`,
  name,
  route_name: route,
  driver_name: "Private upstream field",
  gps: {
    time: new Date(now - age).toISOString(),
    latitude: "46.4",
    longitude: "-63.8",
    headingDegrees: 90,
    speedMilesPerHour: "10",
  },
});
function setup(rows: unknown[] = [vehicle("10", "A"), vehicle("20", "B")]) {
  const feed: RealtimeFeedConfig = {
    kind: "fleet_integrations",
    url: `https://fleet.example/${crypto.randomUUID()}`,
    format: "json",
    pollIntervalSeconds: 10,
    routeIds: ["A", "B"],
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ status_code: 200, data: { results: rows } }),
  );
  const options = { agencyId: "sample", feeds: [feed], fetch, now: () => now };
  return { feed, fetch, options, source: createGenericGtfsRealtimeSource(options) };
}

function setupComposite() {
  const { feed, fetch } = setup();
  const cityFeed: RealtimeFeedConfig = {
    kind: "swiftly",
    url: `https://city.example/real-time/${crypto.randomUUID()}`,
    format: "json",
    pollIntervalSeconds: 10,
  };
  fetch.mockImplementation(async (input) => {
    if (String(input).startsWith("https://fleet.example"))
      return Response.json({ status_code: 200, data: { results: [vehicle("10", "A")] } });
    const data = String(input).includes("/info/")
      ? {
          routes: [
            {
              id: "city",
              shortName: "1",
              directions: [{ id: "0", stops: [{ id: "hub", code: 1 }] }],
            },
          ],
        }
      : String(input).includes("/vehicles")
        ? { vehicles: [] }
        : {
            predictionsData: [
              {
                routeId: "city",
                stopId: "hub",
                destinations: [
                  {
                    directionId: "0",
                    headsign: "City",
                    predictions: [
                      {
                        time: now / 1000 + 120,
                        tripId: "trip",
                        vehicleId: "bus",
                        departure: true,
                      },
                    ],
                  },
                ],
              },
            ],
          };
    return Response.json({ success: true, data });
  });
  const provider = makeTestProvider({
    realtime: { feeds: [cityFeed, feed] },
    staticTopology: {
      source: "seed",
      feeds: [{ url: "https://example.test/gtfs.zip" }],
      vehicleOnlyRoutes: topology.routes.map((route) => ({
        id: route.routeId,
        shortName: route.shortName,
        longName: route.longName,
      })),
    },
  });
  const source = provider.createRealtimeSource!({ fetch });
  const fullTopology: StaticSnapshot = {
    ...topology,
    routes: [
      ...topology.routes,
      {
        ...topology.routes[0],
        routeId: "city",
        stops: [{ id: "hub", name: "Hub", lat: 46, lon: -63 }],
      },
    ],
  };
  return { source, fetch, fullTopology };
}

describe("Fleet Integrations public fleet", () => {
  it("serves fresh fleet positions without inventing stop predictions or leaking metadata", async () => {
    const { source, fetch } = setup();
    const result = await Effect.runPromise(source.fetchRealtime(topology));
    expect(result.vehicles).toHaveLength(2);
    expect(result.vehicles[0]).toMatchObject({
      vehicleId: "10",
      routeId: "A",
      latitude: 46.4,
      longitude: -63.8,
      bearing: 90,
      speed: 4.4704,
    });
    expect(JSON.stringify(result)).not.toContain("Private upstream field");
    expect(result.arrivals).toEqual([]);
    await Effect.runPromise(source.fetchRealtime(topology));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("excludes old fixes, undeclared routes, invalid coordinates and future timestamps", async () => {
    const { source } = setup([
      vehicle("old", "A", 600_000),
      vehicle("foreign", "Z"),
      { ...vehicle("bad", "A"), gps: { ...vehicle("bad", "A").gps, latitude: "91" } },
      vehicle("future", "A", -120_000),
      vehicle("valid", "B"),
    ]);
    expect(
      (await Effect.runPromise(source.fetchRealtime(topology))).vehicles.map((v) => v.vehicleId),
    ).toEqual(["valid"]);
  });
  it("filters requested routes and skips unrelated fleet polls", async () => {
    const { source, fetch } = setup();
    expect(
      (
        await Effect.runPromise(source.fetchRealtime(topology, { routeIds: new Set(["A"]) }))
      ).vehicles.map((v) => v.routeId),
    ).toEqual(["A"]);
    expect(
      (await Effect.runPromise(source.fetchRealtime(topology, { routeIds: new Set(["city"]) })))
        .vehicles,
    ).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    { status_code: 200, data: {} },
    { status_code: 500, data: { results: [] } },
  ])("rejects failed or malformed envelopes", async (response) => {
    const { source, fetch } = setup();
    fetch.mockResolvedValue(Response.json(response));
    await expect(Effect.runPromise(source.fetchRealtime(topology))).rejects.toThrow();
  });
  it("preserves genuine empty fleets", async () => {
    const { source } = setup([]);
    expect((await Effect.runPromise(source.fetchRealtime(topology))).vehicles).toEqual([]);
  });
  it("does not exceed a zero subrequest budget", async () => {
    const { source, fetch } = setup();
    expect(
      (await Effect.runPromise(source.fetchRealtime(topology, { maxSubrequests: 0 }))).partial,
    ).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("composes city departures and rural positions through the registered provider", async () => {
    const { source, fullTopology } = setupComposite();
    const result = await Effect.runPromise(source.fetchRealtime(fullTopology));
    expect(result.vehicles.map((v) => v.routeId)).toEqual(["A"]);
    expect(result.arrivals.map((a) => a.routeId)).toEqual(["city"]);
    expect(result.partial).toBe(false);
  });
  it.each(["fleet", "city"])("keeps the other source available when %s fails", async (failed) => {
    const { source, fetch, fullTopology } = setupComposite();
    const upstream = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (...args) =>
      String(args[0]).startsWith(`https://${failed}.example`)
        ? new Response("Unavailable", { status: 503 })
        : upstream(...args),
    );
    const result = await Effect.runPromise(source.fetchRealtime(fullTopology));
    expect(result.partial).toBe(true);
    expect(result.vehicles.map((v) => v.routeId)).toEqual(failed === "city" ? ["A"] : []);
    expect(result.arrivals.map((a) => a.routeId)).toEqual(failed === "fleet" ? ["city"] : []);
  });
  it.each([0, 1, 2, 3, 4])("shares a combined subrequest ceiling of %i", async (maxSubrequests) => {
    const { source, fetch, fullTopology } = setupComposite();
    await Effect.runPromise(source.fetchRealtime(fullTopology, { maxSubrequests }));
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(maxSubrequests);
  });
  it("does not poll city feeds for a rural-only selection", async () => {
    const { source, fetch, fullTopology } = setupComposite();
    const result = await Effect.runPromise(
      source.fetchRealtime(fullTopology, { routeIds: new Set(["A"]) }),
    );
    expect(result.vehicles.map((v) => v.routeId)).toEqual(["A"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toMatch(/^https:\/\/fleet.example/);
  });
});
