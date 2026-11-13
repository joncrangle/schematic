import { acceptPolledResponse, rejectPolledResponse } from "./polledResponse";
import type { CacheMutationReservation, ReservableCache } from "~/infrastructure/http/InvocationIo";
import type { HostConcurrencyLimiter } from "~/infrastructure/http/hostConcurrency";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { FeedAccept, FeedAuth } from "~/agencies/types";
import {
  applyDevFeedProxy,
  applyFeedAuthRequest,
  applyFeedFormat,
  redactFeedUrl,
  type FeedFormat,
} from "./feedAuth";

export const DEFAULT_FETCH_ATTEMPTS = 3;
export const DEFAULT_FETCH_RETRY_DELAY_MS = 250;
export const DEFAULT_FETCH_TIMEOUT_MS = 2_000;
export const MAX_FETCH_ATTEMPTS = 3;
export const MAX_FETCH_RETRY_DELAY_MS = 2_000;
export const DEFAULT_MAX_FEED_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Exponential backoff with downward jitter and a hard maximum delay. */
export function retryDelayForAttempt(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs = MAX_FETCH_RETRY_DELAY_MS,
  random: () => number = Math.random,
): number {
  const base = Number.isFinite(baseDelayMs) ? Math.max(0, Math.floor(baseDelayMs)) : 0;
  const ceiling = Number.isFinite(maxDelayMs) ? Math.max(0, Math.floor(maxDelayMs)) : 0;
  const exponent = Number.isFinite(attempt) ? Math.min(30, Math.max(0, Math.floor(attempt))) : 0;
  const capped = Math.min(ceiling, base * 2 ** exponent);
  const sample = random();
  const jitter = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5;
  return Math.floor(capped * (0.5 + jitter * 0.5));
}

/**
 * Metrolinx warns that repeated 429s can suspend a key. Do not add more
 * pressure when the upstream has explicitly rate-limited this caller.
 */
export function isRetryableFeedStatus(status: number): boolean {
  return status === 408 || status >= 500;
}

/** Transport failure handed to `mapError` so adapters can branch on status. */
export class TransportFailure extends Data.TaggedError("TransportFailure")<{
  readonly status?: number;
  readonly message: string;
  readonly cause?: unknown;
  readonly retryable?: boolean;
}> {}

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/** The upstream confirmed the cached decoded value is still current. */
export interface NotModifiedResult {
  readonly notModified: true;
}

const NOT_MODIFIED_RESULT: NotModifiedResult = { notModified: true };

function isNotModified(outcome: unknown): outcome is NotModifiedResult {
  return (
    typeof outcome === "object" &&
    outcome !== null &&
    (outcome as { notModified?: unknown }).notModified === true
  );
}

/** Validators and a decoded value observed successfully from one request. */
interface CachedConditionalEntry {
  readonly etag: string | undefined;
  readonly lastModified: string | undefined;
  readonly decoded: unknown;
  readonly observedAt: number;
  readonly failedAt?: number;
}

const CONDITIONAL_CACHE_TTL_SECONDS = 86_400;

