import { logger } from "~/infrastructure/logging/logger";

/**
 * Portable agency-neutral snapshot cache seam.
 *
 * Stores validated typed snapshot values plus receipt metadata, never
 * platform `Request`/`Response` objects, so the same seam serves the
 * process-local in-memory cache on self-hosted Bun/Docker (no Cloudflare
 * bindings, no Redis) and can later sit behind an edge response cache.
 *
 * Freshness policy:
 * - TTL 15s: warm requests within the window are HITs with no refresh.
 * - Warm expiry: join one single-flight refresh so the caller receives the
 *   newly generated snapshot rather than repeatedly observing the pre-refresh
 *   value on a polling cadence aligned with the TTL.
 * - Cold miss: await one single-flight refresh; failure rejects so callers
 *   return an explicit error instead of a fabricated empty all-clear.
 * - Failed warm refreshes retain the last valid snapshot (never empty)
 *   for the 60s stale-on-error grace period. Repeated refreshes fail fast
 *   during the failure cooldown, then retry when it expires. After the grace
 *   period, callers receive the failure even during cooldown.
 */

const SNAPSHOT_CACHE_TTL_MS = 15_000;
const MAX_REFRESH_AGE_MS = 30_000;
export const SNAPSHOT_CACHE_FAILURE_TTL_MS = SNAPSHOT_CACHE_TTL_MS;
export const SNAPSHOT_CACHE_STALE_GRACE_MS = 60_000;

export type SnapshotCacheStatus = "MISS" | "HIT" | "STALE";

export interface SnapshotCacheResult<S> {
  readonly value: S;
  readonly status: SnapshotCacheStatus;
  /** Whole seconds since the cached value was received. */
  readonly ageSeconds: number;
  readonly receivedAt: number;
}

export interface SnapshotCache<S> {
  /** Cold MISS and expired warm requests await one single-flight refresh. */
  readonly get: () => Promise<SnapshotCacheResult<S>>;
  /** Current value without triggering a refresh (may be null when cold). */
  readonly peek: () => S | null;
}

export function createSnapshotCache<S>(options: {
  readonly label: string;
  readonly ttlMs?: number;
  /** Reject repeated refreshes for this duration after a failure. */
  readonly failureTtlMs?: number;
  readonly now?: () => number;
  readonly refresh: () => Promise<S>;
}): SnapshotCache<S> {
  const ttlMs = options.ttlMs ?? SNAPSHOT_CACHE_TTL_MS;
  const failureTtlMs = Math.max(0, options.failureTtlMs ?? SNAPSHOT_CACHE_FAILURE_TTL_MS);
  const nowFn = options.now ?? (() => Date.now());

  const holder: {
    value: S | null;
    receivedAt: number;
    inflight: Promise<S> | null;
    inflightStartedAt: number;
    generation: number;
    warmRefreshFailedAt: number | null;
    failure: { until: number; cause: unknown } | null;
  } = {
    value: null,
    receivedAt: 0,
    inflight: null,
    inflightStartedAt: 0,
    generation: 0,
    warmRefreshFailedAt: null,
    failure: null,
  };

  function ensureInflight(): Promise<S> {
    if (!holder.inflight || nowFn() - holder.inflightStartedAt > MAX_REFRESH_AGE_MS) {
      const generation = ++holder.generation;
      holder.inflightStartedAt = nowFn();
      const pending = runRefresh(generation);
      holder.inflight = pending;
      const clear = () => {
        if (holder.generation === generation) holder.inflight = null;
      };
      void pending.then(clear, clear);
    }
    return holder.inflight;
  }

  async function runRefresh(generation: number): Promise<S> {
    const isWarmRefresh = holder.value !== null;
    try {
      const next = await options.refresh();
      if (holder.generation !== generation) return supersedingRefresh();
      holder.value = next;
      holder.receivedAt = nowFn();
      holder.warmRefreshFailedAt = null;
      holder.failure = null;
      return next;
    } catch (error) {
      if (holder.generation !== generation) return supersedingRefresh();
      const failedAt = nowFn();
      holder.failure = {
        until: failedAt + failureTtlMs,
        cause: error,
      };
      if (isWarmRefresh && holder.warmRefreshFailedAt === null) {
        holder.warmRefreshFailedAt = failedAt;
      }
      throw error;
    }
  }

  function supersedingRefresh(): Promise<S> {
    if (holder.inflight) return holder.inflight;
    if (holder.failure) return Promise.reject(holder.failure.cause);
    if (holder.value !== null) return Promise.resolve(holder.value);
    return Promise.reject(new Error(`${options.label}: refresh was superseded`));
  }

  function result(
    value: S,
    status: SnapshotCacheStatus,
    receivedAt: number,
    now: number,
  ): SnapshotCacheResult<S> {
    return {
      value,
      status,
      ageSeconds: Math.max(0, Math.floor((now - receivedAt) / 1000)),
      receivedAt,
    };
  }

  return {
    get() {
      const now = nowFn();
      const current = holder.value;
      if (current !== null && now - holder.receivedAt < ttlMs) {
        return Promise.resolve(result(current, "HIT", holder.receivedAt, now));
      }

      const failure = holder.failure;
      if (failure && now < failure.until) {
        if (
          current !== null &&
          holder.warmRefreshFailedAt !== null &&
          now - holder.warmRefreshFailedAt < SNAPSHOT_CACHE_STALE_GRACE_MS
        ) {
          return Promise.resolve(result(current, "STALE", holder.receivedAt, now));
        }
        return Promise.reject(failure.cause);
      }

      if (current === null) {
        return ensureInflight().then((value) => ({
          value,
          status: "MISS" as const,
          ageSeconds: 0,
          receivedAt: holder.receivedAt,
        }));
      }

      return ensureInflight().then(
        (value) => result(value, "HIT", holder.receivedAt, nowFn()),
        (error: unknown) => {
          const retained = holder.value;
          const failedAt = holder.warmRefreshFailedAt;
          const canRetain =
            retained !== null &&
            failedAt !== null &&
            nowFn() - failedAt < SNAPSHOT_CACHE_STALE_GRACE_MS;

          if (canRetain) {
            logger.warn(`${options.label}: warm refresh failed, retaining cached snapshot`, {
              err: error,
            });
            return result(retained, "STALE", holder.receivedAt, nowFn());
          }

          throw error;
        },
      );
    },

    peek() {
      return holder.value;
    },
  };
}
