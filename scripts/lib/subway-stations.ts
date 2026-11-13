import { alertStationKey } from "~/domain/stationAlerts";
import type {
  SchematicStationId,
  SchematicStationIndexEntry as SubwayStationIndexEntry,
} from "~/agencies/types";

/**
 * Pure GTFS stops.txt → subway station geo-index transform.
 *
 * Shared by scripts/seed.ts (full ETL) so the committed static artifact
 * the stationIndex in src/agencies/ca/on/ttc/schematic.json stays reproducible, and by
 * its unit tests via synthetic stops.txt fixtures. No filesystem or network
 * access here.
 *
 * Parent stations (location_type=1), or top-level station rows in feeds that
 * omit the parent hierarchy, are mapped onto canonical line names from the
 * provider schematic's sequences and aliases, so feed platform ids land on
 * the names the provider declaration already speaks.
 *
 * Committed stationIndex blocks are this transform's output, not source:
 * never hand-edit them (see CODING_STANDARDS.md "Generated station data").
 */

export interface GtfsStopRow {
  readonly stopId: string;
  readonly stopCode?: string;
  readonly stopName: string;
  readonly stopLat: number;
  readonly stopLon: number;
  /** GTFS location_type: 0 = platform, 1 = parent station. */
  readonly locationType: number;
  readonly parentStation: string | null;
}

export interface UnmatchedPlatform {
  readonly stopId: string;
  readonly name: string;
  readonly parentStation: string | null;
  /** Whether the parent itself resolved to a schematic station (real failure) or not (out-of-scope terminal). */
  readonly knownParent: boolean;
}

export interface SubwayStationsArtifact {
  readonly stations: readonly SubwayStationIndexEntry[];
  /**
   * Platforms that could not be attached to a canonical provider station.
   * Surfaced loudly at seed time instead of being silently dropped.
   */
  readonly unmatchedPlatforms: readonly UnmatchedPlatform[];
  /**
   * Top-level stops that directly match a schematic station but were skipped
   * because the feed declares parent stations and no explicit alias covers
   * them. Each is a ready-made `stationAliases` entry for the curator to
   * accept or deliberately ignore.
   */
  readonly aliasCandidates: readonly AliasCandidate[];
}

export interface AliasCandidate {
  readonly stopName: string;
  readonly schematicId: SchematicStationId;
}

/**
 * Curated sequence stations left with no feed platforms in the merged index.
 * A station listed here loses departures and alert resolution until its
 * sequences entry, aliases, or feed mapping are fixed.
 */
export function findStationsWithoutPlatforms(
  lineSequences: Readonly<Record<string, readonly SchematicStationId[]>>,
  stationIndex: readonly SubwayStationIndexEntry[],
): readonly SchematicStationId[] {
  const covered = new Set(
    stationIndex
      .filter((station) => station.platformIds.length > 0)
      .map((station) => station.schematicId ?? station.id),
  );
  return [...new Set(Object.values(lineSequences).flatMap((sequence) => [...sequence]))].filter(
    (stationId) => !covered.has(stationId),
  );
}

/**
 * Manifest-declared popular routes with no home in the feed: absent from
 * `route_short_name` ids and from both sides of the `routeLineMap` folding.
 */
export function findMissingPopularRoutes(
  popularRoutes: readonly string[],
  feedRouteIds: readonly string[],
  routeLineMap: Readonly<Record<string, string>> = {},
): readonly string[] {
  const known = new Set([
    ...feedRouteIds,
    ...Object.keys(routeLineMap),
    ...Object.values(routeLineMap),
  ]);
  return popularRoutes.filter((routeId) => !known.has(routeId));
}

