/**
 * Agency coverage ranking (core deepening D2).
 *
 * The pure heart of `getAgenciesForPoint`: given every registered agency's
 * declared service bounds and the user's effective position, order the
 * agencies whose bounds contain the point SMALLEST-BOUNDING-BOX FIRST. A
 * geographically precise agency (e.g. GO inside the GTA) must win over a wide
 * regional one (e.g. TTC) wherever both cover the fix.
 *
 * Core owns the ranking policy; the registry only adapts AgencyProviders into
 * the structural shape below and applies its own empty-hit fallback. No
 * ~/agencies import is needed here, agencies arrive as plain data.
 */

/** One declared service bound. */
export interface CoverageBound {
  readonly minLat: number;
  readonly maxLat: number;
  readonly minLon: number;
  readonly maxLon: number;
}

/** Structural stand-in for an AgencyProvider's coverage declaration. */
export interface CoverageAgency {
  readonly id: string;
  readonly bounds: readonly CoverageBound[];
}

const boundContains = (b: CoverageBound, lat: number, lon: number): boolean =>
  lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon;

const boundArea = (b: CoverageBound): number => (b.maxLat - b.minLat) * (b.maxLon - b.minLon);

/**
 * Ids of the agencies covering `(lat, lon)`, ordered smallest-covering-area
 * first. Agencies whose bounds miss the point are dropped; ties keep input
 * order (stable sort). An empty result means NO agency covers the point and
 * the caller applies its own fallback.
 */
export function rankAgenciesForPoint(
  agencies: readonly CoverageAgency[],
  lat: number,
  lon: number,
): readonly string[] {
  const hits: { id: string; area: number }[] = [];
  for (const agency of agencies) {
    const covering = agency.bounds.filter((b) => boundContains(b, lat, lon));
    if (covering.length === 0) continue;
    // A multi-bound agency competes with its TIGHTEST covering bound only.
    hits.push({ id: agency.id, area: Math.min(...covering.map(boundArea)) });
  }
  // Stable per ECMAScript: equal areas preserve registration order.
  return hits.sort((a, b) => a.area - b.area).map((h) => h.id);
}
