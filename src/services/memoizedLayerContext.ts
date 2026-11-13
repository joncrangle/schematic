import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// ---------------------------------------------------------------------------
// Per-agency singleton Effect contexts. Each resolved agency gets ONE
// layer context per process, memoized by agencyId, the agency-scoped
// generalization of the previous single-context cache. The resolved context
// is cached, but an in-flight build is deliberately not shared: a promise
// created while serving one Cloudflare Worker request must not be resumed by
// another request context.
//
// Unlike createCachedEffectContext this carries no registerContextClear test
// hook: these caches are process-wide singletons keyed by agencyId and are
// never cleared in production; tests inject their own getters instead.
// ---------------------------------------------------------------------------

/**
 * One memoized resolved context per agency. Concurrent first callers may build
 * independently; this avoids sharing a request-bound promise across Worker
 * requests. A failed build is never memoized, so the next caller retries.
 */
export function memoizedLayerContext<S, E>(
  buildLayer: (agencyId: string) => Layer.Layer<S, E>,
): (agencyId: string) => Promise<Context.Context<S>> {
  const contextsByAgency = new Map<string, Context.Context<S>>();
  return async (agencyId) => {
    const existing = contextsByAgency.get(agencyId);
    if (existing) return existing;
    const context = await Effect.runPromise(Effect.scoped(Layer.build(buildLayer(agencyId))));
    contextsByAgency.set(agencyId, context);
    return context;
  };
}
