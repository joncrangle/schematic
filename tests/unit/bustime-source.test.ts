import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { createGenericGtfsRealtimeSource } from "~/infrastructure/realtime/genericGtfsRealtimeSource";
import type { StaticSnapshot } from "~/domain/surface/topologySource";
const now = Date.parse("2027-01-01T12:00:00Z");
const topology: StaticSnapshot = { agencyId: "sample", generatedAt: now, routes: [] };
let serial = 0;
const source = (board: string, vehicleXml = "<buses></buses>", clock: () => number = () => now) =>
  createGenericGtfsRealtimeSource({
    agencyId: "sample",
    feeds: [{ kind: "bustime", format: "xml", url: `https://sample.test/bustime/${++serial}` }],
    now: clock,
    getSourceAgencyScope: () =>
      Effect.succeed({
        routeIds: new Set(["R7"]),
        stopIds: new Set(["P"]),
        stopsByCode: new Map([["0042", ["P"]]]),
      }),
    fetch: (async (input) =>
      new Response(String(input).includes("getBuses") ? vehicleXml : board, {
        headers: { Date: new Date(clock() - 10_000).toUTCString() },
      })) as typeof fetch,
  });
describe("BusTime XML", () => {
  it("joins public stop codes and retains only explicit vehicle-linked live countdowns", async () => {
    const s = source(
      "<stop><id>0042</id><pre><pt>3 MIN</pt><v>BUS</v><scheduled>false</scheduled><rn>R7</rn><fd>Downtown</fd></pre><pre><pt>5 MIN</pt><v>SCH</v><scheduled>true</scheduled><rn>R7</rn></pre></stop>",
    );
    const result = await Effect.runPromise(
      s.fetchRealtime(topology, { stopIds: new Set(["P"]), routeIds: new Set(["R7"]) }),
    );
    expect(result.arrivals).toEqual([
      expect.objectContaining({
        stopId: "P",
        routeId: "R7",
        vehicleId: "BUS",
        predictedTime: now + 170_000,
        isRealtime: true,
      }),
    ]);
  });
  it("does not poll predictions for vehicle-only consumers", async () => {
    const result = await Effect.runPromise(
      source(
        "malformed",
        "<buses><bus><id>BUS</id><rt>R7</rt><lat>52</lat><lon>-113</lon><dn>N</dn></bus></buses>",
      ).fetchRealtime(topology, { vehiclesOnly: true }),
    );
    expect(result).toMatchObject({
      partial: false,
      arrivals: [],
      vehicles: [{ vehicleId: "BUS", routeId: "R7", latitude: 52, longitude: -113 }],
    });
  });
  it("keeps failed predictions partial instead of claiming a complete empty result", async () => {
    const result = await Effect.runPromise(
      source("<html>error</html>").fetchRealtime(topology, {
        stopIds: new Set(["P"]),
        routeIds: new Set(["R7"]),
      }),
    );
    expect(result).toMatchObject({ partial: true, arrivals: [] });
  });
});

it("keeps cached countdowns anchored to the original response", async () => {
  let instant = now;
  const s = source(
    "<stop><id>0042</id><pre><pt>3 MIN</pt><v>BUS</v><scheduled>false</scheduled><rn>R7</rn></pre></stop>",
    "<buses></buses>",
    () => instant,
  );
  const filter = { stopIds: new Set(["P"]), routeIds: new Set(["R7"]) };
  const first = await Effect.runPromise(s.fetchRealtime(topology, filter));
  instant += 10_000;
  const second = await Effect.runPromise(s.fetchRealtime(topology, filter));
  expect(second.arrivals[0].predictedTime).toBe(first.arrivals[0].predictedTime);
});
it.each([
  ["3 MIN", 180_000],
  ["DUE", 30_000],
])("serves %s on canonical station platforms", async (label, offset) => {
  const { createGenericStationsSource } =
    await import("~/infrastructure/realtime/genericStationsSource");
  const stations = createGenericStationsSource({
    agencyId: "sample",
    routeType: "bus",
    now: () => now,
    feeds: [{ kind: "bustime", format: "xml", url: `https://station.test/${++serial}` }],
    stations: [
      {
        id: "hub",
        name: "Hub",
        lat: 52,
        lon: -113,
        lines: ["R7"],
        platformIds: ["P"],
        departureRouteIds: ["R7"],
      },
    ],
    getSourceAgencyScope: () =>
      Effect.succeed({
        routeIds: new Set(["R7"]),
        stopIds: new Set(["P"]),
        stopsByCode: new Map([["0042", ["P"]]]),
      }),
    fetch: (async () =>
      new Response(
        `<stop><id>0042</id><pre><pt>${label}</pt><v>BUS</v><scheduled>false</scheduled><rn>R7</rn></pre></stop>`,
        { headers: { Date: new Date(now).toUTCString() } },
      )) as typeof fetch,
  });
  const [station] = await Effect.runPromise(stations.fetchByIds({ stationIds: ["hub"] }));
  expect(station.arrivals).toEqual([expect.objectContaining({ times: [now + offset] })]);
  expect(station.arrivalsStale ?? false).toBe(false);
});
