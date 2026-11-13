// @vitest-environment happy-dom
import { describe, expect, it, afterEach, vi } from "vitest";
import { Show } from "solid-js";
import { render, screen, cleanup, fireEvent } from "@solidjs/testing-library";
import { UserPreferencesProvider, useUserPreferences } from "~/context/UserPreferencesContext";
import { createMemoryPreferencesStorage } from "~/infrastructure/storage/PreferencesStorage";
import { DEFAULT_PREFERENCES } from "~/domain/preferences/UserPreferences";
import { AgencyPickerSheet, type AgencyPickerViewState } from "~/components/AgencyPickerSheet";
import type { BrowserAgency, Schematic } from "~/agencies/types";
import { withSchematic } from "../helpers/browser-agency";
import type { EffectiveAgencySnapshot } from "~/domain/location/EffectiveAgency";

/**
 * Manual agency picker: a dropdown of labelled sections beneath the header —
 * Automatic, the declared-bound "In your area" agencies, favourites, then the
 * remaining agencies bucketed by declared geography under "Browse by region".
 * Selecting applies immediately and closes.
 */

const { registryMocks } = vi.hoisted(() => {
  // vi.hoisted runs before imports — inline the minimal Schematic
  // rather than calling the shared fixture helper.
  const miniSchematic = {
    viewBoxWidth: 100,
    viewBoxHeight: 100,
    lines: [
      {
        id: "L1",
        name: "Line 1",
        color: "#000000",
        points: [
          { x: 10, y: 10 },
          { x: 90, y: 90 },
        ],
      },
    ],
    stations: [
      { id: "alpha", name: "Alpha", x: 10, y: 10, lines: ["L1"] },
      { id: "beta", name: "Beta", x: 90, y: 90, lines: ["L1"], terminal: true },
    ],
    sequences: { L1: ["alpha", "beta"] },
    viewport: { bounds: { minX: 0, maxX: 100, minY: 0, maxY: 100 }, minZoom: 0.5, maxZoom: 4 },
    geoProjection: {
      refLonWest: -80,
      refLonEast: -79,
      refXWest: 0,
      refXEast: 100,
      refLatNorth: 44,
      refLatSouth: 43,
      refYNorth: 0,
      refYSouth: 100,
    },
  } as const;

  const ttc: BrowserAgency = {
    light: { lines: miniSchematic.lines, stationIds: [], stationPoints: [] },
    manifest: {
      id: "ttc",
      name: "TTC",
      locale: "en-CA",
      timezone: "America/Toronto",
      bounds: [{ minLat: 43.58, maxLat: 43.86, minLon: -79.64, maxLon: -79.11 }],
      modes: ["subway"],
      stationService: { routeType: "subway" },
      attribution: {
        name: "City of Toronto Open Data",
        url: "https://open.toronto.ca",
        license: "OGL-Toronto",
      },
      status: "active",
    },
  };
  const go: BrowserAgency = {
    light: { lines: miniSchematic.lines, stationIds: [], stationPoints: [] },
    manifest: {
      id: "go",
      name: "GO Transit",
      locale: "en-CA",
      timezone: "America/Toronto",
      bounds: [{ minLat: 43.25, maxLat: 44.5, minLon: -79.9, maxLon: -78.9 }],
      modes: ["bus", "rail"],
      stationService: { routeType: "rail" },
      attribution: { name: "Metrolinx", url: "https://www.metrolinx.com", license: "OCL" },
      status: "experimental",
    },
  };
  return {
    registryMocks: {
      miniSchematic,
      providers: [ttc, go],
      // Downtown Toronto point matches both; the resolver's smallest-area rule
      // lists TTC first. That snapshot order is the picker's tie-break, not its
      // ranking rule — both agencies here publish no station index to measure.
      agenciesForPoint: (lat: number, lon: number) =>
        lat === 43.6709 && lon === -79.3857 ? [ttc, go] : lat === 44 && lon === -79.5 ? [go] : [],
    },
  };
});

vi.mock("~/agencies/browserRegistry", () => ({
  allProviders: () => registryMocks.providers,
  getAgenciesForPoint: (lat: number, lon: number) => registryMocks.agenciesForPoint(lat, lon),
  getAgencyById: (id: string) => registryMocks.providers.find((p) => p.manifest.id === id),
  getActiveAgency: () =>
    registryMocks.providers.find((p) => p.manifest.status === "active") ??
    registryMocks.providers[0],
}));

