import { createHash } from "node:crypto";
import { Schema } from "effect";
import {
  InterchangeOverridesSchema,
  type InterchangeEndpoint,
  type InterchangeExclusion,
  type InterchangeHub,
  type InterchangeOverrides,
} from "~/domain/map/Interchange";
import { calculateHaversineMeters } from "~/domain/map/MapGeometry";
import type { Schematic, SchematicStationId } from "~/agencies/types";
import type { SeedTableRows } from "./gtfs-seeder-core";
import {
  resolveInterchangeBadgeOffsets,
  type InterchangePlacementOptions,
} from "./interchange-placement";

export interface CanonicalStationIdentity {
  readonly id: SchematicStationId;
  readonly name: string;
  /** Feed-owned location constrains name matching to the physical station. */
  readonly lat?: number;
  readonly lon?: number;
  readonly platformIds?: readonly string[];
}

export interface InterchangeStation {
  readonly agencyId: string;
  readonly id: string;
  /** Repository-owned schematic identity when this feed station is drawable. */
  readonly schematicId?: SchematicStationId;
  readonly feedStopIds?: readonly string[];
  /** Unmatched roadside stops may connect to a station, never to one another. */
  readonly roadside?: boolean;
  readonly boardingStopIds?: readonly string[];
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
}

/** Normalizes only upstream station naming noise; overrides own true aliases. */
export function normalizeInterchangeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(?:towards?|to|vers)\b.*$/g, " ")
    .replace(/\b(?:platform|bay|quai|voie)\s*\d+\b/g, " ")
    .replace(
      /\b(?:go|station|terminal|bus|platform|bay|subway|rail|streetcar|eastbound|westbound|northbound|southbound)\b/g,
      " ",
    )
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

export function stationsFromSeededTables(
  agencyId: string,
  tables: readonly SeedTableRows[],
  canonicalStations: readonly CanonicalStationIdentity[] = [],
  regionalStations: readonly CanonicalStationIdentity[] = [],
  canonicalAliases: Readonly<Record<string, SchematicStationId>> = {},
): readonly InterchangeStation[] {
  const routes = new Map<string, number>();
  const routesTable = tables.find((table) => table.table === "routes");
  for (const row of routesTable?.rows ?? []) {
    const id = String(row.id ?? "");
    if (id) routes.set(id, Number(row.route_type));
  }

  const grouped = new Map<
    string,
    {
      names: Map<string, number>;
      lat: number;
      lon: number;
      count: number;
      stopIds: string[];
      codeAlias?: string;
      rail: boolean;
    }
  >();
  const stopsTable = tables.find((table) => table.table === "stops");
  for (const row of stopsTable?.rows ?? []) {
    const id = String(row.id ?? "");
    const routeIds = parseRouteIds(row.routes_json);
    if (!id || !routeIds.some((routeId) => routes.has(routeId))) continue;

    const name = String(row.name ?? "").trim();
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const groupId = String(row.parent_station ?? "") || id;
    const group = grouped.get(groupId) ?? {
      names: new Map<string, number>(),
      lat: 0,
      lon: 0,
      count: 0,
      stopIds: new Array<string>(),
      rail: false,
    };
    group.rail ||= routeIds.some((id) => [0, 1, 2].includes(routes.get(id) ?? -1));
    const codeAlias = canonicalAliases[`code:${row.code}`];
    if (codeAlias) {
      if (!canonicalStations.some((station) => station.id === codeAlias))
        throw new Error(`[seed:interchanges] Unknown stop-code alias target "${codeAlias}"`);
      if (group.codeAlias && group.codeAlias !== codeAlias)
        throw new Error(
          `[seed:interchanges] Ambiguous stop-code aliases for station group "${groupId}"`,
        );
      group.codeAlias = codeAlias;
    }
    group.names.set(name, (group.names.get(name) ?? 0) + 1);
    group.lat += lat;
    group.lon += lon;
    group.count += 1;
    group.stopIds.push(id);
    grouped.set(groupId, group);
  }

  const servedStopIds = new Set([...grouped.values()].flatMap((group) => group.stopIds));
  return [...grouped.entries()]
    .map(([id, group]): InterchangeStation | undefined => {
      const nearby = (station: CanonicalStationIdentity) =>
        station.lat === undefined ||
        station.lon === undefined ||
        calculateHaversineMeters(
          group.lat / group.count,
          group.lon / group.count,
          station.lat,
          station.lon,
        ) <= 350;
      const indexedMatches = canonicalStations.filter((station) =>
        station.platformIds?.some((stopId) => group.stopIds.includes(stopId)),
      );
      if (indexedMatches.length > 1)
        throw ambiguousStationName([...group.names.keys()].join(" | "), indexedMatches);
      const canonical = indexedMatches[0]
        ? { ...indexedMatches[0], owned: true }
        : group.codeAlias
          ? { ...canonicalStations.find((station) => station.id === group.codeAlias)!, owned: true }
          : canonicalStationForGroup(
              group.names,
              canonicalStations,
              regionalStations.filter(nearby),
              canonicalAliases,
            );
      const identity =
        canonical && (indexedMatches.length > 0 || nearby(canonical)) ? canonical : undefined;
      const feedName = [...group.names.keys()][0]!;
      return {
        agencyId,
        id,
        name: identity?.name ?? feedName,
        ...(identity === undefined && !group.rail ? { roadside: true } : {}),
        lat: group.lat / group.count,
        lon: group.lon / group.count,
        ...(identity?.owned
          ? {
              schematicId: identity.id,
              boardingStopIds: [...new Set(identity.platformIds ?? group.stopIds)]
                .filter((id) => servedStopIds.has(id))
                .sort(),
            }
          : { feedStopIds: [...new Set(group.stopIds)].sort() }),
      };
    })
    .filter((station): station is InterchangeStation => station !== undefined)
    .sort((first, second) => first.id.localeCompare(second.id));
}

