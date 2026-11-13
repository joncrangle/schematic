import type {
  DateOrder,
  Spelling,
  TimeFormat,
  UnitSystem,
} from "~/domain/preferences/UserPreferences";

/** Map CLDR's US and UK measurement systems to the app's imperial display choice.
 * https://github.com/unicode-org/cldr/blob/main/common/supplemental/supplementalData.xml
 */
export function resolveUnitSystem(
  preference: UnitSystem,
  locale: string,
): Exclude<UnitSystem, "locale"> {
  if (preference !== "locale") return preference;
  const region = new Intl.Locale(locale).region;
  return region === "US" || region === "LR" || region === "GB" || region === "MM"
    ? "imperial"
    : "metric";
}

/** The United States and its territories use American spelling; the base dictionary is Canadian. */
const AMERICAN_SPELLING_REGIONS = new Set(["US", "AS", "GU", "MP", "PR", "UM", "VI"]);

export function resolveSpelling(preference: Spelling, locale: string): Exclude<Spelling, "locale"> {
  if (preference !== "locale") return preference;
  return AMERICAN_SPELLING_REGIONS.has(new Intl.Locale(locale).region ?? "")
    ? "american"
    : "canadian";
}

/** Resolve the actual numeric order displayed by regional date formatting. */
export function resolveDateOrder(
  preference: DateOrder,
  locale: string,
): Exclude<DateOrder, "locale"> {
  if (preference !== "locale") return preference;
  if (new Intl.Locale(locale).region === "CA") return "ymd";
  const first = new Intl.DateTimeFormat(locale)
    .formatToParts(new Date(2026, 4, 23))
    .find((part) => ["year", "month", "day"].includes(part.type))?.type;
  return first === "year" ? "ymd" : first === "day" ? "dmy" : "mdy";
}

export function resolveTimeFormat(
  preference: TimeFormat,
  locale: string,
): Exclude<TimeFormat, "locale"> {
  if (preference !== "locale") return preference;
  return new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hour12
    ? "12h"
    : "24h";
}

export function timeFormatOptions(
  preference: TimeFormat,
  options: Intl.DateTimeFormatOptions = {},
): Intl.DateTimeFormatOptions {
  if (preference === "locale") return options;
  const resolved = { ...options };
  delete resolved.hour12;
  resolved.hourCycle = preference === "24h" ? "h23" : "h12";
  return resolved;
}

/** Reorder date fields, retaining field widths, month names, and surrounding time/weekday. */
export function formatRegionalDate(
  value: Date | number,
  locale: string,
  preference: DateOrder,
  options?: Intl.DateTimeFormatOptions,
): string {
  const formatter = new Intl.DateTimeFormat(locale, options);
  const parts = formatter.formatToParts(value);
  // Keep Canada's year-first numeric dates stable across ICU/CLDR revisions.
  // Textual month styles still follow the locale unless explicitly overridden.
  const numericMonth = parts.some(
    (part) => part.type === "month" && /^\p{Number}+$/u.test(part.value),
  );
  const order =
    preference === "locale" && numericMonth && new Intl.Locale(locale).region === "CA"
      ? "ymd"
      : preference;
  if (order === "locale") return formatter.format(value);
  const fields = ["year", "month", "day"];
  const indices = parts.flatMap((part, index) => (fields.includes(part.type) ? [index] : []));
  if (indices.length < 2) return formatter.format(value);
  const first = indices[0]!;
  const last = indices.at(-1)!;
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const requested = (
    {
      ymd: ["year", "month", "day"],
      mdy: ["month", "day", "year"],
      dmy: ["day", "month", "year"],
    } as const
  )[order];
  const ordered = requested.filter((field) => values.has(field));
  const textual = values.has("month") && !/^\p{Number}+$/u.test(values.get("month")!);
  const separator = textual
    ? " "
    : order === "ymd"
      ? "-"
      : parts[first + 1]?.type === "literal"
        ? parts[first + 1]!.value
        : "/";
  const date = ordered
    .map((field, index) => {
      const before =
        index === 0
          ? ""
          : textual && order === "mdy" && field === "year" && values.has("day")
            ? ", "
            : separator;
      return before + values.get(field);
    })
    .join("");
  return (
    parts
      .slice(0, first)
      .map((part) => part.value)
      .join("") +
    date +
    parts
      .slice(last + 1)
      .map((part) => part.value)
      .join("")
  );
}

export interface DistanceDisplay {
  readonly value: number;
  readonly unit: "m" | "km" | "ft" | "mi";
  readonly fractionDigits: number;
}

export function distanceDisplay(meters: number, units: "metric" | "imperial"): DistanceDisplay {
  if (units === "imperial") {
    const miles = meters / 1609.344;
    return miles >= 0.1
      ? { value: miles, unit: "mi", fractionDigits: 1 }
      : { value: Math.round(meters / 0.3048 / 10) * 10, unit: "ft", fractionDigits: 0 };
  }
  return meters >= 1000
    ? { value: meters / 1000, unit: "km", fractionDigits: 1 }
    : { value: Math.round(meters), unit: "m", fractionDigits: 0 };
}
