import { expect, it } from "vitest";
import { decodeSamsaraJob } from "~/infrastructure/realtime/samsara/samsaraBoards";

const now = Date.parse("2026-11-12T20:00:00Z");
const job = {
  id: 7,
  destinationName: "Central",
  jobState: 2,
  scheduledArrivalTime: now + 600000,
  arrivedAt: 0,
  completedAt: 0,
  eta: { etaMs: now + 540000, etaRefreshedAtMs: now - 60000 },
};
it("uses a refreshed computed ETA rather than the scheduled arrival", () => {
  expect(decodeSamsaraJob(job, { stopId: "s", routeId: "A", headsign: "West" }, now)).toMatchObject(
    {
      stopId: "s",
      routeId: "A",
      predictedTime: now + 540000,
      delaySeconds: -60,
      isRealtime: true,
    },
  );
});
it.each([
  { ...job, eta: null },
  { ...job, arrivedAt: now - 1000 },
  { ...job, completedAt: now - 1000 },
  { ...job, jobState: 3 },
  { ...job, eta: { etaMs: now + 100000, etaRefreshedAtMs: now - 1200001 } },
  { ...job, eta: { etaMs: now - 1000, etaRefreshedAtMs: now } },
  { ...job, eta: { etaMs: now + 100000, etaRefreshedAtMs: now + 60001 } },
])("excludes schedules, completed calls, and stale estimates", (body) => {
  expect(
    decodeSamsaraJob(body, { stopId: "s", routeId: "A", headsign: "West" }, now),
  ).toBeUndefined();
});
it("rejects an unrecognized tracker payload", () => {
  expect(() =>
    decodeSamsaraJob({}, { stopId: "s", routeId: "A", headsign: "West" }, now),
  ).toThrow();
});

import { decodeSamsaraStations } from "~/infrastructure/gtfs/samsaraStationsArchive";
it("preserves native route identities, time zones, and on-demand stops without manufacturing service", () => {
  const body = {
    data: [
      {
        id: 1,
        attributes: {
          Name: "Central [On Demand]",
          Timezone: "CT",
          Coordinates: { Latitude: "50", Longitude: "-95" },
          Schedule: [{ Route: "East - West", Stop_No: 2 }],
          routes: { data: [{ attributes: { Name: "East - West" } }] },
        },
      },
    ],
    meta: { pagination: { total: 1 } },
  };
  expect(decodeSamsaraStations(body)).toEqual({
    stations: {
      "1": { name: "Central [On Demand]", lat: 50, lon: -95, routeIds: ["East - West"] },
    },
    routes: ["East - West"],
    stops: [[1, 1, "Central [On Demand]", 50, -95, "America/Winnipeg"]],
    calls: [["East - West", "00:00:00", "00:00:00", 1, 3]],
  });
  expect(() => decodeSamsaraStations({ ...body, meta: { pagination: { total: 2 } } })).toThrow(
    "Incomplete",
  );
});

