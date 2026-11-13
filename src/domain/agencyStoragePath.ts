import type { AgencyManifest } from "~/agencies/types";

/** Canonical scope path used to group and select agency seed configurations. */
export function agencyStoragePath(manifest: AgencyManifest): string {
  const scope = manifest.scope ?? "regional";
  if (scope === "international") return `intl/${manifest.id}`;

  const country = manifest.jurisdiction?.country?.toLowerCase();
  if (!country) return manifest.id;
  const region = manifest.jurisdiction?.region?.toLowerCase();
  // A non-local operator confined to one region lives under that region.
  if (scope === "national" && !region) return `${country}/nat/${manifest.id}`;

  return region ? `${country}/${region}/${manifest.id}` : `${country}/${manifest.id}`;
}
