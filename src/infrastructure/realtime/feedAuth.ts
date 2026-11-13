import type { FeedAccept, FeedAuth } from "~/agencies/types";
import { isFeedSecretName } from "~/infrastructure/env/feedSecretName";

export type FeedFormat = "protobuf" | "json" | "xml";

/**
 * Feed auth options supplied by callers / composition root.
 */
export interface FeedAuthOptions {
  readonly getSecret?: (name: string) => string | undefined;
  readonly init?: RequestInit;
  readonly now?: () => number;
}

export interface AppliedFeedAuth {
  readonly url: string;
  readonly init: RequestInit;
}

/**
 * Routes a declared feed through a local development proxy when requested by
 * the feed declaration. The upstream path and authenticated query are kept
 * intact; production callers omit the proxy origin and use the upstream URL.
 */
export function applyDevFeedProxy(
  url: string,
  devProxyPrefix: string | undefined,
  devProxyOrigin: string | undefined,
): string {
  if (!devProxyPrefix || !devProxyOrigin) return url;
  const upstream = new URL(url);
  const prefix = devProxyPrefix.replace(/\/+$/, "");
  return `${devProxyOrigin.replace(/\/+$/, "")}${prefix}${upstream.pathname}${upstream.search}`;
}

export interface FeedFormatOptions {
  readonly init?: RequestInit;
  readonly accept?: FeedAccept;
}

/**
 * Selects the wire representation requested from an upstream feed.
 * Providers that support content negotiation (including Metrolinx) use the
 * standard media types rather than encoding format-specific URL suffixes.
 */
export function applyFeedFormat(
  format: FeedFormat | undefined,
  optionsOrInit?: RequestInit | FeedFormatOptions,
  legacyAccept?: FeedAccept,
): RequestInit {
  const isOptions =
    optionsOrInit !== undefined && ("accept" in optionsOrInit || "init" in optionsOrInit);
  const init = isOptions
    ? (optionsOrInit as FeedFormatOptions).init
    : (optionsOrInit as RequestInit | undefined);
  const resolvedAccept = isOptions
    ? ((optionsOrInit as FeedFormatOptions).accept ?? legacyAccept)
    : legacyAccept;

  const nextInit: RequestInit = { ...init };
  const mediaType =
    resolvedAccept ??
    (format === "protobuf"
      ? "application/x-protobuf"
      : format === "json"
        ? "application/json"
        : format === "xml"
          ? "application/xml"
          : undefined);
  if (!mediaType) return nextInit;
  const headers = new Headers(nextInit.headers);
  headers.set("Accept", mediaType);
  nextInit.headers = headers;
  return nextInit;
}

/** Removes credential values before a feed URL is included in diagnostics. */
export function redactFeedUrl(url: string, auth?: FeedAuth): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    const names = ["key", "api_key", "apikey", "token", "access_token"];
    if (auth?.type === "query_param") names.push(auth.parameterName);
    if (auth?.type === "custom") names.push(auth.keyParameter, auth.signatureParameter);
    for (const name of names) {
      if (parsed.searchParams.has(name)) parsed.searchParams.set(name, "[redacted]");
    }
    return parsed.toString();
  } catch {
    return "[redacted feed URL]";
  }
}

/**
 * Pure helper applying declared FeedAuth transport rules (header or query_param)
 * to a feed URL and RequestInit using injected secret resolution.
 *
 * If the secret name is undefined or getSecret returns undefined, the request
 * proceeds without credentials so endpoints fail honestly with HTTP 401/403.
 */
export function applyFeedAuth(
  url: string,
  auth: FeedAuth | undefined,
  options?: FeedAuthOptions,
): AppliedFeedAuth {
  const init: RequestInit = { ...options?.init };
  if (!auth || auth.type === "none") {
    return { url, init };
  }

  if (auth.type === "custom") throw new Error("Signed feed auth requires asynchronous transport");
  const getSecret = options?.getSecret;
  const secretName = "secretName" in auth ? auth.secretName : undefined;
  const secretValue =
    secretName && isFeedSecretName(secretName) && getSecret ? getSecret(secretName) : undefined;

  if (auth.type === "header") {
    if (secretValue) {
      const headers = new Headers(init.headers);
      headers.set(auth.headerName, secretValue);
      init.headers = headers;
    }
    return { url, init };
  }

  if (auth.type === "query_param") {
    if (secretValue) {
      const parsedUrl = new URL(url);
      parsedUrl.searchParams.set(auth.parameterName, secretValue);
      return { url: parsedUrl.toString(), init };
    }
    return { url, init };
  }

  return { url, init };
}

/** Minute-salted signatures use Web Crypto on both Workers and self-hosted runtimes. */
export async function applyFeedAuthRequest(
  url: string,
  auth: FeedAuth | undefined,
  options?: FeedAuthOptions,
): Promise<AppliedFeedAuth> {
  if (auth?.type !== "custom") return applyFeedAuth(url, auth, options);
  const resolve = (name: string) =>
    isFeedSecretName(name) ? options?.getSecret?.(name) : undefined;
  const key = resolve(auth.keySecretName),
    secret = resolve(auth.secretName);
  if (!key || !secret) throw new Error("Missing signed feed credentials");
  const minute =
    new Date((options?.now ?? Date.now)()).toISOString().slice(0, 16).replace(/[-:]/gu, "") + "Z";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret + minute));
  const signature = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  const parsed = new URL(url);
  parsed.searchParams.set(auth.keyParameter, key);
  parsed.searchParams.set(auth.signatureParameter, signature);
  return { url: parsed.toString(), init: { ...options?.init } };
}
