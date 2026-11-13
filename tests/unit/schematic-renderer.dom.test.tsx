vi.mock("~/agencies/interchanges", async () => {
  const { testInterchanges } = await import("../helpers/agency-fixtures");
  return { interchanges: testInterchanges };
});
vi.mock("~/agencies/agencyCatalog", async () => {
  const { testAgencyCatalog } = await import("../helpers/agency-fixtures");
  return { agencyCatalog: testAgencyCatalog };
});
// @vitest-environment happy-dom
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";
import { createMemo, createSignal, flush, onSettled } from "solid-js";
import { buildSmoothPathD } from "~/domain/map/MapGeometry";
import { viewBoxPlacement } from "~/components/map/viewport/transform";
import { buildMapModel, selectBadgeOrder, type MapProjection } from "~/core/map";
import { NetworkMap } from "~/components/map/NetworkMap";
import type { InterchangeFocus } from "~/components/map/interchange-navigation";
import { getAgencyById } from "~/agencies/registry";
import type { AgencyProvider, BrowserAgency, Schematic } from "~/agencies/types";
import { useMobileViewport } from "~/hooks/useMobileViewport";
import { withSchematic } from "../helpers/browser-agency";
import {
  NearbyCoordinationProvider,
  createNearbyCoordination,
} from "~/context/NearbyCoordinationContext";
import { createNearbyFocusAdapter } from "~/components/nearby/nearbyFocus";
import { createShellSession } from "~/lib/shellSession";
import { UserPreferencesProvider, useUserPreferences } from "~/context/UserPreferencesContext";
import { AgencySessionProvider } from "~/context/AgencySessionContext";
import {
  createMockAgencySession,
  createReactiveMockAgencySession,
} from "../helpers/mockAgencySession";
import type { EffectiveAgencySnapshot } from "~/domain/location/EffectiveAgency";
import { DEFAULT_PREFERENCES, encodeUserPreferences } from "~/domain/preferences/UserPreferences";
import { resolveInterchangeBadgeVisibility } from "~/domain/map/InterchangeBadgeVisibility";
import { PREFERENCES_STORAGE_KEY } from "~/infrastructure/storage/PreferencesStorage";
import { installMemoryLocalStorage } from "../helpers/local-storage";
import { stubInitialResizeObserver } from "../helpers/resize-observer";

/**
 * Synthetic mini-network: proves the map draws an arbitrary
 * agency's topology — no Sample Transit ids, names, colors, or numeric line numbers.
 */
export const miniSchematic: Schematic = {
  viewBoxWidth: 800,
  viewBoxHeight: 600,
  lines: [
    {
      id: "red",
      name: "Red Line",
      color: "#ff0000",
      points: [
        { x: 100, y: 100 },
        { x: 300, y: 100 },
        { x: 500, y: 100 },
      ],
    },
    {
      id: "blue",
      name: "Blue Line",
      color: "#0000ff",
      points: [
        { x: 300, y: 100 },
        { x: 300, y: 300 },
      ],
    },
  ],
  stations: [
    { id: "alpha", name: "Alpha", x: 100, y: 100, lines: ["red"], accessible: true },
    {
      id: "beta-junction",
      name: "Beta Junction",
      x: 300,
      y: 100,
      lines: ["red", "blue"],
      accessible: true,
      label: { x: 310, y: 90, rot: -45, anchor: "end" },
    },
    {
      id: "gamma-terminal",
      name: "Gamma Terminal",
      x: 500,
      y: 100,
      lines: ["red"],
      terminal: true,
    },
    { id: "delta-south", name: "Delta South", x: 300, y: 300, lines: ["blue"] },
  ],
  badges: [{ line: "blue", num: "B", x: 300, y: 200, color: "#0000ff", textColor: "#ffffff" }],
  sequences: {
    red: ["alpha", "beta-junction", "gamma-terminal"],
    blue: ["beta-junction", "delta-south"],
  },
  cornerInsertions: [
    {
      lineId: "red",
      stationId: "beta-junction",
      before: { x: 250, y: 140 },
      after: { x: 350, y: 140 },
    },
  ],
  viewport: {
    bounds: { minX: 50, maxX: 550, minY: 50, maxY: 350 },
    minZoom: 0.5,
    maxZoom: 8,
  },
  geoProjection: {
    refLonWest: -1,
    refLonEast: 1,
    refXWest: 100,
    refXEast: 500,
    refLatNorth: 1,
    refLatSouth: -1,
    refYNorth: 100,
    refYSouth: 500,
  },
};

