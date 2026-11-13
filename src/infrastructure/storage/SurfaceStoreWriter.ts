import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { D1DatabaseBinding, D1PreparedStatement } from "./RuntimeBindings";
import { ensureSurfaceSchema } from "./surfaceStore/schema";
import { parseRouteType, routeTypeToCode } from "./surfaceRowMappers";
import { buildDirectionLabels } from "~/domain/surface/direction";
import type { RouteDetails, SurfaceRoute, SurfaceStop } from "~/domain/surface/types";

/** Failure phase for an agency-scoped route reconciliation. */
export type SurfaceTopologyWritePhase = "validation" | "read" | "commit";

/** Honest failure at the explicit topology write seam. */
export class SurfaceTopologyWriteError extends Data.TaggedError("SurfaceTopologyWriteError")<{
  readonly agencyId: string;
  readonly routeId: string;
  readonly phase: SurfaceTopologyWritePhase;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface FetchedRouteTopology {
  readonly routeId: string;
  readonly detailsByDirection: ReadonlyMap<number, RouteDetails>;
  /** Authoritative stop union for this fetched route. */
  readonly allStops: readonly SurfaceStop[];
}

export type RouteTopologyWriteOutcome =
  | { readonly outcome: "source-absent"; readonly routeId: string }
  | { readonly outcome: "unchanged"; readonly routeId: string }
  | { readonly outcome: "updated"; readonly routeId: string };

export interface SurfaceTopologyWriter {
  readonly reconcileRoute: (
    fetched: FetchedRouteTopology,
  ) => Effect.Effect<RouteTopologyWriteOutcome, SurfaceTopologyWriteError>;
}

interface StoredRouteRow {
  readonly id: string;
  readonly short_name: string;
  readonly long_name: string;
  readonly route_type: number;
  readonly color: string;
  readonly text_color: string;
}

interface StoredShapeRow {
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
  readonly direction_label?: string | null;
}

interface StoredStopRow {
  readonly id: string;
  readonly code: string | null;
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
  readonly wheelchair: number;
  readonly parent_station: string | null;
  readonly routes_json: string | null;
}

interface StoredStopRouteRow {
  readonly stop_id: string;
  readonly route_id: string;
}

interface CurrentRouteProjection {
  readonly route: StoredRouteRow | null;
  readonly shapesByDirection: ReadonlyMap<number, StoredShapeRow>;
  readonly shapeIdsByDirection: ReadonlyMap<number, readonly string[]>;
  readonly sequencesByDirection: ReadonlyMap<number, readonly string[]>;
  readonly junctionStopIds: ReadonlySet<string>;
  readonly routeStopIds: ReadonlySet<string>;
  readonly stopsById: ReadonlyMap<string, StoredStopRow>;
  readonly membershipsByStop: ReadonlyMap<string, readonly string[]>;
}

interface NormalizedStop {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
  readonly wheelchair: number;
  readonly parentStation: string | null;
}

interface NormalizedFetchedRoute {
  readonly routeId: string;
  readonly route: SurfaceRoute | null;
  readonly detailsByDirection: ReadonlyMap<number, RouteDetails>;
  readonly allStops: readonly NormalizedStop[];
  readonly stopsById: ReadonlyMap<string, NormalizedStop>;
}

interface EffectiveShape {
  readonly headsign: string;
  readonly polyline: string;
  readonly minLat: number;
  readonly maxLat: number;
  readonly minLon: number;
  readonly maxLon: number;
  readonly pointCount: number;
  readonly directionLabel: string;
}

function routeIdForError(fetched: FetchedRouteTopology): string {
  return typeof fetched.routeId === "string"
    ? fetched.routeId.trim()
    : String(fetched.routeId ?? "");
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function writeError(
  agencyId: string,
  routeId: string,
  phase: SurfaceTopologyWritePhase,
  cause: unknown,
): SurfaceTopologyWriteError {
  if (cause instanceof SurfaceTopologyWriteError) return cause;
  return new SurfaceTopologyWriteError({
    agencyId,
    routeId,
    phase,
    message: errorMessage(cause),
    cause,
  });
}

function routeFactsEqual(a: SurfaceRoute, b: SurfaceRoute): boolean {
  return (
    a.id === b.id &&
    a.shortName === b.shortName &&
    a.longName === b.longName &&
    a.routeType === b.routeType &&
    a.color === b.color &&
    a.textColor === b.textColor
  );
}

function normalizeStop(stop: SurfaceStop): NormalizedStop {
  return {
    id: stop.id,
    code: stop.code ?? stop.id,
    name: stop.name,
    lat: stop.lat,
    lon: stop.lon,
    wheelchair: stop.wheelchair ?? 0,
    parentStation: stop.parentStation?.trim() || null,
  };
}

function stopFactsEqual(a: NormalizedStop, b: NormalizedStop): boolean {
  return (
    a.id === b.id &&
    a.code === b.code &&
    a.name === b.name &&
    a.lat === b.lat &&
    a.lon === b.lon &&
    a.wheelchair === b.wheelchair &&
    a.parentStation === b.parentStation
  );
}

function storedStopFactsEqual(incoming: NormalizedStop, stored: StoredStopRow): boolean {
  return (
    incoming.id === stored.id &&
    incoming.code === (stored.code ?? stored.id) &&
    incoming.name === stored.name &&
    incoming.lat === Number(stored.lat) &&
    incoming.lon === Number(stored.lon) &&
    incoming.wheelchair === Number(stored.wheelchair) &&
    (incoming.parentStation === null || incoming.parentStation === stored.parent_station)
  );
}

function addStopFact(
  byId: Map<string, NormalizedStop>,
  stop: SurfaceStop,
  agencyId: string,
  routeId: string,
): void {
  const normalized = normalizeStop(stop);
  const existing = byId.get(normalized.id);
  if (existing && !stopFactsEqual(existing, normalized)) {
    throw new SurfaceTopologyWriteError({
      agencyId,
      routeId,
      phase: "validation",
      message: `duplicate stop id "${normalized.id}" has conflicting facts`,
    });
  }
  byId.set(normalized.id, existing ?? normalized);
}

function normalizeAndValidate(
  fetched: FetchedRouteTopology,
  agencyId: string,
): NormalizedFetchedRoute {
  const routeId = routeIdForError(fetched);
  if (!routeId) {
    throw new SurfaceTopologyWriteError({
      agencyId,
      routeId,
      phase: "validation",
      message: "routeId must be nonblank",
    });
  }

  try {
    const entries = [...fetched.detailsByDirection.entries()];
    if (entries.length === 0) {
      return {
        routeId,
        route: null,
        detailsByDirection: new Map(),
        allStops: [],
        stopsById: new Map(),
      };
    }

    const firstDetails = entries[0]![1];
    if (firstDetails.route.id !== routeId || firstDetails.shape.routeId !== routeId) {
      throw new Error("route and shape ids must match routeId");
    }

    const route = firstDetails.route;
    const detailsByDirection = new Map<number, RouteDetails>();
    const stopsById = new Map<string, NormalizedStop>();
    const allStopsById = new Map<string, NormalizedStop>();

    for (const [directionId, details] of entries) {
      if (directionId !== details.shape.directionId) {
        throw new Error(`map key ${directionId} does not match shape directionId`);
      }
      if (details.route.id !== routeId || details.shape.routeId !== routeId) {
        throw new Error("every route and shape id must match routeId");
      }
      if (!routeFactsEqual(route, details.route)) {
        throw new Error("all directions must carry identical route facts");
      }
      detailsByDirection.set(directionId, details);
      for (const stop of details.stops) addStopFact(stopsById, stop, agencyId, routeId);
    }

    for (const stop of fetched.allStops) {
      addStopFact(allStopsById, stop, agencyId, routeId);
    }
    for (const stop of stopsById.values()) {
      const unionStop = allStopsById.get(stop.id);
      if (!unionStop) {
        throw new Error(`directional stop "${stop.id}" is absent from allStops`);
      }
      if (!stopFactsEqual(stop, unionStop)) {
        throw new Error(`duplicate stop id "${stop.id}" has conflicting facts`);
      }
    }

    return {
      routeId,
      route,
      detailsByDirection,
      allStops: [...allStopsById.values()],
      stopsById: allStopsById,
    };
  } catch (cause) {
    throw writeError(agencyId, routeId, "validation", cause);
  }
}

function parseStoredRouteIds(raw: string | null): readonly string[] {
  try {
    const value: unknown = JSON.parse(raw || "[]");
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((id): id is string => typeof id === "string"))];
  } catch {
    return [];
  }
}

function addUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

async function readCurrentProjection(
  db: D1DatabaseBinding,
  agencyId: string,
  routeId: string,
  desiredStopIds: ReadonlySet<string>,
): Promise<CurrentRouteProjection> {
  const route = await db
    .prepare(
      "SELECT id, short_name, long_name, route_type, color, text_color FROM routes WHERE agency_id = ? AND id = ? LIMIT 1",
    )
    .bind(agencyId, routeId)
    .first<StoredRouteRow>();

  const shapesResult = await db
    .prepare(
      "SELECT id, route_id, direction_id, headsign, polyline, min_lat, max_lat, min_lon, max_lon, point_count, direction_label FROM route_shapes WHERE agency_id = ? AND route_id = ? ORDER BY direction_id ASC",
    )
    .bind(agencyId, routeId)
    .all<StoredShapeRow>();
  if (shapesResult.success === false) throw new Error("reading route shapes failed");

  const sequenceResult = await db
    .prepare(
      "SELECT direction_id, stop_sequence, stop_id FROM route_stops WHERE agency_id = ? AND route_id = ? ORDER BY direction_id ASC, stop_sequence ASC",
    )
    .bind(agencyId, routeId)
    .all<{ direction_id: number; stop_sequence: number; stop_id: string }>();
  if (sequenceResult.success === false) throw new Error("reading route stop sequences failed");

  const routeMembershipResult = await db
    .prepare("SELECT stop_id FROM stop_routes WHERE agency_id = ? AND route_id = ?")
    .bind(agencyId, routeId)
    .all<{ stop_id: string }>();
  if (routeMembershipResult.success === false) throw new Error("reading route memberships failed");

  const sequencesByDirection = new Map<number, string[]>();
  for (const row of sequenceResult.results ?? []) {
    const sequence = sequencesByDirection.get(Number(row.direction_id)) ?? [];
    sequence.push(row.stop_id);
    sequencesByDirection.set(Number(row.direction_id), sequence);
  }

  const junctionStopIds = new Set<string>(
    (routeMembershipResult.results ?? []).map((row) => row.stop_id),
  );
  const routeStopIds = new Set(junctionStopIds);
  for (const sequence of sequencesByDirection.values()) {
    for (const stopId of sequence) routeStopIds.add(stopId);
  }

  const stopIds = new Set([...routeStopIds, ...desiredStopIds]);
  const stopsById = new Map<string, StoredStopRow>();
  const membershipsByStop = new Map<string, string[]>();

  if (stopIds.size > 0) {
    const ids = [...stopIds];
    const stopResult = await db
      .prepare(
        "SELECT id, code, name, lat, lon, wheelchair, parent_station, routes_json FROM stops WHERE agency_id = ? AND id IN (SELECT value FROM json_each(?))",
      )
      .bind(agencyId, JSON.stringify(ids))
      .all<StoredStopRow>();
    if (stopResult.success === false) throw new Error("reading route stops failed");
    for (const row of stopResult.results ?? []) stopsById.set(row.id, row);

    const membershipResult = await db
      .prepare(
        "SELECT stop_id, route_id FROM stop_routes WHERE agency_id = ? AND stop_id IN (SELECT value FROM json_each(?)) ORDER BY stop_id, route_id",
      )
      .bind(agencyId, JSON.stringify(ids))
      .all<StoredStopRouteRow>();
    if (membershipResult.success === false) throw new Error("reading stop memberships failed");
    for (const row of membershipResult.results ?? []) {
      const memberships = membershipsByStop.get(row.stop_id) ?? [];
      addUnique(memberships, row.route_id);
      membershipsByStop.set(row.stop_id, memberships);
    }
  }

  const shapesByDirection = new Map<number, StoredShapeRow>();
  const shapeIdsByDirection = new Map<number, string[]>();
  for (const row of shapesResult.results ?? []) {
    const directionId = Number(row.direction_id);
    const ids = shapeIdsByDirection.get(directionId) ?? [];
    ids.push(row.id);
    shapeIdsByDirection.set(directionId, ids);

    const canonicalId = `${routeId}_${directionId}_canonical`;
    const current = shapesByDirection.get(directionId);
    if (!current || row.id === canonicalId) {
      shapesByDirection.set(directionId, row);
    }
  }

  return {
    route,
    shapesByDirection,
    shapeIdsByDirection,
    sequencesByDirection,
    junctionStopIds,
    routeStopIds,
    stopsById,
    membershipsByStop,
  };
}

