/**
 * Jurisdiction display names for the picker's "Browse by region" headings.
 *
 * Those headings are app labels, so the rider's locale decides them and the
 * text lives in the i18n dictionaries with the rest of the chrome. This module
 * only bridges a declared jurisdiction to its name.
 *
 * Country names come from the platform (`Intl.DisplayNames`), so adding a
 * country costs no data at all and every country resolves in the rider's
 * language. Subdivisions have no `Intl` support — `type: "subdivision"` is not
 * a valid option and a region code echoes back verbatim — so a region resolves
 * to a catalog key: adding one costs a key in each dictionary plus a row here.
 */
import type { PlainTranslationKey, Translator } from "./translate";

/**
 * Declared jurisdiction -> the catalog key holding that region's name. Region
 * names never interpolate, so these are plain keys and `t` takes them alone.
 */
export const REGION_KEYS: Readonly<Record<string, Readonly<Record<string, PlainTranslationKey>>>> =
  {
    ca: {
      mb: "Manitoba",
      on: "Ontario",
      nb: "New Brunswick",
      qc: "Québec",
      yt: "Yukon",
      nt: "Northwest Territories",
      ns: "Nova Scotia",
      nl: "Newfoundland and Labrador",
      bc: "British Columbia",
      ab: "Alberta",
      sk: "Saskatchewan",
      pe: "Prince Edward Island",
    },
    us: { ny: "New York" },
  };

interface CountryNamer {
  /** `null` records a locale the runtime rejected outright. */
  readonly formatter: Intl.DisplayNames | null;
  /** CLDR's own label for its `ZZ` "unknown region" sentinel, in this locale. */
  readonly unknown: string | undefined;
}

const countryNamers = new Map<string, CountryNamer>();

function countryNamer(locale: string): CountryNamer {
  const cached = countryNamers.get(locale);
  if (cached !== undefined) return cached;
  let namer: CountryNamer = { formatter: null, unknown: undefined };
  try {
    const formatter = new Intl.DisplayNames([locale], { type: "region" });
    namer = { formatter, unknown: formatter.of("ZZ") };
  } catch {
    namer = { formatter: null, unknown: undefined };
  }
  countryNamers.set(locale, namer);
  return namer;
}

/**
 * Country display name in the rider's language, from the platform's CLDR data,
 * or the uppercased code when the runtime cannot name it.
 *
 * `Intl.DisplayNames` matches only uppercase alpha-2 (or 3-digit) region codes:
 * a lowercase code echoes back unchanged and a longer one throws. CLDR also
 * carries names for codes that are not countries at all — `ZZ` is its "unknown
 * region" sentinel, so a mis-declared country would otherwise read "Unknown
 * Region" — and that label is compared out in favour of the code.
 */
export function countryName(code: string, locale: string): string {
  const region = code.toUpperCase();
  const { formatter, unknown } = countryNamer(locale);
  if (formatter === null) return region;
  try {
    const name = formatter.of(region);
    return name === undefined || name === unknown ? region : name;
  } catch {
    return region;
  }
}

/**
 * Region display name through the active dictionary, or the uppercased code
 * when the declared region has no entry (a new country's regions before their
 * names are translated).
 */
export function regionName(country: string, region: string, t: Translator): string {
  const names: Readonly<Record<string, PlainTranslationKey>> | undefined =
    REGION_KEYS[country.toLowerCase()];
  const key: PlainTranslationKey | undefined = names?.[region.toLowerCase()];
  return key === undefined ? region.toUpperCase() : t(key);
}
