// @vitest-environment happy-dom
// Session transitions need Solid's client runtime; SSR does not rerun memos after writes.
import { describe, expect, it } from "vitest";
import { createRoot, createSignal, flush } from "solid-js";
import { createAgencySession } from "~/services/session/AgencySession";
import type { LocationLadder } from "~/domain/location/locationLadder";
import type { BrowserAgency, Schematic } from "~/agencies/types";
import { withSchematic } from "../helpers/browser-agency";
import type { InterchangeFocus } from "~/components/map/interchange-navigation";
import type { InterchangeStationReference } from "~/domain/map/Interchange";

const miniSchematic = {
  viewBoxWidth: 100,
  viewBoxHeight: 100,
  lines: [
    {
      id: "L1",
      name: "Line 1",
      color: "#000",
      points: [
        { x: 10, y: 10 },
        { x: 90, y: 90 },
      ],
    },
  ],
  stations: [
    { id: "alpha", name: "Alpha", x: 10, y: 10, lines: ["L1"] },
    { id: "beta", name: "Beta", x: 90, y: 90, lines: ["L1"] },
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

function makeProviders(): BrowserAgency[] {
  const ttc: BrowserAgency = {
    ...withSchematic(miniSchematic as unknown as Schematic),
    manifest: {
      id: "ttc",
      name: "TTC",
      locale: "en-CA",
      timezone: "America/Toronto",
      bounds: [{ minLat: 43.58, maxLat: 43.86, minLon: -79.64, maxLon: -79.11 }],
      modes: ["subway"],
      stationService: { routeType: "subway" },
      attribution: { name: "City", url: "https://example.com", license: "MIT" },
      status: "active",
    },
  };
  const go: BrowserAgency = {
    ...withSchematic(miniSchematic as unknown as Schematic),
    manifest: {
      id: "go",
      name: "GO Transit",
      locale: "en-CA",
      timezone: "America/Toronto",
      bounds: [{ minLat: 43.25, maxLat: 44.5, minLon: -79.9, maxLon: -78.9 }],
      modes: ["rail"],
      stationService: { routeType: "rail" },
      attribution: { name: "Metrolinx", url: "https://example.com", license: "MIT" },
      status: "experimental",
    },
  };
  const yrt: BrowserAgency = {
    ...withSchematic(miniSchematic as unknown as Schematic),
    manifest: {
      id: "yrt",
      name: "YRT",
      locale: "en-CA",
      timezone: "America/Toronto",
      bounds: [{ minLat: 43.8, maxLat: 44.2, minLon: -79.6, maxLon: -79.2 }],
      modes: ["bus"],
      stationService: { routeType: "bus" },
      attribution: { name: "YRT", url: "https://example.com", license: "MIT" },
      status: "experimental",
    },
  };
  return [ttc, go, yrt];
}

function createMockLadder(
  override: Partial<LocationLadder> & {
    fix?: import("~/domain/location/locationLadder").Coordinates | null;
    source?: import("~/lib/location-source").LocationSource;
    statusValue?: import("~/domain/location/locationLadder").GeolocationStatus;
  } = {},
) {
  let fix = override.fix ?? null;
  let source = override.source ?? "default";
  let status = override.statusValue ?? "idle";
  const listeners = new Set<() => void>();
  const ladder = {
    effectiveFix: () => ({ fix, source }),
    status: () => status,
    subscribe: (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    errorMessage: () => null,
    request: () => {},
    startPriming: () => {},
    cancelPriming: () => {},
    applySpoof: () => {},
    clearSpoof: () => {},
    restorePersistedSpoof: () => {},
    seedCoarse: async () => {},
    coarseSeedState: () => ({ status: "idle" as const }),
    seededCoarse: () => null,
    clearLocation: () => {},
    checkExpiry: () => {},
    markPermissionDenied: () => {},
    dispose: () => {},
    _setFix: (newFix: typeof fix, newSource: typeof source, newStatus: typeof status) => {
      fix = newFix;
      source = newSource;
      status = newStatus;
      for (const l of listeners) l();
    },
  };
  // allow overrides
  Object.assign(ladder, override);
  return ladder as unknown as LocationLadder & {
    _setFix: (
      f: import("~/domain/location/locationLadder").Coordinates | null,
      s: import("~/lib/location-source").LocationSource,
      st: import("~/domain/location/locationLadder").GeolocationStatus,
    ) => void;
  };
}

const ttcUnion: InterchangeStationReference = { agencyId: "ttc", stationId: "union" };
const goUnion: InterchangeStationReference = { agencyId: "go", stationId: "union" };
const yrtFinch: InterchangeStationReference = { agencyId: "yrt", stationId: "finch" };

function focusFor(
  target: InterchangeStationReference,
  origin: InterchangeStationReference,
): InterchangeFocus {
  return {
    agencyId: target.agencyId,
    stationId: target.stationId,
    stationName: target.stationId,
    origin,
    screenScale: 1,
  };
}

describe("AgencySession — deep session ownership (no DOM)", () => {
  it("derives baseAgency from location ladder and Automatic selection", () =>
    createRoot((dispose) => {
      const providers = makeProviders();
      const ladder = createMockLadder({
        fix: { latitude: 43.65, longitude: -79.38, timestamp: 1 },
        source: "gps",
        statusValue: "granted",
      });
      const [selection, setSelection] = createSignal<"auto" | string>("auto", {
        ownedWrite: true,
      });
      const session = createAgencySession({
        providers: () => providers,
        selection,
        setSelection,
        locationLadder: ladder,
      });

      expect(session.snapshot().agencyId).toBe("ttc");
      expect(session.baseAgency()?.manifest.id).toBe("ttc");
      expect(session.displayedAgencyId()).toBe("ttc");
      expect(session.displayedAgency()?.manifest.id).toBe("ttc");
      expect(session.isTemporary()).toBe(false);
      dispose();
    }));

  it("keeps Automatic selected while displaying a temporary interchange agency", () =>
    createRoot((dispose) => {
      const providers = makeProviders();
      const ladder = createMockLadder({
        fix: { latitude: 43.65, longitude: -79.38, timestamp: 1 },
        source: "gps",
        statusValue: "granted",
      });
      const session = createAgencySession({
        providers: () => providers,
        selection: () => "auto",
        locationLadder: ladder,
      });

      session.navigateToInterchange(focusFor(goUnion, ttcUnion));
      // Writes are staged: commit before asserting or chaining.
      flush();

      expect(session.isTemporary()).toBe(true);
      expect(session.displayedAgencyId()).toBe("go");
      expect(session.displayedAgency()?.manifest.id).toBe("go");
      expect(session.baseAgency()?.manifest.id).toBe("ttc");
      expect(session.snapshot().agencyId).toBe("ttc");
      expect(session.temporaryOrigin()).toEqual(ttcUnion);
      dispose();
    }));

  it("clears a temporary view when the picker selects auto or a pinned agency", () =>
    createRoot((dispose) => {
      const providers = makeProviders();
      const ladder = createMockLadder();
      const [selection, setSelection] = createSignal<"auto" | string>("auto", {
        ownedWrite: true,
      });
      const session = createAgencySession({
        providers: () => providers,
        selection,
        setSelection: (s) => setSelection(s),
        locationLadder: ladder,
      });

      session.navigateToInterchange(focusFor(goUnion, ttcUnion));
      // Writes are staged: commit before asserting or chaining.
      flush();
      expect(session.isTemporary()).toBe(true);

      session.selectAgency("auto");
      flush();
      expect(session.isTemporary()).toBe(false);
      expect(session.displayedAgencyId()).toBe(session.snapshot().agencyId);
      expect(selection()).toBe("auto");

      session.navigateToInterchange(focusFor(goUnion, ttcUnion));
      // Writes are staged: commit before asserting or chaining.
      flush();
      session.selectAgency("ttc");
      flush();
      expect(session.isTemporary()).toBe(false);
      expect(selection()).toBe("ttc");
      dispose();
    }));

  it("restores saved pinned selection when clearing via picker", () =>
    createRoot((dispose) => {
      const providers = makeProviders();
      const ladder = createMockLadder();
      const [selection, setSelection] = createSignal<"auto" | string>("ttc", {
        ownedWrite: true,
      });
      const session = createAgencySession({
        providers: () => providers,
        selection,
        setSelection: (s) => setSelection(s),
        locationLadder: ladder,
      });

      session.navigateToInterchange(focusFor(yrtFinch, ttcUnion));
      flush();
      expect(session.isTemporary()).toBe(true);
      expect(session.displayedAgencyId()).toBe("yrt");

      session.selectAgency("ttc");
      flush();
      expect(session.isTemporary()).toBe(false);
      expect(session.displayedAgencyId()).toBe(session.baseAgency()?.manifest.id);
      expect(selection()).toBe("ttc");
      dispose();
    }));

  it("replaces a temporary interchange target without changing base selection, preserving origin", () =>
    createRoot((dispose) => {
      const providers = makeProviders();
      const ladder = createMockLadder();
      const session = createAgencySession({
        providers: () => providers,
        selection: () => "auto",
        locationLadder: ladder,
      });

      session.navigateToInterchange(focusFor(goUnion, ttcUnion));
      // Writes are staged: commit before asserting or chaining.
      flush();
      expect(session.temporaryOrigin()).toEqual(ttcUnion);

      session.navigateToInterchange(focusFor(yrtFinch, goUnion));
      flush();
      expect(session.displayedAgencyId()).toBe("yrt");
      expect(session.temporaryOrigin()).toEqual(ttcUnion);
      expect(session.baseAgency()?.manifest.id).toBe(session.snapshot().agencyId);
      dispose();
    }));

  it("exits a temporary view when chained navigation returns to its origin", () =>
    createRoot((dispose) => {
      const providers = makeProviders();
      const ladder = createMockLadder();
      const session = createAgencySession({
        providers: () => providers,
        selection: () => "auto",
        locationLadder: ladder,
      });

      session.navigateToInterchange(focusFor(goUnion, ttcUnion));
      // Writes are staged: commit before asserting or chaining.
      flush();
      session.navigateToInterchange(focusFor(yrtFinch, goUnion));
      flush();
      expect(session.isTemporary()).toBe(true);

      session.navigateToInterchange(focusFor(ttcUnion, yrtFinch));
      flush();
      expect(session.isTemporary()).toBe(false);
      expect(session.displayedAgencyId()).toBe(session.baseAgency()?.manifest.id);
      expect(session.temporaryOrigin()).toBeUndefined();
      dispose();
    }));

  it("exits a temporary view when returning to the original agency via a different interchange badge", () =>
    createRoot((dispose) => {
      const providers = makeProviders();
      const ladder = createMockLadder({
        fix: { latitude: 43.65, longitude: -79.38, timestamp: 1 },
        source: "gps",
        statusValue: "granted",
      });
      const session = createAgencySession({
        providers: () => providers,
        selection: () => "auto",
        locationLadder: ladder,
      });

      const ttcDundas: InterchangeStationReference = { agencyId: "ttc", stationId: "dundas" };
      session.navigateToInterchange(focusFor(goUnion, ttcDundas));
      flush();
      expect(session.isTemporary()).toBe(true);
      expect(session.displayedAgencyId()).toBe("go");
      expect(session.temporaryOrigin()).toEqual(ttcDundas);

      // Clicks an interchange badge returning to TTC, but at union rather than dundas
      session.navigateToInterchange(focusFor(ttcUnion, goUnion));
      flush();
      expect(session.isTemporary()).toBe(false);
      expect(session.displayedAgencyId()).toBe("ttc");
      expect(session.temporaryOrigin()).toBeUndefined();
      dispose();
    }));

  it("keeps a pinned selection while displaying a temporary interchange agency", () =>
    createRoot((dispose) => {
      const providers = makeProviders();
      const ladder = createMockLadder();
      const session = createAgencySession({
        providers: () => providers,
        selection: () => "ttc",
        locationLadder: ladder,
      });

      session.navigateToInterchange(focusFor(yrtFinch, ttcUnion));
      flush();

      expect(session.displayedAgencyId()).toBe("yrt");
      expect(session.baseAgency()?.manifest.id).toBe("ttc");
      expect(session.isTemporary()).toBe(true);
      expect(session.temporaryOrigin()).toEqual(ttcUnion);
      dispose();
    }));

  it("clearTemporaryView restores base agency without touching selection", () =>
    createRoot((dispose) => {
      const providers = makeProviders();
      const ladder = createMockLadder();
      const [selection] = createSignal<"auto" | string>("auto");
      const session = createAgencySession({
        providers: () => providers,
        selection,
        locationLadder: ladder,
      });

      session.navigateToInterchange(focusFor(goUnion, ttcUnion));
      // Writes are staged: commit before asserting or chaining.
      flush();
      expect(session.isTemporary()).toBe(true);

      session.clearTemporaryView();
      flush();
      expect(session.isTemporary()).toBe(false);
      expect(session.displayedAgencyId()).toBe(session.baseAgency()?.manifest.id);
      expect(selection()).toBe("auto");
      dispose();
    }));

  it("provides a single consistent snapshot for baseAgency and coveringIds", () =>
    createRoot((dispose) => {
      const providers = makeProviders();
      const ladder = createMockLadder({
        fix: { latitude: 43.65, longitude: -79.38, timestamp: 1 },
        source: "gps",
        statusValue: "granted",
      });
      const session = createAgencySession({
        providers: () => providers,
        selection: () => "auto",
        locationLadder: ladder,
      });

      const snap = session.snapshot();
      expect(snap.coveringIds.length).toBeGreaterThan(0);
      expect(snap.automaticAgencyId).toBe("ttc");
      expect(session.baseAgency()?.manifest.id).toBe(snap.agencyId);
      dispose();
    }));

  it("reacts to ladder changes via subscription", () =>
    createRoot((dispose) => {
      const providers = makeProviders();
      const ladder = createMockLadder({
        fix: { latitude: 43.65, longitude: -79.38, timestamp: 1 },
        source: "gps",
        statusValue: "granted",
      });
      const session = createAgencySession({
        providers: () => providers,
        selection: () => "auto",
        locationLadder: ladder,
      });

      const first = session.snapshot().agencyId;
      expect(first).toBe("ttc");

      // Move fix to GO-only area (south of YRT/TTC)
      (ladder as unknown as { _setFix: (f: never, s: never, st: never) => void })._setFix(
        { latitude: 43.3, longitude: -79.8, timestamp: 2 } as never,
        "gps" as never,
        "granted" as never,
      );
      // The session commits the notified snapshot on the next microtask
      // (Solid 2 stages the write): drain before asserting.
      flush();

      expect(session.snapshot().agencyId).toBe("go");
      expect(session.baseAgency()?.manifest.id).toBe("go");
      dispose();
    }));

  describe("AgencySession hold matrix", () => {
    it("expired + gps holds previous agency even if fix coordinates change", () =>
      createRoot((dispose) => {
        const providers = makeProviders();
        const ladder = createMockLadder({
          fix: { latitude: 44.0, longitude: -79.4, timestamp: 1 },
          source: "gps",
          statusValue: "granted",
        });
        const session = createAgencySession({
          providers: () => providers,
          selection: () => "auto",
          locationLadder: ladder,
        });

        expect(session.snapshot().agencyId).toBe("yrt");

        // Expire and move to TTC coordinates
        ladder._setFix({ latitude: 43.65, longitude: -79.38, timestamp: 2 }, "gps", "expired");
        flush();

        expect(session.snapshot().agencyId).toBe("yrt");
        expect(session.baseAgency()?.manifest.id).toBe("yrt");
        session.dispose();
        dispose();
      }));

    it("expired + dev-spoof moves to bbox match (does not hold)", () =>
      createRoot((dispose) => {
        const providers = makeProviders();
        const ladder = createMockLadder({
          fix: { latitude: 44.0, longitude: -79.4, timestamp: 1 },
          source: "gps",
          statusValue: "granted",
        });
        const session = createAgencySession({
          providers: () => providers,
          selection: () => "auto",
          locationLadder: ladder,
        });

        expect(session.snapshot().agencyId).toBe("yrt");

        // Dev-spoof at TTC point even though expired
        ladder._setFix(
          { latitude: 43.65, longitude: -79.38, timestamp: 2 },
          "dev-spoof",
          "expired",
        );
        flush();

        expect(session.snapshot().agencyId).toBe("ttc");
        session.dispose();
        dispose();
      }));

    it("no-point holds previous agency even when granted", () =>
      createRoot((dispose) => {
        const providers = makeProviders();
        const ladder = createMockLadder({
          fix: { latitude: 44.0, longitude: -79.4, timestamp: 1 },
          source: "gps",
          statusValue: "granted",
        });
        const session = createAgencySession({
          providers: () => providers,
          selection: () => "auto",
          locationLadder: ladder,
        });

        expect(session.snapshot().agencyId).toBe("yrt");

        // Transition to default source (no real point)
        ladder._setFix(null, "default", "granted");

        expect(session.snapshot().agencyId).toBe("yrt");
        session.dispose();
        dispose();
      }));

    it("starts unresolved when initialized with no point", () =>
      createRoot((dispose) => {
        const providers = makeProviders();
        const ladder = createMockLadder({
          fix: null,
          source: "default",
          statusValue: "idle",
        });
        const session = createAgencySession({
          providers: () => providers,
          selection: () => "auto",
          locationLadder: ladder,
        });

        expect(session.snapshot().agencyId).toBeUndefined();
        expect(session.baseAgency()).toBeUndefined();
        expect(session.displayedAgency()).toBeUndefined();
        session.dispose();
        dispose();
      }));

    it("write-only hold: repeated snapshot reads have no side-effects", () =>
      createRoot((dispose) => {
        const providers = makeProviders();
        const ladder = createMockLadder({
          fix: { latitude: 44.0, longitude: -79.4, timestamp: 1 },
          source: "gps",
          statusValue: "granted",
        });
        const session = createAgencySession({
          providers: () => providers,
          selection: () => "auto",
          locationLadder: ladder,
        });

        const snap1 = session.snapshot();
        const snap2 = session.snapshot();
        expect(snap1).toBe(snap2);
        expect(snap1.agencyId).toBe("yrt");

        ladder._setFix({ latitude: 43.65, longitude: -79.38, timestamp: 2 }, "gps", "expired");

        const held1 = session.snapshot();
        const held2 = session.snapshot();
        expect(held1).toBe(held2);
        expect(held1.agencyId).toBe("yrt");
        session.dispose();
        dispose();
      }));

    it("dispose unsubscribes from ladder so further updates are ignored", () =>
      createRoot((dispose) => {
        const providers = makeProviders();
        const ladder = createMockLadder({
          fix: { latitude: 43.65, longitude: -79.38, timestamp: 1 },
          source: "gps",
          statusValue: "granted",
        });
        const session = createAgencySession({
          providers: () => providers,
          selection: () => "auto",
          locationLadder: ladder,
        });

        expect(session.snapshot().agencyId).toBe("ttc");

        session.dispose();

        ladder._setFix({ latitude: 44.0, longitude: -79.4, timestamp: 2 }, "gps", "granted");

        expect(session.snapshot().agencyId).toBe("ttc");
        dispose();
      }));

    it("updates snapshot and baseAgency when selectAgency is called", () =>
      createRoot((dispose) => {
        const providers = makeProviders();
        const ladder = createMockLadder({
          fix: { latitude: 43.65, longitude: -79.38, timestamp: 1 },
          source: "gps",
          statusValue: "granted",
        });
        const [selection, setSelection] = createSignal<string>("auto", {
          ownedWrite: true,
        });
        const session = createAgencySession({
          providers: () => providers,
          selection,
          setSelection,
          locationLadder: ladder,
        });

        expect(session.snapshot().agencyId).toBe("ttc");
        expect(session.baseAgency()?.manifest.id).toBe("ttc");

        session.selectAgency("go");
        flush();

        expect(session.snapshot().agencyId).toBe("go");
        expect(session.baseAgency()?.manifest.id).toBe("go");
        expect(selection()).toBe("go");
        session.dispose();
        dispose();
      }));
  });
});
