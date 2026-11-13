import {
  MAX_ROUTES_METADATA_IDS,
  type GetNearbyTransitInput,
  type NearbyRouteArrival,
  type RouteTrackingData,
  type SurfaceRouteType,
} from "~/domain/surface/types";
import {
  finiteNumberOrUndefined,
  parseNearbyRpcInput,
  parseOptionalUiLocale,
  requireAgencyId,
} from "~/services/nearby/rpcInput";
import type { UiLocale } from "~/domain/locale";
import {
  handleFetchNearbyTransit,
  handleFetchRouteTracking,
  handleFetchRoutesMetadata,
  handleFetchSavedTransit,
} from "./SurfaceServer";

const MAX_FAVOURITE_ROUTES = 100;

export interface GetRouteTrackingInput {
  readonly agencyId: string;
  readonly routeId: string;
  readonly directionId?: number;
  readonly locale?: unknown;
}

export interface GetSavedTransitInput {
  readonly agencyId: string;
  readonly favouriteRoutes: readonly string[];
  readonly lat?: number;
  readonly lon?: number;
  readonly locale?: unknown;
}

export interface ParsedSavedTransitInput {
  readonly agencyId: string;
  readonly favouriteRoutes: readonly string[];
  readonly lat?: number;
  readonly lon?: number;
  readonly locale?: UiLocale;
}

export function parseSavedTransitInput(input: GetSavedTransitInput): ParsedSavedTransitInput {
  if (Array.isArray(input.favouriteRoutes) && input.favouriteRoutes.length > MAX_FAVOURITE_ROUTES) {
    throw new Error(`favouriteRoutes must contain at most ${MAX_FAVOURITE_ROUTES} routes`);
  }
  const locale = parseOptionalUiLocale(input.locale);
  return {
    agencyId: requireAgencyId(input.agencyId),
    favouriteRoutes: Array.isArray(input.favouriteRoutes) ? input.favouriteRoutes.map(String) : [],
    lat: finiteNumberOrUndefined(input.lat),
    lon: finiteNumberOrUndefined(input.lon),
    ...(locale === undefined ? {} : { locale }),
  };
}

export interface ParsedRouteTrackingInput {
  readonly agencyId: string;
  readonly routeId: string;
  readonly directionId: number;
  readonly locale?: UiLocale;
}

export function parseRouteTrackingInput(input: GetRouteTrackingInput): ParsedRouteTrackingInput {
  const agencyId = requireAgencyId(input.agencyId);
  if (!input.routeId || typeof input.routeId !== "string") {
    throw new Error("Missing or invalid routeId parameter");
  }
  // Seeded topology only ever stores GTFS direction 0 or 1.
  const rawDirectionId: unknown = input.directionId;
  const directionId =
    rawDirectionId === undefined
      ? 0
      : rawDirectionId === 0 || rawDirectionId === "0"
        ? 0
        : rawDirectionId === 1 || rawDirectionId === "1"
          ? 1
          : undefined;
  if (directionId === undefined) {
    throw new Error("Missing or invalid directionId parameter");
  }

  const locale = parseOptionalUiLocale(input.locale);
  return {
    agencyId,
    routeId: input.routeId,
    directionId,
    ...(locale === undefined ? {} : { locale }),
  };
}

// ---------------------------------------------------------------------------
// Server-function wrappers.
//
// The implementations live server-only in SurfaceServer. Each wrapper below
// is a thin "use server" boundary that validates caller-controlled input
// inside the server body and delegates. Every argument is treated as
// untrusted. Validation and authorization happen in the body.
// Wrappers never catch on behalf of the client. A downstream failure
// rejects so TanStack Query surfaces real errors.
// ---------------------------------------------------------------------------

/**
 * Production server function for fetching nearby transit routes, arrival predictions, and active alerts.
 * Executes server-side with proximity calculations to keep static GTFS off client bundles.
 */
export async function fetchNearbyTransit(
  data: GetNearbyTransitInput & { agencyId?: string; locale?: unknown },
): Promise<readonly NearbyRouteArrival[]> {
  "use server";
  return handleFetchNearbyTransit(parseNearbyRpcInput(data));
}

/**
 * Production server function for fetching arrival predictions for saved stops and favourite routes.
 */
export async function fetchSavedTransit(
  data: GetSavedTransitInput,
): Promise<readonly NearbyRouteArrival[]> {
  "use server";
  return handleFetchSavedTransit(parseSavedTransitInput(data));
}

/**
 * Production server function for fetching combined route tracking topology and live vehicle positions.
 */
export async function fetchRouteTracking(
  data: GetRouteTrackingInput,
): Promise<RouteTrackingData | null> {
  "use server";
  return handleFetchRouteTracking(parseRouteTrackingInput(data));
}

export interface RouteMeta {
  readonly id: string;
  readonly shortName: string;
  readonly longName: string;
  readonly routeType: SurfaceRouteType;
}

export interface GetRoutesMetadataInput {
  readonly agencyId: string;
  readonly routeIds?: readonly string[];
}

export interface ParsedRoutesMetadataInput {
  readonly agencyId: string;
  readonly routeIds: readonly string[];
}

export function parseRoutesMetadataInput(input: GetRoutesMetadataInput): ParsedRoutesMetadataInput {
  const routeIds = Array.isArray(input.routeIds)
    ? [...new Set(input.routeIds.map((id) => String(id).trim()).filter(Boolean))]
    : [];
  if (routeIds.length > MAX_ROUTES_METADATA_IDS) {
    throw new Error(`routeIds must contain at most ${MAX_ROUTES_METADATA_IDS} routes`);
  }
  return { agencyId: requireAgencyId(input.agencyId), routeIds };
}

/**
 * Production server function for fetching static route metadata from the GTFS database.
 */
export async function fetchRoutesMetadata(
  data: GetRoutesMetadataInput,
): Promise<readonly RouteMeta[]> {
  "use server";
  return handleFetchRoutesMetadata(parseRoutesMetadataInput(data));
}

function isRouteMeta(value: unknown): value is RouteMeta {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.shortName === "string" &&
    typeof record.longName === "string" &&
    typeof record.routeType === "string"
  );
}

/**
 * Stable catalog fetch over the portable HTTP endpoint.
 *
 * The `RouteMeta[]` response is reached through
 * `GET /api/routes-catalog/:agencyId` so the edge/browser cache absorbs it:
 * the catalog is static between crawls and shared across users, and the
 * server-function POST path can never be cached. Non-2xx responses reject
 * so the query surfaces real errors.
 */
export async function fetchAllRoutesCatalogViaHttp(
  agencyId: string,
  fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = globalThis.fetch,
): Promise<readonly RouteMeta[]> {
  const response = await fetchFn(`/api/routes-catalog/${encodeURIComponent(agencyId)}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Routes catalog request failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }
  const json: unknown = await response.json();
  if (!Array.isArray(json) || !json.every(isRouteMeta)) {
    throw new Error("Routes catalog response was not a RouteMeta array");
  }
  return json;
}
