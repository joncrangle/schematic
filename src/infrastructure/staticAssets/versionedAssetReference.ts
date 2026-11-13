import * as Schema from "effect/Schema";
export const MAX_STATIC_ASSET_BYTES = 512 * 1024;
export const VersionedAssetReferenceSchema = Schema.Struct({
  hash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  bytes: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(MAX_STATIC_ASSET_BYTES),
  ),
});
export type VersionedAssetReference = Schema.Schema.Type<typeof VersionedAssetReferenceSchema>;
