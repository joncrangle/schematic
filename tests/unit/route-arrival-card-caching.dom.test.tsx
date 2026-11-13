// @vitest-environment happy-dom
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";
import { QueryClientProvider } from "@tanstack/solid-query";
import { queryClient } from "~/lib/queryClient";
import { ROUTE_TRACKING_KEY } from "~/lib/routeTrackingLifecycle";
import { RouteArrivalCard } from "~/components/nearby/RouteArrivalCard";
import { StationArrivalCard } from "~/components/nearby/StationArrivalCard";
import { UserPreferencesProvider } from "~/context/UserPreferencesContext";
import { AgencySessionProvider } from "~/context/AgencySessionContext";
import { I18nProvider } from "~/i18n/I18nContext";
import { fr } from "~/i18n/fr";
import { DEFAULT_PREFERENCES } from "~/domain/preferences/UserPreferences";
import type { PreferencesStorage } from "~/infrastructure/storage/PreferencesStorage";
import { createMockAgencySession } from "../helpers/mockAgencySession";
import type {
  NearbyRouteArrival,
  NearbyStationArrival,
  RouteTrackingData,
} from "~/domain/surface/types";

const mockArrival: NearbyRouteArrival = {
  id: "504",
  routeId: "504",
  routeShortName: "504",
  routeLongName: "King",
  routeType: "streetcar",
  agencyId: "ttc",
  directionId: 0,
  stopId: "15145",
  stopName: "King St West at Spadina Ave",
  stopLat: 43.6453,
  stopLon: -79.3957,
  distanceMeters: 45,
  walkingMinutes: 1,
  headsign: "504A Eastbound to Broadview Station",
  arrivals: [Date.now() + 180_000, Date.now() + 480_000],
  alerts: [],
  directions: [
    {
      directionId: 0,
      label: "Eastbound",
      destination: "Broadview Station",
      headsign: "504A Eastbound to Broadview Station",
      stopId: "15145",
      stopName: "King St West at Spadina Ave",
      stopLat: 43.6453,
      stopLon: -79.3957,
      distanceMeters: 45,
      walkingMinutes: 1,
      arrivals: [Date.now() + 180_000],
    },
    {
      directionId: 1,
      label: "Westbound",
      destination: "Dundas West Station",
      headsign: "504B Westbound to Dundas West Station",
      stopId: "15146",
      stopName: "King St West at Spadina Ave",
      stopLat: 43.6453,
      stopLon: -79.3957,
      distanceMeters: 55,
      walkingMinutes: 1,
      arrivals: [Date.now() + 240_000],
    },
  ],
};

const mockTrackingDataEastbound: RouteTrackingData = {
  route: {
    id: "504",
    shortName: "504",
    longName: "King",
    routeType: "streetcar",
    color: "#da251d",
    textColor: "#ffffff",
  },
  shape: {
    id: "504_0",
    routeId: "504",
    directionId: 0,
    headsign: "Eastbound to Broadview Station",
    polyline: JSON.stringify([
      [43.6453, -79.3957],
      [43.646, -79.39],
    ]),
    minLat: 43.64,
    maxLat: 43.65,
    minLon: -79.4,
    maxLon: -79.38,
    pointCount: 2,
  },
  stops: [
    {
      id: "15145",
      name: "King St West at Spadina Ave",
      lat: 43.6453,
      lon: -79.3957,
      routes: ["504"],
      wheelchair: 1,
    },
    {
      id: "15146",
      name: "King St West at University Ave",
      lat: 43.6475,
      lon: -79.386,
      routes: ["504"],
      wheelchair: 1,
    },
  ],
  vehicles: [
    {
      vehicleId: "4401",
      routeId: "504",
      directionId: 0,
      latitude: 43.644,
      longitude: -79.4,
      currentStopSequence: 1,
      timestamp: Date.now(),
    },
  ],
  alerts: [],
  directionLabels: {
    0: { label: "Eastbound", destination: "Broadview Station" },
    1: { label: "Westbound", destination: "Dundas West Station" },
  },
};

