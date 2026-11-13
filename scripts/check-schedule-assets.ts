#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import * as Schema from "effect/Schema";
import { allProviders } from "~/agencies";
import {
  ScheduleCatalogSchema,
  ScheduleArtifactSchema,
  scheduleAssetPath,
  scheduleBucket,
  MAX_SCHEDULE_ASSET_BYTES,
} from "~/infrastructure/gtfs/schedules/artifacts";
const catalog = Schema.decodeUnknownSync(ScheduleCatalogSchema)(
  JSON.parse(readFileSync("src/generated/gtfs-schedules.json", "utf8")),
);
const eligible = new Set(
  allProviders()
    .filter((provider) =>
      provider.realtime?.feeds.some(
        (feed) => feed.kind === "trip_updates" && feed.predictionTimeSource === "static-with-delay",
      ),
    )
    .map((provider) => provider.manifest.id),
);
for (const id of eligible)
  if (!catalog.agencies[id])
    throw new Error(`Generate static schedules for ${id} before deployment`);
for (const [agency, entry] of Object.entries(catalog.agencies)) {
  if (!eligible.has(agency)) throw new Error(`Remove obsolete schedule generation for ${agency}`);
  for (const [route, refs] of Object.entries(entry.routes)) {
    if (!refs.length || (refs.length & (refs.length - 1)) !== 0)
      throw new Error("Invalid schedule partition count");
    for (const [bucket, ref] of refs.entries()) {
      const bytes = readFileSync(join("public", scheduleAssetPath(agency, ref.hash)));
      if (ref.bytes > MAX_SCHEDULE_ASSET_BYTES) throw new Error("Oversized schedule shard");
      if (
        bytes.length !== ref.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== ref.hash
      )
        throw new Error(`Invalid schedule bytes for ${agency}`);
      const data = Schema.decodeUnknownSync(ScheduleArtifactSchema)(
        JSON.parse(bytes.toString("utf8")),
      );
      if (
        data.agencyId !== agency ||
        data.routeId !== route ||
        data.bucket !== bucket ||
        Object.keys(data.trips).some((trip) => scheduleBucket(trip, refs.length) !== bucket)
      )
        throw new Error("Invalid schedule scope");
    }
  }
}
console.log("Static schedule assets verified");
