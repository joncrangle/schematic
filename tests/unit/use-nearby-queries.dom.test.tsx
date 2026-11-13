// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { FavouriteStationRef } from "~/domain/preferences/UserPreferences";

/**
 * useNearbyQueries: one place knows "all four nearby queries" and the
 * derived values the panel renders. Returns derived accessors only — never
 * raw query objects — so adding a fifth query touches only this module.
 */

const fetchNearbyTransit = vi.hoisted(() => vi.fn());
const fetchSavedTransit = vi.hoisted(() => vi.fn());
const fetchNearbyStations = vi.hoisted(() => vi.fn());
const fetchSavedStations = vi.hoisted(() => vi.fn());
const ttcBounds = { minLat: 43.58, maxLat: 43.86, minLon: -79.64, maxLon: -79.11 };
const goBounds = { minLat: 43.0, maxLat: 44.5, minLon: -80.0, maxLon: -78.0 };
const mockAllProviders = vi.hoisted(() =>
  vi.fn(
    () =>
      [
        {
          manifest: {
            id: "ttc",
            bounds: [ttcBounds],
            status: "active",
            stationService: { routeType: "subway" },
          },
        } as unknown as ReturnType<
          typeof import("../../src/agencies/registry").allProviders
        >[number],
      ] as unknown as ReturnType<typeof import("../../src/agencies/registry").allProviders>,
  ),
);
vi.mock("../../src/agencies/browserRegistry", () => ({
  getAgenciesForPoint: vi.fn(),
  allProviders: mockAllProviders,
  getAgencyById: vi.fn(
    (id: string) =>
      ({ manifest: { id } }) as unknown as ReturnType<
        typeof import("../../src/agencies/registry").getAgencyById
      >,
  ),
  getActiveAgency: vi.fn(
    () =>
      ({ manifest: { id: "ttc" } }) as unknown as ReturnType<
        typeof import("../../src/agencies/registry").getActiveAgency
      >,
  ),
}));

import { preloadNearbyQueries, useNearbyQueries } from "../../src/hooks/useNearbyQueries";
import type { NearbyRouteArrival } from "../../src/domain/surface/types";
import type { NearbyStationArrival } from "../../src/domain/surface/types";
import { queryClient } from "../../src/lib/queryClient";

function routeFixture(routeId: string, meters: number): NearbyRouteArrival {
  return {
    id: routeId,
    routeId,
    routeShortName: routeId,
    routeLongName: `Route ${routeId}`,
    routeType: "bus",
    agencyId: "ttc",
    directionId: 0,
    headsign: "Eastbound",
    stopId: `${routeId}-stop`,
    stopName: `${routeId} Stop`,
    stopLat: 43.67,
    stopLon: -79.38,
    distanceMeters: meters,
    walkingMinutes: 2,
    arrivals: [],
    alerts: [],
  };
}

function stationFixture(id: string, meters: number): NearbyStationArrival {
  return {
    id,
    stationName: `Station ${id}`,
    lineIds: ["1"],
    agencyId: "ttc",
    distanceMeters: meters,
    walkingMinutes: 3,
    arrivals: [{ directionId: 1, label: "Southbound", times: [Date.now() + 60_000] }],
  };
}

const ttcRoutes = (...routeIds: string[]) =>
  routeIds.map((routeId) => ({ agencyId: "ttc", routeId }));

const DOWNTOWN = { lat: 43.6709, lon: -79.3857 };

type HookResult = ReturnType<typeof useNearbyQueries>;

function renderHook(options: {
  location?: () => { lat: number; lon: number } | null;
  favouriteStations?: readonly (string | FavouriteStationRef)[];
  favouriteSurfaceRoutes?: { agencyId: string; routeId: string }[];
  enabled?: boolean;
  effectiveAgency?: {
    coveringIds: readonly string[];
    stationCoveringIds: readonly string[];
  };
}): () => HookResult {
  let captured: HookResult | undefined;
  const location = options.location ?? (() => DOWNTOWN);
  const preferences = {
    favouriteStations: (options.favouriteStations ?? []).map((station) =>
      typeof station === "string" ? { agencyId: "ttc", stationName: station } : station,
    ),
    favouriteSurfaceRoutes: options.favouriteSurfaceRoutes ?? [],
  };
  const effectiveAgency = options.effectiveAgency ?? {
    coveringIds: ["ttc"],
    stationCoveringIds: ["ttc"],
  };
  render(() => {
    captured = useNearbyQueries(
      location,
      preferences as Parameters<typeof useNearbyQueries>[1],
      () => "ttc",
      () => ({
        fix: null,
        source: "default",
        status: "idle",
        automaticAgencyId: "ttc",
        agencyId: "ttc",
        declaredCoveringIds: effectiveAgency.coveringIds,
        ...effectiveAgency,
      }),
      () => options.enabled ?? true,
      {
        fetchNearbyTransit,
        fetchSavedTransit,
        fetchNearbyStations,
        fetchSavedStations,
      },
    );
    return null;
  });
  return () => captured!;
}

