import { decodeZenbusAlerts } from "./zenbus/zenbusAlerts";
import { decodeLinkedServiceNotices } from "./linkedServiceNotices";
import { fetchTripSparkAdvisories } from "./tripspark/tripsparkAdvisories";
import { decodeStopClosureTable } from "./stopClosureTableParser";
import { decodeDisruptionDetailsTable } from "./disruptionDetailsTableParser";
import { namespaceFeedId } from "../gtfs/feedIdentity";
import { applyAlertFeedIdentity } from "./alertFeedIdentity";
import { prepareScheduledPredictions } from "./scheduledPredictions";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { AlertSource, FeedAuth } from "~/agencies/types";
import { DEFAULT_UI_LOCALE, localeFallbacks, type UiLocale } from "~/domain/locale";
import { redactFeedUrl, type FeedFormat } from "./feedAuth";
import type { DecodedFeedRequest } from "./fetchDecodedFeeds";
import { DEFAULT_FETCH_ATTEMPTS } from "./fetchDecodedFeeds";
import type { HostingTarget } from "~/infrastructure/env/hostingTarget";
import type { TripRouteLookup, SourceAgencyScope } from "~/domain/surface/boarding";
import { resolveAlertTripRoutes } from "./gtfsTripDescriptor";
import type { RequestScopedEffectCache } from "~/domain/requestScopedEffectCache";
import {
  decodeGtfsRealtimeFeed,
  DecodedFeedSchema,
  type DecodedFeed,
  type GenericAlert,
} from "./gtfsRealtimeDecoder";
import { normalizeI3ServiceStatus, resolveI3Identities } from "./i3ServiceStatus";
import {
  decodeGtfsRealtimeJsonAlertFeed,
  decodeValidatedGtfsRealtimeJsonAlerts,
} from "./gtfsRealtimeJsonDecoder";
import { normalizeVendorJsonAlerts } from "./vendorJsonAlerts";
import { decodeGenericJsonAlertFeed } from "./genericJsonAlertDecoder";
import { decodeRssAlertFeed } from "./rssAlertDecoder";
import { logger } from "~/infrastructure/logging/logger";
import { isFeedSecretName } from "~/infrastructure/env/feedSecretName";
import {
  decodeGhdPage as decodeGhdPageHtml,
  resolveMaxCrawlPages,
} from "./ghdNewsServiceAdvisoriesParser";
import { decodeHeadingServiceNotices } from "./headingServiceNoticesParser";
import { decodeServiceAnnouncementBoard } from "./serviceAnnouncementBoardParser";
import { decodeRouteNoticeIndex } from "./routeNoticeIndexParser";
import { decodeRouteStatusTable } from "./routeStatusTableParser";
import { decodeRouteStationAdvisories } from "./routeStationAdvisoriesParser";
import { parseTmixStopResponse, type TmixStopResponse } from "./tmix/tmixCallsDecoder";
import { buildTmixMessageFeed } from "./tmix/tmixMessageAlerts";
import {
  TMIX_MAX_SUBREQUESTS,
  TMIX_REQUEST_TIMEOUT_MS,
  TMIX_STOP_CALL_CONCURRENCY,
} from "./tmix/tmixRealtimeSource";
import { tmixStopPollKey } from "./tmix/tmixStopPollCache";
import { tmixStopCallsRequest } from "./tmix/tmixTransport";

const isDecodedFeed = Schema.is(DecodedFeedSchema);
function isDecodedPage(value: unknown): value is { feed: DecodedFeed; pageUrls: string[] } {
  if (typeof value !== "object" || value === null) return false;
  const page = value as { feed?: unknown; pageUrls?: unknown };
  return (
    isDecodedFeed(page.feed) &&
    Array.isArray(page.pageUrls) &&
    page.pageUrls.every((url) => typeof url === "string")
  );
}

