import { describe, expect, it } from "vitest";
import {
  citywayHeaders,
  decodeCitywayBoard,
  fetchCitywayArrivals,
  type CitywayStopRequest,
} from "../../src/infrastructure/realtime/cityway/citywaySource";

const now = Date.parse("2026-11-12T14:00:00Z");
const request: CitywayStopRequest = {
  logicalStopId: "10",
  physicalStopId: "20",
  lineId: "30",
  routeId: "A",
  direction: 1,
};
const journey = (real: string | null, restriction = "ExitNotAllowed") => ({
  VJourneyId: 7,
  JPatternName: "Central",
  VJourneyStatus: "Scheduled",
  PassingTimes: [
    {
      StopId: 20,
      Order: 1,
      Departure: {
        TheoreticalTime: "2026-11-12T09:10:00",
        RealTime: real,
        Restriction: restriction,
      },
    },
  ],
});
describe("Cityway stop boards", () => {
  it("reads rotated public keys from HTML-escaped iframe URLs", async () => {
    const headers = await citywayHeaders(
      { riderPageUrl: "https://rider.example.test/schedules" },
      {
        fetch: async () =>
          new Response(
            '<iframe src="https://app.example.test/iframe?module=SCHEDULES&#038;apikey=public-demo"></iframe>',
          ),
      },
    );
    expect(headers).toEqual({ apikey: "public-demo" });
  });
  it("uses request route identity and local live time without dropping origin departures", () => {
    expect(
      decodeCitywayBoard([journey("2026-11-12T09:12:00")], "S", request, "America/Toronto", now),
    ).toMatchObject([
      {
        routeId: "A",
        stopId: "S",
        predictedTime: now + 720000,
        delaySeconds: 120,
        isRealtime: true,
      },
    ]);
  });
  it("keeps scheduled rows marked as scheduled", () => {
    expect(decodeCitywayBoard([journey(null)], "S", request, "America/Toronto", now)).toMatchObject(
      [{ predictedTime: now + 600000, isRealtime: false }],
    );
  });
  it("excludes arrivals where boarding is prohibited", () => {
    expect(
      decodeCitywayBoard([journey(null, "EntryNotAllowed")], "S", request, "America/Toronto", now),
    ).toEqual([]);
  });
  it("rejects an unrecognized document instead of clearing departures", () => {
    expect(() => decodeCitywayBoard({}, "S", request, "America/Toronto", now)).toThrow();
  });
});

it.each([
  { status: 204, expected: { state: "success", value: { arrivals: [], partial: false } } },
  { status: 200, expected: { state: "failure" } },
])(
  "accepts only a verified no-content response as an empty Cityway board: $status",
  async ({ status, expected }) => {
    const feed = {
      kind: "cityway" as const,
      format: "json" as const,
      url: `https://board-${status}.example.test`,
      riderPageUrl: `https://rider-${status}.example.test`,
      networkId: "1",
      timeZone: "America/Toronto",
      stopMap: { S: [request] },
    };
    const fetch = async (input: string | URL | Request) =>
      String(input).includes("rider")
        ? new Response('<iframe src="https://app.test/?apikey=public"></iframe>')
        : new Response(null, { status });
    const value = fetchCitywayArrivals(feed, { fetch, now: () => now });
    const outcome = await value.then(
      (value) => ({ state: "success", value }),
      () => ({ state: "failure" }),
    );
    expect(outcome).toEqual(expected);
  },
);
