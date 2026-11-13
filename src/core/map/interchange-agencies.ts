import type { AgencyProvider, BrowserAgency } from "~/agencies/types";
import type { InterchangeBadgeAgency } from "./index";

/**
 * Projects registry-owned provider data into the provider-neutral facts that
 * Core Map needs to normalize static interchange relationships.
 */
export function projectInterchangeBadgeAgencies(
  providers: readonly (BrowserAgency | AgencyProvider)[],
): readonly InterchangeBadgeAgency[] {
  return providers.map((provider) => ({
    agencyId: provider.manifest.id,
    name: provider.manifest.name,
    shortName: provider.manifest.shortName,
    modes: provider.manifest.modes,
    brandColor: "brandColor" in provider ? provider.brandColor : provider.manifest.brandColor,
    schematicStationIds:
      ("schematic" in provider
        ? provider.schematic?.stations.map((station) => station.id)
        : undefined) ??
      ("light" in provider ? provider.light?.stationIds : undefined) ??
      [],
  }));
}
