import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { HostConcurrencyLimiter } from "~/infrastructure/http/hostConcurrency";

import type {
  AgencyManifest,
  AgencySnapshot,
  AlertSource,
  Schematic,
  SchematicStationIndexEntry,
} from "~/agencies/types";
import { AgencySnapshotSchema } from "~/agencies/types";
import { PLACEHOLDER_ALERT_TITLE } from "~/domain/alerts/placeholderTitle";
import { deduplicateDecodedAlerts, interpretSnapshot } from "~/domain/interpretSnapshot";
import { DEFAULT_UI_LOCALE, normalizeLocale } from "~/domain/locale";
import { isAlertSourceActive } from "./alertSourceActivity";
import { selectAlertSourcesForLocale } from "./alertSourceSelection";
import {
  DEFAULT_FETCH_ATTEMPTS,
  DEFAULT_FETCH_RETRY_DELAY_MS,
  fetchDecodedFeeds,
  type ConditionalGetStore,
} from "./fetchDecodedFeeds";
import {
  alertError,
  alertFeedAdapters,
  AlertFetchError,
  combineAlertFeeds,
  type AlertFeedContext,
} from "./alertFeedAdapters";
import { detectHostingTarget, type HostingTarget } from "~/infrastructure/env/hostingTarget";
import type { TripRouteLookup } from "~/domain/surface/boarding";
import type { RequestScopedEffectCache } from "~/domain/requestScopedEffectCache";
import { TMIX_MAX_SUBREQUESTS } from "./tmix/tmixRealtimeSource";
import { logger } from "~/infrastructure/logging/logger";

export { AlertFetchError, alertError };

export interface FetchAgencyAlertsOptions {
  readonly sourceAgencyIds?: readonly string[];
  readonly getSourceAgencyScope?: import("~/domain/surface/boarding").SourceAgencyScopeLookup;
  readonly identityGeneration?: string;
  readonly agencyId: string;
  readonly sources: readonly AlertSource[];
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly timeZone: string;
  readonly manifest?: Pick<AgencyManifest, "alertInterpretation"> &
    Partial<Pick<AgencyManifest, "locale">>;
  /** Rider locale is validated at this public Core boundary. */
  readonly locale?: unknown;
  readonly stationIndex?: readonly SchematicStationIndexEntry[];
  readonly schematic?: Pick<Schematic, "stations" | "stationAliases">;
  readonly getSecret?: (name: string) => string | undefined;
  readonly devProxyOrigin?: string;
  /** Resolves the route of a trip an alert names, from the seeded trips. */
  readonly getRoutesForTrips?: TripRouteLookup;
  readonly hostingTarget?: HostingTarget;
  /**
   * Overrides the conditional-fetch cache. Tests inject a fake; production
   * resolves `caches.default` on Cloudflare and nothing elsewhere.
   */
  readonly conditionalCache?: Cache;
  /** Shares per-request AnyRide polls with the realtime source. */
  readonly requestCache?: RequestScopedEffectCache;
  /** Shares per-host request slots with other agencies polled in the same cycle. */
  readonly hostLimiter?: HostConcurrencyLimiter;
  /** Workers poll these types; other types reuse a recent observation or fetch on a miss. */
  readonly sourceTypes?: readonly AlertSource["type"][];
}

/**
 * Deep alert-source module: fetches every configured source, dispatches each
 * source to its Core parser, preserves successful partial results as stale,
 * and ports the combined feed through the canonical alert interpreter.
 */
