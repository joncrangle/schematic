vi.mock("~/agencies/agencyCatalog", async () => {
  const { testAgencyCatalog } = await import("../helpers/agency-fixtures");
  return { agencyCatalog: testAgencyCatalog };
});
// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { Context, Effect, Layer, Option } from "effect";

/**
 * Per-endpoint RPC seams: the shared runRpc runtime contract (context
 * fetched once, program provided ctx, duration logged under label, failures
 * reject) lives canonically in tests/unit/run-rpc.test.ts, so this file only
 * pins endpoint-specific facts — validator throwing behavior and short-circuit
 * logic. Snapshot cache semantics live canonically in
 * tests/unit/snapshot-cache.test.ts and tests/unit/snapshot-endpoint.test.ts.
 */

import { parseRouteTrackingInput, parseSavedTransitInput } from "~/services/surface/SurfaceClient";
import { handleFetchRoutesMetadata } from "~/services/surface/SurfaceServer";
import {
  SurfaceDataStore,
  type SurfaceDataStoreService,
} from "~/infrastructure/storage/SurfaceDataStore";
import { NearbyTransit } from "~/services/surface/NearbyTransit";
import { parseStationDeparturesInput } from "~/services/StationsClient";
import {
  buildStationsSourceLayer,
  handleFetchNearbyStations,
  handleFetchSavedStations,
  handleFetchStationDepartures,
  StationsSource,
} from "~/services/StationsServer";
import { parseNearbyRpcInput } from "~/services/nearby/rpcInput";
import * as agencies from "~/agencies";
import { createSwrFeedCache } from "~/infrastructure/realtime/swrFeedCache";
import { encodeFeed } from "../helpers/gtfs-rt-binary";

describe("SurfaceClient validators", () => {
  it("normalizes supported locale tags at public request boundaries", () => {
    expect(
      parseNearbyRpcInput({ agencyId: "sample", lat: 43.65, lon: -79.38, locale: "fr-FR" }).locale,
    ).toBe("fr-CA");
    expect(
      parseSavedTransitInput({ agencyId: "sample", favouriteRoutes: [], locale: "fr" }).locale,
    ).toBe("fr-CA");
    expect(parseRouteTrackingInput({ agencyId: "sample", routeId: "97" }).locale).toBeUndefined();
  });

  it("route-tracking validator keeps throwing on a missing routeId", () => {
    expect(() => parseRouteTrackingInput({ agencyId: "sample", routeId: "" })).toThrow();
  });

  it("route-tracking validator throws on a missing agencyId", () => {
    expect(() => parseRouteTrackingInput({ routeId: "97" } as never)).toThrow(/agencyId/);
  });
});

describe("SurfaceClient route metadata", () => {
  it("serves route metadata through the canonical read path on repeated requests", async () => {
    const getRoute = vi.fn(() =>
      Effect.succeed(
        Option.some({
          id: "97",
          shortName: "97",
          longName: "Yonge",
          routeType: "bus" as const,
          color: "#da251d",
          textColor: "#ffffff",
        }),
      ),
    );
    const store = {
      findNearbyStops: () => Effect.succeed([]),
      getTripTerminals: () => Effect.succeed(new Map()),
      getDirectionsForTrips: () => Effect.succeed(new Map<string, number>()),
      getRouteDirectionIds: () => Effect.succeed([0]),
      getRouteDetails: () => Effect.succeed(Option.none()),
      getRoute,
      getAllRoutes: () => Effect.succeed([]),
      getStopsForRoutes: () => Effect.succeed([]),
      getStopsByIds: () => Effect.succeed([]),
    } satisfies SurfaceDataStoreService;

    const getContext = () =>
      Promise.resolve(
        Context.make(SurfaceDataStore, store).pipe(
          Context.add(
            NearbyTransit,
            NearbyTransit.of({
              getNearbyTransit: () => Effect.succeed([]),
              getSavedTransit: () => Effect.succeed([]),
              getRouteTracking: () => Effect.succeed(Option.none()),
            }),
          ),
        ),
      );
    const expected = [{ id: "97", shortName: "97", longName: "Yonge", routeType: "bus" }];

    expect(
      await handleFetchRoutesMetadata({ agencyId: "sample", routeIds: ["97"] }, getContext),
    ).toEqual(expected);
    // A second request resolves identically through the same canonical read:
    // metadata reads are write-free, never a topology fetch or persist.
    expect(
      await handleFetchRoutesMetadata({ agencyId: "sample", routeIds: ["97"] }, getContext),
    ).toEqual(expected);
  });
});

