import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

/** A small effect cache shared only by the callers that own one request. */
export interface RequestScopedEffectCache {
  readonly get: <A, E>(
    key: string,
    load: () => Effect.Effect<A, E>,
    shouldCache?: (value: A) => boolean,
  ) => Effect.Effect<A, E>;
}

/**
 * Creates one bounded, single-flight cache for a request. Effect Cache owns
 * expiry and concurrent lookups; the per-instance loader table only connects
 * a stable string key to its typed effect.
 */
export function makeRequestScopedEffectCache(options?: {
  readonly capacity?: number;
  readonly timeToLiveMs?: number;
}): Effect.Effect<RequestScopedEffectCache> {
  return Effect.gen(function* () {
    const loaders = new Map<string, () => Effect.Effect<unknown, unknown>>();
    const cachePolicies = new Map<string, (value: unknown) => boolean>();
    const cache = yield* Cache.makeWith<string, unknown, unknown, never>(
      (key) => {
        const load = loaders.get(key);
        return load ? Effect.suspend(load) : Effect.die(new Error("Missing request cache loader"));
      },
      {
        capacity: options?.capacity ?? 256,
        timeToLive: (exit, key) => {
          if (!Exit.isSuccess(exit)) return Duration.zero;
          const shouldCache = cachePolicies.get(key);
          return shouldCache && !shouldCache(exit.value)
            ? Duration.zero
            : Duration.millis(options?.timeToLiveMs ?? 10_000);
        },
      },
    );

    return {
      get: <A, E>(
        key: string,
        load: () => Effect.Effect<A, E>,
        shouldCache: (value: A) => boolean = () => true,
      ): Effect.Effect<A, E> =>
        Effect.sync(() => {
          loaders.set(key, load as () => Effect.Effect<unknown, unknown>);
          cachePolicies.set(key, shouldCache as (value: unknown) => boolean);
        }).pipe(Effect.flatMap(() => Cache.get(cache, key))) as Effect.Effect<A, E>,
    };
  });
}
