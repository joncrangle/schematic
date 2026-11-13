import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_AGENT, fetchDecodedFeeds } from "~/infrastructure/realtime/fetchDecodedFeeds";
import { createGenericGtfsRealtimeSource } from "~/infrastructure/realtime/genericGtfsRealtimeSource";
import { createGenericStationsSource } from "~/infrastructure/realtime/genericStationsSource";
import {
  isTmixOperatorInScope,
  tmixStopCallsBody,
  tmixStopCallsRequest,
  tmixStopCallsUrl,
  tmixVehiclePositionRequest,
  tmixVehiclePositionUrl,
  type TmixAnyRideFeed,
} from "~/infrastructure/realtime/tmix/tmixTransport";
import {
  TMIX_MAX_SUBREQUESTS,
  fetchTmixStationArrivals,
  tmixCallStopsFor,
  tmixWorkPlan,
} from "~/infrastructure/realtime/tmix/tmixRealtimeSource";
import { logger } from "~/infrastructure/logging/logger";
import type { StaticSnapshot } from "~/domain/surface/topologySource";
import type { SchematicStationIndexEntry } from "~/agencies/types";
import { RealtimeError } from "~/domain/surface/realtimeSource";
import { tmixFixture } from "../fixtures/realtime/tmix-wire-fixtures";
import { makeStationSchematic, makeTestProvider } from "../helpers/agency-fixtures";
import {
  concatBuffers,
  encodeFeedHeader,
  encodeMessage,
  encodeString,
  encodeVarintField,
} from "../helpers/gtfs-rt-binary";

const MILTON_BASE_URL = "https://milton.tmix.se/Tmix.Cap.Ti.Process.AnyRide/api";

const miltonFeed: TmixAnyRideFeed = {
  kind: "tmix_anyride",
  url: MILTON_BASE_URL,
  format: "json",
  operatorPrefix: "60",
};

/** Stands in for a decoder when the assertion is about the request, not the body. */
const noDecoder = { decode: () => Effect.succeed(null), mapError: (cause: unknown) => cause };

/** Records the init the shared kernel hands to fetch; never touches the network. */
function recordingFetch(): {
  readonly fetch: typeof fetch;
  readonly init: () => RequestInit | undefined;
} {
  let captured: RequestInit | undefined;
  const fetch: typeof globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    captured = init;
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  return { fetch, init: () => captured };
}

describe("Tmix AnyRide operator scoping", () => {
  // Only id shapes that actually occur. The predicate is called exclusively as
  // `isTmixOperatorInScope(String(call.lineId), prefix)`, so the argument is
  // always a 6-7 digit AnyRide line id; rows for shapes Tmix cannot emit would
  // pin nothing. What matters is which FIELD it is fed, since the two wrong
  // fields fail silently by dropping the whole agency.
  it.each([
    ["6000007", "60", true, "a Milton lineId, the one operator-scoped field"],
    ["6000023", "60", true, "another Milton lineId from the same block"],
    ["1004657", "60", false, "a Milton routeId, a system-wide Tmix number"],
    ["1003183", "60", false, "another system-wide route number"],
    ["8", "60", false, "a bare human line label, which carries no prefix"],
    ["6000007", "61", false, "our own lineId against a neighbouring operator"],
    ["6080001", "60", true, "an id that extends the prefix, a known limit"],
  ] as const)("scopes %j against prefix %j as %s (%s)", (id, operatorPrefix, expected, _why) => {
    expect(isTmixOperatorInScope(id, operatorPrefix)).toBe(expected);
  });

  it("keeps each station response paired with its declared operator prefix", async () => {
    const secondFeed: TmixAnyRideFeed = {
      ...miltonFeed,
      url: "https://example.test/second-feed",
      operatorPrefix: "61",
    };
    const firstFeed: TmixAnyRideFeed = {
      ...miltonFeed,
      url: "https://example.test/first-feed",
    };
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const payload = url.includes("first-feed")
        ? callsBody([wireCall({ id: "from-first-wrong-tenant", lineId: 6100007, line: "91" })])
        : callsBody([wireCall({ id: "from-second", lineId: 6100008, line: "92" })]);
      return new Response(payload, { status: 200 });
    });

    const result = await Effect.runPromise(
      fetchTmixStationArrivals({
        agencyId: "fictional-transit",
        platformIds: ["platform-1"],
        feeds: [firstFeed, secondFeed],
        fetch: fetch as unknown as typeof globalThis.fetch,
      }),
    );

    expect(result.byStop.get("platform-1")?.map((arrival) => arrival.tripId)).toEqual([
      "from-second",
    ]);
  });
});

describe("Tmix AnyRide mapped stop queries", () => {
  it("queries numeric areas while projecting calls onto the requested GTFS stop", async () => {
    const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).query.fromStopAreaQuery).toBe("42");
      return new Response(callsBody([wireCall({ stopPointId: 999999 })]));
    });
    const result = await Effect.runPromise(fetchTmixStationArrivals({
      agencyId: "fictional-transit", platformIds: ["ALPHA"],
      feeds: [{ ...miltonFeed, stopAreaMap: { ALPHA: "42" } }],
      fetch: fetch as typeof globalThis.fetch,
    }));
    expect(result.byStop.get("ALPHA")?.[0]?.stopId).toBe("ALPHA");
    expect(result.byStop.has("999999")).toBe(false);
  });

  it("fails an unmapped GTFS stop without sending a query to the vendor", async () => {
    const fetch = vi.fn();
    await expect(Effect.runPromise(fetchTmixStationArrivals({
      agencyId: "fictional-transit", platformIds: ["MISSING"],
      feeds: [{ ...miltonFeed, stopAreaMap: { ALPHA: "42" } }],
      fetch: fetch as typeof globalThis.fetch,
    }))).rejects.toThrow(/Missing AnyRide stop-area mapping/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Tmix AnyRide endpoints", () => {
  it("builds the GetCalls body from the stop area query", () => {
    expect(tmixStopCallsBody("MI2203")).toBe(
      '{"query":{"fromStopAreaQuery":"MI2203"},"configuration":{"grouping":[]}}',
    );
  });

  it("addresses GetCalls on the declared base URL", () => {
    expect(tmixStopCallsUrl(MILTON_BASE_URL)).toBe(`${MILTON_BASE_URL}/GetCalls`);
  });

  it("addresses the singular GetVehiclePosition by call id", () => {
    const url = new URL(tmixVehiclePositionUrl(MILTON_BASE_URL, "2027026825"));

    expect(url.pathname).toBe("/Tmix.Cap.Ti.Process.AnyRide/api/GetVehiclePosition");
    expect(url.searchParams.get("callId")).toBe("2027026825");
  });

  it("keeps a call id that needs escaping out of the query structure", () => {
    const url = new URL(tmixVehiclePositionUrl(MILTON_BASE_URL, "a b&c=d"));

    expect(url.searchParams.get("callId")).toBe("a b&c=d");
    expect(url.search).toBe("?callId=a+b%26c%3Dd");
  });

  it("tolerates trailing slashes on the declared base URL", () => {
    expect(tmixStopCallsUrl(`${MILTON_BASE_URL}/`)).toBe(`${MILTON_BASE_URL}/GetCalls`);
    expect(tmixVehiclePositionUrl(`${MILTON_BASE_URL}//`, "1")).toBe(
      `${MILTON_BASE_URL}/GetVehiclePosition?callId=1`,
    );
  });
});

describe("Tmix AnyRide request descriptors", () => {
  it.each([
    ["stop calls", tmixStopCallsRequest(miltonFeed, "MI2203", noDecoder)],
    ["single vehicle position", tmixVehiclePositionRequest(miltonFeed, "2027026825", noDecoder)],
  ])("uses the shared transport user agent for %s", async (_label, feed) => {
    const { fetch, init } = recordingFetch();
    await Effect.runPromise(fetchDecodedFeeds([feed], { fetch }));

    const headers = new Headers(init()?.headers);
    expect(headers.get("User-Agent")).toBe(DEFAULT_USER_AGENT);
    expect(headers.get("Accept")).toBe("application/json");
  });

  it.each([
    ["stop calls", (feed: TmixAnyRideFeed) => tmixStopCallsRequest(feed, "S1", noDecoder)],
    [
      "single vehicle position",
      (feed: TmixAnyRideFeed) => tmixVehiclePositionRequest(feed, "1", noDecoder),
    ],
  ])("sends the declared profile as request headers on the %s request", async (_label, build) => {
    const { fetch, init } = recordingFetch();
    await Effect.runPromise(
      fetchDecodedFeeds(
        [build({ ...miltonFeed, profile: { data: "tenant_data", display: "tenant" } })],
        { fetch },
      ),
    );

    const headers = new Headers(init()?.headers);
    expect(headers.get("anyride-profile-data")).toBe("tenant_data");
    expect(headers.get("anyride-profile-display")).toBe("tenant");
  });

  it("sends only the data header when the profile declares no display", async () => {
    const { fetch, init } = recordingFetch();
    await Effect.runPromise(
      fetchDecodedFeeds(
        [
          tmixStopCallsRequest(
            { ...miltonFeed, profile: { data: "tenant_data" } },
            "S1",
            noDecoder,
          ),
        ],
        { fetch },
      ),
    );

    const headers = new Headers(init()?.headers);
    expect(headers.get("anyride-profile-data")).toBe("tenant_data");
    expect(headers.has("anyride-profile-display")).toBe(false);
  });

  it("sends no profile headers for a feed that declares none", async () => {
    const { fetch, init } = recordingFetch();
    await Effect.runPromise(
      fetchDecodedFeeds([tmixStopCallsRequest(miltonFeed, "S1", noDecoder)], { fetch }),
    );

    expect(new Headers(init()?.headers).has("anyride-profile-data")).toBe(false);
  });

  it("posts the stop area query to GetCalls as JSON", async () => {
    const { fetch, init } = recordingFetch();
    await Effect.runPromise(
      fetchDecodedFeeds([tmixStopCallsRequest(miltonFeed, "MI2203", noDecoder)], { fetch }),
    );

    expect(init()?.method).toBe("POST");
    expect(new Headers(init()?.headers).get("Content-Type")).toBe("application/json");
  });

  it("reads a single vehicle position as a GET with no body", async () => {
    const { fetch, init } = recordingFetch();
    await Effect.runPromise(
      fetchDecodedFeeds([tmixVehiclePositionRequest(miltonFeed, "2027026825", noDecoder)], {
        fetch,
      }),
    );

    expect(init()?.method).toBeUndefined();
    expect(init()?.body).toBeUndefined();
  });
});

/** Routes a URL-driven stub fetch so each branch of the fan-out is deterministic. */
function routeFetch(routes: (url: string, init?: RequestInit) => Response): {
  fetch: typeof fetch;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch: typeof globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return routes(String(url), init);
  }) as typeof fetch;
  return { fetch, calls };
}

