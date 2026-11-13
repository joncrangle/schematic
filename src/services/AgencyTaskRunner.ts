import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { allProviders } from "~/agencies";
import type { AgencyProvider, AgencySnapshot } from "~/agencies";
import { getVapidConfig } from "~/infrastructure/env/ServerEnv";
import {
  AlertEvaluatorService,
  createLiveAlertEvaluatorService,
  type AlertEvaluatorServiceApi,
  type EvaluationSummary,
  type EvaluationOptions,
} from "./notifications/AlertEvaluatorService";
import { createLiveNotificationsRepositoryLayer } from "~/infrastructure/storage/SubscriptionRepository";
import { createVapidClientLayer } from "~/infrastructure/notifications/VapidClient";
import { logger } from "~/infrastructure/logging/logger";

/** The services needed by an agency's background alert task. */
export interface AgencyTaskStack {
  readonly evaluator: AlertEvaluatorServiceApi;
}

/**
 * A builder may return an Effect or a Promise for test and adapter seams. The
 * runner turns both into one Effect before a job is run; it never runs an
 * Effect from inside an Effect.tryPromise callback.
 */
export type AgencyTaskStackBuilder = (
  provider: AgencyProvider,
  invalidate: () => void,
) => Effect.Effect<AgencyTaskStack, unknown> | Promise<AgencyTaskStack>;

export interface AgencyTaskRunnerOptions {
  readonly providers?: () => readonly AgencyProvider[];
  readonly buildStack?: AgencyTaskStackBuilder;
  readonly vapidConfig?: typeof getVapidConfig;
  readonly getVapidConfig?: typeof getVapidConfig;
}

export type AgencyJobAggregatePolicy = "propagate" | "swallow+debug";

const VAPID_STACK_INVALIDATION_DEBOUNCE_MS = 5 * 60_000;

/** A job is data; the runner owns provider iteration, isolation and policy. */
export interface AgencyJobDescriptor {
  readonly name: string;
  readonly cron: string;
  readonly run: (provider: AgencyProvider) => Effect.Effect<unknown, unknown>;
  readonly onAggregate: AgencyJobAggregatePolicy;
  /**
   * How many agencies a job drives at once. A number bounds the fanout — the
   * alert evaluation job passes the Workers concurrent-connection limit, so a
   * job never opens more upstream connections than the runtime allows.
   */
  readonly concurrency?: number | "unbounded";
  /** Rotate bounded jobs so repeated resource exhaustion cannot starve the registry tail. */
  readonly providerOffset?: number;
  /** Give the cursor's first agency its budget turn before starting concurrent work. */
  readonly runFirstProviderAlone?: boolean;
}

export interface AgencyJobResult {
  readonly failedIds: readonly string[];
}

interface CachedEvaluationStack {
  readonly deferred: Deferred.Deferred<AgencyTaskStack, unknown>;
  started: boolean;
  effect: Effect.Effect<AgencyTaskStack, unknown>;
}

function defaultBuildStack(
  provider: AgencyProvider,
  invalidate: () => void,
  readVapidConfig: typeof getVapidConfig,
): Effect.Effect<AgencyTaskStack, unknown> {
  return Effect.suspend(() => {
    const vapidKeys = readVapidConfig();
    if (!vapidKeys) {
      return Effect.fail(
        new AgencyTaskRunnerError([provider.manifest.id], "VAPID keys are not configured"),
      );
    }

    try {
      const fullLayer = createLiveAlertEvaluatorService().pipe(
        Layer.provide(
          Layer.merge(
            createLiveNotificationsRepositoryLayer(),
            // Only an explicit bad VAPID/JWT response reaches this callback.
            // A generic 403 can be one subscription's restricted-key mismatch.
            createVapidClientLayer(vapidKeys, { onUnauthorized: invalidate }),
          ),
        ),
      );

      return Effect.gen(function* () {
        const evaluator = yield* AlertEvaluatorService;
        return { evaluator };
      }).pipe(Effect.provide(fullLayer));
    } catch (cause) {
      return Effect.fail(cause);
    }
  });
}

/**
 * Owns per-agency layer construction and all lifecycle state for background
 * work. A Promise, rather than a resolved Context, is cached so concurrent
 * callers share one build. Rejected builds are evicted and can be retried.
 */
