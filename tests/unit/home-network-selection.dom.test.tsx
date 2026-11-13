// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { I18nProvider, useI18n } from "~/i18n/I18nContext";
import Home from "~/routes/index";
import { HELP_DISMISSED_STORAGE_KEY } from "~/components/HelpMode";
import { UserPreferencesProvider } from "~/context/UserPreferencesContext";
import { createLocationLadder } from "~/domain/location/locationLadder";
import { DEFAULT_PREFERENCES, encodeUserPreferences } from "~/domain/preferences/UserPreferences";
import { PREFERENCES_STORAGE_KEY } from "~/infrastructure/storage/PreferencesStorage";
import { makeTestProvider } from "../helpers/agency-fixtures";
import { installMemoryLocalStorage } from "../helpers/local-storage";
import { queryClient } from "~/lib/queryClient";
import { fetchRouteTracking } from "~/services/surface/SurfaceClient";
import type { RouteTrackingData } from "~/domain/surface/types";
import type { InterchangeFocus } from "~/components/map/interchange-navigation";
import type { RouteEnlargeRequest, TargetedRouteTracking } from "~/lib/routeTrackingLifecycle";

vi.mock("@solidjs/meta", () => ({ Title: () => null }));
vi.mock("~/agencies/agencyCatalog", async () => ({
  agencyCatalog: (await import("../helpers/agency-fixtures")).testAgencyCatalog,
}));
vi.mock("~/agencies/interchanges", () => ({ interchanges: [] }));
vi.mock("~/components/map/NetworkMap", () => ({
  NetworkMap: (props: {
    provider: { manifest: { name: string } };
    onEnlargeRoute: (request: RouteEnlargeRequest) => void;
    tracking: TargetedRouteTracking;
    onTemporaryAgencyView: (focus: InterchangeFocus) => void;
  }) => (
    <>
      <div aria-label="Network map">{props.provider.manifest.name}</div>
      <FormattingProbe />
      <button
        onClick={() => props.onEnlargeRoute({ agencyId: "alpha", routeId: "R1", directionId: 0 })}
      >
        Enlarge test route
      </button>
      <button
        onClick={() =>
          props.onTemporaryAgencyView({
            agencyId: "beta",
            stationId: "beta-hub",
            stationName: "Beta Hub",
            screenScale: 1,
            origin: { agencyId: "alpha", stationId: "alpha-hub" },
          })
        }
      >
        View connecting network
      </button>
      <output aria-label="Tracked route">{props.tracking.data()?.route.longName}</output>
    </>
  ),
}));
vi.mock("~/services/surface/SurfaceClient", () => ({ fetchRouteTracking: vi.fn() }));
vi.mock("~/components/BottomPillNav", () => ({
  BottomPillNav: () => <nav aria-label="Network panels" />,
}));
vi.mock("~/hooks/useGeolocation", () => ({
  useGeolocation: () => ({ coords: () => null }),
  getLocationLadder: vi.fn(),
}));
vi.mock("~/lib/snapshotGating", () => ({ useSnapshotGating: () => () => true }));

