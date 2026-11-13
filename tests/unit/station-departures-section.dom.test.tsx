// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { queryClient } from "~/lib/queryClient";
import { STATION_DEPARTURES_KEY } from "~/hooks/useStationDepartures";
import { StationDeparturesSection } from "~/components/nearby/StationDeparturesSection";
import { StationPopover } from "~/components/map/StationPopover";
import { StationArrivalCard } from "~/components/nearby/StationArrivalCard";
import { UserPreferencesProvider } from "~/context/UserPreferencesContext";
import { createMemoryPreferencesStorage } from "~/infrastructure/storage/PreferencesStorage";
import { makeStationSchematic } from "../helpers/agency-fixtures";

import { buildMapModel } from "~/core/map";
import type { NearbyStationArrival } from "~/domain/surface/types";

const railMap = buildMapModel(makeStationSchematic(["Campus", "Terminus"], "R1"));
const originalWindowFetch = Object.getOwnPropertyDescriptor(window, "fetch");
const campusStation = (() => {
  const candidate = railMap.stationsById.get("campus");
  if (!candidate) throw new Error("Sample schematic fixture must contain Campus");
  return candidate;
})();

function stubFetch(payload: unknown) {
  const fetch = vi.fn(async () => ({ ok: true, json: async () => payload }) as Response);
  stubBrowserFetch(fetch);
}

function stubBrowserFetch(fetch: typeof globalThis.fetch) {
  vi.stubGlobal("fetch", fetch);
  Object.defineProperty(window, "fetch", {
    configurable: true,
    writable: true,
    value: fetch,
  });
}

const liveGroups = [
  {
    lineIds: ["LW"],
    arrivals: [{ directionId: 0, label: "Eastbound", times: [Date.now() + 240_000] }],
  },
];

const denseUnionGroups = [
  {
    lineIds: ["BR"],
    lineName: "Barrie",
    arrivals: [
      {
        directionId: 0,
        label: "Barrie",
        lineId: "BR",
        times: [Date.now() + 60_000, Date.now() + 180_000, Date.now() + 300_000],
      },
    ],
  },
  {
    lineIds: ["KI"],
    lineName: "Kitchener",
    arrivals: [
      {
        directionId: 0,
        label: "Kitchener",
        times: [Date.now() + 120_000, Date.now() + 240_000, Date.now() + 360_000],
      },
    ],
  },
  {
    lineIds: ["KI"],
    lineName: "Kitchener",
    arrivals: [
      {
        directionId: 1,
        label: "Outbound",
        lineId: "KI",
        times: [Date.now() + 240_000, Date.now() + 480_000],
      },
    ],
  },
  {
    lineIds: ["LE"],
    lineName: "Lakeshore East",
    arrivals: [
      {
        directionId: 0,
        label: "Lakeshore East",
        times: [Date.now() + 300_000, Date.now() + 600_000, Date.now() + 900_000],
      },
    ],
  },
  {
    lineIds: ["LE"],
    lineName: "Lakeshore East",
    arrivals: [
      {
        directionId: 1,
        label: "Outbound",
        times: [Date.now() + 1_140_000, Date.now() + 2_640_000, Date.now() + 4_320_000],
      },
    ],
  },
  {
    lineIds: ["LW"],
    lineName: "Lakeshore West",
    arrivals: [
      {
        directionId: 0,
        label: "Lakeshore West",
        times: [Date.now() + 360_000, Date.now() + 780_000],
      },
    ],
  },
  {
    lineIds: ["MI"],
    lineName: "Milton",
    arrivals: [
      { directionId: 0, label: "Milton", times: [Date.now() + 420_000, Date.now() + 1_020_000] },
    ],
  },
  {
    lineIds: ["RH"],
    lineName: "Richmond Hill",
    arrivals: [
      {
        directionId: 0,
        label: "Richmond Hill",
        times: [Date.now() + 540_000, Date.now() + 1_200_000],
      },
    ],
  },
];

function emptyCard(): NearbyStationArrival {
  return {
    id: "99999",
    stationName: "Bloor-Yonge",
    lineIds: ["1", "2"],
    agencyId: "ttc",
    distanceMeters: 320,
    walkingMinutes: 4,
    arrivals: [],
  };
}

beforeEach(() => {
  queryClient.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (originalWindowFetch) {
    Object.defineProperty(window, "fetch", originalWindowFetch);
  }
  queryClient.clear();
});

