import type {
  AgencyAlert,
  AgencyStationReference,
  EquipmentOutage,
  SchematicStation,
  SchematicStationId,
  SchematicStationIndexEntry,
} from "~/agencies/types";
import { SEVERITY_RANK } from "~/domain/severity";

export type { EquipmentOutage };

export interface GroupedStationOutages {
  readonly escalators: readonly EquipmentOutage[];
  readonly elevators: readonly EquipmentOutage[];
  readonly others: readonly AgencyAlert[];
}

export interface StationStatusDisplay {
  readonly text: string;
  readonly color: string;
}

export const alertStationKey = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\bstation\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

export interface StationReferenceResolutionOptions {
  readonly stationIndex?: readonly SchematicStationIndexEntry[];
  readonly stationAliases?: Readonly<Record<string, SchematicStationId>>;
  readonly schematicStations?: readonly Pick<SchematicStation, "id" | "name">[];
}

function schematicStationsFor(
  options: StationReferenceResolutionOptions,
): readonly Pick<SchematicStation, "id" | "name">[] {
  if (options.schematicStations) return options.schematicStations;
  return (options.stationIndex ?? [])
    .filter(
      (station): station is SchematicStationIndexEntry & { schematicId: SchematicStationId } =>
        Boolean(station.schematicId),
    )
    .map((station) => ({ id: station.schematicId, name: station.name }));
}

/**
 * Resolves one raw feed/name reference at the alert adapter boundary.
 *
 * Feed and platform ids are authoritative only when the station index links
 * them to a schematic id. Names and aliases are resolved only against an
 * unambiguous schematic station; every other input remains name-only.
 */
const stationResolvers = new WeakMap<
  StationReferenceResolutionOptions,
  (value: string | undefined) => AgencyStationReference | undefined
>();

function stationResolver(options: StationReferenceResolutionOptions) {
  const exact = new Map<string, SchematicStationIndexEntry[]>();
  const names = new Map<string, Set<SchematicStationId>>();
  const aliases = new Map<string, Set<SchematicStationId>>();
  const canonical = new Map<SchematicStationId, string>();
  for (const station of schematicStationsFor(options)) {
    if (!canonical.has(station.id)) canonical.set(station.id, station.name);
    const key = alertStationKey(station.name);
    const ids = names.get(key) ?? new Set<SchematicStationId>();
    ids.add(station.id);
    names.set(key, ids);
  }
  for (const station of options.stationIndex ?? []) {
    if (station.schematicId && !canonical.has(station.schematicId))
      canonical.set(station.schematicId, station.name);
    for (const key of new Set([station.id, station.schematicId, ...station.platformIds])) {
      if (!key) continue;
      const matches = exact.get(key) ?? [];
      matches.push(station);
      exact.set(key, matches);
    }
  }
  for (const [alias, id] of Object.entries(options.stationAliases ?? {})) {
    const key = alertStationKey(alias);
    const ids = aliases.get(key) ?? new Set<SchematicStationId>();
    ids.add(id);
    aliases.set(key, ids);
  }
  const resolved = new Map<string, AgencyStationReference>();
  return (value: string | undefined): AgencyStationReference | undefined => {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    const cached = resolved.get(trimmed);
    if (cached) return cached;
    const matches = exact.get(trimmed) ?? [];
    let reference: AgencyStationReference = { stationName: trimmed };
    if (matches.length === 1) {
      const station = matches[0]!;
      reference = station.schematicId
        ? {
            stationId: station.schematicId,
            stationName: canonical.get(station.schematicId) ?? station.name,
          }
        : { stationName: station.name };
    } else if (matches.length === 0) {
      const key = alertStationKey(trimmed);
      const aliasIds = aliases.get(key);
      const aliasId = aliasIds?.size === 1 ? aliasIds.values().next().value : undefined;
      const ids =
        aliasIds?.size && (!aliasId || canonical.has(aliasId)) ? aliasIds : names.get(key);
      if (ids?.size === 1) {
        const id = ids.values().next().value!;
        const name = canonical.get(id);
        if (name) reference = { stationId: id, stationName: name };
      }
    }
    resolved.set(trimmed, reference);
    return reference;
  };
}

export function resolveAgencyStationReference(
  value: string | undefined,
  options: StationReferenceResolutionOptions = {},
): AgencyStationReference | undefined {
  let resolve = stationResolvers.get(options);
  if (!resolve) {
    resolve = stationResolver(options);
    stationResolvers.set(options, resolve);
  }
  return resolve(value);
}