const DOWNTOWN = { lat: 43.6709, lon: -79.3857 };
const GO_ONLY = { lat: 44, lon: -79.5 };

type Point = { lat: number; lon: number };

function snapshotFor(
  declaredCoveringIds: readonly string[],
  point: Point | null,
): EffectiveAgencySnapshot {
  const automaticAgencyId = declaredCoveringIds[0];
  return {
    fix: point ? { latitude: point.lat, longitude: point.lon, timestamp: 0 } : null,
    source: point ? "gps" : "default",
    status: point ? "granted" : "unavailable",
    automaticAgencyId,
    agencyId: automaticAgencyId,
    declaredCoveringIds,
    coveringIds: declaredCoveringIds,
    stationCoveringIds: [],
  };
}

function effectiveAgencyForPoint(point: Point): EffectiveAgencySnapshot {
  return snapshotFor(
    registryMocks.agenciesForPoint(point.lat, point.lon).map((provider) => provider.manifest.id),
    point,
  );
}

function Harness(props: {
  point?: Point | null | undefined;
  /** Declared-bound membership, declared explicitly so ordering fixtures control it. */
  coveringIds?: readonly string[] | undefined;
  onClose?: () => void;
  isOpen?: boolean;
  viewState?: AgencyPickerViewState;
  onSelectAgency?: (selection: "auto" | string) => void;
}) {
  let triggerEl: HTMLButtonElement | undefined;
  const captured: { value?: ReturnType<typeof useUserPreferences> } = {};
  const point = props.point === undefined ? DOWNTOWN : props.point;
  const effectiveAgency = props.coveringIds
    ? snapshotFor(props.coveringIds, point)
    : point
      ? effectiveAgencyForPoint(point)
      : snapshotFor([], null);
  const viewState =
    props.viewState ??
    ({
      persistedSelection: "auto",
      automaticAgencyId: effectiveAgency.automaticAgencyId,
      displayedAgencyId: effectiveAgency.automaticAgencyId,
      isTemporary: false,
    } satisfies AgencyPickerViewState);
  const Capture = () => {
    captured.value = useUserPreferences();
    return null;
  };
  const onSelectAgency =
    props.onSelectAgency ??
    ((selection: "auto" | string) => captured.value?.setPreference("agency", selection));
  render(() => (
    <UserPreferencesProvider>
      <Capture />
      <button
        type="button"
        ref={(el) => {
          triggerEl = el;
        }}
      >
        pill
      </button>
      <AgencyPickerSheet
        isOpen={props.isOpen ?? true}
        onClose={props.onClose ?? (() => {})}
        effectiveAgency={() => effectiveAgency}
        viewState={() => viewState}
        onSelectAgency={onSelectAgency}
        triggerEl={() => triggerEl}
      />
    </UserPreferencesProvider>
  ));
  return {
    captured: captured as { value: ReturnType<typeof useUserPreferences> },
    triggerEl: () => triggerEl,
  };
}

/** A schematic that carries geographic stations, layered onto the shared mini fixture. */
function schematicWithStations(stations: readonly Point[]): Schematic {
  return {
    ...registryMocks.miniSchematic,
    stationIndex: stations.map((station, index) => ({
      id: `s${index}`,
      name: `Station ${index}`,
      lat: station.lat,
      lon: station.lon,
      lines: ["L1"],
      platformIds: [],
    })),
  };
}

function manifestFor(
  id: string,
  name: string,
  modes: BrowserAgency["manifest"]["modes"],
): BrowserAgency["manifest"] {
  return {
    id,
    name,
    locale: "en-CA",
    timezone: "America/Toronto",
    bounds: [],
    modes,
    stationService: {
      routeType:
        modes.find(
          (m): m is "subway" | "rail" | "bus" => m === "subway" || m === "rail" || m === "bus",
        ) ?? "bus",
    },
    attribution: { name: `City of ${name}`, url: "https://example.com", license: "" },
    status: "experimental",
  };
}

/** An agency whose station index is measured against the fix. */
function mappedAgency(
  id: string,
  name: string,
  stations: readonly Point[],
  modes: BrowserAgency["manifest"]["modes"] = ["bus"],
): BrowserAgency {
  return {
    ...withSchematic(schematicWithStations(stations)),
    manifest: manifestFor(id, name, modes),
  };
}

