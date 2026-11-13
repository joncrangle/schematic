import { describe, expect, it, vi } from "vitest";
import {
  decodeHubupRealtime,
  fetchHubupRealtime,
} from "../../src/infrastructure/realtime/hubup/hubupSource";
const now = Date.parse("2026-11-12T15:00:00Z");
const tails = [
  {
    user_id: 4,
    company_tag: "DEMO",
    tail: {
      lat: 45,
      lon: -74,
      unix: now / 1000,
      fd_heading: 90,
      fg_next_rev_stop_time: "next",
      fg_lateness: 1.5,
    },
    theo_ref: { real_trip_id: "trip", real_route_id: "A", rev_trip_id: "revision" },
  },
];
const details = {
  rev_stop_times: [
    {
      id: "previous",
      rev_trip_id: "revision",
      rev_stop_id: "r1",
      arrival_time: "09:59:00",
      stop_sequence: "1",
    },
    {
      id: "next",
      rev_trip_id: "revision",
      rev_stop_id: "r2",
      arrival_time: "10:01:00",
      stop_sequence: "2",
    },
  ],
  rev_stops: [
    { id: "r1", stop_id: "V1:S:1" },
    { id: "r2", stop_id: "V1:S:2" },
  ],
  stops: [
    { id: "V1:S:1", real_stop_id: "1" },
    { id: "V1:S:2", real_stop_id: "2" },
  ],
};
describe("Hubup revised calls", () => {
  it("joins revised identities and applies live lateness in minutes only to remaining stops", () => {
    expect(decodeHubupRealtime(tails, details, "demo", "America/Toronto", now)).toMatchObject({
      vehicles: [{ vehicleId: "4", routeId: "A", timestamp: now }],
      arrivals: [
        {
          routeId: "A",
          tripId: "trip",
          stopId: "2",
          predictedTime: now + 150000,
          delaySeconds: 90,
          isRealtime: true,
        },
      ],
    });
    expect(
      decodeHubupRealtime(tails, details, "demo", "America/Toronto", now).arrivals,
    ).toHaveLength(1);
  });
  it("does not turn static calls into live predictions without a live lateness", () => {
    expect(
      decodeHubupRealtime(
        [{ ...tails[0], tail: { ...tails[0].tail, fg_lateness: null } }],
        details,
        "demo",
        "America/Toronto",
        now,
      ).arrivals,
    ).toEqual([]);
  });
  it("fails when a live next-stop reference cannot be resolved", () => {
    expect(() =>
      decodeHubupRealtime(
        tails,
        { ...details, rev_stop_times: [] },
        "demo",
        "America/Toronto",
        now,
      ),
    ).toThrow();
  });
  it("rejects stale observations", () => {
    expect(() =>
      decodeHubupRealtime(tails, details, "demo", "America/Toronto", now + 600000),
    ).toThrow();
  });
});

it("keeps after-midnight revised calls on the live trip's service day", () => {
  const overnight = Date.parse("2026-11-13T06:00:00Z");
  const data = decodeHubupRealtime(
    [{ ...tails[0], tail: { ...tails[0].tail, unix: overnight / 1000 } }],
    { ...details, rev_stop_times: [{ ...details.rev_stop_times[1], arrival_time: "25:05:00" }] },
    "demo",
    "America/Toronto",
    overnight,
  );
  expect(data.arrivals[0].predictedTime).toBe(overnight + 390000);
});
it("does not let another company's fresh tail mask this company's stale feed", async () => {
  const feed = {
    kind: "hubup" as const,
    format: "json" as const,
    url: "https://hubup.example.test",
    tailsUrl: "https://tails.example.test/companies",
    companyTag: "demo",
    timeZone: "America/Toronto",
  };
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify([
          { ...tails[0], tail: { ...tails[0].tail, unix: now / 1000 - 600 } },
          { ...tails[0], company_tag: "OTHER" },
        ]),
      ),
  );
  await expect(fetchHubupRealtime(feed, { fetch, now: () => now })).rejects.toThrow();
});
