import * as Schema from "effect/Schema";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GtfsTopology } from "~/infrastructure/gtfs/staticTopology";
import { normalizeCardinalDirection } from "~/domain/surface/direction/cardinal";
import {
  alertTripBucket,
  ScopeArtifactSchema,
  TripArtifactSchema,
  MAX_ALERT_IDENTITY_BYTES,
  alertIdentityAssetPath,
  type AlertIdentityCatalog,
  type ArtifactReference,
  type ScopeArtifact,
  type TripArtifact,
} from "~/infrastructure/alerts/alertIdentityArtifacts";

export function compileAlertIdentityArtifacts(
  agencyId: string,
  topology: GtfsTopology,
  needs: { scope: boolean; trips: boolean },
) {
  const files = new Map<string, string>();
  const write = (
    kind: "scope" | number,
    value: ScopeArtifact | TripArtifact,
  ): ArtifactReference => {
    if (kind === "scope") Schema.decodeUnknownSync(ScopeArtifactSchema)(value);
    else Schema.decodeUnknownSync(TripArtifactSchema)(value);
    const text = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(text) > MAX_ALERT_IDENTITY_BYTES)
      throw new Error(`Alert identity artifact too large for ${agencyId}`);
    const hash = createHash("sha256").update(text).digest("hex");
    files.set(alertIdentityAssetPath(agencyId, kind, hash), text);
    return { hash, bytes: Buffer.byteLength(text) };
  };
  const reference: { scope?: ArtifactReference; trips?: Record<string, ArtifactReference> } = {};
  if (needs.scope) {
    const directions = new Map<string, [string, string, number]>(),
      ambiguous = new Set<string>();
    for (const row of topology.route_shapes ?? []) {
      const word = normalizeCardinalDirection(String(row.headsign));
      if (!word) continue;
      const key = `${row.route_id}|${word}`,
        id = Number(row.direction_id);
      if (directions.has(key) && directions.get(key)![2] !== id) ambiguous.add(key);
      directions.set(key, [String(row.route_id), word, id]);
    }
    reference.scope = write("scope", {
      version: 1,
      agencyId,
      routes: (topology.routes ?? [])
        .map((r) => [String(r.id), String(r.short_name)] as [string, string])
        .sort(([a], [b]) => a.localeCompare(b)),
      stops: (topology.stops ?? [])
        .map(
          (r) => [String(r.id), r.code == null ? null : String(r.code)] as [string, string | null],
        )
        .sort(([a], [b]) => a.localeCompare(b)),
      directions: [...directions]
        .filter(([key]) => !ambiguous.has(key))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, value]) => value),
    });
  }
  if (needs.trips) {
    const buckets = new Map<number, Map<string, [string, number, string[]]>>();
    const identities = new Map<string, string>();
    for (const row of topology.route_direction_trips ?? []) {
      const route = String(row.route_id),
        direction = Number(row.direction_id),
        group = JSON.stringify([route, direction]);
      const ids: unknown = JSON.parse(String(row.trip_ids));
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && id.length > 0))
        throw new Error("Invalid trip identities");
      for (const id of ids) {
        if (identities.has(id) && identities.get(id) !== group)
          throw new Error(`Ambiguous trip identity in ${agencyId}`);
        if (identities.has(id)) continue;
        identities.set(id, group);
        const bucket = alertTripBucket(id),
          groups = buckets.get(bucket) ?? new Map<string, [string, number, string[]]>();
        const entry = groups.get(group) ?? [route, direction, []];
        entry[2].push(id);
        groups.set(group, entry);
        buckets.set(bucket, groups);
      }
    }
    reference.trips = Object.fromEntries(
      [...buckets]
        .sort(([a], [b]) => a - b)
        .map(([bucket, groups]) => [
          String(bucket),
          write(bucket, {
            version: 1,
            agencyId,
            bucket,
            groups: [...groups]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, entry]) => [entry[0], entry[1], entry[2].sort()]),
          }),
        ]),
    );
  }
  return { reference, files };
}

export function writeAlertIdentityArtifacts(options: {
  agencyId: string;
  topology: GtfsTopology;
  sourceHash: string;
  needs: { scope: boolean; trips: boolean };
  publicDir: string;
  catalog: AlertIdentityCatalog;
}): AlertIdentityCatalog {
  const { reference, files } = compileAlertIdentityArtifacts(
    options.agencyId,
    options.topology,
    options.needs,
  );
  for (const [path, contents] of files) {
    const target = join(options.publicDir, path.slice(1));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return {
    version: 1,
    agencies: {
      ...options.catalog.agencies,
      [options.agencyId]: {
        sourceHash: options.sourceHash,
        generation: createHash("sha256").update(JSON.stringify(reference)).digest("hex"),
        ...reference,
      },
    },
  };
}
