import { DEFAULT_UI_LOCALE, type UiLocale } from "~/domain/locale";
import { en, type TranslationDictionary, type TranslationKey } from "./en";

export type DictionaryLoader = () => Promise<TranslationDictionary>;

/**
 * Locale bundles are registered here so the provider has no per-language
 * branches. Keep the default bundle eager and load other bundles on demand.
 */
export const DICTIONARY_LOADERS: Readonly<Record<UiLocale, DictionaryLoader>> = {
  "en-CA": async () => en,
  "fr-CA": async () => (await import("./fr")).fr,
};

export async function loadLocaleDictionary(
  locale: UiLocale,
  loaders: Readonly<Partial<Record<UiLocale, DictionaryLoader>>> = DICTIONARY_LOADERS,
): Promise<TranslationDictionary> {
  const loader = loaders[locale] ?? loaders[DEFAULT_UI_LOCALE];
  const dictionary = loader ? await loader() : en;
  for (const key of Object.keys(dictionary) as TranslationKey[]) {
    const entry = dictionary[key];
    if (entry === undefined) continue;
    const base = en[key];
    const expected = parameterNames(typeof base === "string" ? base : base.other);
    const forms = typeof entry === "string" ? [entry] : Object.values(entry);
    if (forms.some((form) => parameterNames(form) !== expected)) {
      throw new Error(`Translation parameters differ for "${key}" in ${locale}.`);
    }
  }
  return dictionary;
}

function parameterNames(message: string): string {
  return [...new Set([...message.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]))]
    .sort()
    .join(",");
}
