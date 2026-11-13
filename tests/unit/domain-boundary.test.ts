import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, relative, sep } from "node:path";

/**
 * ADR-0007 dependency-rule enforcement (CI half of the pair).
 *
 * The litmus test splits the codebase into core / agency module / app shell.
 * Its rules forbid core (src/domain, src/lib, src/services, src/infrastructure)
 * from reaching into the app's component layer or importing agency internals
 * (~/agencies/<id>/… or ~/agencies/runtime; the agencies/index.ts barrel and
 * agency contract types stay allowed).
 * oxlint's no-restricted-imports overrides in .oxlintrc.json assert the same
 * boundaries statically — removing either guard must fail loudly, so this test
 * deliberately re-derives the checks from the actual files on disk rather than
 * trusting any shared configuration.
 *
 * Amendment 2026-08-27 (honest Core seam): exemptions for
 * src/services/notifications/** and src/services/ttc/** removed; deep-import
 * ban is now unconditional.
 *
 * Server-split follow-up: server-only modules (secret-touching layer
 * builders, handler delegates, server-function implementations) must never
 * be reachable from client-bundled code. The `server-only` boundary marker
 * enforces this at build time; the suite below pins the same rule
 * statically so a violation fails loudly in unit runs too.
 */
// Path anchors resolve from the repo root: the suite runs in happy-dom,
// where import.meta.url isn't a file URL (see schematic-renderer.test.tsx).
const repoRoot = process.cwd();
const domainDir = join(repoRoot, "src/domain");
const componentsDir = join(repoRoot, "src/components");
const libDir = join(repoRoot, "src/lib");
const servicesDir = join(repoRoot, "src/services");
const infrastructureDir = join(repoRoot, "src/infrastructure");
const hooksDir = join(repoRoot, "src/hooks");
const contextDir = join(repoRoot, "src/context");
const routesDir = join(repoRoot, "src/routes");

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(entryPath);
    return /\.(ts|tsx)$/.test(entry.name) ? [entryPath] : [];
  });
}

/** Module specifiers named by static/dynamic/re-export import forms in `source`. */
function extractImportedSpecifiers(source: string): string[] {
  const specifierPatterns = [
    /\bfrom\s*["']([^"']+)["']/g, // import … from "x"; export … from "x"
    /\bimport\s*["']([^"']+)["']/g, // side-effect import "x"
    /\bimport\s*\(\s*["']([^"']+)["']/g, // dynamic import("x")
  ];
  return specifierPatterns.flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1]),
  );
}

/** True when `specifier`, resolved relative to its importer, names the component layer. */
function targetsComponentLayer(specifier: string, importerPath: string): boolean {
  if (specifier.startsWith("~/components")) return true;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const resolved = resolve(dirname(importerPath), specifier);
    return resolved.startsWith(componentsDir + sep);
  }
  return false;
}

/**
 * True when the specifier reaches past the agencies barrel into a concrete
 * agency module (`<…>/agencies/<id>/<file>`); the bare directory and
 * `agencies/index` remain allowed per the ADR's registry exception.
 */
const AGENCY_DEEP_IMPORT = /agencies\/[^/]+\/.+/;
const AGENCY_INTERNAL_IMPORT =
  /(?:^|[/\\])agencies\/(?!index(?:[/\\]|$)|types(?:[/\\]|$))[^/]+(?:[/\\]|$)/;

function targetsAgencyModule(specifier: string, importerPath: string): boolean {
  if (AGENCY_DEEP_IMPORT.test(specifier) || AGENCY_INTERNAL_IMPORT.test(specifier)) return true;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const resolved = resolve(dirname(importerPath), specifier);
    const target = relative(repoRoot, resolved);
    return AGENCY_DEEP_IMPORT.test(target) || AGENCY_INTERNAL_IMPORT.test(target);
  }
  return false;
}

const domainFiles = collectSourceFiles(domainDir);
const libFiles = collectSourceFiles(libDir);
const servicesFiles = collectSourceFiles(servicesDir);
const infrastructureFiles = collectSourceFiles(infrastructureDir);
const coreFiles = [...domainFiles, ...libFiles, ...servicesFiles, ...infrastructureFiles];