describe("buildMapModel — station derivation", () => {
  const topology = buildMapModel(miniSchematic);

  it("derives interchange status from multi-line membership", () => {
    const beta = topology.stationsById.get("beta-junction");
    expect(beta?.isInterchange).toBe(true);
    expect(topology.stationsById.get("alpha")?.isInterchange).toBe(false);
  });

  it("keeps duplicate display names independently addressable by schematic ID", () => {
    const topologyWithDuplicateNames = buildMapModel({
      ...miniSchematic,
      stations: miniSchematic.stations.map((station) => ({ ...station, name: "Twin" })),
    });

    expect(topologyWithDuplicateNames.stationsById.get("alpha")?.name).toBe("Twin");
    expect(topologyWithDuplicateNames.stationsById.get("beta-junction")?.name).toBe("Twin");
    expect(topologyWithDuplicateNames.stationsById.size).toBe(miniSchematic.stations.length);
  });

  it("carries provider-declared terminal flags without inventing any", () => {
    expect(topology.stationsById.get("gamma-terminal")?.isTerminal).toBe(true);
    expect(topology.stationsById.get("alpha")?.isTerminal).toBe(false);
  });

  it("retains provider accessibility state for localized station presentation", () => {
    expect(topology.stationsById.get("delta-south")?.accessible).toBeUndefined();
  });

  it("falls back to offset labels beside unlabelled stations", () => {
    const alpha = topology.stationsById.get("alpha");
    expect(alpha?.labelX).toBe(112);
    expect(alpha?.labelY).toBe(104);
    expect(alpha?.labelRotation).toBe(0);
    expect(alpha?.labelAnchor).toBe("start");
  });

  it("keeps provider-tuned label placements verbatim", () => {
    const beta = topology.stationsById.get("beta-junction");
    expect(beta?.labelX).toBe(310);
    expect(beta?.labelY).toBe(90);
    expect(beta?.labelRotation).toBe(-45);
    expect(beta?.labelAnchor).toBe("end");
  });
});

describe("buildMapModel — lines and badges", () => {
  const topology = buildMapModel(miniSchematic);

  it("traces each line's smooth path from the provider's own points", () => {
    const red = topology.linesById.get("red");
    expect(red?.pathD).toBe(
      buildSmoothPathD([
        { x: 100, y: 100 },
        { x: 300, y: 100 },
        { x: 500, y: 100 },
      ]),
    );
    expect(red?.name).toBe("Red Line");
  });

  it("passes badges through untouched", () => {
    expect(topology.badgeList).toEqual([miniSchematic.badges![0]]);
  });
});

describe("buildMapModel — sequence and corner derivation", () => {
  const topology = buildMapModel(miniSchematic);

  it("serves provider-declared sequences by line id", () => {
    expect(topology.sequenceFor("red")).toEqual(["alpha", "beta-junction", "gamma-terminal"]);
    expect(topology.sequenceFor("mystery")).toEqual([]);
  });

  it("resolves anchors through the anchor-key grammar", () => {
    expect(topology.anchorFor("alpha")).toEqual({ x: 100, y: 100 });
    expect(topology.anchorFor("nowhere")).toBeUndefined();
  });

  it("splices a full U-turn triple oriented by approach direction", () => {
    const points = topology.cornerInsertion("red", ["alpha", "beta-junction", "gamma-terminal"]);
    expect(points).toEqual([
      { x: 100, y: 100 },
      { x: 250, y: 140 },
      { x: 300, y: 100 },
      { x: 350, y: 140 },
      { x: 500, y: 100 },
    ]);
  });

  it("mirrors the U-turn when approached from the other end", () => {
    const points = topology.cornerInsertion("red", ["gamma-terminal", "beta-junction", "alpha"]);
    expect(points).toEqual([
      { x: 500, y: 100 },
      { x: 350, y: 140 },
      { x: 300, y: 100 },
      { x: 250, y: 140 },
      { x: 100, y: 100 },
    ]);
  });

  it("appends a single trailing leg when the corner station leads the span", () => {
    expect(topology.cornerInsertion("red", ["beta-junction", "gamma-terminal"])).toEqual([
      { x: 300, y: 100 },
      { x: 350, y: 140 },
      { x: 500, y: 100 },
    ]);
  });

  it("prepends a single leading leg when the corner station ends the span", () => {
    expect(topology.cornerInsertion("red", ["alpha", "beta-junction"])).toEqual([
      { x: 100, y: 100 },
      { x: 250, y: 140 },
      { x: 300, y: 100 },
    ]);
  });

  it("reduces to a lone anchor when the corner station has no span neighbours", () => {
    expect(topology.cornerInsertion("red", ["beta-junction"])).toEqual([{ x: 300, y: 100 }]);
  });

  it("leaves lines without declared corners as plain anchors", () => {
    expect(topology.cornerInsertion("blue", ["beta-junction", "delta-south"])).toEqual([
      { x: 300, y: 100 },
      { x: 300, y: 300 },
    ]);
  });
});

