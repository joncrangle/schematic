// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flush } from "solid-js";
import { NetworkMap } from "~/components/map/NetworkMap";
import { allProviders } from "~/agencies/browserRegistry";
import { UserPreferencesProvider } from "~/context/UserPreferencesContext";
import { AgencySessionProvider } from "~/context/AgencySessionContext";
import {
  NearbyCoordinationProvider,
  createNearbyCoordination,
} from "~/context/NearbyCoordinationContext";
import { createShellSession } from "~/lib/shellSession";
import { createNearbyFocusAdapter } from "~/components/nearby/nearbyFocus";
import { createMockAgencySession } from "../helpers/mockAgencySession";
import { stubInitialResizeObserver } from "../helpers/resize-observer";
import { queryClient } from "~/lib/queryClient";
import { makeAlert } from "../helpers/fixtures";
import type { AgencySnapshot } from "~/agencies/types";

vi.mock("~/agencies/browserRegistry", async () => {
  const { makeTestProvider, makeTestNetwork, makeStationSchematic } =
    await import("../helpers/agency-fixtures");
  const providers = [
    makeTestProvider({ id: "local", shortName: "L" }, makeTestNetwork()),
    makeTestProvider(
      {
        id: "regional",
        name: "Regional Rail",
        shortName: "R",
        modes: ["rail"],
        stationService: { routeType: "rail" },
      },
      makeStationSchematic(["North", "Terminus"], "R"),
    ),
  ];
  return {
    allProviders: () => providers.map((provider) => ({ ...provider, hasLiveAlerts: true })),
    getAgencyById: (id: string) => providers.find((provider) => provider.manifest.id === id),
    interchanges: [
      {
        id: "walking-hub",
        endpoints: [
          { agencyId: "local", stationId: "hub", stationName: "Hub" },
          {
            agencyId: "regional",
            stationId: "north",
            stationName: "North",
            walkingMarkers: { local: { dx: -120, dy: 80, label: "Regional North" } },
          },
        ],
        badgeOffsets: { local: { dx: -190, dy: 80 }, regional: { dx: 0, dy: -24 } },
      },
    ],
  };
});
vi.mock("~/components/map/SpoofDrawer", () => ({ SpoofDrawer: () => null }));
vi.mock("~/components/nearby/NearbyFloatingPill", () => ({ NearbyFloatingPill: () => null }));
vi.mock("~/components/nearby/StationDeparturesSection", () => ({
  StationDeparturesSection: (props: { agencyId: string; stationId: string }) => (
    <div>
      {props.agencyId}/{props.stationId}
    </div>
  ),
}));

beforeEach(() => {
  queryClient.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        agencyId: "regional",
        generatedAt: Date.now(),
        freshness: "live",
        alerts: [],
      }),
    ),
  );
});

afterEach(() => {
  cleanup();
  queryClient.cancelQueries();
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderWalkingMap(onSwitch = vi.fn()) {
  // The viewport fits from the ResizeObserver's first entry; happy-dom does not
  // deliver it, so the map would never become ready without this stub.
  stubInitialResizeObserver(1200, 800);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 1200, 800),
  );
  const coordination = createNearbyCoordination(createShellSession(), createNearbyFocusAdapter());
  return render(() => (
    <UserPreferencesProvider>
      <AgencySessionProvider session={createMockAgencySession({ agencyId: "local" })}>
        <NearbyCoordinationProvider value={coordination}>
          <NetworkMap
            provider={allProviders()[0]!}
            projection={{
              statusOverlaySegments: [],
              stationSeverities: new Map(),
              stationAccessibilityOutages: new Set(),
            }}
            interchangeBadgeVisibility={() => "compact"}
            onTemporaryAgencyView={onSwitch}
          />
        </NearbyCoordinationProvider>
      </AgencySessionProvider>
    </UserPreferencesProvider>
  ));
}