/** An agency that draws a schematic but publishes no geographic station index. */
function indexlessAgency(id: string, name: string): BrowserAgency {
  return {
    ...withSchematic(registryMocks.miniSchematic),
    manifest: manifestFor(id, name, ["bus"]),
  };
}

/** An agency with no schematic at all, so no station index can exist. */
function schematiclessAgency(id: string, name: string): BrowserAgency {
  return { manifest: manifestFor(id, name, ["bus"]) };
}

/** An agency with a declared jurisdiction and optional scope, for grouping. */
function regionalAgency(
  id: string,
  name: string,
  jurisdiction: { country: string; region?: string },
  scope?: "regional" | "national" | "international",
): BrowserAgency {
  return {
    manifest: { ...manifestFor(id, name, ["bus"]), jurisdiction, ...(scope ? { scope } : {}) },
  };
}

/** Swaps the catalog for one test, so registration order is the fixture's own. */
async function withProviders(
  providers: BrowserAgency[],
  run: () => Promise<void> | void,
): Promise<void> {
  const previous = registryMocks.providers;
  registryMocks.providers = providers;
  try {
    await run();
  } finally {
    registryMocks.providers = previous;
  }
}

/**
 * The given labels in the order the picker rendered them. Labels are located by
 * their own text and ordered by document position, so the input order is
 * irrelevant and the result can only be the render order.
 */
function renderOrder(labels: readonly string[]): string[] {
  return labels
    .map((label) => screen.getByText(label))
    .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    .map((node) => node.textContent ?? "");
}

afterEach(cleanup);