export class AgencyTaskRunner {
  private readonly providers: () => readonly AgencyProvider[];
  private readonly buildStack: AgencyTaskStackBuilder;
  private readonly readVapidConfig: typeof getVapidConfig;
  private readonly stacks = new Map<string, CachedEvaluationStack>();
  private readonly stackPromises = new Map<string, Promise<AgencyTaskStack>>();
  private lastVapidInvalidationAt = Number.NEGATIVE_INFINITY;

  constructor(options: AgencyTaskRunnerOptions = {}) {
    this.providers = options.providers ?? allProviders;
    this.readVapidConfig = options.vapidConfig ?? options.getVapidConfig ?? getVapidConfig;
    this.buildStack =
      options.buildStack ??
      ((provider, invalidate) => defaultBuildStack(provider, invalidate, this.readVapidConfig));
  }

  /** Drop one agency's stack, or every VAPID-dependent stack when omitted. */
  invalidate(agencyId?: string): void {
    if (agencyId === undefined) {
      this.stacks.clear();
      this.stackPromises.clear();
    } else {
      this.stacks.delete(agencyId);
      this.stackPromises.delete(agencyId);
    }
  }

  private invalidateForVapidCredentialFailure(): void {
    const now = Date.now();
    if (now - this.lastVapidInvalidationAt < VAPID_STACK_INVALIDATION_DEBOUNCE_MS) return;
    this.lastVapidInvalidationAt = now;
    this.invalidate();
  }

  /**
   * Effect-native cache seam used by all runner jobs. The cache stores a
   * Deferred rather than a resolved value, so concurrent Effects share the
   * same build without introducing a runPromise boundary into composition.
   */
  getEvaluationStackEffect(provider: AgencyProvider): Effect.Effect<AgencyTaskStack, unknown> {
    const agencyId = provider.manifest.id;
    const existing = this.stacks.get(agencyId);
    if (existing) return existing.effect;

    const deferred = Deferred.makeUnsafe<AgencyTaskStack, unknown>();
    const entry: CachedEvaluationStack = {
      deferred,
      started: false,
      effect: undefined as never,
    };
    entry.effect = Effect.suspend(() => {
      if (entry.started) return Deferred.await(deferred);
      entry.started = true;

      return Effect.try({
        try: () => this.readVapidConfig(),
        catch: (cause) => cause,
      }).pipe(
        Effect.flatMap((vapidKeys) =>
          vapidKeys
            ? this.buildStackEffect(provider)
            : Effect.fail(new AgencyTaskRunnerError([agencyId], "VAPID keys are not configured")),
        ),
        Effect.flatMap((stack) =>
          Deferred.done<AgencyTaskStack, unknown>(Exit.succeed(stack))(deferred).pipe(
            Effect.as(stack),
          ),
        ),
        Effect.onExit((exit) => {
          if (Exit.isSuccess(exit)) return Effect.void;
          return Deferred.done<AgencyTaskStack, unknown>(exit)(deferred).pipe(
            Effect.andThen(
              Effect.sync(() => {
                if (this.stacks.get(agencyId) === entry) this.stacks.delete(agencyId);
              }),
            ),
          );
        }),
      );
    });
    this.stacks.set(agencyId, entry);
    return entry.effect;
  }

  private buildStackEffect(provider: AgencyProvider): Effect.Effect<AgencyTaskStack, unknown> {
    return Effect.suspend(() => {
      try {
        const built = this.buildStack(provider, () => this.invalidateForVapidCredentialFailure());
        return Effect.isEffect(built) ? built : Effect.promise(() => built);
      } catch (cause) {
        return Effect.fail(cause);
      }
    });
  }

  getEvaluationStack(provider: AgencyProvider): Promise<AgencyTaskStack> {
    const agencyId = provider.manifest.id;
    const existing = this.stackPromises.get(agencyId);
    if (existing) return existing;

    const building = Effect.runPromise(this.getEvaluationStackEffect(provider));
    this.stackPromises.set(agencyId, building);
    building.then(undefined, () => {
      if (this.stackPromises.get(agencyId) === building) this.stackPromises.delete(agencyId);
    });
    return building;
  }

  async evaluateSnapshot(
    provider: AgencyProvider,
    snapshot: AgencySnapshot,
    options?: EvaluationOptions,
  ): Promise<EvaluationSummary> {
    return Effect.runPromise(this.evaluateSnapshotEffect(provider, snapshot, options));
  }