it("opens the peer station card without switching, and switches only through its agency badge", async () => {
  const onSwitch = vi.fn();
  const { getByRole, getByText, queryByRole } = renderWalkingMap(onSwitch);
  fireEvent.click(getByRole("button", { name: /^Regional North, North station, line R,/ }));
  flush();
  await vi.waitFor(() =>
    expect(getByRole("dialog", { name: "North station details" })).toBeTruthy(),
  );
  expect(getByText("regional/north")).toBeTruthy();
  expect(onSwitch).not.toHaveBeenCalled();
  fireEvent.keyDown(getByRole("dialog", { name: "North station details" }), { key: "Escape" });
  flush();
  expect(queryByRole("dialog", { name: "North station details" })).toBeNull();
  fireEvent.click(getByRole("button", { name: "Switch to Regional Rail at North" }));
  flush();
  expect(onSwitch).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ agencyId: "regional", stationId: "north" }),
  );
});

it("loads alerts only for the selected peer and keeps pending evidence unavailable", async () => {
  let resolveSnapshot!: (response: Response) => void;
  const fetchSnapshot = vi.fn(
    (_input: RequestInfo | URL) =>
      new Promise<Response>((resolve) => {
        resolveSnapshot = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetchSnapshot);
  const { getByRole, getByText, queryByText } = renderWalkingMap();
  flush();
  expect(fetchSnapshot).not.toHaveBeenCalled();
  expect(getByRole("button", { name: /^Regional North, North station,/ }).textContent).toContain(
    "Live alerts unavailable",
  );
  fireEvent.click(getByRole("button", { name: /^Regional North, North station,/ }));
  flush();
  await vi.waitFor(() => expect(fetchSnapshot).toHaveBeenCalledOnce());
  expect(String(fetchSnapshot.mock.calls[0]?.[0])).toBe("/api/snapshot/regional?locale=en-CA");
  expect(getByText("Live alerts unavailable")).toBeTruthy();
  expect(queryByText("Normal Service")).toBeNull();
  resolveSnapshot(
    Response.json({
      agencyId: "regional",
      generatedAt: Date.now(),
      freshness: "live",
      alerts: [
        makeAlert({
          title: "Regional station disruption",
          scope: "station",
          affectedStations: [{ stationId: "north", stationName: "North" }],
          affectedLineIds: ["R"],
        }),
      ],
    } satisfies AgencySnapshot),
  );
  await vi.waitFor(() => expect(getByText("Regional station disruption")).toBeTruthy());
  expect(getByRole("button", { name: /^Regional North, North station,/ }).textContent).toContain(
    "Delays reported",
  );
  expect(queryByText("Live alerts unavailable")).toBeNull();
  fireEvent.keyDown(getByRole("dialog", { name: "North station details" }), { key: "Escape" });
  flush();
  fireEvent.click(getByRole("button", { name: /^North station, line 2,/ }));
  flush();
  expect(queryByText("Regional station disruption")).toBeNull();
});

it.each(["stale", "failed"])("does not claim a peer all-clear from %s evidence", async (state) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      state === "failed"
        ? new Response("upstream unavailable", { status: 503 })
        : Response.json({
            agencyId: "regional",
            generatedAt: Date.now(),
            freshness: "stale",
            alerts: [],
          }),
    ),
  );
  const { getByRole, getByText, queryByText } = renderWalkingMap();
  fireEvent.click(getByRole("button", { name: /^Regional North, North station,/ }));
  flush();
  await vi.waitFor(() =>
    expect(Boolean(queryClient.getQueryState(["snapshot", "regional", "en-CA"])?.error)).toBe(
      state === "failed",
    ),
  );
  await vi.waitFor(() =>
    expect(
      getByText(
        state === "failed" ? "Live alerts unavailable" : "Service alerts may be out of date",
      ),
    ).toBeTruthy(),
  );
  expect(queryByText("Normal Service")).toBeNull();
});
