import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { allProviders } from "~/agencies";
import {
  createCloudflareInvocationIo,
  createInvocationBudget,
} from "~/infrastructure/http/InvocationIo";
import { ALERT_EVALUATION_CRON, SLOW_ALERT_EVALUATION_CRON } from "~/domain/notifications/cron";
import { createHostConcurrencyLimiter } from "~/infrastructure/http/hostConcurrency";
import { isAlertSourceActive } from "~/infrastructure/realtime/alertSourceActivity";
import { getFeedSecret, getVapidConfig } from "~/infrastructure/env/ServerEnv";
import { logger } from "~/infrastructure/logging/logger";
import { createServerAgencyRuntime } from "~/services/AgencyRuntimeServer";
import {
  agencyTaskRunner,
  type AgencyJobAggregatePolicy,
  type AgencyJobDescriptor,
} from "~/services/AgencyTaskRunner";
import { isScheduleActive } from "~/services/notifications/AlertEvaluatorService";
import type { PushSubscriptionRecord } from "~/domain/notifications/types";
import { DEFAULT_UI_LOCALE, normalizeLocale } from "~/domain/locale";
import {
  SubscriptionRepository,
  type RecipientRotationCursorReservation,
  type SubscriptionStorageError,
  type SubscriptionRepositoryService,
  createLiveNotificationsRepositoryLayer,
} from "~/infrastructure/storage/SubscriptionRepository";

/** The only cron expressions owned by application code. Keep wrangler.jsonc as the deployment mirror. */
export { ALERT_EVALUATION_CRON, SLOW_ALERT_EVALUATION_CRON } from "~/domain/notifications/cron";

export type CronJob = "evaluate-alerts" | "evaluate-slow-alerts";

// Cadence sets and budget arithmetic live in cycleBudget so scripts and tests
// share them without importing the scheduler's Effect machinery.
import {
  FAST_ALERT_SOURCE_TYPES,
  SLOW_ALERT_SOURCE_TYPES,
  type AlertCadence,
  type AlertSourceType,
} from "./cycleBudget";
export {
  FAST_ALERT_SOURCE_TYPES,
  SLOW_ALERT_SOURCE_TYPES,
  type AlertCadence,
  type AlertSourceType,
};

import {
  type HostingTarget,
  detectHostingTarget,
  resetHostingTargetProbeForTesting,
} from "~/infrastructure/env/hostingTarget";
export { type HostingTarget, detectHostingTarget };