  private evaluateSnapshotEffect(
    provider: AgencyProvider,
    snapshot: AgencySnapshot,
    options?: EvaluationOptions,
  ): Effect.Effect<EvaluationSummary, unknown> {
    if (snapshot.agencyId !== provider.manifest.id) {
      return Effect.fail(
        new Error(
          `Agency snapshot mismatch: provider "${provider.manifest.id}" returned "${snapshot.agencyId}"`,
        ),
      );
    }

    return this.getEvaluationStackEffect(provider).pipe(
      Effect.flatMap(({ evaluator }) =>
        evaluator.evaluateAndDispatch(snapshot, undefined, {
          ...options,
          routeIdNormalization:
            options?.routeIdNormalization ??
            provider.manifest.alertInterpretation?.routeIdNormalization,
        }),
      ),
    );
  }

  /**
   * Run one descriptor for every registered provider. Provider failures are
   * folded into outcomes before Effect.forEach sees them, so concurrency never
   * changes the guarantee that every provider gets a turn.
   */
  runJob(
    descriptor: AgencyJobDescriptor,
    options: { readonly onAggregate?: AgencyJobAggregatePolicy } = {},
  ): Promise<AgencyJobResult> {
    return Effect.runPromise(this.runJobEffect(descriptor, options.onAggregate));
  }

  private runJobEffect(
    descriptor: AgencyJobDescriptor,
    policyOverride?: AgencyJobAggregatePolicy,
  ): Effect.Effect<AgencyJobResult, AgencyTaskRunnerError> {
    const registered = this.providers();
    const offset =
      registered.length === 0 ? 0 : (descriptor.providerOffset ?? 0) % registered.length;
    const providers = [...registered.slice(offset), ...registered.slice(0, offset)];
    const policy = policyOverride ?? descriptor.onAggregate;
    const runProvider = (provider: AgencyProvider) => {
      const effect = Effect.try({
        try: () => descriptor.run(provider),
        catch: (cause) => cause,
      }).pipe(Effect.flatMap((job) => job));

      // Exit captures both typed failures and defects (including a rejected
      // Effect.promise), keeping the per-agency isolation guarantee intact.
      return Effect.exit(effect).pipe(
        Effect.flatMap((exit) => {
          if (Exit.isSuccess(exit)) {
            return Effect.succeed({ id: provider.manifest.id, failed: false });
          }
          return Effect.sync(() => {
            logger.error("AgencyTaskRunner: agency job failed", {
              job: descriptor.name,
              agencyId: provider.manifest.id,
              err: String(exit.cause),
            });
            return { id: provider.manifest.id, failed: true };
          });
        }),
      );
    };
    const runConcurrent = (batch: readonly AgencyProvider[]) =>
      Effect.forEach(batch, runProvider, { concurrency: descriptor.concurrency ?? 1 });
    const outcomes =
      descriptor.runFirstProviderAlone && providers.length > 0
        ? runProvider(providers[0]!).pipe(
            Effect.flatMap((first) =>
              runConcurrent(providers.slice(1)).pipe(Effect.map((rest) => [first, ...rest])),
            ),
          )
        : runConcurrent(providers);

    return outcomes.pipe(
      Effect.flatMap((results) => {
        const failedIds = results.filter((result) => result.failed).map((result) => result.id);
        if (failedIds.length === 0) return Effect.succeed({ failedIds });

        const aggregate = new AgencyTaskRunnerError(failedIds, undefined, descriptor.name);
        if (policy === "swallow+debug") {
          return Effect.sync(() => {
            logger.debug("AgencyTaskRunner: swallowed aggregate job failure", {
              job: descriptor.name,
              cron: descriptor.cron,
              failedIds,
            });
            return { failedIds };
          });
        }
        return Effect.fail(aggregate);
      }),
    );
  }
}

export const agencyTaskRunner = new AgencyTaskRunner();

export class AgencyTaskRunnerError extends Data.TaggedError("AgencyTaskRunnerError")<{
  readonly failedIds: readonly string[];
  readonly failedAgencyIds: readonly string[];
  readonly reason?: string;
  readonly jobName?: string;
}> {
  constructor(failedIds: readonly string[], reason?: string, jobName?: string) {
    super({ failedIds: [...failedIds], failedAgencyIds: [...failedIds], reason, jobName });
  }

  get message(): string {
    return this.reason
      ? `AgencyTaskRunner: ${this.reason}`
      : `AgencyTaskRunner: ${this.jobName ?? "agency job"} failed for agencies: ${this.failedIds.join(", ")}`;
  }
}
