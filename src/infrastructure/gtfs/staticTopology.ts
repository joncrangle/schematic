import type { GtfsProjectionConfig } from "./config";
export { modesToGtfsRouteTypes, type GtfsProjectionConfig } from "./config";
import { normalizeWheelchairBoarding } from "~/domain/surface/accessibility";
import {
  directionSemanticForPath,
  parseHeadsign,
  statedCompassLabel,
} from "~/domain/surface/direction";
import { encodePolyline } from "~/domain/map/MapGeometry";
import { simplifyRdp, type CoordPair } from "./geometry";
import { assertGtfsArchiveSize, processArchiveCsv, readGtfsArchive } from "./archive";
import { logger } from "~/infrastructure/logging/logger";

/**
 * The most trip ids one route_direction_trips row may carry.
 *
 * D1 rejects a single statement over roughly 100KB with SQLITE_TOOBIG, and a
 * row's size is the length of its JSON array. Real trip ids are about sixteen
 * characters, so 2,000 ids is roughly 34KB, which leaves comfortable headroom
 * under the limit even for an unusually long id. A group holding more trips than
 * this is spread over several rows rather than failing to seed.
 */
export const TRIP_IDS_PER_PART = 2_000;

export type GtfsRow = Record<string, string | number | null>;
export type GtfsTopology = Readonly<Record<string, readonly GtfsRow[]>>;

/**
 * The direction label the operator actually stated, or "" when they stated
 * none.
 *
 * A headsign is the operator's own claim about where a rider ends up, so a
 * compass word it contains is authoritative: "Westbound to Brampton" is
 * westbound. Deriving a label from the direction index instead substituted our
 * guess for theirs, which is how a bus to Brampton came to be labelled
 * "Southbound". Callers fall back to the canonical literal only when the feed
 * states nothing at all, where there is no claim to contradict.
 */
export function deriveDirectionLabel(headsign: string): string {
  return parseHeadsign(headsign).label || statedCompassLabel(headsign);
}

export async function contentHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashGtfsArchives(
  archives: readonly Uint8Array[],
  config: GtfsProjectionConfig,
): Promise<string> {
  for (const archive of archives) assertGtfsArchiveSize(archive.byteLength);
  const hashes: string[] = [];
  for (const archive of archives) hashes.push(await contentHash(archive));
  return contentHash(
    new TextEncoder().encode(
      JSON.stringify({
        // Projection changes invalidate persisted archive hashes.
        version: 5,
        id: config.id,
        routeTypes: [...config.routeTypes].sort((a, b) => a - b),
        routeIdField: config.routeIdField,
        ...(config.vehicleOnlyRoutes?.length
          ? { vehicleOnlyRoutes: config.vehicleOnlyRoutes }
          : {}),
        ...(config.sourceAgencyIds
          ? { sourceAgencyIds: [...new Set(config.sourceAgencyIds)].sort() }
          : {}),
        ...(config.routeShortNames ? { routeShortNames: config.routeShortNames } : {}),
        defaultColor: config.defaultColor,
        defaultTextColor: config.defaultTextColor,
        ...(config.ignoreFeedRouteColors ? { ignoreFeedRouteColors: true } : {}),
        ...(config.excludedRouteIds?.length
          ? { excludedRouteIds: [...new Set(config.excludedRouteIds)].sort() }
          : {}),
        ...(config.routeDirectionIds ? { routeDirectionIds: config.routeDirectionIds } : {}),
        ...(config.feedIdentities ? { feedIdentities: config.feedIdentities } : {}),
        archives: hashes,
      }),
    ),
  );
}

const OPPOSITE_BEARING: Readonly<Record<string, string>> = {
  northbound: "southbound",
  southbound: "northbound",
  eastbound: "westbound",
  westbound: "eastbound",
};

