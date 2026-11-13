import { deriveAgencyLight } from "~/agencies/lightIndex";
import { primeSchematic } from "~/services/schematic/SchematicLoader";
import type { Schematic } from "~/agencies/types";

/**
 * Test spread for a `BrowserAgency` that draws a map: the light index
 * derived from `schematic`. Pass `agencyId` to also pre-resolve the lazy
 * loader so sync consumers (`topologyFor`, `useAgencySchematic`) see it.
 */
export function withSchematic(
  schematic: Schematic,
  agencyId?: string,
): { readonly light: ReturnType<typeof deriveAgencyLight> } {
  if (agencyId) primeSchematic(agencyId, schematic);
  return { light: deriveAgencyLight(schematic) };
}
