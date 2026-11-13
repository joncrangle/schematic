/**
 * Browser-facing agency registry.
 *
 * The browser receives only the manifest fields and light schematic index needed
 * by the app shell (full geometry loads lazily via schematicLoader). Runtime ports, feed declarations, Effect adapters, and
 * storage configuration remain server-only provider concerns.
 */
import * as Schema from "effect/Schema";
import { AgencyManifestSchema, type BrowserAgency } from "~/agencies/types";
import { agencyCatalog, type AgencyDefinition } from "./agencyCatalog";
import { trimBrowserManifest, type BrowserManifestInput } from "./browserManifest";
import { agencyLightIndex } from "virtual:agency-schematics";
import { deriveAgencyLight } from "./lightIndex";
import { primeSchematic } from "~/services/schematic/SchematicLoader";
export type { BrowserAgency } from "~/agencies/types";
import {
  isPointCovered as isPointCoveredByProviders,
  resolveEffectiveAgency,
} from "~/domain/location/EffectiveAgency";
export { interchanges } from "./interchanges";

/** A catalog entry whose manifest may already be trimmed by the client build. */
export interface BrowserCatalogEntry {
  readonly manifest: BrowserManifestInput;
  readonly schematic?: AgencyDefinition["schematic"];
}

export function projectAgencyCatalogEntry(entry: BrowserCatalogEntry): BrowserAgency {
  const { staticTopology, hasLiveAlerts, ...fields } = trimBrowserManifest(entry.manifest);
  const manifest = Schema.decodeUnknownSync(AgencyManifestSchema)(fields);
  // Only non-browser runs (tests, prerender) carry an eager schematic; the
  // client catalog omits it and loads through `loadSchematic`.
  if (entry.schematic) primeSchematic(manifest.id, entry.schematic);
  return {
    manifest,
    light: entry.schematic ? deriveAgencyLight(entry.schematic) : agencyLightIndex[manifest.id],
    brandColor: manifest.brandColor ?? staticTopology.defaultColor,
    brandTextColor: staticTopology.defaultTextColor,
    hasLiveAlerts,
  };
}

const providers: readonly BrowserAgency[] = Object.freeze(
  agencyCatalog.map(projectAgencyCatalogEntry),
);

export function allProviders(): readonly BrowserAgency[] {
  return providers;
}

export function getAgencyById(id: string): BrowserAgency | undefined {
  return providers.find((provider) => provider.manifest.id === id);
}

export function isPointCovered(point: { lat: number; lon: number }): boolean {
  return isPointCoveredByProviders(point, providers);
}

export function resolveAgencyAtPoint(point: { lat: number; lon: number }) {
  return resolveEffectiveAgency({
    point,
    providers,
    selection: "auto",
    locationState: { status: "granted", source: "gps" },
    hasStationsSource: (id) => Boolean(getAgencyById(id)?.manifest.stationService),
  });
}

export function getActiveAgency(): BrowserAgency {
  const active =
    providers.find((provider) => provider.manifest.status === "active") ?? providers[0];
  if (!active) throw new Error("No agency providers registered");
  return active;
}