interface CandidateEdge {
  readonly first: InterchangeStation;
  readonly second: InterchangeStation;
}

/**
 * Builds a pair predicate that matches each station against the exclusion
 * endpoints once. Discovery tests every station pair, so matching per pair
 * would re-normalize the same names stations² × exclusions times.
 */
function createStationPairExclusionCheck(
  exclusions: readonly InterchangeExclusion[],
): (first: InterchangeStation, second: InterchangeStation) => boolean {
  if (exclusions.length === 0) return () => false;
  const sidesByStation = new Map<
    InterchangeStation,
    { readonly left: readonly number[]; readonly right: readonly number[] }
  >();
  const sidesOf = (station: InterchangeStation) => {
    let sides = sidesByStation.get(station);
    if (!sides) {
      const left: number[] = [];
      const right: number[] = [];
      exclusions.forEach((exclusion, index) => {
        if (stationMatchesEndpoint(station, exclusion.left)) left.push(index);
        if (stationMatchesEndpoint(station, exclusion.right)) right.push(index);
      });
      sides = { left, right };
      sidesByStation.set(station, sides);
    }
    return sides;
  };
  return (first, second) => {
    const a = sidesOf(first);
    const b = sidesOf(second);
    return (
      a.left.some((index) => b.right.includes(index)) ||
      b.left.some((index) => a.right.includes(index))
    );
  };
}

function stationMatchesEndpoint(
  station: InterchangeStation,
  endpoint: InterchangeEndpoint,
): boolean {
  if (station.agencyId !== endpoint.agencyId) return false;
  if (station.schematicId && endpoint.stationId) {
    return station.schematicId === endpoint.stationId;
  }
  return (
    normalizeInterchangeName(station.name) === normalizeInterchangeName(endpoint.stationName) &&
    ownsAnyStop(station, new Set(endpoint.feedStopIds ?? []))
  );
}

/**
 * Finds transit stations within 350m and clusters connected cross-agency pairs
 * into one multi-agency hub. Interchanges are mode-agnostic: a bus stop is a
 * valid peer when it serves the same physical station as rail or rapid transit,
 * even when the agencies use different station names.
 */
