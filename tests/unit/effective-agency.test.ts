vi.mock("~/agencies/agencyCatalog", async () => {
  const { testAgencyCatalog } = await import("../helpers/agency-fixtures");
  return { agencyCatalog: testAgencyCatalog };
});
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveEffectiveAgency as resolveEffectiveAgencyCore,
  isPointCovered as isPointCoveredCore,
  manifestFallbackBounds,
  manifestFocus,
} from "../../src/domain/location/EffectiveAgency";
import type { AgencyManifest } from "../../src/agencies/types";
import { makeTestProvider } from "../helpers/agency-fixtures";
import { createAgencySession } from "../../src/services/session/AgencySession";
import {
  allProviders,
  getActiveAgency,
  getAgencyById,
  resolveAgencyAtPoint,
} from "../../src/agencies/registry";
import {
  createLocationLadder,
  UNDERGROUND_TOLERANCE_MS,
} from "../../src/domain/location/locationLadder";

const SAMPLE_POINT = (() => {
  const sample = allProviders().find((p) => p.manifest.id === "sample")!;
  const b = sample.manifest.bounds[0];
  return { lat: (b.minLat + b.maxLat) / 2, lon: (b.minLon + b.maxLon) / 2 };
})();

const OUTSIDE_POINT = { lat: 0, lon: -30 }; // Atlantic — outside every declared bound
const LOCAL_POINT = (() => {
  const k = allProviders().find((p) => p.manifest.id === "local")!;
  const b = k.manifest.bounds[0];
  return { lat: (b.minLat + b.maxLat) / 2, lon: (b.minLon + b.maxLon) / 2 };
})();

type EffectiveAgencyInput = Parameters<typeof resolveEffectiveAgencyCore>[0];

function resolveEffectiveAgency(
  input: Omit<EffectiveAgencyInput, "providers"> & {
    readonly providers?: EffectiveAgencyInput["providers"];
  },
) {
  return resolveEffectiveAgencyCore({
    ...input,
    providers: input.providers ?? allProviders(),
  });
}

function isPointCovered(point: { lat: number; lon: number }): boolean {
  return isPointCoveredCore(point, allProviders());
}

