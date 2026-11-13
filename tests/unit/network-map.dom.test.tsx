// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent as baseFireEvent } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import type { RouteEnlargeRequest } from "~/lib/routeTrackingLifecycle";

const fireEvent = new Proxy(baseFireEvent, {
  get(target, prop, receiver) {
    const orig = Reflect.get(target, prop, receiver);
    if (typeof orig === "function") {
      return (...args: unknown[]) => {
        const result = (orig as Function).apply(target, args);
        flush();
        return result;
      };
    }
    return orig;
  },
});

vi.mock("~/components/nearby/NearbyFloatingPill", () => ({
  NearbyFloatingPill: (props: { onEnlargeRoute?: (request: RouteEnlargeRequest) => void }) => (
    <button
      type="button"
      aria-label="Enlarge test route"
      onClick={() =>
        props.onEnlargeRoute?.({
          agencyId: "sample",
          routeId: "504",
          directionId: 0,
          stopId: "king",
        })
      }
    />
  ),
}));
import { makeTestNetwork, makeTestProvider } from "../helpers/agency-fixtures";

import {
  deriveMapProjection,
  buildMapModel,
  type MapProjection,
  type StatusOverlaySegment,
} from "~/core/map";
import { NetworkMap } from "~/components/map/NetworkMap";
import { StatusSegmentPath } from "~/components/map/StatusSegmentPath";
import { renderableSegments } from "~/components/map/renderableSegments";
import { encodePolyline } from "~/domain/map/MapGeometry";
import type { RouteTrackingData } from "~/domain/surface/types";
import { type TargetedRouteTracking } from "~/lib/routeTrackingLifecycle";
import {
  NearbyCoordinationProvider,
  createNearbyCoordination,
} from "~/context/NearbyCoordinationContext";
import { createNearbyFocusAdapter } from "~/components/nearby/nearbyFocus";
import { createShellSession } from "~/lib/shellSession";
import { UserPreferencesProvider } from "~/context/UserPreferencesContext";
import { AgencySessionProvider } from "~/context/AgencySessionContext";
import { createMockAgencySession } from "../helpers/mockAgencySession";
import { stubInitialResizeObserver } from "../helpers/resize-observer";

const sampleSchematic = makeTestNetwork();
const sampleProvider = makeTestProvider({}, sampleSchematic);

