import type { TripTerminal, TripRoute } from "~/domain/surface/boarding";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { D1DatabaseBinding } from "../RuntimeBindings";
import type { RouteInterpretationConfig, SchematicStationIndexEntry } from "~/agencies/types";
import { bboxFor, clampProximityRadius } from "~/domain/proximity";
import {
  buildDirectionLabels,
  getRouteDirectionsForRoute,
  type GeneratedDirectionLabel,
} from "~/domain/surface/direction";
import type { RouteDetails, SurfaceRoute, SurfaceStop } from "~/domain/surface/types";
import type { RouteTopology, StaticSnapshot } from "~/domain/surface/topologySource";
import {
  compareRouteShortNames,
  mapRowToRoute,
  mapRowToStop,
  type SqliteRouteRow,
  type SqliteShapeRow,
  type SqliteStopRow,
} from "../surfaceRowMappers";
import { ensureSurfaceSchema } from "./schema";

/**
 * Surface store shared D1 read path.
 *
 * Single home for every cached SQL read the D1 adapter and the topology
 * reader used to duplicate: nearby candidates, cached route details, route
 * rows, stops-for-routes / stops-by-ids, and full snapshot materialization.
 * SQL, ordering (CAST numeric-aware, stop_sequence ASC, input-order restore,
 * json_each membership), and bbox threading are verbatim from the two
 * mirrors so D1-vs-memory equivalence holds by construction.
 *
 * Label authority is C1 Direction: every directionLabel derives from
 * `buildDirectionLabels` (headsign parse + canonical fallback). The
 * per-row `resolveDirectionLabel` fallback (canonical literal only, compass
 * words lost) is gone, topology assembles one details map per route before
 * labeling so both directions resolve from the same facts.
 */

export interface D1ReadsOptions {
  readonly agencyId?: string;
  readonly stationIndex?: readonly SchematicStationIndexEntry[];
  readonly routeInterpretation?: RouteInterpretationConfig;
}

/** Labels for every direction of one route from a single shared facts map. */
export function labelsForRoute(
  shapes: readonly {
    readonly directionId: number;
    readonly headsign: string;
    /** Encoded shape geometry, the second of the three label sources. */
    readonly polyline?: string;
  }[],
  routeShortName?: string,
): Record<
  number,
  { label: string; destination: string; generatedLabel?: GeneratedDirectionLabel }
> {
  return buildDirectionLabels(
    new Map(
      shapes.map(
        (s) => [s.directionId, { shape: { headsign: s.headsign, polyline: s.polyline } }] as const,
      ),
    ),
    routeShortName,
  );
}

function toRouteDetails(
  routeRow: SqliteRouteRow,
  shapeRow: SqliteShapeRow,
  stopRows: readonly SqliteStopRow[],
  stationIndex?: readonly SchematicStationIndexEntry[],
  routeInterpretation?: RouteInterpretationConfig,
): RouteDetails {
  const route = mapRowToRoute(routeRow);
  const stops = stopRows.map((row) => mapRowToStop(row, stationIndex));
  // Shared facts map: cached details resolve through the same
  // shared-map seam the snapshot uses.
  const directionId = Number(shapeRow.direction_id);
  const labels = labelsForRoute(
    [
      {
        directionId,
        headsign: String(shapeRow.headsign ?? ""),
        polyline: shapeRow.polyline,
      },
    ],
    route.shortName,
  );
  const canonicalDirections = getRouteDirectionsForRoute(
    route.routeType,
    route.id,
    routeInterpretation,
  );
  const fallbackLabel =
    canonicalDirections.find((d) => d.directionId === directionId)?.label ??
    canonicalDirections[0].label;
  const directionLabel =
    shapeRow.direction_label && shapeRow.direction_label.trim() !== ""
      ? shapeRow.direction_label.trim()
      : (labels[directionId]?.label ?? fallbackLabel);
  return {
    route,
    shape: {
      id: shapeRow.id,
      routeId: shapeRow.route_id,
      directionId,
      headsign: shapeRow.headsign,
      polyline: shapeRow.polyline,
      minLat: Number(shapeRow.min_lat),
      maxLat: Number(shapeRow.max_lat),
      minLon: Number(shapeRow.min_lon),
      maxLon: Number(shapeRow.max_lon),
      pointCount: shapeRow.point_count,
      directionLabel,
    },
    stops,
  };
}

