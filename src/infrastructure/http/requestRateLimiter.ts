import * as Data from "effect/Data";
import { detectHostingTarget } from "~/infrastructure/env/hostingTarget";
import { getRequestRateLimitPolicy } from "~/infrastructure/env/ServerEnv";
import { clientNetworkKey, rateLimitClientIp } from "./clientIp";

/** Wrangler `ratelimits` binding name; the deployment config must declare it. */
export const REQUEST_RATE_LIMIT_BINDING_NAME = "REQUEST_RATE_LIMITER";

/** Requests without a usable client address share one bucket instead of bypassing the limit. */
export const UNKNOWN_CLIENT_KEY = "unknown-client";

/** Answers whether one more request from `key` is admitted. */
export interface RequestRateLimiter {
  readonly admit: (key: string) => Promise<boolean>;
}

/** Structural shape of the Workers Rate Limiting binding. */
export interface WorkersRateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export class RateLimitBindingRefusedError extends Data.TaggedError("RateLimitBindingRefusedError")<{
  readonly bindingName: string;
}> {
  override get message(): string {
    return `Cloudflare deployment is missing the "${this.bindingName}" rate-limit binding; declare it under "ratelimits" in wrangler.jsonc`;
  }
}

export function createWorkersRateLimiter(binding: WorkersRateLimitBinding): RequestRateLimiter {
  return { admit: async (key) => (await binding.limit({ key })).success };
}

/**
 * Fixed-window counter for one self-hosted process. At `maxKeys` it sweeps
 * expired windows, then evicts the oldest key, so memory stays bounded.
 */
export function createMemoryRateLimiter(options: {
  readonly limit: number;
  readonly windowMs: number;
  readonly maxKeys?: number;
  readonly now?: () => number;
}): RequestRateLimiter {
  const { limit, windowMs, maxKeys = 10_000, now = Date.now } = options;
  const windows = new Map<string, { start: number; count: number }>();
  return {
    admit: async (key) => {
      const at = now();
      const current = windows.get(key);
      if (current !== undefined && at - current.start < windowMs) {
        if (current.count >= limit) return false;
        current.count += 1;
        return true;
      }
      windows.delete(key);
      if (windows.size >= maxKeys) {
        for (const [candidate, window] of windows) {
          if (at - window.start >= windowMs) windows.delete(candidate);
        }
        if (windows.size >= maxKeys) windows.delete(windows.keys().next().value!);
      }
      windows.set(key, { start: at, count: 1 });
      return limit > 0;
    },
  };
}

/** Rate-limit key: the client's IPv4 address or IPv6 /64, else the shared unknown bucket. */
export function requestRateLimitKey(request: Request): string {
  const ip = rateLimitClientIp(request);
  return (ip === null ? null : clientNetworkKey(ip)) ?? UNKNOWN_CLIENT_KEY;
}

let memoryLimiter: RequestRateLimiter | undefined;

/**
 * Workers use the platform binding; a Workers deploy without it is refused.
 * Self-hosted runtimes and local dev without the binding use one in-process limiter.
 */
export function resolveRequestRateLimiter(): RequestRateLimiter {
  const binding = (globalThis as { env?: Record<string, unknown> }).env?.[
    REQUEST_RATE_LIMIT_BINDING_NAME
  ] as WorkersRateLimitBinding | undefined;
  if (binding !== undefined && typeof binding.limit === "function") {
    return createWorkersRateLimiter(binding);
  }
  if (detectHostingTarget() === "cloudflare") {
    throw new RateLimitBindingRefusedError({ bindingName: REQUEST_RATE_LIMIT_BINDING_NAME });
  }
  memoryLimiter ??= createMemoryRateLimiter(getRequestRateLimitPolicy());
  return memoryLimiter;
}

export function resetRequestRateLimiterForTesting(): void {
  memoryLimiter = undefined;
}
