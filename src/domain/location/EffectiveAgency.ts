/**
 * Pure EffectiveAgency resolution.
 *
 * This is the domain-owned seam for Location Ladder → agency selection →
 * coveringIds. The stateful store adapter remains in services and consumes
 * these functions; this module has no service or browser lifecycle dependency.
 */

import type { AgencyManifest, AgencyProvider } from "~/agencies";
import { rankAgenciesForPoint } from "~/domain/agencyCoverage";
import type { CoverageAgency, CoverageBound } from "~/domain/agencyCoverage";
import type { Coordinates, GeolocationStatus } from "~/domain/location/locationLadder";
import type { LocationSource } from "~/lib/location-source";
import type { AgencySelection } from "~/domain/preferences/UserPreferences";

export interface EffectiveAgencySnapshot {
  readonly fix: Coordinates | null;
  readonly source: LocationSource;
  readonly status: GeolocationStatus;
  /** The Automatic winner, or undefined when location cannot resolve a network. */
  readonly automaticAgencyId: string | undefined;
  readonly agencyId: string | undefined;
  /** Declared-bound matches only; excludes explicit development spoof overrides. */
  readonly declaredCoveringIds: readonly string[];
  readonly coveringIds: readonly string[];
  readonly stationCoveringIds: readonly string[];
}

/**
 * The resolver only needs agency identity, coverage, and an optional station
 * capability. Keeping this narrower than AgencyProvider lets the browser
 * projection use the same pure policy without acquiring server ports.
 */
type AgencyResolutionProvider = Pick<AgencyProvider, "manifest"> &
  Partial<Pick<AgencyProvider, "createStationsSource">>;

/** The only conversion from a ladder fix to an agency-resolution point. */
export function effectivePoint(
  fix: Coordinates | null,
  source: LocationSource,
): { lat: number; lon: number } | undefined {
  if (source === "default" || !fix) return undefined;
  return { lat: fix.latitude, lon: fix.longitude };
}