import { vi } from "vitest";
import { fetchSamsaraBoards } from "~/infrastructure/realtime/samsara/samsaraBoards";
const feed = {
  kind: "samsara_boards" as const,
  format: "json" as const,
  url: "https://board.example.test/api",
  trackerOrigin: "https://tracker.example.test",
  orgId: "12",
  pollIntervalSeconds: 60,
  stations: {
    s: { name: "Central", lat: 50, lon: -95, routeIds: ["East - West"] },
    other: { name: "Other [On Demand]", lat: 51, lon: -95, routeIds: ["East - West"] },
  },
};
it("joins the requested station to its public tracker and shares polls across callers", async () => {
  const csrfHeaders: (string | null)[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/auth/csrf"))
      return new Response(JSON.stringify({ csrf_token: "anonymous-fixture" }), {
        headers: { "Set-Cookie": "session=fictional; HttpOnly" },
      });
    if (url.endsWith("/r/graphql")) {
      csrfHeaders.push(new Headers(init?.headers).get("X-Csrf-Token"));
      return new Response(
        JSON.stringify({
          data: {
            dispatchJobFleetViewerToken: {
              job,
              dispatchRoute: {
                dispatchJobsV2: [
                  { job: { ...job, destinationLat: 50, destinationLng: -95 } },
                  { job: { ...job, id: 8, destinationLat: 51, destinationLng: -95 } },
                ],
              },
              routeIsComplete: false,
            },
          },
        }),
      );
    }
    return new Response(
      JSON.stringify({
        etas: [
          {
            id: "7",
            attributes: {
              samaraRouteName: "East - West",
              stopName: "Central",
              stopPosition: "middle",
              state: "en route",
              actualRouteStartTime: new Date(now - 3600000).toISOString(),
              scheduledRouteEndTime: new Date(now + 3600000).toISOString(),
              liveSharingUrl: "https://tracker.example.test/o/12/fleet/viewer/job/public-fixture",
              vehicleName: "bus-1",
              vehicleLocation: {
                latitude: 50,
                longitude: -95,
                timestamp: new Date(now - 10000).toISOString(),
              },
            },
          },
        ],
      }),
    );
  });
  const options = { fetch, now: () => now, stopIds: new Set(["s"]) };
  const first = await fetchSamsaraBoards(feed, options);
  expect(first).toMatchObject({
    arrivals: [{ stopId: "s", routeId: "East - West", isRealtime: true }],
    vehicles: [{ vehicleId: "bus-1", routeId: "East - West" }],
    partial: false,
  });
  expect(await fetchSamsaraBoards(feed, options)).toEqual(first);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(csrfHeaders).toEqual(["anonymous-fixture"]);
  expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get("stationName")).toBe("Central");
});
it.each([
  { case: "missing", body: {} },
  { case: "null", body: { etas: null } },
])("fails closed on malformed station boards", async ({ case: name, body }) => {
  await expect(
    fetchSamsaraBoards(
      { ...feed, url: `${feed.url}?case=${name}` },
      {
        fetch: async () => new Response(JSON.stringify(body)),
        now: () => now,
        stopIds: new Set(["s"]),
      },
    ),
  ).rejects.toThrow("unavailable");
});
it("accepts a complete empty board without visiting the tracker", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ etas: [] })));
  expect(
    await fetchSamsaraBoards(
      { ...feed, url: `${feed.url}?case=empty` },
      { fetch, now: () => now, stopIds: new Set(["s"]) },
    ),
  ).toEqual({ arrivals: [], vehicles: [], partial: false });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("marks an exhausted request budget partial", async () => {
  const fetch = vi.fn();
  expect(await fetchSamsaraBoards(feed, { fetch, now: () => now, maxSubrequests: 0 })).toEqual({
    arrivals: [],
    vehicles: [],
    partial: true,
  });
  expect(fetch).not.toHaveBeenCalled();
});