export function discoverInterchanges(
  candidates: readonly InterchangeStation[],
  maxDistanceMeters = 350,
  exclusions: readonly InterchangeExclusion[] = [],
  isolated: readonly InterchangeEndpoint[] = [],
  boardingIdentityAgencyIds: readonly string[] = [],
): readonly InterchangeHub[] {
  const stations = candidates.filter(
    (station) => !isolated.some((endpoint) => stationMatchesEndpoint(station, endpoint)),
  );
  const edges: CandidateEdge[] = [];
  const isStationPairExcluded = createStationPairExclusionCheck(exclusions);
  const anchors = stations.filter((station) => !station.roadside);
  const distance = (first: InterchangeStation, second: InterchangeStation) =>
    calculateHaversineMeters(first.lat, first.lon, second.lat, second.lon);
  // Latitude alone rejects most pairs, so it runs before the costlier exclusion and distance checks.
  const maxLatitudeDelta = maxDistanceMeters / 110_000;
  for (let i = 0; i < anchors.length; i += 1) {
    const first = anchors[i]!;
    for (let j = i + 1; j < anchors.length; j += 1) {
      const second = anchors[j]!;
      if (first.agencyId === second.agencyId) continue;
      if (Math.abs(first.lat - second.lat) > maxLatitudeDelta) continue;
      if (isStationPairExcluded(first, second)) continue;
      if (distance(first, second) <= maxDistanceMeters) edges.push({ first, second });
    }
  }
  // A roadside stop attaches to one physical station. It cannot bridge two
  // stations into a transfer hub merely because it sits between them.
  for (const stop of stations.filter((station) => station.roadside)) {
    let closest: InterchangeStation | undefined;
    let nearest = maxDistanceMeters;
    for (const anchor of anchors) {
      if (stop.agencyId === anchor.agencyId) continue;
      if (Math.abs(stop.lat - anchor.lat) > maxLatitudeDelta) continue;
      if (isStationPairExcluded(stop, anchor)) continue;
      const meters = distance(stop, anchor);
      if (meters < nearest) {
        closest = anchor;
        nearest = meters;
      }
    }
    if (closest) edges.push({ first: closest, second: stop });
  }

  const components = connectedComponents(edges);
  return components
    .map((component) => {
      const stationsByAgency = new Map<string, InterchangeStation[]>();
      for (const station of component) {
        const list = stationsByAgency.get(station.agencyId) ?? [];
        list.push(station);
        stationsByAgency.set(station.agencyId, list);
      }

      const endpoints = [...stationsByAgency.entries()]
        .map(([agencyId, candidates]) => {
          if (candidates.length === 1) return candidates[0]!;
          const peers = component.filter((s) => s.agencyId !== agencyId);
          const drawable = candidates.filter((candidate) => candidate.schematicId);
          // Boarding IDs establish which feed stops can join a drawable endpoint.
          // Legacy name-only candidates retain their closest-stop identity.
          const representatives =
            drawable.length > 0 &&
            candidates.some(
              (candidate) => candidate.feedStopIds?.length || candidate.boardingStopIds?.length,
            )
              ? drawable
              : candidates;
          let bestStation = representatives[0]!;
          let bestDistance = Infinity;
          for (const candidate of representatives) {
            for (const peer of peers) {
              const dist = calculateHaversineMeters(
                candidate.lat,
                candidate.lon,
                peer.lat,
                peer.lon,
              );
              if (dist < bestDistance) {
                bestDistance = dist;
                bestStation = candidate;
              }
            }
          }
          // Proximity discovers a transfer, but does not make every nearby
          // kerb a boarding platform of the selected facility.
          const strictBoardingIdentity = boardingIdentityAgencyIds.includes(agencyId);
          const boarding = candidates.filter((candidate) =>
            !strictBoardingIdentity
              ? distance(candidate, bestStation) <= maxDistanceMeters
              : bestStation.schematicId
                ? candidate.schematicId === bestStation.schematicId
                : normalizeInterchangeName(candidate.name) ===
                    normalizeInterchangeName(bestStation.name) &&
                  distance(candidate, bestStation) <= maxDistanceMeters,
          );
          const stopIds = [
            ...new Set(
              boarding.flatMap(
                (candidate) => candidate.feedStopIds ?? candidate.boardingStopIds ?? [],
              ),
            ),
          ].sort();
          return stopIds.length > 0 && (strictBoardingIdentity || boarding.length > 1)
            ? { ...bestStation, feedStopIds: stopIds }
            : bestStation;
        })
        .sort((first, second) => first.agencyId.localeCompare(second.agencyId))
        .map((station) => endpointFromStation(station.agencyId, station));
      const normalizedName = normalizeInterchangeName(component[0]?.name ?? "");
      return {
        id: `${endpoints.map((endpoint) => endpoint.agencyId).join("-")}-${slugify(normalizedName)}`,
        endpoints,
      } satisfies InterchangeHub;
    })
    .filter((hub) => hub.endpoints.length >= 2)
    .reduce<InterchangeHub[]>(mergeSameStationHubs, [])
    .sort((first, second) => first.id.localeCompare(second.id));
}

/** Drawn station pairs joined by separate platform pairs, such as two kerbs, form one hub. */
function mergeSameStationHubs(hubs: InterchangeHub[], hub: InterchangeHub): InterchangeHub[] {
  const drawnStationPairKey = (candidate: InterchangeHub) =>
    candidate.endpoints.every((endpoint) => endpoint.stationId)
      ? candidate.endpoints
          .map((endpoint) => `${endpoint.agencyId}:${endpoint.stationId}`)
          .join("|")
      : undefined;
  const key = drawnStationPairKey(hub);
  const index =
    key === undefined ? -1 : hubs.findIndex((existing) => drawnStationPairKey(existing) === key);
  if (index === -1) return [...hubs, hub];
  const existing = hubs[index]!;
  const merged = {
    ...existing,
    endpoints: existing.endpoints.map((endpoint, position) => {
      const stopIds = [
        ...new Set([
          ...(endpoint.feedStopIds ?? []),
          ...(hub.endpoints[position]!.feedStopIds ?? []),
        ]),
      ].sort();
      return stopIds.length > 0 ? { ...endpoint, feedStopIds: stopIds } : endpoint;
    }),
  };
  return hubs.map((candidate, position) => (position === index ? merged : candidate));
}

function matchesOverrideId(hubId: string, overrideId?: string): boolean {
  if (!overrideId) return false;
  if (hubId === overrideId) return true;
  const hubParts = hubId.split("-");
  const overrideParts = overrideId.split("-");
  if (hubParts.length !== overrideParts.length) return false;
  const hubSlug = hubParts[hubParts.length - 1];
  const overrideSlug = overrideParts[overrideParts.length - 1];
  if (hubSlug !== overrideSlug) return false;
  const hubAgencies = hubParts.slice(0, -1).sort().join("-");
  const overrideAgencies = overrideParts.slice(0, -1).sort().join("-");
  return hubAgencies === overrideAgencies;
}