describe("buildMapModel — geometry engine binding", () => {
  const topology = buildMapModel(miniSchematic);

  it("seeds the initial camera from the schematic's declared framing", () => {
    // Bounds span 500×300 on an 800×600 canvas: the fit factor is
    // min(760/500, 570/300) = 1.52, and pan centers bounds center
    // (300, 200) at canvas center at that zoom.
    expect(topology.minZoom).toBe(0.5);
    expect(topology.maxZoom).toBe(8);
    expect(topology.initialZoom).toBe(1.52);
    expect(topology.initialPan).toEqual({ x: -56, y: -4 });
  });

  it("binds the schematic's geographic projection to the geometry engine", () => {
    expect(topology.geometry.projectGeoToMapPoint(0.4, 0.4)).toEqual({ x: 380, y: 220 });
  });
});

describe("selectBadgeOrder — favourite-first badge sorting", () => {
  const badges = [
    { line: "red", num: "R", x: 0, y: 0, color: "#f00", textColor: "#fff" },
    { line: "blue", num: "B", x: 1, y: 0, color: "#00f", textColor: "#fff" },
    { line: "green", num: "G", x: 2, y: 0, color: "#0f0", textColor: "#000" },
  ];

  it("floats favourited lines' badges ahead of the rest, preserving relative order", () => {
    const ordered = selectBadgeOrder(badges, ["green"]);
    expect(ordered.map((b) => b.line)).toEqual(["green", "red", "blue"]);
  });

  it("returns the original list when nothing is favourited", () => {
    expect(selectBadgeOrder(badges, [])).toBe(badges);
  });
});

// ---------------------------------------------------------------------------
// Component-level map behavior: the same NetworkMap component mounts a
// synthetic provider end-to-end and degrades without a schematic.
// ---------------------------------------------------------------------------

/** A registered test agency as the browser sees it: light index plus a pre-resolved schematic. */
function browserAgencyById(id: string) {
  const provider = getAgencyById(id)!;
  return { ...provider, ...withSchematic(provider.schematic!, id) };
}

const miniProvider: AgencyProvider & Pick<BrowserAgency, "light"> = {
  manifest: {
    id: "mini",
    name: "Mini Transit",
    locale: "en-CA",
    timezone: "America/Toronto",
    bounds: [{ minLat: -1, maxLat: 1, minLon: -1, maxLon: 1 }],
    modes: ["subway"],
    stationService: { routeType: "subway" },
    attribution: { name: "Mini Transit", url: "https://example.com", license: "MIT" },
    status: "active",
  },
  staticTopology: {},
  schematic: miniSchematic,
  ...withSchematic(miniSchematic, "mini"),
};

const emptyProjection: MapProjection = {
  statusOverlaySegments: [],
  stationSeverities: new Map(),
  stationAccessibilityOutages: new Set(),
};
const fullInterchangeBadgeVisibility = () => "full" as const;

const maplessProvider: BrowserAgency = {
  manifest: {
    ...miniProvider.manifest,
    id: "mapless",
    name: "Mapless Transit",
  },
};

