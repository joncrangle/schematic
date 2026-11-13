import type { AgencyManifest } from "~/agencies/types";
import { lookupLocaleTag } from "~/domain/locale";

export function resolveServiceArea(
  manifest: Pick<AgencyManifest, "serviceArea" | "serviceAreaTranslations">,
  locale: string,
): string | undefined {
  const translations = manifest.serviceAreaTranslations ?? {};
  const key = lookupLocaleTag(locale, Object.keys(translations));
  return (key === undefined ? undefined : translations[key]) ?? manifest.serviceArea;
}
