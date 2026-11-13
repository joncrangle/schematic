import * as Schema from "effect/Schema";
import { VersionedAssetReferenceSchema } from "../../staticAssets/versionedAssetReference";
export const MAX_SCHEDULE_ASSET_BYTES = 128 * 1024;
const Id = Schema.String.check(Schema.isMinLength(1));
const Seconds = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(604800),
);
const DateId = Schema.String.check(Schema.isPattern(/^\d{8}$/));
export const CalendarSchema = Schema.Struct({
  start: Schema.optional(DateId),
  end: Schema.optional(DateId),
  days: Schema.String.check(Schema.isPattern(/^[01]{7}$/)),
  exceptions: Schema.Record(DateId, Schema.Literals([1, 2])),
});
export const ScheduleVariantSchema = Schema.Struct({
  service: Id,
  // sequence, stop id, arrival seconds, departure seconds, pickup permitted
  calls: Schema.Array(
    Schema.Tuple([Schema.Int, Id, Schema.NullOr(Seconds), Schema.NullOr(Seconds), Schema.Boolean]),
  ),
  frequencies: Schema.Array(Schema.Tuple([Seconds, Seconds, Seconds, Schema.Boolean])),
});
export const ScheduleArtifactSchema = Schema.Struct({
  version: Schema.Literal(1),
  agencyId: Id,
  routeId: Id,
  bucket: Schema.Int,
  services: Schema.Record(Id, CalendarSchema),
  trips: Schema.Record(Id, Schema.Array(ScheduleVariantSchema)),
});
export const ScheduleCatalogSchema = Schema.Struct({
  version: Schema.Literal(1),
  agencies: Schema.Record(
    Id,
    Schema.Struct({
      sourceHash: Id,
      routes: Schema.Record(Id, Schema.Array(VersionedAssetReferenceSchema)),
    }),
  ),
});
export type ScheduleArtifact = Schema.Schema.Type<typeof ScheduleArtifactSchema>;
export type ScheduleCatalog = Schema.Schema.Type<typeof ScheduleCatalogSchema>;
export type ScheduleVariant = Schema.Schema.Type<typeof ScheduleVariantSchema>;
export type ServiceCalendar = Schema.Schema.Type<typeof CalendarSchema>;
export function scheduleBucket(tripId: string, count: number): number {
  let hash = 2166136261;
  for (let i = 0; i < tripId.length; i++) hash = Math.imul(hash ^ tripId.charCodeAt(i), 16777619);
  return (hash >>> 0) % count;
}
export function scheduleAssetPath(agencyId: string, hash: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agencyId) || !/^[a-f0-9]{64}$/.test(hash))
    throw new Error("Invalid schedule asset identity");
  return `/generated/gtfs-schedules/${agencyId}/${hash}.json`;
}
export function gtfsSeconds(value: string): number | undefined {
  if (!/^\d{1,3}:[0-5]\d:[0-5]\d$/.test(value)) return undefined;
  const [h, m, s] = value.split(":").map(Number);
  const seconds = h * 3600 + m * 60 + s;
  return seconds <= 604800 ? seconds : undefined;
}
