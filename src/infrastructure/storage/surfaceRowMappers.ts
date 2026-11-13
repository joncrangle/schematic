import * as Schema from "effect/Schema";
import type { SurfaceStop, SurfaceRoute, SurfaceRouteType } from "~/domain/surface/types";
import { normalizeWheelchairBoarding } from "~/domain/surface/accessibility";
import type { SchematicStationIndexEntry } from "~/agencies/types";
import {
  resolveSchematicStationIdFromFeedId,
  resolveStationNameFromId,
} from "~/domain/stationAlerts";

export interface SqliteRouteRow {
  readonly id: string;
  readonly short_name: string;
  readonly long_name: string;
  readonly route_type: number;
  readonly color: string;
  readonly text_color: string;
}

export interface SqliteStopRow {
  readonly id: string;
  readonly code: string | null;
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
  readonly wheelchair: number;
  readonly parent_station: string | null;
  readonly routes_json: string;
}

export interface SqliteShapeRow {
  readonly id: string;
  readonly route_id: string;
  readonly direction_id: number;
  readonly headsign: string;
  readonly polyline: string;
  readonly min_lat: number;
  readonly max_lat: number;
  readonly min_lon: number;
  readonly max_lon: number;
  readonly point_count: number;
  /**
   * Additive D4 column (nullable until weekly backfill completes). Persisted
   * alongside headsign so a stored row keeps its resolved canonical label even
   * when the raw headsign text no longer parses.
   */
  readonly direction_label?: string | null;
}

/**
 * Single source of truth for GTFS route_type integer codes.
 * Both directions of the string<->int mapping derive from this table;
 * unknown codes parse as "bus" per GTFS convention.
 */
export const ROUTE_TYPE_CODES = {
  streetcar: 0,
  subway: 1,
  ferry: 4,
  rail: 2,
  express: 900,
  bus: 3,
} as const satisfies Record<SurfaceRouteType, number>;

/** Converts GTFS integer route_type to domain SurfaceRouteType. */
export function parseRouteType(code: number | null | undefined): SurfaceRouteType {
  if (code === ROUTE_TYPE_CODES.ferry) return "ferry";
  return code === ROUTE_TYPE_CODES.streetcar
    ? "streetcar"
    : code === ROUTE_TYPE_CODES.subway
      ? "subway"
      : code === ROUTE_TYPE_CODES.rail
        ? "rail"
        : code === ROUTE_TYPE_CODES.express
          ? "express"
          : "bus";
}

/** Converts domain SurfaceRouteType to its GTFS integer route_type. */
export function routeTypeToCode(type: SurfaceRouteType): number {
  return ROUTE_TYPE_CODES[type];
}

const StoredRouteIdsSchema = Schema.Array(Schema.String);

function decodeStoredRouteIds(raw: string): readonly string[] {
  try {
    return Schema.decodeUnknownSync(StoredRouteIdsSchema)(JSON.parse(raw || "[]"));
  } catch {
    return [];
  }
}

/** Deserializes a SQLite stop row into a domain SurfaceStop. */
export function mapRowToStop(
  row: SqliteStopRow,
  stationIndex?: readonly SchematicStationIndexEntry[],
): SurfaceStop {
  const routes = decodeStoredRouteIds(row.routes_json);
  const feedParentStation = row.parent_station?.trim() || undefined;
  const parentStationId = resolveSchematicStationIdFromFeedId(feedParentStation, stationIndex);
  return {
    id: row.id,
    code: row.code ?? row.id,
    name: row.name,
    lat: Number(row.lat),
    lon: Number(row.lon),
    wheelchair: normalizeWheelchairBoarding(row.wheelchair),
    parentStation: feedParentStation
      ? resolveStationNameFromId(feedParentStation, stationIndex)
      : undefined,
    parentStationId,
    routes,
  };
}

/**
 * SQLite `CAST(short_name AS INTEGER)` semantics: leading numeric prefix parsed
 * as integer, otherwise 0, matches D1 `ORDER BY CAST(short_name AS INTEGER),
 * short_name ASC` canonical ordering.
 */
function sqliteCastToInteger(value: string | null | undefined): number {
  if (!value) return 0;
  const trimmed = value.trim();
  if (trimmed === "") return 0;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Canonical route ordering (numeric-aware `short_name`): mirrors D1
 * `ORDER BY CAST(short_name AS INTEGER), short_name ASC` so memory and D1
 * share one comparator. Non-numeric short_names CAST to 0 and sort before
 * numeric entries, with lexical `short_name` as tie-breaker.
 */
export function compareRouteShortNames(a: SurfaceRoute, b: SurfaceRoute): number {
  const intA = sqliteCastToInteger(a.shortName);
  const intB = sqliteCastToInteger(b.shortName);
  if (intA !== intB) return intA - intB;
  if (a.shortName < b.shortName) return -1;
  if (a.shortName > b.shortName) return 1;
  return 0;
}

/** Deserializes a SQLite route row into a domain SurfaceRoute. */
export function mapRowToRoute(row: SqliteRouteRow): SurfaceRoute {
  const routeType = parseRouteType(row.route_type);
  // Express as modifier: YRT Viva and other branded BRT are GTFS
  // route_type 3 but name-contains-express. Keep stored `routeType` for
  // legacy 900 rows, but also set modifier flag for generic `isExpressRoute`.
  const isExpressByName =
    /express/i.test(row.short_name ?? "") || /express/i.test(row.long_name ?? "");
  const isExpress = routeType === "express" || isExpressByName;
  return {
    id: row.id,
    shortName: row.short_name,
    longName: row.long_name,
    routeType,
    color: row.color,
    textColor: row.text_color,
    ...(isExpress ? { isExpress: true as const } : {}),
  };
}