function stubElementRect(width = 1200, height = 800): void {
  // The viewport fits from the ResizeObserver's first entry; happy-dom does not
  // deliver it, so the map would never become ready without this stub.
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

function PreferenceResolvedNetworkMap(props: {
  provider: BrowserAgency;
  projection: MapProjection;
  onTemporaryAgencyView: (focus: InterchangeFocus) => void;
}) {
  const prefs = useUserPreferences();
  const isMobileViewport = useMobileViewport();
  const [isHydrated, setIsHydrated] = createSignal(false);
  const interchangeBadgeVisibility = createMemo(() => {
    if (!isHydrated()) return "full";
    prefs.isLoaded();
    return resolveInterchangeBadgeVisibility(
      prefs.preferences.interchangeBadgeVisibility,
      isMobileViewport(),
    );
  });
  onSettled(() => {
    setIsHydrated(true);
  });

  return (
    <NetworkMap
      provider={props.provider}
      projection={props.projection}
      interchangeBadgeVisibility={interchangeBadgeVisibility}
      onTemporaryAgencyView={props.onTemporaryAgencyView}
    />
  );
}

function mountProvider(provider: BrowserAgency) {
  const coordination = createNearbyCoordination(createShellSession(), createNearbyFocusAdapter());
  const session = createMockAgencySession({ agencyId: provider.manifest.id });
  return render(() => (
    <UserPreferencesProvider>
      <AgencySessionProvider session={session}>
        <NearbyCoordinationProvider value={coordination}>
          <PreferenceResolvedNetworkMap
            provider={provider}
            projection={emptyProjection}
            onTemporaryAgencyView={() => {}}
          />
        </NearbyCoordinationProvider>
      </AgencySessionProvider>
    </UserPreferencesProvider>
  ));
}

function mountSwitchableProvider(initialProvider: AgencyProvider) {
  const [provider, setProvider] = createSignal(initialProvider);
  const coordination = createNearbyCoordination(createShellSession(), createNearbyFocusAdapter());
  const session = createReactiveMockAgencySession(() => provider().manifest.id);
  const ui = render(() => (
    <UserPreferencesProvider>
      <AgencySessionProvider session={session}>
        <NearbyCoordinationProvider value={coordination}>
          <NetworkMap
            provider={provider()}
            projection={emptyProjection}
            interchangeBadgeVisibility={fullInterchangeBadgeVisibility}
            onTemporaryAgencyView={() => {}}
          />
        </NearbyCoordinationProvider>
      </AgencySessionProvider>
    </UserPreferencesProvider>
  ));

  return { ui, setProvider };
}

function mountPreferenceSwitchableProvider(initialProvider: AgencyProvider) {
  const captured: {
    setAgency?: (agencyId: string) => void;
    setTemporaryAgency?: (focus: InterchangeFocus) => void;
    setBadgeVisibility?: (visibility: "full" | "compact" | "hidden") => void;
    getAgency?: () => string;
  } = {};
  const coordination = createNearbyCoordination(createShellSession(), createNearbyFocusAdapter());
  const ui = render(() => (
    <UserPreferencesProvider>
      <PreferenceDrivenMap initialProvider={initialProvider} />
    </UserPreferencesProvider>
  ));

  function PreferenceDrivenMap(props: { initialProvider: AgencyProvider }) {
    const prefs = useUserPreferences();
    const [temporaryAgencyId, setTemporaryAgencyId] = createSignal<string>();
    const provider = createMemo(
      () =>
        (getAgencyById(temporaryAgencyId() ?? prefs.preferences.agency) &&
          browserAgencyById(temporaryAgencyId() ?? prefs.preferences.agency)) ||
        props.initialProvider,
    );
    const snapshot = createMemo<EffectiveAgencySnapshot>(() => ({
      fix: null,
      source: "default",
      status: "idle",
      automaticAgencyId: provider().manifest.id,
      agencyId: provider().manifest.id,
      declaredCoveringIds: [],
      coveringIds: [],
      stationCoveringIds: [],
    }));
    captured.setAgency = (agencyId) => prefs.setPreference("agency", agencyId);
    captured.setBadgeVisibility = (visibility) => prefs.setInterchangeBadgeVisibility(visibility);
    captured.setTemporaryAgency = (focus) => setTemporaryAgencyId(focus.agencyId);
    captured.getAgency = () => prefs.preferences.agency;
    const session = createReactiveMockAgencySession(() => provider().manifest.id, {
      getSnapshot: snapshot,
      isTemporary: () => temporaryAgencyId() !== undefined,
      selectAgency: (id: string) => prefs.setPreference("agency", id as never),
      navigateToInterchange: (focus: InterchangeFocus) => setTemporaryAgencyId(focus.agencyId),
      clearTemporaryView: () => setTemporaryAgencyId(undefined),
    });
    return (
      <AgencySessionProvider session={session}>
        <NearbyCoordinationProvider value={coordination}>
          <PreferenceResolvedNetworkMap
            provider={provider()}
            projection={emptyProjection}
            onTemporaryAgencyView={captured.setTemporaryAgency}
          />
        </NearbyCoordinationProvider>
      </AgencySessionProvider>
    );
  }

  return {
    ui,
    setAgency: (agencyId: string) => {
      if (!captured.setAgency) throw new Error("Preference-driven map is not mounted");
      captured.setAgency(agencyId);
    },
    setBadgeVisibility: (visibility: "full" | "compact" | "hidden") => {
      if (!captured.setBadgeVisibility) throw new Error("Preference-driven map is not mounted");
      captured.setBadgeVisibility(visibility);
    },
    getAgency: () => captured.getAgency?.() ?? "",
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

beforeEach(() => {
  // Each preference-driven mount loads persisted agency selection onMount.
  // Isolate that storage so a preceding test cannot change this test's
  // starting agency before the interchange badge is queried.
  installMemoryLocalStorage();
});

describe("NetworkMap — agency-agnostic rendering", () => {
  it("renders the mapless fallback from a browser agency projection", () => {
    const ui = mountProvider(maplessProvider);

    expect(ui.container.textContent).toContain("Mapless Transit schematic isn't available yet");
    expect(ui.container.querySelector("svg[role='img']")).toBeNull();
  });

  it("draws a non-Sample Transit network from the provider's own topology", () => {
    stubElementRect();
    const ui = mountProvider(miniProvider);

    const titles = Array.from(ui.container.querySelectorAll("title")).map(
      (t) => t.textContent ?? "",
    );
    expect(titles).toContain("Red Line");
    expect(titles).toContain("Blue Line");

    const alpha = ui.container.querySelector('[aria-label^="Alpha station"]');
    expect(alpha).not.toBeNull();

    const svg = ui.container.querySelector("svg[role='img']");
    expect(svg?.getAttribute("aria-label")).toBe("Mini Transit network map");
  });

  it("keeps the schematic canvas mounted when the same agency provider is replaced", () => {
    stubElementRect();
    const [provider, setProvider] = createSignal(miniProvider);
    const coordination = createNearbyCoordination(createShellSession(), createNearbyFocusAdapter());
    const session = createReactiveMockAgencySession(() => provider().manifest.id);
    const ui = render(() => (
      <UserPreferencesProvider>
        <AgencySessionProvider session={session}>
          <NearbyCoordinationProvider value={coordination}>
            <NetworkMap
              provider={provider()}
              projection={emptyProjection}
              interchangeBadgeVisibility={fullInterchangeBadgeVisibility}
              onTemporaryAgencyView={() => {}}
            />
          </NearbyCoordinationProvider>
        </AgencySessionProvider>
      </UserPreferencesProvider>
    ));
    const mountedSvg = ui.container.querySelector("svg[role='img']");

    setProvider({ ...miniProvider, schematic: { ...miniSchematic } });

    expect(ui.container.querySelector("svg[role='img']")).toBe(mountedSvg);
  });

  it("swaps to a different agency's schematic synchronously", () => {
    stubElementRect();
    const otherProvider = {
      ...miniProvider,
      manifest: { ...miniProvider.manifest, id: "other", name: "Other Transit" },
      ...withSchematic(miniSchematic, "other"),
    };
    const { ui, setProvider } = mountSwitchableProvider(miniProvider);

    setProvider(otherProvider);
    // Solid 2 stages the write: commit before querying the swapped DOM.
    flush();

    const svg = ui.container.querySelector('svg[aria-label="Other Transit network map"]');
    expect(svg).not.toBeNull();
    expect(ui.container.querySelector('svg[aria-label="Mini Transit network map"]')).toBeNull();
  });

  it("switches registered agency schematics while keeping one canvas mounted", () => {
    stubElementRect();
    const sample = browserAgencyById("sample");
    const regional = browserAgencyById("regional");
    const { ui, setProvider } = mountSwitchableProvider(sample);

    const sampleSvg = ui.container.querySelector('svg[aria-label="Sample Transit network map"]');
    expect(sampleSvg).not.toBeNull();

    setProvider(regional);
    // Solid 2 stages the write: commit before querying the swapped DOM.
    flush();

    expect(
      ui.container.querySelector('svg[aria-label="Regional Transit network map"]'),
    ).not.toBeNull();
    expect(ui.container.querySelector('svg[aria-label="Sample Transit network map"]')).toBeNull();
    expect(ui.container.querySelectorAll('svg[role="img"]')).toHaveLength(1);
  });

  it("switches agency schematics when selection changes through preferences", () => {
    stubElementRect();
    const sample = browserAgencyById("sample");
    const regional = browserAgencyById("regional");
    const { ui, setAgency } = mountPreferenceSwitchableProvider(sample);

    setAgency(regional.manifest.id);

    expect(
      ui.container.querySelector('svg[aria-label="Regional Transit network map"]'),
    ).not.toBeNull();
    expect(ui.container.querySelector('svg[aria-label="Sample Transit network map"]')).toBeNull();
    expect(ui.container.querySelectorAll('svg[role="img"]')).toHaveLength(1);
  });

  it("switches from an interchange badge, preserves the station position, and preserves zoom", async () => {
    stubElementRect();
    const sample = browserAgencyById("sample");
    const regional = browserAgencyById("regional");
    const { ui, getAgency } = mountPreferenceSwitchableProvider(sample);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const badge = ui.container.querySelector<SVGGElement>(
      '[role="button"][aria-label="Switch to Regional Transit at Hub"]',
    );
    expect(badge).not.toBeNull();

    const zoomIn = ui.container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]');
    expect(zoomIn).not.toBeNull();
    for (let index = 0; index < 5; index += 1) {
      fireEvent.click(zoomIn!);
    }
    const sourceTransform = ui.container
      .querySelector<SVGGElement>('[aria-label="Sample Transit network map"] svg > g:last-of-type')
      ?.getAttribute("transform");
    const sourceZoom = Number(sourceTransform?.match(/scale\(([^)]+)\)/)?.[1]);
    expect(sourceZoom).toBeGreaterThan(1);
    const sourcePanMatch = sourceTransform?.match(/translate\(([^,]+), ([^)]+)\)/);
    expect(sourcePanMatch).not.toBeNull();
    const sourceTopology = buildMapModel(sample.schematic!);
    const sourceHub = sourceTopology.stationsById.get("hub")!;
    const sourceScreenPosition = sourceTopology.camera.transformMapPointToContainer(
      { x: sourceHub.x, y: sourceHub.y },
      {
        width: 1200,
        height: 800,
        zoom: sourceZoom,
        pan: { x: Number(sourcePanMatch![1]), y: Number(sourcePanMatch![2]) },
      },
    );
    expect(sourceScreenPosition).toBeDefined();

    fireEvent.click(badge!);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const regionalMap = ui.container.querySelector<HTMLElement>(
      '[aria-label="Regional Transit network map"]',
    );
    expect(regionalMap).not.toBeNull();
    expect(getAgency()).toBe("auto");
    const regionalSvg = regionalMap!.querySelector<SVGSVGElement>('svg[role="img"]');
    const regionalTopology = buildMapModel(regional.schematic!);
    const hub = regionalTopology.stationsById.get("hub")!;
    const sourceScreenScale =
      sourceZoom *
      viewBoxPlacement(
        { width: 1200, height: 800 },
        sample.schematic!.viewBoxWidth,
        sample.schematic!.viewBoxHeight,
      ).scale;
    const destinationZoom =
      sourceScreenScale /
      viewBoxPlacement(
        { width: 1200, height: 800 },
        regional.schematic!.viewBoxWidth,
        regional.schematic!.viewBoxHeight,
      ).scale;
    const mapGroup = regionalSvg!.querySelector<SVGGElement>(":scope > g:last-of-type");
    const destinationTransform = mapGroup?.getAttribute("transform");
    const destinationPanMatch = destinationTransform?.match(/translate\(([^,]+), ([^)]+)\)/);
    const destinationZoomFromTransform = Number(
      destinationTransform?.match(/scale\(([^)]+)\)/)?.[1],
    );

    expect(destinationPanMatch).not.toBeNull();
    expect(destinationZoomFromTransform).toBeCloseTo(destinationZoom);
    const destinationScreenPosition = regionalTopology.camera.transformMapPointToContainer(
      { x: hub.x, y: hub.y },
      {
        width: 1200,
        height: 800,
        zoom: destinationZoomFromTransform,
        pan: {
          x: Number(destinationPanMatch![1]),
          y: Number(destinationPanMatch![2]),
        },
      },
    );
    expect(destinationScreenPosition?.x).toBeCloseTo(sourceScreenPosition!.x);
    expect(destinationScreenPosition?.y).toBeCloseTo(sourceScreenPosition!.y);
  });

  it("updates mounted interchange badges when the visibility preference changes", () => {
    stubElementRect();
    const sample = browserAgencyById("sample");
    const { ui, setBadgeVisibility } = mountPreferenceSwitchableProvider(sample);
    const badge = () =>
      ui.container.querySelector<SVGGElement>(
        '[role="button"][aria-label="Switch to Regional Transit at Hub"]',
      );

    setBadgeVisibility("full");
    expect(badge()?.querySelector("rect")?.getAttribute("height")).toBe("18");

    setBadgeVisibility("compact");

    expect(badge()?.querySelector("rect")?.getAttribute("height")).toBe("14");
  });

  it("applies a persisted compact preference after the map has mounted", async () => {
    stubElementRect();
    localStorage.setItem(
      PREFERENCES_STORAGE_KEY,
      encodeUserPreferences({ ...DEFAULT_PREFERENCES, interchangeBadgeVisibility: "compact" }),
    );
    const sample = browserAgencyById("sample");
    const ui = mountProvider(sample);
    const badgeBeforePreferencesLoad = ui.container.querySelector<SVGGElement>(
      '[role="button"][aria-label="Switch to Regional Transit at Hub"]',
    );
    expect(badgeBeforePreferencesLoad?.querySelector("rect")?.getAttribute("height")).toBe("18");

    await waitFor(() => {
      const badge = ui.container.querySelector<SVGGElement>(
        '[role="button"][aria-label="Switch to Regional Transit at Hub"]',
      );
      expect(badge?.querySelector("rect")?.getAttribute("height")).toBe("14");
      expect(badge?.textContent).toContain("R");
      expect(badge?.textContent).not.toContain("⇄");
    });
  });

  it("does not mount inactive agency schematics during agency changes", () => {
    stubElementRect();
    const sample = browserAgencyById("sample");
    const regional = browserAgencyById("regional");
    const metro = browserAgencyById("metro");
    const local = browserAgencyById("local");
    const { ui, setProvider } = mountSwitchableProvider(sample);

    setProvider(regional);
    setProvider(metro);
    setProvider(local);
    // Solid 2 stages the writes: commit before querying the swapped DOM.
    flush();

    const svgs = ui.container.querySelectorAll("svg[role='img']");
    expect(svgs).toHaveLength(1);
    expect(
      ui.container.querySelector('svg[aria-label="Local Transit network map"]'),
    ).not.toBeNull();
    expect(ui.container.querySelector('svg[aria-label="Metro Transit network map"]')).toBeNull();
    expect(ui.container.querySelector('svg[aria-label="Regional Transit network map"]')).toBeNull();
    expect(ui.container.querySelector('svg[aria-label="Sample Transit network map"]')).toBeNull();
  });

  it("warms inactive topology without mounting another interactive canvas", async () => {
    vi.useFakeTimers();
    stubElementRect();
    const sample = browserAgencyById("sample");
    const ui = mountProvider(sample);

    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(1000);

    expect(ui.container.querySelectorAll('svg[role="img"]')).toHaveLength(1);
    expect(ui.container.querySelector('svg[aria-label="Regional Transit network map"]')).toBeNull();
  });
});
