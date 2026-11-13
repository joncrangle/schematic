vi.mock("~/agencies/agencyCatalog", async () => {
  const { testAgencyCatalog } = await import("../helpers/agency-fixtures");
  return { agencyCatalog: testAgencyCatalog };
});
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal, flush } from "solid-js";
import { render, cleanup, waitFor, screen, fireEvent } from "@solidjs/testing-library";
import type { JSX } from "@solidjs/web";

/**
 * NearbyPanel nearby list: subway stations and surface routes merge into ONE
 * nearest-first sequence by walking distance. Station cards carry
 * line-number labels and — unlike route cards —
 * expose no Enlarge Map affordance anywhere in their tree.
 */

const mocks = vi.hoisted(() => ({ isDevBuild: true }));
vi.mock("~/lib/devFlags", () => ({ isDevServer: () => mocks.isDevBuild }));

const mockReadCachedRouteTracking = vi.hoisted(() => vi.fn(() => null));
const mockAcquireRouteTracking = vi.hoisted(() =>
  vi.fn(() => ({ data: () => null, release: vi.fn() })),
);
const mockGetAgenciesForPoint = vi.hoisted(() =>
  vi.fn(
    () =>
      [{ manifest: { id: "sample" } }] as unknown as ReturnType<
        typeof import("../../src/agencies/registry").getAgenciesForPoint
      >,
  ),
);
const panelData = vi.hoisted(() => ({
  mergedNearby: [] as readonly unknown[],
  savedArrivals: [] as readonly unknown[],
  savedStations: [] as readonly unknown[],
  fetchError: null as string | null,
  isOutsideServiceArea: false,
  isOutsideCoverage: false,
}));
const mockUseNearbyQueries = vi.hoisted(() => vi.fn());
const mockPrefetch = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("~/hooks/useNearbyQueries", () => ({ useNearbyQueries: mockUseNearbyQueries }));
vi.mock("~/lib/routeTrackingLifecycle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/routeTrackingLifecycle")>();
  return {
    ...actual,
    acquireRouteTracking: mockAcquireRouteTracking,
    readCachedRouteTracking: mockReadCachedRouteTracking,
  };
});
vi.mock("~/agencies/browserRegistry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/agencies/browserRegistry")>();
  return {
    ...actual,
    getAgenciesForPoint: mockGetAgenciesForPoint,
    getAgencyById: vi.fn((id: string) => actual.getAgencyById(id)),
    getActiveAgency: vi.fn(() => actual.getActiveAgency()),
  };
});

import { getLocationLadder } from "~/hooks/useGeolocation";
import {
  UserPreferencesProvider,
  useUserPreferences,
  type UserPreferencesContextValue,
} from "~/context/UserPreferencesContext";
import { AgencySessionProvider } from "~/context/AgencySessionContext";
import { createMockAgencySession } from "../helpers/mockAgencySession";
import type { NearbyRouteArrival, NearbyStationArrival } from "~/domain/surface/types";
import type { EffectiveAgencySnapshot } from "~/domain/location/EffectiveAgency";
import { installMemoryLocalStorage } from "../helpers/local-storage";
import { queryClient } from "~/lib/queryClient";

/**
 * NearbyPanel reads user preferences: every mount goes through the
 * provider, mirroring the production root layout. `seed` optionally writes
 * initial favourites through the provider itself after the initial render.
 */
function renderInProvider(
  ui: () => JSX.Element,
  {
    seed,
    selectedAgency = "sample",
    effectiveSnapshot,
  }: {
    seed?: (prefs: UserPreferencesContextValue) => void;
    selectedAgency?: string;
    effectiveSnapshot?: Partial<EffectiveAgencySnapshot>;
  } = {},
) {
  const ladder = getLocationLadder();
  const currentFix = ladder.effectiveFix();
  const snapshot: EffectiveAgencySnapshot = {
    fix: currentFix.fix,
    source: currentFix.source,
    status: ladder.status(),
    automaticAgencyId: selectedAgency,
    agencyId: selectedAgency,
    declaredCoveringIds: mockGetAgenciesForPoint().map((provider) => provider.manifest.id),
    coveringIds: mockGetAgenciesForPoint().map((provider) => provider.manifest.id),
    stationCoveringIds: mockGetAgenciesForPoint().map((provider) => provider.manifest.id),
    ...effectiveSnapshot,
  };
  const session = createMockAgencySession({ snapshot });
  return render(() => (
    <UserPreferencesProvider>
      <AgencySessionProvider session={session}>
        {seed ? <PreferenceSeeder seed={seed} /> : null}
        {ui()}
      </AgencySessionProvider>
    </UserPreferencesProvider>
  ));
}

