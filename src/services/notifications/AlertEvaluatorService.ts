import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AgencyAlert, AgencySnapshot, RouteIdNormalization } from "~/agencies/types";
import type { CommuteSchedule } from "~/domain/preferences/UserPreferences";
import {
  DEFAULT_UI_LOCALE,
  normalizeLocale,
  requiredSubscriptionLocales,
  type UiLocale,
} from "~/domain/locale";
import { formatLocaleMessage, getLocaleMessages } from "~/domain/localeMessages";
import { STATION_SPAN_CONNECTORS } from "~/domain/alerts/rules";
import { alertStationReferences } from "~/domain/stationAlerts";
import type {
  AlertDeliveryRecord,
  PushPayload,
  PushSubscriptionRecord,
} from "~/domain/notifications/types";
import {
  PUSH_HARD_FAILURE_LIMIT,
  shouldCountHardPushFailure,
} from "~/domain/notifications/pushRetryPolicy";
import {
  SubscriptionRepository,
  SubscriptionStorageError,
  type AlertDeliveryClaim,
  type AlertDeliveryClaimOutcome,
  type SubscriptionRepositoryService,
} from "~/infrastructure/storage/SubscriptionRepository";
import {
  VapidClient,
  VapidError,
  type SendPushResult,
  type VapidSendOptions,
} from "~/infrastructure/notifications/VapidClient";
import { InvocationBudgetExceeded } from "~/infrastructure/http/InvocationIo";
import { createPatternCache, matchAlertsForSubscribedRoute } from "~/domain/surface/surfaceAlerts";
import { logger } from "~/infrastructure/logging/logger";

const DELIVERY_CLAIM_LEASE_MS = 30_000;

function causedByInvocationBudgetExceeded(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null) {
    if (current instanceof InvocationBudgetExceeded) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

function subscriptionStillFavouritesDeliveryTarget(
  delivery: AlertDeliveryRecord,
  subscription: PushSubscriptionRecord,
  agencyId: string,
): boolean {
  // Station matches historically recorded the first affected line, without
  // the station that matched. A remaining station favourite makes a line-only
  // row ambiguous, so retain the prior recovery behavior for those rows.
  if (
    delivery.routeId === undefined &&
    subscription.favouriteStations.some((favourite) => favourite.agencyId === agencyId)
  )
    return true;
  const hasTarget = delivery.lineId !== undefined || delivery.routeId !== undefined;
  if (hasTarget) {
    return (
      (delivery.lineId !== undefined &&
        subscription.favouriteLines.some(
          (favourite) => favourite.agencyId === agencyId && favourite.lineId === delivery.lineId,
        )) ||
      (delivery.routeId !== undefined &&
        subscription.favouriteSurfaceRoutes.some(
          (favourite) => favourite.agencyId === agencyId && favourite.routeId === delivery.routeId,
        ))
    );
  }

  // Legacy station or generic deliveries do not retain their original station
  // target. Keep them eligible while the rider still has any favourite here.
  return (
    subscription.favouriteLines.some((favourite) => favourite.agencyId === agencyId) ||
    subscription.favouriteStations.some((favourite) => favourite.agencyId === agencyId) ||
    subscription.favouriteSurfaceRoutes.some((favourite) => favourite.agencyId === agencyId)
  );
}

export interface EvaluationSummary {
  readonly activeAlertsEvaluated: number;
  readonly subscriptionsChecked: number;
  readonly activePushesSent: number;
  readonly clearedPushesSent: number;
  readonly expiredSubscriptionsPruned: number;
  readonly rejectedSubscriptionsPruned: number;
}

/** Public feed facts and aggregate outcomes only; never subscription keys or payload text. */
export interface EvaluationDiagnostic {
  readonly stage: "snapshot" | "skip" | "push" | "complete" | "failed";
  readonly agencyId: string;
  readonly evaluatedAt: number;
  readonly observedAt: number;
  readonly alertId?: string;
  readonly incidentKey?: string;
  readonly reason?:
    | "not-severe"
    | "not-active"
    | "commute-inactive"
    | "favourites-unmatched"
    | "incident-already-sent"
    | "push-backoff"
    | "snapshot-not-live";
  readonly phase?: "active" | "recovery";
  readonly outcome?: "accepted" | "rejected" | "expired" | "failed";
  readonly statusCode?: number;
  readonly elapsedMs?: number;
  readonly generatedAt?: number;
  readonly sourceUpdatedAt?: number;
  readonly freshness?: AgencySnapshot["freshness"];
  readonly alertCount?: number;
  readonly summary?: EvaluationSummary;
}

export interface EvaluationOptions {
  readonly sendOptions?: VapidSendOptions;
  /** Select the subscription locale whose matching snapshot is being evaluated. */
  readonly locale?: UiLocale;
  /** Rotate the first recipient for bounded Workers invocations. */
  readonly recipientOffset?: number;
  /** One invocation's validated subscription snapshot; never retained in the evaluator stack. */
  readonly subscriptions?: readonly PushSubscriptionRecord[];
  /** Outstanding targets already loaded by the Workers selector. */
  readonly outstandingSubscriptionIds?: readonly string[];
  /** Called after a selected recipient finishes evaluation for this agency. */
  readonly onRecipientProcessed?: (agencyId: string, subscriptionId: string) => void;
  /** Current invocation's repository and query budget; cached stacks retain neither. */
  readonly repository?: SubscriptionRepositoryService;
  /** Route matching uses the same declared policy as alert interpretation. */
  readonly routeIdNormalization?: RouteIdNormalization;
}

export interface AlertEvaluatorServiceApi {
  /** Distinct subscription locales that need a snapshot in the next evaluation cycle. */
  readonly getRequiredLocales: (
    agencyId: string,
  ) => Effect.Effect<readonly UiLocale[], SubscriptionStorageError>;
  readonly evaluateAndDispatch: (
    snapshot: AgencySnapshot,
    now?: number,
    options?: EvaluationOptions,
  ) => Effect.Effect<EvaluationSummary, SubscriptionStorageError | VapidError>;
}

export class AlertEvaluatorService extends Context.Service<
  AlertEvaluatorService,
  AlertEvaluatorServiceApi
>()("AlertEvaluatorService") {}

/**
 * Evaluates whether a commute schedule window is currently active for the given timezone and time.
 * Timezone is always caller-supplied, callers resolve it from the
 * subscription record or the active agency manifest.
 */
export function isScheduleActive(
  schedule: CommuteSchedule,
  timezone: string,
  now = Date.now(),
): boolean {
  if (!schedule.enabled) return false;

  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });

    const parts = formatter.formatToParts(new Date(now));
    const weekdayStr = parts.find((p) => p.type === "weekday")?.value ?? "";
    const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
    const minute = parts.find((p) => p.type === "minute")?.value ?? "00";

    const dayMap: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };

    const currentDay = dayMap[weekdayStr] ?? 0;
    const currentTime = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;

    if (schedule.start <= schedule.end) {
      // Standard daytime window within a single calendar day
      if (!schedule.days.includes(currentDay)) {
        return false;
      }
      return currentTime >= schedule.start && currentTime <= schedule.end;
    }

    // Overnight window crossing midnight (e.g. 22:00 to 02:00)
    if (currentTime >= schedule.start) {
      // Pre-midnight portion belongs to current day
      return schedule.days.includes(currentDay);
    }
    if (currentTime <= schedule.end) {
      // Post-midnight portion belongs to previous calendar day
      const previousDay = currentDay === 0 ? 6 : currentDay - 1;
      return schedule.days.includes(previousDay);
    }
    return false;
  } catch (err) {
    logger.warn("isScheduleActive: time format error, falling back to false", { err });
    return false;
  }
}

