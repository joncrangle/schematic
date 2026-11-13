import { en, type PluralTranslation, type TranslationDictionary, type TranslationKey } from "./en";
import { DEFAULT_UI_LOCALE } from "~/domain/locale";

export type TranslationParams = Readonly<Record<string, string | number>>;

type MessageText<Entry> = Entry extends string ? Entry : Entry[keyof Entry];
type ParameterNames<Text> = Text extends `${string}{{${infer Name}}}${infer Rest}`
  ? Name | ParameterNames<Rest>
  : never;
type ParametersFor<Key extends TranslationKey, Supplied extends string = never> = Readonly<
  Record<Exclude<ParameterNames<MessageText<(typeof en)[Key]>>, Supplied>, string | number>
>;
export type PlainTranslationKey = {
  [Key in TranslationKey]: [ParameterNames<MessageText<(typeof en)[Key]>>] extends [never]
    ? Key
    : never;
}[TranslationKey];
type TranslationArguments<Key extends TranslationKey, Supplied extends string = never> = [
  Exclude<ParameterNames<MessageText<(typeof en)[Key]>>, Supplied>,
] extends [never]
  ? [params?: ParametersFor<Key, Supplied>]
  : [params: ParametersFor<Key, Supplied>];

export type Translator = <Key extends TranslationKey>(
  key: Key,
  ...args: TranslationArguments<NoInfer<Key>>
) => string;

export type PluralTranslator = <Key extends TranslationKey>(
  key: Key,
  count: number,
  ...args: TranslationArguments<NoInfer<Key>, "count">
) => string;

export interface MessageFormatter {
  readonly unitSystem?: () => "metric" | "imperial";
  readonly t: Translator;
  readonly formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  readonly plural: PluralTranslator;
}

export function interpolateMessage(message: string, params: TranslationParams = {}): string {
  return message.replace(/\{\{([\w]+)\}\}/g, (placeholder, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : placeholder,
  );
}

/** Resolves a key in the active dictionary, falling back to English. */
export function translateFromDictionary(
  key: TranslationKey,
  dictionary: TranslationDictionary,
  params?: TranslationParams,
  onMissing?: (key: TranslationKey) => void,
): string {
  let entry = dictionary[key];
  if (entry === undefined) {
    onMissing?.(key);
    entry = en[key];
  }
  return interpolateMessage(
    typeof entry === "string" ? entry : (entry.other ?? entry.one ?? key),
    params,
  );
}

/** Selects the locale's plural form, falling back to English, and formats `count`. */
export function pluralFromDictionary(
  key: TranslationKey,
  count: number,
  dictionary: TranslationDictionary,
  locale: string,
  params?: TranslationParams,
): string {
  const entry = dictionary[key] ?? en[key];
  const message =
    typeof entry === "string" ? entry : (selectPluralMessage(entry, count, locale) ?? "");
  return interpolateMessage(message, {
    ...params,
    count: new Intl.NumberFormat(locale).format(count),
  });
}

export function selectPluralMessage(
  forms: PluralTranslation,
  count: number,
  locale: string,
): string | undefined {
  const category = new Intl.PluralRules(locale).select(count);
  return forms[category] ?? forms.other ?? forms.one;
}

export const englishTranslator: Translator = (key, ...[params]) =>
  translateFromDictionary(key, en, params);

export const englishMessageFormatter: MessageFormatter = {
  t: englishTranslator,
  formatNumber: (value, options) => new Intl.NumberFormat(DEFAULT_UI_LOCALE, options).format(value),
  plural: (key, count, ...[params]) =>
    pluralFromDictionary(key, count, en, DEFAULT_UI_LOCALE, params),
};