describe("StationDeparturesSection", () => {
  it("keeps an expanded nearby train card restricted to its lines when the station response includes buses", async () => {
    stubFetch([
      {
        lineIds: ["R1", "42"],
        arrivals: [
          {
            directionId: 0,
            label: "Train destination",
            lineId: "R1",
            times: [Date.now() + 60_000],
          },
          { directionId: 1, label: "Bus destination", lineId: "42", times: [Date.now() + 120_000] },
        ],
      },
    ]);
    render(() => (
      <UserPreferencesProvider storage={createMemoryPreferencesStorage()}>
        <StationArrivalCard
          station={{
            ...emptyCard(),
            agencyId: "sample",
            id: "campus",
            stationName: "Campus",
            routeType: "rail",
            lineIds: ["R1"],
          }}
          allowExpand
          isExpanded
        />
      </UserPreferencesProvider>
    ));
    expect(await screen.findByText("Train destination")).toBeDefined();
    expect(screen.queryByText("Bus destination")).toBeNull();
    expect(screen.queryByLabelText("Line 42")).toBeNull();
  });
  it("labels each bus departure when a station also has a separate rail group", async () => {
    stubFetch([
      { lineIds: ["R1"], lineName: "Rail", arrivals: [] },
      {
        lineIds: ["42", "57"],
        arrivals: [
          { directionId: 0, label: "Southbound", lineId: "42", times: [Date.now() + 60_000] },
          { directionId: 0, label: "Southbound", lineId: "57", times: [Date.now() + 120_000] },
        ],
      },
    ]);
    render(() => <StationDeparturesSection agencyId="regional" stationId="campus" />);

    const rows = await screen.findAllByTestId("direction-arrivals-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector('[aria-label="Line 42"]')).not.toBeNull();
    expect(rows[1]?.querySelector('[aria-label="Line 57"]')).not.toBeNull();
  });

  it("does not imply no scheduled service when only tracked trains are predicted", async () => {
    stubFetch([{ lineIds: ["R1"], arrivals: [], livePredictionsOnly: true }]);
    render(() => <StationDeparturesSection agencyId="regional" stationId="campus" />);
    expect(await screen.findByText("No live predictions available")).toBeDefined();
    expect(
      screen.getByText(
        "Only tracked departures appear. Check the operator's timetable for scheduled service.",
      ),
    ).toBeDefined();
    expect(screen.queryByText("No active departures")).toBeNull();
  });
  it("renders rows from the departures source under the given header", async () => {
    stubFetch(liveGroups);

    render(() => (
      <StationDeparturesSection agencyId="regional" stationId="campus" header="Regional Transit" />
    ));

    expect(await screen.findByText("Regional Transit")).toBeDefined();
    expect(await screen.findByText("Eastbound")).toBeDefined();
  });

  it("marks stale groups as last known while keeping their times", async () => {
    stubFetch([{ ...liveGroups[0], arrivalsStale: true }]);

    render(() => <StationDeparturesSection agencyId="regional" stationId="campus" />);

    expect(await screen.findByText("Last known")).toBeDefined();
    expect(await screen.findByText("Eastbound")).toBeDefined();
  });

  it("says no departures when the source answers empty", async () => {
    stubFetch([]);

    render(() => <StationDeparturesSection agencyId="regional" stationId="campus" />);

    expect(await screen.findByText("No active departures")).toBeDefined();
  });

  it("shows loading while departures are in flight, then settles the request", async () => {
    let settleFetch!: (response: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => {
      settleFetch = resolve;
    });
    const fetch = vi.fn(() => pendingFetch);
    stubBrowserFetch(fetch);

    render(() => <StationDeparturesSection agencyId="regional" stationId="campus" />);

    expect(screen.getByText("Loading departures…")).toBeDefined();
    expect(screen.queryByText("No active departures")).toBeNull();

    settleFetch({ ok: true, json: async () => [] } as Response);
    expect(await screen.findByText("No active departures")).toBeDefined();
  });

  it("shows loading while refreshing an empty departure result", async () => {
    let settleRefresh!: (response: Response) => void;
    const pendingRefresh = new Promise<Response>((resolve) => {
      settleRefresh = resolve;
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce({ ok: true, json: async () => [] } as Response)
      .mockImplementationOnce(() => pendingRefresh);
    stubBrowserFetch(fetch);

    render(() => <StationDeparturesSection agencyId="regional" stationId="old-station" />);

    expect(await screen.findByText("No active departures")).toBeDefined();
    void queryClient.invalidateQueries({
      queryKey: STATION_DEPARTURES_KEY("regional", "old-station"),
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

    expect(await screen.findByText("Loading departures…")).toBeDefined();
    expect(screen.queryByText("No active departures")).toBeNull();

    settleRefresh({ ok: true, json: async () => [] } as Response);
    expect(await screen.findByText("No active departures")).toBeDefined();
  });
});

describe("StationPopover departures", () => {
  it("renders a dense interchange as one set of direction rows", async () => {
    stubFetch(denseUnionGroups);

    render(() => (
      <UserPreferencesProvider storage={createMemoryPreferencesStorage()}>
        <StationPopover
          agencyId="regional"
          name="Union"
          station={campusStation}
          coords={{ x: 100, y: 100 }}
          containerSize={{ width: 320, height: 640 }}
          onClose={() => {}}
          setRef={() => {}}
          alerts={[]}
          linesById={railMap.linesById}
          departureSections={[{ agencyId: "regional", stationId: "union", header: "Union" }]}
        />
      </UserPreferencesProvider>
    ));

    const content = await screen.findByTestId("station-popover-content");
    await screen.findAllByText("Barrie");
    expect(content).toBeDefined();

    const rows = screen.getAllByTestId("direction-arrivals-row");
    expect(rows).toHaveLength(denseUnionGroups.length);
    expect(screen.getAllByTestId("arrival-times")).toHaveLength(denseUnionGroups.length);
    expect(
      rows.every((row) => row.querySelector('[data-testid="station-line-badges"]') === null),
    ).toBe(true);
  });

  it("keeps row badges when a single departure group contains multiple routes", async () => {
    stubFetch([
      {
        lineIds: ["BR", "KI"],
        arrivals: [
          {
            directionId: 0,
            label: "Outbound",
            lineId: "BR",
            times: [Date.now() + 60_000],
          },
          {
            directionId: 1,
            label: "Inbound",
            lineId: "KI",
            times: [Date.now() + 120_000],
          },
        ],
      },
    ]);

    render(() => <StationDeparturesSection agencyId="regional" stationId="union" />);

    const rows = await screen.findAllByTestId("direction-arrivals-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector('[aria-label="Line BR"]')).not.toBeNull();
    expect(rows[1]?.querySelector('[aria-label="Line KI"]')).not.toBeNull();
  });

  it("shows a route badge on named terminal rows in a single-line group", async () => {
    stubFetch([
      {
        lineIds: ["1"],
        arrivals: [
          {
            directionId: 0,
            label: "→ Vaughan Metropolitan Centre",
            lineId: "1",
            times: [Date.now() + 60_000],
          },
          {
            directionId: 1,
            label: "→ Finch",
            lineId: "1",
            times: [Date.now() + 120_000],
          },
        ],
      },
    ]);

    render(() => <StationDeparturesSection agencyId="ttc" stationId="union" />);

    const rows = await screen.findAllByTestId("direction-arrivals-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector('[aria-label="Line 1"]')).not.toBeNull();
    expect(rows[1]?.querySelector('[aria-label="Line 1"]')).not.toBeNull();
  });

  it("shows one labeled section per serving agency", async () => {
    stubFetch(liveGroups);

    render(() => (
      <UserPreferencesProvider storage={createMemoryPreferencesStorage()}>
        <StationPopover
          agencyId="regional"
          station={campusStation}
          coords={{ x: 100, y: 100 }}
          containerSize={{ width: 320, height: 640 }}
          onClose={() => {}}
          setRef={() => {}}
          alerts={[]}
          linesById={railMap.linesById}
          departureSections={[
            { agencyId: "regional", stationId: "campus", header: "Regional Transit" },
            { agencyId: "ttc", stationId: "campus", header: "TTC" },
          ]}
        />
      </UserPreferencesProvider>
    ));

    expect(await screen.findByText("Regional Transit")).toBeDefined();
    expect(await screen.findByText("TTC")).toBeDefined();
    expect((await screen.findAllByText("Eastbound")).length).toBe(2);
  });

  it("keeps its previous shape when no departures source exists", async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => liveGroups }) as Response);
    stubBrowserFetch(fetch);

    render(() => (
      <UserPreferencesProvider storage={createMemoryPreferencesStorage()}>
        <StationPopover
          agencyId="regional"
          station={campusStation}
          coords={{ x: 100, y: 100 }}
          containerSize={{ width: 320, height: 640 }}
          onClose={() => {}}
          setRef={() => {}}
          alerts={[]}
          linesById={railMap.linesById}
        />
      </UserPreferencesProvider>
    ));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByTestId("station-departures-section")).toBeNull();
  });
});

describe("StationArrivalCard departures fallback", () => {
  it("recovers rows from the departures source when the bulk payload is empty", async () => {
    stubFetch(liveGroups);

    render(() => (
      <UserPreferencesProvider storage={createMemoryPreferencesStorage()}>
        <StationArrivalCard station={{ ...emptyCard(), lineIds: ["LW"] }} allowExpand isExpanded />
      </UserPreferencesProvider>
    ));

    expect(await screen.findByText("Eastbound")).toBeDefined();
  });

  it("does not fetch fallback departures for a collapsed station card", async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => liveGroups }) as Response);
    stubBrowserFetch(fetch);

    render(() => (
      <UserPreferencesProvider storage={createMemoryPreferencesStorage()}>
        <StationArrivalCard station={emptyCard()} allowExpand />
      </UserPreferencesProvider>
    ));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByTestId("station-departures-section")).toBeNull();
  });

  it("leaves bulk rows alone instead of fetching", async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => liveGroups }) as Response);
    stubBrowserFetch(fetch);

    render(() => (
      <UserPreferencesProvider storage={createMemoryPreferencesStorage()}>
        <StationArrivalCard
          station={{
            ...emptyCard(),
            arrivals: [{ directionId: 1, label: "Southbound", times: [Date.now() + 240_000] }],
          }}
        />
      </UserPreferencesProvider>
    ));

    expect(await screen.findByText("Southbound")).toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the honest static text for stale empty cards instead of refetching", async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => liveGroups }) as Response);
    stubBrowserFetch(fetch);

    render(() => (
      <UserPreferencesProvider storage={createMemoryPreferencesStorage()}>
        <StationArrivalCard station={{ ...emptyCard(), arrivalsStale: true }} />
      </UserPreferencesProvider>
    ));

    expect(await screen.findByText("Live departures unavailable")).toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});