function effectiveShape(
  details: RouteDetails,
  label: string,
  stored?: StoredShapeRow,
): EffectiveShape {
  const incoming = details.shape;
  const useStoredGeometry = incoming.polyline === "" && stored !== undefined;
  return {
    headsign: incoming.headsign,
    polyline: useStoredGeometry ? stored.polyline : incoming.polyline,
    minLat: useStoredGeometry ? Number(stored.min_lat) : incoming.minLat,
    maxLat: useStoredGeometry ? Number(stored.max_lat) : incoming.maxLat,
    minLon: useStoredGeometry ? Number(stored.min_lon) : incoming.minLon,
    maxLon: useStoredGeometry ? Number(stored.max_lon) : incoming.maxLon,
    pointCount: useStoredGeometry ? Number(stored.point_count) : incoming.pointCount,
    directionLabel: label,
  };
}

function shapeNeedsUpdate(
  details: RouteDetails,
  label: string,
  stored: StoredShapeRow | undefined,
): boolean {
  if (!stored) return true;
  const incoming = effectiveShape(details, label, stored);
  const storedLabel = stored.direction_label?.trim() || incoming.directionLabel;
  return (
    stored.headsign !== incoming.headsign ||
    stored.polyline !== incoming.polyline ||
    Number(stored.min_lat) !== incoming.minLat ||
    Number(stored.max_lat) !== incoming.maxLat ||
    Number(stored.min_lon) !== incoming.minLon ||
    Number(stored.max_lon) !== incoming.maxLon ||
    Number(stored.point_count) !== incoming.pointCount ||
    storedLabel !== incoming.directionLabel
  );
}

