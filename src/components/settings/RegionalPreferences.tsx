import { createMemo, For, Show } from "solid-js";
import { useUserPreferences } from "~/context/UserPreferencesContext";
import { useI18n } from "~/i18n/I18nContext";
import {
  formatRegionalDate,
  resolveDateOrder,
  resolveTimeFormat,
  timeFormatOptions,
} from "~/i18n/regionalFormatting";
import { SUPPORTED_UI_LOCALES, type UiLocale } from "~/domain/locale";
import { Select } from "~/components/Select";

interface FormatChoicesProps<T extends string> {
  readonly name: string;
  readonly legend: string;
  readonly value: T;
  readonly options: readonly { value: T; label: string; example: string; ariaLabel?: string }[];
  readonly onChange: (value: T) => void;
}

function FormatChoices<T extends string>(props: FormatChoicesProps<T>) {
  return (
    <fieldset class="min-w-0">
      <legend class="mb-2 text-[11px] font-medium text-muted-foreground">{props.legend}</legend>
      <div class="grid auto-cols-fr grid-flow-col gap-1 rounded-lg bg-background/60 p-1">
        <For each={props.options}>
          {(option) => (
            <label class="min-w-0 cursor-pointer">
              <input
                type="radio"
                name={props.name}
                value={option.value}
                aria-label={option.ariaLabel ?? option.label}
                checked={props.value === option.value}
                onClick={() => {
                  // A checked radio emits no change event, but activation still pins its value.
                  if (props.value === option.value) props.onChange(option.value);
                }}
                onChange={() => props.onChange(option.value)}
                class="peer sr-only"
              />
              <span class="flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-md border border-transparent px-1 py-2 text-muted-foreground peer-checked:border-border peer-checked:bg-accent peer-checked:text-foreground peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-info">
                <span class="text-[11px] font-semibold leading-tight">{option.label}</span>
                <span class="whitespace-nowrap font-mono text-[10px] leading-tight opacity-70">
                  {option.example}
                </span>
              </span>
            </label>
          )}
        </For>
      </div>
    </fieldset>
  );
}

/** Present concrete regional choices while retaining automatic defaults in storage. */
export function RegionalPreferences() {
  const { preferences, setPreference } = useUserPreferences();
  const i18n = useI18n();
  const t = i18n.t;
  const exampleDate = new Date(2026, 4, 23, 13, 45);
  const dateOrder = () => resolveDateOrder(preferences.dateOrder, i18n.formatLocale());
  const timeFormat = () => resolveTimeFormat(preferences.timeFormat, i18n.formatLocale());
  const isEnglish = () => new Intl.Locale(i18n.displayLocale()).language === "en";
  const hasOverrides = () =>
    preferences.dateOrder !== "locale" ||
    preferences.timeFormat !== "locale" ||
    preferences.unitSystem !== "locale" ||
    (isEnglish() && preferences.spelling !== "locale");
  const dateExample = (order: "ymd" | "mdy" | "dmy") =>
    formatRegionalDate(exampleDate, i18n.formatLocale(), order, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  const timeExample = (format: "12h" | "24h") =>
    new Intl.DateTimeFormat(
      i18n.formatLocale(),
      timeFormatOptions(format, { hour: "numeric", minute: "2-digit" }),
    ).format(exampleDate);
  const reset = () => {
    setPreference("dateOrder", "locale");
    setPreference("timeFormat", "locale");
    setPreference("unitSystem", "locale");
    setPreference("spelling", "locale");
  };
  const dateOptions = createMemo(
    () =>
      [
        {
          value: "ymd",
          label: t("Year first"),
          ariaLabel: t("Year / month / day"),
          example: dateExample("ymd"),
        },
        {
          value: "mdy",
          label: t("Month first"),
          ariaLabel: t("Month / day / year"),
          example: dateExample("mdy"),
        },
        {
          value: "dmy",
          label: t("Day first"),
          ariaLabel: t("Day / month / year"),
          example: dateExample("dmy"),
        },
      ] as const,
  );
  const timeOptions = createMemo(
    () =>
      [
        { value: "12h", label: t("12-hour"), example: timeExample("12h") },
        { value: "24h", label: t("24-hour"), example: timeExample("24h") },
      ] as const,
  );
  const unitOptions = createMemo(
    () =>
      [
        { value: "metric", label: t("Metric"), example: "km · km/h" },
        { value: "imperial", label: t("Imperial"), example: t("mi · mph") },
      ] as const,
  );
  // Examples stay literal because the choice only appears with English chrome.
  const spellingOptions = createMemo(
    () =>
      [
        { value: "canadian", label: t("Canadian"), example: "favourite" },
        { value: "american", label: t("American"), example: "favorite" },
      ] as const,
  );
  return (
    <section class="rounded-xl border border-border bg-card p-3">
      <div class="flex items-center justify-between gap-4">
        <label for="ui-language-select" class="text-[13px] font-semibold text-foreground">
          {t("Language")}
        </label>
        <Select
          id="ui-language-select"
          ariaLabel={t("Language")}
          class="w-36"
          value={preferences.locale}
          options={[...SUPPORTED_UI_LOCALES]
            .sort((a, b) => a.nativeName.localeCompare(b.nativeName))
            .map((entry) => ({ value: entry.tag, label: entry.nativeName }))}
          onChange={(tag) => setPreference("locale", tag as UiLocale)}
        />
      </div>
      <div class="my-3 h-px bg-border" />
      <div class="mb-3 flex min-h-6 items-center justify-between gap-3">
        <h3 class="text-[13px] font-semibold text-foreground">{t("Formats")}</h3>
        <button
          type="button"
          onClick={reset}
          disabled={!hasOverrides()}
          aria-label={t("Reset formats")}
          class="min-h-8 rounded-md px-2 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-info disabled:pointer-events-none disabled:opacity-40"
        >
          {t("Reset")}
        </button>
      </div>
      <FormatChoices
        name="date-order"
        legend={t("Date order")}
        value={dateOrder()}
        options={dateOptions()}
        onChange={(value) => setPreference("dateOrder", value)}
      />
      <div class="mt-3 grid grid-cols-1 gap-3 min-[360px]:grid-cols-2">
        <FormatChoices
          name="time-format"
          legend={t("Time format")}
          value={timeFormat()}
          options={timeOptions()}
          onChange={(value) => setPreference("timeFormat", value)}
        />
        <FormatChoices
          name="unit-system"
          legend={t("Units")}
          value={i18n.unitSystem()}
          options={unitOptions()}
          onChange={(value) => setPreference("unitSystem", value)}
        />
        <Show when={isEnglish()}>
          <FormatChoices
            name="spelling"
            legend={t("Spelling")}
            value={i18n.spelling()}
            options={spellingOptions()}
            onChange={(value) => setPreference("spelling", value)}
          />
        </Show>
      </div>
    </section>
  );
}