const CALLS_BODY = tmixFixture("calls.populated.flat.json");
/** A capture at a stop with a wide mix of lines, sequences, and headsigns. */
const RICH_CALLS_BODY = tmixFixture("calls.populated.json");
/** The same stop queried with Milton's real `rowGrouping`, nesting several calls per group. */
const GROUPED_CALLS_BODY = tmixFixture("calls.populated.grouped.json");
const UNGROUPED_CALLS_BODY = tmixFixture("calls.populated.ungrouped.json");
const POSITIONS_BODY = tmixFixture("vehicle-positions.populated.json");

/**
 * Wire-shaped bodies for cases the live capture does not contain.
 *
 * Every field is one observed in a real capture; only the value under test
 * changes. Written as bodies rather than as decoder arguments so the
 * assertions still cross the transport boundary and cannot drift from what
 * Tmix actually sends.
 */
function callsBody(
  calls: readonly Record<string, unknown>[],
  grouping: "ungrouped" | "grouped" = "ungrouped",
): string {
  const groups =
    grouping === "ungrouped"
      ? calls.map((call) => ({ id: `g:${String(call.id)}`, calls: [call] }))
      : [{ id: "l:6000007/dest1:6000081", calls }];
  return JSON.stringify({ isStopCancelled: false, calls: groups, messages: [] });
}

/** A capture-shaped call; `overrides` replaces only the field under test. */
function wireCall(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "2027026825",
    key: "3",
    lineId: 6000007,
    routeId: 1004657,
    journeyId: 1494143,
    stopPointId: 6000663,
    sequenceNumber: 0,
    line: "8",
    lineAppearance: { background: "#41827C", foreground: "#FFFFFF", fontStyle: "regular" },
    journey: "632",
    destination: "WILLMOTT - MILTON GO",
    subdestination: "",
    departure: {
      journeyType: "Ordinary",
      forecastTime: "2026-09-28T11:02:00-04:00",
      plannedTime: "2026-09-28T11:02:00-04:00",
      quality: "realtime",
      attributes: [],
      designation: "",
    },
    createdTime: "2026-09-28T11:02:15.1953101-04:00",
    ...overrides,
  };
}

/** A `GetVehiclePosition` body in the capture's own shape. */
function wirePosition(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "2027026825",
    classes: [],
    timestamp: "2026-09-28T15:06:54Z",
    heading: 216.7987060546875,
    location: { lat: 43.51272071711719, lon: -79.85481346026063 },
    ...overrides,
  });
}

/** Records from the populated position fixture, keyed by call id. */
function positionsByCallId(): ReadonlyMap<string, Record<string, unknown>> {
  const records = JSON.parse(POSITIONS_BODY) as Record<string, unknown>[];
  return new Map(records.map((record) => [String(record.id), record]));
}

/**
 * Answers the real captures. A stop Tmix does not know gets the documented
 * HTTP 204 with a zero-byte body; a call it does not know gets 200 with a
 * literal `null`. Both are the vendor's real non-record answers, not stubs.
 */
function miltonRealtimeFetch(overrides?: { readonly position?: (callId: string) => Response }): {
  fetch: typeof fetch;
  calls: { url: string; init?: RequestInit }[];
} {
  const knownStops = new Set(["MI2203", "MI2017"]);
  const positions = positionsByCallId();
  return routeFetch((url, init) => {
    if (url.includes("/GetVehiclePosition?")) {
      const callId = new URL(url).searchParams.get("callId") ?? "";
      if (overrides?.position) return overrides.position(callId);
      const record = positions.get(callId);
      return new Response(record ? JSON.stringify(record) : "null", { status: 200 });
    }
    if (url.includes("/GetCalls")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        query?: { fromStopAreaQuery?: string };
      };
      const stopId = body.query?.fromStopAreaQuery ?? "";
      return knownStops.has(stopId)
        ? new Response(CALLS_BODY, { status: 200 })
        : new Response(null, { status: 204 });
    }
    return new Response("[]", { status: 200 });
  });
}

/** Topology carrying the two stops the fixtures were captured at. */
const topology: StaticSnapshot = {
  agencyId: "milton",
  routes: [
    {
      routeId: "8",
      shortName: "8",
      longName: "8",
      routeType: "bus",
      color: "#000000",
      textColor: "#FFFFFF",
      stops: [{ id: "MI2203", name: "Milton GO", lat: 43.52423, lon: -79.86618, sequence: 0 }],
    },
    {
      routeId: "5",
      shortName: "5",
      longName: "5",
      routeType: "bus",
      color: "#41827C",
      textColor: "#FFFFFF",
      stops: [{ id: "MI2017", name: "Main at Court", lat: 43.54196, lon: -79.86692, sequence: 0 }],
    },
  ],
} as unknown as StaticSnapshot;

