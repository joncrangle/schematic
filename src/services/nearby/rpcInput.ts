import {
  parseProximityQuery,
  type ParsedProximityQuery,
  type RawProximityQuery,
} from "~/domain/proximity";
import { findSupportedLocale, type UiLocale } from "~/domain/locale";

/** Every Nearby RPC is agency-scoped; callers must provide a non-empty id. */
export function requireAgencyId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) {
    throw new Error("Missing or invalid agencyId parameter");
  }
  return id;
}

/** Optional rider coordinates are dropped rather than rejected when unusable. */
export function finiteNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export interface NearbyRpcInput extends ParsedProximityQuery {
  readonly agencyId: string;
  readonly locale?: UiLocale;
}

/** Omission uses the agency default; supplied tags must resolve to a supported UI locale. */
export function parseOptionalUiLocale(value: unknown): UiLocale | undefined {
  if (value === undefined) return undefined;
  const locale = findSupportedLocale(value);
  if (!locale) throw new Error("Missing, invalid or unsupported locale parameter");
  return locale;
}

/** Shared agency validation and proximity coercion for Nearby RPC validators. */
export function parseNearbyRpcInput(
  input: RawProximityQuery & { readonly agencyId?: unknown; readonly locale?: unknown },
): NearbyRpcInput {
  const locale = parseOptionalUiLocale(input.locale);
  return {
    agencyId: requireAgencyId(input.agencyId),
    ...(locale === undefined ? {} : { locale }),
    ...parseProximityQuery(input),
  };
}
