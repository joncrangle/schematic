import countriesUrl from "./generated/countries.json?url";
import type { CoverageGeography } from "./generated/geography";

type CoverageCountries = Readonly<Record<string, CoverageGeography>>;
let countries: Promise<CoverageCountries> | undefined;

/** Share the versioned asset across overlay opens, while allowing failed downloads to retry. */
export function loadCoverageCountries(): Promise<CoverageCountries> {
  return (countries ??= fetch(countriesUrl)
    .then((response) => {
      if (!response.ok) throw new Error(`Coverage countries download failed: ${response.status}`);
      return response.json() as Promise<CoverageCountries>;
    })
    .catch((error) => {
      countries = undefined;
      throw error;
    }));
}
