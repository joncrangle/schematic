#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { allProviders, getAgencyById } from "~/agencies";
import type { AgencyProvider } from "~/agencies/types";
import {
  ScopeArtifactSchema,
  TripArtifactSchema,
  alertIdentityAssetPath,
} from "~/infrastructure/alerts/alertIdentityArtifacts";
import * as Schema from "effect/Schema";
import { createAlertIdentityPublisher } from "./lib/alert-identity-publication";
import type { GtfsTopology } from "~/infrastructure/gtfs/staticTopology";

export function alertIdentityNeeds(
  provider: Pick<AgencyProvider, "alerts" | "staticTopology" | "realtime">,
) {
  const alerts = (provider.alerts ?? []).filter((source) => source.enabled !== false);
  return {
    scope:
      provider.realtime?.feeds.some(
        (feed) =>
          feed.kind === "bustime" ||
          feed.kind === "tripspark" ||
          ((feed.kind === "vehicle_positions" || feed.kind === "trip_updates") &&
            feed.stopIdAliases === "static-code"),
      ) ||
      alerts.some(
        (source) => source.type === "gtfs-rt" && source.stopIdAliases === "static-code",
      ) ||
      alerts.some((source) => source.type === "json" && source.parser === "i3-service-status") ||
      (alerts.length > 0 && !!provider.staticTopology?.sourceAgencyIds),
    trips: alerts.some(
      (source) => source.type === "gtfs-rt" && (source.format ?? "protobuf") === "protobuf",
    ),
  };
}
const catalogFile = resolve("src/generated/alert-identities.json"),
  publicDir = resolve("public");
const publisher = createAlertIdentityPublisher({
  catalogFile,
  publicDir,
  needsForAgency: (id) => {
    const provider = getAgencyById(id);
    return provider ? alertIdentityNeeds(provider) : undefined;
  },
});
const readCatalog = publisher.readCatalog;
export const generateAgencyAlertIdentities = publisher.generate;

export function verifyAlertIdentityAssets(): void {
  const catalog = readCatalog();
  for (const provider of allProviders()) {
    const needs = alertIdentityNeeds(provider);
    if (!needs.scope && !needs.trips) continue;
    const entry = catalog.agencies[provider.manifest.id];
    if (!entry || (needs.scope && !entry.scope) || (needs.trips && !entry.trips))
      throw new Error(`Generate alert identities for ${provider.manifest.id} before deployment`);
  }
  for (const [agency, entry] of Object.entries(catalog.agencies)) {
    const provider = getAgencyById(agency);
    const needs = provider && alertIdentityNeeds(provider);
    if (!needs || (!needs.scope && !needs.trips))
      throw new Error(`Remove obsolete alert identities for ${agency} before deployment`);
    const refs: ["scope" | number, { hash: string; bytes: number }][] = [
      ...(entry.scope ? [["scope", entry.scope] as ["scope", typeof entry.scope]] : []),
      ...Object.entries(entry.trips ?? {}).map(
        ([bucket, ref]) => [Number(bucket), ref] as [number, typeof ref],
      ),
    ];
    for (const [kind, ref] of refs) {
      const path = join(publicDir, alertIdentityAssetPath(agency, kind, ref.hash));
      const bytes = readFileSync(path);
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (bytes.byteLength !== ref.bytes || hash !== ref.hash)
        throw new Error(`Invalid alert identity artifact for ${agency}`);
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      if (kind === "scope") {
        const scope = Schema.decodeUnknownSync(ScopeArtifactSchema)(value);
        if (scope.agencyId !== agency || !scope.routes.length)
          throw new Error(`Invalid alert identity scope for ${agency}`);
      } else {
        const trips = Schema.decodeUnknownSync(TripArtifactSchema)(value);
        if (trips.agencyId !== agency || trips.bucket !== kind)
          throw new Error(`Invalid alert trip partition for ${agency}`);
      }
    }
  }
}
async function generateFromSqlite(agencyIds: readonly string[]) {
  const { Database } = require("bun:sqlite");
  const db = new Database(resolve(process.env.DATA_DIR ?? "data", "transit.db"), {
    readonly: true,
  });
  try {
    for (const agencyId of agencyIds) {
      const provider = getAgencyById(agencyId);
      if (!provider) throw new Error(`Unknown agency ${agencyId}`);
      const needs = alertIdentityNeeds(provider);
      if (!needs.scope && !needs.trips) {
        generateAgencyAlertIdentities(agencyId, {}, "");
        continue;
      }
      const meta = db
        .prepare("SELECT feed_hash FROM seed_topology_meta WHERE agency_id=?")
        .get(agencyId) as { feed_hash: string } | null;
      if (!meta) throw new Error(`Seed SQLite for ${agencyId} before generating alert identities`);
      const topology = {
        routes: db
          .prepare("SELECT id,short_name FROM routes WHERE agency_id=? ORDER BY id")
          .all(agencyId),
        stops: db.prepare("SELECT id,code FROM stops WHERE agency_id=? ORDER BY id").all(agencyId),
        route_shapes: db
          .prepare(
            "SELECT route_id,direction_id,headsign FROM route_shapes WHERE agency_id=? ORDER BY route_id,direction_id,headsign",
          )
          .all(agencyId),
        route_direction_trips: db
          .prepare(
            "SELECT route_id,direction_id,trip_ids FROM route_direction_trips WHERE agency_id=? ORDER BY route_id,direction_id,part",
          )
          .all(agencyId),
      } as GtfsTopology;
      generateAgencyAlertIdentities(agencyId, topology, meta.feed_hash);
    }
  } finally {
    db.close();
  }
  publisher.prune();
  verifyAlertIdentityAssets();
}
if (import.meta.main) {
  if (process.argv.includes("--check")) verifyAlertIdentityAssets();
  else {
    const requested = process.argv.find((arg) => arg.startsWith("--agency="))?.slice(9);
    await generateFromSqlite(requested ? [requested] : allProviders().map((p) => p.manifest.id));
  }
}