describe("AgencyPickerSheet", () => {
  it("shows unresolved Automatic when there is no location match", () => {
    Harness({ point: null });
    expect(screen.getAllByRole("menuitemradio")[0].textContent).toContain("No network resolved");
  });

  it("lists Automatic first with a matched-agency sublabel, then every agency", () => {
    Harness({ point: DOWNTOWN });

    const rows = screen.getAllByRole("menuitemradio");
    expect(rows.length).toBe(3);
    expect(rows[0].textContent).toContain("Automatic");
    expect(rows[0].textContent).toContain("Automatic selects TTC");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Automatic"),
      expect.stringContaining("TTC"),
      expect.stringContaining("GO Transit"),
    ]);
  });

  it("groups every declared-bound agency under In your area", () => {
    Harness({ point: DOWNTOWN });

    const group = screen.getByRole("group", { name: "In your area" });
    expect(group.textContent).toContain("TTC");
    expect(group.textContent).toContain("GO Transit");
    // The Automatic row is its own section, never inside the coverage group.
    expect(group.textContent).not.toContain("Automatic");
    // The heading counts the covered agencies.
    expect(screen.getByText("In your area").parentElement?.textContent).toContain("2");
  });

  it("marks the active selection as checked", () => {
    Harness({ point: DOWNTOWN });
    const rows = screen.getAllByRole("menuitemradio");
    expect(rows[0].getAttribute("aria-checked")).toBe("true");
    expect(rows[1].getAttribute("aria-checked")).toBe("false");
  });

  it("keeps Automatic checked and explains a temporary agency view", () => {
    Harness({
      point: DOWNTOWN,
      viewState: {
        persistedSelection: "auto",
        automaticAgencyId: "ttc",
        displayedAgencyId: "go",
        temporaryAgencyId: "go",
        isTemporary: true,
      },
    });

    const rows = screen.getAllByRole("menuitemradio");
    expect(rows[0].getAttribute("aria-checked")).toBe("true");
    expect(rows[0].textContent).toContain("Viewing GO Transit temporarily");
    expect(rows[2].getAttribute("aria-checked")).toBe("false");
  });

  it("shows no In your area section outside declared bounds", () => {
    Harness({ point: { lat: 0, lon: -30 } });

    expect(screen.queryByRole("group", { name: "In your area" })).toBeNull();
    // Both agencies still render, under the geography disclosures.
    expect(screen.getAllByRole("menuitemradio").length).toBe(3);
  });

  it("lists a lone covering agency inside In your area", () => {
    Harness({ point: GO_ONLY });

    const group = screen.getByRole("group", { name: "In your area" });
    expect(group.textContent).toContain("GO Transit");
    expect(group.textContent).not.toContain("TTC");
  });

  it("applies a pinned selection immediately and closes", () => {
    const onClose = vi.fn();
    const { captured } = Harness({ point: DOWNTOWN, onClose });

    fireEvent.click(screen.getAllByRole("menuitemradio")[2]);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(captured.value.preferences.agency).toBe("go");
  });

  it("applies the Automatic selection and closes", () => {
    const onClose = vi.fn();
    const { captured } = Harness({ point: DOWNTOWN, onClose });

    fireEvent.click(screen.getByText("TTC").closest('[role="menuitemradio"]')!);
    fireEvent.click(screen.getAllByRole("menuitemradio")[0]);

    expect(onClose).toHaveBeenCalledTimes(2);
    expect(captured.value.preferences.agency).toBe("auto");
  });

  it("renders gracefully with a single registered agency", () => {
    const removed = registryMocks.providers.pop();
    Harness({ point: DOWNTOWN });
    expect(screen.getAllByRole("menuitemradio").length).toBe(2);
    if (removed) registryMocks.providers.push(removed);
  });

  it("dismisses on outside pointerdown but not on the trigger", () => {
    const onClose = vi.fn();
    const { triggerEl } = Harness({ point: DOWNTOWN, onClose });

    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    fireEvent.pointerDown(triggerEl()!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each(["AZURE", "BAYVIEW", "COTE"])(
    "finds agencies by service area or translation: %s",
    async (query) => {
      const agency = indexlessAgency("harbour", "HarbourLink");
      const catalog = [
        {
          ...agency,
          manifest: {
            ...agency.manifest,
            serviceArea: "Port Azuré & Bayview",
            serviceAreaTranslations: { fr: "Côte d’Azur" },
          },
        },
        indexlessAgency("inland", "Inland Express"),
      ];
      await withProviders(catalog, async () => {
        Harness({ point: null });
        expect(
          screen.getByText("Port Azuré & Bayview").closest('[role="menuitemradio"]')?.textContent,
        ).toContain("HarbourLink");
        await fireEvent.input(screen.getByLabelText("Search agencies by name or city"), {
          target: { value: query },
        });
        expect(screen.getByText("HarbourLink")).toBeDefined();
        expect(screen.queryByText("Inland Express")).toBeNull();
      });
    },
  );

  it("ranks an exact service-area match first and selects it on Enter", async () => {
    const local = indexlessAgency("harbour", "ZebraLink");
    const regional = indexlessAgency("coastal", "AlphaLink");
    await withProviders(
      [
        { ...regional, manifest: { ...regional.manifest, serviceArea: "Port Azure Coast" } },
        { ...local, manifest: { ...local.manifest, serviceArea: "Port Azuré" } },
      ],
      async () => {
        const onClose = vi.fn();
        const { captured } = Harness({ point: null, onClose });
        const search = screen.getByLabelText("Search agencies by name or city");
        await fireEvent.input(search, { target: { value: "Port Azure" } });
        expect(screen.getAllByRole("menuitemradio")[0].textContent).toContain("ZebraLink");
        await fireEvent.keyDown(search, { key: "Enter" });
        expect(captured.value.preferences.agency).toBe("harbour");
        expect(onClose).toHaveBeenCalledOnce();
      },
    );
  });

  describe("search & favourites", () => {
    it("filters agencies case-insensitively by name or id", async () => {
      // Neither query is answerable from the other field: "transit" is in no
      // id and "kt" is in no name, so each query can only match one of them.
      const CATALOG = [
        mappedAgency("ttc", "TTC", [{ lat: 43.6708, lon: -79.3866 }]),
        mappedAgency("kt", "Kingston Transit", [{ lat: 44.2, lon: -79.6 }]),
      ];
      await withProviders(CATALOG, async () => {
        Harness({ coveringIds: ["ttc", "kt"] });
        await new Promise((r) => setTimeout(r, 20));

        const searchInput = screen.getByPlaceholderText(
          "Search agencies by name or city...",
        ) as HTMLInputElement;
        expect(searchInput).toBeDefined();

        // A lowercase query against a mixed-case name.
        await fireEvent.input(searchInput, { target: { value: "transit" } });

        expect(screen.getByText("Matching Agencies (1)")).toBeDefined();
        expect(screen.getByText("Kingston Transit")).toBeDefined();
        expect(screen.queryByText("TTC")).toBeNull();

        await fireEvent.input(searchInput, { target: { value: "kt" } });

        expect(screen.getByText("Matching Agencies (1)")).toBeDefined();
        expect(screen.getByText("Kingston Transit")).toBeDefined();
        expect(screen.queryByText("TTC")).toBeNull();
      });
    });

    it("ranks exact matches before prefix and partial matches", async () => {
      // Registered in exactly the reverse of the expected order, so a pass
      // cannot come from the catalog's chronological registration order.
      const CATALOG = [
        mappedAgency("nia", "Niagara Falls GO Line", [{ lat: 43.1, lon: -79.2 }]),
        mappedAgency("alg", "Algoma GO Service", [{ lat: 46.3, lon: -81.1 }]),
        mappedAgency("gob", "GO Bus", [{ lat: 43.6, lon: -79.4 }]),
        mappedAgency("go", "GO Rail", [{ lat: 43.6, lon: -79.4 }]),
      ];
      // "GO Rail" is an exact id match, "GO Bus" a prefix match, and the other
      // two only contain the query somewhere inside their names.
      await withProviders(CATALOG, async () => {
        Harness({ coveringIds: [] });
        await new Promise((r) => setTimeout(r, 20));

        const searchInput = screen.getByPlaceholderText(
          "Search agencies by name or city...",
        ) as HTMLInputElement;
        await fireEvent.input(searchInput, { target: { value: "go" } });

        expect(screen.getByText("Matching Agencies (4)")).toBeDefined();
        expect(
          renderOrder(["Algoma GO Service", "GO Rail", "Niagara Falls GO Line", "GO Bus"]),
        ).toEqual(["GO Rail", "GO Bus", "Algoma GO Service", "Niagara Falls GO Line"]);
      });
    });

    it("selects top match on Enter and closes the picker", async () => {
      const onClose = vi.fn();
      const { captured } = Harness({ point: DOWNTOWN, onClose });
      await new Promise((r) => setTimeout(r, 20));

      const searchInput = screen.getByPlaceholderText(
        "Search agencies by name or city...",
      ) as HTMLInputElement;
      await fireEvent.input(searchInput, { target: { value: "go" } });

      await fireEvent.keyDown(searchInput, { key: "Enter" });

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(captured.value.preferences.agency).toBe("go");
    });

    it("closes on Escape key when open", async () => {
      const onClose = vi.fn();
      Harness({ point: DOWNTOWN, onClose });
      await new Promise((r) => setTimeout(r, 20));

      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does not close on Escape key when closed", async () => {
      const onClose = vi.fn();
      Harness({ point: DOWNTOWN, onClose, isOpen: false });
      await new Promise((r) => setTimeout(r, 20));

      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(onClose).not.toHaveBeenCalled();
    });

    it("clears search input on Escape and via clear button, and closes on Escape when search is empty", async () => {
      const onClose = vi.fn();
      Harness({ point: DOWNTOWN, onClose });
      await new Promise((r) => setTimeout(r, 20));

      const searchInput = screen.getByPlaceholderText(
        "Search agencies by name or city...",
      ) as HTMLInputElement;
      await fireEvent.input(searchInput, { target: { value: "go" } });
      expect(screen.getByText("Matching Agencies (1)")).toBeDefined();

      // Clear via Escape without closing the picker
      await fireEvent.keyDown(searchInput, { key: "Escape" });
      expect(searchInput.value).toBe("");
      expect(screen.queryByText("Matching Agencies (1)")).toBeNull();
      expect(onClose).not.toHaveBeenCalled();

      // Pressing Escape again on empty search input closes the picker
      await fireEvent.keyDown(searchInput, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);

      // Clear via clear button
      await fireEvent.input(searchInput, { target: { value: "ttc" } });
      const clearBtn = screen.getByLabelText("Clear agency search");
      await fireEvent.click(clearBtn);
      expect(searchInput.value).toBe("");
    });

    it("toggles favourite agency via star button without closing the picker", async () => {
      const onClose = vi.fn();
      const { captured } = Harness({ point: DOWNTOWN, onClose });
      await new Promise((r) => setTimeout(r, 20));

      const starButton = screen.getByLabelText("Add GO Transit to favourites");
      expect(starButton.getAttribute("aria-pressed")).toBe("false");

      await fireEvent.click(starButton);

      // Does not close picker
      expect(onClose).not.toHaveBeenCalled();
      expect(captured.value.preferences.favouriteAgencies).toEqual(["go"]);
      expect(screen.getByLabelText("Remove GO Transit from favourites")).toBeDefined();

      // Keyboard activation on star button does not trigger parent row selection
      const removeButton = screen.getByLabelText("Remove GO Transit from favourites");
      await fireEvent.keyDown(removeButton, { key: "Enter" });
      expect(onClose).not.toHaveBeenCalled();

      // Toggle off
      await fireEvent.click(removeButton);
      expect(captured.value.preferences.favouriteAgencies).toEqual([]);
    });

    it("keeps declared-bound agencies ahead of favourites", async () => {
      Harness({ point: DOWNTOWN });
      await new Promise((r) => setTimeout(r, 20));

      // Favourite GO Transit
      const starButton = screen.getByLabelText("Add GO Transit to favourites");
      await fireEvent.click(starButton);

      // A declared-bound agency stays inside In your area rather than floating
      // into the favourites section; GO Transit is itself declared bound.
      const rows = screen.getAllByRole("menuitemradio");
      expect(rows[0].textContent).toContain("Automatic");
      expect(rows[1].textContent).toContain("TTC");
      expect(rows[2].textContent).toContain("GO Transit");
      expect(screen.queryByRole("group", { name: "Favourites" })).toBeNull();
    });

    it("displays no results message when query matches nothing", async () => {
      Harness({ point: DOWNTOWN });
      await new Promise((r) => setTimeout(r, 20));

      const searchInput = screen.getByPlaceholderText(
        "Search agencies by name or city...",
      ) as HTMLInputElement;
      await fireEvent.input(searchInput, { target: { value: "nonexistent-agency" } });

      expect(screen.getByText('No agencies found matching "nonexistent-agency"')).toBeDefined();
    });
  });

  describe("display order", () => {
    it("ranks the in-this-area group by distance to the nearest indexed station", async () => {
      // TTC's nearest station is its second one, so any implementation that
      // reads the first entry or an average instead puts it at the far end.
      const CATALOG = [
        mappedAgency("burl", "Burlington Transit", [{ lat: 44.45, lon: -79.65 }]),
        mappedAgency("yrt", "York Region Transit", [{ lat: 43.68, lon: -79.79 }]),
        mappedAgency("ttc", "TTC", [
          { lat: 44.2, lon: -79.6 },
          { lat: 43.6708, lon: -79.3866 },
        ]),
        mappedAgency("go", "GO Transit", [{ lat: 43.6553, lon: -79.3806 }]),
      ];
      await withProviders(CATALOG, async () => {
        Harness({ coveringIds: ["burl", "yrt", "ttc", "go"] });

        // Nearest first; neither alphabetical nor registration order.
        expect(
          renderOrder(["GO Transit", "Burlington Transit", "TTC", "York Region Transit"]),
        ).toEqual(["TTC", "GO Transit", "York Region Transit", "Burlington Transit"]);
      });
    });

    it("keeps the snapshot's own order when two covering agencies are equally near", async () => {
      const SHARED = { lat: 43.7, lon: -79.4 };
      const CATALOG = [
        mappedAgency("aard", "Aardvark Transit", [SHARED]),
        mappedAgency("zeb", "Zebra Transit", [SHARED]),
      ];
      await withProviders(CATALOG, async () => {
        // Bounds rank puts Zebra first, which the alphabet and the ids both
        // contradict, so this pins the tie-break rather than a name sort.
        Harness({ coveringIds: ["zeb", "aard"] });

        expect(renderOrder(["Zebra Transit", "Aardvark Transit"])).toEqual([
          "Zebra Transit",
          "Aardvark Transit",
        ]);
      });
    });

    it("lists covering agencies that publish no station index, ordered by the tie-break", async () => {
      const CATALOG = [
        mappedAgency("ttc", "TTC", [{ lat: 43.6708, lon: -79.3866 }]),
        schematiclessAgency("aard", "Aardvark Transit"),
        indexlessAgency("kt", "Kingston Transit"),
      ];
      await withProviders(CATALOG, async () => {
        // The snapshot lists the two unmapped agencies first, so the mapped one
        // can only lead on distance; the pair behind it keeps bounds rank.
        Harness({ coveringIds: ["aard", "kt", "ttc"] });

        expect(screen.getAllByRole("menuitemradio").length).toBe(4);
        expect(renderOrder(["Kingston Transit", "TTC", "Aardvark Transit"])).toEqual([
          "TTC",
          "Aardvark Transit",
          "Kingston Transit",
        ]);
      });
    });

    it.each([
      { situation: "no fix at all", point: null },
      { situation: "a fix inside no declared bounds", point: { lat: 0, lon: -30 } },
    ])("orders every agency alphabetically with $situation", async ({ point }) => {
      const CATALOG = [
        mappedAgency("yrt", "York Region Transit", [{ lat: 43.68, lon: -79.79 }]),
        mappedAgency("bram", "Brampton Transit", [{ lat: 43.74, lon: -79.76 }]),
        mappedAgency("burl", "Burlington Transit", [{ lat: 44.45, lon: -79.65 }]),
      ];
      await withProviders(CATALOG, async () => {
        Harness({ point, coveringIds: [] });

        expect(screen.queryByRole("group", { name: "In your area" })).toBeNull();
        expect(
          renderOrder(["York Region Transit", "Brampton Transit", "Burlington Transit"]),
        ).toEqual(["Brampton Transit", "Burlington Transit", "York Region Transit"]);
      });
    });

    it("lists favourites ahead of the remaining agencies, each alphabetically", async () => {
      const CATALOG = [
        mappedAgency("burl", "Burlington Transit", [{ lat: 44.45, lon: -79.65 }]),
        mappedAgency("yrt", "York Region Transit", [{ lat: 43.68, lon: -79.79 }]),
        mappedAgency("bram", "Brampton Transit", [{ lat: 43.74, lon: -79.76 }]),
      ];
      await withProviders(CATALOG, async () => {
        Harness({ point: null, coveringIds: [] });
        await new Promise((r) => setTimeout(r, 20));

        // Alphabetically last, so it can only lead by being a favourite.
        await fireEvent.click(screen.getByLabelText("Add York Region Transit to favourites"));

        expect(
          renderOrder(["Burlington Transit", "York Region Transit", "Brampton Transit"]),
        ).toEqual(["York Region Transit", "Brampton Transit", "Burlington Transit"]);
      });
    });

    it("orders same-named agencies by id so the list never depends on arrival", async () => {
      const CATALOG = [
        mappedAgency("west", "Regional Transit", [{ lat: 43.7, lon: -79.4 }], ["bus"]),
        mappedAgency("east", "Regional Transit", [{ lat: 43.7, lon: -79.4 }], ["rail"]),
      ];
      await withProviders(CATALOG, async () => {
        Harness({ point: null, coveringIds: [] });

        // Identical display names, so the mode line is what identifies a row.
        const twins = screen.getAllByText("Regional Transit");
        expect(twins.length).toBe(2);
        expect(twins[0].closest('[role="menuitemradio"]')?.textContent).toContain("Rail");
        expect(twins[1].closest('[role="menuitemradio"]')?.textContent).toContain("Bus");
      });
    });
  });

  describe("geographic grouping", () => {
    const CATALOG = [
      regionalAgency("ont", "Ontario Local", { country: "ca", region: "on" }),
      regionalAgency("coast", "Coastal Transit", { country: "ca", region: "bc" }),
      regionalAgency("empire", "Empire Transit", { country: "us", region: "ny" }),
      regionalAgency("c2c", "Coast to Coast", { country: "ca" }, "national"),
    ];

    it("nests regions and nationwide agencies under their countries", async () => {
      await withProviders(CATALOG, async () => {
        Harness({ point: null, coveringIds: [] });

        // Countries own their regional and nationwide disclosures.
        expect(
          screen.getAllByRole("button", { expanded: true }).map((node) => node.textContent),
        ).toEqual([
          expect.stringMatching(/Canada\s*3$/),
          expect.stringContaining("British Columbia"),
          expect.stringContaining("Ontario"),
          expect.stringContaining("Nationwide"),
          expect.stringMatching(/United States\s*1$/),
          expect.stringContaining("New York"),
        ]);
      });
    });

    it("groups a non-local agency that declares a region under that region", async () => {
      await withProviders(
        [
          ...CATALOG,
          regionalAgency("north", "Northern Coach", { country: "ca", region: "on" }, "national"),
        ],
        async () => {
          Harness({ point: null, coveringIds: [] });

          const headings = screen
            .getAllByRole("button", { expanded: true })
            .map((node) => node.textContent);
          expect(headings).toContainEqual(expect.stringMatching(/Ontario\s*2$/));
          expect(headings).toContainEqual(expect.stringMatching(/Nationwide\s*1$/));
        },
      );
    });

    it("collapses a country's regions and agencies without hiding another country", async () => {
      await withProviders(CATALOG, async () => {
        Harness({ point: null, coveringIds: [] });

        await fireEvent.click(screen.getByRole("button", { name: /Canada/ }));

        expect(screen.getByRole("button", { name: /Canada/ }).getAttribute("aria-expanded")).toBe(
          "false",
        );
        expect(screen.queryByRole("button", { name: /Ontario/ })).toBeNull();
        expect(screen.queryByText("Coast to Coast")).toBeNull();
        expect(screen.getByText("Empire Transit")).toBeDefined();

        await fireEvent.click(screen.getByRole("button", { name: /Canada/ }));
        expect(screen.getByText("Ontario Local")).toBeDefined();
        expect(screen.getByText("Coast to Coast")).toBeDefined();
      });
    });

    it("hides a region's agencies while its disclosure is collapsed", async () => {
      await withProviders(CATALOG, async () => {
        Harness({ point: null, coveringIds: [] });

        expect(screen.getByText("Ontario Local")).toBeDefined();

        const ontario = screen
          .getAllByRole("button", { expanded: true })
          .find((node) => node.textContent?.includes("Ontario"));
        await fireEvent.click(ontario!);

        expect(screen.queryByText("Ontario Local")).toBeNull();
        expect(screen.getByText("Coastal Transit")).toBeDefined();
      });
    });

    it("carries each region's agency count on its heading", async () => {
      await withProviders(
        [
          regionalAgency("ont", "Ontario Local", { country: "ca", region: "on" }),
          regionalAgency("ott", "Ottawa Local", { country: "ca", region: "on" }),
          regionalAgency("coast", "Coastal Transit", { country: "ca", region: "bc" }),
        ],
        async () => {
          Harness({ point: null, coveringIds: [] });

          const heading = (label: string) =>
            screen
              .getAllByRole("button", { expanded: true })
              .map((node) => node.textContent ?? "")
              .find((text) => text.includes(label));

          expect(heading("Ontario")).toMatch(/Ontario\s*2$/);
          expect(heading("British Columbia")).toMatch(/British Columbia\s*1$/);
        },
      );
    });
  });

  describe("showing the selection on open", () => {
    /**
     * The shell renders the picker on a pill click, long after preferences
     * load, and the picker brings its selection into view as it mounts. The
     * stored selection therefore has to be in place before the picker mounts,
     * which the injected storage settles.
     */
    function PickerAfterPreferencesLoad() {
      const prefs = useUserPreferences();
      return (
        <Show when={prefs.isLoaded()}>
          <AgencyPickerSheet
            isOpen={true}
            onClose={() => {}}
            effectiveAgency={() => snapshotFor([], null)}
            viewState={() => ({
              persistedSelection: "north",
              automaticAgencyId: undefined,
              displayedAgencyId: undefined,
              isTemporary: false,
            })}
            onSelectAgency={() => {}}
          />
        </Show>
      );
    }

    it("brings the stored selection into view as the picker opens", async () => {
      // Happy DOM scrolls nothing, so the behaviour under test is the call and
      // the row it was made on, not a resulting scroll offset.
      const scrollIntoView = vi
        .spyOn(Element.prototype, "scrollIntoView")
        .mockImplementation(() => {});

      const CATALOG = [
        regionalAgency("ont", "Ontario Local", { country: "ca", region: "on" }),
        regionalAgency("coast", "Coastal Transit", { country: "ca", region: "bc" }),
        regionalAgency("north", "Thunder Bay Transit", { country: "ca", region: "on" }),
      ];

      try {
        await withProviders(CATALOG, async () => {
          render(() => (
            <UserPreferencesProvider
              storage={createMemoryPreferencesStorage({ ...DEFAULT_PREFERENCES, agency: "north" })}
            >
              <PickerAfterPreferencesLoad />
            </UserPreferencesProvider>
          ));
          await new Promise((resolve) => setTimeout(resolve, 20));

          // The stored agency covers nothing here, so its only row sits inside
          // its own region group, below every group that precedes it.
          const checked = screen
            .getAllByRole("menuitemradio")
            .filter((row) => row.getAttribute("aria-checked") === "true");
          expect(checked).toHaveLength(1);
          expect(checked[0].textContent).toContain("Thunder Bay Transit");

          expect(scrollIntoView.mock.instances).toHaveLength(1);
          expect(scrollIntoView.mock.instances[0]).toBe(checked[0]);
        });
      } finally {
        scrollIntoView.mockRestore();
      }
    });
  });
});