export function fetchAgencyAlerts(
  options: FetchAgencyAlertsOptions,
): Effect.Effect<AgencySnapshot, AlertFetchError> {
  const hostingTarget = options.hostingTarget ?? detectHostingTarget();
  const agencyLocale = options.manifest?.locale ?? DEFAULT_UI_LOCALE;
  const locale = normalizeLocale(options.locale, normalizeLocale(agencyLocale));
  const runtimeSources = options.sources.filter(
    (source) =>
      source.enabled !== false && (!source.runtimes || source.runtimes.includes(hostingTarget)),
  );
  const activeSourceCandidates = runtimeSources.filter((source) =>
    isAlertSourceActive(source, hostingTarget, options.getSecret),
  );
  const activeSources = selectAlertSourcesForLocale(activeSourceCandidates, locale, agencyLocale);
  const missingRequiredSource = runtimeSources.some((source) => {
    if (
      source.requiredForCompleteness !== true ||
      isAlertSourceActive(source, hostingTarget, options.getSecret)
    ) {
      return false;
    }
    if (!source.languageGroup) return true;

    const selectedGroup = activeSources.filter(
      (candidate) => candidate.languageGroup === source.languageGroup,
    );
    if (selectedGroup.length === 0) return true;
    const selectedLanguage = canonicalSourceLanguage(selectedGroup[0]!.language);
    return canonicalSourceLanguage(source.language) === selectedLanguage;
  });

  if (activeSources.length === 0) {
    return validateAgencySnapshot(options, {
      agencyId: options.agencyId,
      generatedAt: options.now(),
      freshness: "unavailable",
      alerts: [],
    });
  }

  return Effect.gen(function* () {
    const ctx = alertFeedContext(options, hostingTarget);
    const anyRideStopBudgets = allocateAnyRideStopBudgets(activeSources);
    const results = yield* Effect.all(
      activeSources.map((source, index) =>
        alertFeedAdapters[source.type](
          source,
          anyRideStopBudgets[index] === undefined
            ? ctx
            : { ...ctx, anyRideStopBudget: anyRideStopBudgets[index] },
        ).pipe(
          Effect.map((value) => ({ status: "fulfilled" as const, value, source })),
          Effect.catch((reason) =>
            Effect.sync(() => {
              logger.warn(`${options.agencyId} alert source failed`, {
                agencyId: options.agencyId,
                sourceType: source.type,
                ...alertFailureMetadata(reason),
              });
              return { status: "rejected" as const, reason };
            }),
          ),
        ),
      ),
      // One agency's sources share the invocation's connection budget with
      // every other agency's. Two at a time keeps a many-sourced agency from
      // crowding out the rest on Workers; self-hosted keeps today's fanout.
      { concurrency: hostingTarget === "cloudflare" ? 2 : "unbounded" },
    );
    const successful = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    if (successful.length === 0) {
      const failure = results.find((result) => result.status === "rejected");
      return yield* Effect.fail(
        failure?.reason ??
          alertError(options, "alerts", `No alert sources available for ${options.agencyId}`),
      );
    }

    const now = options.now();
    let combined = combineAlertFeeds(successful);
    if (
      combined.alerts.some((alert) => alert.targets?.some((target) => target.stopCode)) &&
      options.getSourceAgencyScope
    ) {
      const scope = yield* options
        .getSourceAgencyScope()
        .pipe(Effect.catch(() => Effect.succeed(undefined)));
      combined = {
        ...combined,
        partial: combined.partial || scope === undefined || undefined,
        alerts: combined.alerts.map((alert) => {
          const aliases = new Map<string, string>();
          const targets = alert.targets?.map((target) => {
            if (!target.stopCode || !target.stopId) return target;
            const ids = scope?.stopsByCode?.get(target.stopCode);
            const resolved =
              ids?.length === 1 &&
              scope?.stopIds.has(ids[0]) &&
              options.stationIndex?.some(
                (station) => station.id === ids[0] || station.platformIds.includes(ids[0]),
              );
            const stopId = resolved ? ids[0] : target.stopId;
            aliases.set(target.stopId, stopId);
            return { ...target, stopId };
          });
          return {
            ...alert,
            targets,
            affectedStations: alert.affectedStations?.map((stop) => aliases.get(stop) ?? stop),
          };
        }),
      };
    }

    const entityOnlyIds = new Set(
      results.flatMap((result) =>
        result.status === "fulfilled" &&
        result.source.type === "gtfs-rt" &&
        result.source.entityOnly
          ? result.value.alerts.map((alert) => alert.id)
          : [],
      ),
    );
    if (entityOnlyIds.size > 0) {
      const reconciled = deduplicateDecodedAlerts(
        combined.alerts,
        options.stationIndex,
        options.schematic,
      );
      combined = {
        ...combined,
        alerts: reconciled.map((alert) => {
          const unresolved =
            entityOnlyIds.has(alert.id) &&
            alert.title === PLACEHOLDER_ALERT_TITLE &&
            !alert.description;
          if (!unresolved) return alert;
          const cancelled = alert.effect === "NO_SERVICE" || alert.effect === 1;
          return {
            ...alert,
            title: cancelled
              ? alert.tripScoped
                ? "Cancelled departures"
                : "Service unavailable"
              : "Service advisory",
            description: cancelled
              ? alert.tripScoped
                ? "The operator reports cancelled departures for the affected trips but has not published further details."
                : "The operator reports a service interruption but has not published further details."
              : "The operator published this service advisory without further details.",
          };
        }),
      };
    }
    return yield* validateAgencySnapshot(
      options,
      interpretSnapshot(combined, {
        agencyId: options.agencyId,
        now,
        manifest: options.manifest,
        locale,
        stationIndex: options.stationIndex,
        schematic: options.schematic,
        // A source that failed outright and a source that was only read in part
        // are the same honesty problem — the board is missing advisories — so
        // they reach the interpreter as the same stale verdict.
        feedIsStale:
          missingRequiredSource ||
          activeSources.some((source) => source.coverage === "partial") ||
          results.some((result) => result.status === "rejected") ||
          combined.partial === true,
      }),
    );
  });
}