type OverrideIdParts = {
  readonly agencyList: readonly string[];
  readonly rawStationSlug: string;
  readonly normalizedStationSlug: string;
};

type StationPair = readonly [InterchangeStation, InterchangeStation];

function parseOverrideId(
  overrideId: string,
  stations: readonly InterchangeStation[],
): OverrideIdParts | undefined {
  const parts = overrideId.split("-");
  const availableAgencies = new Set(stations.map((station) => station.agencyId));
  const agencyList: string[] = [];
  let partIndex = 0;
  while (partIndex < parts.length) {
    const agencyId = parts[partIndex]!;
    if (!availableAgencies.has(agencyId) || agencyList.includes(agencyId)) break;
    agencyList.push(agencyId);
    partIndex += 1;
  }
  if (agencyList.length < 2 || partIndex >= parts.length) return undefined;

  const stationParts = parts.slice(partIndex);
  return {
    agencyList,
    rawStationSlug: stationParts.join(""),
    normalizedStationSlug: normalizeInterchangeName(stationParts.join(" ")),
  };
}

function endpointFromStation(agencyId: string, station: InterchangeStation): InterchangeEndpoint {
  return {
    agencyId,
    stationName: station.name,
    ...(station.schematicId ? { stationId: station.schematicId } : {}),
    ...(station.feedStopIds ? { feedStopIds: station.feedStopIds } : {}),
  };
}

function findDirectStationMatch(
  agencyId: string,
  rawStationSlug: string,
  normalizedStationSlug: string,
  stations: readonly InterchangeStation[],
): InterchangeEndpoint | undefined {
  const candidates = stations.filter((station) => {
    if (station.agencyId !== agencyId) return false;
    const normalizedName = normalizeInterchangeName(station.name);
    if (!normalizedName) return false;
    return (
      normalizedName === rawStationSlug ||
      normalizedName === normalizedStationSlug ||
      rawStationSlug.startsWith(normalizedName) ||
      normalizedStationSlug.startsWith(normalizedName) ||
      normalizedName.startsWith(rawStationSlug) ||
      normalizedName.startsWith(normalizedStationSlug)
    );
  });
  const uniqueCandidates = [
    ...new Map(candidates.map((station) => [station.schematicId ?? station.id, station])).values(),
  ];
  if (uniqueCandidates.length > 1) {
    throw new Error(
      `[seed:interchanges] Ambiguous override station slug "${rawStationSlug}" for agency "${agencyId}" matches: ${uniqueCandidates.map((station) => `${station.schematicId ?? station.id} (${station.name})`).join(", ")}`,
    );
  }
  const station = uniqueCandidates[0];
  return station ? endpointFromStation(agencyId, station) : undefined;
}

function isConcatenatedStationPair(
  stationSlug: string,
  firstName: string,
  secondName: string,
): boolean {
  return stationSlug === `${firstName}${secondName}` || stationSlug === `${secondName}${firstName}`;
}

function hasNonEmptyStationPairPrefix(
  stationSlug: string,
  firstName: string,
  secondName: string,
): boolean {
  if (firstName.length === 0 || secondName.length === 0) return false;
  const firstPart = stationSlug.slice(0, -secondName.length);
  return (
    stationSlug.endsWith(secondName) && firstPart.length > 0 && firstName.startsWith(firstPart)
  );
}

function hasNonEmptyStationPairSuffix(
  stationSlug: string,
  firstName: string,
  secondName: string,
): boolean {
  if (firstName.length === 0 || secondName.length === 0) return false;
  const secondPart = stationSlug.slice(firstName.length);
  return (
    stationSlug.startsWith(firstName) && secondPart.length > 0 && secondName.startsWith(secondPart)
  );
}

function isStationPairMatch(
  first: InterchangeStation,
  second: InterchangeStation,
  rawStationSlug: string,
  normalizedStationSlug: string,
): boolean {
  const firstName = normalizeInterchangeName(first.name);
  const secondName = normalizeInterchangeName(second.name);
  return (
    isConcatenatedStationPair(rawStationSlug, firstName, secondName) ||
    isConcatenatedStationPair(normalizedStationSlug, firstName, secondName) ||
    hasNonEmptyStationPairPrefix(rawStationSlug, firstName, secondName) ||
    hasNonEmptyStationPairSuffix(rawStationSlug, firstName, secondName)
  );
}