const mockTrackingDataWestbound: RouteTrackingData = {
  ...mockTrackingDataEastbound,
  shape: {
    id: "504_1",
    routeId: "504",
    directionId: 1,
    headsign: "Westbound to Dundas West Station",
    polyline: JSON.stringify([
      [43.6475, -79.386],
      [43.6453, -79.3957],
    ]),
    minLat: 43.64,
    maxLat: 43.65,
    minLon: -79.4,
    maxLon: -79.38,
    pointCount: 2,
  },
  directionLabels: {
    0: { label: "Eastbound", destination: "Broadview Station" },
    1: { label: "Westbound", destination: "Dundas West Station" },
  },
};

beforeEach(() => {
  queryClient.clear();
  if (typeof window !== "undefined" && window.localStorage) {
    window.localStorage.clear();
  }
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  queryClient.clear();
  if (typeof window !== "undefined" && window.localStorage) {
    window.localStorage.clear();
  }
});

function renderCard(props: Parameters<typeof RouteArrivalCard>[0]) {
  const session = createMockAgencySession({ agencyId: "ttc" });
  return render(() => (
    <QueryClientProvider client={queryClient}>
      <UserPreferencesProvider>
        <AgencySessionProvider session={session}>
          <RouteArrivalCard {...props} />
        </AgencySessionProvider>
      </UserPreferencesProvider>
    </QueryClientProvider>
  ));
}

function renderFrenchCard(props: Parameters<typeof RouteArrivalCard>[0]) {
  const session = createMockAgencySession({ agencyId: "ttc" });
  const storage: PreferencesStorage = {
    load: async () => ({ ...DEFAULT_PREFERENCES, locale: "fr-CA" }),
    save: async () => {},
  };
  return render(() => (
    <QueryClientProvider client={queryClient}>
      <UserPreferencesProvider storage={storage}>
        <I18nProvider loadDictionary={async () => fr}>
          <AgencySessionProvider session={session}>
            <RouteArrivalCard {...props} />
          </AgencySessionProvider>
        </I18nProvider>
      </UserPreferencesProvider>
    </QueryClientProvider>
  ));
}

