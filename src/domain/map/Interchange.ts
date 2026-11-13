import * as Schema from "effect/Schema";
import { SchematicStationIdSchema, type SchematicStationId } from "~/agencies/types";

export const InterchangeBadgePositionSchema = Schema.Struct({
  dx: Schema.Number,
  dy: Schema.Number,
  layout: Schema.optional(Schema.Union([Schema.Literal("horizontal"), Schema.Literal("vertical")])),
});
export type InterchangeBadgePosition = Schema.Schema.Type<typeof InterchangeBadgePositionSchema>;

export const InterchangeBadgePositionsMapSchema = Schema.Record(
  Schema.String,
  InterchangeBadgePositionSchema,
);
export type InterchangeBadgePositionsMap = Schema.Schema.Type<
  typeof InterchangeBadgePositionsMapSchema
>;

/** A peer station drawn separately with a walking link from the active station. */
export const WalkingInterchangeMarkerSchema = Schema.Struct({
  dx: Schema.Number,
  dy: Schema.Number,
  label: Schema.NonEmptyString,
});
export type WalkingInterchangeMarker = Schema.Schema.Type<typeof WalkingInterchangeMarkerSchema>;

/** Explicit cross-agency station identity; the station id is agency-local. */
export interface InterchangeStationReference {
  readonly agencyId: string;
  readonly stationId: SchematicStationId;
}

/** A reviewed static transfer relationship between two or more agencies. */
export const InterchangeEndpointSchema = Schema.Struct({
  agencyId: Schema.NonEmptyString,
  stationName: Schema.NonEmptyString,
  /** Optional for mapless/feed-only endpoints; required for navigation. */
  stationId: Schema.optional(SchematicStationIdSchema),
  /** Seeded boarding stops for departures outside the agency's schematic. */
  feedStopIds: Schema.optional(Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1))),
  /** Optional target-specific override for the badge text. */
  badgeLabel: Schema.optional(Schema.NonEmptyString),
  /** Authored placement keyed by the agency whose map shows this peer station. */
  walkingMarkers: Schema.optional(Schema.Record(Schema.String, WalkingInterchangeMarkerSchema)),
});
export type InterchangeEndpoint = Schema.Schema.Type<typeof InterchangeEndpointSchema>;

export const InterchangeExclusionSchema = Schema.Struct({
  left: InterchangeEndpointSchema,
  right: InterchangeEndpointSchema,
});

export interface InterchangeExclusion {
  readonly left: InterchangeEndpoint;
  readonly right: InterchangeEndpoint;
}

export const InterchangeHubSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  endpoints: Schema.Array(InterchangeEndpointSchema).check(Schema.isMinLength(2)),
  excludedPairs: Schema.optional(Schema.Array(InterchangeExclusionSchema)),
  badgeOffsets: Schema.optional(InterchangeBadgePositionsMapSchema),
  badgeLabel: Schema.optional(Schema.NonEmptyString),
});
export type InterchangeHub = Schema.Schema.Type<typeof InterchangeHubSchema>;

export const InterchangeDatasetSchema = Schema.Array(InterchangeHubSchema).check(
  Schema.makeFilter((hubs) =>
    new Set(hubs.map((hub) => hub.id)).size === hubs.length
      ? undefined
      : "Interchange hub IDs must be unique",
  ),
);
export type InterchangeDataset = Schema.Schema.Type<typeof InterchangeDatasetSchema>;

/** Pure validation for authored datasets, independent of the registered catalog. */
export function decodeInterchangeDataset(raw: unknown): InterchangeDataset {
  return Schema.decodeUnknownSync(InterchangeDatasetSchema)(raw);
}

/** Departure-only identity; it never becomes a schematic navigation target. */
export function interchangeDepartureId(hubId: string | readonly string[]): string {
  if (typeof hubId === "string") return `interchange:${hubId}`;
  const ids = [...new Set(hubId)].sort();
  return ids.length === 1 ? `interchange:${ids[0]}` : `interchanges:${JSON.stringify(ids)}`;
}

/** null denotes a schematic station; an empty array denotes an invalid hub identity. */
export function interchangeDepartureHubIds(stationId: string): readonly string[] | null {
  if (stationId.startsWith("interchange:")) return [stationId.slice("interchange:".length)];
  if (!stationId.startsWith("interchanges:")) return null;
  try {
    const ids: unknown = JSON.parse(stationId.slice("interchanges:".length));
    return Array.isArray(ids) &&
      ids.length > 0 &&
      ids.every((id) => typeof id === "string" && id.length > 0)
      ? [...new Set<string>(ids)]
      : [];
  } catch {
    return [];
  }
}

export const InterchangeHubOverrideSchema = Schema.Struct({
  id: Schema.optional(Schema.NonEmptyString),
  endpoints: Schema.optional(Schema.Array(InterchangeEndpointSchema).check(Schema.isMinLength(2))),
  badgeOffsets: Schema.optional(InterchangeBadgePositionsMapSchema),
  badgeLabel: Schema.optional(Schema.NonEmptyString),
});
export type InterchangeHubOverride = Schema.Schema.Type<typeof InterchangeHubOverrideSchema>;

export const InterchangeOverridesSchema = Schema.Struct({
  hubs: Schema.Array(InterchangeHubOverrideSchema),
  exclusions: Schema.Array(InterchangeExclusionSchema),
  /** Stations kept out of discovery entirely, when no nearby stop is a documented transfer. */
  isolated: Schema.optional(Schema.Array(InterchangeEndpointSchema)),
});
export type InterchangeOverrides = Schema.Schema.Type<typeof InterchangeOverridesSchema>;