export class AlertFetchError extends Data.TaggedError("AlertFetchError")<{
  readonly agencyId: string;
  readonly source: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export function alertError(
  options: { readonly agencyId: string },
  source: string,
  message: string,
  cause?: unknown,
): AlertFetchError {
  return new AlertFetchError({
    agencyId: options.agencyId,
    source,
    message,
    cause,
  });
}

type AlertFeedFetchRequest<T> = Omit<DecodedFeedRequest<T, AlertFetchError>, "mapError"> & {
  readonly url: string;
  readonly auth?: FeedAuth | undefined;
  readonly devProxyPrefix?: string | undefined;
  readonly format?: FeedFormat;
  readonly decode: (bytes: Uint8Array) => Effect.Effect<T, unknown>;
  /** Upstream URL attributed on transport failures. */
  readonly source: string;
  /**
   * Fetch attempts for this request. Absent keeps the context's platform policy:
   * one attempt on Workers, three on self-hosted.
   */
  readonly attempts?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly allowLegacyResponseHeaders?: boolean;
  readonly maxCacheAgeMs?: number;
};

export interface AlertFeedContext {
  readonly fetch?: typeof fetch;
  readonly hostLimiter?: import("../http/hostConcurrency").HostConcurrencyLimiter;
  readonly sourceAgencyIds?: readonly string[];
  readonly getSourceAgencyScope?: import("~/domain/surface/boarding").SourceAgencyScopeLookup;
  readonly identityGeneration?: string;
  readonly sourceAgencyScope?: import("~/domain/surface/boarding").SourceAgencyScope;
  readonly agencyId: string;
  readonly locale?: UiLocale;
  readonly agencyLocale?: string;
  readonly now: () => number;
  readonly timeZone: string;
  readonly getSecret?: (name: string) => string | undefined;
  readonly devProxyOrigin?: string;
  /**
   * Resolves the route of a trip an alert names. Without it, a trip-scoped alert
   * keeps no route attribution.
   */
  readonly getRoutesForTrips?: TripRouteLookup;
  /**
   * Deployment target the crawl policy resolves against. Absent behaves as
   * self-hosted, matching every pre-existing caller.
   */
  readonly hostingTarget?: HostingTarget | undefined;
  /** Reuse recent observations outside this cadence, fetching on cache misses. */
  readonly sourceTypes?: readonly AlertSource["type"][];
  readonly requestCache?: RequestScopedEffectCache;
  /** Per-invocation AnyRide stop-poll allowance assigned to this source. */
  readonly anyRideStopBudget?: number;
  readonly fetchDecoded: <T>(
    request: AlertFeedFetchRequest<T>,
  ) => Effect.Effect<
    { readonly usable: readonly T[]; readonly firstError?: AlertFetchError },
    never
  >;
}

/**
 * Slow feeds retry once per cycle on Workers: a board that failed is re-read
 * fifteen minutes later on the slow cadence, so burning attempts within one
 * invocation spends subrequests without new information. Self-hosted keeps
 * the full retry ladder.
 */
function slowFeedAttempts(hostingTarget?: HostingTarget): number {
  return hostingTarget === "cloudflare" ? CLOUDFLARE_SLOW_FETCH_ATTEMPTS : DEFAULT_FETCH_ATTEMPTS;
}

/** Per-level crawl fanout, capped on Workers by the connection budget. */
function crawlConcurrency(hostingTarget?: HostingTarget): number | "unbounded" {
  return hostingTarget === "cloudflare" ? 2 : "unbounded";
}

/** Fetch attempts for a slow feed on Workers; self-hosted keeps the full ladder. */
export const CLOUDFLARE_SLOW_FETCH_ATTEMPTS = 1;

export type AlertFeedAdapter = (
  source: AlertSource,
  ctx: AlertFeedContext,
) => Effect.Effect<DecodedFeed, AlertFetchError>;

/**
 * Pure fold over successfully fetched feeds: version from the first feed,
 * newest header timestamp, alerts concatenated in feed order. Trip and
 * vehicle sections stay empty, alert pipelines never carry them. A source that
 * came back `partial` makes the whole combination partial, since what the board
 * shows is then the union of what each source could read.
 */
export function combineAlertFeeds(feeds: readonly DecodedFeed[]): DecodedFeed {
  const [first, ...rest] = feeds;
  return {
    header: {
      version: first?.header.version ?? "combined",
      timestamp: Math.max(0, ...feeds.map((feed) => feed.header.timestamp)),
    },
    tripUpdates: [],
    vehiclePositions: [],
    alerts: [first, ...rest].flatMap((feed) => feed?.alerts ?? []),
    partial: feeds.some((feed) => feed.partial === true) || undefined,
  };
}

/** Fetches one feed through the context kernel, failing when nothing is usable. */
function fetchOneAlertFeed<T>(
  ctx: AlertFeedContext,
  request: AlertFeedFetchRequest<T>,
): Effect.Effect<T, AlertFetchError> {
  return ctx
    .fetchDecoded(request)
    .pipe(
      Effect.flatMap(({ usable, firstError }) =>
        usable[0] !== undefined
          ? Effect.succeed(usable[0])
          : Effect.fail(
              firstError ??
                alertError(ctx, request.source, `No usable alert feed for ${request.url}`),
            ),
      ),
    );
}

function decodeAlertText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function decodeGhdPage(
  ctx: Pick<AlertFeedContext, "agencyId" | "now" | "timeZone" | "hostingTarget">,
  html: string,
  source: string,
  maxAgeMinutes: number | undefined,
): Effect.Effect<{ readonly feed: DecodedFeed; readonly pageUrls: string[] }, AlertFetchError> {
  return Effect.tryPromise({
    try: () =>
      decodeGhdPageHtml({
        html,
        pageUrl: source,
        hostingTarget: ctx.hostingTarget ?? "self-hosted",
        now: ctx.now(),
        timeZone: ctx.timeZone,
        maxAgeMinutes,
      }),
    catch: (cause) =>
      alertError(ctx, source, "GHD advisory feed failed normalized-feed validation", cause),
  });
}

/**
 * Refreshes a conditionally reused feed's header timestamp. A 304 proves the
 * board is unchanged, so the cached alerts decode as-is; only the observation
 * timestamp moves to the reuse instant, keeping downstream freshness honest
 * without re-running a single parser.
 */
function refreshReusedFeed(feed: DecodedFeed, reusedAt: number): DecodedFeed {
  return { ...feed, header: { ...feed.header, timestamp: reusedAt } };
}

/**
 * Identity for crawl bookkeeping: trailing-slash (and only trailing-slash)
 * variants of one board page are one page. Without this, `…/board/` and
 * `…/board` fetch as two pages and a self-linking paginator can keep the
 * frontier fed forever. Fetching still uses each discovered URL verbatim;
 * only the visited/queued sets compare canonical forms, and the link
 * extractor itself is untouched (parser parity).
 */
function canonicalCrawlPageUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/u, "") || "/";
    return `${parsed.origin}${path}${parsed.search}`;
  } catch {
    return url;
  }
}

function canonicalAlertLocale(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return Intl.getCanonicalLocales(value.trim())[0];
  } catch {
    return undefined;
  }
}

/**
 * Resolves the effective URL for an alert source. If `baseUrlSecretName` is declared
 * and provisioned in the secret store, its origin and base path override `source.url`.
 * If the configured base URL is invalid, fails honestly with an AlertFetchError.
 */