beforeEach(() => {
  queryClient.clear();
  fetchNearbyTransit.mockReset();
  fetchNearbyTransit.mockResolvedValue([]);
  fetchSavedTransit.mockReset();
  fetchSavedTransit.mockResolvedValue([]);
  fetchNearbyStations.mockReset();
  fetchNearbyStations.mockResolvedValue([]);
  fetchSavedStations.mockReset();
  fetchSavedStations.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useNearbyQueries", () => {
  it("does not execute any query family while the panel gate is disabled", async () => {
    renderHook({
      enabled: false,
      favouriteStations: ["Union Station"],
      favouriteSurfaceRoutes: ttcRoutes("52"),
    });

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(fetchNearbyTransit).not.toHaveBeenCalled();
    expect(fetchNearbyStations).not.toHaveBeenCalled();
    expect(fetchSavedTransit).not.toHaveBeenCalled();
    expect(fetchSavedStations).not.toHaveBeenCalled();
  });

  it("preloads both lazy providers once and reuses the shared load promise", async () => {
    const first = preloadNearbyQueries();
    const second = preloadNearbyQueries();

    expect(second).toBe(first);
    await first;
  });

  it("retains the exact cache keys for all four query families", async () => {
    const hook = renderHook({
      favouriteStations: ["Union Station"],
      favouriteSurfaceRoutes: ttcRoutes("52"),
    });

    await vi.waitFor(() => expect(hook().isOutsideServiceArea()).toBe(true));

    // No panel-activation segment in the identity: keying it minted
    // disabled, dataless entries on close whose never-settling async node
    // held the closing update forever.
    const keys = queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey);
    expect(keys).toContainEqual(["nearby-transit", "ttc", "en-CA", DOWNTOWN, ["ttc"]]);
    expect(keys).toContainEqual(["nearby-stations", "ttc", "en-CA", DOWNTOWN, ["ttc"]]);
    expect(keys).toContainEqual(["saved-transit", "ttc", "en-CA", DOWNTOWN, ttcRoutes("52")]);
    expect(keys).toContainEqual([
      "saved-stations",
      "ttc",
      "en-CA",
      ["Union Station"],
      DOWNTOWN,
      ["ttc"],
    ]);
  });

  it("prefetches enabled nearby queries through the panel's cache keys", async () => {
    fetchNearbyTransit.mockResolvedValue([routeFixture("52", 100)]);
    fetchNearbyStations.mockResolvedValue([stationFixture("99999", 200)]);
    const hook = renderHook({ enabled: false });

    expect(fetchNearbyTransit).not.toHaveBeenCalled();
    expect(fetchNearbyStations).not.toHaveBeenCalled();

    await hook().prefetch();

    expect(fetchNearbyTransit).toHaveBeenCalledTimes(1);
    expect(fetchNearbyStations).toHaveBeenCalledTimes(1);
  });

  it("does not prefetch location queries without a usable location", async () => {
    const hook = renderHook({ location: () => null, enabled: false });

    await hook().prefetch();

    expect(fetchNearbyTransit).not.toHaveBeenCalled();
    expect(fetchNearbyStations).not.toHaveBeenCalled();
  });

  it("lets an enabled panel reuse the idle-prefetched nearby results", async () => {
    fetchNearbyTransit.mockResolvedValue([routeFixture("52", 100)]);
    fetchNearbyStations.mockResolvedValue([stationFixture("99999", 200)]);
    const prefetchHook = renderHook({ enabled: false });

    await prefetchHook().prefetch();
    const transitCalls = fetchNearbyTransit.mock.calls.length;
    const stationCalls = fetchNearbyStations.mock.calls.length;

    const liveHook = renderHook({ enabled: true });
    await vi.waitFor(() => expect(liveHook().hasData()).toBe(true));

    expect(fetchNearbyTransit).toHaveBeenCalledTimes(transitCalls);
    expect(fetchNearbyStations).toHaveBeenCalledTimes(stationCalls);
  });

  it("shares an in-flight idle prewarm when the panel opens", async () => {
    let resolveTransit!: (value: NearbyRouteArrival[]) => void;
    fetchNearbyTransit.mockReturnValue(
      new Promise<NearbyRouteArrival[]>((resolve) => {
        resolveTransit = resolve;
      }),
    );

    const prefetchHook = renderHook({ enabled: false });
    const prefetchPromise = prefetchHook().prefetch();
    await vi.waitFor(() => expect(fetchNearbyTransit).toHaveBeenCalledTimes(1));

    const liveHook = renderHook({ enabled: true });
    expect(fetchNearbyTransit).toHaveBeenCalledTimes(1);

    resolveTransit([routeFixture("52", 100)]);
    await prefetchPromise;
    await vi.waitFor(() => expect(liveHook().hasData()).toBe(true));
  });

  it("merges stations and routes nearest-first, stations winning distance ties", async () => {
    fetchNearbyTransit.mockResolvedValue([routeFixture("52", 400), routeFixture("97", 200)]);
    fetchNearbyStations.mockResolvedValue([stationFixture("99999", 200)]);
    const hook = renderHook({});
    await vi.waitFor(() => expect(hook().mergedNearby().length).toBe(3));
    const ids = hook()
      .mergedNearby()
      .map((item) => ("stationName" in item ? item.id : item.routeId));
    expect(ids).toEqual(["99999", "97", "52"]);
  });

  it("dedupes saved lists against the nearby lists", async () => {
    fetchNearbyTransit.mockResolvedValue([routeFixture("52", 400)]);
    fetchNearbyStations.mockResolvedValue([stationFixture("99999", 300)]);
    fetchSavedTransit.mockResolvedValue([routeFixture("52", 900), routeFixture("97", 900)]);
    fetchSavedStations.mockResolvedValue([
      stationFixture("99999", 900),
      stationFixture("88888", 900),
    ]);
    const hook = renderHook({
      favouriteStations: ["Station 99999"],
      favouriteSurfaceRoutes: ttcRoutes("52"),
    });
    await vi.waitFor(() => expect(hook().savedArrivals().length).toBe(1));
    expect(
      hook()
        .savedArrivals()
        .map((a) => a.routeId),
    ).toEqual(["97"]);
    expect(
      hook()
        .savedStations()
        .map((s) => s.id),
    ).toEqual(["88888"]);
  });

  it.each([
    {
      label: "stations favourited",
      favouriteStations: ["Station 99999"],
      favouriteSurfaceRoutes: [],
    },
    {
      label: "routes favourited",
      favouriteStations: [],
      favouriteSurfaceRoutes: ttcRoutes("52"),
    },
  ])(
    "never fires a saved RPC whose favourite kind is empty ($label)",
    async ({ favouriteStations, favouriteSurfaceRoutes }) => {
      renderHook({ favouriteStations, favouriteSurfaceRoutes });
      await vi.waitFor(() => expect(fetchNearbyStations).toHaveBeenCalled());
      const routesFavourited = favouriteSurfaceRoutes.length > 0;
      expect(routesFavourited ? fetchSavedTransit : fetchSavedStations).toHaveBeenCalled();
      expect(routesFavourited ? fetchSavedStations : fetchSavedTransit).not.toHaveBeenCalled();
    },
  );

  it("reports loading only while queries are in flight AND nothing has landed", async () => {
    let resolveTransit: (value: NearbyRouteArrival[]) => void = () => {};
    fetchNearbyTransit.mockReturnValue(
      new Promise<NearbyRouteArrival[]>((resolve) => {
        resolveTransit = resolve;
      }),
    );
    const hook = renderHook({});
    await vi.waitFor(() => expect(hook().isLoading()).toBe(true));
    resolveTransit([routeFixture("52", 100)]);
    await vi.waitFor(() => expect(hook().hasData()).toBe(true));
    expect(hook().isLoading()).toBe(false);
  });

  it("keeps every public accessor safe before the initial queries resolve", async () => {
    let resolveTransit!: (value: NearbyRouteArrival[]) => void;
    let resolveStations!: (value: NearbyStationArrival[]) => void;
    fetchNearbyTransit.mockReturnValue(
      new Promise<NearbyRouteArrival[]>((resolve) => {
        resolveTransit = resolve;
      }),
    );
    fetchNearbyStations.mockReturnValue(
      new Promise<NearbyStationArrival[]>((resolve) => {
        resolveStations = resolve;
      }),
    );
    const hook = renderHook({
      favouriteStations: ["Union Station"],
      favouriteSurfaceRoutes: ttcRoutes("52"),
    });

    expect(hook().mergedNearby()).toEqual([]);
    expect(hook().savedArrivals()).toEqual([]);
    expect(hook().savedStations()).toEqual([]);
    expect(hook().hasData()).toBe(false);
    expect(hook().fetchError()).toBeNull();
    expect(hook().isOutsideServiceArea()).toBe(false);
    expect(hook().isLoading()).toBe(true);

    resolveTransit([]);
    resolveStations([]);
    await vi.waitFor(() => expect(hook().isOutsideServiceArea()).toBe(true));
  });

  it("uses the manifest bucket size when ranking one public merged result", async () => {
    mockAllProviders.mockReturnValue([
      {
        manifest: {
          id: "ttc",
          proximity: { radiusMeters: 1_500, bucketMeters: 100 },
          stationService: { routeType: "subway" },
          status: "active",
        },
      } as unknown as ReturnType<typeof import("../../src/agencies/registry").allProviders>[number],
    ] as unknown as ReturnType<typeof import("../../src/agencies/registry").allProviders>);
    fetchNearbyTransit.mockResolvedValue([routeFixture("52", 74)]);
    fetchNearbyStations.mockResolvedValue([stationFixture("99999", 76)]);
    const hook = renderHook({});

    await vi.waitFor(() => expect(hook().mergedNearby().length).toBe(2));

    expect(
      hook()
        .mergedNearby()
        .map((item) => ("stationName" in item ? item.id : item.routeId)),
    ).toEqual(["99999", "52"]);
  });

  it.each([
    ["a missing bucket", undefined],
    ["an invalid bucket", { radiusMeters: 1_500, bucketMeters: 0 }],
  ] as const)("falls back to the 75m bucket for %s", async (_label, proximity) => {
    mockAllProviders.mockReturnValue([
      {
        manifest: {
          id: "ttc",
          proximity,
          stationService: { routeType: "subway" },
          status: "active",
        },
      } as unknown as ReturnType<typeof import("../../src/agencies/registry").allProviders>[number],
    ] as unknown as ReturnType<typeof import("../../src/agencies/registry").allProviders>);
    fetchNearbyTransit.mockResolvedValue([routeFixture("52", 74)]);
    fetchNearbyStations.mockResolvedValue([stationFixture("99999", 76)]);
    const hook = renderHook({});

    await vi.waitFor(() => expect(hook().mergedNearby().length).toBe(2));

    expect(
      hook()
        .mergedNearby()
        .map((item) => ("stationName" in item ? item.id : item.routeId)),
    ).toEqual(["52", "99999"]);
  });

  it("falls back to safe provider defaults for invalid policy values", async () => {
    mockAllProviders.mockReturnValue([
      {
        manifest: {
          id: "ttc",
          proximity: { radiusMeters: 0, bucketMeters: -1 },
          stationService: { routeType: "subway" },
          status: "active",
        },
      } as unknown as ReturnType<typeof import("../../src/agencies/registry").allProviders>[number],
    ] as unknown as ReturnType<typeof import("../../src/agencies/registry").allProviders>);
    const hook = renderHook({ enabled: false });

    await hook().prefetch();

    expect(fetchNearbyTransit).toHaveBeenCalledWith(expect.objectContaining({ radius: 1_500 }));
  });

  it.each([
    {
      source: "nearby-transit",
      reject: () => fetchNearbyTransit.mockRejectedValue(new Error("transit socket died")),
      favourites: {},
    },
    {
      source: "nearby-stations",
      reject: () => fetchNearbyStations.mockRejectedValue(new Error("stations socket died")),
      favourites: {},
    },
    {
      source: "saved-transit",
      reject: () => fetchSavedTransit.mockRejectedValue(new Error("saved transit down")),
      favourites: { favouriteStations: [], favouriteSurfaceRoutes: ttcRoutes("52") },
    },
    {
      source: "saved-stations",
      reject: () => fetchSavedStations.mockRejectedValue(new Error("saved stations down")),
      favourites: { favouriteStations: ["Station 88888"], favouriteSurfaceRoutes: [] },
    },
  ])("folds an error from any of the four queries ($source)", async ({ reject, favourites }) => {
    reject();
    const hook = renderHook(favourites);
    await vi.waitFor(() => expect(hook().fetchError()).toBeTruthy(), {
      timeout: 5000,
    });
  });

  it("serves empty lists instead of throwing when every query fails without cached data", async () => {
    fetchNearbyTransit.mockRejectedValue(new Error("transit socket died"));
    fetchNearbyStations.mockRejectedValue(new Error("stations socket died"));
    const hook = renderHook({});
    await vi.waitFor(() => expect(hook().fetchError()).toBeTruthy(), {
      timeout: 5000,
    });
    expect(() => hook().mergedNearby()).not.toThrow();
    expect(hook().mergedNearby()).toEqual([]);
    expect(hook().hasData()).toBe(false);
  });

  it("marks outside-service-area on success with every list empty", async () => {
    const hook = renderHook({});
    await vi.waitFor(() => expect(hook().isOutsideServiceArea()).toBe(true));
    expect(hook().fetchError()).toBeNull();
  });

  it("short-circuits outside coverage with zero nearby fetches and no loading state", async () => {
    const hook = renderHook({
      effectiveAgency: { coveringIds: [], stationCoveringIds: [] },
    });

    await vi.waitFor(() => expect(hook().isOutsideServiceArea()).toBe(true));
    expect(hook().isLoading()).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(fetchNearbyTransit).not.toHaveBeenCalled();
    expect(fetchNearbyStations).not.toHaveBeenCalled();
  });

  it("holds the skeleton while outside favourites pend instead of flashing empty", async () => {
    let resolveSaved!: (value: NearbyRouteArrival[]) => void;
    fetchSavedTransit.mockReturnValue(
      new Promise<NearbyRouteArrival[]>((resolve) => {
        resolveSaved = resolve;
      }),
    );
    const hook = renderHook({
      effectiveAgency: { coveringIds: [], stationCoveringIds: [] },
      favouriteSurfaceRoutes: ttcRoutes("52"),
    });

    // Skeleton owns the screen (panel hides the empty state while loading).
    await vi.waitFor(() => expect(hook().isLoading()).toBe(true));

    resolveSaved([routeFixture("52", 100)]);
    await vi.waitFor(() => expect(hook().hasData()).toBe(true));
    expect(hook().isLoading()).toBe(false);
    expect(hook().isOutsideServiceArea()).toBe(false);
  });

  it("exposes hasData when any list carries stabilized items", async () => {
    fetchSavedStations.mockResolvedValue([stationFixture("88888", 10)]);
    const hook = renderHook({ favouriteStations: ["Station 88888"] });
    await vi.waitFor(() => expect(hook().hasData()).toBe(true));
  });

  it("deduplicates repeated route and station identities before ranking the merged list", async () => {
    const route = routeFixture("52", 100);
    const station = stationFixture("99999", 200);
    fetchNearbyTransit.mockResolvedValue([route, { ...route }]);
    fetchNearbyStations.mockResolvedValue([station, { ...station }]);
    const hook = renderHook({});

    await vi.waitFor(() => expect(hook().mergedNearby().length).toBe(2));

    expect(
      hook()
        .mergedNearby()
        .map((item) => ("stationName" in item ? item.id : item.routeId)),
    ).toEqual(["52", "99999"]);
  });

  it("retries only errored queries; saved retries honour their own gate", async () => {
    fetchNearbyTransit.mockRejectedValue(new Error("transit down"));
    const hook = renderHook({ favouriteSurfaceRoutes: [] });
    await vi.waitFor(() => expect(hook().fetchError()).toBe("transit down"), { timeout: 5000 });
    const transitCallsAfterFailure = fetchNearbyTransit.mock.calls.length;
    hook().retry();
    await vi.waitFor(() =>
      expect(fetchNearbyTransit.mock.calls.length).toBeGreaterThan(transitCallsAfterFailure),
    );
    expect(fetchNearbyStations).toHaveBeenCalledTimes(1);
    expect(fetchSavedTransit).not.toHaveBeenCalled();
  });

  it("retries a successful nearby query when its data is marked stale", async () => {
    fetchNearbyTransit.mockResolvedValue([{ ...routeFixture("97", 100), arrivalsStale: true }]);
    const hook = renderHook({});

    await vi.waitFor(() => expect(hook().mergedNearby()[0]?.arrivalsStale).toBe(true));
    const callsAfterStaleResult = fetchNearbyTransit.mock.calls.length;

    hook().retry();

    await vi.waitFor(() =>
      expect(fetchNearbyTransit.mock.calls.length).toBeGreaterThan(callsAfterStaleResult),
    );
    expect(fetchNearbyStations).toHaveBeenCalledTimes(1);
  });

  it("hides saved placeholder data when its favourite gate turns off", async () => {
    fetchSavedTransit.mockResolvedValue([routeFixture("52", 900)]);
    const [favouriteSurfaceRoutes, setFavouriteSurfaceRoutes] = createSignal(ttcRoutes("52"));
    let captured: HookResult | undefined;

    render(() => {
      captured = useNearbyQueries(
        () => DOWNTOWN,
        {
          favouriteStations: [],
          get favouriteSurfaceRoutes() {
            return favouriteSurfaceRoutes();
          },
        },
        () => "ttc",
        () => ({
          fix: null,
          source: "default",
          status: "idle",
          automaticAgencyId: "ttc",
          agencyId: "ttc",
          declaredCoveringIds: ["ttc"],
          coveringIds: ["ttc"],
          stationCoveringIds: ["ttc"],
        }),
        undefined,
        {
          fetchNearbyTransit,
          fetchSavedTransit,
          fetchNearbyStations,
          fetchSavedStations,
        },
      );
      return null;
    });

    await vi.waitFor(() => expect(captured?.savedArrivals().length).toBe(1));
    setFavouriteSurfaceRoutes([]);
    await vi.waitFor(() => expect(captured?.savedArrivals()).toEqual([]));
  });
});