describe("RouteArrivalCard Cache Sharing with TanStack Query", () => {
  it("localizes generated direction labels in French", async () => {
    const arrival: NearbyRouteArrival = {
      ...mockArrival,
      directions: mockArrival.directions!.map((direction) => ({
        ...direction,
        generatedLabel: direction.directionId === 0 ? "eastbound" : "westbound",
      })),
    };

    renderFrenchCard({ arrival, isExpanded: false });

    expect(await screen.findAllByText("Direction est → Broadview Station")).toHaveLength(2);
  });

  it("preserves an operator direction label that happens to be English", async () => {
    const arrival: NearbyRouteArrival = {
      ...mockArrival,
      directions: mockArrival.directions!.map((direction) =>
        direction.directionId === 0
          ? { ...direction, label: "Northbound", destination: "Operator Terminal" }
          : direction,
      ),
    };

    renderFrenchCard({ arrival, isExpanded: false });

    expect(await screen.findAllByText("Northbound → Operator Terminal")).toHaveLength(2);
  });

  // Either direction must render instantly from its cached tracking entry —
  // including direction 1, previously covered by a separate "direction
  // changed" scenario.
  const cachedDirectionRows: Array<[0 | 1, string]> = [
    [0, "Eastbound"],
    [1, "Westbound"],
  ];

  it.each(cachedDirectionRows)(
    "renders %s instantly from TanStack Query cache without showing skeleton when cache exists",
    (directionId) => {
      // Pre-populate queryClient cache as if Enlarged Map had just fetched this route/direction
      queryClient.setQueryData(
        ROUTE_TRACKING_KEY("ttc", "504", directionId),
        directionId === 0 ? mockTrackingDataEastbound : mockTrackingDataWestbound,
      );

      renderCard({
        arrival: mockArrival,
        isExpanded: true,
        selectedDirectionId: directionId,
      });

      // LinearStopStrip should be rendered immediately with stop names
      // (title-scoped: the header row repeats the selected stop's name).
      expect(screen.getByTitle("King St West at Spadina Ave")).toBeDefined();
      expect(screen.getByTitle("King St West at University Ave")).toBeDefined();

      // Route strip skeleton should NOT be present
      expect(screen.queryByTestId("route-strip-skeleton")).toBeNull();
    },
  );

  it("renders cross-agency GO route from TanStack Query cache under its own agencyId", () => {
    const goArrival: NearbyRouteArrival = {
      ...mockArrival,
      id: "LW",
      routeId: "LW",
      routeShortName: "LW",
      routeLongName: "Lakeshore West",
      routeType: "rail",
      agencyId: "go",
    };

    const goTrackingData: RouteTrackingData = {
      ...mockTrackingDataEastbound,
      route: {
        ...mockTrackingDataEastbound.route,
        id: "LW",
        shortName: "LW",
        longName: "Lakeshore West",
        routeType: "rail",
      },
      stops: [
        {
          id: "union-go",
          name: "Union Station GO",
          lat: 43.6453,
          lon: -79.3806,
          routes: ["LW"],
          wheelchair: 1,
        },
      ],
    };

    queryClient.setQueryData(ROUTE_TRACKING_KEY("go", "LW", 0), goTrackingData);

    renderCard({
      arrival: goArrival,
      isExpanded: true,
      selectedDirectionId: 0,
    });

    expect(screen.getByTitle("Union Station GO")).toBeDefined();
    expect(screen.queryByTestId("route-strip-skeleton")).toBeNull();
  });

  it("relays the correct agencyId when triggering onEnlargeRoute from a cross-agency card", () => {
    const onEnlargeRoute = vi.fn();
    const goArrival: NearbyRouteArrival = {
      ...mockArrival,
      id: "LW",
      routeId: "LW",
      routeShortName: "LW",
      routeLongName: "Lakeshore West",
      routeType: "rail",
      agencyId: "go",
      stopId: "union-go",
      directions: [
        {
          ...mockArrival.directions![0],
          stopId: "union-go",
        },
      ],
    };

    queryClient.setQueryData(ROUTE_TRACKING_KEY("go", "LW", 0), {
      ...mockTrackingDataEastbound,
      route: {
        ...mockTrackingDataEastbound.route,
        id: "LW",
        shortName: "LW",
        longName: "Lakeshore West",
        routeType: "rail",
      },
      stops: [
        {
          id: "union-go",
          name: "Union Station GO",
          lat: 43.6453,
          lon: -79.3806,
          routes: ["LW"],
          wheelchair: 1,
        },
      ],
    });

    renderCard({
      arrival: goArrival,
      isExpanded: true,
      selectedDirectionId: 0,
      onEnlargeRoute,
    });

    const enlargeButton = screen.getByText("Enlarge Map");
    fireEvent.click(enlargeButton);

    expect(onEnlargeRoute).toHaveBeenCalledWith({
      routeId: "LW",
      directionId: 0,
      stopId: "union-go",
      agencyId: "go",
    });
  });

  it("shows skeleton placeholder when query cache is empty and isExpanded is true", () => {
    renderCard({
      arrival: mockArrival,
      isExpanded: true,
      selectedDirectionId: 0,
    });

    // Route strip skeleton loader should be present while data loads
    expect(screen.getByTestId("route-strip-skeleton")).toBeDefined();
  });

  it("retains active departure countdowns on collapsed cards", () => {
    renderCard({
      arrival: mockArrival,
      isExpanded: false,
      selectedDirectionId: 0,
    });

    // Should display the route number and long name
    expect(screen.getByText("504")).toBeDefined();
    expect(screen.getByText("King")).toBeDefined();

    // Should not show "No active departures" since mockArrival has arrivals
    expect(screen.queryByText("No active departures")).toBeNull();
  });

  it("derives arrival countdowns from approaching vehicles in cache when GTFS-RT arrivals are empty", () => {
    const arrivalWithoutGtfsTimes: NearbyRouteArrival = {
      ...mockArrival,
      arrivals: [],
      directions: [
        {
          directionId: 0,
          label: "Eastbound",
          destination: "Broadview Station",
          headsign: "504A Eastbound to Broadview Station",
          stopId: "15146",
          stopName: "King St West at University Ave",
          stopLat: 43.6475,
          stopLon: -79.386,
          distanceMeters: 45,
          walkingMinutes: 1,
          arrivals: [],
        },
      ],
    };

    // Pre-cache tracking data with a vehicle at stop 1 (approaching stop 2 / 15146)
    queryClient.setQueryData(ROUTE_TRACKING_KEY("ttc", "504", 0), mockTrackingDataEastbound);

    renderCard({
      arrival: arrivalWithoutGtfsTimes,
      isExpanded: false,
      selectedDirectionId: 0,
    });

    // Should derive departure countdown from vehicle 4401 in cache rather than showing "No active departures"
    expect(screen.queryByText("No active departures")).toBeNull();
  });

  it("does not derive a cached vehicle ETA for a direction removed at a terminal", () => {
    const arrivalWithTerminalDirectionRemoved: NearbyRouteArrival = {
      ...mockArrival,
      arrivals: [],
      directionId: 0,
      directions: [
        {
          ...mockArrival.directions![0],
          arrivals: [],
        },
      ],
    };
    queryClient.setQueryData(ROUTE_TRACKING_KEY("ttc", "504", 1), mockTrackingDataWestbound);

    renderCard({
      arrival: arrivalWithTerminalDirectionRemoved,
      isExpanded: false,
      selectedDirectionId: 1,
    });

    expect(screen.getByText("No active departures")).toBeDefined();
  });

  it("shows no vehicle-derived countdowns when collapsed-row cached vehicles exceed the freshness window", () => {
    // Collapsed rows read the cache without owning renewal, so vehicle
    // positions older than COLLAPSED_TRACKING_MAX_AGE_MS must not derive
    // countdowns. Freeze Date.now() to make the age math deterministic.
    const frozenNow = 1_700_000_000_000;
    vi.useFakeTimers({ now: frozenNow, toFake: ["Date"] });

    const staleFleet: RouteTrackingData = {
      ...mockTrackingDataEastbound,
      vehicles: [
        {
          ...mockTrackingDataEastbound.vehicles[0],
          timestamp: frozenNow - 61_000, // one second past the 60s window
        },
      ],
    };
    queryClient.setQueryData(ROUTE_TRACKING_KEY("ttc", "504", 0), staleFleet);

    const arrivalWithoutGtfsTimes: NearbyRouteArrival = {
      ...mockArrival,
      arrivals: [],
      directions: [
        {
          directionId: 0,
          label: "Eastbound",
          destination: "Broadview Station",
          headsign: "504A Eastbound to Broadview Station",
          stopId: "15145",
          stopName: "King St West at Spadina Ave",
          stopLat: 43.6453,
          stopLon: -79.3957,
          distanceMeters: 45,
          walkingMinutes: 1,
          arrivals: [],
        },
      ],
    };

    renderCard({
      arrival: arrivalWithoutGtfsTimes,
      isExpanded: false,
      selectedDirectionId: 0,
    });

    // The only cached vehicle is too stale to drive a countdown → fallback copy
    expect(screen.getByText("No active departures")).toBeDefined();
  });

  it("renders an expandable station card from a warm tracking cache without a skeleton", () => {
    const station = {
      ...stationFixture("go"),
      lineIds: ["LW"],
      routeType: "rail" as const,
      lat: 43.6453,
      lon: -79.3957,
      // This test is about the cached route strip. Keep a known departure in
      // the fixture so mounting the expanded card does not start an unrelated
      // live-departures request in Happy DOM.
      arrivals: [
        {
          lineId: "LW",
          directionId: 0 as const,
          label: "Westbound",
          times: [Date.now() + 180_000],
        },
      ],
    };
    queryClient.setQueryData(ROUTE_TRACKING_KEY("go", "LW", 0), {
      ...mockTrackingDataEastbound,
      route: {
        ...mockTrackingDataEastbound.route,
        id: "LW",
        shortName: "LW",
        routeType: "rail" as const,
      },
    });

    renderStation({ station, allowExpand: true, isExpanded: true });

    expect(screen.queryByTestId("station-route-strip-skeleton")).toBeNull();
    expect(screen.getByTitle("King St West at Spadina Ave")).toBeDefined();
  });
});

