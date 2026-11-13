import type { RouteInterpretationConfig } from "~/agencies/types";
import type {
  BoundingBox,
  RouteDetails,
  RouteShape,
  SurfaceRoute,
  SurfaceStop,
} from "~/domain/surface/types";
import { DEFAULT_SURFACE_ROUTE_COLOR, inferRouteType } from "~/domain/surface/types";
import { isNorthSouthDirectionIdsInverted, resolveDirectionId } from "~/domain/surface/direction";

/**
 * Pure NextBus routeConfig grammar (C01).
 *
 * Owns the shared NextBus JSON → RouteDetails parsing that was duplicated
 * across the live fetcher and the topology crawl. Both call sites invoke
 * this pure function after fetching; no fetch, no Effect, no I/O here.
 *
 * Failure is honest: retryable in-band errors throw, non-retryable or missing
 * route returns empty maps. Threaded fallbackBounds replaces the former
 * hardcoded Toronto viewport literals.
 */

export interface NextBusInBandError {
  readonly retryable: boolean;
  readonly content: string;
}

/**
 * Classifies NextBus publicJSONFeed in-band error payloads: HTTP 200 whose
 * body is `{"Error":{"shouldRetry","content"}}` instead of the expected
 * command shape. Unified here so both adapters share one policy.
 */
export function classifyNextBusInBandError(payload: unknown): NextBusInBandError | undefined {
  const err = (payload as { Error?: { shouldRetry?: string; content?: string } } | null)?.Error;
  if (!err) return undefined;
  return { retryable: err.shouldRetry === "true", content: err.content ?? "" };
}

export interface ParseNextBusRouteConfigContext {
  readonly routeId: string;
  readonly fallbackBounds: BoundingBox;
  readonly routeInterpretation?: RouteInterpretationConfig;
  readonly defaultRouteColor?: string;
}

export function parseNextBusRouteConfigJson(
  payload: unknown,
  ctx: ParseNextBusRouteConfigContext,
): { detailsByDir: Map<number, RouteDetails>; allStops: SurfaceStop[] } {
  const { routeId, fallbackBounds, routeInterpretation } = ctx;

  const inBandError = classifyNextBusInBandError(payload);
  if (inBandError?.retryable) {
    throw new Error(`NextBus routeConfig: ${inBandError.content}`);
  }
  const routeData = (payload as { route?: RawRoute })?.route;
  if (!routeData) {
    return { detailsByDir: new Map<number, RouteDetails>(), allStops: [] as SurfaceStop[] };
  }

  const routeType = inferRouteType(routeId, routeInterpretation);
  const titleParts = (routeData.title || "").split("-");
  const shortName = titleParts[0]?.trim() || routeId;
  const longName = titleParts.slice(1).join("-").trim() || routeData.title || routeId;

  const surfaceRoute: SurfaceRoute = {
    id: routeId,
    shortName,
    longName,
    routeType,
    color: routeData.color
      ? `#${routeData.color}`
      : (ctx.defaultRouteColor ?? DEFAULT_SURFACE_ROUTE_COLOR),
    textColor: routeData.oppositeColor ? `#${routeData.oppositeColor}` : "#FFFFFF",
  };

  const rawStops = routeData.stop ?? [];
  const stopMapByTag = new Map<string, SurfaceStop>();
  const allStops: SurfaceStop[] = [];
  for (const st of rawStops) {
    const stopId = st.stopId ?? st.tag;
    const stop: SurfaceStop = {
      id: stopId,
      code: st.stopId,
      name: st.title,
      lat: parseFloat(st.lat),
      lon: parseFloat(st.lon),
      wheelchair: 1,
      routes: [routeId],
    };
    stopMapByTag.set(st.tag, stop);
    allStops.push(stop);
  }

  const rawDirections = Array.isArray(routeData.direction)
    ? routeData.direction
    : routeData.direction
      ? [routeData.direction]
      : [];

  const candidatesByDir = new Map<
    number,
    Array<{
      dir: RawDirection;
      dirIndex: number;
      stops: SurfaceStop[];
      isUI: boolean;
      isShortTurn: boolean;
    }>
  >();

  for (let idx = 0; idx < rawDirections.length; idx++) {
    const dir = rawDirections[idx];
    const dirIndex = resolveDirectionId(
      dir.tag,
      `${dir.title || ""} ${dir.name || ""}`,
      idx === 0 ? 0 : 1,
      { invertNorthSouth: isNorthSouthDirectionIdsInverted(routeId, routeInterpretation) },
    );
    const dirStopsRaw = Array.isArray(dir.stop) ? dir.stop : dir.stop ? [dir.stop] : [];
    const dirStops: SurfaceStop[] = [];
    for (const sRef of dirStopsRaw) {
      const matched = stopMapByTag.get(sRef.tag);
      if (matched) dirStops.push(matched);
    }
    const isUI = dir.useForUI === "true";
    const isShortTurn = (dir.title || "").toLowerCase().includes("short turn");
    const list = candidatesByDir.get(dirIndex) || [];
    list.push({ dir, dirIndex, stops: dirStops, isUI, isShortTurn });
    candidatesByDir.set(dirIndex, list);
  }

  const detailsByDir = new Map<number, RouteDetails>();
  for (const dirIndex of [0, 1] as const) {
    const candidates = candidatesByDir.get(dirIndex) || [];
    candidates.sort((a, b) => {
      if (a.isUI !== b.isUI) return a.isUI ? -1 : 1;
      if (a.isShortTurn !== b.isShortTurn) return a.isShortTurn ? 1 : -1;
      return b.stops.length - a.stops.length;
    });
    const chosen = candidates[0];
    if (chosen) {
      const dir = chosen.dir;
      const dirStops = chosen.stops;
      const shape: RouteShape = {
        id: `${routeId}_${dirIndex}_live`,
        routeId,
        directionId: dirIndex,
        headsign: dir.title || `${dir.name} towards ${dirStops[dirStops.length - 1]?.name || ""}`,
        polyline: "",
        minLat: routeData.latMin ? parseFloat(routeData.latMin) : fallbackBounds.minLat,
        maxLat: routeData.latMax ? parseFloat(routeData.latMax) : fallbackBounds.maxLat,
        minLon: routeData.lonMin ? parseFloat(routeData.lonMin) : fallbackBounds.minLon,
        maxLon: routeData.lonMax ? parseFloat(routeData.lonMax) : fallbackBounds.maxLon,
        pointCount: dirStops.length,
      };
      detailsByDir.set(dirIndex, { route: surfaceRoute, shape, stops: dirStops });
    }
  }

  return { detailsByDir, allStops };
}

type RawDirection = {
  tag: string;
  title: string;
  name: string;
  useForUI?: string;
  stop: readonly { tag: string }[] | { tag: string };
};

type RawRoute = {
  tag: string;
  title: string;
  color?: string;
  oppositeColor?: string;
  latMin?: string;
  latMax?: string;
  lonMin?: string;
  lonMax?: string;
  stop?: readonly {
    tag: string;
    title: string;
    lat: string;
    lon: string;
    stopId?: string;
  }[];
  direction?: readonly RawDirection[] | RawDirection;
};