beforeEach(() => {
  installMemoryLocalStorage();
  localStorage.setItem(HELP_DISMISSED_STORAGE_KEY, "1");
  queryClient.clear();
  vi.mocked(fetchRouteTracking).mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      Response.json({
        agencyId: String(input).split("/").pop(),
        generatedAt: Date.now(),
        freshness: "live",
        alerts: [],
      }),
    ),
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mountHome() {
  const ladder = createLocationLadder({
    now: Date.now,
    requestPosition: null,
    spoofGateActive: false,
  });
  render(() => (
    <UserPreferencesProvider>
      <Home
        providers={() => [makeTestProvider({ id: "alpha", name: "Alpha Transit" })]}
        locationLadder={ladder}
      />
    </UserPreferencesProvider>
  ));
  return ladder;
}

it("shows the fictional guide before requiring a network selection", async () => {
  localStorage.removeItem(HELP_DISMISSED_STORAGE_KEY);
  const ladder = mountHome();
  expect(await screen.findByRole("dialog", { name: "How to use Schematic" })).toBeTruthy();
  expect(screen.getByText("Sablewood station")).toBeTruthy();
  expect(screen.queryByLabelText("Network map")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Got it" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByRole("button", { name: "Alpha Transit" })).toBeTruthy();
  ladder.dispose();
});

it("shows a chooser without map, status, panels or agency requests, then persists a manual network", async () => {
  const ladder = mountHome();
  expect(screen.getByText("Choose your transit network")).toBeTruthy();
  expect(screen.queryByLabelText("Network map")).toBeNull();
  expect(screen.queryByLabelText("Network panels")).toBeNull();
  expect(screen.queryByRole("img", { name: /Live status/ })).toBeNull();
  await waitFor(() => expect(screen.getByRole("button", { name: "Alpha Transit" })).toBeTruthy());
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Alpha Transit" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Network map").textContent).toBe("Alpha Transit"),
  );
  await waitFor(() =>
    expect(JSON.parse(localStorage.getItem(PREFERENCES_STORAGE_KEY)!).agency).toBe("alpha"),
  );
  ladder.dispose();
});

it("restores a saved manual network after preference hydration without a location", async () => {
  localStorage.setItem(
    PREFERENCES_STORAGE_KEY,
    encodeUserPreferences({ ...DEFAULT_PREFERENCES, agency: "alpha" }),
  );
  const ladder = mountHome();
  await waitFor(() =>
    expect(screen.getByLabelText("Network map").textContent).toBe("Alpha Transit"),
  );
  expect(screen.queryByText("Choose your transit network")).toBeNull();
  ladder.dispose();
});

const trackingData: RouteTrackingData = {
  route: {
    id: "R1",
    shortName: "R1",
    longName: "Alpha Route",
    routeType: "bus",
    color: "#112233",
    textColor: "#ffffff",
  },
  shape: {
    id: "shape-r1",
    routeId: "R1",
    directionId: 0,
    headsign: "East",
    polyline: "[]",
    minLat: 43,
    maxLat: 44,
    minLon: -80,
    maxLon: -79,
    pointCount: 2,
  },
  stops: [],
  vehicles: [],
  alerts: [],
};

function mountLocatedHome() {
  let latitude = 43.5;
  let longitude = -79.5;
  const ladder = createLocationLadder({
    now: Date.now,
    permissions: null,
    spoofGateActive: false,
    requestPosition: (success) => success({ coords: { latitude, longitude } }),
  });
  ladder.request();
  const providers = [
    makeTestProvider({ id: "alpha", name: "Alpha Transit" }),
    makeTestProvider({
      id: "beta",
      name: "Beta Transit",
      bounds: [{ minLat: 45, maxLat: 46, minLon: -78, maxLon: -77 }],
    }),
  ];
  render(() => (
    <UserPreferencesProvider>
      <Home providers={() => providers} locationLadder={ladder} />
    </UserPreferencesProvider>
  ));
  return {
    ladder,
    moveTo(lat: number, lon: number) {
      latitude = lat;
      longitude = lon;
      ladder.request();
    },
  };
}