describe("StationsClient short-circuit logic", () => {
  it("fetchSavedStations short-circuits empty favourites before touching the feed", async () => {
    const getContext = vi.fn(() => Promise.reject(new Error("feed must not be reached")));

    const result = await handleFetchSavedStations(
      { agencyId: "sample", stationNames: [], lat: undefined, lon: undefined },
      getContext,
    );

    expect(result).toEqual([]);
    expect(getContext).not.toHaveBeenCalled();
  });

  it("station-departures validator requires agencyId and stationId", () => {
    expect(() => parseStationDeparturesInput({ agencyId: "sample" })).toThrow(/stationId/);
    expect(() => parseStationDeparturesInput({ stationId: "union" })).toThrow(/agencyId/);
    expect(() => parseStationDeparturesInput({ agencyId: "sample", stationId: "  " })).toThrow(
      /stationId/,
    );
  });

  it("station-departures validator trims the station id", () => {
    expect(parseStationDeparturesInput({ agencyId: "sample", stationId: "  union  " })).toEqual({
      agencyId: "sample",
      stationId: "union",
    });
  });

  it("station-departures validator normalizes locale tags", () => {
    expect(
      parseStationDeparturesInput({ agencyId: "sample", stationId: "union", locale: "fr-FR" })
        .locale,
    ).toBe("fr-CA");
  });

  it("fetchStationDepartures answers schematic ids through the stations port", async () => {
    const card = {
      id: "UN",
      stationName: "Union",
      lineIds: ["LW"],
      agencyId: "regional",
      distanceMeters: 0,
      walkingMinutes: 0,
      arrivals: [],
    };
    const fetchByIds = vi.fn(() => Effect.succeed([card]));
    const getContext = () =>
      Promise.resolve(
        Context.make(StationsSource, {
          fetchNearby: () => Effect.succeed([]),
          fetchSaved: () => Effect.succeed([]),
          fetchByIds,
        } as never),
      );

    const result = await handleFetchStationDepartures(
      { agencyId: "regional", stationIds: ["union-schematic"] },
      getContext,
    );

    expect(result).toEqual([card]);
    expect(fetchByIds).toHaveBeenCalledWith({
      stationIds: ["union-schematic"],
      lat: undefined,
      lon: undefined,
    });
  });
});