function resolveStationPairEndpoints(
  agencyList: readonly string[],
  rawStationSlug: string,
  normalizedStationSlug: string,
  stations: readonly InterchangeStation[],
): readonly InterchangeEndpoint[] | undefined {
  if (agencyList.length !== 2) return undefined;
  const [firstAgency, secondAgency] = agencyList as [string, string];
  const firstStations = stations.filter((station) => station.agencyId === firstAgency);
  const secondStations = stations.filter((station) => station.agencyId === secondAgency);
  const pairMatches: StationPair[] = [];
  for (const first of firstStations) {
    for (const second of secondStations) {
      if (isStationPairMatch(first, second, rawStationSlug, normalizedStationSlug)) {
        pairMatches.push([first, second]);
      }
    }
  }
  const uniquePairMatches = [
    ...new Map(
      pairMatches.map(([first, second]) => [
        `${first.schematicId ?? first.id}\u0000${second.schematicId ?? second.id}`,
        [first, second] as StationPair,
      ]),
    ).values(),
  ];
  if (uniquePairMatches.length > 1) {
    throw new Error(
      `[seed:interchanges] Ambiguous override station slug "${rawStationSlug}" matches ${uniquePairMatches.length} station pairs`,
    );
  }
  const pair = uniquePairMatches[0];
  return pair
    ? [endpointFromStation(firstAgency, pair[0]), endpointFromStation(secondAgency, pair[1])]
    : undefined;
}

function discoveredComponentMatches(
  hub: InterchangeHub,
  agencyList: readonly string[],
  directMatches: readonly InterchangeEndpoint[],
): boolean {
  if (hub.endpoints.length < agencyList.length) return false;
  if (
    !agencyList.every(
      (agencyId) => hub.endpoints.filter((endpoint) => endpoint.agencyId === agencyId).length === 1,
    )
  ) {
    return false;
  }
  return directMatches.every((match) =>
    hub.endpoints.some((endpoint) => endpointsEqual(endpoint, match)),
  );
}

function inferDiscoveredComponentEndpoints(
  discovered: readonly InterchangeHub[],
  agencyList: readonly string[],
  directMatches: readonly (InterchangeEndpoint | undefined)[],
): readonly InterchangeEndpoint[] | undefined {
  const resolvedDirectMatches = directMatches.filter(
    (match): match is InterchangeEndpoint => match !== undefined,
  );
  if (resolvedDirectMatches.length === 0) return undefined;
  const matchingComponents = discovered.filter((hub) =>
    discoveredComponentMatches(hub, agencyList, resolvedDirectMatches),
  );
  return matchingComponents.length === 1 ? matchingComponents[0]!.endpoints : undefined;
}

function inferEndpointsFromId(
  overrideId: string,
  stations: readonly InterchangeStation[] = [],
  discovered: readonly InterchangeHub[] = [],
): readonly InterchangeEndpoint[] | undefined {
  if (!overrideId || stations.length === 0) return undefined;
  const idParts = parseOverrideId(overrideId, stations);
  if (!idParts) return undefined;

  const directMatches = idParts.agencyList.map((agencyId) =>
    findDirectStationMatch(
      agencyId,
      idParts.rawStationSlug,
      idParts.normalizedStationSlug,
      stations,
    ),
  );
  if (directMatches.every((match): match is InterchangeEndpoint => match !== undefined)) {
    return directMatches;
  }

  const pairEndpoints = resolveStationPairEndpoints(
    idParts.agencyList,
    idParts.rawStationSlug,
    idParts.normalizedStationSlug,
    stations,
  );
  return (
    pairEndpoints ??
    inferDiscoveredComponentEndpoints(discovered, idParts.agencyList, directMatches)
  );
}

export function mergeInterchanges(
  discovered: readonly InterchangeHub[],
  overrides: InterchangeOverrides,
  stations: readonly InterchangeStation[] = [],
): readonly InterchangeHub[] {
  const resolvedOverrides = resolveOverrideIdentities(overrides, stations);
  const merged = [...discovered];
  for (const override of resolvedOverrides.hubs) {
    const idReplacementIndex = merged.findIndex((hub) => matchesOverrideId(hub.id, override.id));
    const inferredEndpoints =
      override.endpoints ??
      (idReplacementIndex === -1 && override.id
        ? inferEndpointsFromId(override.id, stations, discovered)
        : undefined);
    const replacementIndex =
      idReplacementIndex !== -1
        ? idReplacementIndex
        : merged.findIndex(
            (hub) => inferredEndpoints !== undefined && sharesEndpointPair(hub, inferredEndpoints),
          );
    if (replacementIndex === -1) {
      if (!inferredEndpoints || inferredEndpoints.length < 2) {
        throw new Error(
          `[seed:interchanges] Hub override "${override.id ?? "unknown"}" cannot create a new hub without at least 2 endpoints`,
        );
      }
      merged.push({
        id:
          override.id ??
          `${inferredEndpoints.map((e) => e.agencyId).join("-")}-${slugify(normalizeInterchangeName(inferredEndpoints[0]!.stationName))}`,
        endpoints: inferredEndpoints,
        ...(override.badgeOffsets ? { badgeOffsets: override.badgeOffsets } : {}),
        ...(override.badgeLabel ? { badgeLabel: override.badgeLabel } : {}),
      });
    } else {
      const existing = merged[replacementIndex]!;
      merged[replacementIndex] = {
        ...existing,
        id: override.id ?? existing.id,
        endpoints:
          override.endpoints
            ?.map((endpoint) => {
              const discoveredEndpoint = existing.endpoints.find((candidate) =>
                endpointsEqual(candidate, endpoint),
              );
              return discoveredEndpoint?.feedStopIds && !endpoint.feedStopIds
                ? { ...endpoint, feedStopIds: discoveredEndpoint.feedStopIds }
                : endpoint;
            })
            .concat(
              existing.endpoints.filter(
                (candidate) =>
                  !override.endpoints?.some((endpoint) => endpoint.agencyId === candidate.agencyId),
              ),
            ) ?? existing.endpoints,
        ...(override.badgeOffsets !== undefined || existing.badgeOffsets !== undefined
          ? { badgeOffsets: { ...existing.badgeOffsets, ...override.badgeOffsets } }
          : {}),
        ...(override.badgeLabel !== undefined
          ? { badgeLabel: override.badgeLabel }
          : existing.badgeLabel !== undefined
            ? { badgeLabel: existing.badgeLabel }
            : {}),
      };
    }
  }
  return merged
    .flatMap((hub) => applyExclusions(hub, resolvedOverrides))
    .sort((first, second) => first.id.localeCompare(second.id));
}