export function resolveAlertSourceUrl(
  source: AlertSource,
  ctx: Pick<AlertFeedContext, "agencyId" | "getSecret">,
): Effect.Effect<string, AlertFetchError> {
  if (source.baseUrlSecretName && !isFeedSecretName(source.baseUrlSecretName)) {
    return Effect.fail(
      alertError(ctx, source.url, "Alert base URL secret must use the FEED_ namespace"),
    );
  }
  if (source.baseUrlSecretName && ctx.getSecret) {
    const base = ctx.getSecret(source.baseUrlSecretName);
    if (base) {
      try {
        const parsedBase = new URL(base);
        const parsedUrl = new URL(source.url);
        const basePath = parsedBase.pathname.replace(/\/+$/, "");
        const urlPath = parsedUrl.pathname.replace(/^\/+/, "");
        const combinedPath = urlPath ? `${basePath}/${urlPath}` : basePath || "/";

        const searchParams = new URLSearchParams(parsedBase.search);
        for (const [k, v] of parsedUrl.searchParams.entries()) {
          searchParams.set(k, v);
        }
        const search = searchParams.toString() ? `?${searchParams.toString()}` : "";
        return Effect.succeed(`${parsedBase.origin}${combinedPath}${search}`);
      } catch {
        return Effect.fail(
          alertError(ctx, source.url, `Invalid base URL secret ${source.baseUrlSecretName}`),
        );
      }
    }
  }
  return Effect.succeed(source.url);
}

function withResolvedUrl(
  adapter: (
    source: AlertSource,
    ctx: AlertFeedContext,
    url: string,
  ) => Effect.Effect<DecodedFeed, AlertFetchError>,
): AlertFeedAdapter {
  return (source, ctx) => {
    const selected =
      ctx.hostingTarget !== "cloudflare" ||
      ctx.sourceTypes === undefined ||
      ctx.sourceTypes.includes(source.type);
    const maxAgeMs = source.type === "web" || source.type === "rss" ? 15 * 60_000 : 45_000;
    const locale = ctx.locale ?? null;
    const agencyLocale = canonicalAlertLocale(ctx.agencyLocale) ?? null;
    const scoped: AlertFeedContext = {
      ...ctx,
      fetchDecoded: (request) =>
        ctx.fetchDecoded({
          ...request,
          cacheIdentity: JSON.stringify([
            source.type === "web" && source.parser === "heading-service-notices"
              ? "alert-source-heading-v7"
              : source.type === "rss" || source.type === "web"
                ? "alert-source-v7"
                : "alert-source-v8",
            ctx.agencyId,
            ctx.identityGeneration ?? null,
            ctx.timeZone,
            locale,
            agencyLocale,
            source,
          ]),
          ...(selected ? {} : { maxCacheAgeMs: maxAgeMs }),
        }),
    };
    return resolveAlertSourceUrl(source, ctx).pipe(
      Effect.flatMap((url) =>
        adapter(
          source,
          scoped,
          url.replaceAll("{now}", encodeURIComponent(new Date(ctx.now()).toISOString())),
        ),
      ),
    );
  };
}

const gtfsRtAdapter = (
  source: AlertSource,
  ctx: AlertFeedContext,
  url: string,
): Effect.Effect<DecodedFeed, AlertFetchError> => {
  if (source.type !== "gtfs-rt") {
    return Effect.fail(alertError(ctx, url, "GTFS-RT adapter received an incompatible source"));
  }
  return fetchOneAlertFeed(ctx, {
    url,
    auth: source.auth,
    devProxyPrefix: source.devProxyPrefix,
    validateCached: isDecodedFeed,
    format: source.format ?? "protobuf",
    // The proxy marks an incomplete or unreachable upstream via Warning on
    // both 200 and 304. Use this response's state so recovery clears stale data.
    onResponse: (feed, response) => {
      const refreshed = applyResponseFreshness(feed, response);
      return applyEmptyFeedFreshness(
        {
          ...refreshed,
          partial: refreshed.partial || feed.sourceScopeIncomplete || undefined,
        },
        source,
      );
    },
    accept: source.accept,
    decode: (bytes) =>
      (source.format === "json"
        ? decodeGtfsRealtimeJsonAlertFeed(
            bytes,
            ctx.now(),
            source.descriptionField,
            ctx.locale ?? DEFAULT_UI_LOCALE,
            ctx.agencyLocale ?? DEFAULT_UI_LOCALE,
            source.language,
            source.url,
          )
        : Effect.gen(function* (): Effect.fn.Return<SourceAgencyScope | undefined, unknown> {
            if (ctx.sourceAgencyScope) return ctx.sourceAgencyScope;
            if (!ctx.sourceAgencyIds) return undefined;
            if (!ctx.getSourceAgencyScope)
              return yield* Effect.fail(
                new Error("Shared alerts require static source membership"),
              );
            const scope = yield* ctx.getSourceAgencyScope();
            return { ...scope, agencyIds: new Set(ctx.sourceAgencyIds) };
          }).pipe(
            Effect.flatMap((scope) =>
              resolveAlertTripRoutes(bytes, ctx.getRoutesForTrips, source.idNamespace).pipe(
                // Preserve partial-source recovery when trip enrichment fails.
                Effect.map((tripRoutes) => ({
                  tripRoutes,
                  tripLookupFailed: false,
                })),
                Effect.catch((cause) =>
                  Effect.sync(() => {
                    logger.warn(`${ctx.agencyId} alert trip routes unavailable`, {
                      cause: cause instanceof Error ? cause.message : String(cause),
                    });
                    return { tripRoutes: undefined, tripLookupFailed: true };
                  }),
                ),
                Effect.flatMap(({ tripRoutes, tripLookupFailed }) =>
                  decodeGtfsRealtimeFeed(bytes, {
                    alertDescriptionField: source.descriptionField,
                    locale: ctx.locale ?? DEFAULT_UI_LOCALE,
                    agencyLocale: ctx.agencyLocale ?? DEFAULT_UI_LOCALE,
                    sourceLanguage: source.language,
                    sourceScope: source.url,
                    idNamespace: source.idNamespace,
                    tripRoutes,
                    tripLookupFailed,
                    sourceAgencyScope: scope,
                  }),
                ),
              ),
            ),
            Effect.tap((feed) =>
              Effect.sync(() => {
                if (feed.droppedEntities !== undefined) {
                  logger.warn(
                    `${ctx.agencyId} alert feed skipped ${feed.droppedEntities} malformed entities`,
                    { source: redactFeedUrl(url) },
                  );
                }
              }),
            ),
          )
      ).pipe(
        Effect.flatMap((feed) =>
          prepareScheduledPredictions(bytes, {
            stopIdAliases: source.stopIdAliases,
            idNamespace: source.idNamespace,
            getSourceAgencyScope: ctx.getSourceAgencyScope,
          }).pipe(
            Effect.map((identity) => ({
              ...feed,
              alerts: feed.alerts.map((alert) =>
                applyAlertFeedIdentity(alert, {
                  idNamespace: source.format === "json" ? source.idNamespace : undefined,
                  stopAliases: identity.stopAliases,
                  ignoredStopIds: source.ignoredStopIds?.map((id) =>
                    source.format === "json" ? id : namespaceFeedId(id, source.idNamespace),
                  ),
                }),
              ),
            })),
          ),
        ),
        Effect.mapError((cause) =>
          alertError(
            ctx,
            url,
            cause instanceof Error ? cause.message : "Failed decoding GTFS-RT feed",
            cause,
          ),
        ),
      ),
    source: url,
  });
};

