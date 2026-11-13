import type { AlertSource } from "~/agencies/types";
import {
  canonicalTag,
  DEFAULT_UI_LOCALE,
  findByLocaleFallbacks,
  localeFallbacks,
  resolveContentLocale,
  type UiLocale,
} from "~/domain/locale";

function chooseLanguage(
  sources: readonly AlertSource[],
  requestedLocale: UiLocale,
  agencyLocale: string,
): string | undefined {
  const match = findByLocaleFallbacks(
    sources,
    (source) => source.language,
    localeFallbacks(requestedLocale, agencyLocale),
  );
  return canonicalTag(match?.language);
}

/**
 * Selects one language variant for each declared logical source group. If a
 * group contains no supported fallback, its first declared source remains a
 * stable operator-content fallback rather than erasing the whole group.
 * Ungrouped sources always remain independent, even when they are untagged.
 */
export function selectAlertSourcesForLocale(
  sources: readonly AlertSource[],
  requestedLocale: unknown,
  agencyLocale: string = DEFAULT_UI_LOCALE,
): readonly AlertSource[] {
  const locale = resolveContentLocale(requestedLocale, agencyLocale);
  const selectedByGroup = new Map<string, ReadonlySet<AlertSource>>();
  const groups = new Map<string, AlertSource[]>();

  for (const source of sources) {
    if (!source.languageGroup) continue;
    const variants = groups.get(source.languageGroup) ?? [];
    variants.push(source);
    groups.set(source.languageGroup, variants);
  }

  for (const [group, variants] of groups) {
    const selectedLanguage = chooseLanguage(variants, locale, agencyLocale);
    if (selectedLanguage === undefined) {
      const untagged = variants.filter((source) => source.language === undefined);
      selectedByGroup.set(group, new Set(untagged.length > 0 ? untagged : [variants[0]!]));
      continue;
    }
    selectedByGroup.set(
      group,
      new Set(variants.filter((source) => canonicalTag(source.language) === selectedLanguage)),
    );
  }

  return sources.filter((source) => {
    const group = source.languageGroup;
    if (!group) return true;
    return selectedByGroup.get(group)?.has(source) === true;
  });
}
