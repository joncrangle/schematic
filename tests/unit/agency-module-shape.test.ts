import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { agencyCatalog } from "~/agencies/agencyCatalog";
import { interchangeCatalog } from "~/agencies/interchangeCatalog";

/**
 * An agency module is a directory holding a manifest.json, optionally a
 * schematic.json, and nothing else. These walk the tree and assert that.
 *
 * Lint cannot cover it: no-restricted-imports says where an import may point,
 * not which files may exist. So the file half lives here and the import half
 * lives in the src/agencies/*.ts override in .oxlintrc.json. A module with
 * TypeScript either goes unused, which this suite catches, or gets wired in,
 * which lint catches.
 */

// Path anchors resolve from the repo root: the suite runs in happy-dom,
// where import.meta.url isn't a file URL (see schematic-renderer.test.tsx).
const repoRoot = process.cwd();
const agenciesDir = join(repoRoot, "src/agencies");

/** A region directory holds interchange artifacts rather than a manifest. */
const REGION_ARTIFACTS = new Set(["interchanges.jsonc", "interchanges.overrides.json"]);

interface DirEntry {
  readonly abs: string;
  readonly rel: string;
  /** Path segments below src/agencies. */
  readonly depth: number;
}

function collectDirs(dir: string, depth = 0): DirEntry[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const abs = join(dir, entry.name);
    return [
      { abs, rel: relative(agenciesDir, abs), depth: depth + 1 },
      ...collectDirs(abs, depth + 1),
    ];
  });
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

const allDirs = collectDirs(agenciesDir);

// Id comes from the manifest, not the folder name: nothing requires the two
// to agree, and the catalog is keyed by manifest id.
const moduleDirs = allDirs
  .filter((dir) => listFiles(dir.abs).includes("manifest.json"))
  .map((dir) => ({
    ...dir,
    agencyId: (JSON.parse(readFileSync(join(dir.abs, "manifest.json"), "utf8")) as { id: string })
      .id,
  }));

const registeredIds = new Set(agencyCatalog.map((definition) => definition.manifest.id));

const dirsWithStrayFiles = allDirs.filter(
  (dir) =>
    dir.depth >= 2 &&
    listFiles(dir.abs).some((name) => !REGION_ARTIFACTS.has(name)) &&
    !listFiles(dir.abs).includes("manifest.json"),
);

describe("agency module shape", () => {
  it("finds the module tree", () => {
    // Otherwise every rule below passes on an empty list.
    expect(moduleDirs.length).toBeGreaterThan(0);
  });

  it("module directories hold nothing but a manifest and a schematic", () => {
    const strays = moduleDirs.flatMap((dir) =>
      listFiles(dir.abs)
        .filter((name) => name !== "manifest.json" && name !== "schematic.json")
        .map((name) => `${dir.rel}/${name}`),
    );

    expect(strays).toEqual([]);
  });

  it("registers every module directory", () => {
    const unregistered = moduleDirs
      .filter((dir) => !registeredIds.has(dir.agencyId))
      .map((dir) => dir.rel);

    expect(unregistered).toEqual([]);
  });

  it("backs every catalog entry with a directory", () => {
    const onDisk = new Set(moduleDirs.map((dir) => dir.agencyId));
    const missing = [...registeredIds].filter((id) => !onDisk.has(id));

    expect(missing).toEqual([]);
  });

  it("registers every regional interchange artifact exactly once", () => {
    const artifactRegions = allDirs
      .filter((dir) => listFiles(dir.abs).includes("interchanges.jsonc"))
      .map((dir) => dir.rel)
      .sort();
    expect(interchangeCatalog.map((entry) => entry.regionPath).sort()).toEqual(artifactRegions);
  });

  it("keeps catalog ids unique", () => {
    const seen = new Set<string>();
    const duplicates = agencyCatalog
      .map((definition) => definition.manifest.id)
      .filter((id) => (seen.has(id) ? true : (seen.add(id), false)));

    expect(duplicates).toEqual([]);
  });

  it("holds no files outside a module or a region", () => {
    // An unregistered module is invisible to the app, the seeder, and
    // agency:check, so authoring one and forgetting to register it fails
    // nowhere else.
    expect(dirsWithStrayFiles.map((dir) => dir.rel)).toEqual([]);
  });

  it("keeps module data out of the seam directory", () => {
    expect(
      readdirSync(agenciesDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name),
    ).toEqual([]);
  });
});