describe("EffectiveAgency — pure resolveEffectiveAgency", () => {
  it.each([
    { point: undefined, source: "default" as const },
    { point: OUTSIDE_POINT, source: "coarse-ip" as const },
  ])("leaves Automatic unresolved without a covered location ($source)", ({ point, source }) => {
    const snap = resolveEffectiveAgency({
      point,
      selection: "auto",
      locationState: { status: "unavailable", source },
    });
    expect(snap.agencyId).toBeUndefined();
    expect(snap.automaticAgencyId).toBeUndefined();
    expect(snap.coveringIds).toEqual([]);
  });

  it("preserves a manual choice without inventing an Automatic winner", () => {
    const snap = resolveEffectiveAgency({
      selection: "regional",
      locationState: { status: "denied", source: "default" },
    });
    expect(snap.agencyId).toBe("regional");
    expect(snap.automaticAgencyId).toBeUndefined();
  });

  it("keeps non-local station coverage without displacing a regional operator", () => {
    const regional = makeTestProvider({
      id: "regional",
      bounds: [{ minLat: 40, maxLat: 50, minLon: -90, maxLon: -70 }],
    });
    const national = makeTestProvider({
      id: "national",
      scope: "national",
      bounds: [
        { minLat: 43, maxLat: 43.02, minLon: -80, maxLon: -79.98 },
        { minLat: 55, maxLat: 55.02, minLon: -100, maxLon: -99.98 },
      ],
    });
    const resolve = (lat: number, lon: number) =>
      resolveEffectiveAgency({
        providers: [regional, national],
        point: { lat, lon },
        selection: "auto",
        locationState: { status: "granted", source: "gps" },
      });
    expect(resolve(43.01, -79.99)).toMatchObject({
      automaticAgencyId: "regional",
      coveringIds: ["national", "regional"],
      stationCoveringIds: ["national", "regional"],
    });
    expect(resolve(55.01, -99.99)).toMatchObject({
      automaticAgencyId: "national",
      coveringIds: ["national"],
    });
    expect(resolve(53, -95)).toMatchObject({
      automaticAgencyId: undefined,
      coveringIds: [],
      stationCoveringIds: [],
    });
  });
  it.each([
    {
      label: "expired + gps → hold previous (coarse fallback must not move)",
      input: {
        point: SAMPLE_POINT,
        selection: "auto" as const,
        previousAutomatic: "local",
        locationState: { status: "expired" as const, source: "gps" as const },
      },
      expectedAgency: "local",
    },
    {
      label: "expired + coarse-ip → hold previous",
      input: {
        point: SAMPLE_POINT,
        selection: "auto" as const,
        previousAutomatic: "local",
        locationState: { status: "expired" as const, source: "coarse-ip" as const },
      },
      expectedAgency: "local",
    },
    {
      label: "expired + dev-spoof → move to bbox match",
      input: {
        point: SAMPLE_POINT,
        selection: "auto" as const,
        previousAutomatic: "local",
        locationState: { status: "expired" as const, source: "dev-spoof" as const },
      },
      expectedAgency: "sample",
    },
    {
      label: "!point → hold previous even when granted",
      input: {
        point: null,
        selection: "auto" as const,
        previousAutomatic: "local",
        locationState: { status: "granted" as const, source: "gps" as const },
      },
      expectedAgency: "local",
    },
    {
      label: "out-of-bounds leaves Automatic unresolved",
      input: {
        point: OUTSIDE_POINT,
        selection: "auto" as const,
        locationState: { status: "granted" as const, source: "gps" as const },
      },
      expectedAgency: undefined,
    },
  ])("$label", ({ input, expectedAgency }) => {
    const snap = resolveEffectiveAgency(input);
    expect(snap.agencyId).toBe(expectedAgency);
  });

  it("out-of-bounds leaves display and coverage unresolved", () => {
    const snap = resolveEffectiveAgency({
      point: OUTSIDE_POINT,
      selection: "auto",
      locationState: { status: "granted", source: "gps" },
    });
    expect(snap.agencyId).toBeUndefined();
    expect(snap.coveringIds).toEqual([]);
    expect(snap.stationCoveringIds).toEqual([]);
    expect(snap.declaredCoveringIds).toEqual([]);
    // Inside bounds should be smallest-bbox-wins, not fallback
    const inside = resolveEffectiveAgency({
      point: SAMPLE_POINT,
      selection: "auto",
      locationState: { status: "granted", source: "gps" },
    });
    expect(inside.coveringIds.length).toBeGreaterThan(0);
    expect(inside.coveringIds[0]).toBe("sample");
  });

  it("dev-spoof with an explicit agencyId resolves to that agency and prioritizes it in coveringIds", () => {
    const snap = resolveEffectiveAgency({
      point: SAMPLE_POINT,
      fix: {
        latitude: SAMPLE_POINT.lat,
        longitude: SAMPLE_POINT.lon,
        timestamp: Date.now(),
        agencyId: "metro",
      },
      selection: "auto",
      locationState: { status: "granted", source: "dev-spoof" },
    });
    expect(snap.agencyId).toBe("metro");
    expect(snap.automaticAgencyId).toBe("metro");
    expect(snap.coveringIds[0]).toBe("metro");
  });

  it("!point gives empty coveringIds (no fan-out)", () => {
    const snap = resolveEffectiveAgency({
      point: null,
      selection: "auto",
      locationState: { status: "idle", source: "default" },
    });
    expect(snap.coveringIds).toEqual([]);
    expect(snap.stationCoveringIds).toEqual([]);
    expect(snap.fix).toBeNull();
  });

  it("stationCoveringIds filters out covering agencies without a stations source", () => {
    const providers = [
      {
        manifest: {
          id: "with-stations",
          bounds: [{ minLat: 43, maxLat: 44, minLon: -80, maxLon: -79 }],
          status: "active",
        },
        createStationsSource: () => ({}),
      },
      {
        manifest: {
          id: "without-stations",
          bounds: [{ minLat: 43, maxLat: 44, minLon: -80, maxLon: -79 }],
          status: "active",
        },
      },
    ] as unknown as Parameters<typeof resolveEffectiveAgency>[0]["providers"];
    const snap = resolveEffectiveAgency({
      point: { lat: 43.5, lon: -79.5 },
      selection: "auto",
      locationState: { status: "granted", source: "gps" },
      providers,
    });
    expect(snap.coveringIds).toEqual(["with-stations", "without-stations"]);
    expect(snap.stationCoveringIds).toEqual(["with-stations"]);
  });

  it("derives station coverage from the injected provider list", () => {
    const providers = [
      {
        manifest: {
          id: "synthetic",
          bounds: [{ minLat: 43, maxLat: 44, minLon: -80, maxLon: -79 }],
          status: "active",
        },
        createStationsSource: () => ({}),
      },
    ] as unknown as Parameters<typeof resolveEffectiveAgency>[0]["providers"];

    const snap = resolveEffectiveAgency({
      point: { lat: 43.5, lon: -79.5 },
      selection: "auto",
      locationState: { status: "granted", source: "gps" },
      providers,
    });

    expect(snap.stationCoveringIds).toEqual(["synthetic"]);
  });

  it("derives station coverage from manifest-only browser providers", () => {
    const providers = [
      {
        manifest: {
          id: "manifest-only",
          bounds: [{ minLat: 43, maxLat: 44, minLon: -80, maxLon: -79 }],
          stationService: { routeType: "rail" },
          status: "active",
        },
      },
    ] as unknown as Parameters<typeof resolveEffectiveAgency>[0]["providers"];

    const snap = resolveEffectiveAgency({
      point: { lat: 43.5, lon: -79.5 },
      selection: "auto",
      locationState: { status: "granted", source: "gps" },
      providers,
    });

    expect(snap.stationCoveringIds).toEqual(["manifest-only"]);
  });

  it("pinned selection wins over bbox, degraded pin falls back to auto", () => {
    const pinned = resolveEffectiveAgency({
      point: SAMPLE_POINT,
      selection: "regional",
      locationState: { status: "granted", source: "gps" },
    });
    expect(pinned.agencyId).toBe("regional");

    const degraded = resolveEffectiveAgency({
      point: SAMPLE_POINT,
      selection: "ghost-transit",
      locationState: { status: "granted", source: "gps" },
    });
    expect(degraded.agencyId).toBe("sample");
  });

  it("exposes the Automatic winner separately from a manual selection", () => {
    const pinned = resolveEffectiveAgency({
      point: SAMPLE_POINT,
      selection: "regional",
      locationState: { status: "granted", source: "gps" },
    });

    expect(pinned.agencyId).toBe("regional");
    expect(pinned.automaticAgencyId).toBe("sample");
    expect(pinned.declaredCoveringIds).toContain("sample");
  });

  it("fix echo preserves provided fix", () => {
    const fix = { latitude: 43.1, longitude: -79.1, timestamp: 12345, accuracy: 10 };
    const snap = resolveEffectiveAgency({
      point: { lat: 43.1, lon: -79.1 },
      fix,
      selection: "auto",
      locationState: { status: "granted", source: "gps" },
    });
    expect(snap.fix).toBe(fix);
    expect(snap.source).toBe("gps");
    expect(snap.status).toBe("granted");
  });

  it("isPointCovered seam matches rank without fallback", () => {
    expect(isPointCovered(SAMPLE_POINT)).toBe(true);
    expect(isPointCovered(OUTSIDE_POINT)).toBe(false);
  });
});

