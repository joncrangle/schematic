import {
  createContext,
  createMemo,
  createSignal,
  onCleanup,
  Show,
  useContext,
  type ParentProps,
} from "solid-js";
import { DEFAULT_PREFERENCES, type UserPreferences } from "~/domain/preferences/UserPreferences";
import { useUserPreferences } from "~/context/UserPreferencesContext";
import {
  DEFAULT_UI_LOCALE,
  SUPPORTED_UI_LOCALES,
  resolveFormatLocale,
  type UiLocale,
} from "~/domain/locale";
import {
  formatRegionalDate,
  resolveSpelling,
  resolveUnitSystem,
  timeFormatOptions,
} from "./regionalFormatting";
import { US_SPELLING } from "./usSpelling";
import { en, type TranslationDictionary, type TranslationKey } from "./en";
import { loadLocaleDictionary } from "./catalog";
import {
  englishMessageFormatter,
  pluralFromDictionary,
  translateFromDictionary,
  type Translator,
  type PluralTranslator,
} from "./translate";

export type { TranslationParams } from "./translate";

export interface I18nContextValue {
  /** UI and operator-content language selected by the rider. */
  readonly locale: () => UiLocale;
  /** Locale of the loaded chrome dictionary, which may fall back to English. */
  readonly displayLocale: () => UiLocale;
  readonly formatLocale: () => string;
  readonly unitSystem: () => "metric" | "imperial";
  /** English spelling resolved like units: the rider's choice, else the formatting region. */
  readonly spelling: () => "canadian" | "american";
  readonly isReady: () => boolean;
  readonly t: Translator;
  readonly formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  readonly formatDate: (value: Date | number, options?: Intl.DateTimeFormatOptions) => string;
  readonly formatTime: (value: Date | number, options?: Intl.DateTimeFormatOptions) => string;
  readonly formatRelativeTime: (value: number, unit: Intl.RelativeTimeFormatUnit) => string;
  readonly formatList: (values: readonly string[], options?: Intl.ListFormatOptions) => string;
  readonly plural: PluralTranslator;
}

interface LoadedDictionary {
  readonly preferenceLocale: UiLocale;
  readonly displayLocale: UiLocale;
  readonly dictionary: TranslationDictionary;
}

export interface I18nProviderProps extends ParentProps {
  /** Injectable loader for offline tests and chunk recovery handling. */
  readonly loadDictionary?: (locale: UiLocale) => Promise<TranslationDictionary>;
}

interface DictionaryContextValue {
  readonly locale: () => UiLocale;
  readonly displayLocale: () => UiLocale;
  readonly isReady: () => boolean;
  readonly dictionary: () => TranslationDictionary;
  readonly preferences: () => UserPreferences;
  readonly onMissingKey?: (key: TranslationKey) => void;
  readonly t: Translator;
}

const fallbackContext: I18nContextValue & DictionaryContextValue = {
  locale: () => DEFAULT_UI_LOCALE,
  formatLocale: () => DEFAULT_UI_LOCALE,
  unitSystem: () => "metric",
  spelling: () => "canadian",
  dictionary: () => en,
  preferences: () => DEFAULT_PREFERENCES,
  displayLocale: () => DEFAULT_UI_LOCALE,
  isReady: () => true,
  ...englishMessageFormatter,
  formatDate: (value, options) =>
    new Intl.DateTimeFormat(DEFAULT_UI_LOCALE, options).format(
      value instanceof Date ? value : new Date(value),
    ),
  formatTime: (value, options) =>
    new Intl.DateTimeFormat(DEFAULT_UI_LOCALE, {
      hour: "numeric",
      minute: "2-digit",
      ...options,
    }).format(value instanceof Date ? value : new Date(value)),
  formatRelativeTime: (value, unit) =>
    new Intl.RelativeTimeFormat(DEFAULT_UI_LOCALE, { numeric: "auto" }).format(value, unit),
  formatList: (values, options) => new Intl.ListFormat(DEFAULT_UI_LOCALE, options).format(values),
};

const I18nContext = createContext<I18nContextValue & DictionaryContextValue>(fallbackContext);