/**
 * Scoped trip ids that run against their route's dominant bearing, for routes
 * whose feed states no direction_id. Without this a route run both ways under
 * one name, as an evening routing is, becomes one group whose bearing is
 * whichever shape won. Loops and shapeless trips have no bearing and stay put.
 */
async function opposingUndirectedTrips(
  sources: readonly ReturnType<typeof readGtfsArchive>[],
  rawRoutes: ReadonlyMap<string, string>,
  config: GtfsProjectionConfig,
  scopedKey: (source: number, id: string) => string,
): Promise<ReadonlySet<string>> {
  const opposing = new Set<string>();
  for (const [source, archive] of sources.entries()) {
    const directed = new Set<string>();
    const tripsByRoute = new Map<string, { tripKey: string; shapeId: string }[]>();
    await processArchiveCsv(archive, "trips.txt", ["route_id", "trip_id"], (get) => {
      const rawRouteId = get("route_id");
      const routeId = rawRoutes.get(scopedKey(source, rawRouteId));
      if (!routeId || config.routeDirectionIds?.[rawRouteId] !== undefined) return;
      if (get("direction_id")) {
        directed.add(routeId);
        return;
      }
      const trips = tripsByRoute.get(routeId) ?? [];
      trips.push({ tripKey: scopedKey(source, get("trip_id")), shapeId: get("shape_id") });
      tripsByRoute.set(routeId, trips);
    });
    for (const routeId of directed) tripsByRoute.delete(routeId);
    const shapeIds = new Set(
      [...tripsByRoute.values()].flat().flatMap(({ shapeId }) => (shapeId ? [shapeId] : [])),
    );
    if (shapeIds.size < 2) continue;
    const ends = new Map<
      string,
      { first: [number, number, number]; last: [number, number, number] }
    >();
    await processArchiveCsv(
      archive,
      "shapes.txt",
      ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"],
      (get) => {
        const shapeId = get("shape_id");
        if (!shapeIds.has(shapeId)) return;
        const point: [number, number, number] = [
          Number.parseInt(get("shape_pt_sequence"), 10),
          Number.parseFloat(get("shape_pt_lat")),
          Number.parseFloat(get("shape_pt_lon")),
        ];
        if (!point.every(Number.isFinite)) return;
        const known = ends.get(shapeId);
        if (!known) ends.set(shapeId, { first: point, last: point });
        else {
          if (point[0] < known.first[0]) known.first = point;
          if (point[0] > known.last[0]) known.last = point;
        }
      },
    );
    const bearingOf = (shapeId: string) => {
      const end = ends.get(shapeId);
      return end
        ? directionSemanticForPath([
            [end.first[1], end.first[2]],
            [end.last[1], end.last[2]],
          ])
        : undefined;
    };
    for (const trips of tripsByRoute.values()) {
      const counts = new Map<string, number>();
      for (const { shapeId } of trips) {
        const bearing = bearingOf(shapeId);
        if (bearing) counts.set(bearing, (counts.get(bearing) ?? 0) + 1);
      }
      // Ties break by name so the split is stable across reseeds.
      const [dominant] = [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b))[0] ?? [];
      const opposite = dominant ? OPPOSITE_BEARING[dominant] : undefined;
      if (!opposite || !counts.has(opposite)) continue;
      for (const { tripKey, shapeId } of trips)
        if (bearingOf(shapeId) === opposite) opposing.add(tripKey);
    }
  }
  return opposing;
}

