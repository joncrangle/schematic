import { logger } from "~/infrastructure/logging/logger";

/**
 * Shared single-flight SWR cache kernel for GTFS-RT binary feed ingests.
 *
 * Owns the mutable composite state ({@link SwrFeedCacheHolder.state} +
 * in-flight refresh promise) so no ingest service hand-rolls the
 * TTL-check/single-flight/error-fallback dance again (there were two
 * near-copies; a third must not appear).
 *
 * Divergent caller behaviour is expressed explicitly as an expiry policy:
 * - "stale-while-revalidate": serve the previous snapshot immediately once
 *   warm and let the background poll land later (surface protobuf ingest).
 * - "join-refresh": await the single-flight poll whenever the cache expired,
 *   so callers observe fresh data (and any stale flags set during it) on the
 *   same request that triggered polling (subway trip-updates ingest).
 *
 * Refresh functions receive the current state and RETURN the next state; the
 * kernel performs the assignment, clears the in-flight slot, and handles
 * thrown refresh failures according to {@link SwrRefreshFailurePolicy} —
 * "retain" (default) keeps serving current state so an in-flight promise
 * never rejects; "throw" propagates the failure to every joined caller and
 * clears the slot so the next call retries.
 */
export type SwrExpiryPolicy = "stale-while-revalidate" | "join-refresh";

export type SwrRefreshFailurePolicy = "retain" | "throw";

export interface SwrFeedCache<S> {
  /** Fast-path fresh state, else per-policy single-flight refresh. */
  readonly get: () => Promise<S>;
  /** Current state without triggering freshness (fallback branches). */
  readonly peek: () => S;
  /** Start or join a refresh right now (manual/forced refresh APIs). */
  readonly refreshNow: () => Promise<S>;
}

/** Minimal state contract every feed snapshot satisfies for TTL bookkeeping. */
interface SwrState {
  readonly generatedAt: number;
}

export function createSwrFeedCache<S extends SwrState>(options: {
  readonly label: string;
  readonly ttlMs: number;
  readonly initialState: S;
  readonly expiryPolicy: SwrExpiryPolicy;
  /**
   * Failure policy for a thrown refresh: "retain" (default) keeps current
   * state and logs; "throw" rejects every joined caller (invariant:
   * never silently serve stale on a failed fetch).
   */
  readonly onRefreshFailure?: SwrRefreshFailurePolicy;
  /** Reject repeated callers during this cooldown after a failed refresh. */
  readonly failureTtlMs?: number;
  /** Compute the next state from the current one; failure handling per onRefreshFailure. */
  readonly refresh: (current: S) => Promise<S>;
}): SwrFeedCache<S> {
  // One holder owns all mutable state, no scattered module-level lets.
  const holder: {
    state: S;
    inflight: Promise<S> | null;
    failure?: { until: number; cause: unknown };
  } = {
    state: options.initialState,
    inflight: null,
  };

  function ensureInflight(): Promise<S> {
    if (!holder.inflight) {
      holder.inflight = runRefresh();
    }
    return holder.inflight;
  }

  async function runRefresh(): Promise<S> {
    try {
      const next = await options.refresh(holder.state);
      holder.state = next;
      holder.failure = undefined;
      return next;
    } catch (err) {
      if ((options.onRefreshFailure ?? "retain") === "throw") {
        holder.failure = { until: Date.now() + (options.failureTtlMs ?? 0), cause: err };
        logger.warn(`${options.label}: refresh failed, rejecting callers`, {
          err,
        });
        throw err;
      }
      logger.warn(`${options.label}: background poll failed, retaining SWR cache`, {
        err,
      });
      return holder.state;
    } finally {
      holder.inflight = null;
    }
  }

  return {
    get() {
      const now = Date.now();
      if (holder.failure && now < holder.failure.until) return Promise.reject(holder.failure.cause);
      const state = holder.state;
      if (now - state.generatedAt < options.ttlMs && state.generatedAt > 0) {
        return Promise.resolve(state);
      }

      const inflight = ensureInflight();
      if (options.expiryPolicy === "stale-while-revalidate" && state.generatedAt !== 0) {
        return Promise.resolve(state);
      }
      return inflight;
    },

    peek() {
      return holder.state;
    },

    refreshNow() {
      return ensureInflight();
    },
  };
}
