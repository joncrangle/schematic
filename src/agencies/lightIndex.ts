/**
 * Light per-agency schematic facts that cross-agency browser consumers read
 * synchronously (picker distances, interchange targets, line colours). The
 * full geometry is lazy; this slice ships with the eager catalog.
 *
 * The browser reads this slice from the `virtual:agency-schematics` module,
 * which `scripts/lib/agency-schematics-vite-plugin.ts` derives from every
 * `schematic.json` with `deriveAgencyLight`. Nothing here is hand-maintained.
 */
import type { Schematic } from "./types.ts";

export interface AgencyLightLine {
  readonly id: string;
  readonly name: string;
  readonly color: string;
}

export interface AgencyLightIndex {
  readonly lines: readonly AgencyLightLine[];
  /** Every drawn station id, for interchange target validation. */
  readonly stationIds: readonly string[];
  /** `[lat, lon]` of every stationIndex entry, for nearest-station distance. */
  readonly stationPoints: readonly (readonly [number, number])[];
}

type LightSource = Pick<Schematic, "lines" | "stations" | "stationIndex">;

export function deriveAgencyLight(schematic: LightSource): AgencyLightIndex {
  return {
    lines: schematic.lines.map((line) => ({ id: line.id, name: line.name, color: line.color })),
    stationIds: schematic.stations.map((station) => station.id),
    stationPoints: (schematic.stationIndex ?? []).map((entry) => [entry.lat, entry.lon] as const),
  };
}
