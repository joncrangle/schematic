import * as Effect from "effect/Effect";
import type { RealtimeFeedConfig } from "~/agencies/types";
import type { HostConcurrencyLimiter } from "../../http/hostConcurrency";
import { fetchDecodedFeeds } from "../fetchDecodedFeeds";
import { createFeedPollingFetch } from "../feedPolling";
export type TripSparkFeed = Extract<RealtimeFeedConfig, { kind: "tripspark" }>;
export type TripSparkSessionConfig = Pick<
  TripSparkFeed,
  "url" | "pollIntervalSeconds" | "sessionTokenArgument"
>;
export interface TripSparkHttpOptions {
  readonly fetch: typeof fetch;
  readonly hostLimiter?: HostConcurrencyLimiter;
  readonly now?: () => number;
  readonly language?: string;
}
interface Session {
  readonly token: string;
  readonly cookie: string;
}
const sessions = new WeakMap<
  typeof fetch,
  Map<string, { expires: number; value: Promise<Session> }>
>();

/** Reads arguments without evaluating provider script, including nested preceding arguments. */
export function decodeTripSparkSessionToken(html: string, argument: number): string {
  const marker = "new Home.HomeViewModel(";
  const at = html.indexOf(marker);
  if (at < 0) throw new Error("Missing anonymous session declaration");
  const text = html.slice(at + marker.length);
  const args: string[] = [];
  let start = 0,
    depth = 0,
    quote = "",
    escaped = false;
  for (let i = 0; i < text.length && args.length <= argument; i++) {
    const char = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if ("([{".includes(char)) depth++;
    else if (")]}".includes(char)) depth--;
    else if (char === "," && depth === 0) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const encoded = /^["']([A-Za-z0-9+/=]+)["']$/u.exec(args[argument] ?? "")?.[1];
  if (!encoded) throw new Error("Unreadable anonymous session token");
  const token = atob(encoded);
  if (!token || /[\r\n]/u.test(token)) throw new Error("Invalid anonymous session token");
  return token;
}
async function session(
  feed: TripSparkSessionConfig,
  options: TripSparkHttpOptions,
): Promise<Session | undefined> {
  if (feed.sessionTokenArgument === undefined) return undefined;
  let cache = sessions.get(options.fetch);
  if (!cache) {
    cache = new Map();
    sessions.set(options.fetch, cache);
  }
  const now = (options.now ?? Date.now)(),
    key = new URL(feed.url).origin + "|" + (options.language ?? "en-CA");
  const origin = new URL(feed.url).origin;
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.value;
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  const value = (async () => {
    const result = await Effect.runPromise(
      fetchDecodedFeeds(
        [
          {
            url: origin + "/",
            headers: { "Accept-Language": options.language ?? "en-CA" },
            decode: (bytes) =>
              Effect.try(() => ({
                token: decodeTripSparkSessionToken(
                  new TextDecoder().decode(bytes),
                  feed.sessionTokenArgument!,
                ),
                cookie: "",
              })),
            onResponse: (decoded, response) => ({
              ...decoded,
              cookie: response.headers
                .getSetCookie()

                .map((c) => c.split(";")[0])
                .join("; "),
            }),
            mapError: () => new Error("Anonymous session unavailable"),
          },
        ],
        { fetch: options.fetch, attempts: 1, timeoutMs: 8000, hostLimiter: options.hostLimiter },
      ),
    );
    const decoded = result.usable[0];
    if (!decoded?.cookie) throw new Error("Anonymous session cookie unavailable");
    return decoded;
  })();
  cache.set(key, { expires: now + 20 * 60_000, value });
  value.catch(() => cache!.delete(key));
  return value;
}
async function requestTripSparkDocument(
  feed: TripSparkSessionConfig,
  path: string,
  options: TripSparkHttpOptions,
  body?: Record<string, unknown> | URLSearchParams,
  asText = false,
): Promise<unknown> {
  const credentials = await session(feed, options),
    url = new URL(path, new URL(feed.url).origin).href;
  const form = body instanceof URLSearchParams;
  const headers: Record<string, string> = {
    "X-Requested-With": "XMLHttpRequest",
    "Accept-Language": options.language ?? "en-CA",
    ...(body
      ? { "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json" }
      : {}),
  };
  if (credentials) {
    headers.RequestVerificationToken = credentials.token;
    headers.Cookie = credentials.cookie;
  }
  const wireBody = body ? (form ? body.toString() : JSON.stringify(body)) : undefined;
  const polling = createFeedPollingFetch(
    [{ ...feed, url, pollIntervalSeconds: feed.pollIntervalSeconds ?? 60 }],
    {
      now: options.now,
      fetch: (input, init) => options.fetch(input, { ...init, redirect: "manual" }),
    },
  );
  const result = await Effect.runPromise(
    fetchDecodedFeeds(
      [
        {
          url,
          format: "json",
          method: body ? "POST" : "GET",
          body: wireBody,
          headers,
          decode: (bytes) =>
            Effect.try(() =>
              asText
                ? new TextDecoder().decode(bytes)
                : JSON.parse(new TextDecoder().decode(bytes)),
            ),
          mapError: () => new Error("TripSpark document unavailable"),
        },
      ],
      { fetch: polling, attempts: 1, timeoutMs: 8000, hostLimiter: options.hostLimiter },
    ),
  );
  if (!result.usable.length) {
    sessions
      .get(options.fetch)
      ?.delete(new URL(feed.url).origin + "|" + (options.language ?? "en-CA"));
    throw result.firstError ?? new Error("TripSpark request failed");
  }
  return result.usable[0];
}

export function requestTripSparkJson(
  feed: TripSparkSessionConfig,
  path: string,
  options: TripSparkHttpOptions,
  body?: Record<string, unknown> | URLSearchParams,
): Promise<unknown> {
  return requestTripSparkDocument(feed, path, options, body);
}
export async function requestTripSparkText(
  feed: TripSparkSessionConfig,
  path: string,
  options: TripSparkHttpOptions,
): Promise<string> {
  const result = await requestTripSparkDocument(feed, path, options, undefined, true);
  if (typeof result !== "string") throw new Error("Invalid TripSpark text document");
  return result;
}