/** Keeps per-locale failure detail in the log without dumping whole schema causes. */
function summarizeCause(cause: unknown, maxLength = 400): string {
  const text = String(cause).replace(/\s+/g, " ").trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

/** One or more subscription-locale snapshots failed for an agency this cycle. */
export class LocaleEvaluationError extends Data.TaggedError("LocaleEvaluationError")<{
  readonly agencyId: string;
  readonly failedLocales: readonly string[];
  /** One `locale: cause` summary per failed locale so the aggregate log is diagnosable. */
  readonly failures: readonly string[];
}> {
  get message(): string {
    const details = this.failures.length > 0 ? ` (${this.failures.join("; ")})` : "";
    return `ProductionScheduler: snapshot evaluation failed for ${this.agencyId} locales: ${this.failedLocales.join(", ")}${details}`;
  }
}

export interface ScheduledEvent {
  readonly cron: string;
  readonly scheduledTime: number;
}

export interface ScheduledEventContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface ScheduledDispatchOperations {
  readonly runEvaluationCycle: typeof runEvaluationCycle;
}

export interface SchedulerStartResult {
  readonly hosting: HostingTarget;
  readonly started: boolean;
}

export function resolveCronJob(cron: string): CronJob | null {
  if (cron === ALERT_EVALUATION_CRON) return "evaluate-alerts";
  if (cron === SLOW_ALERT_EVALUATION_CRON) return "evaluate-slow-alerts";
  return null;
}

/**
 * Bound concurrent agency starts. Each agency separately bounds its source and
 * page fanouts; Workers queues connections while waiting for response headers.
 */
const EVALUATION_CONCURRENCY = 6;
/** Per-host alert requests per job, so a shared vendor host isn't hit all at once. */
const ALERT_HOST_CONCURRENCY = 4;
/** Bound one cursor page while reserving room for ledger and outcome queries. */
const WORKER_RECIPIENT_PAGE_SIZE = 50;

interface NotificationWork {
  readonly subscriptionsByAgency: ReadonlyMap<string, readonly PushSubscriptionRecord[]>;
  readonly outstandingSubscriptionIdsByAgency: ReadonlyMap<string, readonly string[]>;
  readonly recipientCursorId: string;
  readonly recipientCursor: number;
  readonly providerOffset: number;
  readonly recipientOrder: ReadonlyMap<string, number>;
  readonly processedRecipientIndexes: Set<number>;
  readonly cursorReservation?: RecipientRotationCursorReservation;
  readonly repository: SubscriptionRepositoryService;
}

function recipientKey(agencyId: string, subscriptionId: string): string {
  return JSON.stringify([agencyId, subscriptionId]);
}

function evaluationJob(
  selection: {
    /**
     * Agencies without a runtime-active source of these types are skipped
     * without fetching. Runtime-active means passing isAlertSourceActive
     * (runtimes gating plus base-URL provisioning), not merely declared:
     * YRT declares a web board that is self-hosted-only, so on Workers it
     * correctly counts as fast-only.
     */
    readonly presenceTypes?: readonly AlertSourceType[];
    /** Cron expression attributed in aggregate logging. */
    readonly cron?: string;
    /** The invocation's stable cadence ordinal shared with recipient selection. */
    readonly cadenceOrdinal?: number;
    readonly notificationWork?: NotificationWork;
  } = {},
  generation?: number,
): AgencyJobDescriptor {
  const hostingTarget = detectHostingTarget();
  const cache =
    typeof caches === "undefined"
      ? undefined
      : (caches as CacheStorage & { default?: Cache }).default;
  const io =
    hostingTarget === "cloudflare"
      ? createCloudflareInvocationIo({
          fetch: (...args) => globalThis.fetch(...args),
          cache,
          limit: 49,
        })
      : undefined;
  // Job-scoped so no promise crosses a Workers invocation.
  const alertHostLimiter = createHostConcurrencyLimiter(ALERT_HOST_CONCURRENCY);
  const presenceTypes = selection.presenceTypes;
  const jobCron = selection.cron ?? ALERT_EVALUATION_CRON;
  const jobName =
    jobCron === SLOW_ALERT_EVALUATION_CRON ? "evaluate-slow-alerts" : "evaluate-alerts";
  const cadenceOrdinal =
    selection.cadenceOrdinal ??
    Math.floor(Date.now() / (jobCron === SLOW_ALERT_EVALUATION_CRON ? 900_000 : 60_000));
  const workerRotation = hostingTarget === "cloudflare" ? cadenceOrdinal : undefined;
  return {
    name: jobName,
    cron: jobCron,
    onAggregate: "propagate",
    // Bound agency starts; source and crawl fanouts remain separately bounded.
    // Each selected Workers page costs at most a cache lookup, one upstream
    // request and one cache write. Mixed sources reuse their opposite cadence's
    // recent observation, fetching on a miss. Actual polling and dispatch share
    // a 49-operation budget; exhausted work remains stale or undelivered.
    concurrency: EVALUATION_CONCURRENCY,
    providerOffset: selection.notificationWork?.providerOffset ?? workerRotation ?? 0,
    runFirstProviderAlone:
      selection.notificationWork !== undefined &&
      selection.notificationWork.recipientOrder.size > 0,
    run: (provider) => {
      if (generation !== undefined && generation !== schedulerGeneration) {
        return Effect.succeed(undefined);
      }
      if (
        selection.notificationWork !== undefined &&
        !selection.notificationWork.subscriptionsByAgency.has(provider.manifest.id)
      ) {
        return Effect.succeed(undefined);
      }
      if (
        presenceTypes !== undefined &&
        provider.alerts !== undefined &&
        !provider.alerts.some(
          (source) =>
            presenceTypes.includes(source.type) &&
            isAlertSourceActive(source, hostingTarget, getFeedSecret),
        )
      ) {
        logger.debug(
          "ProductionScheduler: agency has no active sources on this cadence, skipping",
          {
            agencyId: provider.manifest.id,
            cron: jobCron,
          },
        );
        return Effect.succeed(undefined);
      }

      const runtime = createServerAgencyRuntime(provider, {
        fetch:
          io?.fetch ??
          (((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)) as typeof fetch),
        alertSourceTypes: hostingTarget === "cloudflare" ? presenceTypes : undefined,
        alertConditionalCache: io?.cache,
        alertHostLimiter,
      });
      if (!runtime.hasSnapshot) {
        logger.debug("ProductionScheduler: agency exposes no snapshot port, skipping evaluation", {
          agencyId: provider.manifest.id,
        });
        return Effect.succeed(undefined);
      }
      return agencyTaskRunner.getEvaluationStackEffect(provider).pipe(
        Effect.flatMap(({ evaluator }) => {
          const selectedSubscriptions = selection.notificationWork?.subscriptionsByAgency.get(
            provider.manifest.id,
          );
          // Workers already loaded the invocation's validated recipient set.
          // Derive locales from that same snapshot to avoid an unbudgeted
          // repository read and keep feeds aligned with recipients.
          return selectedSubscriptions === undefined
            ? evaluator.getRequiredLocales(provider.manifest.id)
            : Effect.succeed(
                selectedSubscriptions.length === 0
                  ? [DEFAULT_UI_LOCALE]
                  : [
                      ...new Set(
                        selectedSubscriptions.map((subscription) =>
                          normalizeLocale(subscription.locale),
                        ),
                      ),
                    ],
              );
        }),
        Effect.flatMap((locales) =>
          // One locale at a time preserves the six-provider connection ceiling.
          Effect.forEach(
            locales,
            (locale) => {
              const localeRun = Effect.suspend(() => {
                if (generation !== undefined && generation !== schedulerGeneration) {
                  return Effect.succeed(undefined);
                }
                const fetchStartedAt = Date.now();
                logger.debug("ProductionScheduler: snapshot fetch started", {
                  agencyId: provider.manifest.id,
                  locale,
                  fetchStartedAt,
                });
                return Effect.tryPromise({
                  try: () => runtime.getSnapshot(locale),
                  catch: (cause) => cause,
                }).pipe(
                  Effect.tap((snapshot) =>
                    Effect.sync(() =>
                      logger.info("ProductionScheduler: snapshot received", {
                        agencyId: provider.manifest.id,
                        locale,
                        fetchStartedAt,
                        observedAt: Date.now(),
                        elapsedMs: Date.now() - fetchStartedAt,
                        generatedAt: snapshot.generatedAt,
                        sourceUpdatedAt: snapshot.sourceUpdatedAt,
                        freshness: snapshot.freshness,
                        alertCount: snapshot.alerts.length,
                      }),
                    ),
                  ),
                  Effect.tapError((cause) =>
                    Effect.sync(() =>
                      logger.warn("ProductionScheduler: snapshot fetch failed", {
                        agencyId: provider.manifest.id,
                        locale,
                        fetchStartedAt,
                        observedAt: Date.now(),
                        elapsedMs: Date.now() - fetchStartedAt,
                        err: summarizeCause(cause),
                      }),
                    ),
                  ),
                  Effect.flatMap((snapshot) =>
                    Effect.suspend(() =>
                      generation !== undefined && generation !== schedulerGeneration
                        ? Effect.succeed(undefined)
                        : Effect.tryPromise({
                            try: () =>
                              agencyTaskRunner.evaluateSnapshot(provider, snapshot, {
                                locale,
                                sendOptions: io?.sendOptions,
                                subscriptions:
                                  selection.notificationWork?.subscriptionsByAgency.get(
                                    provider.manifest.id,
                                  ),
                                outstandingSubscriptionIds:
                                  selection.notificationWork?.outstandingSubscriptionIdsByAgency.get(
                                    provider.manifest.id,
                                  ),
                                onRecipientProcessed: (agencyId, subscriptionId) => {
                                  const index = selection.notificationWork?.recipientOrder.get(
                                    recipientKey(agencyId, subscriptionId),
                                  );
                                  if (index !== undefined)
                                    selection.notificationWork?.processedRecipientIndexes.add(
                                      index,
                                    );
                                },
                                repository: selection.notificationWork?.repository,
                              }),
                            catch: (cause) => cause,
                          }),
                    ),
                  ),
                );
              });
              return Effect.exit(localeRun).pipe(Effect.map((exit) => ({ locale, exit })));
            },
            { concurrency: 1 },
          ).pipe(
            Effect.flatMap((outcomes) => {
              const failedLocales: string[] = [];
              const failures: string[] = [];
              for (const outcome of outcomes) {
                const exit = outcome.exit;
                if (Exit.isSuccess(exit)) continue;
                failedLocales.push(outcome.locale);
                failures.push(`${outcome.locale}: ${summarizeCause(exit.cause)}`);
              }
              if (failedLocales.length === 0) return Effect.void;
              return Effect.fail(
                new LocaleEvaluationError({
                  agencyId: provider.manifest.id,
                  failedLocales,
                  failures,
                }),
              );
            }),
          ),
        ),
      );
    },
  };
}

function runEvaluationCycleEffect(
  options: {
    readonly onAggregate?: AgencyJobAggregatePolicy;
    readonly presenceTypes?: readonly AlertSourceType[];
    readonly cron?: string;
  } = {},
  generation?: number,
): Effect.Effect<void, unknown> {
  return Effect.suspend(() => {
    if (generation !== undefined && generation !== schedulerGeneration) {
      return Effect.succeed(undefined);
    }
    if (!getVapidConfig()) {
      return Effect.sync(() => {
        logger.warn("ProductionScheduler: VAPID keys not configured, skipping alert evaluation");
      });
    }
    const hostingTarget = detectHostingTarget();
    const now = Date.now();
    const cadenceOrdinal = Math.floor(
      now / (options.cron === SLOW_ALERT_EVALUATION_CRON ? 900_000 : 60_000),
    );
    const recipientCursorId =
      options.cron === SLOW_ALERT_EVALUATION_CRON ? "evaluate-slow-alerts" : "evaluate-alerts";
    const work: Effect.Effect<NotificationWork | undefined, SubscriptionStorageError> =
      hostingTarget === "cloudflare"
        ? Effect.gen(function* () {
            const repository = yield* SubscriptionRepository;
            const subscriptions = yield* repository.getActiveSubscriptions();
            const targetIds = new Map<string, Set<string>>();
            const outstandingIdsByAgency = new Map<string, Set<string>>();
            const addTarget = (agencyId: string, subscriptionId: string) => {
              const ids = targetIds.get(agencyId) ?? new Set<string>();
              ids.add(subscriptionId);
              targetIds.set(agencyId, ids);
            };
            if (subscriptions.length > 0) {
              for (const target of yield* repository.getOutstandingDeliveryTargets()) {
                addTarget(target.agencyId, target.subscriptionId);
                const ids = outstandingIdsByAgency.get(target.agencyId) ?? new Set<string>();
                ids.add(target.subscriptionId);
                outstandingIdsByAgency.set(target.agencyId, ids);
              }
              for (const subscription of subscriptions) {
                for (const favourite of [
                  ...subscription.favouriteLines,
                  ...subscription.favouriteStations,
                  ...subscription.favouriteSurfaceRoutes,
                ])
                  addTarget(favourite.agencyId, subscription.id);
              }
            }
            const providers = allProviders();
            const providersById = new Map(
              providers.map((provider) => [provider.manifest.id, provider]),
            );
            const candidates = [...targetIds]
              .flatMap(([agencyId, ids]) => {
                const provider = providersById.get(agencyId);
                if (provider === undefined) return [];
                if (
                  options.presenceTypes !== undefined &&
                  provider.alerts !== undefined &&
                  !provider.alerts.some(
                    (source) =>
                      options.presenceTypes!.includes(source.type) &&
                      isAlertSourceActive(source, hostingTarget, getFeedSecret),
                  )
                )
                  return [];
                const outstanding = outstandingIdsByAgency.get(agencyId) ?? new Set<string>();
                return subscriptions
                  .filter((subscription) => {
                    if (!ids.has(subscription.id)) return false;
                    if (outstanding.has(subscription.id)) return true;
                    const hasFavourite = [
                      ...subscription.favouriteLines,
                      ...subscription.favouriteStations,
                      ...subscription.favouriteSurfaceRoutes,
                    ].some((favourite) => favourite.agencyId === agencyId);
                    return (
                      hasFavourite &&
                      subscription.commuteSchedules.some((schedule) =>
                        isScheduleActive(schedule, subscription.timezone, now),
                      )
                    );
                  })
                  .map((subscription) => ({ agencyId, subscription }));
              })
              .sort(
                (left, right) =>
                  left.agencyId.localeCompare(right.agencyId) ||
                  left.subscription.id.localeCompare(right.subscription.id),
              );
            const recipientCursor =
              candidates.length === 0
                ? 0
                : yield* repository.getRecipientRotationCursor(recipientCursorId);
            const cursorReservation =
              candidates.length === 0 ||
              repository.reserveRecipientRotationCursorAdvance === undefined
                ? undefined
                : yield* repository.reserveRecipientRotationCursorAdvance();
            const pageStart = candidates.length === 0 ? 0 : recipientCursor % candidates.length;
            const pageCount = Math.min(candidates.length, WORKER_RECIPIENT_PAGE_SIZE);
            const page = Array.from(
              { length: pageCount },
              (_, index) => candidates[(pageStart + index) % candidates.length]!,
            );
            const recipientOrder = new Map(
              page.map(({ agencyId, subscription }, index) => [
                recipientKey(agencyId, subscription.id),
                index,
              ]),
            );
            const processedRecipientIndexes = new Set<number>();
            const firstRecipientAgency = page[0]?.agencyId;
            const providerOffset =
              firstRecipientAgency === undefined
                ? providers.length === 0
                  ? 0
                  : cadenceOrdinal % providers.length
                : Math.max(
                    0,
                    providers.findIndex(
                      (provider) => provider.manifest.id === firstRecipientAgency,
                    ),
                  );
            const pollAgencyIds = [...targetIds.keys()].filter((agencyId) =>
              providersById.has(agencyId),
            );
            const subscriptionsByAgency = new Map<string, readonly PushSubscriptionRecord[]>(
              pollAgencyIds.map((agencyId) => [agencyId, []]),
            );
            const selectedOutstandingIds = new Map<string, Set<string>>(
              pollAgencyIds.map((agencyId) => [agencyId, new Set<string>()]),
            );
            for (const { agencyId, subscription } of page) {
              const selected = [...(subscriptionsByAgency.get(agencyId) ?? []), subscription];
              subscriptionsByAgency.set(agencyId, selected);
              if (outstandingIdsByAgency.get(agencyId)?.has(subscription.id)) {
                const ids = selectedOutstandingIds.get(agencyId)!;
                ids.add(subscription.id);
              }
            }
            return {
              subscriptionsByAgency,
              outstandingSubscriptionIdsByAgency: new Map(
                [...selectedOutstandingIds].map(([agencyId, ids]) => [agencyId, [...ids]]),
              ),
              recipientCursorId,
              recipientCursor,
              providerOffset,
              recipientOrder,
              processedRecipientIndexes,
              cursorReservation,
              repository,
            } satisfies NotificationWork;
          }).pipe(
            Effect.provide(
              createLiveNotificationsRepositoryLayer({ queryBudget: createInvocationBudget(50) }),
            ),
          )
        : Effect.succeed(undefined);
    return work.pipe(
      Effect.flatMap((notificationWork) => {
        if (notificationWork !== undefined && notificationWork.subscriptionsByAgency.size === 0)
          return Effect.void;
        return Effect.tryPromise({
          try: () =>
            agencyTaskRunner.runJob(
              evaluationJob(
                {
                  presenceTypes: options.presenceTypes,
                  cron: options.cron,
                  cadenceOrdinal,
                  notificationWork,
                },
                generation,
              ),
              options,
            ),
          catch: (cause) => cause,
        }).pipe(
          Effect.asVoid,
          Effect.ensuring(
            notificationWork?.cursorReservation === undefined
              ? Effect.void
              : Effect.acquireUseRelease(
                  Effect.succeed(notificationWork.cursorReservation),
                  (reservation) =>
                    reservation.advance(
                      notificationWork.recipientCursorId,
                      notificationWork.recipientCursor,
                      notificationWork.processedRecipientIndexes.size,
                    ),
                  (reservation) => Effect.sync(() => reservation.release()),
                ).pipe(
                  Effect.catchCause((cause) =>
                    Effect.sync(() =>
                      logger.warn("ProductionScheduler: recipient rotation update failed", {
                        cause: String(cause),
                      }),
                    ),
                  ),
                ),
          ),
        );
      }),
    );
  });
}

interface InFlightEvaluationCycle {
  readonly fiber: Fiber.Fiber<void, unknown>;
  readonly promise: Promise<void>;
}

const inFlightEvaluationCycles = new Map<string, InFlightEvaluationCycle>();

/**
 * Keys the shared in-flight cycle by what it fetches. The fast and slow
 * cadences do different work (different agencies, different snapshots), so
 * collapsing them into one promise would serve one cadence the other's
 * result. Selections that fetch identically share; `onAggregate` is
 * deliberately excluded since it only changes aggregate-error policy, not
 * the snapshot work, and keeps the pre-existing first-caller-wins behavior.
 */
function evaluationCycleKey(options: {
  readonly presenceTypes?: readonly AlertSourceType[];
  readonly cron?: string;
}): string {
  return JSON.stringify({
    presenceTypes: options.presenceTypes ?? null,
    cron: options.cron ?? null,
  });
}

function startEvaluationCycle(
  options: {
    readonly onAggregate?: AgencyJobAggregatePolicy;
    readonly presenceTypes?: readonly AlertSourceType[];
    readonly cron?: string;
  } = {},
  generation?: number,
): Promise<void> {
  if (generation !== undefined && generation !== schedulerGeneration) {
    return Promise.resolve();
  }
  const key = evaluationCycleKey(options);
  const inFlight = inFlightEvaluationCycles.get(key);
  if (inFlight !== undefined) return inFlight.promise;

  const fiber = Effect.runFork(runEvaluationCycleEffect(options, generation));
  const promise = Effect.runPromise(Fiber.join(fiber));
  inFlightEvaluationCycles.set(key, { fiber, promise });
  const clear = () => {
    if (inFlightEvaluationCycles.get(key)?.promise === promise) {
      inFlightEvaluationCycles.delete(key);
    }
  };
  promise.then(clear, clear);
  return promise;
}

/** Options narrowing one alert evaluation cycle to a source cadence. */
export interface EvaluationCycleOptions {
  readonly onAggregate?: AgencyJobAggregatePolicy;
  /**
   * Agencies without a runtime-active source of these types are skipped
   * without fetching. On Workers, agencies must also have current favourites
   * or outstanding accepted incidents; commute windows do not gate polling.
   * Selected types are polled and recent cached observations of
   * the other types complete the snapshot. Cache misses fetch normally.
   */
  readonly presenceTypes?: readonly AlertSourceType[];
  /** Cron expression attributed in aggregate logging. */
  readonly cron?: string;
}

/**
 * Run one alert evaluation. Concurrent callers with the same selection share
 * the active cycle; different cadences run independently. Without a source
 * selection each eligible agency's full snapshot is fetched. Workers select
 * current favourites and outstanding accepted incidents before polling;
 * self-hosted callers continue evaluating every registered agency.
 */
export function runEvaluationCycle(options: EvaluationCycleOptions = {}): Promise<void> {
  return startEvaluationCycle(options);
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let alertWarmupTimer: ReturnType<typeof setTimeout> | null = null;
let schedulerGeneration = 0;

export function startSelfHostedScheduler(intervalMs = 60_000): void {
  if (
    typeof window !== "undefined" ||
    detectHostingTarget() === "cloudflare" ||
    schedulerTimer !== null
  ) {
    return;
  }
  schedulerGeneration += 1;
  const generation = schedulerGeneration;
  logger.info(
    `ProductionScheduler: starting self-hosted background alert scheduler (${intervalMs / 1000}s interval)`,
  );

  alertWarmupTimer = setTimeout(() => {
    alertWarmupTimer = null;
    if (generation !== schedulerGeneration) return;
    startEvaluationCycle({ onAggregate: "swallow+debug" }, generation).catch((err) => {
      logger.debug("ProductionScheduler: initial evaluation cycle notice", { err });
    });
  }, 5_000);

  schedulerTimer = setInterval(() => {
    if (generation !== schedulerGeneration) return;
    startEvaluationCycle({ onAggregate: "swallow+debug" }, generation).catch((err) => {
      logger.debug("ProductionScheduler: interval evaluation cycle notice", { err });
    });
  }, intervalMs);
}

export async function stopSelfHostedScheduler(): Promise<void> {
  schedulerGeneration += 1;
  const inFlight = [...inFlightEvaluationCycles.values()];
  inFlightEvaluationCycles.clear();
  if (alertWarmupTimer !== null) {
    clearTimeout(alertWarmupTimer);
    alertWarmupTimer = null;
  }
  if (schedulerTimer !== null) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    logger.info("ProductionScheduler: stopped self-hosted background alert scheduler");
  }
  for (const cycle of inFlight) {
    await Effect.runPromise(Fiber.interrupt(cycle.fiber)).then(() => undefined);
  }
}

let schedulerInitialized = false;
let driverStarted = false;

function claimSchedulerInitialization(): boolean {
  if (schedulerInitialized) return false;
  schedulerInitialized = true;
  return true;
}

export function startScheduler(): SchedulerStartResult {
  const hosting = detectHostingTarget();
  if (driverStarted) return { hosting, started: false };
  if (!claimSchedulerInitialization()) {
    driverStarted = true;
    return { hosting, started: false };
  }
  driverStarted = true;

  if (hosting === "self-hosted") {
    startSelfHostedScheduler();
    logger.info("ProductionScheduler: self-hosted runtime detected — alert scheduler started");
  } else {
    logger.info("ProductionScheduler: Cloudflare Workers detected — platform cron owns scheduling");
  }
  return { hosting, started: hosting === "self-hosted" };
}

export async function resetSchedulerForTests(): Promise<void> {
  await stopSelfHostedScheduler();
  driverStarted = false;
  resetHostingTargetProbeForTesting();
  schedulerInitialized = false;
}

/** Explicit startup hook for self-hosted deployments; importing this module is inert. */
export function initSchedulers(): void {
  startScheduler();
}

/** Workers adapter: unknown crons warn; known jobs stay attached to waitUntil. */
export function handleScheduledEvent(
  event: ScheduledEvent,
  _env: unknown,
  ctx: ScheduledEventContext,
  operations: ScheduledDispatchOperations = {
    runEvaluationCycle,
  },
): void {
  logger.info("Cloudflare Worker scheduled cron event received", {
    cron: event.cron,
    scheduledTime: event.scheduledTime,
  });

  switch (resolveCronJob(event.cron)) {
    case "evaluate-alerts":
      ctx.waitUntil(
        operations.runEvaluationCycle({
          onAggregate: "swallow+debug",
          presenceTypes: FAST_ALERT_SOURCE_TYPES,
          cron: ALERT_EVALUATION_CRON,
        }),
      );
      return;
    case "evaluate-slow-alerts":
      ctx.waitUntil(
        operations.runEvaluationCycle({
          onAggregate: "swallow+debug",
          presenceTypes: SLOW_ALERT_SOURCE_TYPES,
          cron: SLOW_ALERT_EVALUATION_CRON,
        }),
      );
      return;
    default:
      logger.warn("ProductionScheduler: unrecognized cron expression, dispatching nothing", {
        cron: event.cron,
      });
  }
}