describe("ADR-0007 domain/component boundary", () => {
  it("domain modules never import the component layer", () => {
    expect(domainFiles.length).toBeGreaterThan(0);
    const violations: string[] = [];

    for (const file of domainFiles) {
      const source = readFileSync(file, "utf8");
      for (const specifier of extractImportedSpecifiers(source)) {
        if (targetsComponentLayer(specifier, file)) {
          violations.push(`${file}: imports "${specifier}"`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

describe("ADR-0007 core boundary extensions", () => {
  it("lib modules never import the component layer", () => {
    expect(libFiles.length).toBeGreaterThan(0);
    const violations: string[] = [];

    for (const file of libFiles) {
      const source = readFileSync(file, "utf8");
      for (const specifier of extractImportedSpecifiers(source)) {
        if (targetsComponentLayer(specifier, file)) {
          violations.push(`${file}: imports "${specifier}"`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("core modules never deep-import agency modules", () => {
    expect(servicesFiles.length).toBeGreaterThan(0);
    expect(infrastructureFiles.length).toBeGreaterThan(0);
    const violations: string[] = [];

    for (const file of coreFiles) {
      const source = readFileSync(file, "utf8");
      for (const specifier of extractImportedSpecifiers(source)) {
        if (targetsAgencyModule(specifier, file)) {
          violations.push(`${file}: imports "${specifier}"`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("agency-owned clients live in agency modules, not core services (SubwayClient excision)", () => {
    expect(servicesFiles.some((file) => file.endsWith("SubwayClient.ts"))).toBe(false);
  });
});

describe("surfaceStore seam rules", () => {
  const storeDir = join(infrastructureDir, "storage", "surfaceStore");
  const storeFiles = collectSourceFiles(storeDir);

  it("surfaceStore never reaches for the global fetch (fetch is injected)", () => {
    expect(storeFiles.length).toBeGreaterThan(0);
    const violations = storeFiles.filter((file) =>
      readFileSync(file, "utf8").includes("globalThis.fetch"),
    );
    expect(violations).toEqual([]);
  });

  it("surfaceStore never imports SolidJS reactivity (no createEffect)", () => {
    const violations: string[] = [];
    for (const file of storeFiles) {
      for (const specifier of extractImportedSpecifiers(readFileSync(file, "utf8"))) {
        if (specifier === "solid-js" || specifier.startsWith("solid-js/")) {
          violations.push(`${file}: imports "${specifier}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("server-only boundary", () => {
  // Modules holding secret-touching code: feed secrets and VAPID keys
  // (ServerEnv), Effect layer builders and handler delegates (*Server),
  // the snapshot cache seam, and push/scheduler machinery. Client-bundled
  // layers must never import them directly — the `server-only` boundary
  // marker fails the production build if a marked module lands in a client
  // chunk, and this pins the same rule for unit runs. The four shared
  // wrapper modules (SurfaceClient, StationsClient, NotificationClient,
  // CoarseLocationService) are the only exception: they reference their
  // *Server sibling from inside "use server" bodies, which the server-function
  // transform strips from the client chunk.
  const serverOnlyModules = [
    "src/services/surface/SurfaceServer.ts",
    "src/services/StationsServer.ts",
    "src/services/notifications/NotificationServer.ts",
    "src/services/CoarseLocationServer.ts",
    "src/infrastructure/env/ServerEnv.ts",
    "src/services/SnapshotClient.ts",
    "src/services/SnapshotEndpoint.ts",
    "src/services/RoutesCatalogEndpoint.ts",
    "src/services/StationDeparturesEndpoint.ts",
    "src/services/apiEndpoint.ts",
    "src/services/surface/SurfaceTransit.ts",
    "src/services/AlertIdentityServer.ts",
    "src/services/StaticAssetServer.ts",
    "src/services/ScheduleServer.ts",
    "src/services/AgencyRuntimeServer.ts",
    "src/services/surface/agencyStore.ts",
    "src/infrastructure/notifications/VapidClient.ts",
    "src/services/notifications/ProductionScheduler.ts",
    "src/services/AgencyTaskRunner.ts",
    "src/services/notifications/TestPushService.ts",
    "src/services/notifications/DevAlertSpoof.ts",
  ];
  const serverOnlyPaths = new Set(serverOnlyModules.map((module) => join(repoRoot, module)));
  const sharedWrapperPaths = new Set(
    [
      "src/services/surface/SurfaceClient.ts",
      "src/services/StationsClient.ts",
      "src/services/notifications/NotificationClient.ts",
      "src/services/CoarseLocationService.ts",
    ].map((module) => join(repoRoot, module)),
  );

  /** Resolves an import specifier to an absolute path when it names a src file. */
  function resolveSpecifier(specifier: string, importerPath: string): string | null {
    if (specifier === "server-only") return "server-only";
    if (specifier.startsWith("~/")) return join(repoRoot, "src", specifier.slice(2));
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      return resolve(dirname(importerPath), specifier);
    }
    return null;
  }

  it("marked server-only modules carry the build-time marker", () => {
    const marked = [
      "src/services/surface/SurfaceServer.ts",
      "src/services/StationsServer.ts",
      "src/services/notifications/NotificationServer.ts",
      "src/services/CoarseLocationServer.ts",
    ];
    const violations = marked.filter(
      (module) => !readFileSync(join(repoRoot, module), "utf8").includes('import "server-only"'),
    );
    expect(violations).toEqual([]);
  });

  it("client layers never import server-only modules", () => {
    for (const module of serverOnlyModules) {
      expect(existsSync(join(repoRoot, module))).toBe(true);
    }
    const clientFiles = [
      ...collectSourceFiles(componentsDir),
      ...collectSourceFiles(hooksDir),
      ...collectSourceFiles(contextDir),
      ...collectSourceFiles(routesDir),
      ...collectSourceFiles(libDir),
      join(repoRoot, "src/AppRoot.tsx"),
      join(repoRoot, "src/Document.tsx"),
      join(repoRoot, "src/router.tsx"),
    ];
    expect(clientFiles.length).toBeGreaterThan(0);
    // Sole allowance: lib/devFlags reads only NODE_ENV via ServerEnv for
    // non-bundled runtimes (vitest, scripts); production bundle inspection
    // proves no secret names ship in client chunks.
    const devFlagsPath = join(repoRoot, "src/lib/devFlags.ts");
    const serverEnvPath = join(repoRoot, "src/infrastructure/env/ServerEnv.ts");
    const violations: string[] = [];
    for (const file of clientFiles) {
      if (sharedWrapperPaths.has(file)) continue;
      const source = readFileSync(file, "utf8");
      for (const specifier of extractImportedSpecifiers(source)) {
        const resolved = resolveSpecifier(specifier, file);
        if (resolved === null) continue;
        const target =
          resolved === "server-only"
            ? resolved
            : [resolved, `${resolved}.ts`, `${resolved}.tsx`].find((candidate) =>
                serverOnlyPaths.has(candidate),
              );
        if (target !== undefined) {
          if (file === devFlagsPath && target === serverEnvPath) continue;
          violations.push(`${file}: imports "${specifier}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