/** Classify failures without exposing upstream URLs, credentials, or raw error text. */
function alertFailureMetadata(reason: unknown): { failureClass: string; upstreamStatus?: number } {
  let current = reason;
  for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth++) {
    const error = current as {
      _tag?: unknown;
      message?: unknown;
      cause?: unknown;
      status?: unknown;
    };
    if (error._tag === "TransportFailure" && typeof error.status === "number")
      return { failureClass: "upstream-http", upstreamStatus: error.status };
    if (error._tag === "StorageBindingRefusedError") return { failureClass: "storage-binding" };
    if (typeof error.message === "string") {
      if (/no such (?:table|column)|has no column/iu.test(error.message))
        return { failureClass: "storage-schema" };
      if (/D1/iu.test(error.message)) {
        if (/daily/iu.test(error.message) && /limit|quota/iu.test(error.message))
          return { failureClass: "d1-daily-quota" };
        if (/limit|quota/iu.test(error.message)) return { failureClass: "d1-limit" };
        return { failureClass: "d1-error" };
      }
    }
    current = error.cause;
  }
  return { failureClass: "source" };
}

/**
 * Shares the per-invocation AnyRide alert allowance across every selected
 * direct source. Round-robin allocation keeps one source from consuming the
 * whole allowance while preserving the existing single-source ceiling.
 */
function allocateAnyRideStopBudgets(
  sources: readonly AlertSource[],
): readonly (number | undefined)[] {
  const demands = sources.map((source) =>
    source.type === "anyride-messages" && source.relay === undefined
      ? (source.stops?.length ?? 0)
      : 0,
  );
  const budgets = demands.map(() => 0);
  let remaining = TMIX_MAX_SUBREQUESTS;

  while (remaining > 0) {
    let allocated = false;
    for (let index = 0; index < demands.length && remaining > 0; index += 1) {
      if (budgets[index]! >= demands[index]!) continue;
      budgets[index] = budgets[index]! + 1;
      remaining -= 1;
      allocated = true;
    }
    if (!allocated) break;
  }

  return demands.map((demand, index) => (demand > 0 ? budgets[index] : undefined));
}

function canonicalSourceLanguage(language: string | undefined): string | undefined {
  if (!language) return undefined;
  try {
    return Intl.getCanonicalLocales(language)[0];
  } catch {
    return undefined;
  }
}