describe("Tmix AnyRide realtime source (RealtimeSource.fetchRealtime)", () => {
  it("joins public call labels to canonical routes before tracking filters and direction inference", async () => {
    const mappedTopology: StaticSnapshot = {
      agencyId: "fictional-transit",
      generatedAt: 0,
      routes: [
        {
          ...topology.routes[0],
          routeId: "opaque-101",
          shortName: "opaque-101",
          directionId: 0,
          headsign: "East Terminal",
        },
        {
          ...topology.routes[0],
          routeId: "opaque-101",
          shortName: "opaque-101",
          directionId: 1,
          headsign: "West Terminal",
        },
      ],
    };
    const { fetch } = routeFetch(
      (url) =>
        new Response(
          url.includes("/GetVehiclePosition?")
            ? wirePosition()
            : callsBody([
                wireCall({ line: "R8", destination: "West Terminal" }),
                wireCall({ id: "unrequested", line: "R9" }),
              ]),
          { status: 200 },
        ),
    );
    const source = createGenericGtfsRealtimeSource({
      agencyId: "fictional-transit",
      feeds: [miltonFeed],
      fetch,
      routeLineMap: { R8: "opaque-101", R9: "opaque-102" },
    });

    const result = await Effect.runPromise(
      source.fetchRealtime(mappedTopology, { routeIds: new Set(["opaque-101"]) }),
    );

    expect(result.arrivals).toHaveLength(1);
    expect(result.arrivals[0]).toMatchObject({
      routeId: "opaque-101",
      directionId: 1,
      headsign: "West Terminal",
    });
    expect(result.vehicles).toHaveLength(1);
    expect(result.vehicles[0]?.routeId).toBe("opaque-101");
  });

  const miltonRealtime = (stubFetch: typeof globalThis.fetch) =>
    createGenericGtfsRealtimeSource({
      agencyId: "milton",
      feeds: [miltonFeed],
      fetch: stubFetch,
      now: () => Date.parse("2026-09-28T15:12:00Z"),
    });

  it("flattens both levels of the GetCalls group array and keys arrivals to the queried stop", async () => {
    const { fetch, calls } = miltonRealtimeFetch();
    const snapshot = await Effect.runPromise(
      miltonRealtime(fetch).fetchRealtime(topology, { stopIds: new Set(["MI2203"]) }),
    );

    // MI2203 ungrouped (`grouping: []`) is 9 groups of 1 call. A one-level decoder reads the 9
    // groups as 9 calls with no `departure` and reports zero arrivals, which is
    // the failure this test exists to prevent.
    expect(snapshot.arrivals.length).toBe(9);
    expect(calls.some((call) => call.url.endsWith("/GetCalls"))).toBe(true);
    expect(snapshot.arrivals.every((arrival) => arrival.stopId === "MI2203")).toBe(true);
  });

  it("decodes the current ungrouped capture: one call per group, with nullable arrival and occupancy", async () => {
    const { fetch } = routeFetch((url) =>
      url.includes("/GetVehiclePosition?")
        ? new Response("null", { status: 200 })
        : new Response(UNGROUPED_CALLS_BODY, { status: 200 }),
    );
    const snapshot = await Effect.runPromise(
      miltonRealtime(fetch).fetchRealtime(topology, { stopIds: new Set(["MI2203"]) }),
    );

    // Captured 2026-10-14 with `grouping: []`: four groups of one call each.
    expect(snapshot.arrivals.map((arrival) => arrival.tripId)).toEqual([
      "540411164",
      "540411336",
      "540411427",
      "1032513741",
    ]);
  });

  it("reads every call out of a multi-call group, as Milton's own rowGrouping nests them", async () => {
    const { fetch } = routeFetch((url) =>
      url.includes("/GetVehiclePosition?")
        ? new Response("null", { status: 200 })
        : new Response(GROUPED_CALLS_BODY, { status: 200 }),
    );
    const snapshot = await Effect.runPromise(
      miltonRealtime(fetch).fetchRealtime(topology, { stopIds: new Set(["MI2203"]) }),
    );

    // The grouped capture is 5 groups holding 9 calls. Counting groups instead
    // of calls would silently lose 4 departures.
    expect(snapshot.arrivals.length).toBe(9);
  });

  it("decodes exact epoch milliseconds, delay, and the call id as trip and vehicle id", async () => {
    const { fetch } = routeFetch((url) =>
      url.includes("/GetVehiclePosition?")
        ? new Response("null", { status: 200 })
        : new Response(
            callsBody([
              wireCall({
                id: "2027026825",
                departure: {
                  journeyType: "Ordinary",
                  forecastTime: "2026-09-28T11:02:00-04:00",
                  plannedTime: "2026-09-28T11:00:00-04:00",
                  quality: "realtime",
                  attributes: [],
                  designation: "",
                },
              }),
            ]),
            { status: 200 },
          ),
    );
    const [arrival] = await Effect.runPromise(
      miltonRealtime(fetch)
        .fetchRealtime(topology, { stopIds: new Set(["MI2203"]) })
        .pipe(Effect.map((snapshot) => snapshot.arrivals)),
    );

    expect(arrival).toMatchObject({
      tripId: "2027026825",
      vehicleId: "2027026825",
      routeId: "8",
      stopId: "MI2203",
      // 11:02:00 EDT, to the second. The forecast offset must be honored, not
      // read as local wall time.
      predictedTime: Date.parse("2026-09-28T15:02:00Z"),
      delaySeconds: 120,
      isRealtime: true,
      scheduleRelationship: "SCHEDULED",
      headsign: "WILLMOTT - MILTON GO",
    });
  });

  it.each([
    ["2026-09-28T11:02:00-04:00", 1790607720000, "an explicit negative UTC offset"],
    ["2026-09-28T15:06:54Z", 1790608014000, "a Z-suffixed instant"],
    [
      "2026-09-28T11:02:15.1953101-04:00",
      1790607735195,
      "seven fractional digits, truncated to ms",
    ],
    ["2026-09-28T15:02:00+00:00", 1790607720000, "a positive zero offset"],
  ])("parses %j to epoch ms (%s)", async (timestamp, expectedEpochMs) => {
    const { fetch } = routeFetch((url) =>
      url.includes("/GetVehiclePosition?")
        ? new Response("null", { status: 200 })
        : new Response(
            callsBody([
              wireCall({
                departure: { forecastTime: timestamp, plannedTime: timestamp, attributes: [] },
              }),
            ]),
            { status: 200 },
          ),
    );
    const [arrival] = await Effect.runPromise(
      miltonRealtime(fetch)
        .fetchRealtime(topology, { stopIds: new Set(["MI2203"]) })
        .pipe(Effect.map((snapshot) => snapshot.arrivals)),
    );

    expect(arrival?.predictedTime).toBe(expectedEpochMs);
  });

  it("carries the human line label as the route id, not Tmix's internal route number", async () => {
    const { fetch } = routeFetch((url) =>
      url.includes("/GetVehiclePosition?")
        ? new Response("null", { status: 200 })
        : new Response(callsBody([wireCall({ line: "9A", lineId: 6000080, routeId: 1004663 })]), {
            status: 200,
          }),
    );
    const [arrival] = await Effect.runPromise(
      miltonRealtime(fetch)
        .fetchRealtime(topology, { stopIds: new Set(["MI2203"]) })
        .pipe(Effect.map((snapshot) => snapshot.arrivals)),
    );

    // `routeId` 1004663 is a system-wide Tmix number; `line` is what the
    // agency's route table and routeLineMap are keyed on.
    expect(arrival?.routeId).toBe("9A");
  });

  it("folds branched line labels onto the canonical route id through the manifest map", async () => {
    const { fetch } = routeFetch((url) =>
      url.includes("/GetVehiclePosition?")
        ? new Response("null", { status: 200 })
        : new Response(
            callsBody([
              wireCall({ id: "line-9a", line: "9A", lineId: 6000080 }),
              wireCall({ id: "line-9b", line: "9B", lineId: 6000081 }),
              wireCall({ id: "line-8", line: "8", lineId: 6000007 }),
            ]),
            { status: 200 },
          ),
    );
    // The manifest's `routeLineMap` is what makes Tmix's branched labels join
    // the agency's single "9" route rather than inventing two extra ones.
    const snapshot = await Effect.runPromise(
      createGenericGtfsRealtimeSource({
        agencyId: "milton",
        feeds: [miltonFeed],
        fetch,
        routeLineMap: { "9A": "9", "9B": "9" },
      }).fetchRealtime(topology, { stopIds: new Set(["MI2203"]) }),
    );

    const routeFor = (tripId: string) =>
      snapshot.arrivals.find((arrival) => arrival.tripId === tripId)?.routeId;
    expect(routeFor("line-9a")).toBe("9");
    expect(routeFor("line-9b")).toBe("9");
    // An unmapped label passes through untouched.
    expect(routeFor("line-8")).toBe("8");
  });

  it("keeps Milton calls and drops other tenants' calls by lineId alone", async () => {
    const { fetch } = routeFetch((url) =>
      url.includes("/GetVehiclePosition?")
        ? new Response("null", { status: 200 })
        : new Response(
            callsBody([
              wireCall({ id: "in-scope-milton", lineId: 6000007, line: "8" }),
              wireCall({ id: "out-of-scope-neighbour", lineId: 6100042, line: "3" }),
            ]),
            { status: 200 },
          ),
    );
    const snapshot = await Effect.runPromise(
      miltonRealtime(fetch).fetchRealtime(topology, { stopIds: new Set(["MI2203"]) }),
    );

    expect(snapshot.arrivals.map((arrival) => arrival.tripId)).toEqual(["in-scope-milton"]);
  });

  it("marks every arrival's direction as inferred, since Tmix states none", async () => {
    const { fetch } = routeFetch((url) =>
      url.includes("/GetVehiclePosition?")
        ? new Response("null", { status: 200 })
        : new Response(
            callsBody([
              wireCall({ id: "north-dest" }),
              wireCall({ id: "south-dest", destination: "ONTARIO SOUTH - MILTON GO" }),
            ]),
            { status: 200 },
          ),
    );
    const snapshot = await Effect.runPromise(
      miltonRealtime(fetch).fetchRealtime(topology, { stopIds: new Set(["MI2203"]) }),
    );

    // This mark is the whole reason the display layer prefers a real headsign
    // over the compass word `directionId: 0` renders as. Without it a bus bound
    // for "ONTARIO SOUTH - MILTON GO" would be shown as "Northbound".
    expect(snapshot.arrivals.every((a) => a.directionInferred === true)).toBe(true);
    expect(snapshot.arrivals.map((a) => a.headsign)).toEqual([
      "WILLMOTT - MILTON GO",
      "ONTARIO SOUTH - MILTON GO",
    ]);
  });

  it("reads the vehicle's route from its call, since the position payload carries none", async () => {
    const { fetch } = routeFetch((url) => {
      if (!url.includes("/GetVehiclePosition?")) {
        return new Response(
          callsBody([wireCall({ id: "line-8-bus", line: "8", lineId: 6000007 })]),
          { status: 200 },
        );
      }
      return new Response(wirePosition({ id: "line-8-bus" }), { status: 200 });
    });
    const snapshot = await Effect.runPromise(miltonRealtime(fetch).fetchRealtime(topology));

    expect(snapshot.vehicles).toHaveLength(1);
    expect(snapshot.vehicles[0]).toMatchObject({ vehicleId: "line-8-bus", routeId: "8" });
  });

  it("decodes exact epoch milliseconds and coordinates from a positioned vehicle", async () => {
    const { fetch } = routeFetch((url) => {
      if (!url.includes("/GetVehiclePosition?")) {
        return new Response(callsBody([wireCall({ id: "positioned" })]), { status: 200 });
      }
      return new Response(wirePosition({ id: "positioned" }), { status: 200 });
    });
    const [vehicle] = (await Effect.runPromise(miltonRealtime(fetch).fetchRealtime(topology)))
      .vehicles;

    expect(vehicle).toMatchObject({
      vehicleId: "positioned",
      latitude: 43.51272071711719,
      longitude: -79.85481346026063,
      bearing: 216.7987060546875,
      timestamp: Date.parse("2026-09-28T15:06:54Z"),
    });
  });

  it("omits bearing entirely when the vendor omits heading, rather than emitting NaN or 0", async () => {
    const { fetch } = routeFetch((url) => {
      if (!url.includes("/GetVehiclePosition?")) {
        return new Response(callsBody([wireCall({ id: "headingless" })]), { status: 200 });
      }
      return new Response(wirePosition({ id: "headingless", heading: undefined }), { status: 200 });
    });
    const [vehicle] = (await Effect.runPromise(miltonRealtime(fetch).fetchRealtime(topology)))
      .vehicles;

    expect(vehicle).toBeDefined();
    expect("bearing" in (vehicle ?? {})).toBe(false);
    // 0 would read as "due north", which is a claim the feed never made.
    expect(vehicle?.bearing).toBeUndefined();
  });

  it("infers vehicle direction from bearing, so a headingless vehicle lands on the default", async () => {
    const at = (time: string) => ({ forecastTime: time, plannedTime: time, attributes: [] });
    const { fetch } = routeFetch((url) => {
      if (!url.includes("/GetVehiclePosition?")) {
        return new Response(
          callsBody([
            wireCall({ id: "eastbound", departure: at("2026-09-28T11:02:00-04:00") }),
            wireCall({ id: "westbound", departure: at("2026-09-28T11:03:00-04:00") }),
            wireCall({ id: "headingless-bus", departure: at("2026-09-28T11:04:00-04:00") }),
          ]),
          { status: 200 },
        );
      }
      const callId = new URL(url).searchParams.get("callId");
      const heading = callId === "eastbound" ? 90 : callId === "westbound" ? 270 : undefined;
      return new Response(wirePosition({ id: callId, heading }), { status: 200 });
    });
    const snapshot = await Effect.runPromise(miltonRealtime(fetch).fetchRealtime(topology));
    const directionFor = (id: string) =>
      snapshot.vehicles.find((vehicle) => vehicle.vehicleId === id)?.directionId;

    // Tmix states no direction anywhere; the realtime seam infers it from the
    // bearing, so 90° and 270° must resolve to opposite directions.
    expect(directionFor("eastbound")).toBe(0);
    expect(directionFor("westbound")).toBe(1);
    expect(directionFor("headingless-bus")).toBe(0);
  });

  it.each([
    { quality: "planned", forecastTime: undefined, plannedTime: "2026-09-28T11:02:00-04:00" },
    {
      quality: "timetable",
      forecastTime: "2026-09-28T11:05:00-04:00",
      plannedTime: "2026-09-28T11:02:00-04:00",
    },
    { quality: "timetable", forecastTime: "2026-09-28T11:02:00-04:00", plannedTime: undefined },
  ])(
    "keeps $quality calls scheduled rather than live",
    async ({ quality, forecastTime, plannedTime }) => {
      const { fetch } = routeFetch((url) =>
        url.includes("/GetVehiclePosition?")
          ? new Response("null", { status: 200 })
          : new Response(
              callsBody([
                wireCall({
                  id: "plan-only",
                  departure: {
                    plannedTime,
                    quality,
                    forecastTime,
                    attributes: [],
                  },
                }),
              ]),
              { status: 200 },
            ),
      );
      const [arrival] = await Effect.runPromise(
        miltonRealtime(fetch)
          .fetchRealtime(topology, { stopIds: new Set(["MI2203"]) })
          .pipe(Effect.map((snapshot) => snapshot.arrivals)),
      );

      expect(arrival?.isRealtime).toBe(false);
      expect(arrival?.predictedTime).toBe(Date.parse("2026-09-28T15:02:00Z"));
    },
  );

  it("places each vehicle from the singular endpoint and derives direction from its bearing", async () => {
    const { fetch } = miltonRealtimeFetch();
    const snapshot = await Effect.runPromise(miltonRealtime(fetch).fetchRealtime(topology));

    expect(snapshot.vehicles.length).toBeGreaterThan(0);
    for (const vehicle of snapshot.vehicles) {
      expect(Number.isFinite(vehicle.latitude)).toBe(true);
      expect(Number.isFinite(vehicle.longitude)).toBe(true);
      expect(Number.isFinite(vehicle.timestamp)).toBe(true);
      expect([0, 1]).toContain(vehicle.directionId);
    }
  });

  it("omits bearing rather than emitting NaN for the vehicles Tmix reports without a heading", async () => {
    const { fetch } = miltonRealtimeFetch();
    const snapshot = await Effect.runPromise(miltonRealtime(fetch).fetchRealtime(topology));

    const positions = positionsByCallId();
    const resolved = snapshot.vehicles.filter((vehicle) => positions.has(vehicle.vehicleId));
    // The capture contains both shapes, so the assertion is that the absent
    // one stays absent rather than defaulting to a fabricated heading.
    const headingless = resolved.filter((vehicle) => vehicle.bearing === undefined);
    expect(headingless.length).toBeGreaterThan(0);
    expect(resolved.some((vehicle) => vehicle.bearing !== undefined)).toBe(true);
    expect(
      resolved.every((vehicle) => vehicle.bearing === undefined || !Number.isNaN(vehicle.bearing)),
    ).toBe(true);
  });

  it("truncates a large fleet to the subrequest budget and says how many it dropped", async () => {
    // A body far larger than any budget, so the bound is what decides the count
    // rather than the fixture. A fixture with only 9 calls would pass whether or
    // not the budget existed.
    const fleet = Array.from({ length: 200 }, (_, index) =>
      wireCall({
        id: `bus-${index}`,
        line: "8",
        lineId: 6000007,
        departure: {
          forecastTime: "2026-09-28T12:00:00-04:00",
          plannedTime: "2026-09-28T12:00:00-04:00",
        },
      }),
    );
    const { fetch, calls } = routeFetch((url) =>
      url.includes("/GetVehiclePosition?")
        ? new Response(wirePosition({ id: new URL(url).searchParams.get("callId") ?? "" }), {
            status: 200,
          })
        : new Response(callsBody(fleet), { status: 200 }),
    );
    const warn = vi.spyOn(logger, "warn");
    // An empty stop set is the route-tracking shape: no specific stop is asked
    // for, so the source discovers stops and needs the vehicle map too.
    const snapshot = await Effect.runPromise(
      miltonRealtime(fetch).fetchRealtime(topology, { stopIds: new Set() }),
    );

    // The whole invocation, both phases, is bounded: the stop calls the plan
    // allowed plus the vehicle allowance left over.
    const plan = tmixWorkPlan(tmixCallStopsFor(topology, undefined), 1);
    const positionCalls = calls.filter((call) => call.url.includes("/GetVehiclePosition?"));
    expect(positionCalls.length).toBe(plan.vehicleAllowance);
    expect(calls.length).toBeLessThanOrEqual(TMIX_MAX_SUBREQUESTS);
    // 200 locatable, a handful placed: a partial map, which is exactly why the
    // drop is logged rather than left for a rider to wonder about.
    expect(snapshot.vehicles).toHaveLength(plan.vehicleAllowance);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("vehicle budget reached"),
      expect.objectContaining({ located: 200, shown: plan.vehicleAllowance }),
    );
    warn.mockRestore();
  });

  it("keeps the whole refresh inside the subrequest budget with two declared feeds", async () => {
    const fleet = Array.from({ length: 200 }, (_, index) =>
      wireCall({
        id: `bus-${index}`,
        departure: { forecastTime: "2026-09-28T12:00:00-04:00" },
      }),
    );
    const { fetch, calls } = routeFetch((url) =>
      url.includes("/GetVehiclePosition?")
        ? new Response(wirePosition({ id: new URL(url).searchParams.get("callId") ?? "" }), {
            status: 200,
          })
        : new Response(callsBody(fleet), { status: 200 }),
    );
    await Effect.runPromise(
      createGenericGtfsRealtimeSource({
        agencyId: "milton",
        feeds: [miltonFeed, { ...miltonFeed, operatorPrefix: "61" }],
        fetch,
      }).fetchRealtime(topology, { stopIds: new Set() }),
    );

    // Stop calls are queried per feed. Only the first feed returns calls whose
    // line ID belongs to its operator prefix, so positions are queried once
    // per located vehicle rather than once per declared feed.
    const plan = tmixWorkPlan(tmixCallStopsFor(topology, undefined), 2);
    expect(calls.length).toBeLessThanOrEqual(TMIX_MAX_SUBREQUESTS);
    expect(calls.length).toBe(plan.stops.length * 2 + plan.vehicleAllowance);
  });

  it("drops caller-named stops rather than the vehicle phase when over budget, and says so", async () => {
    // The proximity panel is the heaviest caller: it names up to 3 stops per
    // route across every route in range, which overruns the allowance on its own.
    const manyStops = Array.from({ length: 40 }, (_, index) => `MI${3000 + index}`);
    const { fetch, calls } = routeFetch(
      () => new Response(callsBody([wireCall({ id: "bus-1" })]), { status: 200 }),
    );
    const warn = vi.spyOn(logger, "warn");
    await Effect.runPromise(
      miltonRealtime(fetch).fetchRealtime(topology, { stopIds: new Set(manyStops) }),
    );

    const stopCalls = calls.filter((call) => call.url.endsWith("/GetCalls"));
    expect(stopCalls.length).toBe(tmixWorkPlan(manyStops, 1).stops.length);
    expect(calls.length).toBeLessThanOrEqual(TMIX_MAX_SUBREQUESTS);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("subrequest budget reached"),
      expect.objectContaining({ requested: 40 }),
    );
    warn.mockRestore();
  });

  it("scopes stops to requested routeIds and stopIdsByRoute instead of whole topology", () => {
    // When a rider is viewing route 5, only route 5's stops should be queried
    const route5Stops = tmixCallStopsFor(topology, { routeIds: new Set(["5"]) });
    expect(route5Stops).toEqual(["MI2017"]);

    // With stopIdsByRoute from NearbyTransit, it uses the scoped stop set
    const customScoped = tmixCallStopsFor(topology, {
      routeIds: new Set(["8"]),
      stopIdsByRoute: new Map([["8", new Set(["CUSTOM_STOP"])]]),
    });
    expect(customScoped).toEqual(["CUSTOM_STOP"]);
  });

  it("renders an empty board rather than failing when the vendor returns no calls", async () => {
    const { fetch } = routeFetch((url) =>
      url.includes("/GetVehiclePosition?")
        ? new Response("null", { status: 200 })
        : new Response(tmixFixture("calls.empty.json"), { status: 200 }),
    );
    const snapshot = await Effect.runPromise(miltonRealtime(fetch).fetchRealtime(topology));

    expect(snapshot.arrivals).toEqual([]);
    expect(snapshot.vehicles).toEqual([]);
  });

  it("treats the 204 zero-byte unknown stop as an empty result, not a parse failure", async () => {
    const { fetch } = routeFetch(() => new Response(null, { status: 204 }));
    const snapshot = await Effect.runPromise(
      miltonRealtime(fetch).fetchRealtime(topology, { stopIds: new Set(["MI2203"]) }),
    );

    // `response.ok` is true for 204, so the kernel hands the decoder an empty
    // buffer. JSON.parse on that throws, which would turn "no such stop" into
    // a panel-wide failure.
    expect(snapshot.arrivals).toEqual([]);
  });

  it("drops vehicles the vendor answers with a literal null body instead of failing the fetch", async () => {
    const { fetch } = miltonRealtimeFetch({
      position: () => new Response("null", { status: 200 }),
    });
    const snapshot = await Effect.runPromise(miltonRealtime(fetch).fetchRealtime(topology));

    expect(snapshot.vehicles).toEqual([]);
    // Reached, and honestly empty: the panel shows no vehicles rather than
    // claiming a feed failure that did not happen.
    expect(snapshot.arrivals.length).toBeGreaterThan(0);
  });

  it("drops one unparseable vehicle among good ones instead of losing the whole refresh", async () => {
    const badCallId = "2027026520";
    const { fetch } = miltonRealtimeFetch({
      // A captive portal or proxy error page: a valid 200 that JSON.parse
      // rejects. Inside `Effect.sync` that throw is a *defect*, which
      // `fetchDecodedFeeds`' `Effect.match` does not catch — the whole fetch
      // dies on one bad body out of twenty.
      position: (callId) =>
        callId === badCallId
          ? new Response("<html>proxy error</html>", { status: 200 })
          : new Response(JSON.stringify(positionsByCallId().get(callId) ?? null), { status: 200 }),
    });
    const snapshot = await Effect.runPromise(miltonRealtime(fetch).fetchRealtime(topology));

    const placed = positionsByCallId();
    const resolvable = [...placed.keys()].filter((id) => id !== badCallId);
    expect(snapshot.vehicles.map((vehicle) => vehicle.vehicleId).sort()).toEqual(resolvable.sort());
    expect(snapshot.arrivals.length).toBeGreaterThan(0);
  });

  it("fails the whole refresh when no position body is parseable", async () => {
    const { fetch } = miltonRealtimeFetch({
      position: () => new Response("<html>proxy error</html>", { status: 200 }),
    });
    const error = await Effect.runPromise(
      Effect.flip(miltonRealtime(fetch).fetchRealtime(topology)),
    );

    // Every lookup reached the vendor and every one came back unusable. That
    // is a broken phase, not a quiet network, so it must not render as an
    // empty map.
    expect(error).toBeInstanceOf(RealtimeError);
  });

  // Regression guard for the false green this adapter originally shipped.
  // Route tracking names routes, not stops, so `includeArrivals` is false and
  // the vehicle phase depends entirely on the calls phase. Gating
  // reachability on `includeArrivals` let a total GetCalls outage satisfy such
  // a request with `vehicles: []` and `vehiclesAvailable: true` — a map
  // reading "no buses running" with nothing wrong anywhere in the response.
  it.each([
    ["an empty stop set (route tracking)", new Set<string>()],
    ["a named stop (proximity)", new Set(["MI2203"])],
  ])("fails a vehicles-only refresh when every GetCalls fails, for %s", async (_label, stopIds) => {
    const { fetch } = routeFetch(() => new Response("upstream", { status: 500 }));
    const error = await Effect.runPromise(
      Effect.flip(miltonRealtime(fetch).fetchRealtime(topology, { stopIds })),
    );

    expect(error).toBeInstanceOf(RealtimeError);
    expect(error.message).toContain("HTTP 500");
  });

  it("fails loudly when the position phase reaches nobody, so a broken map never reads as a quiet one", async () => {
    const { fetch } = routeFetch((url) =>
      url.includes("/GetVehiclePosition?")
        ? new Response("upstream", { status: 500 })
        : new Response(CALLS_BODY, { status: 200 }),
    );
    const error = await Effect.runPromise(
      Effect.flip(miltonRealtime(fetch).fetchRealtime(topology)),
    );

    expect(error).toBeInstanceOf(RealtimeError);
    expect(error.message).toMatch(/Tmix/i);
  });

  it.each([
    [400, "a rejected request"],
    [500, "an upstream error"],
  ])("surfaces HTTP %i from GetCalls as a RealtimeError (%s)", async (status) => {
    const { fetch } = routeFetch(() => new Response("upstream", { status }));
    const error = await Effect.runPromise(
      Effect.flip(miltonRealtime(fetch).fetchRealtime(topology, { stopIds: new Set(["MI2203"]) })),
    );

    expect(error).toBeInstanceOf(RealtimeError);
    expect(error.message).toContain(`HTTP ${status}`);
  });

  it("still fails the missing-feed check when no Tmix feed is declared at all", async () => {
    const { fetch } = routeFetch(() => new Response("[]", { status: 200 }));
    const error = await Effect.runPromise(
      Effect.flip(
        createGenericGtfsRealtimeSource({ agencyId: "milton", feeds: [], fetch }).fetchRealtime(
          topology,
        ),
      ),
    );

    expect(error).toBeInstanceOf(RealtimeError);
    expect(error.message).toContain("Missing GTFS-RT feed configs");
  });
});

