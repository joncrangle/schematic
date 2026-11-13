import { describe, expect, it } from "vitest";
import { resolveFormatLocale } from "~/domain/locale";
import {
  formatRegionalDate,
  resolveUnitSystem,
  timeFormatOptions,
} from "~/i18n/regionalFormatting";

const date = new Date("2026-05-23T16:07:00Z");
describe("regional formatting", () => {
  it.each([
    [["en", "de-DE", "en-US"], "US", "en-US"],
    [["invalid_tag", "fr"], "GB", "en-GB"],
    [[], undefined, "en-CA"],
    [["en-US"], "CA", "en-CA"],
    [["en-US"], undefined, "en-US"],
    [["en-GB"], "invalid", "en-GB"],
    [["fr-CA"], "US", "en-US"],
  ] as const)(
    "resolves browser hints %j after known country %s",
    (languages, country, expected) => {
      expect(resolveFormatLocale("en-CA", languages, country)).toBe(expected);
    },
  );
  it.each([
    ["en-US", "ymd", "2026-5-23"],
    ["en-US", "mdy", "5/23/2026"],
    ["en-US", "dmy", "23/5/2026"],
  ] as const)("formats %s dates in %s order", (locale, order, expected) => {
    expect(formatRegionalDate(date, locale, order, { timeZone: "UTC" })).toBe(expected);
  });
  it.each([
    ["ymd", "2026 May 23"],
    ["mdy", "May 23, 2026"],
    ["dmy", "23 May 2026"],
  ] as const)("preserves textual months in %s order", (order, expected) => {
    expect(
      formatRegionalDate(date, "en-US", order, {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      }),
    ).toBe(expected);
  });
  it.each([
    ["en-US", "imperial"],
    ["en-GB", "imperial"],
    ["fr-CA", "metric"],
  ] as const)("uses distance conventions for %s", (locale, units) => {
    expect(resolveUnitSystem("locale", locale)).toBe(units);
    expect(resolveUnitSystem("metric", locale)).toBe("metric");
    expect(resolveUnitSystem("imperial", locale)).toBe("imperial");
  });
});

it.each([
  ["12h", true, "12:07 AM"],
  ["12h", false, "12:07 AM"],
  ["24h", true, "00:07"],
  ["24h", false, "00:07"],
] as const)("uses %s despite a surface hour12=%s setting", (preference, hour12, expected) => {
  const options = timeFormatOptions(preference, {
    hour: "2-digit",
    minute: "2-digit",
    hour12,
    timeZone: "UTC",
  });
  expect(new Intl.DateTimeFormat("en-US", options).format(new Date("2026-05-23T00:07:00Z"))).toBe(
    expected,
  );
});