it.each(["alpha", "beta"])(
  "clears targeted mode and stops route polling before choosing %s after coverage is lost",
  async (nextAgency) => {
    vi.mocked(fetchRouteTracking).mockResolvedValue(trackingData);
    const { ladder, moveTo } = mountLocatedHome();
    await waitFor(() =>
      expect(screen.getByLabelText("Network map").textContent).toBe("Alpha Transit"),
    );
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    fireEvent.click(screen.getByRole("button", { name: "Enlarge test route" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Tracked route").textContent).toBe("Alpha Route"),
    );
    expect(screen.queryByLabelText("Alpha Transit transit status")).toBeNull();

    moveTo(60, -79.5);
    await waitFor(() => expect(screen.getByText("Choose your transit network")).toBeTruthy());
    expect(screen.getByLabelText("Schematic transit status")).toBeTruthy();
    const trackingCalls = vi.mocked(fetchRouteTracking).mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchRouteTracking).toHaveBeenCalledTimes(trackingCalls);

    fireEvent.click(
      screen.getByRole("button", {
        name: nextAgency === "alpha" ? "Alpha Transit" : "Beta Transit",
      }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Network map").textContent).toBe(
        nextAgency === "alpha" ? "Alpha Transit" : "Beta Transit",
      ),
    );
    expect(screen.getByLabelText("Tracked route").textContent).toBe("");
    expect(
      screen.getByLabelText(
        nextAgency === "alpha" ? "Alpha Transit transit status" : "Beta Transit transit status",
      ),
    ).toBeTruthy();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchRouteTracking).toHaveBeenCalledTimes(trackingCalls);
    ladder.dispose();
  },
);

it.each(["location", "interchange"])(
  "ends targeted mode when the displayed network changes through %s",
  async (transition) => {
    vi.mocked(fetchRouteTracking).mockResolvedValue(trackingData);
    const { ladder, moveTo } = mountLocatedHome();
    await waitFor(() =>
      expect(screen.getByLabelText("Network map").textContent).toBe("Alpha Transit"),
    );
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    fireEvent.click(screen.getByRole("button", { name: "Enlarge test route" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Tracked route").textContent).toBe("Alpha Route"),
    );
    if (transition === "location") moveTo(45.5, -77.5);
    else fireEvent.click(screen.getByRole("button", { name: "View connecting network" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Network map").textContent).toBe("Beta Transit"),
    );
    expect(screen.getByLabelText("Tracked route").textContent).toBe("");
    expect(screen.getByLabelText(/^Beta Transit transit status/)).toBeTruthy();
    const calls = vi.mocked(fetchRouteTracking).mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchRouteTracking).toHaveBeenCalledTimes(calls);
    moveTo(43.5, -79.5);
    ladder.dispose();
  },
);

function FormattingProbe() {
  const i18n = useI18n();
  return (
    <output aria-label="Resolved formats">
      {i18n.formatLocale()} {i18n.unitSystem()}
    </output>
  );
}

it("uses the rider's location country despite a US browser and a manually selected foreign network", async () => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-US"]);
  localStorage.setItem(
    PREFERENCES_STORAGE_KEY,
    encodeUserPreferences({ ...DEFAULT_PREFERENCES, agency: "foreign" }),
  );
  const local = makeTestProvider({ id: "local", name: "Local Transit" });
  const foreign = makeTestProvider({
    id: "foreign",
    name: "Foreign Transit",
    bounds: [{ minLat: 30, maxLat: 31, minLon: -100, maxLon: -99 }],
  });
  const providers = [
    { ...local, manifest: { ...local.manifest, jurisdiction: { country: "CA" } } },
    { ...foreign, manifest: { ...foreign.manifest, jurisdiction: { country: "US" } } },
  ];
  let latitude = 43.5;
  let longitude = -79.5;
  const ladder = createLocationLadder({
    now: Date.now,
    permissions: null,
    spoofGateActive: false,
    requestPosition: (success) => success({ coords: { latitude, longitude } }),
  });
  ladder.request();
  render(() => (
    <UserPreferencesProvider>
      <I18nProvider>
        <Home providers={() => providers} locationLadder={ladder} />
      </I18nProvider>
    </UserPreferencesProvider>
  ));
  await waitFor(() =>
    expect(screen.getByLabelText("Network map").textContent).toBe("Foreign Transit"),
  );
  expect(screen.getByLabelText("Resolved formats").textContent).toBe("en-CA metric");
  latitude = 30.5;
  longitude = -99.5;
  ladder.request();
  await waitFor(() =>
    expect(screen.getByLabelText("Resolved formats").textContent).toBe("en-US imperial"),
  );
  ladder.dispose();
});