const station: SchematicStationIndexEntry = {
  id: "MI2203",
  schematicId: "8218-parkhill",
  name: "Milton GO",
  lat: 43.52423,
  lon: -79.86618,
  lines: ["1", "2", "3", "5", "6", "7", "8", "9A", "9B", "21"],
  platformIds: ["MI2203"],
} as unknown as SchematicStationIndexEntry;

describe("Tmix AnyRide stations source (StationsSource.fetchByIds)", () => {
  it("keeps a circuit's hub departure headsign instead of inventing a terminus direction", async () => {
    const schematic = makeStationSchematic(["Loop Hub", "Market"], "8");
    const line = schematic.lines[0];
    const provider = makeTestProvider(
      {
        id: "fictional-loop",
        modes: ["bus"],
        stationService: { routeType: "bus" },
        realtime: { feeds: [{ ...miltonFeed, url: "https://example.test/loop" }] },
        alerts: [],
      },
      {
        ...schematic,
        lines: [{ ...line, points: [...line.points, line.points[0]] }],
        stationIndex: schematic.stationIndex!.map((station, index) => ({
          ...station,
          lat: 43.7,
          lon: -79.4 - index * 0.01,
        })),
      },
    );
    const { fetch } = routeFetch(
      () =>
        new Response(
          callsBody([
            wireCall({
              destination: "Market Loop",
              sequenceNumber: 0,
              departure: { forecastTime: "2026-09-28T11:40:00-04:00", quality: "realtime" },
            }),
          ]),
        ),
    );
    const source = provider.createStationsSource!({
      fetch,
      now: () => Date.parse("2026-09-28T15:12:00Z"),
    });

    const cards = await Effect.runPromise(source.fetchByIds({ stationIds: ["feed-loop-hub"] }));

    expect(cards.flatMap((card) => card.arrivals).map((row) => row.label)).toEqual([
      "→ Market Loop",
    ]);
  });

  const miltonStations = (stubFetch: typeof globalThis.fetch) =>
    createGenericStationsSource({
      agencyId: "milton",
      stations: [station],
      feeds: [miltonFeed],
      fetch: stubFetch,
      now: () => Date.parse("2026-09-28T15:12:00Z"),
      routeType: "bus",
    });

  it("serves a departure row per line and headsign from the wide-mix capture", async () => {
    const { fetch } = routeFetch(() => new Response(RICH_CALLS_BODY, { status: 200 }));
    const cards = await Effect.runPromise(
      miltonStations(fetch).fetchByIds({ stationIds: ["MI2203"] }),
    );

    // The capture is 19 calls over 9 lines. Flattening only one group level
    // would yield zero rows, so this asserts the whole board is built.
    const rows = cards.flatMap((card) => card.arrivals);
    expect(rows.length).toBeGreaterThan(5);
    expect(new Set(rows.map((row) => row.lineId).filter(Boolean)).size).toBeGreaterThan(3);
    expect(rows.every((row) => row.times.length > 0)).toBe(true);
    // Line 2 runs two separate terminals from this stop, and they must not
    // collapse into one row: the headsign is the only thing separating them.
    expect(rows.filter((row) => row.label.includes("MILTON HOSPITAL")).length).toBe(1);
    expect(rows.filter((row) => row.label.includes("CROSSROADS CENTRE")).length).toBe(1);
  });

  it("labels each row with the agency's real terminal, not a synthesized compass word", async () => {
    // One line, one terminal, one direction bucket. Under the pre-existing
    // rule a non-colliding non-rail bucket renders its direction word, which
    // for this feed is the "Northbound" the decoder made up out of a constant
    // 0. The agency said "YATES - MILTON GO"; that has to be what a rider reads.
    const future = {
      forecastTime: "2026-09-28T11:40:00-04:00",
      plannedTime: "2026-09-28T11:40:00-04:00",
    };
    const { fetch } = routeFetch(
      () =>
        new Response(
          callsBody([
            wireCall({
              id: "yates-bus",
              line: "8",
              lineId: 6000007,
              destination: "YATES - MILTON GO",
              departure: future,
            }),
          ]),
          { status: 200 },
        ),
    );
    const cards = await Effect.runPromise(
      miltonStations(fetch).fetchByIds({ stationIds: ["MI2203"] }),
    );

    const labels = cards.flatMap((card) => card.arrivals.map((row) => row.label));
    expect(labels[0]).toContain("YATES - MILTON GO");
    expect(labels.some((label) => /bound/i.test(label))).toBe(false);
  });

  it("leaves an inferred direction unlabelled when it has no headsign to name it", async () => {
    const { fetch } = routeFetch(
      () =>
        new Response(
          callsBody([
            wireCall({
              id: "no-destination",
              line: "8",
              lineId: 6000007,
              destination: "",
              departure: { forecastTime: "2026-09-28T11:40:00-04:00" },
            }),
          ]),
          { status: 200 },
        ),
    );
    const cards = await Effect.runPromise(
      miltonStations(fetch).fetchByIds({ stationIds: ["MI2203"] }),
    );

    expect(cards.flatMap((card) => card.arrivals.map((row) => row.label))).toEqual([""]);
  });

  it("drops other tenants' calls from the station board on lineId alone", async () => {
    // Two calls on distinct lines, both departing after the source's `now` so
    // the only thing that can remove the second is the operator scope.
    const future = {
      forecastTime: "2026-09-28T11:40:00-04:00",
      plannedTime: "2026-09-28T11:40:00-04:00",
    };
    const { fetch } = routeFetch(
      () =>
        new Response(
          callsBody([
            wireCall({ id: "milton-bus", lineId: 6000007, line: "8", departure: future }),
            wireCall({ id: "neighbour-bus", lineId: 6100042, line: "3", departure: future }),
          ]),
          { status: 200 },
        ),
    );
    const cards = await Effect.runPromise(
      miltonStations(fetch).fetchByIds({ stationIds: ["MI2203"] }),
    );

    // The neighbour's line 3 is a real line in Milton's own table, so only
    // the operator scope on `lineId` can be what kept it off this board.
    expect(cards[0]?.arrivals.flatMap((row) => row.lineId)).not.toContain("3");
    expect(cards[0]?.arrivals.flatMap((row) => row.lineId)).toContain("8");
  });

  it("omits the headsign row when the vendor sends an empty destination", async () => {
    const { fetch } = routeFetch((url) =>
      url.includes("/GetVehiclePosition?")
        ? new Response("null", { status: 200 })
        : new Response(callsBody([wireCall({ id: "no-headsign", destination: "" })]), {
            status: 200,
          }),
    );
    const snapshot = await Effect.runPromise(
      createGenericGtfsRealtimeSource({
        agencyId: "milton",
        feeds: [miltonFeed],
        fetch,
      }).fetchRealtime(topology, { stopIds: new Set(["MI2203"]) }),
    );

    // An empty terminal is real on this feed (lines 1, 5, 6, 8 in the capture).
    // It must not become a blank or invented destination string.
    expect(snapshot.arrivals[0]?.headsign).toBeUndefined();
  });

  it("serves departures from a per-stop GetCalls with no trip_updates feed declared", async () => {
    const { fetch, calls } = miltonRealtimeFetch();
    const cards = await Effect.runPromise(
      miltonStations(fetch).fetchByIds({ stationIds: ["MI2203"] }),
    );

    expect(calls.some((call) => call.url.endsWith("/GetCalls"))).toBe(true);
    expect(cards).toHaveLength(1);
    const times = cards[0]?.arrivals.flatMap((arrival) => arrival.times) ?? [];
    expect(times.length).toBeGreaterThan(0);
    expect(times.every((time) => Number.isFinite(time))).toBe(true);
  });

  it("keeps the station card live (not stale) on an honest empty board", async () => {
    const { fetch } = routeFetch(
      () => new Response(tmixFixture("calls.empty.json"), { status: 200 }),
    );
    const cards = await Effect.runPromise(
      miltonStations(fetch).fetchByIds({ stationIds: ["MI2203"] }),
    );

    expect(cards[0]?.arrivalsStale).toBeUndefined();
    expect(cards[0]?.arrivals).toEqual([]);
  });

  it("marks the card stale when the vendor rejects every request, rather than showing an empty board", async () => {
    const { fetch } = routeFetch(() => new Response("upstream", { status: 500 }));
    const cards = await Effect.runPromise(
      miltonStations(fetch).fetchByIds({ stationIds: ["MI2203"] }),
    );

    expect(cards[0]?.arrivalsStale).toBe(true);
    expect(cards[0]?.arrivals).toEqual([]);
  });

  it("keeps readable Tmix station departures and marks the board partial after one feed fails", async () => {
    const station = {
      id: "fictional-station",
      name: "Fictional Station",
      lat: 43.7,
      lon: -79.4,
      lines: ["8"],
      platformIds: ["fictional-platform"],
    } as const;
    const readableFeed = {
      kind: "tmix_anyride",
      url: "https://example.test/primary",
      format: "json",
      operatorPrefix: "60",
    } as const;
    const failedFeed = {
      kind: "tmix_anyride",
      url: "https://example.test/secondary",
      format: "json",
      operatorPrefix: "61",
    } as const;
    const { fetch } = routeFetch((url) =>
      url.includes("primary")
        ? new Response(
            callsBody([
              wireCall({
                id: "fictional-call",
                lineId: 6000007,
                line: "8",
                departure: {
                  forecastTime: "2026-09-28T11:40:00-04:00",
                  plannedTime: "2026-09-28T11:40:00-04:00",
                },
              }),
            ]),
            { status: 200 },
          )
        : new Response("upstream", { status: 503 }),
    );
    const source = createGenericStationsSource({
      agencyId: "fictional-transit",
      stations: [station],
      feeds: [readableFeed, failedFeed],
      fetch,
      now: () => Date.parse("2026-09-28T15:12:00Z"),
      routeType: "bus",
    });

    const [card] = await Effect.runPromise(source.fetchByIds({ stationIds: [station.id] }));

    expect(card?.arrivalsStale).toBe(true);
    expect(card?.arrivals.flatMap((arrival) => arrival.times)).toEqual([
      Date.parse("2026-09-28T15:40:00Z"),
    ]);
  });

  it("answers an unknown station id with an empty list, never an error", async () => {
    const { fetch } = miltonRealtimeFetch();
    const cards = await Effect.runPromise(
      miltonStations(fetch).fetchByIds({ stationIds: ["not-a-milton-station"] }),
    );

    expect(cards).toEqual([]);
  });

  it("caps station subrequests to the budget when a station has many platforms", async () => {
    const manyPlatforms = Array.from({ length: 50 }, (_, i) => `MI_PLATFORM_${i}`);
    const station = {
      id: "large-station",
      name: "Large Terminal",
      lines: ["5"],
      platformIds: manyPlatforms,
    } as unknown as SchematicStationIndexEntry;

    const { fetch, calls } = routeFetch(() => new Response(CALLS_BODY, { status: 200 }));
    const warn = vi.spyOn(logger, "warn");
    await Effect.runPromise(
      createGenericStationsSource({
        agencyId: "milton",
        stations: [station],
        feeds: [miltonFeed],
        fetch,
        routeType: "bus",
      }).fetchByIds({ stationIds: ["large-station"] }),
    );

    expect(calls.length).toBe(TMIX_MAX_SUBREQUESTS);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("station subrequest budget reached"),
      expect.objectContaining({ dropped: 10, requested: 50 }),
    );
    warn.mockRestore();
  });

  it("merges tmix and declared station_departures when both are configured", async () => {
    const station = {
      id: "interchange-station",
      name: "Interchange",
      lines: ["5"],
      platformIds: ["MI2017"],
    } as unknown as SchematicStationIndexEntry;

    const { fetch } = routeFetch((url) =>
      url.includes("tmix")
        ? new Response(CALLS_BODY, { status: 200 })
        : new Response(
            JSON.stringify([
              {
                line: "5",
                direction: 0,
                nextTrains: [5],
              },
            ]),
            { status: 200 },
          ),
    );

    const cards = await Effect.runPromise(
      createGenericStationsSource({
        agencyId: "milton",
        stations: [station],
        feeds: [
          miltonFeed,
          {
            kind: "station_departures",
            url: "https://other.feed/departures/{stopId}",
            format: "json",
          },
        ],
        fetch,
        routeType: "bus",
      }).fetchByIds({ stationIds: ["interchange-station"] }),
    );

    expect(cards[0]?.arrivals.length).toBeGreaterThan(0);
  });
});