export function compileInterchanges(
  stations: readonly InterchangeStation[],
  overrides: InterchangeOverrides,
  schematics: ReadonlyMap<string, Schematic> = new Map(),
  placement: InterchangePlacementOptions = {},
): readonly InterchangeHub[] {
  const resolvedOverrides = resolveOverrideIdentities(overrides, stations);
  const hubs = mergeInterchanges(
    discoverInterchanges(
      stations,
      350,
      resolvedOverrides.exclusions,
      resolvedOverrides.isolated,
      resolvedOverrides.boardingIdentityAgencyIds,
    ),
    overrides,
    stations,
  );
  const counts = new Map<string, number>();
  for (const hub of hubs) counts.set(hub.id, (counts.get(hub.id) ?? 0) + 1);
  const unique = hubs.map((hub) => {
    if (counts.get(hub.id) === 1) return hub;
    const identities = hub.endpoints
      .map((endpoint) => [
        endpoint.agencyId,
        endpoint.stationId ?? endpoint.feedStopIds ?? endpoint.stationName,
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const suffix = createHash("sha256")
      .update(JSON.stringify(identities))
      .digest("hex")
      .slice(0, 12);
    return { ...hub, id: `${hub.id}-${suffix}` };
  });
  for (const hub of unique)
    for (const endpoint of hub.endpoints) {
      const schematic = schematics.get(endpoint.agencyId);
      if (
        endpoint.stationId &&
        schematic &&
        !schematic.stations.some((station) => station.id === endpoint.stationId)
      )
        throw new Error(
          `[seed:interchanges] Unknown drawn station "${endpoint.agencyId}:${endpoint.stationId}"`,
        );
    }
  return resolveInterchangeBadgeOffsets(unique, schematics, placement);
}

export function decodeInterchangeOverrides(raw: unknown): InterchangeOverrides {
  return Schema.decodeUnknownSync(InterchangeOverridesSchema)(raw);
}

function parseRouteIds(value: unknown): readonly string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((routeId): routeId is string => typeof routeId === "string")
      : [];
  } catch {
    return [];
  }
}

function connectedComponents(edges: readonly CandidateEdge[]): InterchangeStation[][] {
  const components: InterchangeStation[][] = [];
  const visited = new Set<string>();
  const adjacency = new Map<string, InterchangeStation[]>();
  const stationByKey = new Map<string, InterchangeStation>();
  for (const edge of edges) {
    const firstKey = stationKey(edge.first);
    const secondKey = stationKey(edge.second);
    stationByKey.set(firstKey, edge.first);
    stationByKey.set(secondKey, edge.second);
    adjacency.set(firstKey, [...(adjacency.get(firstKey) ?? []), edge.second]);
    adjacency.set(secondKey, [...(adjacency.get(secondKey) ?? []), edge.first]);
  }

  for (const startKey of stationByKey.keys()) {
    if (visited.has(startKey)) continue;
    const component: InterchangeStation[] = [];
    const queue = [startKey];
    visited.add(startKey);
    while (queue.length > 0) {
      const key = queue.shift()!;
      const station = stationByKey.get(key);
      if (station) component.push(station);
      for (const next of adjacency.get(key) ?? []) {
        const nextKey = stationKey(next);
        if (!visited.has(nextKey)) {
          visited.add(nextKey);
          queue.push(nextKey);
        }
      }
    }
    components.push(component);
  }
  return components;
}

function stationKey(station: InterchangeStation): string {
  return `${station.agencyId}\u0000${station.id}`;
}

function hubContainsPair(
  hub: InterchangeHub,
  left: InterchangeEndpoint,
  right: InterchangeEndpoint,
): boolean {
  return (
    hub.endpoints.some((endpoint) => endpointsEqual(endpoint, left)) &&
    hub.endpoints.some((endpoint) => endpointsEqual(endpoint, right))
  );
}