function sequenceNeedsUpdate(
  details: RouteDetails,
  stored: readonly string[] | undefined,
): boolean {
  const incoming = details.stops.map((stop) => stop.id);
  if (!stored || stored.length !== incoming.length) return true;
  return incoming.some((stopId, index) => stopId !== stored[index]);
}

function existingMemberships(
  projection: CurrentRouteProjection,
  stopId: string,
  routeId: string,
): string[] {
  const memberships: string[] = [];
  const stored = projection.stopsById.get(stopId);
  for (const id of parseStoredRouteIds(stored?.routes_json ?? null)) {
    if (id !== routeId) addUnique(memberships, id);
  }
  for (const id of projection.membershipsByStop.get(stopId) ?? []) {
    if (id !== routeId) addUnique(memberships, id);
  }
  return memberships;
}

function desiredRoutesJson(
  projection: CurrentRouteProjection,
  stopId: string,
  routeId: string,
  shouldServe: boolean,
): string {
  const memberships = existingMemberships(projection, stopId, routeId);
  if (shouldServe) addUnique(memberships, routeId);
  return JSON.stringify(memberships);
}

function routeFactsFromStored(row: StoredRouteRow): SurfaceRoute {
  return {
    id: row.id,
    shortName: row.short_name,
    longName: row.long_name,
    routeType: parseRouteType(Number(row.route_type)),
    color: row.color,
    textColor: row.text_color,
  };
}

function routeUpsert(
  db: D1DatabaseBinding,
  agencyId: string,
  route: SurfaceRoute,
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO routes (agency_id, id, short_name, long_name, route_type, color, text_color) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(agency_id, id) DO UPDATE SET short_name = excluded.short_name, long_name = excluded.long_name, route_type = excluded.route_type, color = excluded.color, text_color = excluded.text_color",
    )
    .bind(
      agencyId,
      route.id,
      route.shortName,
      route.longName,
      routeTypeToCode(route.routeType),
      route.color,
      route.textColor,
    );
}

function stopUpsert(
  db: D1DatabaseBinding,
  agencyId: string,
  stop: NormalizedStop,
  routesJson: string,
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO stops (agency_id, id, code, name, lat, lon, wheelchair, parent_station, routes_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(agency_id, id) DO UPDATE SET code = excluded.code, name = excluded.name, lat = excluded.lat, lon = excluded.lon, wheelchair = excluded.wheelchair, parent_station = COALESCE(excluded.parent_station, stops.parent_station), routes_json = excluded.routes_json",
    )
    .bind(
      agencyId,
      stop.id,
      stop.code,
      stop.name,
      stop.lat,
      stop.lon,
      stop.wheelchair,
      stop.parentStation,
      routesJson,
    );
}