beforeEach(() => {
  // Station hover warms the departures cache. The hook's HTTP behavior is
  // covered in use-station-departures.test.tsx; keep this map suite offline.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => [] }) as Response),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sampleTopology = buildMapModel(sampleSchematic);
const mapCamera = sampleTopology.camera;

const MIN_ZOOM = sampleSchematic.viewport.minZoom;
const MAX_ZOOM = sampleSchematic.viewport.maxZoom;
const INITIAL_ZOOM = sampleTopology.initialZoom;

// Live-sheet projection: one reduced-speed zone on Line 1 between West
// and Hub, built through the public snapshot interpreter.
const westLawrenceRsz = deriveMapProjection(
  {
    agencyId: "sample",
    generatedAt: 0,
    freshness: "live",
    alerts: [
      {
        id: "rsz-west-hub",
        kind: "slow-service",
        severity: "degraded",
        lifecycle: "active",
        scope: "segment",
        affectedLineIds: ["1"],
        fromStation: { stationId: "west", stationName: "West" },
        toStation: { stationId: "hub", stationName: "Hub" },
        title: "Reduced speed zone",
        description: "Reduced speed zone",
        startsAt: 0,
        updatedAt: 0,
      },
    ],
  },
  sampleTopology,
);

const projection = westLawrenceRsz;
const fullInterchangeBadgeVisibility = () => "full" as const;

const segmentOnLine1: StatusOverlaySegment = {
  id: "seg-line1-union-stgeorge",
  kind: "rsz",
  lineId: "1",
  lineName: "Line 1",
  lineColor: "#000000",
  fromStation: "Union",
  toStation: "St. George",
  note: "",
  pathD: "M 10 10 L 20 20",
  midpoint: { x: 15, y: 15 },
};

const pulsingAlertProjection: MapProjection = {
  statusOverlaySegments: [
    { ...segmentOnLine1, id: "delay-a", kind: "delay" },
    { ...segmentOnLine1, id: "delay-b", kind: "delay" },
    { ...segmentOnLine1, id: "severe-a", kind: "severe", pathD: "M 50 50 L 60 60" },
  ],
  stationSeverities: new Map(),
  stationAccessibilityOutages: new Set(),
};

function hasDirectTitle(g: SVGGElement): boolean {
  return Array.from(g.children).some((child) => child.localName === "title");
}

function groupWithTitle(container: HTMLElement, text: string): SVGGElement | undefined {
  return Array.from(container.querySelectorAll("g")).find(
    (g) => hasDirectTitle(g) && g.querySelector("title")?.textContent?.includes(text),
  );
}

function strokeOpacities(g: SVGGElement): string[] {
  return Array.from(g.querySelectorAll("path"))
    .filter((path) => path.getAttribute("stroke") !== "transparent")
    .map((path) => path.getAttribute("opacity") ?? "")
    .sort();
}

function stubElementRect(width = 1200, height = 800): void {
  // Happy DOM does not deliver the browser's initial ResizeObserver event.
  stubInitialResizeObserver(width, height);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        width,
        height,
        left: 0,
        top: 0,
        right: width,
        bottom: height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  );
}

function makeCoordination() {
  const session = createShellSession();
  return createNearbyCoordination(session, createNearbyFocusAdapter());
}

function mountMap(provider = sampleProvider) {
  const session = createShellSession();
  const coordination = createNearbyCoordination(session, createNearbyFocusAdapter());
  const ui = render(() => (
    <UserPreferencesProvider>
      <AgencySessionProvider session={createMockAgencySession({ agencyId: "sample" })}>
        <NearbyCoordinationProvider value={coordination}>
          <NetworkMap
            provider={provider}
            projection={projection}
            interchangeBadgeVisibility={fullInterchangeBadgeVisibility}
            onTemporaryAgencyView={() => {}}
          />
        </NearbyCoordinationProvider>
      </AgencySessionProvider>
    </UserPreferencesProvider>
  ));
  return { setNearbyOpen: session.setNearbyOpen, ...ui };
}

function makeTargetedTrackingData(directionId: number): RouteTrackingData {
  return {
    route: {
      id: "504",
      shortName: "504",
      longName: "King",
      routeType: "streetcar",
      color: "#da251d",
      textColor: "#ffffff",
    },
    shape: {
      id: `504_${directionId}`,
      routeId: "504",
      directionId,
      headsign: directionId === 0 ? "Eastbound" : "Westbound",
      polyline: "",
      minLat: 43.65,
      maxLat: 43.69,
      minLon: -79.47,
      maxLon: -79.3,
      pointCount: 2,
    },
    stops: [],
    vehicles: [],
    alerts: [],
  };
}

function mountTargetedMap(props: {
  tracking?: TargetedRouteTracking;
  onClearTargetedRoute?: () => void;
}) {
  return render(() => (
    <UserPreferencesProvider>
      <AgencySessionProvider session={createMockAgencySession({ agencyId: "sample" })}>
        <NearbyCoordinationProvider value={makeCoordination()}>
          <NetworkMap
            provider={sampleProvider}
            projection={projection}
            interchangeBadgeVisibility={fullInterchangeBadgeVisibility}
            tracking={props.tracking}
            onClearTargetedRoute={props.onClearTargetedRoute}
            onTemporaryAgencyView={() => {}}
          />
        </NearbyCoordinationProvider>
      </AgencySessionProvider>
    </UserPreferencesProvider>
  ));
}

describe("Subway Map Geometry & Component Logic", () => {
  it("should compute dynamic fitTransform that fits the entire map width and height", () => {
    // The shipped default camera must start inside the schematic's zoom
    // bounds, otherwise every mount begins clamped.
    expect(INITIAL_ZOOM).toBeGreaterThanOrEqual(MIN_ZOOM);
    expect(INITIAL_ZOOM).toBeLessThanOrEqual(MAX_ZOOM);

    const mobileFit = mapCamera.computeFitTransform(390, 844)!;
    expect(mobileFit.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
    expect(mobileFit.pan).toBeDefined();

    const desktopFit = mapCamera.computeFitTransform(1920, 1080)!;
    expect(desktopFit.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
    expect(desktopFit.pan).toBeDefined();
  });

  it("should accurately convert points between map and container space", () => {
    const originalMapPoint = { x: 1350, y: 1100 };
    const camera = { width: 800, height: 600, zoom: 2.5, pan: { x: 100, y: -50 } };

    const containerPoint = mapCamera.transformMapPointToContainer(originalMapPoint, camera);
    expect(containerPoint).toBeDefined();

    const invertedMapPoint = mapCamera.transformContainerPointToMap(containerPoint!, camera);
    expect(invertedMapPoint).toBeDefined();
    expect(invertedMapPoint!.x).toBeCloseTo(originalMapPoint.x, 2);
    expect(invertedMapPoint!.y).toBeCloseTo(originalMapPoint.y, 2);
  });
});

describe("StatusSegmentPath selected-line dimming", () => {
  it.each([
    {
      hovered: null as string | null,
      expected: ["0.9"],
      because: "no selection keeps the dashed slow-zone stroke at full opacity",
    },
    {
      hovered: "1" as string | null,
      expected: ["0.9"],
      because: "the slow zone's own line selected keeps the dashed stroke at full opacity",
    },
    {
      hovered: "2" as string | null,
      expected: ["0"],
      because: "another line selected hides the slow-zone stroke entirely",
    },
  ])("slow zone on line 1 with selected line $hovered -> $because", ({ hovered, expected }) => {
    const [hoveredLineId] = createSignal<string | null>(hovered);

    const { container } = render(() => (
      <StatusSegmentPath
        segment={segmentOnLine1}
        isSelected={() => false}
        onToggle={() => {}}
        hoveredLineId={hoveredLineId}
      />
    ));

    const opacities = Array.from(container.querySelectorAll("path"))
      .filter((path) => path.getAttribute("stroke") !== "transparent")
      .map((path) => path.getAttribute("opacity") ?? "")
      .sort();
    expect(opacities).toEqual(expected);
  });
});

describe("StatusSegmentPath slow-zone styling", () => {
  it.each([
    {
      kind: "rsz" as const,
      strokeWidth: "10",
      dasharray: "10 14",
      opacity: "0.9",
      haloCount: 0,
      because: "slow zones render dashed, halo-free, slightly narrower than warnings",
    },
    {
      kind: "delay" as const,
      strokeWidth: "12",
      dasharray: null,
      opacity: "0.9",
      haloCount: 1,
      because: "delays keep the thick solid warning stroke with halo",
    },
  ])("$kind segment -> $because", ({ kind, strokeWidth, dasharray, opacity, haloCount }) => {
    const { container } = render(() => (
      <StatusSegmentPath
        segment={{ ...segmentOnLine1, id: `${kind}-style`, kind }}
        isSelected={() => false}
        onToggle={() => {}}
      />
    ));

    const strokes = Array.from(container.querySelectorAll("path")).filter(
      (path) => path.getAttribute("stroke") !== "transparent",
    );
    expect(strokes).toHaveLength(haloCount + 1);

    const core = strokes.at(-1)!;
    expect(core.getAttribute("stroke-width")).toBe(strokeWidth);
    expect(core.getAttribute("stroke-dasharray")).toBe(dasharray);
    expect(core.getAttribute("opacity")).toBe(opacity);
  });
});

describe("NetworkMap selected-line dimming end-to-end", () => {
  it("keeps the line dimming stable when a hovered badge is clicked and the pointer leaves", () => {
    const { container } = mountMap(
      makeTestProvider(
        {},
        {
          ...sampleSchematic,
          badges: [{ line: "2", num: "2", x: 400, y: 20, color: "#654321", textColor: "#FFFFFF" }],
        },
      ),
    );
    const badge = container.querySelector<SVGGElement>('g[aria-label="Highlight line 2"]');
    const line1 = groupWithTitle(container, "Line 1");
    expect(badge).not.toBeNull();
    expect(line1).toBeDefined();

    fireEvent.pointerEnter(badge!, { pointerType: "mouse" });
    expect(strokeOpacities(line1!)).toEqual(["0.2"]);
    fireEvent.click(badge!);
    expect(strokeOpacities(line1!)).toEqual(["0.2"]);
    fireEvent.pointerLeave(badge!, { pointerType: "mouse" });
    expect(strokeOpacities(line1!)).toEqual(["0.2"]);

    fireEvent.pointerEnter(badge!, { pointerType: "mouse" });
    fireEvent.click(badge!);
    expect(strokeOpacities(line1!)).toEqual(["0.95"]);
  });

  it("clicking Line 2 dims Line 1's static slow-zone segment along with its line", () => {
    const { container } = render(() => (
      <UserPreferencesProvider>
        <AgencySessionProvider session={createMockAgencySession({ agencyId: "sample" })}>
          <NearbyCoordinationProvider value={makeCoordination()}>
            <NetworkMap
              provider={sampleProvider}
              projection={projection}
              interchangeBadgeVisibility={fullInterchangeBadgeVisibility}
              onTemporaryAgencyView={() => {}}
            />
          </NearbyCoordinationProvider>
        </AgencySessionProvider>
      </UserPreferencesProvider>
    ));

    const rszGroup = groupWithTitle(container, "West to Hub");
    expect(rszGroup).toBeDefined();
    expect(strokeOpacities(rszGroup!)).toEqual(["0.9"]);

    const line1 = groupWithTitle(container, "Line 1");
    const line2 = groupWithTitle(container, "Line 2");
    expect(line1).toBeDefined();
    expect(line2).toBeDefined();

    fireEvent.click(line2!);

    expect(strokeOpacities(rszGroup!)).toEqual(["0"]);
    expect(strokeOpacities(line1!)).toEqual(["0.2"]);
    expect(strokeOpacities(line2!)).toEqual(["0.35", "0.95"]);
  });
});

describe("NetworkMap station selection ownership", () => {
  it("does not create ownerless computations when a station marker is clicked", () => {
    stubElementRect();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = mountMap();
    warn.mockClear();

    const north = container.querySelector<SVGGElement>(
      `g[role="button"][aria-label^="North station,"]`,
    );
    expect(north).not.toBeNull();

    fireEvent.click(north!);

    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("computations created outside a `createRoot` or `render`"),
    );
  });
});

describe("NetworkMap alert animation layers", () => {
  it("updates StatusSegmentPath stroke-width when isSelected changes", () => {
    const [selected, setSelected] = createSignal(false);
    const { container } = render(() => (
      <svg>
        <StatusSegmentPath
          segment={{
            id: "delay-a",
            lineId: "1",
            lineName: "Line 1",
            lineColor: "#E31837",
            fromStation: "Union",
            toStation: "St. George",
            note: "",
            kind: "delay",
            pathD: "M 10 10 L 20 20",
            midpoint: { x: 15, y: 15 },
          }}
          isSelected={() => selected()}
          onToggle={() => setSelected(!selected())}
        />
      </svg>
    ));
    const hitTarget = container.querySelector('path[stroke="transparent"]');
    expect(hitTarget).not.toBeNull();
    const corePath = Array.from(container.querySelectorAll("path")).at(-1);
    expect(corePath?.getAttribute("stroke-width")).toBe("12");

    fireEvent.click(hitTarget!);
    expect(selected()).toBe(true);
    expect(corePath?.getAttribute("stroke-width")).toBe("14");
  });

  it("shares one pulse driver while preserving overlapping segment compositing and clicks", async () => {
    const { container } = render(() => (
      <UserPreferencesProvider>
        <AgencySessionProvider session={createMockAgencySession({ agencyId: "sample" })}>
          <NearbyCoordinationProvider value={makeCoordination()}>
            <NetworkMap
              provider={sampleProvider}
              projection={pulsingAlertProjection}
              interchangeBadgeVisibility={fullInterchangeBadgeVisibility}
              onTemporaryAgencyView={() => {}}
            />
          </NearbyCoordinationProvider>
        </AgencySessionProvider>
      </UserPreferencesProvider>
    ));

    const delayLayer = container.querySelector<SVGGElement>("g.animate-pulse-delay");
    const severeLayer = container.querySelector<SVGGElement>("g.animate-pulse-severe");
    expect(container.querySelectorAll("g.animate-pulse-delay")).toHaveLength(1);
    expect(container.querySelectorAll("g.animate-pulse-severe")).toHaveLength(1);
    expect(delayLayer).not.toBeNull();
    expect(severeLayer).not.toBeNull();

    const delaySegments = Array.from(delayLayer!.children).filter(
      (child) => child.localName === "g",
    ) as SVGGElement[];
    expect(delaySegments).toHaveLength(2);
    expect(
      delaySegments.every(
        (segment) => segment.style.opacity === "var(--status-segment-pulse-opacity, 1)",
      ),
    ).toBe(true);

    const hitTargets = Array.from(
      container.querySelectorAll<SVGPathElement>('path[stroke="transparent"]'),
    );
    expect(hitTargets).toHaveLength(3);

    for (const hitTarget of hitTargets) {
      const segmentGroup = hitTarget.parentElement;
      fireEvent.click(hitTarget);
      await vi.waitFor(() => {
        const corePath = Array.from(segmentGroup?.querySelectorAll("path") ?? []).at(-1);
        expect(corePath?.getAttribute("stroke-width")).toBe("14");
      });
    }
  });
});

describe("NetworkMap user preferences", () => {
  it("throws when rendered without a UserPreferencesProvider", () => {
    stubElementRect();

    expect(() =>
      render(() => (
        <NearbyCoordinationProvider value={makeCoordination()}>
          <NetworkMap
            provider={sampleProvider}
            projection={projection}
            interchangeBadgeVisibility={fullInterchangeBadgeVisibility}
            onTemporaryAgencyView={() => {}}
          />
        </NearbyCoordinationProvider>
      )),
    ).toThrow(/useUserPreferences must be used within a UserPreferencesProvider/);
  });

  it("hides interchange agency badge rows when the preference is hidden", () => {
    stubElementRect();

    const { container } = render(() => (
      <UserPreferencesProvider>
        <AgencySessionProvider session={createMockAgencySession({ agencyId: "sample" })}>
          <NearbyCoordinationProvider value={makeCoordination()}>
            <NetworkMap
              provider={sampleProvider}
              projection={projection}
              interchangeBadgeVisibility={() => "hidden"}
              onTemporaryAgencyView={() => {}}
            />
          </NearbyCoordinationProvider>
        </AgencySessionProvider>
      </UserPreferencesProvider>
    ));

    expect(container.querySelectorAll(".interchange-badge-row")).toHaveLength(0);
  });
});

describe("NetworkMap nearby coordination", () => {
  it("keeps the NetworkMap mounted while Nearby opens", async () => {
    stubElementRect();
    const { container, setNearbyOpen } = mountMap();
    const map = () => container.querySelector('[role="group"][aria-label$="network map"]');

    expect(map()).not.toBeNull();

    setNearbyOpen(true);
    await Promise.resolve();

    expect(map()).not.toBeNull();
  });

  it("throws when rendered without a NearbyCoordinationProvider", () => {
    stubElementRect();

    expect(() =>
      render(() => (
        <NetworkMap
          provider={sampleProvider}
          projection={projection}
          interchangeBadgeVisibility={fullInterchangeBadgeVisibility}
          onTemporaryAgencyView={() => {}}
        />
      )),
    ).toThrow(/useNearbyCoordination must be used within a NearbyCoordinationProvider/);
  });

  it("gates the station popover on the coordinated nearby state", async () => {
    stubElementRect();
    const { container, setNearbyOpen } = mountMap();
    const north = container.querySelector<SVGGElement>(
      `g[role="button"][aria-label^="North station,"]`,
    );
    expect(north).not.toBeNull();

    fireEvent.click(north!);
    await vi.waitFor(() =>
      expect(
        container.querySelector(`[role="dialog"][aria-label="North station details"]`),
      ).not.toBeNull(),
    );

    setNearbyOpen(true);
    flush();
    expect(
      container.querySelector(`[role="dialog"][aria-label="North station details"]`),
    ).toBeNull();

    setNearbyOpen(false);
    flush();
    expect(
      container.querySelector(`[role="dialog"][aria-label="North station details"]`),
    ).not.toBeNull();
  });
});

describe("NetworkMap targeted tracking framing", () => {
  it.each(["stop", "vehicle"])(
    "dismisses the selected %s details when changing route direction",
    async (kind) => {
      stubElementRect();
      const outbound: RouteTrackingData = {
        route: {
          id: "R1",
          shortName: "R1",
          longName: "Transition Route",
          routeType: "bus",
          color: "#123456",
          textColor: "#ffffff",
        },
        shape: {
          id: "r1-outbound",
          routeId: "R1",
          directionId: 0,
          headsign: "East",
          polyline: encodePolyline([
            [43.5, -79.5],
            [43.6, -79.4],
          ]),
          minLat: 43,
          maxLat: 44,
          minLon: -80,
          maxLon: -79,
          pointCount: 2,
        },
        stops: [
          {
            id: "outbound-stop",
            name: "Outbound stop",
            lat: 43.5,
            lon: -79.5,
            wheelchair: 0,
            routes: ["R1"],
          },
        ],
        vehicles: [
          {
            vehicleId: "outbound-vehicle",
            routeId: "R1",
            directionId: 0,
            latitude: 43.55,
            longitude: -79.45,
            timestamp: Date.now(),
          },
        ],
        alerts: [],
        availableDirectionIds: [0, 1],
      };
      const [directionId, setDirectionId] = createSignal(0);
      const [data, setData] = createSignal<RouteTrackingData>(outbound);
      const tracking: TargetedRouteTracking = {
        data,
        isStaleForDirection: () => data().shape.directionId !== directionId(),
        nearestStopId: () => undefined,
        onDataArrival: () => () => {},
        selectDirection: setDirectionId,
        selectedDirectionId: directionId,
        selectedRouteId: () => "R1",
      };
      const { getByText, getByRole, getAllByRole, queryByRole } = mountTargetedMap({ tracking });
      await vi.waitFor(() => expect(getByText("Outbound stop")).toBeTruthy());
      const marker =
        kind === "stop" ? getByText("Outbound stop") : getByText(/R1.*Transition Route/);
      fireEvent.click(marker.closest("g")!);
      await vi.waitFor(() => expect(getByRole("dialog")).toBeTruthy());
      fireEvent.click(
        getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")!,
      );
      expect(getByRole("dialog")).toBeTruthy();
      const otherDirection = getAllByRole("tab").find(
        (tab) => tab.getAttribute("aria-selected") === "false",
      )!;
      fireEvent.click(otherDirection);
      expect(queryByRole("dialog")).toBeNull();
      setData({
        ...outbound,
        shape: { ...outbound.shape, directionId: 1 },
        stops: [],
        vehicles: [],
      });
      flush();
      expect(queryByRole("dialog")).toBeNull();
    },
  );

  it.each(["close button", "Escape", "map background"])(
    "allows leaving targeted mode through %s before its first snapshot arrives",
    async (exit) => {
      stubElementRect();
      const [routeId, setRouteId] = createSignal<string | undefined>("R1");
      const tracking = {
        data: () => null,
        isStaleForDirection: () => false,
        nearestStopId: () => undefined,
        onDataArrival: () => () => {},
        selectDirection: () => {},
        selectedDirectionId: () => (routeId() ? 0 : undefined),
        selectedRouteId: routeId,
      };
      const clear = vi.fn(() => setRouteId(undefined));
      const { getByRole, queryByRole } = mountTargetedMap({
        tracking,
        onClearTargetedRoute: clear,
      });
      await vi.waitFor(() =>
        expect(getByRole("region", { name: "Targeted route mode controls" })).toBeTruthy(),
      );
      if (exit === "close button")
        fireEvent.click(
          getByRole("button", { name: "Close route overlay and return to network map" }),
        );
      else if (exit === "Escape") fireEvent.keyDown(window, { key: "Escape" });
      else fireEvent.click(getByRole("img", { name: /network map/ }));
      expect(clear).toHaveBeenCalledOnce();
      expect(queryByRole("region", { name: "Targeted route mode controls" })).toBeNull();
    },
  );

  it("does not render held geometry while the requested direction is pending", async () => {
    stubElementRect();
    const dir0Base = makeTargetedTrackingData(0);
    const dir1Base = makeTargetedTrackingData(1);
    const dir0 = {
      ...dir0Base,
      shape: {
        ...dir0Base.shape,
        polyline: encodePolyline([
          [0, 0],
          [1, 1],
        ]),
      },
    };
    const dir1 = {
      ...dir1Base,
      shape: {
        ...dir1Base.shape,
        polyline: encodePolyline([
          [2, 2],
          [3, 3],
        ]),
      },
    };
    const [target, setTarget] = createSignal({ routeId: "504", directionId: 0 });
    const [liveData, setLiveData] = createSignal<RouteTrackingData | null>(dir0);
    const tracking: TargetedRouteTracking = {
      data: liveData,
      isStaleForDirection: () => {
        const data = liveData();
        return data !== null && data.shape.directionId !== target().directionId;
      },
      nearestStopId: () => undefined,
      onDataArrival: () => () => {},
      selectDirection: (directionId) => setTarget({ routeId: "504", directionId }),
      selectedDirectionId: () => target().directionId,
    };

    const { container } = mountTargetedMap({ tracking });

    await vi.waitFor(() => {
      expect(container.querySelector(".targeted-route-layer path")).not.toBeNull();
    });

    setTarget({ routeId: "504", directionId: 1 });
    // Solid 2 stages the write: commit before reading staleness/DOM.
    flush();
    expect(tracking.isStaleForDirection()).toBe(true);
    expect(container.querySelector(".targeted-route-layer")).toBeNull();

    setLiveData(dir1);
    flush();
    expect(tracking.isStaleForDirection()).toBe(false);
    await vi.waitFor(() => {
      expect(container.querySelector(".targeted-route-layer path")).not.toBeNull();
    });
  });
});

describe("renderableSegments", () => {
  function makeSegment(id: string, kind: StatusOverlaySegment["kind"]): StatusOverlaySegment {
    return {
      id,
      kind,
      lineId: "1",
      lineName: "Line 1",
      lineColor: "#000000",
      fromStation: "A",
      toStation: "B",
      note: `${kind} segment`,
      pathD: "M0,0 L10,10",
      midpoint: { x: 5, y: 5 },
    };
  }

  const ALL_KINDS = ["severe", "upcoming", "delay", "rsz"] as const;

  function projectionWith(segments: readonly StatusOverlaySegment[]): MapProjection {
    return {
      statusOverlaySegments: [...segments],
      stationSeverities: new Map(),
      stationAccessibilityOutages: new Set(),
    } as unknown as MapProjection;
  }

  it("orders segments by layer: upcoming below rsz below delay below severe", () => {
    const renderable = renderableSegments(
      projectionWith(ALL_KINDS.map((kind, i) => makeSegment(`s${i}`, kind))),
      {
        showReducedSpeedZones: true,
      },
    );

    expect(renderable.map((s) => s.kind)).toEqual(["upcoming", "rsz", "delay", "severe"]);
  });

  it("drops reduced-speed segments when the preference is off", () => {
    const renderable = renderableSegments(
      projectionWith([makeSegment("a", "rsz"), makeSegment("b", "delay")]),
      { showReducedSpeedZones: false },
    );

    expect(renderable.map((s) => s.id)).toEqual(["b"]);
  });
});