/** Namespaced opaque keys keep credentials and raw upstream responses out of this cache. */
export async function conditionalCacheKey(
  requestUrl: string,
  headers: Headers,
  cacheIdentity: string,
): Promise<string> {
  const identity = JSON.stringify({
    version: 2,
    requestUrl,
    headers: [...headers.entries()].sort(([left], [right]) => left.localeCompare(right)),
    cacheIdentity,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `https://conditional-feed.schematic.invalid/v2/${hash}`;
}

function readConditionalEnvelope(value: unknown): CachedConditionalEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const { etag, lastModified, decoded, observedAt, failedAt } = record;
  if (decoded === undefined) return undefined;
  if (etag !== undefined && typeof etag !== "string") return undefined;
  if (lastModified !== undefined && typeof lastModified !== "string") return undefined;
  if (typeof observedAt !== "number" || !Number.isFinite(observedAt)) return undefined;
  if (failedAt !== undefined && (typeof failedAt !== "number" || !Number.isFinite(failedAt)))
    return undefined;
  return { etag, lastModified, decoded, observedAt, failedAt };
}

/** Cache failures and corrupt entries are misses, overwritten after a successful fetch. */
async function lookupConditionalEntry(
  store: ConditionalGetStore,
  key: string,
): Promise<CachedConditionalEntry | undefined> {
  try {
    const hit = await store.cache.match(key);
    if (!hit) return undefined;
    const entry = readConditionalEnvelope(await hit.json());
    if (!entry) return undefined;
    const age = store.now() - entry.observedAt;
    return age >= 0 && age <= CONDITIONAL_CACHE_TTL_SECONDS * 1_000 ? entry : undefined;
  } catch {
    return undefined;
  }
}

/** One best-effort write per live result. Failures retain validators while blocking fresh observation reuse. */
async function storeConditionalEntry(
  store: ConditionalGetStore,
  key: string,
  validators: { readonly etag: string | null; readonly lastModified: string | null },
  decoded: unknown,
  observedAt: number,
  failedAt?: number,
  reservation?: CacheMutationReservation,
): Promise<void> {
  try {
    const body = JSON.stringify({
      etag: validators.etag ?? undefined,
      lastModified: validators.lastModified ?? undefined,
      decoded,
      observedAt,
      failedAt,
    });
    const put = reservation?.put ?? store.cache.put.bind(store.cache);
    await put(
      key,
      new Response(body, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${CONDITIONAL_CACHE_TTL_SECONDS}`,
        },
      }),
    );
  } catch {
    // A rejected write cannot fail the successfully fetched feed.
  }
}

export interface DecodedFeedRequest<T, E> {
  readonly url: string;
  readonly auth?: FeedAuth | undefined;
  readonly devProxyPrefix?: string | undefined;
  /** Wire format requested via Accept header; absent sends no Accept header. */
  readonly format?: FeedFormat;
  /** Explicit media type that takes precedence over the format default. */
  readonly accept?: FeedAccept;
  /** Absent keeps the request a GET, matching every pre-existing caller. */
  readonly method?: "GET" | "POST" | undefined;
  /** Request body; only meaningful alongside a POST method. */
  readonly body?: string | undefined;
  readonly headers?: Record<string, string>;
  readonly decode: (bytes: Uint8Array) => Effect.Effect<T, unknown>;
  /** Explicit decoder version/configuration namespace. Absent disables decoded-value caching. */
  readonly cacheIdentity?: string;
  /** Rejects incompatible cached values before conditional reuse. */
  readonly validateCached?: (value: unknown) => value is T;
  /** Applies current response metadata after decoding or conditional reuse. Must be pure and total. */
  readonly onResponse?: (value: T, response: Response) => T;
  /** Maps transport AND decode failures onto the caller's error tag. */
  readonly mapError: (cause: unknown) => E;
  /**
   * Refreshes a conditionally reused value. Runs only on a `304 Not
   * Modified` cache hit, in place of `decode`, so it must stay total and
   * cheap: timestamp refreshes, never parsing. Absent returns the cached
   * value unchanged.
   */
  readonly onNotModified?: ((cached: T, reusedAt: number) => T) | undefined;
}

/**
 * Workers-safe decoded-feed store. Opaque request identities isolate values
 * across credentials, representations and decoder configurations. `now`
 * supplies receipt times and bounds fresh observation reuse.
 */
export interface ConditionalGetStore {
  readonly cache: Cache;
  readonly now: () => number;
  /** Holds one cache write slot while a live poll and any redirects are in progress. */
  readonly reserveMutation?: () => CacheMutationReservation;
}

export interface FetchDecodedFeedsOptions {
  readonly fetch: typeof fetch;
  readonly getSecret?: (name: string) => string | undefined;
  readonly devProxyOrigin?: string;
  /** Default 1: current realtime/stations behavior (no retry). */
  readonly attempts?: number;
  readonly retryDelayMs?: number;
  /** Maximum simultaneous feed fetches; absent keeps the shared unbounded behavior. */
  readonly concurrency?: number;
  /** Per-host request slots shared with the rest of the polling scope. */
  readonly hostLimiter?: HostConcurrencyLimiter;
  /** Maximum time spent fetching one feed response, including its body. */
  readonly timeoutMs?: number;
  /** Default: 408/5xx, never 429. */
  readonly isRetryable?: (status: number) => boolean;
  /**
   * Enables decoded-value storage for GET requests declaring a cacheIdentity.
   * Upstream validators enable conditional HTTP reuse; validatorless values
   * remain available to cadence readers. Absent keeps unconditional fetches.
   */
  readonly conditionalStore?: ConditionalGetStore | undefined;
  /** Reuse a recent observation without HTTP; a miss or failed observation fetches normally. */
  readonly maxCacheAgeMs?: number;
}

export interface FetchedDecodedFeeds<T, E> {
  readonly usable: readonly T[];
  readonly firstError?: E;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A body may already be closed or locked by a failed read.
  }
}

function responseTooLarge(response: Response, url: string, auth: FeedAuth | undefined) {
  return new TransportFailure({
    status: response.status,
    message: `Response body exceeded ${DEFAULT_MAX_FEED_RESPONSE_BYTES} bytes fetching ${redactFeedUrl(url, auth)}`,
    retryable: false,
  });
}

export async function readResponseBody(
  response: Response,
  url: string,
  auth: FeedAuth | undefined,
): Promise<Uint8Array> {
  const contentLength = response.headers?.get("Content-Length");
  if (contentLength != null && /^\d+$/u.test(contentLength)) {
    const advertisedBytes = Number(contentLength);
    if (
      Number.isSafeInteger(advertisedBytes) &&
      advertisedBytes > DEFAULT_MAX_FEED_RESPONSE_BYTES
    ) {
      await cancelResponseBody(response);
      throw responseTooLarge(response, url, auth);
    }
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > DEFAULT_MAX_FEED_RESPONSE_BYTES) {
      throw responseTooLarge(response, url, auth);
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > DEFAULT_MAX_FEED_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The size limit still applies when an upstream stream cannot cancel.
        }
        throw responseTooLarge(response, url, auth);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Shared fetch → decode fanout kernel for every feed ingestion pipeline.
 *
 * One reusable shape: auth/format/proxy request building, status-checked
 * request with opt-in retry, bytes → caller decode, partial-failure collection.
 * The kernel itself never fails, callers keep their own fail/stale policy over
 * `usable` / `firstError`.
 */
export function fetchDecodedFeeds<T, E>(
  feeds: readonly DecodedFeedRequest<T, E>[],
  options: FetchDecodedFeedsOptions,
): Effect.Effect<FetchedDecodedFeeds<T, E>, never> {
  const requestedAttempts = options.attempts ?? 1;
  const attempts = Number.isFinite(requestedAttempts)
    ? Math.min(MAX_FETCH_ATTEMPTS, Math.max(1, Math.floor(requestedAttempts)))
    : MAX_FETCH_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_FETCH_RETRY_DELAY_MS;
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
  const isRetryable = options.isRetryable ?? isRetryableFeedStatus;
  const concurrency =
    options.concurrency === undefined
      ? "unbounded"
      : Number.isFinite(options.concurrency)
        ? Math.max(1, Math.floor(options.concurrency))
        : 1;

  const hostLimiter = options.hostLimiter;
  const runInHostSlot = <T>(url: string, task: () => Promise<T>): Promise<T> =>
    hostLimiter === undefined ? task() : hostLimiter.run(url, task);

  const fetchBytes = (
    requestUrl: string,
    init: RequestInit | undefined,
    sourceUrl: string,
    auth: FeedAuth | undefined,
    hooks?: {
      /** Return the not-modified marker instead of failing a 304. */
      readonly reuseIfNotModified?: boolean;
      /** Observes a reusable 304 or a 200 before its body is read. Never throws. */
      readonly onOkResponse?: (response: Response) => void;
    },
  ): Effect.Effect<Uint8Array | NotModifiedResult, TransportFailure> =>
    Effect.tryPromise({
      try: async () => {
        let lastError: unknown;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          // Queue for the host before the timeout starts, so waiting never times out.
          const settled = await runInHostSlot(
            sourceUrl,
            async (): Promise<Uint8Array | NotModifiedResult | undefined> => {
              let response: Response | undefined;
              let bodyBytes: Uint8Array | undefined;
              let timedOut = false;
              let timeoutId: ReturnType<typeof setTimeout> | undefined;
              let removeParentAbortListener: (() => void) | undefined;
              try {
                const controller = new AbortController();
                const parentSignal = init?.signal;
                const onParentAbort = () => controller.abort(parentSignal?.reason);
                if (parentSignal) {
                  if (parentSignal.aborted) onParentAbort();
                  else {
                    parentSignal.addEventListener("abort", onParentAbort, { once: true });
                    removeParentAbortListener = () =>
                      parentSignal.removeEventListener("abort", onParentAbort);
                  }
                }
                timeoutId = setTimeout(() => {
                  timedOut = true;
                  controller.abort();
                }, timeoutMs);
                response = await options.fetch(requestUrl, {
                  ...init,
                  redirect: auth && auth.type !== "none" ? "manual" : "follow",
                  signal: controller.signal,
                });
                // A revalidation hit carries no body: the cached decoded value is
                // the response. Without a cached value a 304 is an upstream
                // protocol violation and falls through to the error path below,
                // exactly as before this hook existed.
                if (response.status === 304 && hooks?.reuseIfNotModified === true) {
                  hooks.onOkResponse?.(response);
                  return NOT_MODIFIED_RESULT;
                }
                if (response.ok) {
                  hooks?.onOkResponse?.(response);
                  bodyBytes = await readResponseBody(response, requestUrl, auth);
                }
              } catch (cause) {
                if (response !== undefined) await cancelResponseBody(response);
                lastError = timedOut
                  ? new TransportFailure({
                      message: `Timed out after ${timeoutMs}ms fetching ${redactFeedUrl(requestUrl, auth)}`,
                      cause,
                    })
                  : cause;
              } finally {
                if (timeoutId !== undefined) clearTimeout(timeoutId);
                removeParentAbortListener?.();
              }

              if (bodyBytes) return bodyBytes;
              if (lastError instanceof TransportFailure && lastError.retryable === false) {
                throw lastError;
              }
              if (response) {
                if (response.ok) {
                  // A response body read failed; retain the body error above and
                  // let the retry policy decide whether to try again.
                  if (lastError === undefined) {
                    lastError = new TransportFailure({
                      message: `Failed reading ${redactFeedUrl(requestUrl, auth)}`,
                    });
                  }
                } else {
                  await cancelResponseBody(response);
                  const failure = new TransportFailure({
                    status: response.status,
                    message: `HTTP ${response.status} fetching ${redactFeedUrl(requestUrl, auth)}`,
                  });
                  if (!isRetryable(response.status)) throw failure;
                  lastError = failure;
                }
              }
              return undefined;
            },
          );
          if (settled !== undefined) return settled;

          if (attempt < attempts - 1) {
            const delay = retryDelayForAttempt(attempt, retryDelayMs);
            if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
        throw lastError instanceof TransportFailure
          ? lastError
          : new TransportFailure({
              message: `Failed fetching ${redactFeedUrl(sourceUrl, auth)}`,
              cause: lastError,
            });
      },
      catch: (cause) =>
        cause instanceof TransportFailure
          ? cause
          : new TransportFailure({
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
    });

  return Effect.all(
    feeds.map((feed) =>
      Effect.tryPromise({
        try: () =>
          applyFeedAuthRequest(feed.url, feed.auth, {
            getSecret: options.getSecret,
            init:
              feed.format || feed.accept
                ? applyFeedFormat(feed.format, { accept: feed.accept })
                : undefined,
          }),
        catch: (cause) => cause,
      }).pipe(
        Effect.flatMap((request) => {
          const requestUrl = applyDevFeedProxy(
            request.url,
            feed.devProxyPrefix,
            options.devProxyOrigin,
          );
          const headers = new Headers(request.init?.headers);
          if (feed.headers) {
            for (const [key, value] of Object.entries(feed.headers)) headers.set(key, value);
          }
          if (!headers.has("User-Agent")) headers.set("User-Agent", DEFAULT_USER_AGENT);
          const store = options.conditionalStore;
          const activeStore =
            store !== undefined &&
            feed.cacheIdentity !== undefined &&
            (feed.method === undefined || feed.method === "GET") &&
            feed.body === undefined
              ? store
              : undefined;
          const lookup = Effect.promise(async () => {
            if (activeStore === undefined || feed.cacheIdentity === undefined) return undefined;
            try {
              const key = await conditionalCacheKey(requestUrl, headers, feed.cacheIdentity);
              const entry = await lookupConditionalEntry(activeStore, key);
              return { key, entry };
            } catch {
              return undefined;
            }
          });
          return lookup.pipe(
            Effect.flatMap((cached) => {
              let entry = cached?.entry;
              if (entry && feed.validateCached) {
                try {
                  if (!feed.validateCached(entry.decoded)) entry = undefined;
                } catch {
                  entry = undefined;
                }
              }
              if (
                options.maxCacheAgeMs !== undefined &&
                entry !== undefined &&
                entry.failedAt === undefined
              ) {
                const age = (activeStore?.now() ?? Date.now()) - entry.observedAt;
                if (age >= 0 && age <= options.maxCacheAgeMs)
                  return Effect.succeed(entry.decoded as T);
              }
              let reservation: CacheMutationReservation | undefined;
              if (activeStore !== undefined && cached !== undefined) {
                const reserveMutation =
                  activeStore.reserveMutation ??
                  (activeStore.cache as Partial<ReservableCache>).reserveMutation;
                try {
                  reservation = reserveMutation?.();
                } catch (cause) {
                  return Effect.fail(cause);
                }
              }
              const requestHeaders = new Headers(headers);
              if (entry?.etag !== undefined) requestHeaders.set("If-None-Match", entry.etag);
              if (entry?.lastModified !== undefined)
                requestHeaders.set("If-Modified-Since", entry.lastModified);
              const requestInit: RequestInit = {
                ...request.init,
                headers: requestHeaders,
              };
              // Assigned rather than spread so requests that declare neither field stay
              // byte-for-byte identical to the pre-POST kernel: no `method`, no `body`.
              if (feed.method !== undefined) requestInit.method = feed.method;
              if (feed.body !== undefined) requestInit.body = feed.body;
              // Validators observed on the 200 that produced these bytes. Read
              // before the body so a read failure cannot store validators for a
              // value that was never decoded.
              let seenValidators: { etag: string | null; lastModified: string | null } | undefined;
              let observedAt: number | undefined;
              let receivedResponse: Response | undefined;
              const applyResponse = (value: T): Effect.Effect<T, unknown> =>
                Effect.try({
                  try: () =>
                    receivedResponse === undefined
                      ? value
                      : (feed.onResponse?.(value, receivedResponse) ?? value),
                  catch: (cause) => cause,
                });
              return fetchBytes(requestUrl, requestInit, feed.url, feed.auth, {
                reuseIfNotModified:
                  entry !== undefined &&
                  (entry.etag !== undefined || entry.lastModified !== undefined),
                onOkResponse: (response) => {
                  receivedResponse = response;
                  observedAt = activeStore?.now();
                  seenValidators = {
                    etag: response.headers?.get("ETag") ?? null,
                    lastModified: response.headers?.get("Last-Modified") ?? null,
                  };
                },
              }).pipe(
                Effect.flatMap((outcome) => {
                  if (!isNotModified(outcome)) {
                    return feed.decode(outcome).pipe(
                      Effect.flatMap(applyResponse),
                      Effect.tap(() =>
                        Effect.promise(() => acceptPolledResponse(receivedResponse)),
                      ),
                      Effect.tapError(() =>
                        Effect.promise(() => rejectPolledResponse(receivedResponse)),
                      ),
                      Effect.tap((decoded) =>
                        activeStore !== undefined && cached !== undefined
                          ? Effect.promise(() =>
                              storeConditionalEntry(
                                activeStore,
                                cached.key,
                                seenValidators ?? { etag: null, lastModified: null },
                                decoded,
                                observedAt ?? activeStore.now(),
                                undefined,
                                reservation,
                              ),
                            )
                          : Effect.void,
                      ),
                    );
                  }
                  // A 304 is only honored with a cached value in hand (see
                  // fetchBytes), so the entry is defined here; the guard keeps the
                  // invariant explicit instead of trusting it.
                  if (entry === undefined) {
                    return Effect.fail(
                      new TransportFailure({
                        status: 304,
                        message: `HTTP 304 for ${redactFeedUrl(requestUrl, feed.auth)} without a cached value`,
                      }),
                    );
                  }
                  // The entry exists only when a store served the lookup, so the
                  // clock is defined here; the fallback keeps the expression total.
                  const reusedAt = activeStore?.now() ?? Date.now();
                  return Effect.try({
                    try: () =>
                      feed.onNotModified?.(entry.decoded as T, reusedAt) ?? (entry.decoded as T),
                    catch: (cause) => cause,
                  }).pipe(
                    Effect.flatMap(applyResponse),
                    Effect.tap((refreshed) =>
                      activeStore !== undefined && cached !== undefined
                        ? Effect.promise(() =>
                            storeConditionalEntry(
                              activeStore,
                              cached.key,
                              {
                                etag: seenValidators?.etag ?? entry.etag ?? null,
                                lastModified:
                                  seenValidators?.lastModified ?? entry.lastModified ?? null,
                              },
                              refreshed,
                              observedAt ?? activeStore.now(),
                              undefined,
                              reservation,
                            ),
                          )
                        : Effect.void,
                    ),
                  );
                }),
                Effect.tapError(() =>
                  activeStore !== undefined && cached !== undefined && entry !== undefined
                    ? Effect.promise(() =>
                        storeConditionalEntry(
                          activeStore,
                          cached.key,
                          { etag: entry.etag ?? null, lastModified: entry.lastModified ?? null },
                          entry.decoded,
                          entry.observedAt,
                          activeStore.now(),
                          reservation,
                        ),
                      )
                    : Effect.void,
                ),
                Effect.ensuring(Effect.sync(() => reservation?.release())),
              );
            }),
          );
        }),
        Effect.mapError((cause) => feed.mapError(cause)),
        Effect.match({
          onFailure: (error) => ({ ok: false as const, error }),
          onSuccess: (value) => ({ ok: true as const, value }),
        }),
      ),
    ),
    { concurrency },
  ).pipe(
    Effect.map((results) => {
      const usable: T[] = [];
      let firstError: E | undefined;
      for (const result of results) {
        if (result.ok) usable.push(result.value);
        else if (firstError === undefined) firstError = result.error;
      }
      return firstError === undefined ? { usable } : { usable, firstError };
    }),
  );
}
