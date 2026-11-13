import type { AgencyAlert, Schematic } from "~/agencies/types";

const now = Date.now();

export const makeAlert = (overrides: Partial<AgencyAlert> = {}): AgencyAlert => ({
  id: "alert_1",
  kind: "delay",
  severity: "degraded",
  lifecycle: "active",
  scope: "network",
  title: "97 Yonge: Construction Delays",
  description: "Expect 5-10 minute delays due to watermain work near St Clair.",
  startsAt: now - 3600_000,
  updatedAt: now,
  ...overrides,
});

export const makeAgencyAlert = (overrides: Partial<AgencyAlert> = {}): AgencyAlert => ({
  id: "alert_1",
  kind: "delay",
  severity: "degraded",
  lifecycle: "active",
  scope: "network",
  title: "97 Yonge: Construction Delays",
  description: "Expect 5-10 minute delays due to watermain work near St Clair.",
  startsAt: now - 3600_000,
  updatedAt: now,
  ...overrides,
});

/**
 * Minimal contract-valid Schematic for stub providers in tests that
 * exercise everything except the map itself.
 */
export const makeMinimalSchematic = (): Schematic => ({
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
  viewport: {
    bounds: { minX: 0, maxX: 100, minY: 0, maxY: 100 },
    minZoom: 0.5,
    maxZoom: 4,
  },
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
});

/**
 * happy-dom's localStorage delegates to Node's experimental localStorage,
 * which is unavailable under vitest (no --localstorage-file). Tests that
 * exercise code reading window.localStorage install this Map-backed stand-in.
 */
export class MemoryLocalStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  get length(): number {
    return this.store.size;
  }
}
