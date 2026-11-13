import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  renameSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as Schema from "effect/Schema";
import {
  AlertIdentityCatalogSchema,
  type AlertIdentityCatalog,
} from "~/infrastructure/alerts/alertIdentityArtifacts";
import type { GtfsTopology } from "~/infrastructure/gtfs/staticTopology";
import { writeAlertIdentityArtifacts } from "./alert-identity-artifacts";

type IdentityNeeds = { readonly scope: boolean; readonly trips: boolean };

/** Publishes matching catalog/assets before deleting obsolete generations. */
export function createAlertIdentityPublisher(options: {
  readonly catalogFile: string;
  readonly publicDir: string;
  readonly needsForAgency: (agencyId: string) => IdentityNeeds | undefined;
}) {
  const readCatalog = (): AlertIdentityCatalog =>
    existsSync(options.catalogFile)
      ? Schema.decodeUnknownSync(AlertIdentityCatalogSchema)(
          JSON.parse(readFileSync(options.catalogFile, "utf8")),
        )
      : { version: 1, agencies: {} };
  function pruneAgency(
    agencyId: string,
    entry: AlertIdentityCatalog["agencies"][string] | undefined,
  ) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agencyId))
      throw new Error("Invalid artifact agency identity");
    const dir = join(options.publicDir, "generated/alert-identities", agencyId);
    if (!existsSync(dir)) return;
    const keep = new Set([
      ...(entry?.scope ? [`scope-${entry.scope.hash}.json`] : []),
      ...Object.entries(entry?.trips ?? {}).map(
        ([bucket, ref]) => `trips-${bucket}-${ref.hash}.json`,
      ),
    ]);
    for (const file of readdirSync(dir)) if (!keep.has(file)) rmSync(join(dir, file));
  }
  function publish(input: AlertIdentityCatalog, agencyId: string) {
    const removed: string[] = [];
    const agencies = Object.fromEntries(
      Object.entries(input.agencies)
        .filter(([id]) => {
          const needs = options.needsForAgency(id);
          if (needs && (needs.scope || needs.trips)) return true;
          removed.push(id);
          return false;
        })
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    const catalog: AlertIdentityCatalog = { version: 1, agencies };
    mkdirSync(dirname(options.catalogFile), { recursive: true });
    writeFileSync(`${options.catalogFile}.tmp`, JSON.stringify(catalog, null, 2) + "\n");
    renameSync(`${options.catalogFile}.tmp`, options.catalogFile);
    for (const id of new Set([agencyId, ...removed])) pruneAgency(id, catalog.agencies[id]);
  }
  return {
    readCatalog,
    generate(agencyId: string, topology: GtfsTopology, sourceHash: string): void {
      const needs = options.needsForAgency(agencyId);
      if (!needs) throw new Error(`Unknown agency ${agencyId}`);
      const catalog = readCatalog();
      publish(
        needs.scope || needs.trips
          ? writeAlertIdentityArtifacts({
              agencyId,
              topology,
              sourceHash,
              needs,
              publicDir: options.publicDir,
              catalog,
            })
          : catalog,
        agencyId,
      );
    },
    prune(): void {
      const root = join(options.publicDir, "generated/alert-identities");
      if (!existsSync(root)) return;
      const catalog = readCatalog();
      for (const agency of readdirSync(root)) pruneAgency(agency, catalog.agencies[agency]);
    },
  };
}
