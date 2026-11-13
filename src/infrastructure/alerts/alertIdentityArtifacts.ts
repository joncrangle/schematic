import { VersionedAssetReferenceSchema as ArtifactReferenceSchema } from "../staticAssets/versionedAssetReference";
import * as Schema from "effect/Schema";

export const ALERT_IDENTITY_BUCKETS = 32;
export { MAX_STATIC_ASSET_BYTES as MAX_ALERT_IDENTITY_BYTES } from "../staticAssets/versionedAssetReference";
export const ALERT_IDENTITY_ASSET_ROOT = "/generated/alert-identities";
const Id = Schema.String.check(Schema.isMinLength(1));
const Direction = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export {
  VersionedAssetReferenceSchema as ArtifactReferenceSchema,
  type VersionedAssetReference as ArtifactReference,
} from "../staticAssets/versionedAssetReference";
export const AgencyIdentityArtifactsSchema = Schema.Struct({
  sourceHash: Id,
  generation: Hash,
  scope: Schema.optional(ArtifactReferenceSchema),
  trips: Schema.optional(
    Schema.Record(
      Schema.String.check(Schema.isPattern(/^(?:[0-9]|[12][0-9]|3[01])$/)),
      ArtifactReferenceSchema,
    ),
  ),
});
export const AlertIdentityCatalogSchema = Schema.Struct({
  version: Schema.Literal(1),
  agencies: Schema.Record(Schema.String, AgencyIdentityArtifactsSchema),
});
export type AlertIdentityCatalog = Schema.Schema.Type<typeof AlertIdentityCatalogSchema>;
export const ScopeArtifactSchema = Schema.Struct({
  version: Schema.Literal(1),
  agencyId: Id,
  routes: Schema.Array(Schema.Tuple([Id, Schema.String])),
  stops: Schema.Array(Schema.Tuple([Id, Schema.NullOr(Schema.String)])),
  directions: Schema.Array(Schema.Tuple([Id, Id, Direction])),
});
export type ScopeArtifact = Schema.Schema.Type<typeof ScopeArtifactSchema>;
export const TripArtifactSchema = Schema.Struct({
  version: Schema.Literal(1),
  agencyId: Id,
  bucket: Direction,
  groups: Schema.Array(Schema.Tuple([Id, Direction, Schema.Array(Id)])),
});
export type TripArtifact = Schema.Schema.Type<typeof TripArtifactSchema>;

/** Stable partitioning makes a trip lookup read only the required static shards. */
export function alertTripBucket(tripId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < tripId.length; i++) hash = Math.imul(hash ^ tripId.charCodeAt(i), 16777619);
  return (hash >>> 0) % ALERT_IDENTITY_BUCKETS;
}
export function alertIdentityAssetPath(
  agencyId: string,
  kind: "scope" | number,
  hash: string,
): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agencyId))
    throw new Error("Invalid artifact agency identity");
  return `${ALERT_IDENTITY_ASSET_ROOT}/${encodeURIComponent(agencyId)}/${kind === "scope" ? "scope" : `trips-${kind}`}-${hash}.json`;
}