describe("useNearbyQueries multi-agency", () => {
  beforeEach(() => {
    mockAllProviders.mockReturnValue([
      {
        manifest: { id: "ttc", bounds: [ttcBounds], status: "active" },
        createStationsSource: () => ({}),
      } as unknown as ReturnType<typeof import("../../src/agencies/registry").allProviders>[number],
      {
        manifest: { id: "go", bounds: [goBounds], status: "experimental" },
      } as unknown as ReturnType<typeof import("../../src/agencies/registry").allProviders>[number],
    ] as unknown as ReturnType<typeof import("../../src/agencies/registry").allProviders>);
  });

  afterEach(() => {
    mockAllProviders.mockReturnValue([
      {
        manifest: { id: "ttc", bounds: [ttcBounds], status: "active" },
        createStationsSource: () => ({}),
      } as unknown as ReturnType<typeof import("../../src/agencies/registry").allProviders>[number],
    ] as unknown as ReturnType<typeof import("../../src/agencies/registry").allProviders>);
  });

  it("fans out nearby queries to covering agencies in parallel", async () => {
    fetchNearbyTransit.mockImplementation(async (input: { agencyId: string }) => {
      if (input.agencyId === "ttc") return [routeFixture("52", 35)];
      if (input.agencyId === "go")
        return [{ ...routeFixture("LW", 15), agencyId: "go", routeType: "rail" as const }];
      return [];
    });
    fetchNearbyStations.mockImplementation(async (input: { agencyId: string }) => {
      if (input.agencyId === "ttc") return [stationFixture("union-ttc", 10)];
      return [];
    });
    const hook = renderHook({
      effectiveAgency: { coveringIds: ["ttc", "go"], stationCoveringIds: ["ttc", "go"] },
    });
    await vi.waitFor(() => expect(hook().mergedNearby().length).toBe(3));
    expect(
      hook()
        .mergedNearby()
        .map((i) => ("stationName" in i ? i.id : (i as NearbyRouteArrival).routeId)),
    ).toEqual(["union-ttc", "52", "LW"]);
    expect(fetchNearbyTransit).toHaveBeenCalledTimes(2);
    expect(fetchNearbyStations).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["uses the default radius", undefined, 1500],
    ["uses the manifest radius", { radiusMeters: 900, bucketMeters: 50 }, 900],
    ["caps an oversized manifest radius", { radiusMeters: 99_999, bucketMeters: 50 }, 1500],
  ] as const)("%s through the injected fetcher seam", async (_label, proximity, expectedRadius) => {
    mockAllProviders.mockReturnValue([
      {
        manifest: {
          id: "ttc",
          proximity,
          stationService: { routeType: "subway" },
          status: "active",
        },
      } as unknown as ReturnType<typeof import("../../src/agencies/registry").allProviders>[number],
    ] as unknown as ReturnType<typeof import("../../src/agencies/registry").allProviders>);
    const hook = renderHook({ enabled: false });

    await hook().prefetch();

    expect(fetchNearbyTransit).toHaveBeenCalledWith(
      expect.objectContaining({ agencyId: "ttc", radius: expectedRadius }),
    );
    expect(fetchNearbyStations).toHaveBeenCalledWith(
      expect.objectContaining({ agencyId: "ttc", radius: expectedRadius }),
    );
  });

  it("uses station-capable providers for saved stations and disables nearby stations without coverage", async () => {
    mockAllProviders.mockReturnValue([
      {
        manifest: { id: "ttc", stationService: { routeType: "subway" }, status: "active" },
      } as unknown as ReturnType<typeof import("../../src/agencies/registry").allProviders>[number],
      {
        manifest: { id: "go", status: "experimental" },
      } as unknown as ReturnType<typeof import("../../src/agencies/registry").allProviders>[number],
    ] as unknown as ReturnType<typeof import("../../src/agencies/registry").allProviders>);
    const hook = renderHook({
      enabled: false,
      favouriteStations: ["Union Station"],
      effectiveAgency: { coveringIds: ["ttc"], stationCoveringIds: [] },
    });

    await hook().prefetch();

    expect(fetchNearbyStations).not.toHaveBeenCalled();
    expect(fetchSavedStations).toHaveBeenCalledWith(expect.objectContaining({ agencyId: "ttc" }));
    expect(fetchSavedStations).toHaveBeenCalledTimes(1);
  });

  it("isolates per-agency failures — healthy agency data still renders", async () => {
    fetchNearbyTransit.mockImplementation(async (input: { agencyId: string }) => {
      if (input.agencyId === "go") throw new Error("GO down");
      return [routeFixture("52", 100)];
    });
    fetchNearbyStations.mockResolvedValue([]);
    const hook = renderHook({
      effectiveAgency: { coveringIds: ["ttc", "go"], stationCoveringIds: ["ttc"] },
    });
    await vi.waitFor(() => expect(hook().mergedNearby().length).toBe(1));
    expect(
      hook().mergedNearby()[0] && "routeId" in hook().mergedNearby()[0]
        ? (hook().mergedNearby()[0] as NearbyRouteArrival).routeId
        : "",
    ).toBe("52");
    expect(hook().fetchError()).toBeNull();
  });

  it("surfaces error only when every covering agency fails", async () => {
    fetchNearbyTransit.mockRejectedValue(new Error("all down"));
    fetchNearbyStations.mockRejectedValue(new Error("stations down"));
    const hook = renderHook({
      effectiveAgency: { coveringIds: ["ttc", "go"], stationCoveringIds: ["ttc"] },
    });
    await vi.waitFor(() => expect(hook().fetchError()).toBeTruthy(), { timeout: 5000 });
    expect(hook().fetchError()).toMatch(/all down|stations down/);
  });

  it("keeps successful saved-agency results when another saved agency fails", async () => {
    fetchSavedTransit.mockImplementation(async (input: { agencyId: string }) => {
      if (input.agencyId === "go") throw new Error("GO saved data unavailable");
      return [routeFixture("52", 100)];
    });
    const hook = renderHook({
      favouriteSurfaceRoutes: [
        { agencyId: "ttc", routeId: "52" },
        { agencyId: "go", routeId: "LW" },
      ],
    });

    await vi.waitFor(() => expect(hook().savedArrivals().length).toBe(1));

    expect(
      hook()
        .savedArrivals()
        .map((arrival) => arrival.routeId),
    ).toEqual(["52"]);
    expect(hook().fetchError()).toBeNull();
  });

  it("fans out saved queries only to their referenced agencies and orders selected agency first", async () => {
    mockAllProviders.mockReturnValue([
      {
        manifest: { id: "ttc", bounds: [ttcBounds], status: "active" },
        createStationsSource: () => ({}),
      } as unknown as ReturnType<typeof import("../../src/agencies/registry").allProviders>[number],
      {
        manifest: { id: "go", bounds: [goBounds], status: "experimental" },
      } as unknown as ReturnType<typeof import("../../src/agencies/registry").allProviders>[number],
    ] as unknown as ReturnType<typeof import("../../src/agencies/registry").allProviders>);
    fetchNearbyTransit.mockResolvedValue([]);
    fetchNearbyStations.mockResolvedValue([]);
    fetchSavedTransit.mockImplementation(async (input: { agencyId: string }) => {
      if (input.agencyId === "go")
        return [{ ...routeFixture("LW", 50), agencyId: "go", routeType: "rail" as const }];
      if (input.agencyId === "ttc") return [routeFixture("52", 100)];
      return [];
    });
    const hook = renderHook({
      favouriteSurfaceRoutes: [
        { agencyId: "ttc", routeId: "52" },
        { agencyId: "go", routeId: "LW" },
      ],
    });
    await vi.waitFor(() => expect(hook().savedArrivals().length).toBe(2));
    expect(
      hook()
        .savedArrivals()
        .map((a) => a.routeId),
    ).toEqual(["52", "LW"]);
    expect(fetchSavedTransit).toHaveBeenCalledTimes(2);
  });

  it("does not treat the same route id from another agency as a saved TTC route", async () => {
    mockAllProviders.mockReturnValue([
      {
        manifest: { id: "ttc", bounds: [ttcBounds], status: "active" },
        createStationsSource: () => ({}),
      } as unknown as ReturnType<typeof import("../../src/agencies/registry").allProviders>[number],
      {
        manifest: {
          id: "kingston",
          bounds: [{ minLat: 44.2, maxLat: 44.3, minLon: -76.55, maxLon: -76.45 }],
          status: "experimental",
        },
      } as unknown as ReturnType<typeof import("../../src/agencies/registry").allProviders>[number],
    ] as unknown as ReturnType<typeof import("../../src/agencies/registry").allProviders>);
    fetchSavedTransit.mockImplementation(async (input: { agencyId: string }) => [
      { ...routeFixture("501", 100), agencyId: input.agencyId },
    ]);

    const hook = renderHook({
      favouriteSurfaceRoutes: [{ agencyId: "ttc", routeId: "501" }],
    });

    await vi.waitFor(() => expect(hook().savedArrivals().length).toBeGreaterThan(0));
    expect(
      hook()
        .savedArrivals()
        .map((arrival) => arrival.agencyId),
    ).toEqual(["ttc"]);
  });

  it("keeps subway lines out of the surface-route stream when a station card represents them", async () => {
    // Ensure single-agency covering for this isolated test (unified covering would otherwise fan out to both downtown agencies)
    mockAllProviders.mockReturnValue([
      {
        manifest: { id: "ttc", bounds: [ttcBounds], status: "active" },
        createStationsSource: () => ({}),
      } as unknown as ReturnType<typeof import("../../src/agencies/registry").allProviders>[number],
    ] as unknown as ReturnType<typeof import("../../src/agencies/registry").allProviders>);
    fetchNearbyTransit.mockResolvedValue([{ ...routeFixture("1", 10), routeType: "subway" }]);
    fetchNearbyStations.mockResolvedValue([stationFixture("union-ttc", 20)]);

    const hook = renderHook({});

    await vi.waitFor(() => expect(hook().mergedNearby().length).toBeGreaterThan(0));
    expect(
      hook()
        .mergedNearby()
        .map((item) => ("stationName" in item ? `station:${item.id}` : `route:${item.routeId}`)),
    ).toEqual(["station:union-ttc"]);
  });

  it.each([
    ["within the co-location envelope", 0.0011, 1],
    ["outside the co-location envelope", 0.002, 2],
  ] as const)("%s, preserving the public merged result", async (_label, longitudeDelta, count) => {
    const railRoute = { ...routeFixture("LE", 0), agencyId: "go", routeType: "rail" as const };
    const railStation = {
      ...stationFixture("DC:LE", 84),
      agencyId: "go",
      stationName: "Durham College Oshawa GO",
      lineIds: ["LE"],
      routeType: "rail" as const,
      lat: railRoute.stopLat,
      lon: railRoute.stopLon + longitudeDelta,
    };
    fetchNearbyTransit.mockResolvedValue([railRoute]);
    fetchNearbyStations.mockResolvedValue([railStation]);

    const hook = renderHook({
      effectiveAgency: { coveringIds: ["go"], stationCoveringIds: ["go"] },
    });

    await vi.waitFor(() => expect(hook().mergedNearby().length).toBe(count));
  });
});