function applyExclusions(
  hub: InterchangeHub,
  overrides: InterchangeOverrides,
): readonly InterchangeHub[] {
  const excludedPairs = overrides.exclusions.flatMap((exclusion) => {
    const left = hub.endpoints.find((endpoint) =>
      excludedEndpointMatches(endpoint, exclusion.left),
    );
    const right = hub.endpoints.find((endpoint) =>
      excludedEndpointMatches(endpoint, exclusion.right),
    );
    return left && right ? [{ left, right }] : [];
  });
  if (excludedPairs.length === 0) return [hub];
  if (hub.endpoints.length === 2) return [];
  return [{ ...hub, excludedPairs }];
}

/** An exclusion endpoint that declares feed stops only matches endpoints serving one of them. */
function excludedEndpointMatches(hubEndpoint: InterchangeEndpoint, excluded: InterchangeEndpoint) {
  if (!endpointsEqual(hubEndpoint, excluded)) return false;
  const declared = new Set(excluded.feedStopIds ?? []);
  if (declared.size === 0 || !hubEndpoint.feedStopIds) return true;
  return hubEndpoint.feedStopIds.some((id) => declared.has(id));
}

function endpointsEqual(first: InterchangeEndpoint, second: InterchangeEndpoint): boolean {
  if (first.agencyId !== second.agencyId) return false;
  if (first.stationId && second.stationId) return first.stationId === second.stationId;
  return (
    normalizeInterchangeName(first.stationName) === normalizeInterchangeName(second.stationName)
  );
}

function sharesEndpointPair(
  first: InterchangeHub,
  second: readonly InterchangeEndpoint[],
): boolean {
  if (second.length < 2) return false;
  return second.some((left, leftIndex) =>
    second.some(
      (right, rightIndex) => leftIndex < rightIndex && hubContainsPair(first, left, right),
    ),
  );
}

/**
 * A declared stop list narrows same-name stations in one agency, so an
 * override can address one place when the name repeats elsewhere. An empty
 * list narrows nothing.
 */
function ownsAnyStop(station: InterchangeStation, stopIds: ReadonlySet<string>): boolean {
  if (stopIds.size === 0) return true;
  return [...(station.feedStopIds ?? []), ...(station.boardingStopIds ?? [])].some((id) =>
    stopIds.has(id),
  );
}

/**
 * Resolves only seed-time name-only overrides against the feed station table.
 * A unique drawable match is enriched with its schematic ID; a mapless match
 * retains its boarding stop IDs. Multiple identities are an authoring error, never a
 * reason to choose the first candidate.
 */
function resolveOverrideIdentities(
  overrides: InterchangeOverrides,
  stations: readonly InterchangeStation[],
): InterchangeOverrides {
  const resolveEndpoint = (endpoint: InterchangeEndpoint): InterchangeEndpoint => {
    if (endpoint.stationId || stations.length === 0) return endpoint;
    const normalizedName = normalizeInterchangeName(endpoint.stationName);
    if (!normalizedName) return endpoint;
    const declaredStopIds = new Set(endpoint.feedStopIds ?? []);
    const candidates = [
      ...new Map(
        stations
          .filter(
            (station) =>
              station.agencyId === endpoint.agencyId &&
              normalizeInterchangeName(station.name) === normalizedName &&
              ownsAnyStop(station, declaredStopIds),
          )
          .map((station) => [station.schematicId ?? station.id, station]),
      ).values(),
    ];
    if (declaredStopIds.size > 0 && candidates.length === 0) {
      throw new Error(
        `[seed:interchanges] Name-only endpoint "${endpoint.stationName}" for agency "${endpoint.agencyId}" declares feedStopIds that match no station: ${[...declaredStopIds].join(", ")}`,
      );
    }
    if (
      candidates.length > 1 &&
      candidates.every(
        (candidate) =>
          !candidate.schematicId &&
          calculateHaversineMeters(
            candidate.lat,
            candidate.lon,
            candidates[0]!.lat,
            candidates[0]!.lon,
          ) <= 350,
      )
    ) {
      return {
        ...endpoint,
        feedStopIds: [
          ...new Set(candidates.flatMap((candidate) => candidate.feedStopIds ?? [])),
        ].sort(),
      };
    }
    if (candidates.length > 1) {
      throw new Error(
        `[seed:interchanges] Ambiguous name-only endpoint "${endpoint.stationName}" for agency "${endpoint.agencyId}" matches: ${candidates.map((station) => `${station.schematicId ?? station.id} (${station.name})`).join(", ")}`,
      );
    }
    const candidate = candidates[0];
    return candidate
      ? {
          ...endpoint,
          ...endpointFromStation(endpoint.agencyId, candidate),
          stationName: endpoint.stationName,
        }
      : endpoint;
  };
  const resolveEndpoints = (endpoints: readonly InterchangeEndpoint[]) =>
    endpoints.map(resolveEndpoint);

  return {
    hubs: overrides.hubs.map((hub) =>
      hub.endpoints ? { ...hub, endpoints: resolveEndpoints(hub.endpoints) } : hub,
    ),
    exclusions: overrides.exclusions.map((exclusion) => ({
      left: resolveEndpoint(exclusion.left),
      right: resolveEndpoint(exclusion.right),
    })),
    isolated: overrides.isolated?.map(resolveEndpoint),
    boardingIdentityAgencyIds: overrides.boardingIdentityAgencyIds,
  };
}