describe("a merged station card tracks the line it names", () => {
  // One card, two modes. `lineIds` names the ION as the route the strip tracks
  // and `arrivals` holds a row per mode, held in time order, so the sooner
  // departure leads the list no matter which mode it belongs to.
  //
  // Each direction of the tracked line has its own cached strip, with a stop
  // name that exists only in that direction. Which names appear is therefore
  // the rider's answer to which direction was tracked, and nothing has to
  // inspect the card's internals to read it.
  const NORTHBOUND_STOP = "Fairview North Only Stop";
  const SOUTHBOUND_STOP = "Cedar South Only Stop";
  const NORTHBOUND_LABEL = "Northbound";
  const SOUTHBOUND_LABEL = "Southbound";

  const trackedData = (directionId: 0 | 1) => ({
    ...mockTrackingDataEastbound,
    shape: { ...mockTrackingDataEastbound.shape, directionId },
    stops: [
      {
        id: directionId === 0 ? "ion-north" : "ion-south",
        name: directionId === 0 ? NORTHBOUND_STOP : SOUTHBOUND_STOP,
        lat: 43.6453,
        lon: -79.3957,
        routes: ["ion"],
        wheelchair: 1,
      },
    ],
    directionLabels: {
      0: { label: NORTHBOUND_LABEL, destination: "Fairway" },
      1: { label: SOUTHBOUND_LABEL, destination: "Conestoga" },
    },
  });

  const mixedModeStation: NearbyStationArrival = {
    ...stationFixture("go"),
    id: "conestoga-idx",
    stationName: "Conestoga Station",
    // The tracked line is first in the list, as mergeCards leaves it.
    lineIds: ["ion", "7"],
    lat: 43.45,
    lon: -80.49,
    arrivals: [
      // The bus departs sooner, so this leads the time-ordered list while
      // belonging to a different mode than the tracked line.
      { lineId: "7", directionId: 0, label: "Eastbound", times: [Date.now() + 60_000] },
      { lineId: "ion", directionId: 1, label: "Southbound", times: [Date.now() + 180_000] },
    ],
  };

  function seedTrackedLine(): void {
    queryClient.setQueryData(ROUTE_TRACKING_KEY("go", "ion", 0), trackedData(0));
    queryClient.setQueryData(ROUTE_TRACKING_KEY("go", "ion", 1), trackedData(1));
  }

  it("follows the tracked line's own direction, not the soonest departure's", () => {
    seedTrackedLine();

    renderStation({ station: mixedModeStation, allowExpand: true, isExpanded: true });

    // The tracked line's row states direction 1, so that is the direction shown,
    // even though the bus row ahead of it in time states direction 0.
    expect(screen.getByTitle(SOUTHBOUND_STOP)).toBeDefined();
    expect(screen.queryByTitle(NORTHBOUND_STOP)).toBeNull();
  });

  it("keeps the rider's own pick for that line", async () => {
    seedTrackedLine();

    renderStation({ station: mixedModeStation, allowExpand: true, isExpanded: true });
    // The rider asks for the other way on the same line. The button's accessible
    // name carries the destination as well as the label.
    fireEvent.click(screen.getByRole("button", { name: new RegExp(NORTHBOUND_LABEL) }));

    await waitFor(() => expect(screen.getByTitle(NORTHBOUND_STOP)).toBeDefined());
    expect(screen.queryByTitle(SOUTHBOUND_STOP)).toBeNull();
  });
});

