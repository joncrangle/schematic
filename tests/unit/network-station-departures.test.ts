import { describe, expect, it } from "vitest";
import {
  decodeMappedStationDepartures,
  fetchMappedStationDepartures,
} from "~/infrastructure/realtime/mappedStationDepartures";
import type { StationDeparturesResponseMapping } from "~/agencies/types";

const now = Date.parse("2026-01-10T12:00:00Z");
const mapping: StationDeparturesResponseMapping = {
  networkStations: {
    path: "stations",
    idField: "code",
    groupsField: "groups",
    stopCodes: { platformA: "CENTRAL", platformB: "CENTRAL", other: "OTHER" },
  },
  routesPath: "$",
  routeIdField: "color",
  departuresField: "calls",
  timeField: "seconds",
  timeFormat: "countdown-seconds",
  updatedAtField: "observed",
  maxAgeSeconds: 120,
  routeAliases: { blue: "R", "blue,orange": "V" },
  directionField: "bound",
  directionAliases: { outward: 0, inward: 1 },
  headsignField: "destination",
};
const body = {
  stations: [
    {
      code: "CENTRAL",
      groups: [
        {
          bound: "outward",
          calls: [
            {
              color: "blue",
              seconds: "90",
              observed: "2026-01-10T12:00:00Z",
              destination: "Airport",
            },
          ],
        },
      ],
    },
    { code: "OTHER", groups: [] },
  ],
};
describe("network station countdowns", () => {
  it("joins declared platforms and preserves source timing, route and direction", () => {
    const result = decodeMappedStationDepartures(body, "platformA", mapping, undefined, now);
    expect(result).toMatchObject([
      {
        stopId: "platformA",
        routeId: "R",
        directionId: 0,
        directionAuthoritative: true,
        predictedTime: now + 90_000,
        isRealtime: true,
        headsign: "Airport",
      },
    ]);
    expect(
      decodeMappedStationDepartures(body, "platformB", mapping, undefined, now)[0]?.tripId,
    ).toBe(result[0]?.tripId);
  });
  it.each(["-1", "oops", "", "Infinity"])("rejects invalid countdown %s", (seconds) => {
    const invalid = structuredClone(body);
    invalid.stations[0].groups[0].calls[0].seconds = seconds;
    expect(() =>
      decodeMappedStationDepartures(invalid, "platformA", mapping, undefined, now),
    ).toThrow();
  });
  it("accepts a recognized empty station and rejects missing identities", () => {
    expect(decodeMappedStationDepartures(body, "other", mapping, undefined, now)).toEqual([]);
    expect(() => decodeMappedStationDepartures(body, "absent", mapping, undefined, now)).toThrow();
    expect(() =>
      decodeMappedStationDepartures({ stations: [] }, "platformA", mapping, undefined, now),
    ).toThrow();
  });
  it("shares the document across stations while checking observation age on cache hits", async () => {
    let clock = now;
    let calls = 0;
    const opts = {
      agencyId: "fictional",
      now: () => clock,
      fetch: async () => {
        calls++;
        return Response.json(body);
      },
    };
    const feed = {
      kind: "station_departures" as const,
      url: "https://example.test/board",
      format: "json" as const,
      responseMapping: mapping,
      pollIntervalSeconds: 300,
    };
    const first = await fetchMappedStationDepartures(opts, feed, "platformA");
    expect(await fetchMappedStationDepartures(opts, feed, "other")).toEqual([]);
    clock += 30_000;
    expect((await fetchMappedStationDepartures(opts, feed, "platformA"))[0]?.predictedTime).toBe(
      first[0]?.predictedTime,
    );
    clock += 120_000;
    await expect(fetchMappedStationDepartures(opts, feed, "platformA")).rejects.toThrow("Stale");
    expect(calls).toBe(1);
  });
});