function slugify(value: string): string {
  return value || "unnamed";
}

function canonicalStationIdentity(
  name: string,
  canonicalStations: readonly CanonicalStationIdentity[],
  regionalStations: readonly CanonicalStationIdentity[] = [],
  canonicalAliases: Readonly<Record<string, SchematicStationId>> = {},
): (CanonicalStationIdentity & { readonly owned: boolean }) | undefined {
  if (ingestionStationKeys(name).length === 0) return undefined;
  if (canonicalStations.length === 0 && regionalStations.length === 0) {
    return { id: "", name, owned: false };
  }
  const inputKeys = ingestionStationKeys(name);
  const aliasIds = [
    ...new Set(
      Object.entries(canonicalAliases)
        .filter(([alias]) => ingestionStationKeys(alias).some((key) => inputKeys.includes(key)))
        .map(([, id]) => id),
    ),
  ];
  if (aliasIds.length > 1) {
    throw new Error(
      `[seed:interchanges] Ambiguous schematic aliases for "${name}" resolve to: ${aliasIds.join(", ")}`,
    );
  }
  const aliasId = aliasIds[0];
  if (aliasId) {
    const aliasMatches = canonicalStations.filter((station) => station.id === aliasId);
    if (aliasMatches.length !== 1) {
      throw new Error(
        `[seed:interchanges] Schematic alias for "${name}" references unknown or ambiguous station id "${aliasId}"`,
      );
    }
    return { ...aliasMatches[0]!, owned: true };
  }

  const ownMatches = canonicalStationMatches(canonicalStations, name);
  if (ownMatches.length > 1) {
    throw ambiguousStationName(name, ownMatches);
  }
  if (ownMatches.length === 1) return { ...ownMatches[0]!, owned: true };

  const regionalMatches = canonicalStationMatches(regionalStations, name);
  if (new Set(regionalMatches.map((station) => station.name)).size > 1) {
    throw ambiguousStationName(name, regionalMatches);
  }
  return regionalMatches[0] ? { ...regionalMatches[0], owned: false } : undefined;
}

function canonicalStationForGroup(
  names: ReadonlyMap<string, number>,
  canonicalStations: readonly CanonicalStationIdentity[],
  regionalStations: readonly CanonicalStationIdentity[],
  canonicalAliases: Readonly<Record<string, SchematicStationId>>,
): (CanonicalStationIdentity & { readonly owned: boolean }) | undefined {
  const candidates = [...names.entries()]
    .sort(
      ([firstName, firstCount], [secondName, secondCount]) =>
        secondCount - firstCount || firstName.localeCompare(secondName),
    )
    .map(([name]) =>
      canonicalStationIdentity(name, canonicalStations, regionalStations, canonicalAliases),
    )
    .filter(
      (candidate): candidate is CanonicalStationIdentity & { readonly owned: boolean } =>
        candidate !== undefined,
    );
  const unique = [
    ...new Map(
      candidates.map((candidate) => [
        candidate.owned ? `owned:\u0000${candidate.id}` : `regional:\u0000${candidate.name}`,
        candidate,
      ]),
    ).values(),
  ];
  if (unique.length > 1) {
    throw ambiguousStationName([...names.keys()].join(" | "), unique);
  }
  return unique[0];
}

function canonicalStationMatches(
  stations: readonly CanonicalStationIdentity[],
  upstreamName: string,
): readonly CanonicalStationIdentity[] {
  for (const key of ingestionStationKeys(upstreamName)) {
    const matches = stations.filter((candidate) =>
      ingestionStationKeys(candidate.name).includes(key),
    );
    if (matches.length > 0) return matches;
  }
  return [];
}

/**
 * Feed-only station-name cleanup. It deliberately keeps semantic words such
 * as "terminal" so Newmarket and Newmarket Terminal remain distinct, then
 * offers a less-specific fallback for feeds that append a terminal suffix to
 * a canonical station name.
 */
function ingestionStationKeys(name: string): readonly string[] {
  const normalized = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(?:platform|bay)(?:\s*\d+)?\b/g, " ")
    .replace(
      /\b(?:at|go|station|bus|subway|rail|streetcar|eastbound|westbound|northbound|southbound)\b/g,
      " ",
    )
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (!normalized) return [];
  const keys = [normalized];
  const withoutTerminal = normalized.replace(/\s+terminal$/, "");
  if (withoutTerminal && withoutTerminal !== normalized) keys.push(withoutTerminal);
  return keys;
}

function ambiguousStationName(
  upstreamName: string,
  matches: readonly CanonicalStationIdentity[],
): Error {
  return new Error(
    `[seed:interchanges] Ambiguous station name "${upstreamName}" matches schematic stations: ${matches.map((station) => `${station.id} (${station.name})`).join(", ")}`,
  );
}