describe("Last known chip", () => {
  it("renders the Last known chip while the arrivals feed is degraded", () => {
    renderCard({
      arrival: { ...mockArrival, arrivalsStale: true },
      isExpanded: false,
      selectedDirectionId: 0,
    });

    expect(screen.getByText("Last known")).toBeDefined();
  });

  it("omits the chip when the feed is healthy", () => {
    renderCard({
      arrival: mockArrival,
      isExpanded: false,
      selectedDirectionId: 0,
    });

    expect(screen.queryByText("Last known")).toBeNull();
  });

  it("explains when live departures are unavailable without last-known times", () => {
    renderCard({
      arrival: {
        ...mockArrival,
        arrivals: [],
        directions: mockArrival.directions?.map((direction) => ({
          ...direction,
          arrivals: [],
        })),
        arrivalsStale: true,
      },
      isExpanded: false,
      selectedDirectionId: 0,
    });

    expect(screen.getByText("Live departures unavailable")).toBeDefined();
    expect(screen.queryByText("No active departures")).toBeNull();
    expect(screen.queryByText("Last known")).toBeNull();
  });
});

function stationFixture(agencyId = "ttc"): NearbyStationArrival {
  return {
    id: "99999",
    stationName: "Bloor-Yonge",
    lineIds: ["1"],
    agencyId,
    distanceMeters: 100,
    walkingMinutes: 1,
    arrivals: [],
  };
}

