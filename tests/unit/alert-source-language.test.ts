import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { selectAlertSourcesForLocale } from "~/infrastructure/realtime/alertSourceSelection";
import { AlertSourceSchema, type AlertSource } from "~/agencies/types";

const rss = (url: string, overrides: Record<string, unknown> = {}): AlertSource =>
  ({
    type: "rss",
    url: `https://example.test/${url}`,
    expiryPolicy: "feed-presence",
    ...overrides,
  }) as AlertSource;

describe("alert source language selection", () => {
  it("validates BCP-47 language tags and nonblank variant groups", () => {
    expect(() =>
      Schema.decodeUnknownSync(AlertSourceSchema)(
        rss("invalid", { language: "not a locale", languageGroup: "updates" }),
      ),
    ).toThrow(/valid BCP 47 locale/);
    expect(() =>
      Schema.decodeUnknownSync(AlertSourceSchema)(rss("invalid", { languageGroup: " " })),
    ).toThrow(/non-whitespace/);
  });

  it("requires canonical RSS identity extraction to use a grouped source and one capture", () => {
    expect(() =>
      Schema.decodeUnknownSync(AlertSourceSchema)(
        rss("identity", { incidentIdentityPattern: "/item/(\\d+)" }),
      ),
    ).toThrow(/requires languageGroup/);
    expect(() =>
      Schema.decodeUnknownSync(AlertSourceSchema)(
        rss("identity", {
          languageGroup: "updates",
          incidentIdentityPattern: "/item/\\d+",
        }),
      ),
    ).toThrow(/exactly one capture group/);
  });

  it.each([
    { requested: "fr-CA", available: ["fr-CA", "fr", "en-CA", "en"], selected: "fr-CA" },
    { requested: "fr-CA", available: ["fr", "en-CA", "en"], selected: "fr" },
    { requested: "fr-CA", available: ["en-CA", "en"], selected: "en-CA" },
    { requested: "fr-CA", available: ["en"], selected: "en" },
  ] as const)(
    "selects $selected for $requested when available",
    ({ requested, available, selected }) => {
      const sources = available.map((language) =>
        rss(language, { language, languageGroup: "service-updates" }),
      );

      expect(
        selectAlertSourcesForLocale(sources, requested, "en-CA").map((source) => source.url),
      ).toEqual([`https://example.test/${selected}`]);
    },
  );

  it("keeps independent feeds and selects the same-language members of a variant group", () => {
    const sources = [
      rss("updates-en-a", { language: "en", languageGroup: "updates" }),
      rss("updates-en-b", { language: "en", languageGroup: "updates" }),
      rss("updates-fr", { language: "fr", languageGroup: "updates" }),
      rss("elevators", { language: "en" }),
      rss("untagged-complement"),
    ];

    expect(
      selectAlertSourcesForLocale(sources, "fr-CA", "en-CA").map((source) => source.url),
    ).toEqual([
      "https://example.test/updates-fr",
      "https://example.test/elevators",
      "https://example.test/untagged-complement",
    ]);
  });

  it("preserves the preferred script before falling back to the base language", () => {
    const sources = [
      rss("simplified", { language: "zh-Hans-CN", languageGroup: "updates" }),
      rss("traditional", { language: "zh-Hant-HK", languageGroup: "updates" }),
    ];
    expect(
      selectAlertSourcesForLocale(sources, "en-CA", "zh-Hant-TW").map((source) => source.url),
    ).toEqual(["https://example.test/traditional"]);
  });

  it("falls back to an untagged member only when the requested and default variants are absent", () => {
    const sources = [
      rss("fr", { language: "fr", languageGroup: "updates" }),
      rss("untranslated", { languageGroup: "updates" }),
    ];

    expect(
      selectAlertSourcesForLocale(sources, "en-CA", "en-CA").map((source) => source.url),
    ).toEqual(["https://example.test/untranslated"]);
  });

  it("keeps the first configured member when a group has no supported language fallback", () => {
    const sources = [
      rss("spanish-first", { language: "es", languageGroup: "service-updates" }),
      rss("spanish-second", { language: "es-MX", languageGroup: "service-updates" }),
      rss("independent", { language: "pt" }),
    ];

    expect(
      selectAlertSourcesForLocale(sources, "fr-CA", "en-CA").map((source) => source.url),
    ).toEqual(["https://example.test/spanish-first", "https://example.test/independent"]);
  });
});
