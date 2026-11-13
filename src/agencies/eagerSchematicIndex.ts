import { agencyCatalog } from "./agencyCatalog";
import { deriveAgencyLight, type AgencyLightIndex } from "./lightIndex";
import type { Schematic } from "./types";

// Bun CLI tools use the eager catalog; Vite replaces this module with split browser chunks.
export const agencyLightIndex: Readonly<Record<string, AgencyLightIndex>> = Object.fromEntries(
  agencyCatalog.flatMap(({ manifest, schematic }) =>
    schematic ? [[manifest.id, deriveAgencyLight(schematic)]] : [],
  ),
);

export const agencySchematicLoaders: Readonly<Record<string, () => Promise<Schematic>>> =
  Object.fromEntries(
    agencyCatalog.flatMap(({ manifest, schematic }) =>
      schematic ? [[manifest.id, () => Promise.resolve(schematic)]] : [],
    ),
  );
