import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { AlertSource, AnyRideProfile } from "~/agencies/types";
import { fetchAgencyAlerts } from "~/infrastructure/realtime/fetchAgencyAlerts";
import { parseTmixStopResponse } from "~/infrastructure/realtime/tmix/tmixCallsDecoder";
import { buildTmixMessageFeed } from "~/infrastructure/realtime/tmix/tmixMessageAlerts";
import { fetchStopCalls } from "~/infrastructure/realtime/tmix/tmixRealtimeSource";
import { tmixStopPollKey } from "~/infrastructure/realtime/tmix/tmixStopPollCache";
import {
  makeRequestScopedEffectCache,
  type RequestScopedEffectCache,
} from "~/domain/requestScopedEffectCache";
import { TMIX_MAX_SUBREQUESTS } from "~/infrastructure/realtime/tmix/tmixRealtimeSource";
import contract from "../fixtures/realtime/tmix/messages.contract.json";

/**
 * Fictional tenant: the adapter is generic, so nothing here names an operator.
 * The wire shapes come from the AnyRide `GetCalls` capture contract.
 */
const BASE_URL = "https://anyride.example.test/api";
const NOW = Date.parse("2026-10-14T20:00:00Z");
const DETOUR = "Route A detour for the morning trip due to construction.";
const PROFILE: AnyRideProfile = { data: "tenant_data", display: "tenant" };

const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));

describe("AnyRide message alert contract (shared with the alert-feed daemon)", () => {
  it.each(contract.map((entry) => [entry.name, entry] as const))("%s", (_name, entry) => {
    const outcomes = entry.polls.map((poll) =>
      "failed" in poll && poll.failed
        ? undefined
        : parseTmixStopResponse(encode(poll.body), { strictAlertEnvelope: true }),
    );
    const feed = buildTmixMessageFeed(entry.stops, outcomes, {
      operatorPrefix: entry.operatorPrefix,
      now: entry.now,
    });
    expect(feed ?? null).toEqual(entry.expected);
  });
});

const stopSource = (overrides: Partial<Extract<AlertSource, { type: "anyride-messages" }>> = {}) =>
  ({
    type: "anyride-messages",
    url: BASE_URL,
    operatorPrefix: "70",
    profile: PROFILE,
    stops: [
      { stopId: "S1", routeIds: ["A"] },
      { stopId: "S2", routeIds: ["A", "B"] },
    ],
    ...overrides,
  }) satisfies AlertSource;

const wireBody = (messages: unknown[], calls: unknown[] = []) =>
  JSON.stringify({ isStopCancelled: false, calls, messages });

const wireMessage = (overrides: Record<string, unknown> = {}) => ({
  id: "TX100",
  text: DETOUR,
  priority: 100,
  isDisturbance: false,
  isInfo: true,
  affectedCalls: [],
  ...overrides,
});

/** Answers each GetCalls POST from the stop named in its body. */
function anyRideFetch(
  bodyFor: (stopId: string) => Response,
): ReturnType<typeof vi.fn<typeof globalThis.fetch>> {
  return vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const query = JSON.parse(String(init?.body)) as { query: { fromStopAreaQuery: string } };
    return bodyFor(query.query.fromStopAreaQuery);
  });
}

const rules = [
  {
    priority: 200,
    match: { sourceField: "isDisturbance", sourceValue: true },
    result: { kind: "delay" as const, severity: "degraded" as const },
  },
  {
    priority: 100,
    match: { textIncludes: ["detour"] },
    result: {
      kind: "delay" as const,
      severity: "degraded" as const,
      serviceChange: "detour" as const,
    },
  },
];

function readAlerts(
  fetch: typeof globalThis.fetch,
  source: AlertSource,
  interpretation?: { rules?: typeof rules },
  options?: {
    readonly requestCache?: RequestScopedEffectCache;
    readonly getSecret?: (name: string) => string | undefined;
  },
) {
  return Effect.runPromise(
    fetchAgencyAlerts({
      agencyId: "fictional-transit",
      sources: [source],
      fetch,
      now: () => NOW,
      timeZone: "America/Toronto",
      hostingTarget: "self-hosted",
      requestCache: options?.requestCache,
      getSecret: options?.getSecret,
      manifest: { alertInterpretation: { lineIds: ["A", "B"], ...interpretation } },
    }),
  );
}