export function resolveStationNameFromId(
  id?: string,
  stationIndex?: readonly SchematicStationIndexEntry[],
): string | undefined {
  const trimmed = id?.trim();
  if (!trimmed) return undefined;
  const station = stationIndex?.find(
    (candidate) =>
      candidate.id === trimmed ||
      candidate.schematicId === trimmed ||
      candidate.platformIds.includes(trimmed),
  );
  if (station) return station.name;
  return trimmed;
}

/** Resolves a feed-owned station or platform id to the schematic identity. */
export function resolveSchematicStationIdFromFeedId(
  feedId: string | undefined,
  stationIndex?: readonly SchematicStationIndexEntry[],
): SchematicStationId | undefined {
  const trimmed = feedId?.trim();
  if (!trimmed) return undefined;
  return stationIndex?.find(
    (candidate) => candidate.id === trimmed || candidate.platformIds.includes(trimmed),
  )?.schematicId;
}

export function alertTargetRoutes(
  alert: Pick<AgencyAlert, "affectedLineIds" | "affectedRouteIds">,
): readonly string[] {
  return [...(alert.affectedLineIds ?? []), ...(alert.affectedRouteIds ?? [])];
}

export function alertStationReferences(
  alert: Pick<AgencyAlert, "affectedStations" | "fromStation" | "toStation" | "targets">,
): readonly AgencyStationReference[] {
  return [
    ...(alert.fromStation ? [alert.fromStation] : []),
    ...(alert.toStation ? [alert.toStation] : []),
    ...(alert.affectedStations ?? []),
    ...(alert.targets ?? []).flatMap((target) => (target.station ? [target.station] : [])),
  ];
}

export interface AlertStationRouteImpact {
  /** Whether structured targets identify this station at all. */
  readonly matched: boolean;
  /** Routes/lines that the alert targets at this station. */
  readonly routeIds: readonly string[];
}

/**
 * Narrows alert-wide route attribution to one station when the feed preserved
 * informed-entity route/stop pairs. An alert-wide route union is only a safe
 * fallback for legacy snapshots that have no structured station targets.
 */
export function alertStationRouteImpact(
  alert: Pick<AgencyAlert, "affectedLineIds" | "affectedRouteIds" | "targets">,
  stationId: SchematicStationId,
): AlertStationRouteImpact {
  const explicitTargets = (alert.targets ?? []).filter((target) => target.station?.stationId);
  if (explicitTargets.length === 0) {
    return { matched: true, routeIds: alertTargetRoutes(alert) };
  }

  const stationTargets = explicitTargets.filter(
    (target) => target.station?.stationId === stationId,
  );
  return {
    matched: stationTargets.length > 0,
    routeIds: [
      ...new Set(stationTargets.flatMap((target) => (target.routeId ? [target.routeId] : []))),
    ],
  };
}

export function isStationInAlertSpan(
  stationId: SchematicStationId,
  stationName: string,
  alert: AgencyAlert,
  stationLines?: readonly string[],
): boolean {
  if (
    alert.lifecycle === "expired" ||
    alert.lifecycle === "upcoming" ||
    alert.kind === "upcoming"
  ) {
    return false;
  }
  const key = alertStationKey(stationName);
  const references = alertStationReferences(alert);
  const stationMatches = references.some((station) =>
    station.stationId
      ? station.stationId === stationId
      : alertStationKey(station.stationName) === key,
  );
  if (!stationMatches) return false;

  // Station cards only display alerts directly impacting the station or its routes.
  // When the station's lines are known, alerts with route/line attribution must touch
  // at least one line serving this station (unless station-scoped accessibility).
  if (stationLines && stationLines.length > 0) {
    const stationImpact = alertStationRouteImpact(alert, stationId);
    if (!stationImpact.matched && alert.kind !== "accessibility") return false;
    const alertRoutes = stationImpact.routeIds;
    if (alertRoutes.length > 0 && alert.kind !== "accessibility") {
      const impactsStationRoute = alertRoutes.some((route) => stationLines.includes(route));
      if (!impactsStationRoute) return false;
    }
  }

  return true;
}

export function filterStationAlerts(
  alerts: readonly AgencyAlert[] | undefined,
  stationId: SchematicStationId,
  stationName: string,
  stationLines?: readonly string[],
): readonly AgencyAlert[] {
  return (alerts ?? []).filter((alert) =>
    isStationInAlertSpan(stationId, stationName, alert, stationLines),
  );
}