describe("EffectiveAgency — registry resolution adapters", () => {
  it.each([
    {
      label: "leaves point selection unresolved without a point",
      point: undefined,
      expectedAgencyId: undefined,
    },
    {
      label: "leaves point selection unresolved outside declared bounds",
      point: OUTSIDE_POINT,
      expectedAgencyId: undefined,
    },
    {
      label: "selects the registered provider whose bounds contain the point",
      point: SAMPLE_POINT,
      expectedAgencyId: "sample",
    },
  ] as const)("$label", ({ point, expectedAgencyId }) => {
    const active = getActiveAgency(point);

    expect(active?.manifest.id).toBe(expectedAgencyId);
    expect(resolveAgencyAtPoint(point ?? OUTSIDE_POINT).agencyId).toBe(expectedAgencyId);
  });

  it("preserves honest point coverage at the selected provider boundary", () => {
    expect(getActiveAgency(SAMPLE_POINT)).toBe(getAgencyById("sample"));
    expect(resolveAgencyAtPoint(SAMPLE_POINT).agencyId).toBe("sample");
    expect(isPointCovered(SAMPLE_POINT)).toBe(true);
    expect(isPointCovered(OUTSIDE_POINT)).toBe(false);
  });
});

describe("EffectiveAgency — expiry → point → selection → coveringIds integration", () => {
  it("granted fix inside Sample Transit → covers [sample] and agency sample", () => {
    const snap = resolveEffectiveAgency({
      point: SAMPLE_POINT,
      selection: "auto",
      locationState: { status: "granted", source: "gps" },
    });
    expect(snap.agencyId).toBe("sample");
    expect(snap.coveringIds).toContain("sample");
  });

  it("local point in auto → local agency with correct covering", () => {
    const snap = resolveEffectiveAgency({
      point: LOCAL_POINT,
      selection: "auto",
      locationState: { status: "granted", source: "gps" },
    });
    // Local's bounds are nested inside? For local point, smallest bbox wins may be local
    // Check that covering contains local
    expect(snap.coveringIds).toContain("local");
  });

  it("ranks smaller local coverage ahead of a containing regional box", () => {
    const snap = resolveEffectiveAgency({
      point: SAMPLE_POINT,
      selection: "auto",
      locationState: { status: "granted", source: "gps" },
    });
    expect(snap.coveringIds).toContain("regional");
    expect(snap.automaticAgencyId).toBe("sample");
    expect(snap.stationCoveringIds).toContain("sample");
  });
});