describe("AnyRide message alert source", () => {
  it("shares the forty-poll budget across direct alert sources and marks short reads stale", async () => {
    const sources = ["first", "second"].map((sourceName) =>
      stopSource({
        url: `${BASE_URL}/${sourceName}`,
        stops: Array.from({ length: 30 }, (_, index) => ({
          stopId: `${sourceName}-${index}`,
          routeIds: ["A"],
        })),
      }),
    );
    const fetch = anyRideFetch(() => new Response(wireBody([])));

    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "fictional-transit",
        sources,
        fetch,
        now: () => NOW,
        timeZone: "America/Toronto",
        hostingTarget: "self-hosted",
        manifest: { alertInterpretation: { lineIds: ["A"] } },
      }),
    );

    expect(fetch).toHaveBeenCalledTimes(TMIX_MAX_SUBREQUESTS);
    expect(snapshot.freshness).toBe("stale");
  });

  it.each([{}, { error: "challenge" }, { calls: [], messages: [{}] }])(
    "treats an unreadable 200 alert envelope as a partial read: %j",
    async (body) => {
      const fetch = anyRideFetch((stopId) =>
        stopId === "S2" ? new Response(JSON.stringify(body)) : new Response(wireBody([])),
      );
      const snapshot = await readAlerts(fetch, stopSource());

      expect(snapshot.alerts).toEqual([]);
      expect(snapshot.freshness).toBe("stale");
    },
  );

  it("polls each stop with the declared profile and scopes the alert to the queried GTFS stops", async () => {
    const fetch = anyRideFetch(() => new Response(wireBody([wireMessage()])));
    const snapshot = await readAlerts(fetch, stopSource());

    expect(fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).query)).toEqual([
      { fromStopAreaQuery: "S1" },
      { fromStopAreaQuery: "S2" },
    ]);
    const headers = new Headers(fetch.mock.calls[0]![1]?.headers);
    expect(headers.get("anyride-profile-data")).toBe("tenant_data");
    expect(headers.get("anyride-profile-display")).toBe("tenant");
    expect(snapshot.alerts).toHaveLength(1);
    expect(snapshot.alerts[0]).toMatchObject({
      id: "TX100",
      title: DETOUR,
      lifecycle: "active",
      scope: "station",
      endsAt: undefined,
      affectedRouteIds: ["A", "B"],
    });
    expect(snapshot.alerts[0]!.targets?.map((target) => target.routeId)).toEqual(["A", "A", "B"]);
  });

  it("classifies an info-flagged message as information unless a declared rule says more", async () => {
    const fetch = anyRideFetch(
      () => new Response(wireBody([wireMessage({ text: "Stop moved." })])),
    );
    const snapshot = await readAlerts(fetch, stopSource(), { rules });

    expect(snapshot.alerts[0]).toMatchObject({ kind: "information", severity: "normal" });
    expect(snapshot.alerts[0]!.title).toBe("Stop moved.");
  });

  it("raises a disturbance to degraded and a service-change text to a detour", async () => {
    const disturbance = await readAlerts(
      anyRideFetch(
        () => new Response(wireBody([wireMessage({ text: "Late.", isDisturbance: true })])),
      ),
      stopSource(),
      { rules },
    );
    expect(disturbance.alerts[0]).toMatchObject({ kind: "delay", severity: "degraded" });

    const detour = await readAlerts(
      anyRideFetch(() => new Response(wireBody([wireMessage()]))),
      stopSource(),
      { rules },
    );
    expect(detour.alerts[0]).toMatchObject({ severity: "degraded", serviceChange: "detour" });
  });

  it("attributes the route from the calls a message names, and falls back to the stop's routes", async () => {
    const call = {
      id: "9001",
      key: "0",
      lineId: 7000002,
      line: "B",
      departure: { forecastTime: "2026-10-14T16:10:00-04:00" },
    };
    const fetch = anyRideFetch((stopId) =>
      stopId === "S1"
        ? new Response(wireBody([wireMessage({ affectedCalls: ["0"] })], [call]))
        : new Response(wireBody([])),
    );
    const snapshot = await readAlerts(fetch, stopSource());

    expect(snapshot.alerts[0]!.affectedRouteIds).toEqual(["B"]);
  });

  it("ends an alert as soon as a complete poll stops returning its id", async () => {
    let present = true;
    const fetch = anyRideFetch(() => new Response(wireBody(present ? [wireMessage()] : [])));
    expect((await readAlerts(fetch, stopSource())).alerts).toHaveLength(1);

    present = false;
    const after = await readAlerts(fetch, stopSource());
    expect(after.alerts).toEqual([]);
    expect(after.freshness).toBe("live");
  });

  it("reports a stale source, never an all-clear, when one stop fails", async () => {
    const fetch = anyRideFetch((stopId) =>
      stopId === "S2" ? new Response("upstream down", { status: 503 }) : new Response(wireBody([])),
    );
    const snapshot = await readAlerts(fetch, stopSource());

    expect(snapshot.alerts).toEqual([]);
    expect(snapshot.freshness).toBe("stale");
  });

  it("keeps the alerts it did read when a later stop fails", async () => {
    const fetch = anyRideFetch((stopId) =>
      stopId === "S2"
        ? new Response("upstream down", { status: 503 })
        : new Response(wireBody([wireMessage()])),
    );
    const snapshot = await readAlerts(fetch, stopSource());

    expect(snapshot.alerts.map((alert) => alert.id)).toEqual(["TX100"]);
    expect(snapshot.freshness).toBe("stale");
  });

  it("treats a zero-byte unknown-stop answer as incomplete, not as an empty stop", async () => {
    const fetch = anyRideFetch((stopId) =>
      stopId === "S2" ? new Response(null, { status: 204 }) : new Response(wireBody([])),
    );
    expect((await readAlerts(fetch, stopSource())).freshness).toBe("stale");
  });

  it("fails the source when no stop can be read", async () => {
    const fetch = anyRideFetch(() => new Response("down", { status: 500 }));

    await expect(readAlerts(fetch, stopSource())).rejects.toMatchObject({
      _tag: "AlertFetchError",
    });
  });

  it("stays inside the shared subrequest budget and reports the unpolled stops as incomplete", async () => {
    const stops = Array.from({ length: TMIX_MAX_SUBREQUESTS + 5 }, (_value, index) => ({
      stopId: `S${index}`,
      routeIds: ["A"],
    }));
    const fetch = anyRideFetch(() => new Response(wireBody([])));
    const snapshot = await readAlerts(fetch, stopSource({ stops }));

    expect(fetch).toHaveBeenCalledTimes(TMIX_MAX_SUBREQUESTS);
    expect(snapshot.freshness).toBe("stale");
  });

  it("reuses a stop the realtime source just polled instead of spending the budget again", async () => {
    const fetch = anyRideFetch(() => new Response(wireBody([wireMessage()])));
    const requestCache = await Effect.runPromise(makeRequestScopedEffectCache());
    await Effect.runPromise(
      fetchStopCalls(
        {
          kind: "tmix_anyride",
          url: BASE_URL,
          format: "json",
          operatorPrefix: "70",
          profile: PROFILE,
        },
        "S1",
        { fetch, requestCache },
      ),
    );
    expect(fetch).toHaveBeenCalledTimes(1);

    const snapshot = await readAlerts(fetch, stopSource(), undefined, { requestCache });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(snapshot.alerts.map((alert) => alert.id)).toEqual(["TX100"]);
  });

  it("does not treat a lenient realtime parse of an unknown envelope as an alert all-clear", async () => {
    const fetch = anyRideFetch((stopId) =>
      stopId === "S1" ? new Response("{}") : new Response(wireBody([])),
    );
    const requestCache = await Effect.runPromise(makeRequestScopedEffectCache());
    const realtime = await Effect.runPromise(
      fetchStopCalls(
        {
          kind: "tmix_anyride",
          url: BASE_URL,
          format: "json",
          operatorPrefix: "70",
          profile: PROFILE,
        },
        "S1",
        { fetch, requestCache },
      ),
    );

    expect(realtime.usable[0]?.alertEnvelopeValid).toBe(false);
    const snapshot = await readAlerts(fetch, stopSource(), undefined, { requestCache });

    expect(snapshot.alerts).toEqual([]);
    expect(snapshot.freshness).toBe("stale");
    // The invalid response is fetched again for S1; S2 is read normally.
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not share a poll across profiles, which change the answer", async () => {
    const fetch = anyRideFetch(() => new Response(wireBody([wireMessage()])));
    const requestCache = await Effect.runPromise(makeRequestScopedEffectCache());
    await readAlerts(fetch, stopSource({ stops: [{ stopId: "S1", routeIds: ["A"] }] }), undefined, {
      requestCache,
    });
    await readAlerts(
      fetch,
      stopSource({ profile: { data: "other_data" }, stops: [{ stopId: "S1", routeIds: ["A"] }] }),
      undefined,
      { requestCache },
    );

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("normalizes an omitted realtime format to the transport's JSON default", () => {
    const source = { url: BASE_URL, profile: PROFILE };
    expect(tmixStopPollKey(source, "S1")).toBe(
      tmixStopPollKey({ ...source, format: "json" }, "S1"),
    );
  });

  it("does not share a poll across different authentication declarations", async () => {
    const fetch = anyRideFetch(() => new Response(wireBody([])));
    const requestCache = await Effect.runPromise(makeRequestScopedEffectCache());
    const source = (secretName: string) =>
      stopSource({
        stops: [{ stopId: "S1", routeIds: ["A"] }],
        auth: { type: "header", headerName: "X-Api-Key", secretName },
      });
    const options = { requestCache, getSecret: () => "same-secret" };

    await readAlerts(fetch, source("FEED_FIRST_KEY"), undefined, options);
    await readAlerts(fetch, source("FEED_SECOND_KEY"), undefined, options);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not cache the zero-byte unknown-stop sentinel", async () => {
    const fetch = anyRideFetch((stopId) =>
      stopId === "missing" ? new Response(null, { status: 204 }) : new Response(wireBody([])),
    );
    const requestCache = await Effect.runPromise(makeRequestScopedEffectCache());
    const source = stopSource({
      stops: [
        { stopId: "missing", routeIds: ["A"] },
        { stopId: "valid", routeIds: ["A"] },
      ],
    });

    await readAlerts(fetch, source, undefined, { requestCache });
    await readAlerts(fetch, source, undefined, { requestCache });

    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("AnyRide message alerts relayed by the alert-feed daemon", () => {
  const relaySource = {
    type: "anyride-messages",
    url: "https://alerts.example.test/fictional.json",
    relay: "daemon-document",
  } satisfies AlertSource;

  const relayFeed = (partial?: true) => ({
    header: { version: "anyride-messages", timestamp: NOW },
    tripUpdates: [],
    vehiclePositions: [],
    alerts: [
      {
        id: "TX100",
        title: DETOUR,
        startsAt: 0,
        updatedAt: NOW,
        routeIds: ["A"],
        targets: [{ routeId: "A", stopId: "S1" }],
        sourceFields: { isDisturbance: false, isInfo: true, priority: 100 },
      },
    ],
    ...(partial ? { partial } : {}),
  });

  it("serves the daemon's feed through the same interpretation rules", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(JSON.stringify(relayFeed())),
    );
    const snapshot = await readAlerts(fetch, relaySource, { rules });

    expect(snapshot.alerts[0]).toMatchObject({ id: "TX100", severity: "degraded" });
    expect(snapshot.freshness).toBe("live");
  });

  it.each([
    ["the feed says it is partial", () => new Response(JSON.stringify(relayFeed(true)))],
    [
      "the daemon marks the response stale",
      () => new Response(JSON.stringify(relayFeed()), { headers: { Warning: '110 - "Stale"' } }),
    ],
  ])("is stale when %s", async (_label, respond) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => respond());
    expect((await readAlerts(fetch, relaySource)).freshness).toBe("stale");
  });
});
