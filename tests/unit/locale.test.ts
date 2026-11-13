import { describe, expect, it } from "vitest";
import {
  findSupportedLocale,
  isUiLocale,
  localeFallbacks,
  lookupLocaleTag,
  normalizeLocale,
  resolveLocale,
  SUPPORTED_UI_LOCALES,
} from "~/domain/locale";

describe("UI locale negotiation", () => {
  it("resolves regional preferences within their configured script before the language default", () => {
    const configured = ["zh-Hant-TW", "zh-Hans-CN", "en-CA"] as const;
    expect(lookupLocaleTag("zh-Hans-HK", configured)).toBe("zh-Hans-CN");
    expect(lookupLocaleTag("zh-Hant-TW-u-nu-hanidec", configured)).toBe("zh-Hant-TW");
    expect(lookupLocaleTag("zh-SG", configured)).toBe("zh-Hant-TW");
  });

  it("uses one registry for supported tags, native names, and normalization", () => {
    for (const { tag } of SUPPORTED_UI_LOCALES) {
      expect(isUiLocale(tag)).toBe(true);
      expect(findSupportedLocale(tag)).toBe(tag);
      expect(normalizeLocale(tag.toUpperCase())).toBe(tag);
    }
  });

  it.each([
    ["fr-FR", "fr-CA"],
    ["de-DE", undefined],
  ] as const)("matches unregistered tag %s to supported locale %s", (input, expected) => {
    expect(isUiLocale(input)).toBe(false);
    expect(findSupportedLocale(input)).toBe(expected);
  });

  it.each([
    ["fr", "fr-CA"],
    ["fr-FR", "fr-CA"],
    ["FR-ca", "fr-CA"],
    ["en", "en-CA"],
    ["en-US", "en-CA"],
    ["de-DE", "en-CA"],
    [null, "en-CA"],
  ] as const)("normalizes %s to %s", (input, expected) => {
    expect(normalizeLocale(input)).toBe(expected);
  });

  it("uses a supported fallback for invalid locale values", () => {
    expect(normalizeLocale("not-a-locale", "fr-CA")).toBe("fr-CA");
    expect(normalizeLocale(42, "fr-CA")).toBe("fr-CA");
  });

  it.each([
    [["fr-CA", "en-CA"], "fr-CA"],
    [["fr-FR", "en-US"], "fr-CA"],
    [["de-DE", "en-US"], "en-CA"],
    [[], "en-CA"],
  ] as const)("resolves browser languages %j to %s", (languages, expected) => {
    expect(resolveLocale(languages)).toBe(expected);
  });

  it("builds a deduplicated source-language fallback chain", () => {
    expect(localeFallbacks("fr-CA", "en-CA")).toEqual(["fr-CA", "fr", "en-CA", "en", ""]);
    expect(localeFallbacks("en-US", "fr-CA")).toEqual(["en-US", "en", "fr-CA", "fr", "en-CA", ""]);
  });
});