export function I18nProvider(props: I18nProviderProps) {
  const preferences = useUserPreferences();
  const [loadedDictionary, setLoadedDictionary] = createSignal<LoadedDictionary>();
  const [hasInitialDictionary, setHasInitialDictionary] = createSignal(false);
  let latestLoad = 0;
  let disposed = false;

  const requestDictionary = async (preferenceLocale: UiLocale): Promise<void> => {
    const requestId = ++latestLoad;
    let loaded: LoadedDictionary;
    try {
      const dictionary = await (props.loadDictionary ?? loadLocaleDictionary)(preferenceLocale);
      loaded = { preferenceLocale, displayLocale: preferenceLocale, dictionary };
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn(
          `The ${preferenceLocale} dictionary could not be loaded; using English chrome.`,
          error,
        );
      }
      loaded = { preferenceLocale, displayLocale: DEFAULT_UI_LOCALE, dictionary: en };
    }

    // Keep the HTML language and direction paired with the dictionary that
    // actually won the latest request. A stale import can never flip chrome.
    if (disposed || requestId !== latestLoad) return;
    setLoadedDictionary(loaded);
    if (!hasInitialDictionary()) setHasInitialDictionary(true);
    if (typeof document !== "undefined") {
      const metadata = SUPPORTED_UI_LOCALES.find(({ tag }) => tag === loaded.displayLocale)!;
      document.documentElement.lang = loaded.displayLocale;
      document.documentElement.dir = metadata.direction;
    }
  };

  const unsubscribeLocale = preferences.onLocaleChange((locale) => {
    if (disposed) return;
    void requestDictionary(locale);
  });
  onCleanup(() => {
    // In-flight dynamic imports may resolve after the app shell is replaced.
    // Invalidate them before releasing the preference listener so they cannot
    // write stale document metadata into a newly mounted shell.
    disposed = true;
    latestLoad += 1;
    unsubscribeLocale();
  });

  // `loadedDictionary` deliberately keeps its previous value while a locale
  // chunk loads. Initial content waits for the first bundle; later switches
  // update the dictionary and document metadata together without remounting
  // the app shell or exposing untranslated intermediate chrome.
  const isReady = hasInitialDictionary;
  const locale = () => preferences.preferences.locale;
  const displayLocale = () => loadedDictionary()?.displayLocale ?? DEFAULT_UI_LOCALE;
  const dictionary = () => loadedDictionary()?.dictionary ?? en;
  const warnMissingKey = (key: TranslationKey) => {
    if (import.meta.env.DEV) console.warn(`Missing ${locale()} translation for "${key}".`);
  };

  const value: DictionaryContextValue = {
    locale,
    displayLocale,
    isReady,
    dictionary,
    preferences: () => preferences.preferences,
    onMissingKey: warnMissingKey,
    t: (key, ...[params]) => translateFromDictionary(key, dictionary(), params, warnMissingKey),
  };

  return (
    <I18nContext value={createRegionalContext(value, () => undefined)}>
      <Show when={isReady()} fallback={<main aria-busy="true" data-i18n-loading="true" />}>
        {props.children}
      </Show>
    </I18nContext>
  );
}

/** Share regional formatters for the shell-resolved country without resolving location in i18n. */
export function FormattingCountryProvider(props: ParentProps<{ country: string | undefined }>) {
  const context = useContext(I18nContext);
  const value = createRegionalContext(context, () => props.country);
  return <I18nContext value={value}>{props.children}</I18nContext>;
}

function createRegionalContext(
  context: DictionaryContextValue,
  country: () => string | undefined,
): I18nContextValue & DictionaryContextValue {
  const preferences = context.preferences;
  const formatLocale = createMemo(() =>
    resolveFormatLocale(
      context.displayLocale(),
      typeof navigator === "undefined" ? [] : navigator.languages,
      country(),
    ),
  );
  const unitSystem = () => resolveUnitSystem(preferences().unitSystem, formatLocale());
  const spelling = () => resolveSpelling(preferences().spelling, formatLocale());
  // Nested providers re-derive from the loaded dictionary so an inner region can undo an outer one.
  const dictionary = createMemo(() =>
    spelling() === "american" && new Intl.Locale(context.displayLocale()).language === "en"
      ? { ...context.dictionary(), ...US_SPELLING }
      : context.dictionary(),
  );
  const numberFormatter = createMemo(() => new Intl.NumberFormat(formatLocale()));
  const relativeFormatter = createMemo(
    () => new Intl.RelativeTimeFormat(formatLocale(), { numeric: "auto" }),
  );
  return {
    ...context,
    formatLocale,
    unitSystem,
    spelling,
    t: (key, ...[params]) =>
      translateFromDictionary(key, dictionary(), params, context.onMissingKey),
    formatNumber: (value, options) =>
      options
        ? new Intl.NumberFormat(formatLocale(), options).format(value)
        : numberFormatter().format(value),
    formatDate: (value, options) =>
      formatRegionalDate(
        value,
        formatLocale(),
        preferences().dateOrder,
        timeFormatOptions(preferences().timeFormat, options),
      ),
    formatTime: (value, options) => {
      return new Intl.DateTimeFormat(
        formatLocale(),
        timeFormatOptions(preferences().timeFormat, {
          hour: "numeric",
          minute: "2-digit",
          ...options,
        }),
      ).format(value);
    },
    formatRelativeTime: (value, unit) => relativeFormatter().format(value, unit),
    formatList: (values, options) => new Intl.ListFormat(formatLocale(), options).format(values),
    plural: (key, count, ...[params]) =>
      pluralFromDictionary(key, count, dictionary(), formatLocale(), params),
  };
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