function shapeUpsert(
  db: D1DatabaseBinding,
  agencyId: string,
  routeId: string,
  directionId: number,
  shape: EffectiveShape,
): D1PreparedStatement {
  const shapeId = `${routeId}_${directionId}_canonical`;
  return db
    .prepare(
      "INSERT INTO route_shapes (agency_id, id, route_id, direction_id, headsign, polyline, min_lat, max_lat, min_lon, max_lon, point_count, direction_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(agency_id, id) DO UPDATE SET headsign = excluded.headsign, polyline = excluded.polyline, min_lat = excluded.min_lat, max_lat = excluded.max_lat, min_lon = excluded.min_lon, max_lon = excluded.max_lon, point_count = excluded.point_count, direction_label = excluded.direction_label",
    )
    .bind(
      agencyId,
      shapeId,
      routeId,
      directionId,
      shape.headsign,
      shape.polyline,
      shape.minLat,
      shape.maxLat,
      shape.minLon,
      shape.maxLon,
      shape.pointCount,
      shape.directionLabel,
    );
}

async function reconcileRoute(
  agencyId: string,
  db: D1DatabaseBinding,
  fetched: FetchedRouteTopology,
): Promise<RouteTopologyWriteOutcome> {
  const normalized = normalizeAndValidate(fetched, agencyId);
  if (normalized.detailsByDirection.size === 0) {
    return { outcome: "source-absent", routeId: normalized.routeId };
  }
  const route = normalized.route!;

  let projection: CurrentRouteProjection;
  try {
    await ensureSurfaceSchema(db);
    projection = await readCurrentProjection(
      db,
      agencyId,
      normalized.routeId,
      new Set(normalized.stopsById.keys()),
    );
  } catch (cause) {
    throw writeError(agencyId, normalized.routeId, "read", cause);
  }

  const routeChanged =
    projection.route === null || !routeFactsEqual(routeFactsFromStored(projection.route), route);
  const labels = buildDirectionLabels(normalized.detailsByDirection, route.shortName);

  const directionsWithShapeChanges = new Set<number>();
  const directionsWithSequenceChanges = new Set<number>();
  for (const [directionId, details] of normalized.detailsByDirection) {
    const canonicalShapeId = `${normalized.routeId}_${directionId}_canonical`;
    const storedShape = projection.shapesByDirection.get(directionId);
    const label = labels[directionId]?.label ?? "";
    const sequenceChanged = sequenceNeedsUpdate(
      details,
      projection.sequencesByDirection.get(directionId),
    );
    const hasCanonicalShape = projection.shapeIdsByDirection
      .get(directionId)
      ?.includes(canonicalShapeId);
    if (
      !hasCanonicalShape ||
      shapeNeedsUpdate(
        details,
        label,
        sequenceChanged && details.shape.polyline === "" ? undefined : storedShape,
      )
    ) {
      directionsWithShapeChanges.add(directionId);
    }
    if (sequenceChanged) {
      directionsWithSequenceChanges.add(directionId);
    }
  }

  const desiredStopIds = new Set(normalized.stopsById.keys());
  for (const [directionId, sequence] of projection.sequencesByDirection) {
    if (!normalized.detailsByDirection.has(directionId)) {
      for (const stopId of sequence) desiredStopIds.add(stopId);
    }
  }

  const stopIdsToInspect = new Set([...projection.routeStopIds, ...desiredStopIds]);
  let stopFactsOrMembershipChanged = false;
  let junctionMembershipChanged = false;
  for (const stopId of stopIdsToInspect) {
    const shouldServe = desiredStopIds.has(stopId);
    const hasJunctionMembership = projection.junctionStopIds.has(stopId);
    const stored = projection.stopsById.get(stopId);
    if (shouldServe) {
      const incoming = normalized.stopsById.get(stopId);
      if (incoming && (!stored || !storedStopFactsEqual(incoming, stored))) {
        stopFactsOrMembershipChanged = true;
      }
    }
    const hasJsonMembership = parseStoredRouteIds(stored?.routes_json ?? null).includes(
      normalized.routeId,
    );
    if (hasJunctionMembership !== shouldServe || hasJsonMembership !== shouldServe) {
      stopFactsOrMembershipChanged = true;
      if (hasJunctionMembership !== shouldServe) junctionMembershipChanged = true;
    }
  }

  const statements: D1PreparedStatement[] = [];
  if (routeChanged) statements.push(routeUpsert(db, agencyId, route));

  if (stopFactsOrMembershipChanged) {
    for (const stopId of stopIdsToInspect) {
      const incoming = normalized.stopsById.get(stopId);
      const stored = projection.stopsById.get(stopId);
      const shouldServe = desiredStopIds.has(stopId);
      const routesJson = desiredRoutesJson(projection, stopId, normalized.routeId, shouldServe);
      if (incoming) {
        const physicalChanged = !stored || !storedStopFactsEqual(incoming, stored);
        const membershipChanged = (stored?.routes_json ?? "[]") !== routesJson;
        if (physicalChanged || membershipChanged) {
          statements.push(stopUpsert(db, agencyId, incoming, routesJson));
        }
      } else if (stored && (stored.routes_json ?? "[]") !== routesJson) {
        statements.push(
          db
            .prepare("UPDATE stops SET routes_json = ? WHERE agency_id = ? AND id = ?")
            .bind(routesJson, agencyId, stopId),
        );
      }
    }
  }

  if (junctionMembershipChanged) {
    const ids = [...desiredStopIds];
    const excludedStopFilter =
      ids.length > 0 ? " AND stop_id NOT IN (SELECT value FROM json_each(?))" : "";
    statements.push(
      db
        .prepare(
          `DELETE FROM stop_routes WHERE agency_id = ? AND route_id = ?${excludedStopFilter}`,
        )
        .bind(agencyId, normalized.routeId, ...(ids.length > 0 ? [JSON.stringify(ids)] : [])),
    );
    for (const stopId of desiredStopIds) {
      if (!projection.junctionStopIds.has(stopId)) {
        statements.push(
          db
            .prepare(
              "INSERT OR IGNORE INTO stop_routes (agency_id, stop_id, route_id) VALUES (?, ?, ?)",
            )
            .bind(agencyId, stopId, normalized.routeId),
        );
      }
    }
  }

  for (const directionId of directionsWithSequenceChanges) {
    statements.push(
      db
        .prepare(
          "DELETE FROM route_stops WHERE agency_id = ? AND route_id = ? AND direction_id = ?",
        )
        .bind(agencyId, normalized.routeId, directionId),
    );
    const details = normalized.detailsByDirection.get(directionId)!;
    for (const [stopSequence, stop] of details.stops.entries()) {
      statements.push(
        db
          .prepare(
            "INSERT INTO route_stops (agency_id, route_id, direction_id, stop_sequence, stop_id) VALUES (?, ?, ?, ?, ?)",
          )
          .bind(agencyId, normalized.routeId, directionId, stopSequence, stop.id),
      );
    }
  }

  for (const directionId of directionsWithShapeChanges) {
    const details = normalized.detailsByDirection.get(directionId)!;
    const preserveStoredGeometry =
      projection.shapeIdsByDirection
        .get(directionId)
        ?.includes(`${normalized.routeId}_${directionId}_canonical`) === true &&
      !directionsWithSequenceChanges.has(directionId);
    statements.push(
      shapeUpsert(
        db,
        agencyId,
        normalized.routeId,
        directionId,
        effectiveShape(
          details,
          labels[directionId]?.label ?? "",
          preserveStoredGeometry ? projection.shapesByDirection.get(directionId) : undefined,
        ),
      ),
    );
  }

  // Older topology writers could leave one live row beside the canonical
  // direction row. Keep one deterministic shape per route/direction so a
  // shape from one pattern cannot be paired with another pattern's stops.
  for (const [directionId, shapeIds] of projection.shapeIdsByDirection) {
    const canonicalShapeId = `${normalized.routeId}_${directionId}_canonical`;
    if (!shapeIds.includes(canonicalShapeId) || shapeIds.length <= 1) continue;
    statements.push(
      db
        .prepare(
          "DELETE FROM route_shapes WHERE agency_id = ? AND route_id = ? AND direction_id = ? AND id <> ?",
        )
        .bind(agencyId, normalized.routeId, directionId, canonicalShapeId),
    );
  }

  if (statements.length === 0) {
    return { outcome: "unchanged", routeId: normalized.routeId };
  }

  try {
    await db.batch(statements);
  } catch (cause) {
    throw writeError(agencyId, normalized.routeId, "commit", cause);
  }
  return { outcome: "updated", routeId: normalized.routeId };
}

/** Creates a writer bound to one agency and one topology database. */
export function makeSurfaceTopologyWriter(input: {
  readonly agencyId: string;
  readonly db: D1DatabaseBinding;
}): SurfaceTopologyWriter {
  return {
    reconcileRoute: (fetched) =>
      Effect.tryPromise({
        try: () => reconcileRoute(input.agencyId, input.db, fetched),
        catch: (cause) => writeError(input.agencyId, routeIdForError(fetched), "read", cause),
      }),
  };
}
