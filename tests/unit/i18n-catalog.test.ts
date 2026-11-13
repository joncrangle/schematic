import { describe, expect, it } from "vitest";
import { SUPPORTED_UI_LOCALES } from "~/domain/locale";
import { DICTIONARY_LOADERS, loadLocaleDictionary } from "~/i18n/catalog";
import { en, type TranslationEntry, type TranslationKey } from "~/i18n/en";
import { US_SPELLING } from "~/i18n/usSpelling";

describe("locale dictionary registry", () => {
  it("has one loader for each configured UI locale", () => {
    expect(Object.keys(DICTIONARY_LOADERS).sort()).toEqual(
      SUPPORTED_UI_LOCALES.map(({ tag }) => tag).sort(),
    );
  });

  it.each(SUPPORTED_UI_LOCALES)("loads the complete $tag dictionary", async ({ tag }) => {
    const dictionary = await loadLocaleDictionary(tag);
    expect(Object.keys(dictionary).sort()).toEqual(Object.keys(en).sort());
  });

  it("uses the default dictionary when an optional locale loader is absent", async () => {
    const defaultLoader = async () => en;
    await expect(loadLocaleDictionary("fr-CA", { "en-CA": defaultLoader })).resolves.toBe(en);
  });

  it.each([
    { "Line {{name}}": "Ligne {{id}}" },
    { "More alerts": { one: "+{{count}} de plus", other: "de plus" } },
  ])("rejects a translation that changes required interpolation parameters", async (dictionary) => {
    await expect(
      loadLocaleDictionary("fr-CA", { "fr-CA": async () => dictionary }),
    ).rejects.toThrow(/parameters/);
  });

  it("allows a translation to reorder named parameters", async () => {
    const dictionary = { "{{from}} to {{to}}": "{{to}} depuis {{from}}" };
    await expect(loadLocaleDictionary("fr-CA", { "fr-CA": async () => dictionary })).resolves.toBe(
      dictionary,
    );
  });
});

describe("American spelling overrides", () => {
  const messagesOf = (entry: TranslationEntry) =>
    typeof entry === "string" ? [entry] : Object.values(entry);
  const parametersOf = (message: string) =>
    [...message.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();

  it("leaves no Canadian spelling in English chrome", () => {
    const canadianSpelling =
      /favourite|recentre|colour|centre|metre|licence|travell|cancell|behaviour|neighbour/i;
    const messages = (Object.keys(en) as TranslationKey[]).flatMap((key) =>
      messagesOf(US_SPELLING[key] ?? en[key]),
    );
    expect(messages.filter((message) => canadianSpelling.test(message))).toEqual([]);
  });

  it("changes only spelling and keeps each message's parameters", () => {
    const overrides = Object.entries(US_SPELLING) as [TranslationKey, TranslationEntry][];
    expect(
      overrides.filter(
        ([key, entry]) =>
          entry === en[key] ||
          parametersOf(messagesOf(entry).join()).join() !==
            parametersOf(messagesOf(en[key]).join()).join(),
      ),
    ).toEqual([]);
  });
});