/**
 * Seeds preferences in a microtask after the initial render has settled.
 * Mutating the provider from a component body is rejected by Solid rc.9 as a
 * write inside an owned scope.
 */
function PreferenceSeeder(props: { seed: (prefs: UserPreferencesContextValue) => void }) {
  const prefs = useUserPreferences();
  queueMicrotask(() => props.seed(prefs));
  return null;
}

function stationFixture(): NearbyStationArrival {
  return {
    id: "99999",
    stationName: "Bloor-Yonge",
    lineIds: ["1", "2"],
    agencyId: "sample",
    routeType: "subway",
    distanceMeters: 320,
    walkingMinutes: 4,
    arrivals: [
      { directionId: 1, label: "Southbound", times: [Date.now() + 240_000] },
      { directionId: 0, label: "Northbound", times: [Date.now() + 420_000] },
    ],
  };
}

function routeFixture(routeId: string, shortName: string, stopName: string, meters: number) {
  return {
    id: routeId,
    routeId,
    routeShortName: shortName,
    routeLongName: shortName,
    routeType: "bus" as const,
    agencyId: "sample",
    directionId: 0,
    headsign: "Eastbound",
    stopId: `${routeId}-stop`,
    stopName,
    stopLat: 43.67,
    stopLon: -79.38,
    distanceMeters: meters,
    walkingMinutes: 2,
    arrivals: [],
    alerts: [],
  };
}

function setPanelData(data: Partial<typeof panelData> = {}) {
  panelData.mergedNearby = data.mergedNearby ?? [];
  panelData.savedArrivals = data.savedArrivals ?? [];
  panelData.savedStations = data.savedStations ?? [];
  panelData.fetchError = data.fetchError ?? null;
  panelData.isOutsideServiceArea = data.isOutsideServiceArea ?? false;
  panelData.isOutsideCoverage = data.isOutsideCoverage ?? false;
}

