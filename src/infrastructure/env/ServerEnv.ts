import type { PushRegistrationPolicy, VapidKeys } from "~/domain/notifications/types";
import { isFeedSecretName } from "./feedSecretName";

/**
 * The single server-env read seam.
 *
 * Precedence is owned exactly once, here: `process.env` first, Bun/Node load
 * `.env` there, and under Cloudflare's nodejs_compat worker vars and secrets
 * are mirrored into process.env, then the Cloudflare bindings object
 * (`globalThis.env`, see wrangler.jsonc vars). The bindings channel exists
 * solely as a documented test-simulation channel: unit suites install
 * `globalThis.env` to simulate Workers-only configurations. All reads happen
 * at call time (never at module load) so they stay correct across runtimes.
 *
 * Consumers must go through the typed accessors below instead of touching
 * process.env directly for these variables, that is what retired the
 * divergent readServerEnv / readProcessEnv helpers from src/lib/devFlags.ts.
 * (Cross-cutting infrastructure that also consults a build-time channel, like
 * the logger's import.meta.env fallback, reads its own channels directly and
 * documents why.)
 */

/** Placeholder VAPID subject used when VAPID_SUBJECT is unset or blank. */
export const DEFAULT_VAPID_SUBJECT = "mailto:admin@example.com";

type EnvRecord = Record<string, string | undefined>;

/**
 * Primitive owning the precedence chain. Empty-string process values are
 * treated as unset so a half-configured .env falls through to bindings
 * instead of poisoning the config.
 */
function readServerVar(name: string): string | undefined {
  if (typeof process !== "undefined") {
    const processValue = (process.env as EnvRecord | undefined)?.[name];
    if (processValue !== undefined && processValue !== "") {
      return processValue;
    }
  }
  return (globalThis as { env?: EnvRecord }).env?.[name];
}

/**
 * VAPID configuration for Web Push, or null when unconfigured.
 *
 * Returns null unless BOTH keys resolve non-empty (whitespace-only counts as
 * unset). VAPID_SUBJECT defaulting happens only inside a configured result —
 * an unconfigured server never fabricates a subject-bearing config.
 */
export function getVapidConfig(): VapidKeys | null {
  const publicKey = readServerVar("VAPID_PUBLIC_KEY")?.trim();
  const privateKey = readServerVar("VAPID_PRIVATE_KEY")?.trim();
  if (!publicKey || !privateKey) return null;

  const subject = readServerVar("VAPID_SUBJECT")?.trim() || DEFAULT_VAPID_SUBJECT;
  return { publicKey, privateKey, subject };
}

/**
 * GeoLite2 database path for coarse-IP geolocation, or null when unset.
 * Callers preserve silent-degrade on null: operators without the database
 * simply keep the coarse-ip tier disabled.
 */
export function getGeoipDbPath(): string | null {
  return readServerVar("GEOIP_DB_PATH")?.trim() || null;
}

/**
 * Runtime NODE_ENV behind dev-status evaluation. Note the build-time
 * import.meta.env.DEV flag still wins over this value (see devFlags.ts).
 */
export function getNodeEnv(): string | undefined {
  return readServerVar("NODE_ENV");
}

/**
 * Feed auth secret provisioned by deployment/platform.
 * Returns the trimmed secret value, or undefined when unset or whitespace-only.
 */
export function getFeedSecret(name: string): string | undefined {
  if (!isFeedSecretName(name)) return undefined;
  const value = readServerVar(name)?.trim();
  return value ? value : undefined;
}

/** Additional exact HTTPS push-service hostnames trusted by a self-hosted operator. */
export function getAdditionalPushEndpointHosts(): string[] {
  return (readServerVar("PUSH_ENDPOINT_HOSTS") ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
}

function readPositiveInteger(name: string, fallback: number): number {
  const raw = readServerVar(name)?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * Self-hosted request rate limit per client network. Workers declare theirs on
 * the rate-limit binding in wrangler config instead.
 */
export function getRequestRateLimitPolicy(): { readonly limit: number; readonly windowMs: number } {
  return {
    limit: readPositiveInteger("REQUEST_RATE_LIMIT", 600),
    windowMs: readPositiveInteger("REQUEST_RATE_LIMIT_WINDOW_SECONDS", 60) * 1000,
  };
}

/** Push registration bounds; unset or invalid values fall back to the defaults. */
export function getPushRegistrationPolicy(): PushRegistrationPolicy {
  const minute = 60 * 1000;
  return {
    perClientLimit: readPositiveInteger("PUSH_REGISTRATION_LIMIT", 10),
    windowMs: readPositiveInteger("PUSH_REGISTRATION_WINDOW_MINUTES", 60) * minute,
    maxSubscriptions: readPositiveInteger("PUSH_SUBSCRIPTION_CEILING", 50_000),
    undeliveredRetentionMs:
      readPositiveInteger("PUSH_UNDELIVERED_RETENTION_DAYS", 30) * 24 * 60 * minute,
  };
}