export function getUniqueServiceAlerts(
  stationAlerts: readonly AgencyAlert[],
): readonly AgencyAlert[] {
  const seen = new Set<string>();
  return stationAlerts.filter((alert) => {
    if (alert.kind === "accessibility") return false;
    const key = `${alert.title ?? ""}|${alert.description ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Whether an advisory description adds information beyond its title. */
export function hasDistinctAlertDescription(
  alert: Pick<AgencyAlert, "title" | "description">,
): boolean {
  const description = alert.description?.trim();
  return Boolean(description && description.toLowerCase() !== alert.title.trim().toLowerCase());
}

export interface StationServiceAlertGroup {
  readonly alerts: readonly AgencyAlert[];
  readonly representative: AgencyAlert;
}

/**
 * Groups concurrent service advisories that describe the same line-level
 * condition at a station. Feed adapters commonly publish one advisory per
 * direction or segment; a station card should expose one summary row and let
 * the rider expand the underlying advisories when needed.
 */
export function getStationServiceAlertGroups(
  stationAlerts: readonly AgencyAlert[],
): readonly StationServiceAlertGroup[] {
  const grouped = new Map<string, AgencyAlert[]>();

  for (const alert of stationAlerts) {
    const lineIds = [...(alert.affectedLineIds ?? []), ...(alert.affectedRouteIds ?? [])].sort();
    const key =
      lineIds.length > 0
        ? `${alert.kind}|${alert.severity}|${lineIds.join(",")}`
        : `alert:${alert.id}`;
    const alerts = grouped.get(key);
    if (alerts) alerts.push(alert);
    else grouped.set(key, [alert]);
  }

  return [...grouped.values()]
    .map((alerts) => {
      const ordered = [...alerts].sort((a, b) => b.updatedAt - a.updatedAt);
      return { alerts: ordered, representative: ordered[0]! };
    })
    .sort((a, b) => {
      const severity =
        SEVERITY_RANK[b.representative.severity] - SEVERITY_RANK[a.representative.severity];
      if (severity !== 0) return severity;
      return b.representative.updatedAt - a.representative.updatedAt;
    });
}

export function getGroupedStationOutages(
  stationAlerts: readonly AgencyAlert[],
): GroupedStationOutages {
  const escalators: EquipmentOutage[] = [];
  const elevators: EquipmentOutage[] = [];
  const others: AgencyAlert[] = [];
  const seen = new Set<string>();

  for (const alert of stationAlerts.filter((candidate) => candidate.kind === "accessibility")) {
    const key = alert.title || alert.description || "";
    if (seen.has(key)) continue;
    seen.add(key);
    const outages = alert.equipmentOutages ?? [];
    for (const outage of outages) {
      if (outage.type === "escalator") escalators.push(outage);
      else if (outage.type === "elevator") elevators.push(outage);
    }
    if (!outages.some((outage) => outage.type === "escalator" || outage.type === "elevator")) {
      others.push(alert);
    }
  }
  return { escalators, elevators, others };
}

export function getStationOverallStatus(
  serviceAlerts: readonly AgencyAlert[],
  stationLines?: readonly string[],
  stationId?: SchematicStationId,
): StationStatusDisplay {
  const relevantAlerts = stationId
    ? serviceAlerts.filter((alert) => {
        const hasExplicitStationTarget = alert.targets?.some((target) => target.station?.stationId);
        return !hasExplicitStationTarget || alertStationRouteImpact(alert, stationId).matched;
      })
    : serviceAlerts;
  if (relevantAlerts.length === 0) return { text: "Normal Service", color: "text-live-400" };

  const severeAlerts = relevantAlerts.filter((alert) => alert.severity === "severe");
  if (severeAlerts.length > 0) {
    if (stationLines && stationLines.length > 1) {
      const routesForStation = (alert: AgencyAlert): readonly string[] =>
        stationId ? alertStationRouteImpact(alert, stationId).routeIds : alertTargetRoutes(alert);
      const hasStationWideSevere = severeAlerts.some(
        (alert) => routesForStation(alert).length === 0,
      );
      const severeLineIds = new Set(severeAlerts.flatMap(routesForStation));
      const allLinesSevere = stationLines.every((lineId) => severeLineIds.has(lineId));

      if (hasStationWideSevere || allLinesSevere) {
        return { text: "No Service", color: "text-destructive" };
      }
      return { text: "Service Delay", color: "text-warning-400" };
    }

    return { text: "No Service", color: "text-destructive" };
  }

  if (relevantAlerts.some((alert) => alert.kind === "slow-service")) {
    return { text: "Reduced Speed Zone", color: "text-warning-400" };
  }
  if (relevantAlerts.some((alert) => alert.severity === "degraded")) {
    return { text: "Service Delay", color: "text-warning-400" };
  }
  return { text: "Normal Service", color: "text-live-400" };
}
