import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { deriveAgencyLight } from "../../src/agencies/lightIndex.ts";
import { trimBrowserManifest } from "../../src/agencies/browserManifest.ts";

const VIRTUAL_ID = "virtual:agency-schematics";
const RESOLVED_VIRTUAL_ID = `\0${VIRTUAL_ID}`;
const OMITTED_ID = "\0agency-schematic-omitted";
const BROWSER_MANIFEST_PREFIX = "\0agency-browser-manifest:";
// Keeps Vite's JSON plugin, which matches ids ending in `.json`, off the module.
const BROWSER_MANIFEST_SUFFIX = ".js";
const AGENCIES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/agencies");
const CATALOG_PATH = join(AGENCIES_DIR, "agencyCatalog.ts");
const BROWSER_MANIFEST_MODULE = join(AGENCIES_DIR, "browserManifest.ts");
const BROWSER_REGISTRY_PATH = join(AGENCIES_DIR, "browserRegistry.ts");

interface AgencyFiles {
  readonly id: string;
  readonly manifestPath: string;
  readonly schematicPath: string;
}

function findAgencyFiles(dir: string, found: AgencyFiles[] = []): AgencyFiles[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (!statSync(path).isDirectory()) continue;
    const manifestPath = join(path, "manifest.json");
    const schematicPath = join(path, "schematic.json");
    if (existsSync(manifestPath) && existsSync(schematicPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { id: string };
      found.push({ id: manifest.id, manifestPath, schematicPath });
    }
    findAgencyFiles(path, found);
  }
  return found;
}

/**
 * Splits agency data for the browser. `virtual:agency-schematics` exports a
 * light index derived from every `schematic.json` plus a lazy loader per
 * agency, and the client environment drops the catalog's eager schematic
 * imports so the heavy geometry only loads on demand. The client environment
 * also trims each catalog manifest to the fields the browser registry reads
 * (`trimBrowserManifest`), so feed and alert configuration never ships to the
 * browser. Server and worker environments keep the full eager catalog.
 */
export interface AgencySchematicsPluginOptions {
  /**
   * Trim client manifests and reject client catalog imports outside the
   * browser registry. Test configs disable it: their DOM project runs in the
   * client environment but deliberately loads server modules.
   */
  readonly trimClientManifests?: boolean;
}

export function agencySchematicsPlugin({
  trimClientManifests = true,
}: AgencySchematicsPluginOptions = {}): Plugin {
  return {
    name: "schematic:agency-schematics",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === VIRTUAL_ID) return RESOLVED_VIRTUAL_ID;
      if (this.environment?.name !== "client" || !importer) return undefined;
      const importerPath = importer.split("?")[0];
      if (importerPath === CATALOG_PATH) {
        if (source.endsWith("/schematic.json")) return OMITTED_ID;
        if (trimClientManifests && source.endsWith("/manifest.json")) {
          return `${BROWSER_MANIFEST_PREFIX}${resolve(dirname(importerPath), source)}${BROWSER_MANIFEST_SUFFIX}`;
        }
      }
      // Trimmed manifests only satisfy the browser registry's projection.
      if (
        trimClientManifests &&
        /(^|\/)agencyCatalog(\.ts)?$/.test(source) &&
        importerPath !== BROWSER_REGISTRY_PATH
      ) {
        this.error(
          `${importerPath} imports agencyCatalog in the client build; read agencies through browserRegistry instead.`,
        );
      }
      return undefined;
    },
    load(id) {
      if (id === OMITTED_ID) return "export default undefined;";
      if (id.startsWith(BROWSER_MANIFEST_PREFIX)) {
        const manifestPath = id.slice(BROWSER_MANIFEST_PREFIX.length, -BROWSER_MANIFEST_SUFFIX.length);
        this.addWatchFile(manifestPath);
        const trimmed = trimBrowserManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
        return [
          `import { markBrowserManifest } from ${JSON.stringify(BROWSER_MANIFEST_MODULE)};`,
          `export default markBrowserManifest(${JSON.stringify(trimmed)});`,
        ].join("\n");
      }
      if (id !== RESOLVED_VIRTUAL_ID) return undefined;
      const agencies = findAgencyFiles(AGENCIES_DIR).sort((a, b) => a.id.localeCompare(b.id));
      const light: Record<string, unknown> = {};
      const loaders: string[] = [];
      for (const agency of agencies) {
        this.addWatchFile(agency.schematicPath);
        this.addWatchFile(agency.manifestPath);
        light[agency.id] = deriveAgencyLight(
          JSON.parse(readFileSync(agency.schematicPath, "utf8")),
        );
        loaders.push(
          `  ${JSON.stringify(agency.id)}: () => import(${JSON.stringify(agency.schematicPath)}).then((m) => m.default),`,
        );
      }
      return [
        `export const agencyLightIndex = ${JSON.stringify(light)};`,
        `export const agencySchematicLoaders = {\n${loaders.join("\n")}\n};`,
      ].join("\n");
    },
  };
}
