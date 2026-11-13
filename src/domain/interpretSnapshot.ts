import type {
  AgencyAlert,
  AgencyStationReference,
  AgencySnapshot,
  AlertKind,
  AlertInterpretationConfig,
  AlertInterpretationRule,
  AlertSourceValue,
  AgencyManifest,
  AlertScope,
  AlertServiceChange,
  EquipmentOutage,
  RouteIdNormalization,
  Schematic,
  SchematicStationIndexEntry,
} from "~/agencies/types";
import { reconcilePublishedRestorations } from "~/domain/alerts/publishedRestorations";
import {
  publishedImpactPeriod,
  splitPublishedCancellations,
} from "~/domain/alerts/publishedImpactPeriod";
import { PLACEHOLDER_ALERT_TITLE } from "~/domain/alerts/placeholderTitle";
import {
  alertPeriodsSignature,
  alertWindowsCanMerge,
  foldAlertPeriods,
  mergeAlertPeriods,
  periodsForAlert,
  summarizeAlertPeriods,
} from "~/domain/alerts/periods";
import { stableAlertFallbackId } from "~/domain/alerts/stableAlertId";
import type { DecodedFeed, GenericAlert } from "~/infrastructure/realtime/gtfsRealtimeDecoder";
import { SEVERITY_COLORS, SEVERITY_RANK, SeverityLadder, type Severity } from "~/domain/severity";
import type { UiLocale } from "~/domain/locale";
import {
  composeAlertLanguageData,
  alertEffectName as effectName,
  STRUCTURED_ALERT_EFFECTS,
} from "~/domain/alerts/rules";
import {
  alertStationKey,
  resolveAgencyStationReference,
  type StationReferenceResolutionOptions,
} from "~/domain/stationAlerts";
import { normalizeRouteIdList } from "~/domain/routeId";
import { createPatternCache } from "~/domain/surface/surfaceAlerts";

export interface InterpretSnapshotOptions {
  readonly agencyId: string;
  readonly now?: number | (() => number);
  /** Validated rider locale carried with the feed that produced this snapshot. */
  readonly locale?: UiLocale;
  readonly lineIds?: readonly string[];
  readonly routeLineMap?: Readonly<Record<string, string>>;
  readonly rules?: readonly AlertInterpretationRule[];
  readonly routeIdNormalization?: RouteIdNormalization;
  readonly equipmentKeywords?: Readonly<Record<string, readonly string[]>>;
  readonly interpretation?: AlertInterpretationConfig;
  readonly manifest?: Pick<AgencyManifest, "alertInterpretation"> &
    Partial<Pick<AgencyManifest, "locale">>;
  /** Provider-owned station identity index used to canonicalize feed stop ids. */
  readonly stationIndex?: readonly SchematicStationIndexEntry[];
  /** Optional schematic station names and aliases used for bounded name resolution. */
  readonly schematic?: Pick<Schematic, "stations" | "stationAliases">;
  /** A successfully fetched but partially degraded feed remains stale. */
  readonly feedIsStale?: boolean;
}

export interface LineStatus {
  readonly lineId: string;
  readonly severity: Severity;
  readonly alerts: readonly AgencyAlert[];
}

/** Canonical colors are exported here as part of the interpretation seam. */
export { SEVERITY_COLORS, SEVERITY_RANK, SeverityLadder };
export { BASELINE_ALERT_RULES } from "~/domain/alerts/rules";

const ALERT_LANGUAGE_DATA = composeAlertLanguageData();
const EQUIPMENT_NON_IDENTIFIER_WORDS = new Set(
  ALERT_LANGUAGE_DATA.equipmentNonIdentifierWords.map(normalizeText),
);

interface AlertClassification {
  readonly kind: AlertKind;
  readonly severity: Severity;
  readonly serviceChange?: AlertServiceChange;
}

