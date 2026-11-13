import type { FeedIdentity } from "./feedIdentity";
import type { AgencyManifest, StaticTopologySource, TransitMode } from "~/agencies/types";
import { DEFAULT_SURFACE_ROUTE_COLOR } from "~/domain/surface/types";

export interface GtfsProjectionConfig {
  readonly id: string;
  readonly routeTypes: ReadonlySet<number>;
  readonly routeIdField: "id" | "short_name";
  readonly defaultColor: string;
  readonly defaultTextColor: string;
  /** Use the defaults above even when the feed publishes route colours. */
  readonly ignoreFeedRouteColors?: boolean;
  readonly sourceAgencyIds?: readonly string[];
  readonly excludedRouteIds?: readonly string[];
  readonly routeShortNames?: Readonly<Record<string, string>>;
  readonly routeDirectionIds?: Readonly<Record<string, 0 | 1>>;
  readonly feedIdentities?: readonly FeedIdentity[];
  readonly vehicleOnlyRoutes?: StaticTopologySource["vehicleOnlyRoutes"];
}

/** Shared projection policy for runtime refreshes and manual seeds. */
export function deriveGtfsProjectionConfig(
  manifest: Pick<AgencyManifest, "id" | "modes" | "routeShortNames">,
  topology: Pick<
    StaticTopologySource,
    | "vehicleOnlyRoutes"
    | "routeIdField"
    | "defaultColor"
    | "defaultTextColor"
    | "ignoreFeedRouteColors"
    | "excludedRouteIds"
    | "sourceAgencyIds"
    | "feeds"
    | "additionalRouteTypes"
    | "routeDirectionIds"
  >,
) {
  return {
    id: manifest.id,
    ...(topology.vehicleOnlyRoutes?.length
      ? { vehicleOnlyRoutes: topology.vehicleOnlyRoutes }
      : {}),
    ...(topology.routeDirectionIds ? { routeDirectionIds: topology.routeDirectionIds } : {}),
    ...(topology.sourceAgencyIds ? { sourceAgencyIds: topology.sourceAgencyIds } : {}),
    ...(topology.excludedRouteIds?.length ? { excludedRouteIds: topology.excludedRouteIds } : {}),
    ...(manifest.routeShortNames ? { routeShortNames: manifest.routeShortNames } : {}),
    ...(topology.feeds?.some((feed) => feed.idNamespace || feed.stripIdPrefixPattern)
      ? {
          feedIdentities: topology.feeds.map((feed) => ({
            ...(feed.idNamespace ? { idNamespace: feed.idNamespace } : {}),
            ...(feed.stripIdPrefixPattern
              ? { stripIdPrefixPattern: feed.stripIdPrefixPattern }
              : {}),
          })),
        }
      : {}),
    routeTypes: new Set([
      ...modesToGtfsRouteTypes(manifest.modes),
      ...(topology.additionalRouteTypes ?? []),
    ]),
    routeIdField: topology.routeIdField ?? "id",
    defaultColor: topology.defaultColor || DEFAULT_SURFACE_ROUTE_COLOR,
    defaultTextColor: topology.defaultTextColor || "#FFFFFF",
    ...(topology.ignoreFeedRouteColors ? { ignoreFeedRouteColors: true } : {}),
  } satisfies GtfsProjectionConfig;
}

/**
 * Maps declared product modes to GTFS `route_type` codes for static seeding.
 * GTFS code 0 covers tram, streetcar, and light rail, so the `rail` mode
 * ingests both heavy rail (2) and light rail (0): ION Light Rail publishes
 * `route_type 0` but is product rail, not streetcar. Agencies declaring
 * `streetcar` keep ingesting 0 exactly as before.
 */
export function modesToGtfsRouteTypes(modes: readonly TransitMode[]): Set<number> {
  const codes: Record<TransitMode, readonly number[]> = {
    subway: [1],
    ferry: [4],
    rail: [0, 2],
    streetcar: [0],
    bus: [3],
    express: [900],
  };
  return new Set(modes.flatMap((mode) => codes[mode]));
}