function renderStation(cardProps: Parameters<typeof StationArrivalCard>[0]) {
  return render(() => (
    <UserPreferencesProvider>
      <StationArrivalCard {...cardProps} />
    </UserPreferencesProvider>
  ));
}

describe("card name row", () => {
  function railArrival(over: Partial<NearbyRouteArrival> = {}): NearbyRouteArrival {
    return {
      ...mockArrival,
      id: "LW",
      routeId: "LW",
      routeShortName: "LW",
      routeLongName: "Lakeshore West",
      routeType: "rail",
      agencyId: "go",
      stopId: "aldershot",
      stopName: "Aldershot GO",
      directions: [
        {
          directionId: 0,
          label: "Westbound",
          destination: "Aldershot GO",
          headsign: "Westbound to Aldershot GO",
          stopId: "aldershot",
          stopName: "Aldershot GO",
          stopLat: 43.3356,
          stopLon: -79.7129,
          distanceMeters: 120,
          walkingMinutes: 2,
          arrivals: [Date.now() + 240_000],
        },
      ],
      ...over,
    };
  }

  function cardText(cardProps: Parameters<typeof RouteArrivalCard>[0]): string {
    const { container } = renderCard(cardProps);
    return (container.textContent ?? "").replace(/\s+/g, " ").trim();
  }

  it("names a rail card for the station the rider is standing at", () => {
    // The badge is a line code, so the name row beside it has to say where the
    // rider is. "Lakeshore West" names a corridor, not a station.
    const text = cardText({ arrival: railArrival(), showAgencyBadge: true });

    expect(text).toContain("Aldershot GO");
    expect(text).not.toContain("Lakeshore West");
  });

  it("does not print the rail station name twice", () => {
    // The name row owns the station on rail, so the direction row must not
    // repeat it. Asserted on the separator form rather than a bare count:
    // "Aldershot GO" is also a valid destination and legitimately appears in
    // both direction rows, so counting occurrences would pin the destination
    // labels instead of the duplication being guarded against.
    const text = cardText({ arrival: railArrival(), showAgencyBadge: true });

    expect(text).not.toContain("• Aldershot GO");
    expect(text).not.toContain("•Aldershot GO");
  });

  it("keeps the operator's route name on a bus card", () => {
    // A bus badge is a bare number, so the long name is the only thing naming
    // the route, and the station still needs its own row.
    const text = cardText({ arrival: mockArrival, showAgencyBadge: true });

    expect(text).toContain("King");
    expect(text).toContain("King St West at Spadina Ave");
  });

  it("falls back to the corridor when a rail station has no name", () => {
    const text = cardText({
      arrival: railArrival({ stopName: "", directions: [] }),
      showAgencyBadge: true,
    });

    expect(text).toContain("Lakeshore West");
  });

  it("leaves no dangling separator when a rail direction states no headsign", () => {
    const text = cardText({
      arrival: railArrival({
        headsign: "",
        directions: [
          {
            directionId: 0,
            label: "",
            destination: "",
            headsign: "",
            stopId: "aldershot",
            stopName: "Aldershot GO",
            stopLat: 43.3356,
            stopLon: -79.7129,
            distanceMeters: 120,
            walkingMinutes: 2,
            arrivals: [Date.now() + 240_000],
          },
        ],
      }),
      showAgencyBadge: true,
    });

    expect(text).not.toContain("•");
  });
});

