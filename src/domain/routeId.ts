import type { RouteIdNormalization } from "~/agencies/types";

/** Normalize route IDs only with rules declared by the owning agency. */
export function normalizeRouteId(raw: string, normalization?: RouteIdNormalization): string {
  const trimmed = raw.trim();
  if (!normalization) return trimmed;

  let normalized = normalization.aliases?.[trimmed] ?? trimmed;
  const prefix = normalization.stripPrefix?.trim();
  if (prefix && normalized.toLowerCase().startsWith(prefix.toLowerCase())) {
    const next = normalized[prefix.length];
    if (next === undefined || !/[a-z]/i.test(next)) {
      normalized = normalized.slice(prefix.length).trim();
    }
  }

  if (normalization.extractPattern) {
    const match = new RegExp(normalization.extractPattern).exec(normalized);
    if (match?.[1]) normalized = match[1];
  }
  return normalized.trim();
}

/** Normalize a route list with the same agency rule and keep first-seen order. */
export function normalizeRouteIdList(
  routeIds: readonly string[] | undefined,
  normalization?: RouteIdNormalization,
): readonly string[] | undefined {
  if (!routeIds || routeIds.length === 0) return undefined;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of routeIds) {
    const normalized = normalizeRouteId(raw, normalization);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result.length > 0 ? result : undefined;
}