/** Collects `route_short_name` ids (falling back to `route_id`) from routes.txt. */
export function parseGtfsRouteIds(routesTxt: string): string[] {
  const ids: string[] = [];
  let header: string[] | null = null;
  for (const rawLine of routesTxt.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const fields = splitCsvLine(rawLine);
    if (!header) {
      header = fields.map((field) => field.trim());
      continue;
    }
    const shortIdx = header.indexOf("route_short_name");
    const idIdx = header.indexOf("route_id");
    const id =
      (shortIdx >= 0 ? fields[shortIdx]?.trim() : "") || (idIdx >= 0 ? fields[idIdx]?.trim() : "");
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * Refreshes feed-owned identity fields without discarding curated station labels
 * or customized properties (such as directionTermini and curated IDs).
 */
export function mergeStationIndex(
  existing: readonly SubwayStationIndexEntry[],
  generated: readonly SubwayStationIndexEntry[],
  lineSequences?: Readonly<Record<string, readonly SchematicStationId[]>>,
): readonly SubwayStationIndexEntry[] {
  const matchedExisting = new Map<SubwayStationIndexEntry, SubwayStationIndexEntry>();
  const matchedGenerated = new Set<SubwayStationIndexEntry>();

  const generatedById = new Map<string, SubwayStationIndexEntry>();
  for (const gen of generated) {
    generatedById.set(gen.id, gen);
  }

  // Pass 1: exact ID match.
  for (const station of existing) {
    const refreshed = generatedById.get(station.id);
    if (refreshed && !matchedGenerated.has(refreshed)) {
      matchedExisting.set(station, refreshed);
      matchedGenerated.add(refreshed);
    }
  }

  // Pass 2: match by schematicId for unmatched entries.
  const unmatchedGeneratedBySchematicId = new Map<string, SubwayStationIndexEntry[]>();
  for (const gen of generated) {
    if (matchedGenerated.has(gen)) continue;
    const key = gen.schematicId ?? gen.id;
    const list = unmatchedGeneratedBySchematicId.get(key) ?? [];
    list.push(gen);
    unmatchedGeneratedBySchematicId.set(key, list);
  }

  for (const station of existing) {
    if (matchedExisting.has(station)) continue;
    const key = station.schematicId ?? station.id;
    const candidates = unmatchedGeneratedBySchematicId.get(key);
    if (candidates && candidates.length === 1) {
      const refreshed = candidates[0]!;
      matchedExisting.set(station, refreshed);
      matchedGenerated.add(refreshed);
      unmatchedGeneratedBySchematicId.delete(key);
    }
  }

  const sequenceStationIds = lineSequences
    ? new Set(Object.values(lineSequences).flatMap((seq) => [...seq]))
    : null;

  const result: SubwayStationIndexEntry[] = [];

  for (const station of existing) {
    const refreshed = matchedExisting.get(station);
    if (refreshed) {
      result.push({
        id: station.id,
        ...(refreshed.schematicId ? { schematicId: refreshed.schematicId } : {}),
        name: station.name,
        lat: refreshed.lat,
        lon: refreshed.lon,
        lines: refreshed.lines,
        platformIds: refreshed.platformIds,
        ...(refreshed.departureRouteIds ? { departureRouteIds: refreshed.departureRouteIds } : {}),
        ...(station.directionTermini ? { directionTermini: station.directionTermini } : {}),
      });
    } else if (!sequenceStationIds || sequenceStationIds.has(station.schematicId ?? station.id)) {
      result.push({
        id: station.id,
        ...(station.schematicId ? { schematicId: station.schematicId } : {}),
        name: station.name,
        lat: station.lat,
        lon: station.lon,
        lines: station.lines,
        platformIds: [],
        ...(station.directionTermini ? { directionTermini: station.directionTermini } : {}),
      });
    }
  }

  for (const gen of generated) {
    if (!matchedGenerated.has(gen)) {
      result.push(gen);
    }
  }

  return result;
}

function stationNameKeys(value: string): readonly string[] {
  const key = alertStationKey(value);
  const withoutGoSuffix = key.replace(/\s+go$/, "");
  return withoutGoSuffix === key ? [key] : [key, withoutGoSuffix];
}

/** Minimal RFC-4180-style CSV field splitter handling quoted commas/escapes. */
export function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += c;
    }
  }
  result.push(current.trim());
  return result;
}

