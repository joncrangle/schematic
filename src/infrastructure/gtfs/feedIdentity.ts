export interface FeedIdentity {
  readonly idNamespace?: string;
  readonly stripIdPrefixPattern?: string;
}

export function namespaceFeedId(value: string, namespace?: string): string {
  const id = value.trim();
  return id && namespace ? `${namespace}:${id}` : id;
}

/** Foreign keys and primary keys share one transformation; public stop codes never change. */
export function createStaticFeedIdentity(identity?: FeedIdentity) {
  const pattern = identity?.stripIdPrefixPattern
    ? new RegExp(identity.stripIdPrefixPattern, "u")
    : undefined;
  const fields = new Set([
    "route_id",
    "trip_id",
    "stop_id",
    "parent_station",
    "shape_id",
    "service_id",
  ]);
  return (field: string, value: string): string => {
    if (!value || !fields.has(field)) return value;
    const stripped = field === "service_id" ? value : pattern ? value.replace(pattern, "") : value;
    if (!stripped) throw new Error(`Empty transformed GTFS ${field}`);
    return namespaceFeedId(stripped, identity?.idNamespace);
  };
}