describe("agency pill / badge", () => {
  it.each([
    { kind: "route" as const, agencyId: "ttc", expectedLabel: "TTC" },
    { kind: "route" as const, agencyId: "go", expectedLabel: "GO" },
    { kind: "station" as const, agencyId: "ttc", expectedLabel: "TTC" },
    { kind: "station" as const, agencyId: "go", expectedLabel: "GO" },
    { kind: "route" as const, agencyId: "yrt", expectedLabel: "YRT" },
  ])(
    "$kind cards expose the requested $agencyId agency identity",
    ({ kind, agencyId, expectedLabel }) => {
      if (kind === "route") {
        renderCard({
          arrival: { ...mockArrival, agencyId },
          showAgencyBadge: true,
          selectedDirectionId: 0,
        });
      } else {
        renderStation({ station: stationFixture(agencyId), showAgencyBadge: true });
      }

      expect(screen.getByTestId("agency-badge").textContent).toBe(expectedLabel);
    },
  );

  it("uses the same TTC badge styling for route and station cards", () => {
    renderCard({ arrival: mockArrival, showAgencyBadge: true, selectedDirectionId: 0 });
    const routeBadgeStyle = screen.getByTestId("agency-badge").getAttribute("style");
    cleanup();

    renderStation({ station: stationFixture("ttc"), showAgencyBadge: true });
    expect(screen.getByTestId("agency-badge").getAttribute("style")).toBe(routeBadgeStyle);
  });

  it.each(["route", "station"] as const)("omits the %s badge by default", (kind) => {
    if (kind === "route") {
      renderCard({ arrival: mockArrival, selectedDirectionId: 0 });
    } else {
      renderStation({ station: stationFixture("ttc") });
    }

    expect(screen.queryByTestId("agency-badge")).toBeNull();
  });
});

describe("route badge colours", () => {
  // Deliberately not the contrast-computed text colour for this background, so
  // the assertion can only pass when the feed's own text colour is applied.
  const feedColours = { routeColor: "#123456", routeTextColor: "#fedcba" };

  function routeBadgeFor(shortName: string): HTMLElement {
    const badge = screen.getByText(shortName).closest<HTMLElement>("[style]");
    if (!badge) throw new Error(`no styled badge around ${shortName}`);
    return badge;
  }

  it("renders the route badge with the feed's text colour, not the contrast-computed one", () => {
    renderCard({
      arrival: { ...mockArrival, ...feedColours },
      isExpanded: false,
      selectedDirectionId: 0,
    });

    const badge = routeBadgeFor("504");
    expect(getComputedStyle(badge).backgroundColor).toBe(feedColours.routeColor);
    expect(getComputedStyle(badge).color).toBe(feedColours.routeTextColor);
  });

  it("takes both colours from the tracked route when the arrival carries none", () => {
    queryClient.setQueryData(ROUTE_TRACKING_KEY("ttc", "504", 0), {
      ...mockTrackingDataEastbound,
      route: {
        ...mockTrackingDataEastbound.route,
        color: feedColours.routeColor,
        textColor: feedColours.routeTextColor,
      },
    });

    renderCard({ arrival: mockArrival, isExpanded: false, selectedDirectionId: 0 });

    const badge = routeBadgeFor("504");
    expect(getComputedStyle(badge).backgroundColor).toBe(feedColours.routeColor);
    expect(getComputedStyle(badge).color).toBe(feedColours.routeTextColor);
  });
});

it("expands a schematic station through its canonical feed route", () => {
  const station = {
    ...stationFixture("fixture-intercity"),
    stationName: "Central",
    lineIds: ["corridor"],
    trackingRouteId: "feed-route-123",
    livePredictionsOnly: true,
    arrivals: [
      {
        lineId: "corridor",
        directionId: 0 as const,
        label: "Train 123",
        times: [Date.now() + 60_000],
      },
    ],
  };
  queryClient.setQueryData(ROUTE_TRACKING_KEY("fixture-intercity", "feed-route-123", 0), {
    ...mockTrackingDataEastbound,
    route: { ...mockTrackingDataEastbound.route, id: "feed-route-123" },
    stops: [
      {
        id: "central",
        name: "Canonical Route Stop",
        lat: 44,
        lon: -76,
        routes: ["feed-route-123"],
        wheelchair: 1,
      },
    ],
  });
  renderStation({ station, allowExpand: true, isExpanded: true });
  expect(screen.getByTitle("Canonical Route Stop")).toBeDefined();
  expect(screen.queryByTestId("station-route-strip-skeleton")).toBeNull();
});