/** Builds the adapter context: kernel partially applied with transport policy. */
function alertFeedContext(
  options: FetchAgencyAlertsOptions,
  hostingTarget: HostingTarget,
): AlertFeedContext {
  const conditionalStore = resolveConditionalStore(options, hostingTarget);
  return {
    fetch: options.fetch,
    hostLimiter: options.hostLimiter,
    agencyId: options.agencyId,
    locale: normalizeLocale(
      options.locale,
      normalizeLocale(options.manifest?.locale ?? DEFAULT_UI_LOCALE),
    ),
    agencyLocale: options.manifest?.locale ?? DEFAULT_UI_LOCALE,
    now: options.now,
    timeZone: options.timeZone,
    getSecret: options.getSecret,
    devProxyOrigin: options.devProxyOrigin,
    getRoutesForTrips: options.getRoutesForTrips,
    getSourceAgencyScope: options.getSourceAgencyScope,
    identityGeneration: options.identityGeneration,
    sourceAgencyIds: options.sourceAgencyIds,
    hostingTarget,
    sourceTypes: options.sourceTypes,
    requestCache: options.requestCache,
    fetchDecoded: (request) => {
      // `attempts` is adapter transport policy, not kernel input: resolve it
      // into the kernel option and keep the request itself kernel-shaped.
      // `onNotModified` stays on the request; the kernel owns reuse.
      const { attempts, maxCacheAgeMs, timeoutMs, allowLegacyResponseHeaders, ...kernelRequest } =
        request;
      const directLegacyFetch: typeof fetch = async (input, init) => {
        const { fetchLegacyHeaderDocument } = await import("./legacyHeaderFetch");
        return fetchLegacyHeaderDocument(input, init);
      };
      return fetchDecodedFeeds(
        [
          {
            ...kernelRequest,
            mapError: (cause) =>
              cause instanceof AlertFetchError
                ? cause
                : alertError(
                    options,
                    request.source,
                    cause instanceof Error ? cause.message : String(cause),
                    cause,
                  ),
          },
        ],
        {
          fetch:
            allowLegacyResponseHeaders &&
            hostingTarget === "self-hosted" &&
            !(options.devProxyOrigin && request.devProxyPrefix)
              ? directLegacyFetch
              : options.fetch,
          getSecret: options.getSecret,
          devProxyOrigin: options.devProxyOrigin,
          attempts: hostingTarget === "cloudflare" ? 1 : (attempts ?? DEFAULT_FETCH_ATTEMPTS),
          maxCacheAgeMs,
          retryDelayMs: DEFAULT_FETCH_RETRY_DELAY_MS,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(options.hostLimiter !== undefined ? { hostLimiter: options.hostLimiter } : {}),
          ...(conditionalStore !== undefined ? { conditionalStore } : {}),
        },
      );
    },
  };
}

/**
 * Resolves the conditional-fetch store. Cloudflare persists validators plus
 * the last decoded value in `caches.default`, so unchanged boards answer 304
 * with zero decode work. Everywhere else — including self-hosted, where a
 * process-lifetime memo would trade memory growth for no durability — the
 * path stays today's unconditional fetch+decode.
 */
function resolveConditionalStore(
  options: FetchAgencyAlertsOptions,
  hostingTarget: HostingTarget,
): ConditionalGetStore | undefined {
  if (options.conditionalCache !== undefined) {
    return { cache: options.conditionalCache, now: options.now };
  }
  if (hostingTarget !== "cloudflare") return undefined;
  try {
    // `caches.default` is a Cloudflare extension to the CacheStorage shape in
    // the DOM lib, so the capability is probed structurally, not by type.
    const storage =
      typeof caches !== "undefined"
        ? (caches as CacheStorage & { readonly default?: Cache })
        : undefined;
    const cache = storage?.default;
    return cache === undefined ? undefined : { cache, now: options.now };
  } catch {
    return undefined;
  }
}

function validateAgencySnapshot(
  options: FetchAgencyAlertsOptions,
  snapshot: unknown,
): Effect.Effect<AgencySnapshot, AlertFetchError> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(AgencySnapshotSchema)(snapshot),
    catch: (cause) =>
      alertError(options, "snapshot", "Normalized snapshot failed contract validation", cause),
  });
}