export interface AlertMatchResult {
  readonly matches: boolean;
  readonly lineId?: string;
  readonly routeId?: string;
}

/** Folded text comparison: case, spacing, and accents never identify an incident. */
function normalizeIncidentText(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeIncidentId(value: string): string {
  return value.trim().toLowerCase();
}

/** cyrb53: dependency-free 53-bit hash, deterministic across Bun/node/workerd. */
function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Stable incident identity for dedupe: agency + kind + severity + sorted
 * attribution + normalized title. `kind`/`severity` already encode the raw
 * protocol effect via Core interpretation. Deliberately excludes the upstream
 * id (churns across fetches per the GTFS-RT spec), timing (corrected
 * timestamps must not re-push), and description (volatile detail; headline
 * rewrites are the new-incident edge). The `v1-` prefix versions the
 * normalization so future changes miss old keys loudly (one re-push) rather
 * than colliding silently.
 *
 * A declared source identity (`v2-`) is the operator's statement that
 * translated variants are one incident. It excludes `kind`/`severity` because
 * those are classified from translated prose and may differ by language.
 */
export function incidentKeyForAlert(agencyId: string, alert: AgencyAlert): string {
  if (alert.incidentIdentity) {
    const canonical = JSON.stringify([
      agencyId.trim(),
      alert.incidentIdentity.namespace.trim(),
      alert.incidentIdentity.value.trim(),
    ]);
    return `v2-${cyrb53(canonical).toString(16)}`;
  }

  const lines = [...(alert.affectedLineIds ?? [])].map(normalizeIncidentId).sort();
  const routes = [...(alert.affectedRouteIds ?? [])].map(normalizeIncidentId).sort();
  const stations = [
    ...(alert.affectedStations ?? []).map((s) =>
      s.stationId ? normalizeIncidentId(s.stationId) : normalizeIncidentText(s.stationName),
    ),
    ...(alert.fromStation
      ? [
          alert.fromStation.stationId
            ? normalizeIncidentId(alert.fromStation.stationId)
            : normalizeIncidentText(alert.fromStation.stationName),
        ]
      : []),
    ...(alert.toStation
      ? [
          alert.toStation.stationId
            ? normalizeIncidentId(alert.toStation.stationId)
            : normalizeIncidentText(alert.toStation.stationName),
        ]
      : []),
    ...(alert.targets ?? []).map((t) =>
      t.station
        ? `${normalizeIncidentId(t.routeId ?? "")}@${t.station.stationId ? normalizeIncidentId(t.station.stationId) : normalizeIncidentText(t.station.stationName)}`
        : normalizeIncidentId(t.routeId ?? ""),
    ),
  ].sort();
  const canonical = JSON.stringify([
    agencyId.trim(),
    alert.kind,
    alert.severity,
    lines,
    routes,
    stations,
    normalizeIncidentText(alert.title),
  ]);
  return `v1-${cyrb53(canonical).toString(16)}`;
}

function makeDeliveryClaim(input: {
  agencyId: string;
  alertId: string;
  incidentKey: string;
  subscriptionId: string;
  locale: UiLocale;
  phase: AlertDeliveryClaim["phase"];
}): AlertDeliveryClaim {
  const claimedAt = Date.now();
  return {
    ...input,
    localeScope: input.incidentKey.startsWith("v2-") ? "*" : input.locale,
    ownerToken: crypto.randomUUID(),
    claimedAt,
    expiresAt: claimedAt + DELIVERY_CLAIM_LEASE_MS,
  };
}

// Prose without structured station evidence must explicitly name a station.
// A bare name can identify a road, neighbourhood, or surface stop instead.
// The shared cache escapes names and bounds memory across subscriptions.
const stationPattern = createPatternCache((key) => {
  const namedStation = /(?:^|\s)stations?$/i.test(key)
    ? key
    : `(?:${key}\\s+stations?|station\\s+${key})`;
  // "Between A and B stations" explicitly qualifies both endpoints.
  const spans = STATION_SPAN_CONNECTORS.map(
    ({ between, separator }) =>
      `${between}\\s+${key}\\s+${separator}\\s+[\\p{L}\\p{N}][\\p{L}\\p{N} '’().-]*?\\s+stations?`,
  );
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])(?:${[namedStation, ...spans].join("|")})(?![\\p{L}\\p{N}])`,
    "iu",
  );
});

/**
 * Checks if an alert matches a user's subscription preferences.
 */
export function doesAlertMatchSubscription(
  alert: AgencyAlert,
  sub: PushSubscriptionRecord,
  agencyId: string,
  routeIdNormalization?: RouteIdNormalization,
): AlertMatchResult {
  const lineId = alert.affectedLineIds?.find((id) =>
    sub.favouriteLines.some(
      (favourite) => favourite.agencyId === agencyId && favourite.lineId === id,
    ),
  );
  const firstAffectedLineId = alert.affectedLineIds?.[0];

  // 1. Line match
  if (lineId) {
    return { matches: true, lineId };
  }

  // 2. Match station references or explicit station mentions in prose.
  if (sub.favouriteStations.length > 0) {
    const stationReferences = alertStationReferences(alert);
    // Fully resolved station identities are authoritative. Only unresolved or
    // absent references need prose recovery, such as a JSON header prefix.
    const hasCanonicalStationTargets =
      stationReferences.length > 0 && stationReferences.every((station) => station.stationId);
    for (const favourite of sub.favouriteStations) {
      if (favourite.agencyId !== agencyId) continue;
      if (stationReferences.some((station) => station.stationName === favourite.stationName)) {
        return { matches: true, lineId: lineId ?? firstAffectedLineId };
      }
      if (hasCanonicalStationTargets) continue;
      const regex = stationPattern(favourite.stationName);
      if (regex.test(alert.title) || (alert.description && regex.test(alert.description))) {
        return { matches: true, lineId: lineId ?? firstAffectedLineId };
      }
    }
  }

  // 3. Surface route match
  if (sub.favouriteSurfaceRoutes.length > 0) {
    for (const favourite of sub.favouriteSurfaceRoutes) {
      if (favourite.agencyId !== agencyId) continue;
      const matched = matchAlertsForSubscribedRoute(
        favourite.routeId,
        [alert],
        routeIdNormalization,
      );
      if (matched.length > 0) {
        return { matches: true, routeId: favourite.routeId };
      }
    }
  }

  return { matches: false };
}

interface SevereSnapshotEvidence {
  readonly severeAlerts: readonly AgencyAlert[];
  readonly severeIncidentKeys: ReadonlySet<string>;
  readonly severeAlertIds: ReadonlySet<string>;
}

function deliveryTargetStillPresent(
  delivery: AlertDeliveryRecord,
  evidence: SevereSnapshotEvidence,
  subscription: PushSubscriptionRecord,
  agencyId: string,
  routeIdNormalization?: RouteIdNormalization,
): boolean {
  const { severeAlerts, severeIncidentKeys, severeAlertIds } = evidence;
  // A declared source identity is stronger than the old delivery target: the
  // key itself tells us whether that article is still a severe active incident.
  if (delivery.incidentKey.startsWith("v2-")) {
    return severeIncidentKeys.has(delivery.incidentKey);
  }
  // Legacy content keys cannot identify a translated rewrite. The same
  // upstream id is still authoritative evidence that the incident remains.
  if (severeAlertIds.has(delivery.alertId)) return true;
  if (!delivery.lineId && !delivery.routeId) {
    // Older generic/station-only rows do not record their station target.
    // Preserve them until the complete snapshot has no severe incidents;
    // another alert cannot prove that this particular station incident ended.
    return severeAlerts.length > 0;
  }

  for (const alert of severeAlerts) {
    const match = doesAlertMatchSubscription(alert, subscription, agencyId, routeIdNormalization);
    if (!match.matches) continue;
    if (delivery.lineId) {
      const lineId = normalizeIncidentId(delivery.lineId);
      if (
        alert.affectedLineIds?.some((candidate) => normalizeIncidentId(candidate) === lineId) ||
        (match.lineId !== undefined && normalizeIncidentId(match.lineId) === lineId)
      ) {
        return true;
      }
      continue;
    }
    if (delivery.routeId) {
      const routeId = normalizeIncidentId(delivery.routeId);
      if (
        alert.affectedRouteIds?.some((candidate) => normalizeIncidentId(candidate) === routeId) ||
        (match.routeId !== undefined && normalizeIncidentId(match.routeId) === routeId)
      ) {
        return true;
      }
      continue;
    }
  }
  return false;
}

export function createLiveAlertEvaluatorService(
  options: { readonly onDiagnostic?: (event: EvaluationDiagnostic) => void } = {},
): Layer.Layer<AlertEvaluatorService, never, SubscriptionRepository | VapidClient> {
  return Layer.effect(
    AlertEvaluatorService,
    Effect.gen(function* () {
      const subRepo = yield* SubscriptionRepository;
      const vapid = yield* VapidClient;

      return AlertEvaluatorService.of({
        getRequiredLocales: (agencyId) =>
          Effect.gen(function* () {
            const subscriptions = yield* subRepo.getActiveSubscriptions();
            // Self-hosted deployments poll every agency each cycle. Workers
            // select recipients and budget locales separately in the scheduler.
            if (subscriptions.length === 0) return [DEFAULT_UI_LOCALE];
            const outstanding = yield* subRepo.getOutstandingDeliveryTargets();
            const recoveryRecipients = new Set(
              outstanding
                .filter((target) => target.agencyId === agencyId)
                .map((target) => target.subscriptionId),
            );
            const relevantSubscriptions = subscriptions.filter(
              (subscription) =>
                recoveryRecipients.has(subscription.id) ||
                subscription.favouriteLines.some((favourite) => favourite.agencyId === agencyId) ||
                subscription.favouriteStations.some(
                  (favourite) => favourite.agencyId === agencyId,
                ) ||
                subscription.favouriteSurfaceRoutes.some(
                  (favourite) => favourite.agencyId === agencyId,
                ),
            );
            return relevantSubscriptions.length > 0
              ? requiredSubscriptionLocales(relevantSubscriptions)
              : [DEFAULT_UI_LOCALE];
          }),
        evaluateAndDispatch: (
          snapshot: AgencySnapshot,
          now = Date.now(),
          evaluationOptions: EvaluationOptions = {},
        ) =>
          Effect.gen(function* () {
            const startedAt = Date.now();
            const repository = evaluationOptions.repository ?? subRepo;
            const emit = (
              event: Omit<EvaluationDiagnostic, "agencyId" | "evaluatedAt" | "observedAt">,
            ) => {
              if (
                !options.onDiagnostic &&
                (event.stage === "skip" || event.stage === "snapshot") &&
                logger.getLevel() !== "debug"
              )
                return;
              const diagnostic: EvaluationDiagnostic = {
                ...event,
                agencyId: snapshot.agencyId,
                evaluatedAt: now,
                observedAt: Date.now(),
              };
              if (options.onDiagnostic) {
                try {
                  options.onDiagnostic(diagnostic);
                } catch {
                  logger.warn("AlertEvaluator: diagnostic observer failed");
                }
              } else if (
                event.stage === "failed" ||
                (event.stage === "push" && event.outcome !== "accepted")
              ) {
                logger.warn("AlertEvaluator: diagnostic", diagnostic);
              } else if (event.stage === "complete" || event.stage === "push") {
                logger.info("AlertEvaluator: diagnostic", diagnostic);
              } else {
                logger.debug("AlertEvaluator: diagnostic", diagnostic);
              }
            };
            emit({
              stage: "snapshot",
              generatedAt: snapshot.generatedAt,
              sourceUpdatedAt: snapshot.sourceUpdatedAt,
              freshness: snapshot.freshness,
              alertCount: snapshot.alerts.length,
            });
            // A failed or partial fetch cannot prove that an incident ended.
            // Preserve history until a complete live snapshot is available.
            if (snapshot.freshness !== "live") {
              emit({ stage: "skip", reason: "snapshot-not-live" });
              const summary: EvaluationSummary = {
                activeAlertsEvaluated: 0,
                subscriptionsChecked: 0,
                activePushesSent: 0,
                clearedPushesSent: 0,
                expiredSubscriptionsPruned: 0,
                rejectedSubscriptionsPruned: 0,
              };
              emit({ stage: "complete", summary, elapsedMs: Date.now() - startedAt });
              return summary;
            }
            const allSubscriptions =
              evaluationOptions.subscriptions ?? (yield* repository.getActiveSubscriptions());
            const outstandingSubscriptionIds =
              evaluationOptions.outstandingSubscriptionIds === undefined
                ? new Set(
                    allSubscriptions.length === 0
                      ? []
                      : (yield* repository.getOutstandingDeliveryTargets())
                          .filter((target) => target.agencyId === snapshot.agencyId)
                          .map((target) => target.subscriptionId),
                  )
                : new Set(evaluationOptions.outstandingSubscriptionIds);
            const subscriptions = allSubscriptions.filter((subscription) => {
              if (outstandingSubscriptionIds.has(subscription.id)) return true;
              const hasFavourite =
                subscription.favouriteLines.some(
                  (favourite) => favourite.agencyId === snapshot.agencyId,
                ) ||
                subscription.favouriteStations.some(
                  (favourite) => favourite.agencyId === snapshot.agencyId,
                ) ||
                subscription.favouriteSurfaceRoutes.some(
                  (favourite) => favourite.agencyId === snapshot.agencyId,
                );
              const isCommuteActive = subscription.commuteSchedules.some((schedule) =>
                isScheduleActive(schedule, subscription.timezone, now),
              );
              if (hasFavourite && isCommuteActive) return true;
              if (snapshot.alerts.length > 0) {
                emit({
                  stage: "skip",
                  reason: hasFavourite ? "commute-inactive" : "favourites-unmatched",
                });
              }
              return false;
            });
            const selectedLocale = evaluationOptions.locale;
            const localeSubscriptions =
              selectedLocale === undefined
                ? subscriptions
                : subscriptions.filter((sub) => normalizeLocale(sub.locale) === selectedLocale);
            const recipientOffset =
              localeSubscriptions.length === 0
                ? 0
                : (((evaluationOptions.recipientOffset ?? 0) % localeSubscriptions.length) +
                    localeSubscriptions.length) %
                  localeSubscriptions.length;
            const orderedSubscriptions =
              recipientOffset === 0
                ? localeSubscriptions
                : [
                    ...localeSubscriptions.slice(recipientOffset),
                    ...localeSubscriptions.slice(0, recipientOffset),
                  ];
            const deliveryRows =
              orderedSubscriptions.length === 0
                ? []
                : yield* repository.getDeliveriesForSubscriptions(
                    snapshot.agencyId,
                    orderedSubscriptions.map((subscription) => subscription.id),
                  );
            const deliveriesBySubscription = new Map<string, AlertDeliveryRecord[]>();
            for (const delivery of deliveryRows) {
              const rows = deliveriesBySubscription.get(delivery.subscriptionId) ?? [];
              rows.push(delivery);
              deliveriesBySubscription.set(delivery.subscriptionId, rows);
            }

            // Filter for active severe alerts only per §38 strict severe-only
            // rule. Expired severe alerts must not be sent late, and must be
            // absent from the recovery baseline below.
            const severeAlerts = snapshot.alerts.filter((a) => {
              const reason =
                a.severity !== "severe"
                  ? "not-severe"
                  : a.lifecycle !== "active"
                    ? "not-active"
                    : undefined;
              if (reason) emit({ stage: "skip", alertId: a.id, reason });
              return reason === undefined;
            });
            const currentSevereIncidentKeys = new Set(
              severeAlerts.map((a) => incidentKeyForAlert(snapshot.agencyId, a)),
            );

            const currentSevereAlertIds = new Set(severeAlerts.map((alert) => alert.id));
            const currentSevereSnapshot: SevereSnapshotEvidence = {
              severeAlerts,
              severeIncidentKeys: currentSevereIncidentKeys,
              severeAlertIds: currentSevereAlertIds,
            };

            let activePushesSent = 0;
            let clearedPushesSent = 0;
            let expiredSubscriptionsPruned = 0;
            let rejectedSubscriptionsPruned = 0;
            let subscriptionsChecked = 0;
            const markRecipientProcessed = (subscription: PushSubscriptionRecord) => {
              subscriptionsChecked += 1;
              evaluationOptions.onRecipientProcessed?.(snapshot.agencyId, subscription.id);
            };

            recipientLoop: for (const sub of orderedSubscriptions) {
              const subscriptionLocale = normalizeLocale(sub.locale, DEFAULT_UI_LOCALE);
              const notificationCopy = getLocaleMessages(subscriptionLocale).notifications;
              const acceptedIncidentKeys = new Set<string>();
              const acceptedAlertIds = new Set<string>();
              // Check if any commute schedule is currently active
              const isCommuteActive = sub.commuteSchedules.some((s) =>
                isScheduleActive(s, sub.timezone, now),
              );

              let isSubPruned = false;
              let isRecipientDeferred = false;
              let isRecipientBackedOff = false;
              let recipientStorageFailed = false;
              const isolateStorageFailure = (
                effect: Effect.Effect<void, SubscriptionStorageError>,
              ) =>
                effect.pipe(
                  Effect.catchTag("SubscriptionStorageError", (error) => {
                    if (causedByInvocationBudgetExceeded(error)) return Effect.fail(error);
                    recipientStorageFailed = true;
                    logger.warn("AlertEvaluator: subscription storage failed", {
                      agencyId: snapshot.agencyId,
                      subscriptionId: sub.id,
                    });
                    return Effect.void;
                  }),
                );

              // Delivery history, read once: dedupe and recovery share it.
              // Only outstanding (active_sent) rows suppress: a cleared
              // incident that recurs with identical content is a new
              // inactive→active edge and must push again.
              const previousDeliveries = deliveriesBySubscription.get(sub.id) ?? [];
              // Reconcile old-language evidence against the complete live
              // state before the commute gate. A localized notification may
              // have been rejected, so delivery success cannot decide whether
              // the old incident is still active. `deliveryTargetStillPresent`
              // uses stable v2 identity when available and a conservative
              // recipient-target match for legacy content keys.
              for (const delivery of previousDeliveries) {
                if (
                  delivery.status === "active_sent" &&
                  normalizeLocale(delivery.locale) !== subscriptionLocale &&
                  !deliveryTargetStillPresent(
                    delivery,
                    currentSevereSnapshot,
                    sub,
                    snapshot.agencyId,
                    evaluationOptions.routeIdNormalization,
                  )
                ) {
                  yield* isolateStorageFailure(
                    repository.recordDelivery({ ...delivery, status: "cleared_silent" }, now),
                  );
                  if (recipientStorageFailed) break;
                }
              }
              if (recipientStorageFailed) continue recipientLoop;
              if (!isCommuteActive) {
                emit({ stage: "skip", reason: "commute-inactive" });
                // Observe recovery even while delivery is disabled. Otherwise
                // an identical incident can stay suppressed for later commutes.
                // Keep the recorded locale unchanged for incidents that remain
                // active: no notification in the selected locale was accepted.
                for (const delivery of previousDeliveries) {
                  if (
                    delivery.status === "active_sent" &&
                    normalizeLocale(delivery.locale) === subscriptionLocale &&
                    !currentSevereIncidentKeys.has(delivery.incidentKey) &&
                    !currentSevereAlertIds.has(delivery.alertId)
                  ) {
                    yield* isolateStorageFailure(
                      repository.recordDelivery({ ...delivery, status: "cleared_silent" }, now),
                    );
                    if (recipientStorageFailed) break;
                  }
                }
                if (recipientStorageFailed) continue recipientLoop;
                markRecipientProcessed(sub);
                continue;
              }
              if ((sub.pushRetryAt ?? 0) > now) {
                emit({ stage: "skip", reason: "push-backoff" });
                markRecipientProcessed(sub);
                continue;
              }
              const declaredIncidentKeys = new Set(
                severeAlerts
                  .filter((alert) => alert.incidentIdentity !== undefined)
                  .map((alert) => incidentKeyForAlert(snapshot.agencyId, alert)),
              );
              const seenIncidentKeys = new Set(
                previousDeliveries
                  .filter(
                    (d) =>
                      d.status === "active_sent" &&
                      (normalizeLocale(d.locale) === subscriptionLocale ||
                        declaredIncidentKeys.has(d.incidentKey)),
                  )
                  .map((d) => d.incidentKey),
              );

              const sendPush = (
                phase: "active" | "recovery",
                alertId: string,
                incidentKey: string,
                payload: PushPayload,
              ) =>
                Effect.suspend(() => {
                  const sendStartedAt = Date.now();
                  return vapid.sendNotification(sub, payload, evaluationOptions.sendOptions).pipe(
                    Effect.tapError(() =>
                      Effect.sync(() =>
                        emit({
                          stage: "push",
                          phase,
                          alertId,
                          incidentKey,
                          outcome: "failed",
                          elapsedMs: Date.now() - sendStartedAt,
                        }),
                      ),
                    ),
                    Effect.tap((result) =>
                      Effect.sync(() =>
                        emit({
                          stage: "push",
                          phase,
                          alertId,
                          incidentKey,
                          outcome: result.expired
                            ? "expired"
                            : result.success
                              ? "accepted"
                              : "rejected",
                          statusCode: result.statusCode,
                          elapsedMs: Date.now() - sendStartedAt,
                        }),
                      ),
                    ),
                    // Transport failure belongs to this attempt, not the
                    // agency's batch. Leave its ledger untouched for retry.
                    Effect.catchTag("VapidError", (error) =>
                      Effect.succeed({
                        success: false,
                        expired: false,
                        statusCode: 0,
                        credentialFailure: false,
                        retryAfterAt: undefined,
                        deferred:
                          error.cause instanceof InvocationBudgetExceeded && !error.attempted,
                      } satisfies SendPushResult),
                    ),
                  );
                });

              const withMutation = <A, E>(
                attempt: (
                  mutation: Pick<
                    typeof repository,
                    | "claimDelivery"
                    | "completeDeliveryClaim"
                    | "releaseDeliveryClaim"
                    | "recordPushFailure"
                    | "deleteSubscriptionByEndpoint"
                  >,
                ) => Effect.Effect<A, E>,
              ) =>
                Effect.acquireUseRelease(
                  repository.reserveMutation?.() ?? Effect.succeed(undefined),
                  (reservation) => attempt(reservation ?? repository),
                  (reservation) => Effect.sync(() => reservation?.release()),
                );

              // 1. Evaluate active severe alerts
              for (const alert of severeAlerts) {
                const match = doesAlertMatchSubscription(
                  alert,
                  sub,
                  snapshot.agencyId,
                  evaluationOptions.routeIdNormalization,
                );
                if (!match.matches) {
                  emit({ stage: "skip", alertId: alert.id, reason: "favourites-unmatched" });
                  continue;
                }

                // Deduplicate by incident content, not upstream id: feed
                // publishers churn FeedEntity ids across fetches, and only
                // content identifies the rider-visible incident.
                const incidentKey = incidentKeyForAlert(snapshot.agencyId, alert);
                if (seenIncidentKeys.has(incidentKey)) {
                  emit({
                    stage: "skip",
                    alertId: alert.id,
                    incidentKey,
                    reason: "incident-already-sent",
                  });
                  continue;
                }

                // Construct Active Push Payload, guarantee visible text:
                // whitespace-only feed values must never produce a blank notification
                const alertTitle = (alert.title ?? "").trim();
                const targetLabel = match.lineId
                  ? formatLocaleMessage(notificationCopy.active.lineTarget, { id: match.lineId })
                  : notificationCopy.active.genericTarget;
                const alertBody =
                  (alert.description ?? "").trim() ||
                  alertTitle ||
                  notificationCopy.active.fallbackBody;
                const payload: PushPayload = {
                  title: formatLocaleMessage(notificationCopy.active.title, {
                    target: targetLabel,
                    alert: alertTitle || notificationCopy.active.fallbackTitle,
                  }),
                  body: alertBody,
                  tag: `transit-alert-${snapshot.agencyId}-${incidentKey}`,
                  data: {
                    url: `/?alert=${encodeURIComponent(alert.id)}`,
                    agencyId: snapshot.agencyId,
                    alertId: alert.id,
                    lineId: match.lineId,
                    routeId: match.routeId,
                  },
                };
                const claim = makeDeliveryClaim({
                  agencyId: snapshot.agencyId,
                  alertId: alert.id,
                  incidentKey,
                  subscriptionId: sub.id,
                  locale: subscriptionLocale,
                  phase: "active",
                });

                yield* isolateStorageFailure(
                  withMutation((mutation) =>
                    Effect.gen(function* () {
                      if (!(yield* mutation.claimDelivery(claim))) return;
                      let settled = false;
                      yield* Effect.acquireUseRelease(
                        Effect.succeed(undefined),
                        () =>
                          Effect.gen(function* () {
                            const result = yield* sendPush(
                              "active",
                              alert.id,
                              incidentKey,
                              payload,
                            );
                            if (result.deferred) {
                              isRecipientDeferred = true;
                              return;
                            }
                            if (result.expired) {
                              // Deleting the endpoint is the terminal outcome;
                              // a leftover claim expires after the short lease.
                              settled = true;
                              yield* mutation.deleteSubscriptionByEndpoint(sub.endpoint);
                              expiredSubscriptionsPruned++;
                              isSubPruned = true;
                            } else if (result.success) {
                              activePushesSent++;
                              seenIncidentKeys.add(incidentKey);
                              acceptedIncidentKeys.add(incidentKey);
                              acceptedAlertIds.add(alert.id);
                              const delivery: AlertDeliveryClaimOutcome = {
                                id: `del_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
                                agencyId: snapshot.agencyId,
                                alertId: alert.id,
                                incidentKey,
                                subscriptionId: sub.id,
                                locale: subscriptionLocale,
                                lineId: match.lineId,
                                routeId: match.routeId,
                                status: "active_sent",
                                deliveredAt: now,
                              };
                              // If persistence fails after HTTP acceptance, the
                              // claim lease bounds recovery and retry. The push
                              // service and SQL store cannot share a transaction.
                              settled = true;
                              yield* mutation.completeDeliveryClaim(claim, delivery);
                            } else {
                              const failure = yield* mutation.recordPushFailure(claim, {
                                attemptedAt: now,
                                hardFailure: shouldCountHardPushFailure(
                                  result.statusCode,
                                  result.credentialFailure,
                                ),
                                retryAfterAt: result.retryAfterAt,
                              });
                              settled = true;
                              if (
                                failure !== null &&
                                failure.hardFailureCount >= PUSH_HARD_FAILURE_LIMIT
                              ) {
                                yield* mutation.deleteSubscriptionByEndpoint(sub.endpoint);
                                rejectedSubscriptionsPruned++;
                                isSubPruned = true;
                              }
                              yield* mutation.releaseDeliveryClaim(claim);
                              isRecipientBackedOff = !isSubPruned;
                            }
                          }),
                        () => (settled ? Effect.void : mutation.releaseDeliveryClaim(claim)),
                      );
                    }),
                  ),
                );
                if (recipientStorageFailed) break;
                if (isSubPruned) break;
                if (isRecipientDeferred) break;
                if (isRecipientBackedOff) break;
              }

              if (recipientStorageFailed) continue recipientLoop;
              if (isRecipientDeferred) {
                break recipientLoop;
              }
              if (isSubPruned) {
                markRecipientProcessed(sub);
                continue;
              }
              if (isRecipientBackedOff) {
                markRecipientProcessed(sub);
                continue;
              }

              // 2. Evaluate Cleared / Recovery Notifications
              const activeDeliveries = previousDeliveries.filter((d) => d.status === "active_sent");
              // One all-clear per incident: id churn can leave several rows
              // for the same content hash behind (one per upstream id).
              const attemptedRecoveryIncidentKeys = new Set<string>();

              for (const prevDelivery of activeDeliveries) {
                if (normalizeLocale(prevDelivery.locale) !== subscriptionLocale) {
                  // A locale change can churn source IDs and translated
                  // headlines. Keep the last accepted language through a
                  // rejected send or an inactive commute; after a new
                  // language push succeeds, retire old-language evidence
                  // silently so it cannot create a false recovery push.
                  if (acceptedIncidentKeys.has(prevDelivery.incidentKey)) {
                    // A successful localized send under this upstream ID
                    // replaced the old row. Other same-incident rows remain
                    // old-language evidence and can be retired silently.
                    if (acceptedAlertIds.has(prevDelivery.alertId)) continue;
                    yield* isolateStorageFailure(
                      repository.recordDelivery(
                        {
                          ...prevDelivery,
                          status: "cleared_silent",
                        },
                        now,
                      ),
                    );
                    if (recipientStorageFailed) break;
                  }
                  continue;
                }
                const stillActiveByKey = currentSevereIncidentKeys.has(prevDelivery.incidentKey);
                const stillActiveById = currentSevereAlertIds.has(prevDelivery.alertId);
                // If the incident's content hash left the active set, send recovery notification
                if (stillActiveByKey || stillActiveById) {
                  // Keep prior locale evidence until the active pass records a
                  // successful delivery in this locale. A rejected push must
                  // never turn old-language history into a recovery baseline
                  // for a notification the rider did not receive.
                  continue;
                }
                // The active loop may have re-recorded this upstream id under
                // a new key this same tick (headline rewrite); do not recover a
                // row already replaced by the active pass.
                if (acceptedAlertIds.has(prevDelivery.alertId)) continue;
                if (attemptedRecoveryIncidentKeys.has(prevDelivery.incidentKey)) continue;
                attemptedRecoveryIncidentKeys.add(prevDelivery.incidentKey);
                if (
                  !subscriptionStillFavouritesDeliveryTarget(prevDelivery, sub, snapshot.agencyId)
                ) {
                  yield* isolateStorageFailure(
                    repository.recordDelivery(
                      {
                        ...prevDelivery,
                        status: "cleared_silent",
                      },
                      now,
                    ),
                  );
                  if (recipientStorageFailed) break;
                  continue;
                }
                const recoveryRecord: AlertDeliveryClaimOutcome = {
                  id: `del_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
                  agencyId: snapshot.agencyId,
                  alertId: prevDelivery.alertId,
                  incidentKey: prevDelivery.incidentKey,
                  subscriptionId: sub.id,
                  lineId: prevDelivery.lineId,
                  routeId: prevDelivery.routeId,
                  status: "cleared_sent",
                  deliveredAt: now,
                  locale: subscriptionLocale,
                };
                const targetLabel = prevDelivery.lineId
                  ? formatLocaleMessage(notificationCopy.recovery.lineTarget, {
                      id: prevDelivery.lineId,
                    })
                  : prevDelivery.routeId
                    ? formatLocaleMessage(notificationCopy.recovery.routeTarget, {
                        id: prevDelivery.routeId,
                      })
                    : notificationCopy.recovery.genericTarget;

                const recoveryPayload: PushPayload = {
                  title: formatLocaleMessage(notificationCopy.recovery.title, {
                    target: targetLabel,
                  }),
                  body: formatLocaleMessage(notificationCopy.recovery.body, {
                    target: targetLabel,
                  }),
                  tag: `transit-alert-${snapshot.agencyId}-${prevDelivery.incidentKey}`,
                  data: {
                    url: prevDelivery.lineId
                      ? `/?line=${encodeURIComponent(prevDelivery.lineId)}`
                      : "/",
                    agencyId: snapshot.agencyId,
                    alertId: prevDelivery.alertId,
                    lineId: prevDelivery.lineId,
                    routeId: prevDelivery.routeId,
                  },
                };
                const claim = makeDeliveryClaim({
                  agencyId: snapshot.agencyId,
                  alertId: prevDelivery.alertId,
                  incidentKey: prevDelivery.incidentKey,
                  subscriptionId: sub.id,
                  locale: subscriptionLocale,
                  phase: "recovery",
                });

                yield* isolateStorageFailure(
                  withMutation((mutation) =>
                    Effect.gen(function* () {
                      if (!(yield* mutation.claimDelivery(claim))) return;
                      let settled = false;
                      yield* Effect.acquireUseRelease(
                        Effect.succeed(undefined),
                        () =>
                          Effect.gen(function* () {
                            const result = yield* sendPush(
                              "recovery",
                              prevDelivery.alertId,
                              prevDelivery.incidentKey,
                              recoveryPayload,
                            );
                            if (result.deferred) {
                              isRecipientDeferred = true;
                              return;
                            }
                            if (result.expired) {
                              settled = true;
                              yield* mutation.deleteSubscriptionByEndpoint(sub.endpoint);
                              expiredSubscriptionsPruned++;
                              isSubPruned = true;
                            } else if (result.success) {
                              clearedPushesSent++;
                              // The history still reads active_sent until the
                              // owner-checked outcome lands, so competing
                              // evaluations cannot infer a recovery from a
                              // pending claim.
                              settled = true;
                              yield* mutation.completeDeliveryClaim(claim, recoveryRecord);
                            } else {
                              const failure = yield* mutation.recordPushFailure(claim, {
                                attemptedAt: now,
                                hardFailure: shouldCountHardPushFailure(
                                  result.statusCode,
                                  result.credentialFailure,
                                ),
                                retryAfterAt: result.retryAfterAt,
                              });
                              settled = true;
                              if (
                                failure !== null &&
                                failure.hardFailureCount >= PUSH_HARD_FAILURE_LIMIT
                              ) {
                                yield* mutation.deleteSubscriptionByEndpoint(sub.endpoint);
                                rejectedSubscriptionsPruned++;
                                isSubPruned = true;
                              }
                              yield* mutation.releaseDeliveryClaim(claim);
                              isRecipientBackedOff = !isSubPruned;
                            }
                          }),
                        () => (settled ? Effect.void : mutation.releaseDeliveryClaim(claim)),
                      );
                    }),
                  ),
                );
                if (recipientStorageFailed) break;
                if (isSubPruned) break;
                if (isRecipientDeferred) break;
                if (isRecipientBackedOff) break;
              }
              if (recipientStorageFailed) continue recipientLoop;
              if (isRecipientDeferred) {
                break recipientLoop;
              }
              if (isRecipientBackedOff) {
                markRecipientProcessed(sub);
                continue;
              }
              markRecipientProcessed(sub);
            }

            const summary = {
              activeAlertsEvaluated: severeAlerts.length,
              subscriptionsChecked,
              activePushesSent,
              clearedPushesSent,
              expiredSubscriptionsPruned,
              rejectedSubscriptionsPruned,
            };
            emit({ stage: "complete", summary, elapsedMs: Date.now() - startedAt });
            return summary;
          }).pipe(
            Effect.tapError(() =>
              Effect.sync(() => {
                const event: EvaluationDiagnostic = {
                  stage: "failed",
                  agencyId: snapshot.agencyId,
                  evaluatedAt: now,
                  observedAt: Date.now(),
                };
                if (options.onDiagnostic) {
                  try {
                    options.onDiagnostic(event);
                  } catch {
                    logger.warn("AlertEvaluator: diagnostic observer failed");
                  }
                } else logger.warn("AlertEvaluator: diagnostic", event);
              }),
            ),
          ),
      });
    }),
  );
}