function normalizeText(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function structuredEffect(effect: string | number | undefined): AlertClassification | undefined {
  if (effect === undefined) return undefined;
  const key = effectName(effect);
  if (!key) return undefined;
  return STRUCTURED_ALERT_EFFECTS[key];
}

const indexedPlatforms = new WeakMap<readonly SchematicStationIndexEntry[], ReadonlySet<string>>();
function isPartialPlatformClosure(
  alertStops: readonly string[] | undefined,
  alertRoutes: readonly string[],
  stationIndex: readonly SchematicStationIndexEntry[] | undefined,
): boolean {
  if (!alertStops || alertStops.length === 0 || !stationIndex || stationIndex.length === 0) {
    return false;
  }
  let platformIds = indexedPlatforms.get(stationIndex);
  if (!platformIds) {
    platformIds = new Set(stationIndex.flatMap((station) => station.platformIds));
    indexedPlatforms.set(stationIndex, platformIds);
  }
  if (alertStops.some((stopId) => !platformIds.has(stopId))) return false;
  const matchedStations = stationIndex.filter((station) =>
    station.platformIds.some((platformId) => alertStops.includes(platformId)),
  );
  if (matchedStations.length === 0) return false;
  return matchedStations.every((station) => {
    // Unaffected routes may own the remaining platforms, so they cannot prove partial service.
    const stationRoutes = station.departureRouteIds ?? station.lines;
    if (alertRoutes.length > 0 && stationRoutes.some((routeId) => !alertRoutes.includes(routeId))) {
      return false;
    }
    if (station.platformIds.length <= 1) return false;
    const closedPlatforms = station.platformIds.filter((platformId) =>
      alertStops.includes(platformId),
    );
    return closedPlatforms.length < station.platformIds.length;
  });
}

function interpretationRules(
  options: InterpretSnapshotOptions,
): readonly AlertInterpretationRule[] {
  return interpretationConfig(options).rules ?? [];
}

// Rule terms and stop-id patterns are manifest-bounded, so every snapshot
// reuses the same compiled expressions instead of rebuilding them per alert.
const rulePhrasePattern = createPatternCache(
  (escaped) => new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`),
);
const stopIdPatterns = new Map<string, RegExp>();
function stopIdPattern(source: string): RegExp {
  let pattern = stopIdPatterns.get(source);
  if (!pattern) {
    pattern = new RegExp(source, "gi");
    stopIdPatterns.set(source, pattern);
  }
  return pattern;
}

function ruleMatches(alert: GenericAlert, rule: AlertInterpretationRule): boolean {
  const { effects, sourceField, sourceValue, textIncludes, titleIncludes } = rule.match;
  if (effects && effects.length > 0) {
    const actualEffect = effectName(alert.effect);
    const matchesEffect = effects.some((candidate) => {
      return actualEffect === effectName(candidate);
    });
    if (!matchesEffect) return false;
  }

  if (sourceField !== undefined) {
    const value = alert.sourceFields?.[sourceField];
    if (value === undefined) return false;
    if (sourceValue !== undefined && !sourceValuesEqual(value, sourceValue)) {
      return false;
    }
  }

  if (!titleIncludes?.length && !textIncludes?.length) return true;
  const translatedTitles = alert.sourceTranslations
    ?.filter((translation) => translation.field === "title")
    .map((translation) => translation.text)
    .join(" ");
  const translatedDescriptions = alert.sourceTranslations
    ?.filter((translation) => translation.field === "description")
    .map((translation) => translation.text)
    .join(" ");
  for (const [terms, value] of [
    [titleIncludes, `${alert.title} ${translatedTitles ?? ""}`],
    [
      textIncludes,
      `${alert.title} ${translatedTitles ?? ""} ${alert.description ?? ""} ${translatedDescriptions ?? ""} ${alert.category ?? ""}`,
    ],
  ] as const) {
    if (!terms?.length) continue;
    const text = normalizeText(value);
    if (
      !terms.some((term) => {
        const normalizedTerm = normalizeText(term);
        if (normalizedTerm.length === 0) return false;
        return rulePhrasePattern(normalizedTerm).test(text);
      })
    ) {
      return false;
    }
  }

  return true;
}

function sourceValuesEqual(actual: AlertSourceValue, expected: AlertSourceValue): boolean {
  if (typeof actual !== typeof expected) return false;
  if (typeof actual === "string" && typeof expected === "string") {
    return normalizeText(actual) === normalizeText(expected);
  }
  return actual === expected;
}

function classifyAlert(
  alert: GenericAlert,
  options: InterpretSnapshotOptions,
  baselineRules: readonly AlertInterpretationRule[],
): AlertClassification {
  const structured = structuredEffect(alert.effect);

  // When an alert only closes a subset of platforms at multi-platform stations
  // (and other platforms remain open), it is a platform relocation or partial closure.
  // A published non-suspension effect already states the alert's meaning.
  if (
    (!structured || structured.kind === "suspension") &&
    isPartialPlatformClosure(
      alert.affectedStations,
      [...(alert.routeIds ?? []), ...(alert.lineId ? [alert.lineId] : [])],
      options.stationIndex,
    )
  ) {
    return { kind: "delay", severity: "degraded" };
  }

  const matchingRule = interpretationRules(options)
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => ruleMatches(alert, rule))
    .sort((a, b) => (b.rule.priority ?? 0) - (a.rule.priority ?? 0) || a.index - b.index)[0]?.rule;
  // A matching manifest rule is an explicit, agency-owned refinement. It
  // therefore wins over the protocol fallback; priority resolves overlaps.
  if (matchingRule) return matchingRule.result;

  // A structured effect is the operator's own machine-readable statement, and it
  // outranks anything we infer from prose. Baseline rules may still ELEVATE above
  // it, because a feed that publishes a bland effect while the text announces an
  // emergency is understating itself and the text is worth trusting.
  //
  // They may not CLEAR it. A resolution rule matches on prose anywhere in the
  // alert, and its terms are not specific to a resolution: "lifted" also appears
  // in "speed restriction lifted" and "cleared" in "snow has cleared", both of
  // which describe an ongoing severe disruption. Because the resolution tier is
  // applied before the structured effect, a structured NO_SERVICE reading "The
  // incident has cleared" was downgraded to information/normal and then dropped
  // from station status entirely, hiding a live severe alert because of a word
  // in its description.
  //
  // So: a resolution only wins when there is no structured effect to contradict.
  const highPriorityBaselineRule = baselineRules
    .filter((rule) => (rule.priority ?? 0) >= 150 && ruleMatches(alert, rule))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
  const clearsAlert =
    highPriorityBaselineRule !== undefined &&
    SEVERITY_RANK[highPriorityBaselineRule.result.severity] <=
      SEVERITY_RANK[structured?.severity ?? "normal"];
  if (highPriorityBaselineRule && (!structured || !clearsAlert)) {
    return highPriorityBaselineRule.result;
  }

  if (structured) return structured;

  // Low-priority baseline rules (routine detour phrasing for unstructured feeds).
  const lowPriorityBaselineRule = baselineRules
    .filter((rule) => (rule.priority ?? 0) < 150 && ruleMatches(alert, rule))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
  if (lowPriorityBaselineRule) return lowPriorityBaselineRule.result;

  return { kind: "information", severity: "normal" };
}

function lifecycleFor(
  alert: Pick<GenericAlert, "startsAt" | "endsAt" | "activePeriods">,
  now: number,
): AgencyAlert["lifecycle"] {
  if (alert.activePeriods?.length) {
    if (
      alert.activePeriods.some(
        ({ startsAt, endsAt }) =>
          (startsAt === undefined || now >= startsAt) && (endsAt === undefined || now < endsAt),
      )
    ) {
      return "active";
    }
    if (alert.activePeriods.some(({ startsAt }) => startsAt !== undefined && now < startsAt)) {
      return "upcoming";
    }
    return "expired";
  }
  if (alert.endsAt !== undefined && now >= alert.endsAt) return "expired";
  if (now < alert.startsAt) return "upcoming";
  return "active";
}

function freshnessFromReceipt(
  timestamp: number | undefined,
  feedIsStale = false,
): AgencySnapshot["freshness"] {
  if (!timestamp || timestamp <= 0) return "unavailable";
  if (feedIsStale) return "stale";
  // The source header describes the operator's last content change, not when
  // this application successfully received the feed. A quiet but healthy
  // feed must not become stale merely because its payload is unchanged.
  return "live";
}

function interpretationConfig(options: InterpretSnapshotOptions): AlertInterpretationConfig {
  return {
    stopIdPattern:
      options.interpretation?.stopIdPattern ?? options.manifest?.alertInterpretation?.stopIdPattern,
    openEndedEndTimestamp:
      options.interpretation?.openEndedEndTimestamp ??
      options.manifest?.alertInterpretation?.openEndedEndTimestamp,
    preserveFeedPeriods:
      options.interpretation?.preserveFeedPeriods ??
      options.manifest?.alertInterpretation?.preserveFeedPeriods,
    reconcileUntimedNotices:
      options.interpretation?.reconcileUntimedNotices ??
      options.manifest?.alertInterpretation?.reconcileUntimedNotices,
    reconcilePublishedRestorations:
      options.interpretation?.reconcilePublishedRestorations ??
      options.manifest?.alertInterpretation?.reconcilePublishedRestorations,
    titleDateTimezone:
      options.interpretation?.titleDateTimezone ??
      options.manifest?.alertInterpretation?.titleDateTimezone,
    lineIds:
      options.lineIds ??
      options.interpretation?.lineIds ??
      options.manifest?.alertInterpretation?.lineIds,
    routeNames:
      options.interpretation?.routeNames ?? options.manifest?.alertInterpretation?.routeNames,
    routeLineMap:
      options.routeLineMap ??
      options.interpretation?.routeLineMap ??
      options.manifest?.alertInterpretation?.routeLineMap,
    rules:
      options.rules ??
      options.interpretation?.rules ??
      options.manifest?.alertInterpretation?.rules,
    routeIdNormalization:
      options.routeIdNormalization ??
      options.interpretation?.routeIdNormalization ??
      options.manifest?.alertInterpretation?.routeIdNormalization,
    stripLinePrefixFromTitle:
      options.interpretation?.stripLinePrefixFromTitle ??
      options.manifest?.alertInterpretation?.stripLinePrefixFromTitle,
    equipmentKeywords:
      options.equipmentKeywords ??
      options.interpretation?.equipmentKeywords ??
      options.manifest?.alertInterpretation?.equipmentKeywords,
  };
}

/**
 * Mines structured equipment outages from alert text. The keyword map is
 * manifest-driven; equipment name/location parsing is shared Core policy.
 */
function equipmentOutagesForAlert(
  rawText: string,
  alertId: string,
  keywords: Readonly<Record<string, readonly string[]>> | undefined,
): readonly EquipmentOutage[] | undefined {
  const text = rawText || "";
  const lower = text.toLowerCase();
  const entries = Object.entries(keywords ?? {});
  const hit = entries
    .filter(([, words]) => words.some((word) => lower.includes(word.toLowerCase())))
    .sort(
      (first, second) =>
        Math.min(
          ...first[1]
            .map((word) => lower.indexOf(word.toLowerCase()))
            .filter((index) => index >= 0),
        ) -
        Math.min(
          ...second[1]
            .map((word) => lower.indexOf(word.toLowerCase()))
            .filter((index) => index >= 0),
        ),
    )[0];
  if (!hit) return undefined;
  const [type, words] = hit;
  const matchedWord = words.find((word) => lower.includes(word.toLowerCase())) ?? type;
  const escapedKeyword = [...matchedWord]
    .map((character) => (".*+?^${}()|[]\\".includes(character) ? `\\${character}` : character))
    .join("");
  // Equipment names can contain accented letters. Language catalogs identify
  // common status words so they do not get absorbed as part of the name.
  const match = text.match(
    new RegExp(
      `(^|[^\\p{L}\\p{N}])(${escapedKeyword})(?:\\s+([\\p{L}\\p{N}]+))?(?![\\p{L}\\p{N}])`,
      "iu",
    ),
  );
  const identifier = match?.[3];
  const equipment =
    match && identifier && !EQUIPMENT_NON_IDENTIFIER_WORDS.has(normalizeText(identifier))
      ? `${match[2]} ${identifier}`
      : (match?.[2] ?? matchedWord);
  const cleaned = text.replace(/^[^:]+:\s*/, "");
  const location = cleaned
    .replace(equipment, "")
    .replace(/out of service\s*/i, "")
    .replace(/while we perform maintenance.*/i, "")
    .trim()
    .replace(/^from\s+/i, "");

  // Downstream station grouping only branches on elevator/escalator;
  // manifest-specific equipment lands on "other" with its name preserved.
  const outageType = type === "elevator" || type === "escalator" ? type : "other";
  return [{ id: alertId, type: outageType, equipment, location, rawText: text }];
}

/** Applied after raw decoding so direct feeds and daemon relays receive identical attribution. */
function namedRouteIds(
  alert: GenericAlert,
  config: AlertInterpretationConfig,
): readonly string[] | undefined {
  if (
    alert.tripScoped ||
    alert.routeIds?.length ||
    alert.lineId ||
    alert.targets?.some((target) => target.routeId)
  )
    return alert.routeIds;
  if (!config.routeNames) return alert.routeIds;
  const tokens = (text: string) =>
    normalizeText(text)
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const text = ` ${tokens(`${alert.title} ${alert.description ?? ""}`)} `;
  const matches = Object.entries(config.routeNames)
    .filter(([, names]) => names.some((name) => text.includes(` ${tokens(name)} `)))
    .map(([id]) => id);
  return matches.length ? matches : alert.routeIds;
}

function affectedLines(
  alert: GenericAlert,
  config: AlertInterpretationConfig,
): readonly string[] | undefined {
  // A raw route id is not a line id. Bus-only agencies commonly use the same
  // numeric route labels as another agency's rail lines, so line attribution
  // must be opt-in through an agency manifest declaration or explicit map.
  if (config.lineIds === undefined && config.routeLineMap === undefined) {
    return undefined;
  }

  const declared = config.lineIds ? new Set(config.lineIds) : undefined;
  const mappings = config.routeLineMap ?? {};
  const routeIds = alert.routeIds ?? [];
  const result: string[] = [];
  const normalizeRouteToken = (routeId: string): string =>
    routeId
      .trim()
      .replace(/^line\s*/i, "")
      .trim();

  const add = (lineId: string | undefined) => {
    if (!lineId || (declared && !declared.has(lineId)) || result.includes(lineId)) return;
    result.push(lineId);
  };

  add(alert.lineId);
  for (const routeId of routeIds) {
    add(
      mappings[routeId] ??
        mappings[routeId.toLowerCase()] ??
        (declared ? (declared.has(routeId) ? routeId : undefined) : undefined),
    );
    if (declared) {
      const normalizedRouteId = normalizeRouteToken(routeId);
      if (declared.has(normalizedRouteId)) add(normalizedRouteId);
    }
  }

  return result.length > 0 ? result : undefined;
}

function alertScope(
  alert: GenericAlert,
  affectedLineIds: readonly string[] | undefined,
): AlertScope {
  // Stops qualify a trip restriction; they never broaden it to station service.
  if (alert.tripScoped) return "trip";
  if (alert.stopScoped) return "station";
  if (alert.fromStationId && alert.toStationId) return "segment";
  if ((alert.affectedStations?.length ?? 0) > 0) return "station";
  if (alert.targets?.some((target) => target.stopId !== undefined)) return "station";
  if ((affectedLineIds?.length ?? 0) > 0) return "line";
  if ((alert.routeIds?.length ?? 0) > 0) return "route";
  return "network";
}

/**
 * Cancelled departures are not a suspended route. A trip-scoped verdict is never
 * a suspension and never severe, whatever the effect says, so the line and its
 * route chips are not marked down by a few cancelled trips. This is the one place
 * the cap lives; line status only needs its station and segment cap.
 */
function capTripScope(classification: AlertClassification): AlertClassification {
  return {
    ...classification,
    kind: classification.kind === "suspension" ? "information" : classification.kind,
    severity: classification.severity === "severe" ? "degraded" : classification.severity,
  };
}

function toAgencyAlert(
  alert: GenericAlert,
  now: number,
  options: InterpretSnapshotOptions,
  stationCandidates: readonly StationTextCandidate[],
): AgencyAlert {
  const config = interpretationConfig(options);
  // Agency interpretation at the Core seam: raw decoder route ids are
  // normalized through the manifest rule. Explicit feed values are retained
  // only when the agency has opted into line attribution below.
  const routeIds = normalizeRouteIdList(namedRouteIds(alert, config), config.routeIdNormalization);
  const inferredStationSpan =
    !alert.fromStationId &&
    !alert.toStationId &&
    (!alert.affectedStations || alert.affectedStations.length === 0)
      ? stationSpanFromAlertText(
          alert,
          stationCandidates,
          ALERT_LANGUAGE_DATA.stationSpanConnectors,
        )
      : undefined;
  const endpointStations =
    !alert.targets?.length && alert.affectedStations && alert.affectedStations.length === 2
      ? alert.affectedStations
      : undefined;
  const titlePeriod = config.titleDateTimezone
    ? publishedImpactPeriod(alert, config.titleDateTimezone)
    : undefined;
  const normalizedAlert: GenericAlert = {
    ...alert,
    ...(titlePeriod
      ? {
          startsAt: titlePeriod.startsAt,
          endsAt: titlePeriod.endsAt,
          activePeriods: [titlePeriod],
          impactPeriods: [titlePeriod],
        }
      : {}),
    lineId: alert.lineId,
    fromStationId: alert.fromStationId ?? endpointStations?.[0] ?? inferredStationSpan?.from,
    toStationId: alert.toStationId ?? endpointStations?.[1] ?? inferredStationSpan?.to,
    routeIds,
  };
  const affectedLineIds = affectedLines(normalizedAlert, config);
  const scope = alertScope(normalizedAlert, affectedLineIds);
  const classified = classifyAlert(normalizedAlert, options, ALERT_LANGUAGE_DATA.baselineRules);
  const interpretation = scope === "trip" ? capTripScope(classified) : classified;
  const lifecycle = lifecycleFor(normalizedAlert, now);
  const kind = lifecycle === "upcoming" ? "upcoming" : interpretation.kind;
  const severity = kind === "upcoming" ? "normal" : interpretation.severity;
  const stationResolution = stationResolutionOptions(options);
  const resolveStation = (station: string) =>
    resolveAgencyStationReference(station, stationResolution);
  const affectedStations = normalizedAlert.affectedStations?.flatMap((station) => {
    const resolved = resolveStation(station);
    return resolved ? [resolved] : [];
  });
  const targets = normalizedAlert.targets?.flatMap((target) => {
    const routeId = target.routeId
      ? normalizeRouteIdList([target.routeId], config.routeIdNormalization)?.[0]
      : undefined;
    const station = target.stopId ? resolveStation(target.stopId) : undefined;
    return routeId || station
      ? [{ routeId, station, directionId: target.directionId, directionText: target.directionText }]
      : [];
  });
  const resolvedTargets = targets && targets.length > 0 ? targets : undefined;

  return {
    id: normalizedAlert.id,
    incidentIdentity: normalizedAlert.incidentIdentity,
    kind,
    severity,
    lifecycle,
    // An unidentified stop cannot anchor a disruption on a drawn corridor.
    affectedLineIds:
      normalizedAlert.stopScoped &&
      !normalizedAlert.affectedStations?.length &&
      !normalizedAlert.targets?.some((target) => target.stopId)
        ? undefined
        : affectedLineIds,
    affectedRouteIds: routeIds,
    targets: resolvedTargets,
    affectedStations,
    fromStation: normalizedAlert.fromStationId
      ? resolveStation(normalizedAlert.fromStationId)
      : undefined,
    toStation: normalizedAlert.toStationId
      ? resolveStation(normalizedAlert.toStationId)
      : undefined,
    scope,
    serviceChange: interpretation.serviceChange,
    equipmentOutages: equipmentOutagesForAlert(
      `${normalizedAlert.title} ${normalizedAlert.description ?? ""}`,
      normalizedAlert.id,
      config.equipmentKeywords ?? ALERT_LANGUAGE_DATA.equipmentKeywords,
    )?.map((outage) =>
      affectedStations?.length === 1
        ? { ...outage, location: affectedStations[0]!.stationName }
        : outage,
    ),
    title: readableAlertTitle(normalizedAlert),
    description: normalizedAlert.description,
    startsAt: normalizedAlert.startsAt,
    endsAt: normalizedAlert.endsAt,
    activePeriods: normalizedAlert.activePeriods,
    impactPeriods: normalizedAlert.impactPeriods,
    updatedAt: normalizedAlert.updatedAt,
  };
}

const stationOptionsCache = new WeakMap<object, StationReferenceResolutionOptions>();
function stationResolutionOptions(
  options: Pick<InterpretSnapshotOptions, "stationIndex" | "schematic">,
): StationReferenceResolutionOptions {
  let resolved = stationOptionsCache.get(options);
  if (!resolved) {
    resolved = {
      stationIndex: options.stationIndex,
      stationAliases: options.schematic?.stationAliases,
      schematicStations: options.schematic?.stations,
    };
    stationOptionsCache.set(options, resolved);
  }
  return resolved;
}

interface StationTextCandidate {
  readonly value: string;
  readonly key: string;
}

function stationTextCandidates(
  schematic: InterpretSnapshotOptions["schematic"],
): readonly StationTextCandidate[] {
  if (!schematic) return [];
  return [
    ...schematic.stations.map((station) => ({
      value: station.name,
      key: alertStationKey(station.name),
    })),
    ...Object.keys(schematic.stationAliases ?? {}).map((value) => ({
      value,
      key: alertStationKey(value),
    })),
  ].filter((candidate) => candidate.key.length > 0);
}

/**
 * Finds a bounded span in operator prose without owning any agency vocabulary.
 * Only names declared by the provider's schematic (or its aliases) are
 * eligible, so an incidental pair of words in an alert can never create a
 * station identity by itself.
 */
function stationSpanFromAlertText(
  alert: GenericAlert,
  candidates: readonly StationTextCandidate[],
  connectors: readonly { readonly between: string; readonly separator: string }[],
): { readonly from: string; readonly to: string } | undefined {
  if (candidates.length === 0) return undefined;

  const text = alertStationKey(
    [
      alert.title,
      alert.description ?? "",
      ...(alert.sourceTranslations ?? []).map((translation) => translation.text),
    ].join(" "),
  );

  const findCandidate = (segment: string, direction: "last" | "first"): string | undefined => {
    const paddedSegment = ` ${segment} `;
    let selected: { value: string; index: number; end: number } | undefined;
    for (const candidate of candidates) {
      const index =
        direction === "last"
          ? paddedSegment.lastIndexOf(` ${candidate.key} `)
          : paddedSegment.indexOf(` ${candidate.key} `);
      if (index === -1) continue;
      const end = index + candidate.key.length;
      // A contained name is part of the complete station name, not a second
      // endpoint. Resolve overlaps before choosing the first or last mention.
      if (selected && index >= selected.index && end <= selected.end) continue;
      if (
        !selected ||
        (index <= selected.index && end >= selected.end) ||
        (direction === "last" && index > selected.index) ||
        (direction === "first" && index < selected.index)
      ) {
        selected = { value: candidate.value, index, end };
      }
    }
    return selected?.value;
  };

  for (const { between, separator } of connectors) {
    for (const betweenMatch of text.matchAll(new RegExp(`\\b${between}\\b`, "g"))) {
      const betweenEnd = betweenMatch.index + betweenMatch[0].length;
      const separatorText = ` ${separator} `;
      const separatorIndex = text.indexOf(separatorText, betweenEnd);
      if (separatorIndex === -1) continue;
      const from = findCandidate(text.slice(betweenEnd, separatorIndex), "last");
      const to = findCandidate(text.slice(separatorIndex + separatorText.length), "first");
      if (from && to) return { from, to };
    }
  }
  return undefined;
}

/**
 * Interprets one decoded feed at the Core seam. Classification, lifecycle,
 * attribution, freshness, and the shared severity ladder live together so an
 * agency module only supplies declarative line and interpretation rules.
 */
export function interpretSnapshot(
  feed: DecodedFeed,
  options: InterpretSnapshotOptions,
): AgencySnapshot {
  const now = typeof options.now === "function" ? options.now() : (options.now ?? Date.now());
  const stationCandidates =
    feed.alerts.length === 0 ? [] : stationTextCandidates(options.schematic);
  const config = interpretationConfig(options);
  const sourceAlerts = deduplicateDecodedAlerts(
    config.titleDateTimezone
      ? feed.alerts.flatMap((alert) =>
          splitPublishedCancellations(alert, config.titleDateTimezone!),
        )
      : feed.alerts,
    options.stationIndex,
    options.schematic,
    config.stripLinePrefixFromTitle ?? false,
  );
  const prepared = sourceAlerts.map((alert) =>
    prepareAlertEvidence(alert, config, stationCandidates, options),
  );
  const unchanged =
    !config.reconcileUntimedNotices &&
    prepared.every((alert, index) => alert === sourceAlerts[index]);
  const finalAlerts = unchanged
    ? prepared
    : deduplicateDecodedAlerts(
        config.reconcileUntimedNotices
          ? reconcileUntimedNotices(prepared, stationResolutionOptions(options))
          : prepared,
        options.stationIndex,
        options.schematic,
        config.stripLinePrefixFromTitle ?? false,
      );
  const interpretedAlerts = finalAlerts.map((alert) =>
    toAgencyAlert(alert, now, options, stationCandidates),
  );
  return {
    agencyId: options.agencyId,
    sourceUpdatedAt: feed.header.timestamp,
    generatedAt: now,
    freshness: freshnessFromReceipt(feed.header.timestamp, options.feedIsStale),
    alerts: interpretationConfig(options).reconcilePublishedRestorations
      ? reconcilePublishedRestorations(interpretedAlerts, now)
      : interpretedAlerts,
  };
}

function readableAlertTitle(alert: GenericAlert): string {
  const headline = isPlaceholderTitle(alert.title, false)
    ? alert.description
        ?.split("\n")[0]
        ?.split(/(?<=[.!?])\s/u)[0]
        ?.trim()
    : undefined;
  return headline
    ? headline.length > 200
      ? `${headline.slice(0, 197)}...`
      : headline
    : alert.title;
}

/** Recover only provider-declared identities or named equipment subjects before deduplication. */
function prepareAlertEvidence(
  alert: GenericAlert,
  config: AlertInterpretationConfig,
  candidates: readonly StationTextCandidate[],
  options: InterpretSnapshotOptions,
): GenericAlert {
  const sentinel = config.openEndedEndTimestamp;
  if (
    sentinel !== undefined &&
    (alert.endsAt === sentinel ||
      alert.activePeriods?.some((period) => period.endsAt === sentinel) ||
      alert.impactPeriods?.some((period) => period.endsAt === sentinel))
  ) {
    const normalize = (period: { readonly startsAt?: number; readonly endsAt?: number }) => ({
      ...period,
      endsAt: period.endsAt === sentinel ? undefined : period.endsAt,
    });
    alert = {
      ...alert,
      endsAt: alert.endsAt === sentinel ? undefined : alert.endsAt,
      activePeriods: alert.activePeriods?.map(normalize),
      impactPeriods: alert.impactPeriods?.map(normalize),
    };
  }
  const title = readableAlertTitle(alert);
  const routeIds = normalizeRouteIdList(namedRouteIds(alert, config), config.routeIdNormalization);
  const explicitStops =
    alert.stopScoped ||
    alert.affectedStations?.length ||
    alert.targets?.some((target) => target.stopId) ||
    alert.fromStationId ||
    alert.toStationId;
  let inferredStops: string[] = [];
  if (!explicitStops && config.stopIdPattern) {
    inferredStops = [
      ...[title, alert.description ?? ""].join("\n").matchAll(stopIdPattern(config.stopIdPattern)),
    ]
      .map((match) => match[1])
      .filter((value): value is string => Boolean(value));
    inferredStops = [...new Set(inferredStops)];
  }
  if (
    !explicitStops &&
    inferredStops.length === 0 &&
    equipmentOutagesForAlert(
      title,
      alert.id,
      config.equipmentKeywords ?? ALERT_LANGUAGE_DATA.equipmentKeywords,
    )
  ) {
    const key = ` ${alertStationKey(title)} `;
    const matched = candidates.filter((candidate) => key.includes(` ${candidate.key} `));
    inferredStops = [
      ...new Set(
        matched
          .filter(
            (candidate) =>
              !matched.some(
                (other) =>
                  other.key !== candidate.key && ` ${other.key} `.includes(` ${candidate.key} `),
              ),
          )
          .map((candidate) => {
            const resolved = resolveAgencyStationReference(
              candidate.value,
              stationResolutionOptions(options),
            );
            return resolved?.stationName ?? candidate.value;
          }),
      ),
    ];
  }
  const targets = inferredStops.length
    ? inferredStops.flatMap((stopId) =>
        routeIds?.length ? routeIds.map((routeId) => ({ routeId, stopId })) : [{ stopId }],
      )
    : alert.targets;
  const addsImpact =
    config.preserveFeedPeriods &&
    alert.startsAt > 0 &&
    alert.endsAt !== undefined &&
    !alert.impactPeriods?.length;
  if (
    !inferredStops.length &&
    !addsImpact &&
    (routeIds === alert.routeIds ||
      (routeIds?.length === alert.routeIds?.length &&
        routeIds?.every((id, index) => id === alert.routeIds?.[index])))
  )
    return alert;
  return {
    ...alert,
    routeIds,
    targets,
    affectedStations: inferredStops.length ? inferredStops : alert.affectedStations,
    ...(config.preserveFeedPeriods &&
    alert.startsAt > 0 &&
    alert.endsAt !== undefined &&
    !alert.impactPeriods?.length
      ? { impactPeriods: periodsForAlert(alert) }
      : {}),
  };
}

/** A shared headline, complete station scope and opening paragraph establish a unique web copy. */
function reconcileUntimedNotices(
  alerts: readonly GenericAlert[],
  options: StationReferenceResolutionOptions,
): GenericAlert[] {
  const replacements = new Map<string, GenericAlert>();
  const consumed = new Set<GenericAlert>();
  const body = (alert: GenericAlert) =>
    normalizedAlertText(
      (alert.description ?? "").replace(readableAlertTitle(alert), "").trim().split("\n")[0],
    );
  const stations = (alert: GenericAlert) =>
    [...new Set((alert.affectedStations ?? []).map((name) => stationReferenceKey(name, options)))]
      .sort()
      .join("|");
  const targetScope = (alert: GenericAlert) => {
    const targets =
      alert.targets ??
      (alert.affectedStations ?? []).map((stopId) => ({
        stopId,
        routeId: undefined,
        directionId: undefined,
        directionText: undefined,
      }));
    if (targets.some((target) => !target.stopId)) return undefined;
    return targets
      .flatMap((target) =>
        (target.routeId ? [target.routeId] : alert.routeIds?.length ? alert.routeIds : [""]).map(
          (routeId) =>
            `${routeId}:${stationReferenceKey(target.stopId!, options)}:${target.directionId ?? target.directionText ?? ""}`,
        ),
      )
      .sort()
      .join("|");
  };
  for (const notice of alerts) {
    if (
      notice.tripScoped ||
      notice.tripIds?.length ||
      notice.startsAt !== 0 ||
      notice.endsAt !== undefined ||
      !stations(notice) ||
      !targetScope(notice) ||
      !body(notice)
    )
      continue;
    const matches = alerts.filter(
      (candidate) =>
        !candidate.tripScoped &&
        !candidate.tripIds?.length &&
        candidate.startsAt > 0 &&
        candidate.endsAt !== undefined &&
        normalizedAlertTitle(readableAlertTitle(candidate)) ===
          normalizedAlertTitle(readableAlertTitle(notice)) &&
        stations(candidate) === stations(notice) &&
        targetScope(candidate) === targetScope(notice) &&
        [...(candidate.routeIds ?? [])].sort().join("|") ===
          [...(notice.routeIds ?? [])].sort().join("|") &&
        body(candidate) === body(notice),
    );
    if (matches.length !== 1) continue;
    const precise = matches[0]!;
    replacements.set(precise.id, {
      ...precise,
      title: notice.title,
      description: notice.description,
      sourceTranslations: [
        ...(precise.sourceTranslations ?? []),
        ...(notice.sourceTranslations ?? []),
      ],
    });
    consumed.add(notice);
  }
  return alerts
    .filter((alert) => !consumed.has(alert))
    .map((alert) => replacements.get(alert.id) ?? alert);
}

/**
 * Removes duplicate records emitted by parallel operator feeds. IDs are the
 * primary identity; semantic content and compatible spatial references also
 * catch the same advisory when feed adapters assign different IDs.
 */
function stationReferenceQuality(
  station: string | undefined,
  options: StationReferenceResolutionOptions,
): number {
  const trimmed = station?.trim();
  if (!trimmed) return 0;
  const resolved = resolveAgencyStationReference(trimmed, options);
  if (!resolved) return 0;
  if (resolved.stationId) {
    if (alertStationKey(resolved.stationName) === alertStationKey(trimmed)) return 4;
    return 3;
  }
  if (resolved.stationName !== trimmed) return 3;
  if (/\s/.test(trimmed)) return 2;
  return /[a-z]/i.test(trimmed) ? 1 : 0;
}

function preferredStationReference(
  first: string | undefined,
  second: string | undefined,
  options: StationReferenceResolutionOptions,
): string | undefined {
  return stationReferenceQuality(second, options) > stationReferenceQuality(first, options)
    ? second
    : first;
}

function stationReferenceKey(station: string, options: StationReferenceResolutionOptions): string {
  const resolved = resolveAgencyStationReference(station, options);
  return resolved?.stationId
    ? `id:${resolved.stationId}`
    : `name:${alertStationKey(resolved?.stationName ?? station)}`;
}

function mergedStationList(
  first: readonly string[] | undefined,
  second: readonly string[] | undefined,
  options: StationReferenceResolutionOptions,
): readonly string[] | undefined {
  const candidates = [...(first ?? []), ...(second ?? [])];
  if (candidates.length === 0) return undefined;
  const unique = new Map<string, { value: string; quality: number }>();
  for (const candidate of candidates) {
    const key = stationReferenceKey(candidate, options);
    const quality = stationReferenceQuality(candidate, options);
    const previous = unique.get(key);
    if (!previous || quality > previous.quality) unique.set(key, { value: candidate, quality });
  }
  return [...unique.values()].map(({ value }) => value);
}

function mergeDecodedAlerts(
  first: GenericAlert,
  second: GenericAlert,
  options: StationReferenceResolutionOptions,
  stripLinePrefixFromTitle: boolean,
): GenericAlert {
  const mergedPeriods = mergeAlertPeriods(first, second);
  const periodSummary = summarizeAlertPeriods(
    mergedPeriods,
    Math.min(first.startsAt, second.startsAt),
  );
  const activePeriods =
    first.activePeriods !== undefined ||
    second.activePeriods !== undefined ||
    mergedPeriods.length > 1
      ? mergedPeriods
      : undefined;
  const impactPeriods = foldAlertPeriods([
    ...(first.impactPeriods ?? []),
    ...(second.impactPeriods ?? []),
  ]);
  const routeIds = [...new Set([...(first.routeIds ?? []), ...(second.routeIds ?? [])])];
  const sourceFields = { ...first.sourceFields, ...second.sourceFields };
  const sourceTranslations = [
    ...(first.sourceTranslations ?? []),
    ...(second.sourceTranslations ?? []),
  ].filter(
    (translation, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.field === translation.field &&
          candidate.text === translation.text &&
          candidate.language === translation.language,
      ) === index,
  );
  return {
    ...first,
    incidentIdentity: first.incidentIdentity ?? second.incidentIdentity,
    title: isPlaceholderTitle(first.title, stripLinePrefixFromTitle) ? second.title : first.title,
    description: first.description ?? second.description,
    lineId: first.lineId ?? second.lineId,
    targets: mergeAlertTargets(first.targets, second.targets),
    tripIds: mergedTripIds(first.tripIds, second.tripIds),
    tripScoped: first.tripScoped === true && second.tripScoped === true ? true : undefined,
    fromStationId: preferredStationReference(first.fromStationId, second.fromStationId, options),
    toStationId: preferredStationReference(first.toStationId, second.toStationId, options),
    routeIds: routeIds.length > 0 ? routeIds : undefined,
    affectedStations: mergedStationList(first.affectedStations, second.affectedStations, options),
    equipmentOutages: first.equipmentOutages ?? second.equipmentOutages,
    category: first.category ?? second.category,
    sourceFields: Object.keys(sourceFields).length > 0 ? sourceFields : undefined,
    sourceTranslations: sourceTranslations.length > 0 ? sourceTranslations : undefined,
    effect: preferredEffect(first.effect, second.effect),
    cause: first.cause ?? second.cause,
    startsAt: periodSummary.startsAt,
    endsAt: periodSummary.endsAt,
    activePeriods,
    impactPeriods: impactPeriods.length > 0 ? impactPeriods : undefined,
    updatedAt: Math.max(first.updatedAt, second.updatedAt),
  };
}

function mergedTripIds(
  first: GenericAlert["tripIds"],
  second: GenericAlert["tripIds"],
): GenericAlert["tripIds"] {
  const tripIds = [...new Set([...(first ?? []), ...(second ?? [])])];
  return tripIds.length > 0 ? tripIds : undefined;
}

/** `OTHER_EFFECT` and `UNKNOWN_EFFECT` state nothing the operator committed to. */
function isGenericEffect(effect: GenericAlert["effect"]): boolean {
  const name = effectName(effect);
  return name === undefined || name === "OTHER_EFFECT" || name === "UNKNOWN_EFFECT";
}

/** Keeps a specific effect over a generic one when two copies of an alert merge. */
function preferredEffect(
  first: GenericAlert["effect"],
  second: GenericAlert["effect"],
): GenericAlert["effect"] {
  return isGenericEffect(first) && !isGenericEffect(second) ? second : (first ?? second);
}

function mergeAlertTargets(
  first: GenericAlert["targets"],
  second: GenericAlert["targets"],
): GenericAlert["targets"] {
  const targets = [...(first ?? []), ...(second ?? [])];
  if (targets.length === 0) return undefined;
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.routeId ?? ""}|${target.stopId ?? ""}|${target.directionId ?? target.directionText ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizedAlertText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizedAlertTitle(title: string, stripLinePrefixFromTitle = false): string {
  const normalized = normalizedAlertText(title);
  return stripLinePrefixFromTitle ? normalized.replace(/^line\s+[^:]+:\s*/i, "") : normalized;
}

function alertContentSignature(alert: GenericAlert, stripLinePrefixFromTitle: boolean): string {
  return [
    normalizedAlertTitle(alert.title, stripLinePrefixFromTitle),
    alert.lineId ?? "",
    [...(alert.routeIds ?? [])].sort().join(","),
    alert.effect ?? "",
    alert.stopScoped ?? false,
  ].join("|");
}

function isPlaceholderTitle(title: string, stripLinePrefixFromTitle: boolean): boolean {
  return (
    normalizedAlertTitle(title, stripLinePrefixFromTitle) ===
    normalizedAlertTitle(PLACEHOLDER_ALERT_TITLE, stripLinePrefixFromTitle)
  );
}

/**
 * A shared title can be a publisher's category label ("Information"), so two
 * alerts that share it and publish different text are distinct advisories
 * rather than parallel copies of one.
 */
function haveDistinctText(first: GenericAlert, second: GenericAlert): boolean {
  const firstText = normalizedAlertText(first.description);
  const secondText = normalizedAlertText(second.description);
  return firstText !== "" && secondText !== "" && firstText !== secondText;
}

function spatialReferences(
  alert: GenericAlert,
  options: StationReferenceResolutionOptions,
): readonly AgencyStationReference[] {
  return [
    alert.fromStationId,
    alert.toStationId,
    ...(alert.affectedStations ?? []),
    ...(alert.targets ?? []).map((target) => target.stopId),
  ].flatMap((station) => {
    const resolved = resolveAgencyStationReference(station, options);
    return resolved ? [resolved] : [];
  });
}

function directionScopesCanMerge(first: GenericAlert, second: GenericAlert): boolean {
  if (Boolean(first.stopScoped) !== Boolean(second.stopScoped)) return false;
  const directions = (alert: GenericAlert) =>
    [
      ...new Set(
        (alert.targets ?? []).map(
          (t) => `${t.routeId ?? ""}|${t.directionId ?? t.directionText ?? ""}`,
        ),
      ),
    ]
      .sort()
      .join(";");
  if (
    directions(first) !== directions(second) &&
    [...(first.targets ?? []), ...(second.targets ?? [])].some(
      (t) => t.directionId !== undefined || t.directionText !== undefined,
    )
  )
    return false;
  return true;
}

/**
 * Allows parallel feeds to merge a station-name copy with an opaque-ID copy,
 * while keeping two independently bounded advisories separate.
 */
function spatialVariantsCanMerge(
  first: GenericAlert,
  second: GenericAlert,
  options: StationReferenceResolutionOptions,
): boolean {
  // Alerts that name trips are about those departures only, so two of them
  // are the same advisory only when they name the same trips.
  if (
    (first.tripIds?.length ?? 0) > 0 || (second.tripIds?.length ?? 0) > 0
      ? !sameSet(first.tripIds, second.tripIds)
      : false
  ) {
    return false;
  }
  if (!directionScopesCanMerge(first, second)) return false;
  const firstReferences = spatialReferences(first, options);
  const secondReferences = spatialReferences(second, options);
  if (firstReferences.length === 0 || secondReferences.length === 0) return true;

  const firstIds = firstReferences.flatMap((station) =>
    station?.stationId ? [station.stationId] : [],
  );
  const secondIds = secondReferences.flatMap((station) =>
    station?.stationId ? [station.stationId] : [],
  );
  if (firstIds.length > 0 || secondIds.length > 0) {
    const secondIdSet = new Set(secondIds);
    return firstIds.some((stationId) => secondIdSet.has(stationId));
  }

  const firstNames = firstReferences.map((station) => alertStationKey(station.stationName));
  const secondNames = new Set(
    secondReferences.map((station) => alertStationKey(station.stationName)),
  );
  return firstNames.some((stationName) => secondNames.has(stationName));
}

export function deduplicateDecodedAlerts(
  alerts: readonly GenericAlert[],
  stationIndex?: readonly SchematicStationIndexEntry[],
  schematic?: Pick<Schematic, "stations" | "stationAliases">,
  stripLinePrefixFromTitle = false,
): readonly GenericAlert[] {
  const options = stationResolutionOptions({ stationIndex, schematic });
  const seenIds = new Map<string, number>();
  const seenSignatures = new Map<string, number>();
  const semanticCandidates = new Map<string, number[]>();
  const unique: GenericAlert[] = [];
  const usedIds = new Set<string>();
  for (const alert of alerts) {
    const windowsSignature = alertPeriodsSignature(periodsForAlert(alert));
    const impactSignature = alertPeriodsSignature(alert.impactPeriods ?? []);
    const signature = [
      normalizedAlertTitle(alert.title, stripLinePrefixFromTitle),
      (alert.description ?? "").trim().toLowerCase(),
      [...(alert.routeIds ?? [])].sort().join(","),
      [...(alert.targets ?? [])]
        .map(
          (target) =>
            `${target.routeId ?? ""}:${target.stopId ?? ""}:${target.directionId ?? target.directionText ?? ""}`,
        )
        .sort()
        .join(","),
      [...(alert.affectedStations ?? [])].sort().join(","),
      alert.fromStationId ?? "",
      alert.toStationId ?? "",
      [...(alert.tripIds ?? [])].sort().join(","),
      alert.effect ?? "",
      alert.startsAt,
      alert.endsAt ?? "",
      windowsSignature,
      impactSignature,
      alert.stopScoped ?? false,
    ].join("|");
    const existingIndex = seenIds.get(alert.id);
    if (
      existingIndex !== undefined &&
      directionScopesCanMerge(unique[existingIndex]!, alert) &&
      alertWindowsCanMerge(unique[existingIndex]!, alert)
    ) {
      unique[existingIndex] = mergeDecodedAlerts(
        unique[existingIndex]!,
        alert,
        options,
        stripLinePrefixFromTitle,
      );
      continue;
    }
    const identicalIndex = seenSignatures.get(signature);
    if (identicalIndex !== undefined && alertWindowsCanMerge(unique[identicalIndex]!, alert)) {
      unique[identicalIndex] = mergeDecodedAlerts(
        unique[identicalIndex]!,
        alert,
        options,
        stripLinePrefixFromTitle,
      );
      seenIds.set(alert.id, identicalIndex);
      continue;
    }
    const semanticSignature = alertContentSignature(alert, stripLinePrefixFromTitle);
    const candidateIndexes = semanticCandidates.get(semanticSignature) ?? [];
    const mergeIndex = candidateIndexes.find(
      (index) =>
        !haveDistinctText(unique[index]!, alert) &&
        alertWindowsCanMerge(unique[index]!, alert) &&
        spatialVariantsCanMerge(unique[index]!, alert, options),
    );
    if (mergeIndex !== undefined) {
      unique[mergeIndex] = mergeDecodedAlerts(
        unique[mergeIndex]!,
        alert,
        options,
        stripLinePrefixFromTitle,
      );
      seenIds.set(alert.id, mergeIndex);
      seenSignatures.set(signature, mergeIndex);
      continue;
    }
    const duplicateId = usedIds.has(alert.id);
    const uniqueAlert = duplicateId
      ? {
          ...alert,
          id: stableAlertFallbackId("alert-window", alert.id, {
            activePeriods: periodsForAlert(alert),
            title: normalizedAlertTitle(alert.title),
            routeIds: [...(alert.routeIds ?? [])].sort(),
          }),
        }
      : alert;
    seenIds.set(uniqueAlert.id, unique.length);
    seenSignatures.set(signature, unique.length);
    candidateIndexes.push(unique.length);
    semanticCandidates.set(semanticSignature, candidateIndexes);
    unique.push(uniqueAlert);
    usedIds.add(uniqueAlert.id);
  }
  return foldPlaceholderTwins(unique, options, stripLinePrefixFromTitle);
}

function sameSet(first: readonly string[] | undefined, second: readonly string[] | undefined) {
  const left = new Set(first ?? []);
  const right = new Set(second ?? []);
  return left.size === right.size && [...left].every((value) => right.has(value));
}

/** Every route, stop, span, and trip an alert is scoped to, as one comparable key. */
function spatialScopeKey(alert: GenericAlert): string {
  return [
    alert.lineId ?? "",
    [...(alert.routeIds ?? [])].sort().join(","),
    [...(alert.targets ?? [])]
      .map(
        (target) =>
          `${target.routeId ?? ""}:${target.stopId ?? ""}:${target.directionId ?? target.directionText ?? ""}`,
      )
      .sort()
      .join(","),
    [...(alert.affectedStations ?? [])].sort().join(","),
    alert.fromStationId ?? "",
    alert.toStationId ?? "",
    [...(alert.tripIds ?? [])].sort().join(","),
    alert.stopScoped ?? false,
  ].join("|");
}

/**
 * A description-less machine alert can lend its effect to one text notice only
 * when the period and complete scope match. Split twins may match collectively;
 * overlapping or ambiguous notices remain separate.
 */
function foldPlaceholderTwins(
  alerts: readonly GenericAlert[],
  options: StationReferenceResolutionOptions,
  stripLinePrefixFromTitle: boolean,
): GenericAlert[] {
  let result = [...alerts];
  const isTwin = (alert: GenericAlert) =>
    isPlaceholderTitle(alert.title, stripLinePrefixFromTitle) &&
    normalizedAlertText(alert.description) === "";
  for (let twinIndex = 0; twinIndex < result.length; twinIndex += 1) {
    const twin = result[twinIndex]!;
    if (!isTwin(twin)) continue;
    const period = alertPeriodsSignature(periodsForAlert(twin));
    const findText = (scope: GenericAlert): number[] =>
      result.flatMap((candidate, index) =>
        normalizedAlertText(candidate.description) !== "" &&
        (isGenericEffect(candidate.effect) ||
          isGenericEffect(scope.effect) ||
          effectName(candidate.effect) === effectName(scope.effect)) &&
        alertPeriodsSignature(periodsForAlert(candidate)) === period &&
        spatialScopeKey(candidate) === spatialScopeKey(scope)
          ? [index]
          : [],
      );
    let indexes = [twinIndex];
    let combined = twin;
    let matches = findText(combined);
    if (matches.length === 0) {
      indexes = result.flatMap((candidate, index) =>
        isTwin(candidate) &&
        candidate.effect === twin.effect &&
        candidate.lineId === twin.lineId &&
        candidate.fromStationId === twin.fromStationId &&
        candidate.toStationId === twin.toStationId &&
        candidate.tripScoped === twin.tripScoped &&
        alertPeriodsSignature(periodsForAlert(candidate)) === period
          ? [index]
          : [],
      );
      if (indexes.length < 2) continue;
      combined = indexes.slice(1).reduce((merged, index) => {
        const next = result[index]!;
        return {
          ...mergeDecodedAlerts(merged, next, options, stripLinePrefixFromTitle),
          // Compare feed identities before canonical station grouping collapses platforms.
          affectedStations: [
            ...new Set([...(merged.affectedStations ?? []), ...(next.affectedStations ?? [])]),
          ],
        };
      }, result[indexes[0]!]!);
      matches = findText(combined);
    }
    if (matches.length !== 1) continue;
    const textIndex = matches[0]!;
    const text = result[textIndex]!;
    result[textIndex] = {
      ...mergeDecodedAlerts(text, combined, options, stripLinePrefixFromTitle),
      // Keep the full feed platform set for partial-platform closure classification.
      affectedStations: text.affectedStations,
    };
    const removed = new Set(indexes);
    result = result.filter((_, index) => !removed.has(index));
    twinIndex = -1;
  }
  return result;
}

/**
 * Derives schematic line status from the same interpreted alerts. Unattributed
 * alerts remain systemwide and never accidentally attach to a line.
 */
export function deriveLineStatuses(
  alerts: readonly AgencyAlert[],
  lineIds: readonly string[],
): Record<string, LineStatus> {
  const alertsByLine = new Map<string, AgencyAlert[]>(lineIds.map((lineId) => [lineId, []]));
  for (const alert of alerts) {
    if (alert.lifecycle !== "active" || alert.kind === "upcoming") continue;
    for (const lineId of alert.affectedLineIds ?? []) {
      const lineAlerts = alertsByLine.get(lineId);
      if (lineAlerts) lineAlerts.push(alert);
    }
  }

  const statuses: Record<string, LineStatus> = {};
  for (const lineId of lineIds) {
    const lineAlerts = alertsByLine.get(lineId) ?? [];
    let severity: Severity = "normal";
    for (const alert of lineAlerts) {
      // Station accessibility outages are rendered at the station and never
      // alter the line's track-service status.
      if (alert.kind === "accessibility") continue;
      // A line can have a severe alert at a station or bounded segment while
      // still operating elsewhere. Scope is structured evidence, not a legacy
      // boolean inferred from alert prose.
      if (alert.scope === "station" || alert.scope === "segment") {
        const cappedSeverity: Severity = alert.severity === "severe" ? "degraded" : alert.severity;
        if (SEVERITY_RANK[cappedSeverity] > SEVERITY_RANK[severity]) severity = cappedSeverity;
        continue;
      }
      if (SEVERITY_RANK[alert.severity] > SEVERITY_RANK[severity]) severity = alert.severity;
    }
    statuses[lineId] = { lineId, severity, alerts: lineAlerts };
  }
  return statuses;
}