function transport(label: string, jobs: unknown[], rejectSession = false) {
  const configured = {
    ...feed,
    url: `https://${label}.example.test/board`,
    trackerOrigin: `https://${label}.example.test`,
  };
  let sessions = 0,
    queries = 0;
  const cookieHeaders: (string | null)[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/auth/csrf")) {
      sessions++;
      return new Response(JSON.stringify({ csrf_token: `csrf-${sessions}` }), {
        headers: { "Set-Cookie": `session=${sessions}; HttpOnly` },
      });
    }
    if (url.endsWith("/r/graphql")) {
      queries++;
      if (rejectSession && queries === 1) return new Response("expired", { status: 401 });
      cookieHeaders.push(new Headers(init?.headers).get("Cookie"));
      return new Response(
        JSON.stringify({
          data: {
            dispatchJobFleetViewerToken: {
              job,
              routeIsComplete: false,
              dispatchRoute: { dispatchJobsV2: jobs.map((job) => ({ job })) },
            },
          },
        }),
      );
    }
    return new Response(
      JSON.stringify({
        etas: [
          {
            id: "7",
            attributes: {
              samaraRouteName: "East - West",
              stopName: "Central",
              stopPosition: "middle",
              state: "en route",
              actualRouteStartTime: new Date(now - 3600000).toISOString(),
              scheduledRouteEndTime: new Date(now + 3600000).toISOString(),
              liveSharingUrl: `${configured.trackerOrigin}/o/12/fleet/viewer/job/public-${label}`,
              vehicleName: "bus-1",
              vehicleLocation: {
                latitude: 50,
                longitude: -95,
                timestamp: new Date(now).toISOString(),
              },
            },
          },
        ],
      }),
    );
  });
  return {
    feed: configured,
    fetch,
    sessions: () => sessions,
    queries: () => queries,
    cookies: () => cookieHeaders,
  };
}
const routedJob = { ...job, destinationLat: 50, destinationLng: -95 };
const terminalJob = { ...routedJob, id: 999, destinationLat: 52 };
it("reads a complete long route through one hub instead of starving later stops", async () => {
  const jobs = Array.from({ length: 50 }, (_, i) => ({
    ...routedJob,
    id: i + 7,
    destinationLat: 50 + i * 0.01,
  }));
  const mock = transport("long-route", [...jobs, terminalJob]);
  const stations = Object.fromEntries(
    jobs.map((j, i) => [
      `z${i}`,
      {
        name: i === 0 ? "Central" : `Station ${i}`,
        lat: j.destinationLat,
        lon: -95,
        routeIds: ["East - West"],
      },
    ]),
  );
  const result = await fetchSamsaraBoards(
    { ...mock.feed, stations },
    { fetch: mock.fetch, now: () => now, maxSubrequests: 4 },
  );
  expect(result.arrivals).toHaveLength(50);
  expect(result.arrivals.at(-1)?.stopId).toBe("z49");
  expect(result.partial).toBe(false);
  expect(mock.fetch).toHaveBeenCalledTimes(3);
});
it("retains a healthy job after a stale job on the same route", async () => {
  const mock = transport("partial-jobs", [
    { ...routedJob, eta: { etaMs: now + 100000, etaRefreshedAtMs: now - 1200001 } },
    { ...routedJob, id: 8 },
    terminalJob,
  ]);
  const result = await fetchSamsaraBoards(mock.feed, {
    fetch: mock.fetch,
    now: () => now,
    stopIds: new Set(["s"]),
  });
  expect(result.arrivals.map((a) => a.tripId)).toEqual(["8"]);
  expect(result.partial).toBe(true);
});
it("renews an anonymous session once after a CSRF rejection", async () => {
  const mock = transport("session-renewal", [routedJob, terminalJob], true);
  const result = await fetchSamsaraBoards(mock.feed, {
    fetch: mock.fetch,
    now: () => now,
    stopIds: new Set(["s"]),
  });
  expect(result.arrivals).toHaveLength(1);
  expect(mock.sessions()).toBe(2);
  expect(mock.queries()).toBe(2);
  expect(mock.cookies()).toEqual(["session=2"]);
});
it("reads fleet observations without requesting departure trackers", async () => {
  const mock = transport("fleet-only", []);
  const result = await fetchSamsaraBoards(
    { ...mock.feed, stations: { s: mock.feed.stations.s } },
    {
      fetch: mock.fetch,
      now: () => now,
      vehiclesOnly: true,
    },
  );
  expect(result.vehicles).toMatchObject([{ vehicleId: "bus-1" }]);
  expect(result.arrivals).toEqual([]);
  expect(mock.fetch).toHaveBeenCalledTimes(1);
  expect(mock.queries()).toBe(0);
});
it("keeps schedule membership when a source relation is missing and applies facility coordinates", () => {
  const result = decodeSamsaraStations(
    {
      data: [
        {
          id: 1,
          attributes: {
            Name: "Village [On Demand]",
            Timezone: "ET",
            Coordinates: { Latitude: "50", Longitude: "-95" },
            Schedule: [{ Route: "East - West", Stop_No: 3 }],
            routes: { data: [] },
          },
        },
      ],
      meta: { pagination: { total: 1 } },
    },
    { "1": { lat: 51, lon: -96 } },
  );
  expect(result.stations["1"]).toEqual({
    name: "Village [On Demand]",
    lat: 51,
    lon: -96,
    routeIds: ["East - West"],
  });
  expect(result.calls).toHaveLength(1);
});

it("distinguishes nearby same-route stations by their nearest verified coordinates", async () => {
  const mock = transport("nearby-hotels", [
    routedJob,
    { ...routedJob, id: 8, destinationLat: 51 },
    { ...routedJob, id: 9, destinationLat: 51.0009 },
    terminalJob,
  ]);
  const stations = {
    s: feed.stations.s,
    z1: { name: "First hotel", lat: 51, lon: -95, routeIds: ["East - West"] },
    z2: { name: "Second hotel", lat: 51.0009, lon: -95, routeIds: ["East - West"] },
  };
  const result = await fetchSamsaraBoards(
    { ...mock.feed, stations },
    { fetch: mock.fetch, now: () => now },
  );
  expect(result.arrivals.map((a) => a.stopId)).toEqual(["s", "z1", "z2"]);
  expect(result.partial).toBe(false);
});

it("preserves a healthy empty board when another requested board fails", async () => {
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const name = new URL(String(input)).searchParams.get("stationName");
    return new Response(JSON.stringify(name === "Central" ? { etas: [] } : { etas: null }));
  });
  const result = await fetchSamsaraBoards(
    { ...feed, url: "https://mixed-empty.example.test/board" },
    { fetch, now: () => now, stopIds: new Set(["s", "other"]) },
  );
  expect(result).toEqual({ arrivals: [], vehicles: [], partial: true });
});

it("retains healthy route jobs when a neighboring job has an unknown shape", async () => {
  const mock = transport("malformed-route-job", [{ id: 8 }, routedJob, terminalJob]);
  const result = await fetchSamsaraBoards(mock.feed, {
    fetch: mock.fetch,
    now: () => now,
    stopIds: new Set(["s"]),
  });
  expect(result.arrivals.map((a) => a.tripId)).toEqual(["7"]);
  expect(result.partial).toBe(true);
});
