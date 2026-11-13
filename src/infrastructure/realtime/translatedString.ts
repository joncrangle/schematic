import type { GenericAlertTranslationEvidence } from "~/agencies/types";
import { extractStrongTitle, stripHtml } from "./stripHtml";
import {
  DEFAULT_UI_LOCALE,
  findByLocaleFallbacks,
  localeFallbacks,
  resolveContentLocale,
} from "~/domain/locale";

export interface TranslationValue {
  readonly text?: string | null;
  readonly language?: string | null;
}

/** Prefer rider, agency, default, then untagged text; retain available operator content. */
export function selectTranslatedText(
  translations: readonly TranslationValue[],
  requestedLocale: unknown,
  agencyLocale: string = DEFAULT_UI_LOCALE,
): string | undefined {
  const locale = resolveContentLocale(requestedLocale, agencyLocale);
  const nonblank = (translation: TranslationValue): string | undefined => {
    const text = translation.text?.trim();
    return text || undefined;
  };

  const available = translations.filter((translation) => nonblank(translation) !== undefined);
  const selected =
    findByLocaleFallbacks(
      available,
      (translation) => translation.language,
      localeFallbacks(locale, agencyLocale),
    ) ?? available[0];
  return selected ? nonblank(selected) : undefined;
}

/** Retain classification evidence; decoded text must not be parsed as HTML a second time. */
export function translationEvidence(
  field: GenericAlertTranslationEvidence["field"],
  translations: readonly TranslationValue[],
  fallbackLanguage?: string,
  textFormat: "html" | "text" = "html",
): GenericAlertTranslationEvidence[] {
  return translations.flatMap(({ text, language }) => {
    const normalized = (textFormat === "html" ? stripHtml(text ?? "") : (text ?? "")).trim();
    return normalized ? [{ field, text: normalized, language: language ?? fallbackLanguage }] : [];
  });
}

/** Some operators put their advisory title inside the description's strong markup. */
export function embeddedTitleEvidence(
  translations: readonly TranslationValue[],
  fallbackLanguage?: string,
): GenericAlertTranslationEvidence[] {
  return translations.flatMap(({ text, language }) => {
    const title = extractStrongTitle(text ?? "")?.trim();
    return title ? [{ field: "title", text: title, language: language ?? fallbackLanguage }] : [];
  });
}