describe("StationsSource resolution", () => {
  it("keeps the Worker fetch receiver bound for station feed requests", async () => {
    const fetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError("detached fetch");
      const bytes = encodeFeed(Math.floor(Date.now() / 1_000), []);
      const body = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(body).set(bytes);
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as unknown as typeof globalThis.fetch;
    vi.stubGlobal("fetch", fetch);

    try {
      const ctx = await Effect.runPromise(
        Effect.scoped(Layer.build(buildStationsSourceLayer("sample"))),
      );
      const stations = await handleFetchNearbyStations(
        { agencyId: "sample", lat: 43.5, lon: -79.5, radius: 1_500 },
        () => Promise.resolve(ctx),
      );

      expect(fetch).toHaveBeenCalledOnce();
      expect(stations.length).toBeGreaterThan(0);
      expect(stations.every((station) => station.arrivalsStale !== true)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses a provider without a stations source instead of serving empty", async () => {
    const mockProvider = {
      manifest: {
        id: "sample-bus",
        name: "Sample Bus",
        locale: "en-CA",
        timezone: "America/Toronto",
        bounds: [{ minLat: 43, maxLat: 44, minLon: -79, maxLon: -78 }],
        modes: ["bus"],
        status: "active",
        scope: "regional",
        jurisdiction: { country: "ca", region: "on" },
      },
    } as unknown as agencies.AgencyProvider;
    const spy = vi
      .spyOn(agencies, "getAgencyById")
      .mockImplementation((id) => (id === "sample-bus" ? mockProvider : undefined));

    try {
      const ctx = await Effect.runPromise(
        Effect.scoped(Layer.build(buildStationsSourceLayer("sample-bus"))),
      );

      await expect(
        handleFetchSavedStations(
          { agencyId: "sample-bus", stationNames: ["Union Station"], lat: 43.65, lon: -79.38 },
          () => Promise.resolve(ctx),
        ),
      ).rejects.toThrow(/stations source/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("Nearby RPC input", () => {
  it("normalizes agency and proximity values accepted from RPC and wire callers", () => {
    expect(
      parseNearbyRpcInput({
        agencyId: "  sample ",
        lat: "43.65",
        lon: "-79.38",
        radius: "2000",
      }),
    ).toEqual({ agencyId: "sample", lat: 43.65, lon: -79.38, radius: 1500 });
  });

  it.each([undefined, "", "  ", 42])("rejects invalid agency ids %p", (agencyId) => {
    expect(() => parseNearbyRpcInput({ agencyId, lat: 43.65, lon: -79.38 })).toThrow(/agencyId/);
  });

  it("rejects invalid coordinates", () => {
    expect(() =>
      parseNearbyRpcInput({ agencyId: "sample", lat: Number.NaN, lon: Number.NaN }),
    ).toThrow(/Invalid latitude or longitude/);
  });

  it.each([
    [90.01, 0],
    [-90.01, 0],
    [0, 180.01],
    [0, -180.01],
  ])("rejects out-of-range coordinates %p, %p", (lat, lon) => {
    expect(() => parseNearbyRpcInput({ agencyId: "sample", lat, lon })).toThrow(
      /Invalid latitude or longitude/,
    );
  });

  it("accepts coordinates on the range boundary", () => {
    expect(parseNearbyRpcInput({ agencyId: "sample", lat: -90, lon: 180 })).toMatchObject({
      lat: -90,
      lon: 180,
    });
  });

  it("defaults an omitted radius", () => {
    expect(parseNearbyRpcInput({ agencyId: "sample", lat: 43.65, lon: -79.38 }).radius).toBe(500);
  });

  it("caps numeric radius at the 1.5 km ceiling", () => {
    expect(
      parseNearbyRpcInput({ agencyId: "sample", lat: 43.65, lon: -79.38, radius: 9999 }).radius,
    ).toBe(1500);
  });

  it.each(["abc", Number.POSITIVE_INFINITY, Number.NaN])(
    "rejects non-finite radius %p",
    (radius) => {
      expect(() =>
        parseNearbyRpcInput({ agencyId: "sample", lat: 43.65, lon: -79.38, radius }),
      ).toThrow(/Invalid proximity radius/);
    },
  );

  it("clamps negative proximity radius to zero", () => {
    expect(
      parseNearbyRpcInput({ agencyId: "sample", lat: 43.65, lon: -79.38, radius: -50 }).radius,
    ).toBe(0);
  });
});

describe("createSwrFeedCache onRefreshFailure policies", () => {
  interface TestState {
    readonly generatedAt: number;
  }
  const makeState = (generatedAt: number): TestState => ({ generatedAt });

  it("default retain policy resolves get() with current state when refresh fails", async () => {
    let attempts = 0;
    const cache = createSwrFeedCache<TestState>({
      label: "retain-test",
      ttlMs: 1_000,
      initialState: makeState(0),
      expiryPolicy: "join-refresh",
      refresh: async () => {
        attempts += 1;
        throw new Error("upstream down");
      },
    });

    const result = await cache.get();

    expect(result).toEqual(makeState(0));
    expect(attempts).toBe(1);
  });

  it("throw policy propagates the failure and clears in-flight so the next call retries", async () => {
    const boom = new Error("feed exploded");
    let attempts = 0;
    const cache = createSwrFeedCache<TestState>({
      label: "throw-test",
      ttlMs: 1_000,
      initialState: makeState(0),
      expiryPolicy: "join-refresh",
      onRefreshFailure: "throw",
      refresh: async () => {
        attempts += 1;
        if (attempts === 1) throw boom;
        return makeState(1234);
      },
    });

    await expect(cache.get()).rejects.toBe(boom);

    const recovered = await cache.get();
    expect(recovered).toEqual(makeState(1234));
    expect(attempts).toBe(2);
  });
});
