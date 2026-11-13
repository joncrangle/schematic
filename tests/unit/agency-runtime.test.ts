import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

import { makeTestProvider } from "../helpers/agency-fixtures";
import { makeRequestScopedEffectCache } from "~/domain/requestScopedEffectCache";
import {
  AgencyCapabilityError,
  createAgencyRuntime,
  hasAgencyCapability,
} from "~/services/AgencyRuntime";
import type { AgencyProvider } from "~/agencies/types";
import type { UiLocale } from "~/domain/locale";
import type { RealtimeSource } from "~/domain/surface/realtimeSource";
import type { StationsSource } from "~/domain/surface/stationsSource";
import type { TopologySource } from "~/domain/surface/topologySource";
import { encodeFeed } from "../helpers/gtfs-rt-binary";

function provider(overrides: Partial<AgencyProvider> = {}): AgencyProvider {
  return {
    manifest: { id: "test-agency" },
    staticTopology: {},
    ...overrides,
  } as AgencyProvider;
}

const context = {
  fetch: vi.fn() as unknown as typeof fetch,
  now: () => 123,
};

describe("AgencyRuntime", () => {
  it("discovers capabilities centrally and lazily memoizes each source", () => {
    const source = {} as RealtimeSource;
    const createRealtimeSource = vi.fn(() => source);
    const runtime = createAgencyRuntime(provider({ createRealtimeSource }), context);

    expect(hasAgencyCapability(runtime.provider, "realtime")).toBe(true);
    expect(runtime.hasRealtime).toBe(true);
    expect(createRealtimeSource).not.toHaveBeenCalled();
    expect(runtime.getRealtimeSource()).toBe(source);
    expect(runtime.getRealtimeSource()).toBe(source);
    expect(createRealtimeSource).toHaveBeenCalledOnce();
  });

  it("rejects missing capabilities explicitly when invoked", async () => {
    const runtime = createAgencyRuntime(provider(), context);

    await expect(runtime.getSnapshot()).rejects.toMatchObject({
      _tag: "AgencyCapabilityError",
      agencyId: "test-agency",
      capability: "snapshot",
    });
    expect(() => runtime.getRealtimeSource()).toThrow(AgencyCapabilityError);
  });

  it("passes the configured or requested UI locale to the snapshot provider", async () => {
    const passedLocales: string[] = [];
    const snapshotValue = {
      agencyId: "test-agency",
      generatedAt: 123,
      freshness: "unavailable" as const,
      alerts: [],
    };
    const snapshotProvider = provider({
      manifest: { id: "test-agency", locale: "en-CA" } as AgencyProvider["manifest"],
      snapshot: {
        get: vi.fn(async (ctx) => {
          if (ctx.locale) passedLocales.push(ctx.locale);
          return snapshotValue;
        }),
      },
    });
    const runtime = createAgencyRuntime(snapshotProvider, { ...context, locale: "fr-CA" });

    await runtime.getSnapshot();
    await runtime.getSnapshot("en-CA");

    expect(passedLocales).toEqual(["fr-CA", "en-CA"]);
  });

  it("does not construct topology without an injected D1 binding", () => {
    const createTopologySource = vi.fn();
    const runtime = createAgencyRuntime(provider({ createTopologySource }), context);

    expect(() => runtime.getTopologySource()).toThrowError(
      'Agency "test-agency" has no injected D1 binding',
    );
    expect(createTopologySource).not.toHaveBeenCalled();
  });

  it("constructs and memoizes the topology source with its runtime context", () => {
    const source = {} as TopologySource;
    const createTopologySource = vi.fn(() => source);
    const d1 = {};
    const getSecret = vi.fn(() => undefined);
    const now = vi.fn(() => 456);
    const runtimeContext = {
      ...context,
      d1,
      now,
      getSecret,
      devProxyOrigin: "https://dev-proxy.example.test",
    };
    const runtime = createAgencyRuntime(
      { ...makeTestProvider({ id: "topology-sample" }), createTopologySource },
      runtimeContext,
    );

    expect(runtime.getTopologySource()).toBe(source);
    expect(runtime.getTopologySource()).toBe(source);
    expect(createTopologySource).toHaveBeenCalledOnce();
    expect(createTopologySource).toHaveBeenCalledWith({
      d1,
      fetch: context.fetch,
      now,
      getSecret,
      devProxyOrigin: "https://dev-proxy.example.test",
    });
  });

  it("forwards station-source dependencies once and reuses the source", () => {
    const source = {} as StationsSource;
    const createStationsSource = vi.fn(() => source);
    const getRoutesForTrips = vi.fn();
    const getTripTerminals = vi.fn();
    const getDirectionsForTrips = vi.fn();
    const getSecret = vi.fn(() => undefined);
    const now = vi.fn(() => 789);
    const runtimeContext = {
      ...context,
      locale: "fr-CA" as const,
      now,
      getRoutesForTrips,
      getTripTerminals,
      getDirectionsForTrips,
      getSecret,
      devProxyOrigin: "https://dev-proxy.example.test",
    };
    const runtime = createAgencyRuntime(
      { ...makeTestProvider({ id: "stations-sample" }), createStationsSource },
      runtimeContext,
    );

    expect(runtime.getStationsSource()).toBe(source);
    expect(runtime.getStationsSource()).toBe(source);
    expect(createStationsSource).toHaveBeenCalledOnce();
    expect(createStationsSource).toHaveBeenCalledWith({
      getRoutesForTrips,
      getTripTerminals,
      getDirectionsForTrips,
      locale: "fr-CA",
      fetch: context.fetch,
      now,
      getSecret,
      devProxyOrigin: "https://dev-proxy.example.test",
    });
  });

  it("forwards alert filters and caches, and falls back from an unsupported locale", async () => {
    const snapshot = {
      agencyId: "snapshot-sample",
      generatedAt: 123,
      freshness: "unavailable" as const,
      alerts: [],
    };
    const get = vi.fn(async () => snapshot);
    const providerFixture = {
      ...makeTestProvider({ id: "snapshot-sample", locale: "en-CA" }),
      snapshot: { get },
    };
    const requestCache = await Effect.runPromise(makeRequestScopedEffectCache());
    const contextRequestCache = await Effect.runPromise(makeRequestScopedEffectCache());
    const alertConditionalCache = Object.create(null) as Cache;
    const runtime = createAgencyRuntime(providerFixture, {
      ...context,
      locale: "fr-CA",
      requestCache: contextRequestCache,
      alertSourceTypes: ["gtfs-rt"],
      alertConditionalCache,
    });

    await runtime.getSnapshot("xx-YY" as unknown as UiLocale);
    await runtime.getSnapshot("en-CA", requestCache);

    expect(get).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        locale: "fr-CA",
        alertSourceTypes: ["gtfs-rt"],
        alertConditionalCache,
        requestCache: contextRequestCache,
      }),
    );
    expect(get).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        locale: "en-CA",
        alertSourceTypes: ["gtfs-rt"],
        alertConditionalCache,
        requestCache,
      }),
    );
  });
});