/** Parses a complete stops.txt CSV document into typed rows. */
export function parseGtfsStopRows(stopsTxt: string): GtfsStopRow[] {
  const rows: GtfsStopRow[] = [];
  let idx: Record<string, number> | null = null;
  let sawHeader = false;

  for (const rawLine of stopsTxt.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    const fields = splitCsvLine(trimmed);
    if (!sawHeader) {
      sawHeader = true;
      const header = fields.map((h) => h.trim());
      idx = {};
      for (const key of [
        "stop_id",
        "stop_code",
        "stop_name",
        "stop_lat",
        "stop_lon",
        "location_type",
        "parent_station",
      ]) {
        idx[key] = header.indexOf(key);
      }
      continue;
    }

    const get = (key: string): string => {
      const i = idx![key];
      return i >= 0 ? (fields[i] ?? "") : "";
    };

    const locTypeRaw = get("location_type");
    rows.push({
      stopId: get("stop_id"),
      stopCode: get("stop_code") || undefined,
      stopName: get("stop_name"),
      stopLat: parseFloat(get("stop_lat")),
      stopLon: parseFloat(get("stop_lon")),
      locationType: locTypeRaw === "" ? 0 : parseInt(locTypeRaw, 10),
      parentStation: get("parent_station") || null,
    });
  }

  return rows;
}

/**
 * Builds the station geo index from parsed stops.txt rows.
 *
 * - Parent stations (location_type=1) matching a canonical provider line name
 *   become entries; interchange stations accumulate every serving line.
 * - Child platforms (location_type=0 with a resolvable parent) attach their
 *   stop_id to that station's platformIds.
 * - Platforms whose parent is not an indexed subway station are flagged as
 *   unmatched rather than silently dropped.
 */