interface JsonAlertDocument {
  readonly feed: DecodedFeed;
  /** Completeness of the document itself, independent of a relay's current Warning. */
  readonly incomplete: boolean;
}

function isJsonAlertDocument(value: unknown): value is JsonAlertDocument {
  if (typeof value !== "object" || value === null) return false;
  const document = value as Partial<JsonAlertDocument>;
  return isDecodedFeed(document.feed) && typeof document.incomplete === "boolean";
}

function applyJsonResponse(document: JsonAlertDocument, response: Response): JsonAlertDocument {
  const feed = applyResponseFreshness(document.feed, response);
  return { ...document, feed: document.incomplete ? { ...feed, partial: true } : feed };
}
function reuseJsonResponse(document: JsonAlertDocument, now: number): JsonAlertDocument {
  return { ...document, feed: refreshReusedFeed(document.feed, now) };
}

const jsonAdapter = (
  source: AlertSource,
  ctx: AlertFeedContext,
  url: string,
): Effect.Effect<DecodedFeed, AlertFetchError> => {
  if (source.type !== "json") {
    return Effect.fail(alertError(ctx, url, "JSON adapter received an incompatible source"));
  }
  if (source.parser === "normalized-alert-feed") {
    return fetchOneAlertFeed(ctx, {
      url,
      auth: source.auth,
      devProxyPrefix: source.devProxyPrefix,
      format: "json",
      validateCached: isJsonAlertDocument,
      onResponse: applyJsonResponse,
      onNotModified: reuseJsonResponse,
      decode: (bytes) =>
        Effect.try((): JsonAlertDocument => {
          const feed = Schema.decodeUnknownSync(DecodedFeedSchema)(
            JSON.parse(decodeAlertText(bytes)),
          );
          return { feed, incomplete: feed.partial === true };
        }),
      source: url,
    }).pipe(Effect.map((document) => document.feed));
  }
  if (source.parser === "tripspark-advisories") {
    if (!ctx.fetch) return Effect.fail(alertError(ctx, url, "TripSpark transport unavailable"));
    return Effect.tryPromise({
      try: () =>
        fetchTripSparkAdvisories(
          {
            url,
            sessionTokenArgument: source.sessionTokenArgument,
            pollIntervalSeconds: source.pollIntervalSeconds,
          },
          {
            fetch: ctx.fetch!,
            now: ctx.now,
            language: source.language ?? ctx.locale,
            hostLimiter: ctx.hostLimiter,
          },
          source.excludedNewsIds,
        ),
      catch: (cause) => alertError(ctx, url, "TripSpark advisory board unavailable", cause),
    }).pipe(
      Effect.flatMap((notices) =>
        decodeGenericJsonAlertFeed(notices, ctx.now(), {
          timeZone: ctx.timeZone,
          language: source.language ?? ctx.agencyLocale,
          sourceScope: url,
        }).pipe(
          Effect.mapError((cause) => alertError(ctx, url, "Invalid TripSpark advisories", cause)),
        ),
      ),
    );
  }
  if (source.parser === "i3-service-status") {
    // A board republished every fifteen minutes is current past the ten-minute default.
    const maxHeaderAgeMs = (source.maxHeaderAgeMinutes ?? 10) * 60_000;
    return fetchOneAlertFeed(ctx, {
      url,
      auth: source.auth,
      validateCached: isDecodedFeed,
      source: url,
      format: "json",
      onResponse: (feed, response) => ({
        ...applyResponseFreshness(feed, response),
        partial:
          applyResponseFreshness(feed, response).partial === true ||
          ctx.now() - feed.header.timestamp > maxHeaderAgeMs ||
          feed.header.timestamp > ctx.now() + 60_000,
      }),
      decode: (bytes) =>
        Effect.try(() => normalizeI3ServiceStatus(JSON.parse(decodeAlertText(bytes)), source)).pipe(
          Effect.flatMap((document) => {
            const scope: Effect.Effect<SourceAgencyScope, unknown> = !document.entity.length
              ? Effect.succeed({
                  agencyIds: new Set<string>(),
                  routeIds: new Set<string>(),
                  stopIds: new Set<string>(),
                  routesByShortName: new Map(),
                  stopsByCode: new Map(),
                })
              : ctx.sourceAgencyScope
                ? Effect.succeed(ctx.sourceAgencyScope)
                : ctx.getSourceAgencyScope
                  ? ctx.getSourceAgencyScope().pipe(
                      Effect.map((scope) => ({
                        ...scope,
                        agencyIds: new Set<string>(),
                      })),
                    )
                  : Effect.fail(new Error("i3 alerts require seeded membership"));
            return scope.pipe(
              Effect.flatMap((scope) =>
                Effect.tryPromise(async () => {
                  const resolved = resolveI3Identities(document, scope);
                  const entity = await Promise.all(
                    resolved.entity.map(async (entry, index) => {
                      const content = `${source.url}\0${JSON.stringify(document.entity[index]!.alert)}`;
                      const digest = new Uint8Array(
                        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)),
                      );
                      const id = `i3-${Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
                      return { ...entry, id };
                    }),
                  );
                  return decodeValidatedGtfsRealtimeJsonAlerts(
                    { ...resolved, entity },
                    ctx.now(),
                    undefined,
                    ctx.locale ?? DEFAULT_UI_LOCALE,
                    ctx.agencyLocale ?? DEFAULT_UI_LOCALE,
                    undefined,
                    source.url,
                  );
                }),
              ),
            );
          }),
          Effect.map((feed) => ({
            ...feed,
            alerts: feed.alerts.map((a) => ({
              ...a,
              effect: a.effect ?? "UNKNOWN_EFFECT",
            })),
          })),
          Effect.mapError((cause) => alertError(ctx, url, "Invalid i3 alert feed", cause)),
        ),
    });
  }
  return fetchOneAlertFeed(ctx, {
    url,
    auth: source.auth,
    devProxyPrefix: source.devProxyPrefix,
    method: source.method,
    body: source.body === undefined ? undefined : JSON.stringify(source.body),
    headers: source.method === "POST" ? { "Content-Type": "application/json" } : undefined,
    validateCached: isJsonAlertDocument,
    onResponse: applyJsonResponse,
    onNotModified: reuseJsonResponse,
    decode: (bytes) =>
      Effect.try({
        try: () => normalizeVendorJsonAlerts(JSON.parse(decodeAlertText(bytes)), source.parser),
        catch: (cause) =>
          alertError(
            ctx,
            url,
            cause instanceof Error ? cause.message : "Failed parsing JSON alert feed",
            cause,
          ),
      }).pipe(
        Effect.flatMap((payload) =>
          decodeGenericJsonAlertFeed(payload.alerts, ctx.now(), {
            timestampMode:
              source.parser === "eum-search-advisories"
                ? "agency-local-wall-clock"
                : source.timestampMode,
            timeZone: ctx.timeZone,
            language: source.language ?? ctx.agencyLocale ?? ctx.locale,
            sourceScope: source.url,
          }).pipe(
            Effect.map((feed): JsonAlertDocument => ({
              feed,
              incomplete: payload.partial,
            })),
            Effect.mapError((cause) =>
              alertError(
                ctx,
                url,
                cause instanceof Error ? cause.message : "Failed decoding JSON alert feed",
                cause,
              ),
            ),
          ),
        ),
      ),
    source: url,
  }).pipe(Effect.map((document) => document.feed));
};

const rssAdapter = (
  source: AlertSource,
  ctx: AlertFeedContext,
  url: string,
): Effect.Effect<DecodedFeed, AlertFetchError> => {
  const maxAgeMinutes = source.type === "rss" ? source.maxAgeMinutes : 0;
  return fetchOneAlertFeed(ctx, {
    url,
    auth: source.auth,
    devProxyPrefix: source.devProxyPrefix,
    validateCached: isDecodedFeed,
    attempts: slowFeedAttempts(ctx.hostingTarget),
    onNotModified: refreshReusedFeed,
    onResponse: applyResponseFreshness,
    decode: (bytes) =>
      Effect.try({
        try: () =>
          decodeRssAlertFeed(decodeAlertText(bytes), {
            now: ctx.now(),
            language: source.language ?? ctx.agencyLocale ?? ctx.locale,
            maxAgeMinutes,
            expiryPolicy: source.type === "rss" ? source.expiryPolicy : undefined,
            routeCategoryPrefix: source.type === "rss" ? source.routeCategoryPrefix : undefined,
            routeIdsFromTitle: source.type === "rss" ? source.routeIdsFromTitle : undefined,
            incidentIdentityPattern:
              source.type === "rss" ? source.incidentIdentityPattern : undefined,
            incidentIdentityNamespace: source.type === "rss" ? source.languageGroup : undefined,
            sourceScope: source.url,
          }),
        catch: (cause) =>
          alertError(
            ctx,
            url,
            cause instanceof Error ? cause.message : "Failed decoding RSS alert feed",
            cause,
          ),
      }),
    source: url,
  });
};

/**
 * A source that declares `emptyIsStale` always publishes a standing alert, so a
 * feed with none is a stub or a failure and the board is stale, never clear.
 */
function applyEmptyFeedFreshness(feed: DecodedFeed, source: AlertSource): DecodedFeed {
  return source.type === "gtfs-rt" && source.emptyIsStale === true && feed.alerts.length === 0
    ? { ...feed, partial: true }
    : feed;
}

/** A proxy warning applies to this response, including reused 304 observations. */
function applyResponseFreshness(feed: DecodedFeed, response: Response): DecodedFeed {
  return {
    ...feed,
    partial: /(?:^|,)\s*11[01]\b/u.test(response.headers.get("Warning") ?? "") || undefined,
  };
}

/**
 * Keeps the first card for each id, so a repeated page cannot double an advisory.
 *
 * A GHD paginator links the page it is already on, so every agency on this
 * adapter sees its first page served twice. The daemon drops the repeat by entity
 * id; this is the same fold, and the first occurrence is the one kept so the
 * order stays the page's own.
 */
function dedupeById(alerts: readonly GenericAlert[]): GenericAlert[] {
  const seen = new Set<string>();
  return alerts.filter((alert) => {
    if (seen.has(alert.id)) return false;
    seen.add(alert.id);
    return true;
  });
}

/**
 * A page URL safe to put in a log: credentials scrubbed by the shared redactor,
 * then the query string dropped, because a query is where a page's whole
 * identity and any operator-supplied filter would otherwise be written down.
 */
function loggablePageUrl(url: string): string {
  try {
    const parsed = new URL(redactFeedUrl(url));
    parsed.search = "";
    return parsed.toString();
  } catch {
    return "[redacted advisory page]";
  }
}

function webAlertHeaders(locale: UiLocale, agencyLocale: string): Readonly<Record<string, string>> {
  const languages = localeFallbacks(locale, agencyLocale).filter(Boolean);
  const qualityStep = Math.min(0.1, 0.9 / Math.max(1, languages.length - 1));
  const acceptLanguage = languages
    .map((language, index) =>
      index === 0 ? language : `${language};q=${Number((1 - index * qualityStep).toFixed(3))}`,
    )
    .join(",");
  return {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": acceptLanguage,
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
  };
}

/**
 * Fetches a paginated advisory board, one page at a time and independently.
 *
 * A bad card on page 2 is a page-2 problem, not a board problem: the pages that
 * did decode still carry real advisories, so a subpage failure is logged and
 * dropped rather than escalating through the collection and discarding the rest.
 * The feed it returns is marked `partial`, which `fetchAgencyAlerts` turns into
 * the same stale freshness a wholly rejected source produces, so a half-read
 * board never presents itself as a complete one. Only the first page can fail the
 * source outright, because a source whose first page is unreadable has nothing at
 * all to show. The daemon's `scrape_ghd_feed` crawls to the same
 * `MAX_CRAWL_PAGES` ceiling over the same same-origin links, drops a failed
 * subpage the same way, and serves its feed stale, so the two agree on which
 * pages a board is read from and on the outcome of one failing. On Workers the
 * ceiling is lower (`CLOUDFLARE_MAX_CRAWL_PAGES`); stopping early there reports
 * partial exactly like a failed subpage, so the honesty contract is unchanged.
 */
const webAdapter = (
  source: AlertSource,
  context: AlertFeedContext,
  url: string,
): Effect.Effect<DecodedFeed, AlertFetchError> =>
  Effect.gen(function* () {
    const ctx: AlertFeedContext =
      source.type === "web" &&
      (source.allowLegacyResponseHeaders || source.requestTimeoutMs !== undefined)
        ? {
            ...context,
            fetchDecoded: (request) =>
              context.fetchDecoded({
                ...request,
                ...(source.allowLegacyResponseHeaders ? { allowLegacyResponseHeaders: true } : {}),
                ...(source.requestTimeoutMs === undefined
                  ? {}
                  : { timeoutMs: source.requestTimeoutMs }),
              }),
          }
        : context;
    const maxAgeMinutes = source.type === "web" ? source.maxAgeMinutes : undefined;
    const firstPageResult = yield* fetchOneAlertFeed<{
      readonly feed: DecodedFeed;
      readonly pageUrls: string[];
    }>(ctx, {
      url,
      auth: source.auth,
      devProxyPrefix: source.devProxyPrefix,
      headers: webAlertHeaders(
        ctx.locale ?? DEFAULT_UI_LOCALE,
        ctx.agencyLocale ?? DEFAULT_UI_LOCALE,
      ),
      validateCached: isDecodedPage,
      attempts: slowFeedAttempts(ctx.hostingTarget),
      onNotModified: (cached, reusedAt) => ({
        feed: refreshReusedFeed(cached.feed, reusedAt),
        pageUrls: cached.pageUrls,
      }),
      decode: (bytes) => {
        if (source.type === "web" && source.parser === "heading-service-notices") {
          return Effect.try({
            try: () =>
              decodeLinkedServiceNotices(
                decodeAlertText(bytes),
                url,
                ctx.now(),
                ctx.timeZone,
                source.routeNames,
                source.stopNames,
              ) ?? {
                feed: decodeHeadingServiceNotices(
                  decodeAlertText(bytes),
                  url,
                  ctx.now(),
                  source.routeNames,
                  source.stopNames,
                  ctx.timeZone,
                  source.publicationReference,
                  source.clearStatementNames,
                ),
                pageUrls: [],
              },
            catch: (cause) =>
              alertError(ctx, url, "Service notice page could not be decoded", cause),
          });
        }
        if (source.type === "web" && source.parser === "service-announcement-board") {
          return Effect.try({
            try: () => ({
              feed: decodeServiceAnnouncementBoard(
                decodeAlertText(bytes),
                url,
                ctx.now(),
                source.routeNames,
              ),
              pageUrls: [],
            }),
            catch: (cause) =>
              alertError(ctx, url, "Service announcement page could not be decoded", cause),
          });
        }
        if (source.type === "web" && source.parser === "route-notice-index") {
          return Effect.try({
            try: () => ({
              feed: decodeRouteNoticeIndex(
                decodeAlertText(bytes),
                url,
                ctx.now(),
                source.routeNames,
              ),
              pageUrls: [],
            }),
            catch: (cause) =>
              alertError(ctx, url, "Service notice index could not be decoded", cause),
          });
        }
        if (source.type === "web" && source.parser === "stop-closure-table") {
          return Effect.try({
            try: () => ({
              feed: decodeStopClosureTable(
                decodeAlertText(bytes),
                url,
                ctx.now(),
                ctx.timeZone,
                source.routeNames,
              ),
              pageUrls: [],
            }),
            catch: (cause) =>
              alertError(ctx, url, "Stop closure table could not be decoded", cause),
          });
        }
        if (source.type === "web" && source.parser === "disruption-details-table") {
          return Effect.try({
            try: () => ({
              feed: decodeDisruptionDetailsTable(
                decodeAlertText(bytes),
                url,
                ctx.now(),
                ctx.timeZone,
                source.routeNames,
              ),
              pageUrls: [],
            }),
            catch: (cause) =>
              alertError(ctx, url, "Disruption details board could not be decoded", cause),
          });
        }
        if (source.type === "web" && source.parser === "route-status-table") {
          return Effect.try({
            try: () => ({
              feed: decodeRouteStatusTable(
                decodeAlertText(bytes),
                url,
                ctx.now(),
                source.routeNames,
              ),
              pageUrls: [],
            }),
            catch: (cause) =>
              alertError(ctx, url, "Route status table could not be decoded", cause),
          });
        }
        if (source.type === "web" && source.parser === "route-station-advisories") {
          return Effect.try({
            try: () => ({
              feed: decodeRouteStationAdvisories(
                decodeAlertText(bytes),
                url,
                ctx.now(),
                ctx.timeZone,
                source.routeNames,
              ),
              pageUrls: [],
            }),
            catch: (cause) =>
              alertError(ctx, url, "Route and station advisories could not be decoded", cause),
          });
        }
        return decodeGhdPage(ctx, decodeAlertText(bytes), url, maxAgeMinutes);
      },
      source: url,
    });

    // Breadth-first over same-origin pagination links, one level at a time, and
    // capped at the hosting target's crawl ceiling. Following every reachable
    // link with no ceiling makes the request cost of a cycle unknowable in
    // advance, which is the property a platform subrequest budget needs to
    // have. Reading each level rather than only the first is what lets a
    // `next`-only paginator — which advertises page 2 from page 1 and page 3
    // from page 2 — be read to the end.
    const maxCrawlPages = resolveMaxCrawlPages(
      ctx.hostingTarget,
      source.type === "web" ? source.cloudflareMaxCrawlPages : undefined,
    );
    const feeds: DecodedFeed[] = [firstPageResult.feed];
    const visited = new Set<string>([canonicalCrawlPageUrl(url)]);
    // Every URL ever queued, canonicalized. A diamond (two siblings sharing
    // a child) would otherwise push the shared child twice and fetch it
    // twice; trailing-slash variants of a queued page collapse here too.
    const queued = new Set<string>([canonicalCrawlPageUrl(url)]);
    let frontier: string[] = [];
    const enqueueUnseen = (candidates: readonly string[]): void => {
      for (const candidate of candidates) {
        const key = canonicalCrawlPageUrl(candidate);
        if (visited.has(key) || queued.has(key)) continue;
        queued.add(key);
        frontier.push(candidate);
      }
    };
    enqueueUnseen(firstPageResult.pageUrls);
    let partial = false;
    let truncated = false;
    let unread = 0;

    while (frontier.length > 0 && visited.size < maxCrawlPages) {
      const unseen = [
        ...new Set(frontier.filter((pageUrl) => !visited.has(canonicalCrawlPageUrl(pageUrl)))),
      ];
      const level = unseen.slice(0, maxCrawlPages - visited.size);
      if (level.length === 0) break;
      // The slice above drops pages the ceiling has no room for. They are
      // unread, not absent, so a cut level marks the feed as a short read.
      truncated = truncated || level.length < unseen.length;
      unread += unseen.length - level.length;
      for (const pageUrl of level) visited.add(canonicalCrawlPageUrl(pageUrl));
      frontier = [];

      const read = yield* Effect.forEach(
        level,
        (pageUrl) =>
          fetchOneAlertFeed<{
            readonly feed: DecodedFeed;
            readonly pageUrls: string[];
          }>(ctx, {
            url: pageUrl,
            auth: source.auth,
            devProxyPrefix: source.devProxyPrefix,
            headers: webAlertHeaders(
              ctx.locale ?? DEFAULT_UI_LOCALE,
              ctx.agencyLocale ?? DEFAULT_UI_LOCALE,
            ),
            validateCached: isDecodedPage,
            attempts: slowFeedAttempts(ctx.hostingTarget),
            onNotModified: (cached, reusedAt) => ({
              feed: refreshReusedFeed(cached.feed, reusedAt),
              pageUrls: cached.pageUrls,
            }),
            decode: (bytes) =>
              source.type === "web" && source.parser === "heading-service-notices"
                ? Effect.try({
                    try: () => {
                      const page = decodeLinkedServiceNotices(
                        decodeAlertText(bytes),
                        pageUrl,
                        ctx.now(),
                        ctx.timeZone,
                        source.routeNames,
                        source.stopNames,
                      );
                      if (!page) throw new Error("Unrecognized linked advisory detail");
                      return page;
                    },
                    catch: (cause) =>
                      alertError(ctx, pageUrl, "Linked advisory could not be decoded", cause),
                  })
                : decodeGhdPage(ctx, decodeAlertText(bytes), pageUrl, maxAgeMinutes),
            source: pageUrl,
          }).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                logger.warn(
                  `${ctx.agencyId} advisory subpage unreadable; serving the pages that read: ${loggablePageUrl(pageUrl)} — ${error.message}`,
                );
                partial = true;
                return undefined;
              }),
            ),
          ),
        { concurrency: crawlConcurrency(ctx.hostingTarget) },
      );

      for (const page of read) {
        if (!page) continue;
        feeds.push(page.feed);
        enqueueUnseen(page.pageUrls);
      }
    }

    // Pages the ceiling cut off are unread, not absent: the slice above drops
    // levels the ceiling has no room for, and a chained board keeps linking
    // past the last page read. Reporting the surviving pages as complete would
    // present a short read as the whole board, so a truncated crawl is partial
    // exactly like a failed subpage, and the caller serves it stale.
    truncated = truncated || frontier.length > 0;
    unread += frontier.length;

    if (truncated) {
      logger.warn(
        `${ctx.agencyId} advisory crawl stopped at the ${maxCrawlPages}-page ceiling with pages unread; serving the pages that read: ${loggablePageUrl(url)} — read ${feeds.length}, ${unread} unread`,
      );
    }

    return {
      ...firstPageResult.feed,
      // A paginator that links the page it is already on (`?page=1`) sends the
      // same cards twice. The daemon de-duplicates by entity id, so this does too.
      alerts: dedupeById(feeds.flatMap((feed) => feed.alerts)),
      partial: partial || truncated || feeds.some((feed) => feed.partial) ? true : undefined,
    };
  });

/**
 * Reads AnyRide service messages. See `tmix/tmixMessageAlerts.ts` for the
 * rules this adapter applies; the part that matters here is completeness. A
 * stop that failed, answered with no content, or fell outside the shared
 * subrequest budget leaves the read incomplete, and an incomplete read is
 * `partial`, so the snapshot is stale rather than an all-clear.
 */
const anyRideMessagesAdapter = (
  source: AlertSource,
  ctx: AlertFeedContext,
  url: string,
): Effect.Effect<DecodedFeed, AlertFetchError> => {
  if (source.type !== "anyride-messages") {
    return Effect.fail(alertError(ctx, url, "AnyRide adapter received an incompatible source"));
  }
  const mapDecodeError = (cause: unknown, fallback: string) =>
    alertError(ctx, url, cause instanceof Error ? cause.message : fallback, cause);

  if (source.relay === "daemon-document") {
    // The daemon polled the stops and decoded them with the same rules; its
    // feed already says whether every stop was read.
    return fetchOneAlertFeed(ctx, {
      url,
      auth: source.auth,
      devProxyPrefix: source.devProxyPrefix,
      format: "json",
      // The proxy marks an incomplete or unreachable upstream via Warning.
      onResponse: (feed, response) =>
        feed.partial === true ? feed : applyResponseFreshness(feed, response),
      decode: (bytes) =>
        Effect.try({
          try: () => JSON.parse(decodeAlertText(bytes)) as unknown,
          catch: (cause) => cause,
        }).pipe(
          Effect.flatMap((payload) => Schema.decodeUnknownEffect(DecodedFeedSchema)(payload)),
          Effect.mapError((cause) => mapDecodeError(cause, "Failed decoding AnyRide message feed")),
        ),
      source: url,
    });
  }

  const declared = source.stops ?? [];
  const operatorPrefix = source.operatorPrefix ?? "";
  // The shared subrequest budget bounds the read; stops beyond it stay unpolled
  // and make the read incomplete.
  const polledStops = declared.slice(0, ctx.anyRideStopBudget ?? TMIX_MAX_SUBREQUESTS);
  return Effect.gen(function* () {
    let firstError: AlertFetchError | undefined;
    const outcomes = yield* Effect.forEach(
      polledStops,
      (stop): Effect.Effect<TmixStopResponse | undefined> => {
        const feed = {
          url,
          profile: source.profile,
          auth: source.auth,
          devProxyPrefix: source.devProxyPrefix,
          format: "json",
        };
        const pollKey = tmixStopPollKey(feed, stop.stopId);
        const { mapError: _unused, ...request } = tmixStopCallsRequest<
          TmixStopResponse,
          AlertFetchError
        >(
          {
            ...feed,
            auth: source.auth,
            devProxyPrefix: source.devProxyPrefix,
            format: "json",
          },
          stop.stopId,
          {
            decode: (bytes) =>
              Effect.try({
                try: () => parseTmixStopResponse(bytes, { strictAlertEnvelope: true }),
                catch: (cause) => cause,
              }),
            mapError: (cause) => mapDecodeError(cause, "Failed decoding AnyRide stop poll"),
          },
        );
        const load = () =>
          ctx.fetchDecoded({
            ...request,
            source: url,
            attempts: 1,
            timeoutMs: TMIX_REQUEST_TIMEOUT_MS,
          });
        const poll = ctx.requestCache
          ? ctx.requestCache.get(pollKey, load, (result) => {
              const response = result.usable[0];
              return (
                response !== undefined && response.noContent !== true && response.alertEnvelopeValid
              );
            })
          : load();
        return poll.pipe(
          Effect.map(({ usable, firstError: error }) => {
            const response = usable[0];
            if (response === undefined) {
              firstError ??= error;
              return undefined;
            }
            // A concurrent lenient realtime poll can win the shared cache
            // before this strict alert poll. Never interpret an unrecognized
            // response it produced as an empty, complete alert read.
            if (!response.alertEnvelopeValid || response.noContent === true) {
              firstError ??= alertError(
                ctx,
                url,
                `AnyRide alert poll returned an unreadable envelope for stop ${stop.stopId}`,
              );
              return undefined;
            }
            return response;
          }),
        );
      },
      { concurrency: TMIX_STOP_CALL_CONCURRENCY },
    );
    const feed = buildTmixMessageFeed(declared, outcomes, {
      operatorPrefix,
      now: ctx.now(),
    });
    if (feed === undefined) {
      return yield* Effect.fail(
        firstError ?? alertError(ctx, url, `No AnyRide stop could be read for ${ctx.agencyId}`),
      );
    }
    if (feed.partial) {
      logger.warn(
        `${ctx.agencyId} AnyRide message read is incomplete: serving the stops that read (${declared.length} declared)`,
      );
    }
    return feed;
  });
};

const zenbusMessagesAdapter = (source: AlertSource, ctx: AlertFeedContext, url: string) =>
  fetchOneAlertFeed(ctx, {
    url,
    auth: source.auth,
    devProxyPrefix: source.devProxyPrefix,
    validateCached: isDecodedFeed,
    decode: (bytes) =>
      Effect.try(() =>
        decodeZenbusAlerts(bytes, ctx.now(), {
          timeZone: ctx.timeZone,
          stopCodeMap: source.type === "zenbus-messages" ? source.stopCodeMap : undefined,
        }),
      ),
    source: url,
  });

export const alertFeedAdapters: Record<AlertSource["type"], AlertFeedAdapter> = {
  "zenbus-messages": withResolvedUrl(zenbusMessagesAdapter),
  "anyride-messages": withResolvedUrl(anyRideMessagesAdapter),
  "gtfs-rt": withResolvedUrl(gtfsRtAdapter),
  json: withResolvedUrl(jsonAdapter),
  rss: withResolvedUrl(rssAdapter),
  web: withResolvedUrl(webAdapter),
};