describe("AgencyRuntime secret injection", () => {
  it("injects getSecret into createRealtimeSource so feed fetches resolve secrets", async () => {
    const mockGetSecret = vi.fn((name: string) =>
      name === "FEED_API_KEY" ? "injected-key" : undefined,
    );
    const emptyFeedBytes = encodeFeed(Math.floor(Date.now() / 1000), []);
    const calls: string[] = [];
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(new Uint8Array(emptyFeedBytes), { status: 200 });
    }) as unknown as typeof fetch;

    const providerFixture = makeTestProvider({
      id: "regional",
      realtime: {
        feeds: [
          {
            kind: "vehicle_positions",
            url: "https://example.test/vehicles",
            format: "protobuf",
            auth: { type: "query_param", parameterName: "key", secretName: "FEED_API_KEY" },
          },
          {
            kind: "trip_updates",
            url: "https://example.test/trips",
            format: "protobuf",
            auth: { type: "query_param", parameterName: "key", secretName: "FEED_API_KEY" },
          },
        ],
      },
    });
    expect(providerFixture).toBeDefined();
    const runtime = createAgencyRuntime(providerFixture!, {
      fetch: mockFetch,
      now: Date.now,
      getSecret: mockGetSecret,
    });

    await Effect.runPromise(
      runtime
        .getRealtimeSource()
        .fetchRealtime({ agencyId: "regional", generatedAt: Date.now(), routes: [] }),
    );

    expect(mockGetSecret).toHaveBeenCalledWith("FEED_API_KEY");
    expect(calls).toEqual(
      expect.arrayContaining([
        "https://example.test/vehicles?key=injected-key",
        "https://example.test/trips?key=injected-key",
      ]),
    );
  });
});
