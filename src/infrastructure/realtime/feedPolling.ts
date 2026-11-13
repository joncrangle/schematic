import { registerPolledResponse } from "./polledResponse";
import { conditionalCacheKey, readResponseBody } from "./fetchDecodedFeeds";

interface PollingFeed {
  readonly url: string;
  readonly pollIntervalSeconds?: number;
  readonly requestsPerMinute?: number;
  readonly devProxyPrefix?: string;
}
interface PolledDocument {
  readonly bytes: Uint8Array;
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly [string, string][];
  readonly observedAt: number;
}
interface PollEntry {
  readonly startedAt: number;
  readonly pending: Promise<PolledDocument>;
  document?: PolledDocument;
}
interface PollingOptions {
  readonly fetch: typeof fetch;
  readonly now?: () => number;
  readonly devProxyOrigin?: string;
  readonly memory?: Map<string, PollEntry>;
  readonly edgeCache?: Cache | null;
}

const documents = new Map<string, PollEntry>();
const requestBudgets = new WeakMap<typeof fetch, Map<string, number[]>>();
const OBSERVED_AT = "x-schematic-feed-observed-at";
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 128;

function edgeCache(): Cache | undefined {
  return (globalThis as typeof globalThis & { caches?: { default?: Cache } }).caches?.default;
}

function response(document: PolledDocument): Response {
  return new Response(
    document.status === 204 || document.status === 304 ? null : document.bytes.slice(),
    {
      status: document.status,
      statusText: document.statusText,
      headers: [...document.headers],
    },
  );
}

function pathPattern(pathname: string): RegExp {
  const path = decodeURI(pathname)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("\\{stopId\\}", "[^/]+")
    .replaceAll("\\{date\\}", "[^/]+")
    .replaceAll("\\{terminal\\}", "[^/]+")
    .replaceAll("\\{board\\}", "[^/]+");
  return new RegExp(`^${path}(?:/|$)`);
}

/** Conditional validators belong to one consumer, never to the shared poll. */
function withoutValidators(source: Headers): Headers {
  const headers = new Headers(source);
  headers.delete("If-None-Match");
  headers.delete("If-Modified-Since");
  return headers;
}

function trim(memory: Map<string, PollEntry>): void {
  let size = [...memory.values()].reduce(
    (sum, entry) => sum + (entry.document?.bytes.length ?? 0),
    0,
  );
  for (const [key, entry] of memory) {
    if (size <= MAX_CACHE_BYTES && memory.size <= MAX_CACHE_ENTRIES) break;
    if (!entry.document) continue;
    size -= entry.document.bytes.length;
    memory.delete(key);
  }
}