interface UnionBounds {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

function unionOfBounds(manifest: AgencyManifest): UnionBounds {
  const bounds = manifest.bounds;
  if (bounds.length === 0) {
    throw new Error(
      `Agency "${manifest.id}" declares no service bounds; cannot derive operational defaults`,
    );
  }
  return bounds.reduce(
    (union, bound) => ({
      minLat: Math.min(union.minLat, bound.minLat),
      maxLat: Math.max(union.maxLat, bound.maxLat),
      minLon: Math.min(union.minLon, bound.minLon),
      maxLon: Math.max(union.maxLon, bound.maxLon),
    }),
    { ...bounds[0] },
  );
}

/** Declared operational focus, otherwise the centre of the bounds union. */
export function manifestFocus(manifest: AgencyManifest): { lat: number; lon: number } {
  if (manifest.focus) return manifest.focus;
  const union = unionOfBounds(manifest);
  return {
    lat: (union.minLat + union.maxLat) / 2,
    lon: (union.minLon + union.maxLon) / 2,
  };
}

/** The union of declared bounds used by generic fallback viewport consumers. */
export function manifestFallbackBounds(manifest: AgencyManifest): UnionBounds {
  return unionOfBounds(manifest);
}

export interface ResolveEffectiveAgencyInput {
  /** Effective position after default-filter; undefined means no real fix. */
  readonly point?: { lat: number; lon: number } | null;
  /** Full fix for snapshot echo; when omitted, synthesized from point. */
  readonly fix?: Coordinates | null;
  readonly selection: AgencySelection;
  /** Previous Automatic winner, kept separately from a manual selection. */
  readonly previousAutomatic?: string | AgencyResolutionProvider | null;
  readonly locationState: { status: GeolocationStatus; source: LocationSource };
  /** Provider and capability seams are injected by registry/store adapters. */
  readonly providers: readonly AgencyResolutionProvider[];
  readonly hasStationsSource?: (id: string) => boolean;
}

function previousIdOf(previous?: string | AgencyResolutionProvider | null): string | undefined {
  if (!previous) return undefined;
  if (typeof previous === "string") return previous;
  return previous.manifest?.id;
}

function hasStationsSourceFor(providers: readonly AgencyResolutionProvider[], id: string): boolean {
  const provider = providers.find((candidate) => candidate.manifest.id === id);
  return (
    Boolean(provider?.manifest.stationService) ||
    typeof provider?.createStationsSource === "function"
  );
}

function toCoverageInputs(providers: readonly AgencyResolutionProvider[]): CoverageAgency[] {
  return providers.map((provider) => ({
    id: provider.manifest.id,
    bounds: (provider.manifest.bounds ?? []) as readonly CoverageBound[],
  }));
}

function rankedCoveringIds(
  point: { lat: number; lon: number },
  providers: readonly AgencyResolutionProvider[],
): readonly string[] {
  return rankAgenciesForPoint(toCoverageInputs(providers), point.lat, point.lon);
}

function resolveAutoAgency(
  point: { lat: number; lon: number } | undefined,
  previousId: string | undefined,
  locationState: { status: GeolocationStatus; source: LocationSource },
  providers: readonly AgencyResolutionProvider[],
  spoofedAgencyId?: string,
): string | undefined {
  if (locationState.source === "dev-spoof" && spoofedAgencyId) {
    if (providers.some((p) => p.manifest.id === spoofedAgencyId)) {
      return spoofedAgencyId;
    }
  }
  const expiredHold = locationState.status === "expired" && locationState.source !== "dev-spoof";
  if (
    previousId &&
    providers.some((p) => p.manifest.id === previousId) &&
    (expiredHold || !point)
  ) {
    return previousId;
  }
  if (point) {
    const ranked = rankedCoveringIds(point, providers);
    if (ranked.length > 0) {
      return (
        ranked.find((id) => {
          const scope = providers.find((provider) => provider.manifest.id === id)?.manifest.scope;
          return scope === undefined || scope === "regional";
        }) ?? ranked[0]
      );
    }
  }
  return undefined;
}

/** Whether any agency's declared bounds contain the point (without fallback). */
export function isPointCovered(
  point: { lat: number; lon: number },
  providers: readonly AgencyResolutionProvider[],
): boolean {
  return providers.some((provider) =>
    (provider.manifest.bounds ?? []).some(
      (bound) =>
        point.lat >= bound.minLat &&
        point.lat <= bound.maxLat &&
        point.lon >= bound.minLon &&
        point.lon <= bound.maxLon,
    ),
  );
}

/**
 * Resolves the effective agency and all fan-out sets from one location state.
 * No caller recomputes coveringIds.
 */
export function resolveEffectiveAgency(
  input: ResolveEffectiveAgencyInput,
): EffectiveAgencySnapshot {
  const providers = input.providers;
  const hasStationsSource =
    input.hasStationsSource ?? ((id: string) => hasStationsSourceFor(providers, id));
  const point = input.point ?? undefined;
  const { status, source } = input.locationState;

  const automaticAgencyId = resolveAutoAgency(
    point,
    previousIdOf(input.previousAutomatic),
    input.locationState,
    providers,
    input.fix?.agencyId,
  );

  let agencyId: string | undefined;
  if (input.selection !== "auto") {
    const pinned = providers.find((provider) => provider.manifest.id === input.selection);
    agencyId = pinned ? pinned.manifest.id : automaticAgencyId;
  } else {
    agencyId = automaticAgencyId;
  }

  const declaredCoveringIds = point ? rankedCoveringIds(point, providers) : [];
  // Query coverage is declared bounds only, independent of manual selection or session hold.
  let coveringIds: readonly string[] = declaredCoveringIds;
  if (
    input.locationState.source === "dev-spoof" &&
    input.fix?.agencyId &&
    providers.some((p) => p.manifest.id === input.fix!.agencyId)
  ) {
    coveringIds = [input.fix.agencyId, ...coveringIds.filter((id) => id !== input.fix!.agencyId)];
  }
  const stationCoveringIds = coveringIds.filter((id) => hasStationsSource(id));

  const fix =
    input.fix !== undefined
      ? input.fix
      : point
        ? { latitude: point.lat, longitude: point.lon, timestamp: 0 }
        : null;

  return {
    fix,
    source,
    status,
    automaticAgencyId,
    agencyId,
    declaredCoveringIds,
    coveringIds,
    stationCoveringIds,
  };
}
