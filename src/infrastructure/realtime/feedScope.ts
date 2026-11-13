/** Disjoint feed namespaces let scoped boards avoid fetching every sector. */
export function feedMatchesScope(
  feed: { readonly idNamespace?: string },
  scope: { readonly stopIds?: ReadonlySet<string>; readonly routeIds?: ReadonlySet<string> },
): boolean {
  if (!feed.idNamespace) return true;
  const ids = scope.stopIds?.size ? scope.stopIds : scope.routeIds;
  return !ids?.size || [...ids].some((id) => id.startsWith(feed.idNamespace + ":"));
}