beforeEach(() => {
  mocks.isDevBuild = true;
  installMemoryLocalStorage();
  setPanelData({ mergedNearby: [stationFixture()] });
  mockPrefetch.mockClear();
  mockUseNearbyQueries.mockImplementation(
    (
      _location: unknown,
      favourites: {
        favouriteStations: readonly string[];
        favouriteSurfaceRoutes: readonly unknown[];
      },
    ) => {
      const savedArrivals = () =>
        favourites.favouriteSurfaceRoutes.length ? panelData.savedArrivals : [];
      const savedStations = () =>
        favourites.favouriteStations.length ? panelData.savedStations : [];
      const mergedNearby = () => panelData.mergedNearby;
      const hasData = () =>
        mergedNearby().length > 0 || savedArrivals().length > 0 || savedStations().length > 0;
      return {
        mergedNearby,
        savedArrivals,
        savedStations,
        hasData,
        isLoading: () => false,
        fetchError: () => panelData.fetchError,
        isOutsideServiceArea: () => panelData.isOutsideServiceArea,
        isOutsideCoverage: () => panelData.isOutsideCoverage,
        retry: vi.fn(),
        prefetch: mockPrefetch,
        allQueriesIdle: () => true,
      };
    },
  );
  // No GPS stub: status stays idle and only the dev spoof feeds the panel.
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: undefined,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  mockGetAgenciesForPoint.mockReturnValue([{ manifest: { id: "sample" } }] as unknown as ReturnType<
    typeof import("../../src/agencies/registry").getAgenciesForPoint
  >);
  getLocationLadder().clearSpoof();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("NearbyPanel subway stations section", () => {
  it.each([
    { kind: "routes", cached: false },
    { kind: "stations", cached: false },
    { kind: "routes", cached: true },
    { kind: "stations", cached: true },
  ])(
    "shows available $kind while other requests are pending, cached=$cached",
    async ({ kind, cached }) => {
      queryClient.clear();
      const actual = await vi.importActual<typeof import("~/hooks/useNearbyQueries")>(
        "~/hooks/useNearbyQueries",
      );
      let resolveTransit!: (items: NearbyRouteArrival[]) => void;
      const pendingTransit = new Promise<NearbyRouteArrival[]>((resolve) => {
        resolveTransit = resolve;
      });
      let resolveStations!: (items: NearbyStationArrival[]) => void;
      const pendingStations = new Promise<NearbyStationArrival[]>((resolve) => {
        resolveStations = resolve;
      });
      const route = routeFixture("52", "52", "Available Stop", 120);
      const station = stationFixture();
      const location = { lat: 43.6709, lon: -79.3857 };
      if (cached) {
        queryClient.setQueryData(
          ["nearby-transit", "sample", "en-CA", location, ["sample"]],
          kind === "routes" ? [route] : [],
          { updatedAt: 1 },
        );
        queryClient.setQueryData(
          ["nearby-stations", "sample", "en-CA", location, ["sample"]],
          kind === "stations" ? [station] : [],
          { updatedAt: 1 },
        );
      }
      const fetchTransit = vi.fn(() =>
        kind === "routes" && !cached ? Promise.resolve([route]) : pendingTransit,
      );
      const fetchStations = vi.fn(() =>
        kind === "stations" && !cached ? Promise.resolve([station]) : pendingStations,
      );
      let queries!: ReturnType<typeof actual.useNearbyQueries>;
      mockUseNearbyQueries.mockImplementation(
        (...args: Parameters<typeof actual.useNearbyQueries>) => {
          queries = actual.useNearbyQueries(args[0], args[1], args[2], args[3], args[4], {
            fetchNearbyTransit: fetchTransit,
            fetchNearbyStations: fetchStations,
            fetchSavedTransit: vi.fn(async () => []),
            fetchSavedStations: vi.fn(async () => []),
          });
          return queries;
        },
      );
      const panel = await import("~/components/nearby/NearbyPanel");
      const [open, setOpen] = createSignal(false);
      renderInProvider(
        () => (
          <>
            <button type="button" onClick={() => setOpen((prev) => !prev)}>
              Toggle Nearby
            </button>
            <panel.NearbyPanel isOpen={open} />
          </>
        ),
        {
          effectiveSnapshot: {
            fix: { latitude: 43.6709, longitude: -79.3857, timestamp: Date.now() },
            source: "gps",
            status: "granted",
          },
        },
      );
      try {
        fireEvent.click(screen.getByText("Toggle Nearby"));
        flush();
        await waitFor(() => {
          expect(fetchTransit).toHaveBeenCalled();
          expect(fetchStations).toHaveBeenCalled();
        });
        await waitFor(() =>
          expect(
            screen.getByText(kind === "routes" ? "Available Stop" : "Bloor-Yonge"),
          ).toBeDefined(),
        );
        fireEvent.click(screen.getByText("Toggle Nearby"));
        flush();
        expect(screen.queryByText(kind === "routes" ? "Available Stop" : "Bloor-Yonge")).toBeNull();
        fireEvent.click(screen.getByText("Toggle Nearby"));
        flush();
        await waitFor(() =>
          expect(
            screen.getByText(kind === "routes" ? "Available Stop" : "Bloor-Yonge"),
          ).toBeDefined(),
        );
        resolveTransit([{ ...route, stopName: "Refreshed Stop" }]);
        resolveStations([{ ...station, stationName: "Refreshed Station" }]);
        const expectedRouteName =
          kind === "routes" && !cached ? "Available Stop" : "Refreshed Stop";
        const expectedStationName =
          kind === "stations" && !cached ? "Bloor-Yonge" : "Refreshed Station";
        await waitFor(() => {
          expect(screen.getByText(expectedRouteName)).toBeDefined();
          expect(screen.getByText(expectedStationName)).toBeDefined();
        });
      } finally {
        resolveTransit([]);
        resolveStations([]);
        await waitFor(() => expect(queries.allQueriesIdle()).toBe(true));
        cleanup();
        queryClient.clear();
      }
    },
  );

  it("warms nearby data during an idle window while the panel stays closed", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    const panel = await import("~/components/nearby/NearbyPanel");

    renderInProvider(() => <panel.NearbyPanel isOpen={() => false} />, {
      effectiveSnapshot: {
        fix: { latitude: 43.6709, longitude: -79.3857, timestamp: 1 },
        source: "gps",
        status: "granted",
      },
    });

    await vi.advanceTimersByTimeAsync(1_250);

    expect(mockPrefetch).toHaveBeenCalledTimes(1);
  });

  it("does not warm nearby data from coarse location without location approval", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    const panel = await import("~/components/nearby/NearbyPanel");

    renderInProvider(() => <panel.NearbyPanel isOpen={() => false} />, {
      effectiveSnapshot: {
        fix: { latitude: 43.6709, longitude: -79.3857, timestamp: 1 },
        source: "coarse-ip",
        status: "idle",
      },
    });

    await vi.advanceTimersByTimeAsync(1_250);

    expect(mockPrefetch).not.toHaveBeenCalled();
  });

  it("does not schedule an idle warm-up after the panel is disposed", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    const panel = await import("~/components/nearby/NearbyPanel");

    const rendered = renderInProvider(() => <panel.NearbyPanel isOpen={() => false} />, {
      effectiveSnapshot: {
        fix: { latitude: 43.6709, longitude: -79.3857, timestamp: 1 },
        source: "gps",
        status: "granted",
      },
    });
    rendered.unmount();

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_250);

    expect(mockPrefetch).not.toHaveBeenCalled();
  });

  it("renders station cards with countdown pills but no enlarge affordance in their tree", async () => {
    const panel = await import("~/components/nearby/NearbyPanel");
    getLocationLadder().applySpoof({ latitude: 43.6709, longitude: -79.3857, accuracyMeters: 10 });
    const { container } = renderInProvider(() => <panel.NearbyPanel />);

    // Station cards render directly (no section heading) with station name
    await waitFor(() => expect(screen.getByText("Bloor-Yonge")).toBeDefined());

    const stationCards = container.querySelectorAll('[data-testid="station-arrival-card"]');
    expect(stationCards.length).toBe(1);

    // No enlarge affordance may exist for stations (surface-only path)
    expect(screen.queryByText("Enlarge Map")).toBeNull();

    // Countdown pills present inside the station card
    const pillText = stationCards[0].textContent ?? "";
    expect(pillText).toMatch(/min|Due/);

    // Collapsed card surfaces BOTH directions with their own labels
    expect(pillText).toContain("Southbound");
    expect(pillText).toContain("Northbound");
  });

  it("labels each serving line", async () => {
    const panel = await import("~/components/nearby/NearbyPanel");
    getLocationLadder().applySpoof({ latitude: 43.6709, longitude: -79.3857, accuracyMeters: 10 });
    renderInProvider(() => <panel.NearbyPanel />);

    await waitFor(() => expect(screen.getByText("Bloor-Yonge")).toBeDefined());

    const badges = document.querySelectorAll<HTMLSpanElement>('[role="img"][aria-label^="Line "]');
    expect(badges.length).toBe(2);
    // Bloor-Yonge serves Lines 1 and 2, in fixture order.
    expect(badges[0].getAttribute("aria-label")).toBe("Line 1");
    expect(badges[1].getAttribute("aria-label")).toBe("Line 2");

    expect(badges[0].textContent).toContain("1");
    expect(badges[1].textContent).toContain("2");
  });

  it("renders favourited stations under the Favourites heading even when outside the nearby radius", async () => {
    setPanelData({
      mergedNearby: [],
      savedStations: [
        { ...stationFixture(), id: "99998", stationName: "Finch", distanceMeters: 18_000 },
      ],
    });

    const panel = await import("~/components/nearby/NearbyPanel");
    getLocationLadder().applySpoof({ latitude: 43.6709, longitude: -79.3857, accuracyMeters: 10 });

    const { container } = renderInProvider(() => <panel.NearbyPanel />, {
      seed: (prefs) =>
        prefs.setPreference("favouriteStations", (prev) => [
          ...prev,
          { agencyId: "sample", stationName: "Finch" },
        ]),
    });

    await waitFor(() => expect(screen.getByText("Favourites")).toBeDefined());
    await waitFor(() => expect(screen.getByText("Finch")).toBeDefined());

    const stationCards = container.querySelectorAll('[data-testid="station-arrival-card"]');
    expect(stationCards.length).toBe(1);
    // The inaccurate route-only heading is gone
    expect(screen.queryByText("Favourite Routes")).toBeNull();
  });

  it("interleaves subway stations and surface routes in one nearest-first list", async () => {
    // Interleaved distances across kinds: route 120 < station 300 < route
    // 450 < station 900. Sectioned rendering would cluster both stations
    // ahead of both routes instead.
    setPanelData({
      mergedNearby: [
        routeFixture("52", "52", "Alderwood Stop", 120),
        { ...stationFixture(), id: "99901", stationName: "Museum", distanceMeters: 300 },
        routeFixture("63", "63", "Regent Stop", 450),
        { ...stationFixture(), id: "99902", stationName: "Wilson", distanceMeters: 900 },
      ],
    });

    const panel = await import("~/components/nearby/NearbyPanel");
    getLocationLadder().applySpoof({ latitude: 43.6709, longitude: -79.3857, accuracyMeters: 10 });
    const { container } = renderInProvider(() => <panel.NearbyPanel />);

    for (const label of ["Alderwood Stop", "Museum", "Regent Stop", "Wilson"]) {
      await waitFor(() => expect(screen.getByText(label)).toBeDefined());
    }

    // One behavior fact: cards ascend by walking distance regardless of
    // kind — route, station, route, station — in document order.
    const text = container.textContent ?? "";
    expect(text.indexOf("Alderwood Stop")).toBeLessThan(text.indexOf("Museum"));
    expect(text.indexOf("Museum")).toBeLessThan(text.indexOf("Regent Stop"));
    expect(text.indexOf("Regent Stop")).toBeLessThan(text.indexOf("Wilson"));

    expect(container.querySelectorAll('[data-testid="station-arrival-card"]').length).toBe(2);
  });

  it("orders nearby routes purely by distance even when a favourite route is farther", async () => {
    // Deliberately unsorted payload: farther favourite first.
    setPanelData({
      mergedNearby: [
        routeFixture("52", "52", "Near Stop", 120),
        routeFixture("300", "300", "Far Stop", 1400),
      ],
    });

    const panel = await import("~/components/nearby/NearbyPanel");
    getLocationLadder().applySpoof({ latitude: 43.6709, longitude: -79.3857, accuracyMeters: 10 });

    const { container } = renderInProvider(() => <panel.NearbyPanel />, {
      seed: (prefs) =>
        prefs.setPreference("favouriteSurfaceRoutes", (prev) => [
          ...prev,
          { agencyId: "sample", routeId: "300" },
        ]),
    });

    await waitFor(() => expect(screen.getByText("Near Stop")).toBeDefined());
    await waitFor(() => expect(screen.getByText("Far Stop")).toBeDefined());

    const text = container.textContent ?? "";
    expect(text.indexOf("Near Stop")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Near Stop")).toBeLessThan(text.indexOf("Far Stop"));
  });
  it("keeps the Sample Transit station card and adds a co-located GO station card when Sample Transit is selected", async () => {
    mockGetAgenciesForPoint.mockReturnValue([
      { manifest: { id: "sample" } },
      { manifest: { id: "regional" } },
    ] as unknown as ReturnType<typeof import("../../src/agencies/registry").getAgenciesForPoint>);
    setPanelData({
      mergedNearby: [
        stationFixture(),
        {
          ...stationFixture(),
          id: "UN",
          stationName: "Hub Station GO",
          agencyId: "regional",
          lineIds: ["LW"],
          lineName: "Lakeshore West",
          routeType: "rail",
          arrivals: [],
          arrivalsStale: true,
        },
      ],
    });

    const panel = await import("~/components/nearby/NearbyPanel");
    getLocationLadder().applySpoof({ latitude: 43.6455, longitude: -79.3806, accuracyMeters: 10 });
    const { container } = renderInProvider(() => <panel.NearbyPanel />);

    await waitFor(() => expect(screen.getByText(/Hub Station GO/)).toBeDefined());
    expect(screen.getByText("Bloor-Yonge")).toBeDefined();
    expect(screen.getByText("Live departures unavailable")).toBeDefined();
    expect(container.querySelectorAll('[data-testid="agency-badge"]').length).toBe(2);
  });

  it("surfaces delayed live data when nearby cards remain available", async () => {
    setPanelData({
      mergedNearby: [{ ...routeFixture("97", "97", "Yonge Stop", 120), arrivalsStale: true }],
    });

    const panel = await import("~/components/nearby/NearbyPanel");
    getLocationLadder().applySpoof({ latitude: 43.6709, longitude: -79.3857, accuracyMeters: 10 });
    renderInProvider(() => <panel.NearbyPanel />);

    await waitFor(() => expect(screen.getByText("Live departure data delayed")).toBeDefined());
    expect(screen.getByText("Live departures unavailable")).toBeDefined();
    expect(screen.queryByText("No active departures")).toBeNull();
  });

  it("renders each external GO line as its own card with a visible line designator", async () => {
    mockGetAgenciesForPoint.mockReturnValue([
      { manifest: { id: "sample" } },
      { manifest: { id: "regional" } },
    ] as unknown as ReturnType<typeof import("../../src/agencies/registry").getAgenciesForPoint>);
    setPanelData({
      mergedNearby: [
        stationFixture(),
        {
          ...stationFixture(),
          id: "UN",
          stationName: "Hub Station GO",
          agencyId: "regional",
          lineIds: ["LW"],
          lineName: "Lakeshore West",
          routeType: "rail",
          arrivals: [],
          arrivalsStale: true,
        },
        {
          ...stationFixture(),
          id: "UN:MI",
          stationName: "Hub Station GO",
          agencyId: "regional",
          lineIds: ["MI"],
          lineName: "Milton",
          routeType: "rail",
          arrivals: [],
          arrivalsStale: true,
        },
        {
          ...stationFixture(),
          id: "UN:KI",
          stationName: "Hub Station GO",
          agencyId: "regional",
          lineIds: ["KI"],
          lineName: "Kitchener",
          routeType: "rail",
          arrivals: [],
          arrivalsStale: true,
        },
      ],
    });

    const panel = await import("~/components/nearby/NearbyPanel");
    getLocationLadder().applySpoof({ latitude: 43.6455, longitude: -79.3806, accuracyMeters: 10 });
    const { container } = renderInProvider(() => <panel.NearbyPanel />);

    await waitFor(() => expect(screen.getByText("Lakeshore West at Hub Station GO")).toBeDefined());
    expect(screen.getByText("Milton at Hub Station GO")).toBeDefined();
    expect(screen.getByText("Kitchener at Hub Station GO")).toBeDefined();

    const goCards = [...container.querySelectorAll('[data-testid="station-arrival-card"]')].filter(
      (card) => card.textContent?.includes("Hub Station GO"),
    );
    expect(goCards).toHaveLength(3);
    for (const lineId of ["LW", "MI", "KI"]) {
      const badge = screen.getByRole("img", { name: `Line ${lineId}` });
      expect(badge).toBeDefined();
      expect(badge.textContent).toContain(lineId);
    }
  });

  it("keeps selected-agency subway cards collapsed and lets cross-agency rail cards expand", async () => {
    mockGetAgenciesForPoint.mockReturnValue([
      { manifest: { id: "sample" } },
      { manifest: { id: "regional" } },
    ] as unknown as ReturnType<typeof import("../../src/agencies/registry").getAgenciesForPoint>);
    setPanelData({
      mergedNearby: [
        stationFixture(),
        {
          ...stationFixture(),
          id: "UN",
          stationName: "Hub Station GO",
          agencyId: "regional",
          lineIds: ["LW"],
          routeType: "rail",
          arrivals: [],
          arrivalsStale: true,
        },
      ],
    });

    const panel = await import("~/components/nearby/NearbyPanel");
    getLocationLadder().applySpoof({ latitude: 43.6455, longitude: -79.3806, accuracyMeters: 10 });
    const { container } = renderInProvider(() => <panel.NearbyPanel />);

    await waitFor(() => expect(screen.getByText("Hub Station GO")).toBeDefined());
    const accordions = [...container.querySelectorAll<HTMLElement>("[aria-expanded]")];
    expect(accordions).toHaveLength(1);
    const ttcCard = screen
      .getByText("Bloor-Yonge")
      .closest('[data-testid="station-arrival-card"]')!;
    const goCard = screen
      .getByText("Hub Station GO")
      .closest('[data-testid="station-arrival-card"]')!;
    expect(ttcCard.querySelector("[aria-expanded]")).toBeNull();
    const goAccordion = goCard.querySelector<HTMLElement>("[aria-expanded]")!;
    expect(goAccordion.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(goAccordion);
    // Writes are staged to the next microtask; commit synchronously before
    // asserting DOM state.
    flush();
    expect(goAccordion.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("station-route-strip-skeleton")).toBeDefined();
  });

  it("lets cross-agency Sample Transit subway and selected-agency GO rail cards expand when GO is selected", async () => {
    mockGetAgenciesForPoint.mockReturnValue([
      { manifest: { id: "sample" } },
      { manifest: { id: "regional" } },
    ] as unknown as ReturnType<typeof import("../../src/agencies/registry").getAgenciesForPoint>);
    setPanelData({
      mergedNearby: [
        stationFixture(),
        {
          ...stationFixture(),
          id: "UN",
          stationName: "Hub Station GO",
          agencyId: "regional",
          lineIds: ["LW"],
          routeType: "rail",
          arrivals: [],
          arrivalsStale: true,
        },
      ],
    });

    const panel = await import("~/components/nearby/NearbyPanel");
    getLocationLadder().applySpoof({ latitude: 43.6455, longitude: -79.3806, accuracyMeters: 10 });
    const { container } = renderInProvider(() => <panel.NearbyPanel />, {
      selectedAgency: "regional",
    });

    await waitFor(() => expect(screen.getByText("Bloor-Yonge")).toBeDefined());
    const accordions = [...container.querySelectorAll<HTMLElement>("[aria-expanded]")];
    expect(accordions).toHaveLength(2);
    for (const stationName of ["Bloor-Yonge", "Hub Station GO"]) {
      const card = screen.getByText(stationName).closest('[data-testid="station-arrival-card"]')!;
      const accordion = card.querySelector<HTMLElement>("[aria-expanded]")!;
      expect(accordion.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(accordion);
      flush();
      expect(accordion.getAttribute("aria-expanded")).toBe("true");
      expect(card.querySelector('[data-testid="station-route-strip-skeleton"]')).not.toBeNull();
    }
  });
});

describe("NearbyPanel failure semantics", () => {
  it("raises the connection-error banner on a stations-only outage and never renders an empty-state", async () => {
    // Surface side succeeds with zero routes (a legitimate empty), while the
    // subway stations feed is down.
    setPanelData({ mergedNearby: [], fetchError: "stations down" });

    const panel = await import("~/components/nearby/NearbyPanel");
    getLocationLadder().applySpoof({ latitude: 43.6709, longitude: -79.3857, accuracyMeters: 10 });
    renderInProvider(() => <panel.NearbyPanel />);

    await waitFor(() => expect(screen.getByText("Connection issue")).toBeDefined(), {
      timeout: 5000,
    });

    // An outage must never masquerade as an all-clear empty state.
    expect(screen.queryByText("Outside Sample Transit Service Area")).toBeNull();
    expect(screen.queryByText("No nearby surface routes")).toBeNull();
  });
});

describe("NearbyPanel outside-coverage empty state", () => {
  it("names no agency when the fix is outside every declared bound", async () => {
    setPanelData({ mergedNearby: [], isOutsideServiceArea: true, isOutsideCoverage: true });

    const panel = await import("~/components/nearby/NearbyPanel");
    // Mid-ocean, never inside a present or future agency bound.
    getLocationLadder().applySpoof({ latitude: 0, longitude: -30, accuracyMeters: 10 });
    renderInProvider(() => <panel.NearbyPanel />);

    await waitFor(() => expect(screen.getByText("No nearby stops")).toBeDefined());
    expect(screen.queryByText("No nearby Sample Transit stops")).toBeNull();
    expect(screen.getByText(/outside the service area/)).toBeDefined();
  });

  it("keeps the agency-scoped copy when inside coverage with no stops nearby", async () => {
    setPanelData({ mergedNearby: [], isOutsideServiceArea: true, isOutsideCoverage: false });

    const panel = await import("~/components/nearby/NearbyPanel");
    getLocationLadder().applySpoof({ latitude: 43.6709, longitude: -79.3857, accuracyMeters: 10 });
    renderInProvider(() => <panel.NearbyPanel />);

    await waitFor(() => expect(screen.getByText("No nearby Sample Transit stops")).toBeDefined());
  });
});

describe("NearbyPanel saved-query lifecycle", () => {
  const cases = [
    {
      kind: "stations",
      preferenceKey: "favouriteStations" as const,
      favouriteLabel: "Finch",
      seedFavourites: [{ agencyId: "sample", stationName: "Finch" }],
      savedPayload: () => [
        { ...stationFixture(), id: "99998", stationName: "Finch", distanceMeters: 18_000 },
      ],
    },
    {
      kind: "routes",
      preferenceKey: "favouriteSurfaceRoutes" as const,
      favouriteLabel: "Favourite Stop",
      seedFavourites: [{ agencyId: "sample", routeId: "300" }],
      savedPayload: () => [routeFixture("300", "300", "Favourite Stop", 900)],
    },
  ];

  it.each(cases)(
    "emptying $kind favourites mid-session clears their cards from Favourites",
    async ({ preferenceKey, favouriteLabel, seedFavourites, savedPayload }) => {
      // Nearby feeds return empty so each seeded favourite renders under the
      // Favourites section only.
      if (preferenceKey === "favouriteStations") {
        setPanelData({ mergedNearby: [], savedStations: savedPayload() });
      } else {
        setPanelData({ mergedNearby: [], savedArrivals: savedPayload() });
      }

      const panel = await import("~/components/nearby/NearbyPanel");
      getLocationLadder().applySpoof({
        latitude: 43.6709,
        longitude: -79.3857,
        accuracyMeters: 10,
      });

      function LifecycleHarness() {
        const prefs = useUserPreferences();
        return (
          <>
            <button type="button" onClick={() => prefs.setPreference(preferenceKey, () => [])}>
              Remove favourite
            </button>
            <panel.NearbyPanel />
          </>
        );
      }

      renderInProvider(() => <LifecycleHarness />, {
        seed: (prefs) => prefs.setPreference(preferenceKey, seedFavourites as never),
      });

      // Seeded favourite renders under the Favourites heading.
      await waitFor(() => expect(screen.getByText(favouriteLabel)).toBeDefined());
      expect(screen.getByText("Favourites")).toBeDefined();

      // Mid-session removal drops the kind from >0 to empty…
      fireEvent.click(screen.getByText("Remove favourite"));

      // …so its stale cached cards must not linger under Favourites
      // (stale cache kept them alive after the gate flipped off).
      await waitFor(() => expect(screen.queryByText("Favourites")).toBeNull());
      expect(screen.queryByText(favouriteLabel)).toBeNull();

      // Stays gone — no late resurrection on a subsequent tick.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.queryByText("Favourites")).toBeNull();
      expect(screen.queryByText(favouriteLabel)).toBeNull();
    },
  );
});

describe("computeListArmed", () => {
  it("stays disarmed until open with location and idle queries", async () => {
    const panel = await import("~/components/nearby/NearbyPanel");
    expect(panel.computeListArmed(false, false, true, true, false)).toBe(false);
    expect(panel.computeListArmed(false, true, false, true, false)).toBe(false);
    expect(panel.computeListArmed(false, true, true, false, false)).toBe(false);
    expect(panel.computeListArmed(false, true, true, true, false)).toBe(true);
  });

  it("latches open across background refetches and closes with the panel", async () => {
    const panel = await import("~/components/nearby/NearbyPanel");
    expect(panel.computeListArmed(true, true, true, false, false)).toBe(true);
    expect(panel.computeListArmed(true, false, true, true, false)).toBe(false);
  });
});