/** The CLI and background refresh share this projection and its duplicate-key precedence. */
export async function projectGtfsTopology(
  archives: readonly Uint8Array[],
  config: GtfsProjectionConfig,
): Promise<GtfsTopology> {
  if (!archives.length) throw new Error("No GTFS archives supplied");
  const sources = archives.map((bytes, index) =>
    readGtfsArchive(bytes, config.feedIdentities?.[index]),
  );
  const routes = new Map<string, GtfsRow>();
  const excludedRouteIds = new Set(config.excludedRouteIds);
  const rawRoutes = new Map<string, string>();
  const scopedKey = (source: number, id: string) => JSON.stringify([source, id]);
  for (const [source, archive] of sources.entries()) {
    await processArchiveCsv(archive, "routes.txt", ["route_id", "route_type"], (get) => {
      if (config.sourceAgencyIds && !config.sourceAgencyIds.includes(get("agency_id"))) return;
      const type = Number.parseInt(get("route_type"), 10);
      if (!config.routeTypes.has(type)) return;
      const rawId = get("route_id");
      if (excludedRouteIds.has(rawId)) return;
      const id = config.routeIdField === "short_name" ? get("route_short_name") || rawId : rawId;
      if (!rawId || !id) throw new Error("Empty GTFS route id");
      rawRoutes.set(scopedKey(source, rawId), id);
      if (!routes.has(id))
        routes.set(id, {
          agency_id: config.id,
          id,
          short_name: config.routeShortNames?.[id] ?? (get("route_short_name") || id),
          long_name: get("route_long_name"),
          route_type: type,
          color:
            get("route_color") && !config.ignoreFeedRouteColors
              ? `#${get("route_color")}`
              : config.defaultColor,
          text_color:
            get("route_text_color") && !config.ignoreFeedRouteColors
              ? `#${get("route_text_color")}`
              : config.defaultTextColor,
        });
    });
  }
  if (!routes.size) throw new Error("GTFS has no routes for configured modes");
  const trips = new Map<string, string>();
  type ShapeFrequency = { count: number; tripId: string };
  type DirectionGroup = {
    source: number;
    routeId: string;
    directionId: number;
    /** Headsigns seen in this direction, by trip count. */
    headsigns: Map<string, number>;
    shapes: Map<string, ShapeFrequency>;
  };
  const groups = new Map<string, DirectionGroup>();
  const undirectedOpposites = await opposingUndirectedTrips(sources, rawRoutes, config, scopedKey);
  /** Scoped trip id -> its group key, so every trip keeps its group. */
  const tripGroupKeyByTrip = new Map<string, string>();
  /** Scoped trip id -> the destination its sign states, when it states one. */
  const headsignByTrip = new Map<string, string>();
  for (const [source, archive] of sources.entries()) {
    await processArchiveCsv(archive, "trips.txt", ["route_id", "trip_id"], (get) => {
      const routeId = rawRoutes.get(scopedKey(source, get("route_id")));
      if (!routeId) return;
      const tripId = get("trip_id");
      if (!tripId) throw new Error("Empty GTFS trip id");
      trips.set(scopedKey(source, tripId), routeId);
      const directionId =
        config.routeDirectionIds?.[get("route_id")] ??
        (get("direction_id")
          ? Number.parseInt(get("direction_id"), 10) === 1
            ? 1
            : 0
          : undirectedOpposites.has(scopedKey(source, tripId))
            ? 1
            : 0);
      const shapeId = get("shape_id");
      // One group per direction of travel, which is what `direction_id` states
      // and what a rider is standing at a station waiting for: one way east,
      // one way west. Grouping per headsign instead produced a row per
      // destination, so a GO station offered eight rows on one line and a bus
      // route offered one per branch with the same terminal repeated. Branches
      // that share a direction are one row to a rider, not several.
      const headsign = get("trip_headsign").trim();
      const key = JSON.stringify([source, routeId, directionId]);
      const group = groups.get(key) ?? {
        source,
        routeId,
        directionId,
        headsigns: new Map<string, number>(),
        shapes: new Map<string, ShapeFrequency>(),
      };
      if (headsign) group.headsigns.set(headsign, (group.headsigns.get(headsign) ?? 0) + 1);
      if (headsign) headsignByTrip.set(scopedKey(source, tripId), headsign);
      else headsignByTrip.delete(scopedKey(source, tripId));
      if (shapeId) {
        const shape = group.shapes.get(shapeId) ?? { count: 0, tripId };
        shape.count++;
        if (tripId < shape.tripId) shape.tripId = tripId;
        group.shapes.set(shapeId, shape);
      }
      groups.set(key, group);
      tripGroupKeyByTrip.set(scopedKey(source, tripId), key);
    });
  }
  // A group's label is the headsign most of its trips state, so a direction
  // carrying several branches is named for the service a rider mostly sees.
  // Ties break on the headsign so the label is stable across reseeds rather
  // than depending on which trip the feed happened to list first.
  type ResolvedGroup = DirectionGroup & { key: string; headsign: string };
  const resolved = new Map<string, ResolvedGroup>();
  for (const [key, group] of groups) {
    let headsign = "";
    let best = -1;
    for (const [candidate, count] of [...group.headsigns].sort(([a], [b]) => a.localeCompare(b))) {
      if (count > best) {
        headsign = candidate;
        best = count;
      }
    }
    resolved.set(key, { ...group, key, headsign });
  }
  const canonical: Array<{
    source: number;
    routeId: string;
    directionId: number;
    shapeKey: string;
    headsign: string;
  }> = [];
  const canonicalTrips = new Map<string, { routeId: string; directionId: number }>();
  const selectedShapes = new Set<string>();
  for (const group of resolved.values()) {
    let best: [string, ShapeFrequency] | undefined;
    const shapesById = [...group.shapes].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    for (const entry of shapesById) if (!best || entry[1].count > best[1].count) best = entry;
    if (!best) continue;
    const shapeKey = scopedKey(group.source, best[0]);
    canonical.push({
      source: group.source,
      routeId: group.routeId,
      directionId: group.directionId,
      shapeKey,
      headsign: group.headsign,
    });
    canonicalTrips.set(scopedKey(group.source, best[1].tripId), group);
    selectedShapes.add(shapeKey);
  }
  const shapeLessGroups = [...resolved.values()].filter((group) => group.shapes.size === 0);
  if (shapeLessGroups.length > 0) {
    const stopCounts = new Map<string, { tripId: string; count: number }>();
    for (const [source, archive] of sources.entries()) {
      await processArchiveCsv(archive, "stop_times.txt", ["trip_id"], (get) => {
        const tripId = get("trip_id");
        const tripKey = scopedKey(source, tripId);
        const groupKey = tripGroupKeyByTrip.get(tripKey);
        if (!groupKey || resolved.get(groupKey)?.shapes.size !== 0) return;
        const previous = stopCounts.get(tripKey);
        stopCounts.set(tripKey, { tripId, count: (previous?.count ?? 0) + 1 });
      });
    }
    const longestByGroup = new Map<string, { tripKey: string; tripId: string; count: number }>();
    for (const [tripKey, { tripId, count }] of stopCounts) {
      const groupKey = tripGroupKeyByTrip.get(tripKey);
      if (!groupKey) continue;
      const previous = longestByGroup.get(groupKey);
      if (
        !previous ||
        count > previous.count ||
        (count === previous.count && tripId < previous.tripId)
      )
        longestByGroup.set(groupKey, { tripKey, tripId, count });
    }
    for (const group of shapeLessGroups) {
      const longestTrip = longestByGroup.get(group.key);
      if (longestTrip) {
        canonicalTrips.set(longestTrip.tripKey, group);
        logger.warn("GTFS direction has no shape; using the longest trip stop list", {
          agencyId: config.id,
          routeId: group.routeId,
          directionId: group.directionId,
          tripId: longestTrip.tripId,
        });
      } else {
        logger.warn("GTFS direction has no shape or stop list", {
          agencyId: config.id,
          routeId: group.routeId,
          directionId: group.directionId,
        });
      }
    }
  }
  // Trip -> direction group. This is the join that lets a realtime departure
  // be attributed to the group its trip belongs to, which is the only way to
  // resolve direction for the feeds that publish no direction_id at all.
  //
  // One row per group carrying that group's trip ids, rather than one row per
  // trip. direction_id is assigned per (source, route) and a route_id belongs
  // to exactly one archive, so the groups a route contributes are keyed by
  // route alone. Trip ids are unioned across any group that lands on the same
  // route/direction so no trip can be dropped by a duplicate id.
  type DirectionGroupRow = {
    agency_id: string;
    route_id: string;
    direction_id: number;
    trip_ids: Set<string>;
  };
  const directionGroups = new Map<string, DirectionGroupRow>();
  for (const [scopedTripKey, key] of tripGroupKeyByTrip) {
    const group = resolved.get(key);
    if (!group) continue;
    const [, tripId] = JSON.parse(scopedTripKey) as [number, string];
    const routeId = trips.get(scopedTripKey);
    if (!routeId) continue;
    const rowKey = JSON.stringify([routeId, group.directionId]);
    const row = directionGroups.get(rowKey) ?? {
      agency_id: config.id,
      route_id: routeId,
      direction_id: group.directionId,
      trip_ids: new Set<string>(),
    };
    row.trip_ids.add(tripId);
    directionGroups.set(rowKey, row);
  }
  // A group's trips travel together as one JSON array, so a group with very many
  // trips produces one very large INSERT. D1 rejects any single statement over
  // roughly 100KB with SQLITE_TOOBIG, and GO's UP line puts 14,125 trips in a
  // single direction group, which is a 226KB statement. So a group larger than
  // the cap is spread over as many rows as it needs, each carrying the trips it
  // can. The reader already expands every row matching agency_id and route_id
  // through json_each, so split parts are found with no query change.
  const directionTrips: GtfsRow[] = [];
  for (const row of directionGroups.values()) {
    // Sorted so an unchanged feed produces an unchanged row, which is what lets
    // the seeder skip the write entirely.
    const tripIds = [...row.trip_ids].sort();
    for (let offset = 0, part = 0; offset < tripIds.length; offset += TRIP_IDS_PER_PART, part++) {
      directionTrips.push({
        agency_id: row.agency_id,
        route_id: row.route_id,
        direction_id: row.direction_id,
        part,
        trip_ids: JSON.stringify(tripIds.slice(offset, offset + TRIP_IDS_PER_PART)),
      });
    }
  }

  const terminalByTrip = new Map<string, { stopId: string; sequence: number }>();
  const membership = new Map<string, Set<string>>();
  const routeStops = new Map<string, GtfsRow>();
  for (const [source, archive] of sources.entries()) {
    await processArchiveCsv(
      archive,
      "stop_times.txt",
      ["trip_id", "stop_id", "stop_sequence"],
      (get) => {
        const tripKey = scopedKey(source, get("trip_id"));
        const routeId = trips.get(tripKey);
        if (!routeId) return;
        const stopId = get("stop_id");
        if (!stopId) throw new Error("Empty GTFS stop id");
        const set = membership.get(stopId) ?? new Set<string>();
        set.add(routeId);
        membership.set(stopId, set);
        const sequence = Number.parseInt(get("stop_sequence"), 10);
        if (!Number.isFinite(sequence)) throw new Error("Invalid GTFS stop sequence");
        const terminal = terminalByTrip.get(tripKey);
        if (!terminal || sequence > terminal.sequence)
          terminalByTrip.set(tripKey, { stopId, sequence });
        const trip = canonicalTrips.get(tripKey);
        if (trip) {
          routeStops.set(JSON.stringify([trip.routeId, trip.directionId, sequence]), {
            agency_id: config.id,
            route_id: trip.routeId,
            direction_id: trip.directionId,
            stop_sequence: sequence,
            stop_id: stopId,
          });
        }
      },
    );
  }
  // Terminality belongs to a trip, including short turns and branches that
  // share a shape. Group identical terminal facts so D1 never writes one row
  // per trip. Keys and sorted chunks stay stable across unchanged reseeds.
  const terminalFacts = new Map<
    string,
    { routeId: string; directionId: number; stopId: string; sequence: number; tripId: string }
  >();
  for (const [tripKey, terminal] of terminalByTrip) {
    const group = resolved.get(tripGroupKeyByTrip.get(tripKey) ?? "");
    if (!group) continue;
    const tripId = (JSON.parse(tripKey) as [number, string])[1];
    // Later archives replace child facts for the same route/trip identity.
    terminalFacts.set(JSON.stringify([group.routeId, tripId]), {
      routeId: group.routeId,
      directionId: group.directionId,
      ...terminal,
      tripId,
    });
  }
  const terminalGroups = new Map<
    string,
    { routeId: string; directionId: number; stopId: string; sequence: number; tripIds: Set<string> }
  >();
  for (const terminal of terminalFacts.values()) {
    const key = JSON.stringify([
      terminal.routeId,
      terminal.directionId,
      terminal.stopId,
      terminal.sequence,
    ]);
    const row = terminalGroups.get(key) ?? { ...terminal, tripIds: new Set<string>() };
    row.tripIds.add(terminal.tripId);
    terminalGroups.set(key, row);
  }
  const tripTerminals: GtfsRow[] = [];
  for (const group of terminalGroups.values()) {
    const ids = [...group.tripIds].sort();
    for (let offset = 0, part = 0; offset < ids.length; offset += TRIP_IDS_PER_PART, part++) {
      tripTerminals.push({
        agency_id: config.id,
        route_id: group.routeId,
        direction_id: group.directionId,
        terminal_stop_id: group.stopId,
        terminal_stop_sequence: group.sequence,
        part,
        trip_ids: JSON.stringify(ids.slice(offset, offset + TRIP_IDS_PER_PART)),
      });
    }
  }
  // Trips sharing a headsign travel together in one row, as terminals do.
  const headsignFacts = new Map<string, { routeId: string; headsign: string; tripId: string }>();
  for (const [tripKey, headsign] of headsignByTrip) {
    const group = resolved.get(tripGroupKeyByTrip.get(tripKey) ?? "");
    if (!group) continue;
    const tripId = (JSON.parse(tripKey) as [number, string])[1];
    headsignFacts.set(JSON.stringify([group.routeId, tripId]), {
      routeId: group.routeId,
      headsign,
      tripId,
    });
  }
  const headsignGroups = new Map<
    string,
    { routeId: string; headsign: string; tripIds: string[] }
  >();
  for (const fact of headsignFacts.values()) {
    const key = JSON.stringify([fact.routeId, fact.headsign]);
    const row = headsignGroups.get(key) ?? { ...fact, tripIds: [] };
    row.tripIds.push(fact.tripId);
    headsignGroups.set(key, row);
  }
  const tripHeadsigns: GtfsRow[] = [];
  for (const group of headsignGroups.values()) {
    const ids = group.tripIds.sort();
    for (let offset = 0, part = 0; offset < ids.length; offset += TRIP_IDS_PER_PART, part++) {
      tripHeadsigns.push({
        agency_id: config.id,
        route_id: group.routeId,
        headsign: group.headsign,
        part,
        trip_ids: JSON.stringify(ids.slice(offset, offset + TRIP_IDS_PER_PART)),
      });
    }
  }
  const points = new Map<string, Array<{ lat: number; lon: number; seq: number }>>();
  for (const [source, archive] of sources.entries()) {
    if (!canonical.some((shape) => shape.source === source)) continue;
    await processArchiveCsv(
      archive,
      "shapes.txt",
      ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"],
      (get) => {
        const key = scopedKey(source, get("shape_id"));
        if (!selectedShapes.has(key)) return;
        const point = {
          lat: Number.parseFloat(get("shape_pt_lat")),
          lon: Number.parseFloat(get("shape_pt_lon")),
          seq: Number.parseInt(get("shape_pt_sequence"), 10),
        };
        if (!Object.values(point).every(Number.isFinite))
          throw new Error("Invalid GTFS shape point");
        const list = points.get(key) ?? [];
        list.push(point);
        points.set(key, list);
      },
    );
  }
  const stops = new Map<string, GtfsRow>();
  for (const archive of sources) {
    await processArchiveCsv(
      archive,
      "stops.txt",
      ["stop_id", "stop_name", "stop_lat", "stop_lon"],
      (get) => {
        const id = get("stop_id");
        if (!membership.has(id)) return;
        const locationType = get("location_type") ? Number.parseInt(get("location_type"), 10) : 0;
        if (Number.isFinite(locationType) && locationType !== 0) return;
        if (stops.has(id)) return;
        const lat = Number.parseFloat(get("stop_lat")),
          lon = Number.parseFloat(get("stop_lon"));
        if (!Number.isFinite(lat) || !Number.isFinite(lon))
          throw new Error(`Invalid GTFS stop coordinates: ${id}`);
        stops.set(id, {
          agency_id: config.id,
          id,
          code: get("stop_code") || null,
          name: get("stop_name"),
          lat,
          lon,
          wheelchair: normalizeWheelchairBoarding(
            Number.parseInt(get("wheelchair_boarding") || "0", 10),
          ),
          parent_station: get("parent_station") || null,
          routes_json: JSON.stringify([...(membership.get(id) ?? [])].sort()),
        });
      },
      (stopId) => membership.has(stopId),
    );
  }
  if (!stops.size) throw new Error("GTFS has no active stops");
  const shapes = new Map<string, GtfsRow>();
  for (const shape of canonical) {
    const raw = points.get(shape.shapeKey);
    if (!raw?.length) throw new Error(`Missing canonical shape points for ${shape.routeId}`);
    raw.sort((a, b) => a.seq - b.seq);
    const coords: CoordPair[] = raw.map((p) => [p.lat, p.lon]);
    const simplified = simplifyRdp(coords);
    const id = `${shape.routeId}_${shape.directionId}_canonical`;
    let minLat = Infinity,
      maxLat = -Infinity,
      minLon = Infinity,
      maxLon = -Infinity;
    for (const [lat, lon] of coords) {
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
    }
    shapes.set(id, {
      agency_id: config.id,
      id,
      route_id: shape.routeId,
      direction_id: shape.directionId,
      headsign: shape.headsign,
      polyline: encodePolyline(simplified),
      min_lat: minLat,
      max_lat: maxLat,
      min_lon: minLon,
      max_lon: maxLon,
      point_count: simplified.length,
      direction_label: deriveDirectionLabel(shape.headsign),
    });
  }
  const stopRoutes: GtfsRow[] = [];
  for (const id of stops.keys())
    for (const routeId of membership.get(id) ?? [])
      stopRoutes.push({ agency_id: config.id, stop_id: id, route_id: routeId });
  for (const row of routeStops.values())
    if (!stops.has(String(row.stop_id))) throw new Error(`Missing canonical stop ${row.stop_id}`);
  for (const route of config.vehicleOnlyRoutes ?? []) {
    if (routes.has(route.id))
      throw new Error(`Vehicle-only service collides with GTFS route ${route.id}`);
    routes.set(route.id, {
      agency_id: config.id,
      id: route.id,
      short_name: route.shortName,
      long_name: route.longName,
      route_type: 3,
      color: config.defaultColor,
      text_color: config.defaultTextColor,
    });
  }
  return {
    routes: [...routes.values()],
    stops: [...stops.values()],
    route_shapes: [...shapes.values()],
    route_stops: [...routeStops.values()],
    route_direction_trips: directionTrips,
    route_trip_terminals: tripTerminals,
    route_trip_headsigns: tripHeadsigns,
    stop_routes: stopRoutes,
  };
}
