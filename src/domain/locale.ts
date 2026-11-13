/**
 * UI languages supported by the application. Add one row per regional UI
 * locale; consumers derive their locale unions and choices from this list.
 */
export const SUPPORTED_UI_LOCALES = [
  { tag: "en-CA", language: "en", nativeName: "English", direction: "ltr" },
  { tag: "fr-CA", language: "fr", nativeName: "Français", direction: "ltr" },
] as const;

export type UiLocale = (typeof SUPPORTED_UI_LOCALES)[number]["tag"];
/** Must match the locale whose dictionary is the eager base bundle. */
export const DEFAULT_UI_LOCALE: UiLocale = "en-CA";

export function isUiLocale(value: unknown): value is UiLocale {
  return typeof value === "string" && SUPPORTED_UI_LOCALES.some(({ tag }) => tag === value);
}

const canonicalTags = new Map<string, string | undefined>();

/** Canonical BCP-47 tag, or `undefined` for blank and invalid values. */
export function canonicalTag(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const key = value.trim();
  if (canonicalTags.has(key)) return canonicalTags.get(key);
  let result: string | undefined;
  try {
    result = Intl.getCanonicalLocales(key)[0];
  } catch {
    result = undefined;
  }
  if (canonicalTags.size >= 256) canonicalTags.delete(canonicalTags.keys().next().value!);
  canonicalTags.set(key, result);
  return result;
}

/** Exact tags, then progressively broader BCP-47 ranges, preserve script preferences. */
export function lookupLocaleTag<T extends string>(
  value: unknown,
  configuredTags: readonly T[],
): T | undefined {
  const canonical = canonicalTag(value);
  if (!canonical) return undefined;
  for (const candidate of languageCandidates(canonical)) {
    const range = candidate.toLowerCase();
    const exact = configuredTags.find((tag) => canonicalTag(tag)?.toLowerCase() === range);
    if (exact) return exact;
    const moreSpecific = configuredTags.find((tag) =>
      canonicalTag(tag)?.toLowerCase().startsWith(`${range}-`),
    );
    if (moreSpecific) return moreSpecific;
  }
  return undefined;
}

/** Finds the configured UI locale using the same generic lookup for any language. */
export function findSupportedLocale(value: unknown): UiLocale | undefined {
  return lookupLocaleTag(
    value,
    SUPPORTED_UI_LOCALES.map(({ tag }) => tag),
  );
}

/** Converts supported language tags to the app's configured regional locale. */
export function normalizeLocale(value: unknown, fallback: UiLocale = DEFAULT_UI_LOCALE): UiLocale {
  return isUiLocale(value) ? value : (findSupportedLocale(value) ?? fallback);
}

/** Stable unique locales for the subscriptions selected by a scheduler path. */
export function requiredSubscriptionLocales(
  subscriptions: readonly { readonly locale?: unknown }[],
): UiLocale[] {
  return [
    ...new Set(subscriptions.map((subscription) => normalizeLocale(subscription.locale))),
  ].sort();
}

/** Resolve rider content selection against the agency's configured default. */
export function resolveContentLocale(requested: unknown, agencyLocale: unknown): UiLocale {
  return normalizeLocale(requested, normalizeLocale(agencyLocale));
}

/** Selects the first supported language from the browser's ordered preferences. */
export function resolveLocale(browserLanguages: readonly string[] = []): UiLocale {
  for (const language of browserLanguages) {
    const locale = findSupportedLocale(language);
    if (locale) return locale;
  }
  return DEFAULT_UI_LOCALE;
}

function languageCandidates(value: string | undefined): string[] {
  const canonical = canonicalTag(value);
  if (!canonical) return [];
  const parts = canonical.split("-");
  const candidates: string[] = [];
  while (parts.length > 0) {
    candidates.push(parts.join("-"));
    parts.pop();
    // RFC 4647 lookup removes extension/private-use singleton subtags with
    // the extension value so malformed prefixes are never considered.
    if (parts.at(-1)?.length === 1) parts.pop();
  }
  return candidates;
}

/**
 * Produces the ordered feed-language preference chain, ending with an
 * untagged source. The agency locale is considered after the rider's locale.
 */
const fallbackChains = new Map<string, readonly string[]>();
export function localeFallbacks(requested: string, agencyLocale?: string): readonly string[] {
  const key = `${requested}\0${agencyLocale ?? ""}`;
  const cached = fallbackChains.get(key);
  if (cached) return cached;
  const result = [
    ...new Set([
      ...languageCandidates(requested),
      ...languageCandidates(agencyLocale),
      ...languageCandidates(DEFAULT_UI_LOCALE),
      "",
    ]),
  ];
  if (fallbackChains.size >= 64) fallbackChains.delete(fallbackChains.keys().next().value!);
  fallbackChains.set(key, result);
  return result;
}

/**
 * Walks a `localeFallbacks` chain and returns the first candidate tagged with
 * that range or a more specific tag. The empty range selects untagged
 * candidates. More-specific matching keeps a preferred script (zh-Hant) ahead
 * of the broader language (zh), while fr-CA cannot match fr-FR until the
 * explicit fr range is reached.
 */
export function findByLocaleFallbacks<T>(
  candidates: readonly T[],
  languageOf: (candidate: T) => string | null | undefined,
  fallbacks: readonly string[],
): T | undefined {
  for (const fallback of fallbacks) {
    if (fallback === "") {
      const untagged = candidates.find((candidate) => !languageOf(candidate));
      if (untagged !== undefined) return untagged;
      continue;
    }
    const range = canonicalTag(fallback);
    const exact = candidates.find((candidate) => canonicalTag(languageOf(candidate)) === range);
    if (exact !== undefined) return exact;
    const moreSpecific = candidates.find((candidate) =>
      canonicalTag(languageOf(candidate))?.startsWith(`${fallback}-`),
    );
    if (moreSpecific !== undefined) return moreSpecific;
  }
  return undefined;
}

/** UI language with resolved location/agency country before browser-language hints. */
export function resolveFormatLocale(
  uiLocale: UiLocale,
  browserLanguages: readonly string[] = [],
  resolvedCountry?: string,
): string {
  const country = resolvedCountry?.trim().toUpperCase();
  if (country && /^(?:[A-Z]{2}|[0-9]{3})$/.test(country)) {
    return new Intl.Locale(uiLocale, { region: country }).baseName;
  }
  for (const tag of browserLanguages) {
    const canonical = canonicalTag(tag);
    if (!canonical) continue;
    const region = new Intl.Locale(canonical).region;
    if (region) return new Intl.Locale(uiLocale, { region }).baseName;
  }
  return new Intl.Locale(uiLocale, { region: "CA" }).baseName;
}