/**
 * Blast-radius guard for the headsign rule.
 *
 * `attach`'s label rule is shared by every agency, and the fix for the Tmix
 * false green touched it. These cases pin the pre-existing behaviour for feeds
 * that establish a real direction: TTC, GO, Miway, Brampton, Burlington,
 * Hamilton, Kingston and YRT all depend on a non-colliding, non-rail bucket
 * rendering its direction word, and none of them sets `directionInferred`.
 * Getting this wrong regresses eight agencies to fix one, so the assertions are
 * about what must NOT change.
 */
describe("station card labelling for feeds that state their direction", () => {
  const now = () => Date.parse("2026-09-28T15:12:00Z");
  const bloorWest = {
    id: "1000",
    schematicId: "1000",
    name: "Bloor West",
    lat: 43.666,
    lon: -79.4,
    lines: ["2"],
    platformIds: ["1000"],
  } as unknown as SchematicStationIndexEntry;

  /**
   * A real GTFS-RT `FeedMessage`, hand-encoded: this seam is protobuf, and
   * feeding it JSON would test nothing. `direction_id` comes from the
   * TripDescriptor, i.e. from the operator, and `stop_headsign` is a real agency
   * headsign.
   */
  function gtfsRtBody(predictions: readonly { at: number; headsign: string }[]): Uint8Array {
    const entities = predictions.map((prediction, index) =>
      encodeMessage(
        2,
        concatBuffers(
          encodeString(1, `entity-${index}`),
          encodeMessage(
            3,
            concatBuffers(
              // trip: trip_id, route_id, direction_id
              encodeMessage(
                1,
                concatBuffers(
                  encodeString(1, `trip-${index}`),
                  encodeString(5, "2"),
                  encodeVarintField(6, 0),
                ),
              ),
              // stop_time_update: stop_sequence, arrival, stop_id, stop_headsign
              encodeMessage(
                2,
                concatBuffers(
                  encodeVarintField(1, index + 1),
                  encodeMessage(2, encodeVarintField(2, Math.floor(prediction.at / 1000))),
                  encodeString(4, "1000"),
                  encodeString(7, prediction.headsign),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    return concatBuffers(encodeFeedHeader(Math.floor(1790608320000 / 1000)), ...entities);
  }

  const stationsWith = (fetchImpl: typeof globalThis.fetch) =>
    createGenericStationsSource({
      agencyId: "ttc",
      stations: [bloorWest],
      feeds: [
        { kind: "station_trip_updates", url: "https://feeds.example.test/ttc", format: "protobuf" },
      ],
      fetch: fetchImpl,
      now,
      routeType: "bus",
    });

  const protobufFetch = (bytes: Uint8Array) =>
    routeFetch(() => new Response(bytes.slice().buffer as ArrayBuffer, { status: 200 }));

  it("names a direction index by its headsign, never by an invented compass word", async () => {
    const { fetch } = protobufFetch(gtfsRtBody([{ at: 1790608500000, headsign: "KEELE" }]));
    const cards = await Effect.runPromise(stationsWith(fetch).fetchByIds({ stationIds: ["1000"] }));

    // `direction_id` groups trips but carries no bearing, so the operator's
    // headsign is the only statement of where this departure goes.
    const rows = cards.flatMap((card) => card.arrivals);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("→ KEELE");
  });

  it("splits two colliding GTFS-RT buckets by their headsigns, unchanged", async () => {
    const { fetch } = protobufFetch(
      gtfsRtBody([
        { at: 1790608500000, headsign: "KEELE" },
        { at: 1790609100000, headsign: "KEELE" },
        { at: 1790609700000, headsign: "BLOOR WEST" },
      ]),
    );
    const cards = await Effect.runPromise(stationsWith(fetch).fetchByIds({ stationIds: ["1000"] }));

    // Different headsigns in one direction family → two rows, each labelled by
    // its terminal and ordered by departure time. The pre-existing collision
    // rule, untouched.
    const labels = cards.flatMap((card) => card.arrivals.map((row) => row.label));
    expect(labels).toEqual([
      expect.stringContaining("KEELE"),
      expect.stringContaining("BLOOR WEST"),
    ]);
  });
});

describe("Tmix AnyRide duplicate vehicle fixes", () => {
  const SHARED_FIX = {
    timestamp: "2026-10-14T23:03:47Z",
    heading: 90,
    location: { lat: 44.5, lon: -80.1 },
  };

  /** Two calls name one bus (current trip 1, next trip 2) and a third call is a different bus. */
  function twoCallsOneBus(overrides: { readonly nextFix?: Record<string, unknown> } = {}) {
    const calls = [
      wireCall({
        id: "543231052",
        key: "0",
        departure: { forecastTime: "2026-10-14T19:41:00-04:00" },
      }),
      wireCall({
        id: "543231002",
        key: "1",
        departure: { forecastTime: "2026-10-14T20:41:00-04:00" },
      }),
      wireCall({
        id: "543231100",
        key: "2",
        departure: { forecastTime: "2026-10-14T19:55:00-04:00" },
      }),
    ];
    const fixes: Record<string, Record<string, unknown>> = {
      "543231052": { id: "543231052", ...SHARED_FIX },
      "543231002": { id: "543231002", ...SHARED_FIX, ...overrides.nextFix },
      "543231100": { id: "543231100", ...SHARED_FIX, location: { lat: 44.6, lon: -80.2 } },
    };
    return routeFetch((url) => {
      if (url.includes("/GetVehiclePosition?")) {
        const callId = new URL(url).searchParams.get("callId") ?? "";
        return new Response(JSON.stringify(fixes[callId] ?? null), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          isStopCancelled: false,
          calls: calls.map((call) => ({ id: `g:${String(call.id)}`, calls: [call] })),
          messages: [],
        }),
        { status: 200 },
      );
    }).fetch;
  }

  const realtime = (stubFetch: typeof globalThis.fetch, collapse: boolean) =>
    createGenericGtfsRealtimeSource({
      agencyId: "milton",
      feeds: [{ ...miltonFeed, ...(collapse ? { duplicateVehicleFixes: "collapse-by-fix" } : {}) }],
      fetch: stubFetch,
      now: () => Date.parse("2026-10-14T23:04:00Z"),
    });

  const vehicleIds = async (stubFetch: typeof globalThis.fetch, collapse: boolean) =>
    (await Effect.runPromise(realtime(stubFetch, collapse).fetchRealtime(topology))).vehicles
      .map((vehicle) => vehicle.vehicleId)
      .sort();

  it("keeps the earliest-departing call when two calls report a byte-identical fix", async () => {
    expect(await vehicleIds(twoCallsOneBus(), true)).toEqual(["543231052", "543231100"]);
  });

  it("keeps every call when the feed does not opt in", async () => {
    expect(await vehicleIds(twoCallsOneBus(), false)).toEqual([
      "543231002",
      "543231052",
      "543231100",
    ]);
  });

  it("never merges two buses whose fixes differ, however close", async () => {
    const nearby = twoCallsOneBus({ nextFix: { location: { lat: 44.5, lon: -80.100001 } } });

    expect(await vehicleIds(nearby, true)).toEqual(["543231002", "543231052", "543231100"]);
  });

  it("keeps overlapping-prefix feeds isolated and honors duplicate-collapse per originating feed", async () => {
    const callsFor = (prefix: string) =>
      callsBody([
        wireCall({
          id: prefix + "-current",
          departure: { forecastTime: "2026-10-14T19:41:00-04:00" },
        }),
        wireCall({
          id: prefix + "-next",
          departure: { forecastTime: "2026-10-14T20:41:00-04:00" },
        }),
        wireCall({
          id: prefix + "-other",
          departure: { forecastTime: "2026-10-14T19:55:00-04:00" },
        }),
      ]);
    const feedA = {
      ...miltonFeed,
      duplicateVehicleFixes: "collapse-by-fix" as const,
    };
    const feedB = {
      ...miltonFeed,
      url: "https://another.anyride.example.test/api",
    };
    const fixes = (callId: string) => {
      const duplicate = callId.endsWith("-current") || callId.endsWith("-next");
      return wirePosition({
        id: callId,
        location: duplicate ? { lat: 44.5, lon: -80.1 } : { lat: 44.6, lon: -80.2 },
      });
    };
    const { fetch } = routeFetch((url) => {
      const prefix = url.includes("another.anyride") ? "B" : "A";
      if (url.includes("/GetVehiclePosition?")) {
        const callId = new URL(url).searchParams.get("callId") ?? "";
        return new Response(fixes(callId));
      }
      return new Response(callsFor(prefix));
    });
    const snapshot = await Effect.runPromise(
      createGenericGtfsRealtimeSource({
        agencyId: "milton",
        feeds: [feedA, feedB],
        fetch,
        now: () => Date.parse("2026-10-14T23:04:00Z"),
      }).fetchRealtime(topology),
    );

    expect(snapshot.vehicles.map((vehicle) => vehicle.vehicleId).sort()).toEqual([
      "A-current",
      "A-other",
      "B-current",
      "B-next",
      "B-other",
    ]);
  });
});

describe("vendor route labels on a shared schematic corridor", () => {
  it("keeps departures from both canonical routes on the corridor card", async () => {
    const getTripTerminals = vi.fn((_routeId: string, _tripIds: readonly string[]) => Effect.succeed(new Map()));
    const getDirectionsForTrips = vi.fn((_routeId: string, _tripIds: readonly string[]) => Effect.succeed(new Map()));
    const source = createGenericStationsSource({
      getTripTerminals, getDirectionsForTrips,
      agencyId: "fictional-transit",
      stations: [{ id: "hub", name: "Hub", lat: 43, lon: -79, lines: ["corridor"],
        platformIds: ["platform"], departureRouteIds: ["41", "42"] }],
      feeds: [{ kind: "tmix_anyride", url: "https://vendor.example/api", format: "json", operatorPrefix: "88" }],
      routeLineMap: { "Vendor outbound": "41", "Vendor inbound": "42", "41": "corridor", "42": "corridor" },
      routeType: "bus",
      now: () => Date.parse("2026-09-28T15:12:00Z"),
      fetch: (async () => new Response(callsBody([
        wireCall({ id: "outbound", lineId: 8800041, line: "Vendor outbound", destination: "North Terminal", departure: { forecastTime: "2026-09-28T11:40:00-04:00", quality: "realtime" } }),
        wireCall({ id: "inbound", lineId: 8800042, line: "Vendor inbound", destination: "South Terminal", departure: { forecastTime: "2026-09-28T11:45:00-04:00", quality: "realtime" } }),
      ]))) as typeof fetch,
    });
    const cards = await Effect.runPromise(source.fetchByIds({ stationIds: ["hub"] }));
    expect(getTripTerminals.mock.calls.map(call => call[0])).toEqual(["41", "42"]);
    expect(getDirectionsForTrips.mock.calls.map(call => call[0])).toEqual(["41", "42"]);
    expect(cards.flatMap(card => card.arrivals.map(row => row.label))).toEqual([
      expect.stringContaining("North Terminal"), expect.stringContaining("South Terminal"),
    ]);
  });
});
