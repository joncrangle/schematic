/**
 * Explicit registry: no runtime fs scanning (impossible on Workers).
 * Size-optimized bbox selection for the agency picker.
 */
import type { AgencyProvider } from "./types";
import { validateProvider } from "./validateProvider";
import { createAgencyProvider } from "./createAgencyProvider";
import { agencyCatalog } from "./agencyCatalog";
import {
  isPointCovered as isPointCoveredByProviders,
  resolveEffectiveAgency,
  type EffectiveAgencySnapshot,
  type ResolveEffectiveAgencyInput,
} from "~/domain/location/EffectiveAgency";
export { interchanges } from "./interchanges";
export type { InterchangeHub, InterchangeEndpoint } from "~/domain/map/Interchange";

const baselineProviders: readonly AgencyProvider[] = Object.freeze(
  agencyCatalog.map((definition) => createAgencyProvider(definition)),
);
const mutableProviders: AgencyProvider[] = [...baselineProviders];

// Fail-fast registration validation: a malformed
// provider throws at module load, so dev, CI, and prod startup all refuse to
// boot with an agency that violates its Effect Schema contract.
for (const provider of baselineProviders) {
  validateProvider(provider);
}

export function dangerouslyRegisterProvider(provider: AgencyProvider): void {
  validateProvider(provider);
  if (!mutableProviders.some((p) => p.manifest.id === provider.manifest.id)) {
    mutableProviders.push(provider);
  }
}

export function dangerouslyResetProviders(): void {
  mutableProviders.splice(0, mutableProviders.length, ...baselineProviders);
}

export function allProviders(): readonly AgencyProvider[] {
  return mutableProviders;
}

export function getAgencyById(id: string): AgencyProvider | undefined {
  return mutableProviders.find((p) => p.manifest.id === id);
}

type RegisteredResolutionInput = Omit<ResolveEffectiveAgencyInput, "providers">;

function resolveRegisteredAgency(input: RegisteredResolutionInput): {
  readonly providers: readonly AgencyProvider[];
  readonly snapshot: EffectiveAgencySnapshot;
} {
  const registeredProviders = allProviders();
  return {
    providers: registeredProviders,
    snapshot: resolveEffectiveAgency({ ...input, providers: registeredProviders }),
  };
}

/** Point resolution adapter for app-shell callers using the registered agencies. */
export function resolveAgencyAtPoint(point: { lat: number; lon: number }): EffectiveAgencySnapshot {
  return resolveRegisteredAgency({
    point,
    selection: "auto",
    locationState: { status: "granted", source: "gps" },
  }).snapshot;
}

/** Honest declared-bounds check for app-shell callers using the registered agencies. */
export function isPointCovered(point: { lat: number; lon: number }): boolean {
  return isPointCoveredByProviders(point, allProviders());
}

/**
 * Smallest-bounding-box-wins selection for the agency picker.
 * Ranking policy lives in core (`rankAgenciesForPoint`); this adapter
 * only maps declared coverage IDs into providers.
 */
export function getAgenciesForPoint(lat: number, lon: number): readonly AgencyProvider[] {
  const resolved = resolveRegisteredAgency({
    point: { lat, lon },
    selection: "auto",
    locationState: { status: "granted", source: "gps" },
  });
  return resolved.snapshot.coveringIds
    .map((id) => resolved.providers.find((p) => p.manifest.id === id))
    .filter((p): p is AgencyProvider => p !== undefined);
}

/** Legacy operational default for server callers; point resolution never invents coverage. */
export function getActiveAgency(): AgencyProvider;
export function getActiveAgency(
  point: { lat: number; lon: number } | undefined,
): AgencyProvider | undefined;
export function getActiveAgency(point?: { lat: number; lon: number }): AgencyProvider | undefined {
  if (arguments.length > 0) {
    if (!point) return undefined;
    const id = resolveAgencyAtPoint(point).automaticAgencyId;
    return id ? getAgencyById(id) : undefined;
  }
  const active =
    mutableProviders.find((p) => p.manifest.status === "active") ?? mutableProviders[0];
  if (!active) throw new Error("No agency providers registered");
  return active;
}