/** Share wire documents, never filtered or decoded results, across provider ports. */
export function createFeedPollingFetch(
  feeds: readonly PollingFeed[],
  options: PollingOptions,
): typeof fetch {
  const now = options.now ?? Date.now;
  const memory = options.memory ?? documents;
  const cache = options.edgeCache === undefined ? edgeCache() : (options.edgeCache ?? undefined);
  const rules = feeds
    .filter((feed) => feed.pollIntervalSeconds !== undefined)
    .map((feed) => {
      const source = new URL(feed.url);
      const proxy =
        feed.devProxyPrefix && options.devProxyOrigin
          ? new URL(
              `${feed.devProxyPrefix.replace(/\/+$/, "")}${source.pathname}`,
              options.devProxyOrigin,
            )
          : undefined;
      const paths = [pathPattern(source.pathname), proxy && pathPattern(proxy.pathname)];
      return { feed, source, proxy, paths };
    });
  if (rules.length === 0) return options.fetch;

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const rule = rules.find(
      ({ source, proxy, paths }) =>
        ((url.origin === source.origin && paths[0]!.test(decodeURI(url.pathname))) ||
          (url.origin === proxy?.origin && paths[1]?.test(decodeURI(url.pathname)))) &&
        [...source.searchParams].every(([key, value]) => url.searchParams.get(key) === value),
    );
    if (!rule) return options.fetch(input, init);
    const intervalMs = rule.feed.pollIntervalSeconds! * 1000;
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.clone().text();
    const sharedHeaders = withoutValidators(request.headers);
    const key = await conditionalCacheKey(
      request.url,
      sharedHeaders,
      JSON.stringify(["wire-poll-v1", intervalMs, request.method, body]),
    );
    let entry = memory.get(key);
    const age =
      entry === undefined ? Infinity : now() - (entry.document?.observedAt ?? entry.startedAt);
    if (entry && age >= 0 && age < intervalMs) {
      // Refresh recency so trim evicts idle feeds before frequently read ones.
      memory.delete(key);
      memory.set(key, entry);
    } else {
      const startedAt = now();
      const pending = (async (): Promise<PolledDocument> => {
        if (cache) {
          try {
            const hit = await cache.match(key);
            if (hit) {
              const observedAt = Number(hit.headers.get(OBSERVED_AT));
              const age = now() - observedAt;
              if (Number.isFinite(observedAt) && age >= 0 && age < intervalMs) {
                const headers = new Headers(hit.headers);
                headers.delete(OBSERVED_AT);
                return {
                  bytes: await readResponseBody(hit, "cached feed", undefined),
                  status: hit.status,
                  statusText: hit.statusText,
                  headers: [...headers],
                  observedAt,
                };
              }
            }
          } catch {
            // An unavailable edge cache falls back to the process poller.
          }
        }
        if (rule.feed.requestsPerMinute) {
          let origins = requestBudgets.get(options.fetch);
          if (!origins) {
            origins = new Map();
            requestBudgets.set(options.fetch, origins);
          }
          const timestamp = now();
          const recent = (origins.get(url.origin) ?? []).filter((time) => timestamp - time < 60000);
          origins.set(url.origin, recent);
          if (recent.length >= rule.feed.requestsPerMinute)
            return {
              bytes: new Uint8Array(),
              status: 429,
              statusText: "Local feed request budget exhausted",
              headers: [],
              observedAt: timestamp,
            };
          recent.push(timestamp);
        }
        const upstream = await options.fetch(request.url, {
          ...init,
          method: request.method,
          body,
          headers: sharedHeaders,
          signal: AbortSignal.timeout(8_000),
        });
        const document = {
          bytes: await readResponseBody(upstream, "polled feed", undefined),
          status: upstream.status,
          statusText: upstream.statusText,
          headers: [...upstream.headers],
          observedAt: now(),
        };
        return document;
      })();
      entry = { startedAt, pending };
      memory.delete(key);
      memory.set(key, entry);
      const current = entry;
      pending.then(
        (document) => {
          current.document = document;
          trim(memory);
        },
        () => {
          // A thrown read (timeout, network loss, a cancelled or exhausted
          // invocation) produced no upstream document, so the next caller
          // retries. Upstream error statuses stay cached for the interval.
          if (memory.get(key) === current) memory.delete(key);
        },
      );
    }
    const document = await waitForPoll(entry.pending, request.signal);
    return registerPolledResponse(response(document), {
      accept: async () => {
        if (!cache || document.status < 200 || document.status >= 300) return;
        try {
          const stored = response(document);
          stored.headers.set(OBSERVED_AT, String(document.observedAt));
          stored.headers.set("Cache-Control", `public, max-age=${Math.ceil(intervalMs / 1000)}`);
          await cache.put(key, stored);
        } catch {
          /* A cache write cannot fail a validated feed. */
        }
      },
      reject: async () => {
        if (memory.get(key) === entry) memory.delete(key);
        try {
          await cache?.delete(key);
        } catch {
          /* A corrupt observation is never reused locally. */
        }
      },
    });
  }) as typeof fetch;
}

function waitForPoll<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