export function buildSubwayStationIndex(
  rows: readonly GtfsStopRow[],
  lineSequences: Readonly<Record<string, readonly SchematicStationId[]>>,
  lineIds: readonly string[] = Object.keys(lineSequences),
  stationAliases: Readonly<Record<string, SchematicStationId>> = {},
  stationNames: ReadonlyMap<SchematicStationId, string> = new Map(),
): SubwayStationsArtifact {
  // normalized feed/display name → distinct canonical station identities.
  const canonicalByNormName = new Map<
    string,
    Array<{ lineId: string; id: SchematicStationId; name: string }>
  >();
  const canonicalById = new Map<
    SchematicStationId,
    Array<{ lineId: string; id: SchematicStationId; name: string }>
  >();
  const aliasesByKey = new Map<string, SchematicStationId>();
  const aliasesByCode = new Map<string, SchematicStationId>();
  const aliasesById = new Map<string, SchematicStationId>();
  for (const [alias, id] of Object.entries(stationAliases)) {
    if (alias.startsWith("id:")) {
      aliasesById.set(alias.slice(3), id);
      continue;
    }
    if (alias.startsWith("code:")) {
      aliasesByCode.set(alias.slice(5), id);
      continue;
    }
    const key = alertStationKey(alias);
    const previous = aliasesByKey.get(key);
    if (previous && previous !== id) {
      throw new Error(
        `[seed:station-index] Ambiguous schematic alias "${alias}" resolves to both "${previous}" and "${id}"`,
      );
    }
    aliasesByKey.set(key, id);
  }
  for (const lineId of lineIds) {
    for (const id of lineSequences[lineId] ?? []) {
      const name = stationNames.get(id) ?? id;
      const match = { lineId, id, name };
      const byId = canonicalById.get(id) ?? [];
      if (!byId.some((entry) => entry.lineId === lineId)) byId.push(match);
      canonicalById.set(id, byId);
      for (const norm of stationNameKeys(name)) {
        const existing = canonicalByNormName.get(norm) ?? [];
        if (!existing.some((e) => e.id === id && e.lineId === lineId)) {
          existing.push(match);
        }
        canonicalByNormName.set(norm, existing);
      }
    }
  }

  const resolveMatches = (
    upstreamName: string,
    stopCode?: string,
    stopId?: string,
  ): readonly { lineId: string; id: SchematicStationId; name: string }[] => {
    const aliasId =
      (stopId ? aliasesById.get(stopId) : undefined) ??
      (stopCode ? aliasesByCode.get(stopCode) : undefined) ??
      aliasesByKey.get(alertStationKey(upstreamName));
    const matches = aliasId
      ? (canonicalById.get(aliasId) ?? [])
      : stationNameKeys(upstreamName).flatMap((key) => canonicalByNormName.get(key) ?? []);
    const uniqueMatches = [...new Map(matches.map((match) => [match.id, match])).values()];
    if (uniqueMatches.length > 1) {
      throw new Error(
        `[seed:station-index] Ambiguous feed station name "${upstreamName}" matches schematic station ids: ${uniqueMatches.map((match) => `${match.id} (${match.name})`).join(", ")}`,
      );
    }
    if (aliasId && uniqueMatches.length === 0) {
      throw new Error(
        `[seed:station-index] Schematic alias for "${upstreamName}" references unknown station id "${aliasId}"`,
      );
    }
    return matches;
  };

  const stationsById = new Map<string, SubwayStationIndexEntry>();
  const stopIds = new Set(rows.map((row) => row.stopId));
  const parentIdsByCode = new Map<string, string[]>();
  for (const row of rows) {
    if (row.locationType !== 1 || !row.stopId || !row.stopCode) continue;
    const ids = parentIdsByCode.get(row.stopCode) ?? [];
    ids.push(row.stopId);
    parentIdsByCode.set(row.stopCode, ids);
  }
  const unmatchedPlatforms: UnmatchedPlatform[] = [];
  const aliasCandidatesByKey = new Map<string, AliasCandidate>();
  const hasStandardParentStations = rows.some((row) => row.locationType === 1);
  // Bus feeds mix terminal parents with on-street stops that carry no parent.
  // Top-level stops join the index via direct name matching only when the
  // feed declares no parent stations at all; when parents exist, top-level
  // stops must resolve through an explicit provider alias so subway entrances
  // and surface stops that merely share a name never pollute a station.

  // Parents first so every child can resolve against an emitted station.
  // Canonical parents WITHOUT coordinates are held as deferred candidates:
  // GTFS allows coordinate-less parent stations, so their position is derived
  // from child-platform coordinates once platforms are attached.
  const canonicalParents = new Map<
    string,
    {
      readonly row: GtfsStopRow;
      readonly matches: readonly { lineId: string; id: SchematicStationId; name: string }[];
    }
  >();
  const platformCoords = new Map<string, { lats: number[]; lons: number[] }>();

  for (const row of rows) {
    const isTopLevelStation = row.locationType === 0 && !row.parentStation;
    if ((row.locationType !== 1 && !isTopLevelStation) || !row.stopId) continue;
    if (
      isTopLevelStation &&
      hasStandardParentStations &&
      !aliasesByKey.has(alertStationKey(row.stopName)) &&
      !aliasesByCode.has(row.stopCode ?? "") &&
      !aliasesById.has(row.stopId)
    ) {
      const direct = resolveMatches(row.stopName, row.stopCode, row.stopId);
      if (direct.length > 0) {
        const schematicId = direct[0]!.id;
        if (
          ![...aliasCandidatesByKey.values()].some(
            (candidate) =>
              candidate.stopName === row.stopName && candidate.schematicId === schematicId,
          )
        ) {
          aliasCandidatesByKey.set(alertStationKey(row.stopName), {
            stopName: row.stopName,
            schematicId,
          });
        }
      }
      continue;
    }
    const matches = resolveMatches(row.stopName, row.stopCode, row.stopId);
    if (matches.length === 0) continue;

    canonicalParents.set(row.stopId, { row, matches });
    if (Number.isFinite(row.stopLat) && Number.isFinite(row.stopLon)) {
      const previous = stationsById.get(row.stopId);
      stationsById.set(row.stopId, {
        id: row.stopId,
        schematicId: matches[0].id,
        // Prefer the provider schematic's canonical spelling when one exists.
        name: matches[0].name,
        lat: previous?.lat ?? row.stopLat,
        lon: previous?.lon ?? row.stopLon,
        lines: [...new Set([...(previous?.lines ?? []), ...matches.map((m) => m.lineId)])].sort(),
        platformIds: [
          ...new Set([
            ...(previous?.platformIds ?? []),
            ...(isTopLevelStation ? [row.stopId] : []),
          ]),
        ].sort(),
      });
    }
  }

  const deferredPlatforms = new Map<string, GtfsStopRow[]>();
  for (const row of rows) {
    if (row.locationType !== 0 || !row.parentStation) continue;
    // Some feeds put a parent stop_code in parent_station. Only use that
    // fallback when no stop_id in the complete input owns the reference.
    let parentId = row.parentStation;
    if (!stopIds.has(parentId)) {
      const candidates = parentIdsByCode.get(parentId) ?? [];
      if (candidates.length > 1) {
        throw new Error(
          `[seed:station-index] Ambiguous parent_station "${parentId}" for stop "${row.stopId}" matches parent stop_code on stop ids: ${candidates.join(", ")}`,
        );
      }
      parentId = candidates[0] ?? parentId;
    }
    const station = stationsById.get(parentId);
    if (!station) {
      if (canonicalParents.has(parentId)) {
        // Parent exists but is waiting on derived coordinates.
        const pending = deferredPlatforms.get(parentId) ?? [];
        pending.push(row);
        deferredPlatforms.set(parentId, pending);
      } else {
        unmatchedPlatforms.push({
          stopId: row.stopId,
          name: row.stopName,
          parentStation: row.parentStation,
          knownParent: false,
        });
      }
      continue;
    }
    stationsById.set(parentId, {
      ...station,
      platformIds: [...station.platformIds, row.stopId].sort(),
    });
    if (Number.isFinite(row.stopLat) && Number.isFinite(row.stopLon)) {
      const acc = platformCoords.get(parentId) ?? { lats: [], lons: [] };
      acc.lats.push(row.stopLat);
      acc.lons.push(row.stopLon);
      platformCoords.set(parentId, acc);
    }
  }

  // Promote deferred coordinate-less parents whose platforms yield a mean
  // position; flag their platforms loudly when no coordinates are resolvable.
  for (const [parentId, platforms] of deferredPlatforms) {
    const parent = canonicalParents.get(parentId)!;
    const lats = platforms.map((p) => p.stopLat).filter((v) => Number.isFinite(v));
    const lons = platforms.map((p) => p.stopLon).filter((v) => Number.isFinite(v));

    if (lats.length > 0 && lons.length > 0 && lats.length === lons.length) {
      const matches = parent.matches;
      stationsById.set(parentId, {
        id: parentId,
        schematicId: matches[0].id,
        name: matches[0].name,
        lat: lats.reduce((a, b) => a + b, 0) / lats.length,
        lon: lons.reduce((a, b) => a + b, 0) / lons.length,
        lines: [...new Set(matches.map((m) => m.lineId))].sort(),
        platformIds: platforms.map((p) => p.stopId).sort(),
      });
    } else {
      for (const p of platforms) {
        unmatchedPlatforms.push({
          stopId: p.stopId,
          name: p.stopName,
          parentStation: parentId,
          knownParent: true,
        });
      }
    }
  }

  // Group feed entities by schematic station so bus networks with many
  // on-street stops (or duplicated terminal parents) collapse to one curated
  // entry per schematic id. Single parent-station entries keep their
  // upstream feed id (subway/rail style); everything else takes the
  // schematic id as its stable identity with the union of platforms/lines.
  const groupedBySchematic = new Map<string, SubwayStationIndexEntry[]>();
  for (const entry of stationsById.values()) {
    const key = entry.schematicId ?? entry.id;
    const group = groupedBySchematic.get(key) ?? [];
    group.push(entry);
    groupedBySchematic.set(key, group);
  }
  const aggregated: SubwayStationIndexEntry[] = [];
  for (const [schematicId, group] of groupedBySchematic) {
    const ordered = [...group].sort((a, b) => a.id.localeCompare(b.id));
    // Single feed entities keep their upstream id (subway/rail style).
    // Only genuinely multi-source groups collapse to the schematic id with
    // the union of platforms/lines (bus on-street + terminal parents).
    if (ordered.length === 1) {
      aggregated.push(ordered[0]!);
      continue;
    }
    const representative = ordered[0]!;
    aggregated.push({
      id: schematicId,
      schematicId: (representative.schematicId ?? schematicId) as SchematicStationId,
      name: representative.name,
      lat: representative.lat,
      lon: representative.lon,
      lines: [...new Set(ordered.flatMap((entry) => entry.lines))].sort(),
      platformIds: [...new Set(ordered.flatMap((entry) => entry.platformIds))].sort(),
    });
  }

  return {
    stations: aggregated.sort(
      (a, b) =>
        a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.id.localeCompare(b.id),
    ),
    unmatchedPlatforms: [...unmatchedPlatforms].sort(
      (a, b) =>
        a.stopId.localeCompare(b.stopId) ||
        a.parentStation?.localeCompare(b.parentStation ?? "") ||
        0,
    ),
    aliasCandidates: [...aliasCandidatesByKey.values()].sort(
      (a, b) => a.stopName.localeCompare(b.stopName) || a.schematicId.localeCompare(b.schematicId),
    ),
  };
}