/** Shared D1 read capabilities consumed by the read policy and the topology reader. */
export function makeD1Reads(db: D1DatabaseBinding, opts?: D1ReadsOptions) {
  const stationIndex = opts?.stationIndex;
  const routeInterpretation = opts?.routeInterpretation;
  const agencyId = opts?.agencyId ?? "ttc";

  const readNearbyCandidates = (lat: number, lon: number, radiusMeters: number) =>
    Effect.tryPromise(async () => {
      await ensureSurfaceSchema(db);
      // Clamp inside the shared read path: the kernel's
      // findNearbyStops is the primary entry and already passes an effective
      // radius, but direct readers must not bypass the 1.5 km ceiling.
      const effectiveRadius = clampProximityRadius(radiusMeters);
      const box = bboxFor(lat, lon, effectiveRadius);

      const agencyFilter = opts?.agencyId ? "AND agency_id = ?" : "";
      const query = `
            SELECT id, code, name, lat, lon, wheelchair, parent_station, routes_json
            FROM stops
            WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? ${agencyFilter}
          `;
      const params = opts?.agencyId
        ? [box.minLat, box.maxLat, box.minLon, box.maxLon, agencyId]
        : [box.minLat, box.maxLat, box.minLon, box.maxLon];
      const stmt = db.prepare(query).bind(...params);
      const res = await stmt.all<SqliteStopRow>();
      return (res.results || []).map((row) => mapRowToStop(row, stationIndex));
    });

  /**
   * Every direction id a route declares, ascending. Callers must enumerate
   * rather than assume 0/1: a feed that publishes no `direction_id` files every
   * trip under 0, and a multi-archive agency can declare a group per direction
   * the operator states rather than per terminal.
   */
  const readRouteDirectionIds = (routeId: string) =>
    Effect.tryPromise(async () => {
      await ensureSurfaceSchema(db);
      const res = await db
        .prepare(
          "SELECT DISTINCT direction_id FROM route_shapes WHERE agency_id = ? AND route_id = ? ORDER BY direction_id ASC",
        )
        .bind(agencyId, routeId)
        .all<{ direction_id: number | string }>();
      return (res.results ?? []).map((row) => Number(row.direction_id));
    });

  /**
   * Map each trip id to the direction group the seeder filed it under.
   *
   * The join that attributes a realtime departure to a group. Static GTFS
   * declares the group per trip and the realtime feed names the trip, so this
   * resolves direction even for feeds that publish no `direction_id` at all.
   * Trips absent from the map are simply not in the table (added trips, or a
   * feed whose ids do not match static) and the caller falls back.
   *
   * The table stores one row per group with that group's trip ids as a JSON
   * array, so the join expands the arrays rather than matching one row per
   * trip. `json_each` does the expansion and the membership test inside SQLite,
   * which keeps the response proportional to the trips actually asked about
   * instead of shipping every trip id on the route (GO's UP route alone is
   * ~28k) to filter on the client.
   *
   * The requested ids are bound as a single JSON array parameter rather than as
   * one placeholder each. That keeps the statement at three bound parameters
   * for any number of trips, so it cannot approach D1's 100 bound-parameter
   * ceiling no matter how many predictions a stop carries. The route filter is
   * the primary key's leading prefix, so this stays a single indexed range scan
   * over one route's groups.
   */
  const readDirectionsForTrips = (routeId: string, tripIds: readonly string[]) =>
    Effect.tryPromise(async () => {
      if (tripIds.length === 0) return new Map<string, number>();
      await ensureSurfaceSchema(db);
      const directions = new Map<string, number>();
      const res = await db
        .prepare(
          `SELECT j.value AS trip_id, r.direction_id AS direction_id
             FROM route_direction_trips r, json_each(r.trip_ids) j
            WHERE r.agency_id = ? AND r.route_id = ?
              AND j.value IN (SELECT value FROM json_each(?))`,
        )
        .bind(agencyId, routeId, JSON.stringify(tripIds))
        .all<{ trip_id: string; direction_id: number | string }>();
      for (const row of res.results ?? []) directions.set(row.trip_id, Number(row.direction_id));
      return directions;
    });

  const readRoutesForTrips = (tripIds: readonly string[]) =>
    Effect.tryPromise(async () => {
      const routes = new Map<string, TripRoute>();
      if (tripIds.length === 0) return routes;
      await ensureSurfaceSchema(db);
      const result = await db
        .prepare(`SELECT j.value AS trip_id, r.route_id, r.direction_id
        FROM route_direction_trips r, json_each(r.trip_ids) j
        WHERE r.agency_id = ? AND j.value IN (SELECT value FROM json_each(?))`)
        .bind(agencyId, JSON.stringify(tripIds))
        .all<{ trip_id: string; route_id: string; direction_id: number }>();
      for (const row of result.results ?? [])
        routes.set(row.trip_id, { routeId: row.route_id, directionId: Number(row.direction_id) });
      return routes;
    });

  const readTripTerminals = (routeId: string, tripIds: readonly string[]) =>
    Effect.tryPromise(async () => {
      const terminals = new Map<string, TripTerminal>();
      if (tripIds.length === 0) return terminals;
      await ensureSurfaceSchema(db);
      const res = await db
        .prepare(`WITH wanted AS (SELECT value AS trip_id FROM json_each(?)),
        ends AS (SELECT j.value AS trip_id, r.terminal_stop_id, r.terminal_stop_sequence
          FROM route_trip_terminals r, json_each(r.trip_ids) j
          WHERE r.agency_id = ? AND r.route_id = ? AND j.value IN (SELECT trip_id FROM wanted)),
        signs AS (SELECT k.value AS trip_id, h.headsign
          FROM route_trip_headsigns h, json_each(h.trip_ids) k
          WHERE h.agency_id = ? AND h.route_id = ? AND k.value IN (SELECT trip_id FROM wanted))
        SELECT ends.trip_id, ends.terminal_stop_id, ends.terminal_stop_sequence, signs.headsign
        FROM ends LEFT JOIN signs ON signs.trip_id = ends.trip_id`)
        .bind(JSON.stringify(tripIds), agencyId, routeId, agencyId, routeId)
        .all<{
          trip_id: string;
          terminal_stop_id: string;
          terminal_stop_sequence: number;
          headsign: string | null;
        }>();
      for (const row of res.results ?? [])
        terminals.set(row.trip_id, {
          stopId: row.terminal_stop_id,
          stopSequence: Number(row.terminal_stop_sequence),
          ...(row.headsign ? { headsign: row.headsign } : {}),
        });
      return terminals;
    });

  const readCachedRouteDetails = (routeId: string, directionId: number) =>
    Effect.tryPromise(async () => {
      await ensureSurfaceSchema(db);

      const routeRow = await db
        .prepare(
          "SELECT id, short_name, long_name, route_type, color, text_color FROM routes WHERE agency_id = ? AND id = ? LIMIT 1",
        )
        .bind(agencyId, routeId)
        .first<SqliteRouteRow>();
      const shapeRow = await db
        .prepare(`
              SELECT id, route_id, direction_id, headsign, polyline, min_lat, max_lat, min_lon, max_lon, point_count, direction_label
              FROM route_shapes
              WHERE agency_id = ? AND route_id = ? AND direction_id = ?
              ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, id ASC
              LIMIT 1
            `)
        .bind(agencyId, routeId, directionId, `${routeId}_${directionId}_canonical`)
        .first<SqliteShapeRow>();

      if (!routeRow || !shapeRow) return Option.none<RouteDetails>();

      const stopsQuery = `
              SELECT s.id, s.code, s.name, s.lat, s.lon, s.wheelchair, s.parent_station, s.routes_json
              FROM route_stops rs
              JOIN stops s ON rs.agency_id = s.agency_id AND rs.stop_id = s.id
              WHERE rs.agency_id = ? AND rs.route_id = ? AND rs.direction_id = ?
              ORDER BY rs.stop_sequence ASC
            `;
      const stopsRes = await db
        .prepare(stopsQuery)
        .bind(agencyId, routeId, directionId)
        .all<SqliteStopRow>();
      return Option.some(
        toRouteDetails(
          routeRow,
          shapeRow,
          stopsRes.results || [],
          stationIndex,
          routeInterpretation,
        ),
      );
    });

  const readRouteRow = (routeId: string) =>
    Effect.tryPromise(async () => {
      await ensureSurfaceSchema(db);
      const row = await db
        .prepare(
          "SELECT id, short_name, long_name, route_type, color, text_color FROM routes WHERE agency_id = ? AND id = ? LIMIT 1",
        )
        .bind(agencyId, routeId)
        .first<SqliteRouteRow>();
      if (!row) return Option.none<SurfaceRoute>();
      return Option.some(mapRowToRoute(row));
    });

  const readAllRouteRows = () =>
    Effect.tryPromise(async () => {
      await ensureSurfaceSchema(db);
      const res = await db
        .prepare(
          "SELECT id, short_name, long_name, route_type, color, text_color FROM routes WHERE agency_id = ? ORDER BY CAST(short_name AS INTEGER), short_name ASC",
        )
        .bind(agencyId)
        .all<SqliteRouteRow>();
      const rows = res.results || [];
      return rows.map(mapRowToRoute);
    });

  const readStopsForRoutes = (routeIds: readonly string[]) =>
    Effect.tryPromise(async () => {
      await ensureSurfaceSchema(db);
      // Indexed junction lookup: stop_routes (agency_id, route_id, stop_id)
      // mirrors routes_json membership, including merged co-located routes
      // that have no route_stops rows of their own. One PK-prefix range scan
      // for all routes instead of a json_each full-table scan per route.
      if (routeIds.length === 0) return [];
      const res = await db
        .prepare(
          `SELECT sr.route_id AS route_id, s.id, s.code, s.name, s.lat, s.lon, s.wheelchair, s.parent_station, s.routes_json
               FROM stop_routes sr
               JOIN stops s ON sr.agency_id = s.agency_id AND sr.stop_id = s.id
               WHERE sr.agency_id = ? AND sr.route_id IN (SELECT value FROM json_each(?))`,
        )
        .bind(agencyId, JSON.stringify(routeIds))
        .all<SqliteStopRow & { route_id: string }>();
      // Regroup in input route order. A stop served in both directions has
      // two junction rows; the stops table (and the old json_each scan)
      // yields it once per route.
      const byRoute = new Map<string, SurfaceStop[]>();
      const seen = new Set<string>();
      for (const row of res.results || []) {
        const key = `${row.route_id}:${row.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let list = byRoute.get(row.route_id);
        if (!list) {
          list = [];
          byRoute.set(row.route_id, list);
        }
        list.push(mapRowToStop(row, stationIndex));
      }
      return routeIds.flatMap((routeId) => byRoute.get(routeId) ?? []);
    });

  const readStopsByIds = (stopIds: readonly string[]) =>
    Effect.tryPromise(async () => {
      await ensureSurfaceSchema(db);
      const query =
        "SELECT id, code, name, lat, lon, wheelchair, parent_station, routes_json FROM stops WHERE agency_id = ? AND id IN (SELECT value FROM json_each(?))";
      const stmt = db.prepare(query).bind(agencyId, JSON.stringify(stopIds));
      const res = await stmt.all<SqliteStopRow>();
      return (res.results || []).map((row) => mapRowToStop(row, stationIndex));
    });

  return {
    readNearbyCandidates,
    readRouteDirectionIds,
    readTripTerminals,
    readDirectionsForTrips,
    readRoutesForTrips,
    readCachedRouteDetails,
    readRouteRow,
    readAllRouteRows,
    readStopsForRoutes,
    readStopsByIds,
  };
}

/**
 * Full snapshot materialization over the shared read path: routes in CAST
 * order, shapes per route in direction_id order, stops per shape in
 * stop_sequence order. Routes without shapes emit a single entry with an
 * empty polyline and the canonical dir0 literal so realtime can still run.
 */
export async function fetchTopologySnapshot(
  db: D1DatabaseBinding,
  input: {
    readonly agencyId: string;
    readonly now?: () => number;
    readonly stationIndex?: readonly SchematicStationIndexEntry[];
    readonly routeInterpretation?: RouteInterpretationConfig;
  },
): Promise<StaticSnapshot> {
  const { agencyId, now = () => Date.now(), stationIndex, routeInterpretation } = input;
  await ensureSurfaceSchema(db);

  const routesRes = await db
    .prepare(
      "SELECT id, short_name, long_name, route_type, color, text_color FROM routes WHERE agency_id = ? ORDER BY CAST(short_name AS INTEGER), short_name ASC",
    )
    .bind(agencyId)
    .all<SqliteRouteRow>();
  const routeRows = routesRes.results ?? [];

  const routes: RouteTopology[] = [];
  for (const row of routeRows) {
    const route = mapRowToRoute(row);

    const shapesRes = await db
      .prepare(
        "SELECT id, route_id, direction_id, headsign, polyline, min_lat, max_lat, min_lon, max_lon, point_count, direction_label FROM route_shapes WHERE agency_id = ? AND route_id = ? ORDER BY direction_id ASC",
      )
      .bind(agencyId, route.id)
      .all<SqliteShapeRow>();
    const shapeRows = shapesRes.results ?? [];

    if (shapeRows.length === 0) {
      routes.push({
        routeId: route.id,
        shortName: route.shortName,
        longName: route.longName,
        color: route.color,
        textColor: route.textColor,
        routeType: route.routeType,
        polyline: "",
        directionId: 0,
        headsign: "",
        // Canonical literal from the domain policy, no per-routeType
        // hardcoded literals here.
        directionLabel: getRouteDirectionsForRoute(
          route.routeType,
          route.id,
          routeInterpretation,
        )[0].label,
        stops: [] as const,
      });
      continue;
    }

    // One shared facts map per route so both direction labels resolve from
    // the same headsigns (C1 authority, no per-row canonical fallback).
    const labels = labelsForRoute(
      shapeRows.map((s) => ({
        directionId: Number(s.direction_id),
        headsign: String(s.headsign ?? ""),
        polyline: s.polyline,
      })),
      route.shortName,
    );

    for (const shapeRow of shapeRows) {
      const stopsRes = await db
        .prepare(
          `SELECT s.id, s.code, s.name, s.lat, s.lon, s.wheelchair, s.parent_station, s.routes_json
           FROM route_stops rs
           JOIN stops s ON rs.agency_id = s.agency_id AND rs.stop_id = s.id
           WHERE rs.agency_id = ? AND rs.route_id = ? AND rs.direction_id = ?
           ORDER BY rs.stop_sequence ASC`,
        )
        .bind(agencyId, route.id, shapeRow.direction_id)
        .all<SqliteStopRow>();
      const stopRows = stopsRes.results ?? [];
      const stops = stopRows.map((r) => {
        const s = mapRowToStop(r, stationIndex);
        return {
          id: s.id,
          code: s.code,
          name: s.name,
          lat: s.lat,
          lon: s.lon,
          wheelchair: s.wheelchair,
          parentStation: s.parentStation,
          parentStationId: s.parentStationId,
        };
      });

      const shapeDirId = Number(shapeRow.direction_id);
      const canonicalDirections = getRouteDirectionsForRoute(
        route.routeType,
        route.id,
        routeInterpretation,
      );
      const fallbackLabel =
        canonicalDirections.find((d) => d.directionId === shapeDirId)?.label ??
        canonicalDirections[0].label;
      const directionLabel =
        shapeRow.direction_label && shapeRow.direction_label.trim() !== ""
          ? shapeRow.direction_label.trim()
          : (labels[shapeDirId]?.label ?? fallbackLabel);

      routes.push({
        routeId: route.id,
        shortName: route.shortName,
        longName: route.longName,
        color: route.color,
        textColor: route.textColor,
        routeType: route.routeType,
        polyline: String(shapeRow.polyline ?? ""),
        directionId: shapeDirId,
        headsign: String(shapeRow.headsign ?? ""),
        directionLabel,
        stops,
      });
    }
  }

  return { agencyId, generatedAt: now(), routes };
}

export { compareRouteShortNames };
