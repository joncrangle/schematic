import { describe, expect, it } from "vitest";
import { fr } from "~/i18n/fr";
import { countryName, regionName } from "~/i18n/jurisdictions";
import { englishTranslator, translateFromDictionary, type Translator } from "~/i18n/translate";

/** The same shape as `englishTranslator`, over the French dictionary. */
const frenchTranslator: Translator = (key, ...[params]) =>
  translateFromDictionary(key, fr, params);

/**
 * The picker's "Browse by region" headings resolve through these two functions.
 * Country names come from the platform, so the behaviour under test is that a
 * stored lowercase code still resolves and that the rider's language decides
 * the name. Region names come from the dictionaries, so the behaviour there is
 * the key lookup, the rider's language, and the code fallback.
 */
describe("country display names", () => {
  it("names a country in the rider's language from the stored lowercase code", () => {
    expect(countryName("ca", "en-CA")).toBe("Canada");
    expect(countryName("us", "fr-CA")).toBe("États-Unis");
  });

  it("falls back to the uppercased code when the platform cannot name it", () => {
    expect(countryName("not-a-code", "en-CA")).toBe("NOT-A-CODE");
    expect(countryName("xx", "en-CA")).toBe("XX");
  });

  it("never renders CLDR's unknown-region sentinel for a mis-declared country", () => {
    expect(countryName("zz", "en-CA")).toBe("ZZ");
    expect(countryName("zz", "fr-CA")).toBe("ZZ");
  });
});

describe("region display names", () => {
  it("names a region from the dictionary in the rider's language", () => {
    expect(regionName("ca", "bc", englishTranslator)).toBe("British Columbia");
    expect(regionName("ca", "bc", frenchTranslator)).toBe("Colombie-Britannique");
  });

  it("falls back to the uppercased code for an undeclared country or region", () => {
    expect(regionName("ca", "zz", englishTranslator)).toBe("ZZ");
    expect(regionName("zz", "on", englishTranslator)).toBe("ON");
  });

  it("falls back to the uppercased code until a new country's regions are named", () => {
    expect(regionName("mx", "jal", englishTranslator)).toBe("JAL");
  });
});