describe("EffectiveAgency — ladder owns expiry scheduling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not poll a ladder that provides its own scheduler", async () => {
    const NOW = 1_800_000_000_000;
    let clock = NOW;
    let expiryTick: (() => void) | undefined;
    const ladder = createLocationLadder({
      now: () => clock,
      requestPosition: ((onSuccess) =>
        onSuccess({
          coords: { latitude: SAMPLE_POINT.lat, longitude: SAMPLE_POINT.lon, accuracy: 10 },
          timestamp: NOW,
        })) as Parameters<typeof createLocationLadder>[0]["requestPosition"],
      storage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      },
      spoofGateActive: true,
      scheduleExpiry: (check) => {
        expiryTick = check;
        return () => {};
      },
    });
    ladder.request();
    const session = createAgencySession({
      providers: allProviders,
      selection: () => "auto",
      locationLadder: ladder,
    });

    clock += UNDERGROUND_TOLERANCE_MS + 1;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ladder.status()).toBe("granted");

    expiryTick?.();
    expect(ladder.status()).toBe("expired");
    session.dispose();
    ladder.dispose();
  });
});

describe("agency-derived operational defaults", () => {
  function manifestWith(bounds: AgencyManifest["bounds"]): AgencyManifest {
    return {
      id: "test-agency",
      name: "Test Agency",
      locale: "en-CA",
      timezone: "America/Toronto",
      bounds,
      modes: ["rail"],
      stationService: { routeType: "rail" },
      attribution: { name: "Test", url: "https://example.com", license: "MIT" },
      status: "active",
    };
  }

  it("derives the focus point as the midpoint of a single declared bound", () => {
    const focus = manifestFocus(
      manifestWith([{ minLat: 43, maxLat: 44, minLon: -80, maxLon: -78 }]),
    );

    expect(focus).toEqual({ lat: 43.5, lon: -79 });
  });

  it("uses declared focus without narrowing the fallback extent", () => {
    const manifest = {
      ...manifestWith([{ minLat: 40, maxLat: 60, minLon: -125, maxLon: -60 }]),
      focus: { lat: 43.65, lon: -79.38 },
    };
    expect(manifestFocus(manifest)).toEqual({ lat: 43.65, lon: -79.38 });
    expect(manifestFallbackBounds(manifest)).toEqual({
      minLat: 40,
      maxLat: 60,
      minLon: -125,
      maxLon: -60,
    });
  });

  it("derives the focus point from the hub of every declared bound", () => {
    const focus = manifestFocus(
      manifestWith([
        { minLat: 10, maxLat: 12, minLon: 30, maxLon: 32 },
        { minLat: 40, maxLat: 42, minLon: -80, maxLon: -78 },
      ]),
    );

    expect(focus).toEqual({ lat: 26, lon: -24 });
  });

  it("refuses to invent a focus when the manifest declares no bounds", () => {
    expect(() => manifestFocus(manifestWith([]))).toThrow(/bounds/);
  });

  it("exposes the hub of declared bounds as the generic fallback viewport", () => {
    const bounds = manifestFallbackBounds(
      manifestWith([
        { minLat: 10, maxLat: 12, minLon: 30, maxLon: 32 },
        { minLat: 40, maxLat: 42, minLon: -80, maxLon: -78 },
      ]),
    );

    expect(bounds).toEqual({ minLat: 10, maxLat: 42, minLon: -80, maxLon: 32 });
  });
});
