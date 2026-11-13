import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as Schema from "effect/Schema";
import { compileGtfsSchedules } from "~/infrastructure/gtfs/schedules/compile";
import {
  ScheduleCatalogSchema,
  ScheduleArtifactSchema,
  scheduleAssetPath,
  scheduleBucket,
  MAX_SCHEDULE_ASSET_BYTES,
  type ScheduleCatalog,
  type ScheduleArtifact,
} from "~/infrastructure/gtfs/schedules/artifacts";

import type { FeedIdentity } from "~/infrastructure/gtfs/feedIdentity";

/** Write immutable shards, atomically publish their catalog, then prune obsolete files. */
export async function publishSchedules(options: {
  agencyId: string;
  sourceHash: string;
  archives: readonly Uint8Array[];
  identities?: readonly FeedIdentity[];
  catalogFile: string;
  publicDir: string;
  eligible: (id: string) => boolean;
}) {
  const compiled = await compileGtfsSchedules(options.archives, options.identities);
  const routes: Record<string, { hash: string; bytes: number }[]> = Object.create(null);
  for (const [routeId, data] of compiled) {
    let count = 1;
    while (true) {
      const shards = Array.from({ length: count }, (_, bucket) => ({
        version: 1 as const,
        agencyId: options.agencyId,
        routeId,
        bucket,
        services: Object.create(null) as Record<string, ScheduleArtifact["services"][string]>,
        trips: Object.create(null) as Record<string, ScheduleArtifact["trips"][string]>,
      }));
      for (const [trip, variants] of Object.entries(data.trips).sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        const shard = shards[scheduleBucket(trip, count)];
        shard.trips[trip] = variants;
        for (const variant of variants)
          shard.services[variant.service] = data.services[variant.service];
      }
      const encoded = shards.map((shard) =>
        JSON.stringify(Schema.decodeUnknownSync(ScheduleArtifactSchema)(shard)),
      );
      if (encoded.some((text) => Buffer.byteLength(text) > MAX_SCHEDULE_ASSET_BYTES)) {
        if (count >= 4096) throw new Error("Static trip cannot fit schedule shard");
        count *= 2;
        continue;
      }
      routes[routeId] = encoded.map((text) => {
        const hash = createHash("sha256").update(text).digest("hex"),
          path = join(options.publicDir, scheduleAssetPath(options.agencyId, hash));
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
        return { hash, bytes: Buffer.byteLength(text) };
      });
      break;
    }
  }
  const old: ScheduleCatalog = existsSync(options.catalogFile)
    ? Schema.decodeUnknownSync(ScheduleCatalogSchema)(
        JSON.parse(readFileSync(options.catalogFile, "utf8")),
      )
    : { version: 1, agencies: {} };
  const agencies = {
    ...old.agencies,
    [options.agencyId]: { sourceHash: options.sourceHash, routes },
  };
  const catalog = Schema.decodeUnknownSync(ScheduleCatalogSchema)({
    version: 1,
    agencies: Object.fromEntries(
      Object.entries(agencies)
        .filter(([id]) => options.eligible(id))
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  });
  mkdirSync(dirname(options.catalogFile), { recursive: true });
  writeFileSync(options.catalogFile + ".tmp", JSON.stringify(catalog, null, 2) + "\n");
  renameSync(options.catalogFile + ".tmp", options.catalogFile);
  const root = join(options.publicDir, "generated/gtfs-schedules");
  if (existsSync(root))
    for (const id of readdirSync(root)) {
      const keep = new Set(
        Object.values(catalog.agencies[id]?.routes ?? {})
          .flat()
          .map((ref) => ref.hash + ".json"),
      );
      for (const file of readdirSync(join(root, id)))
        if (!keep.has(file)) unlinkSync(join(root, id, file));
    }
}
