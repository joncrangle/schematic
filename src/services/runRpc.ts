import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { logger } from "~/infrastructure/logging/logger";

/**
 * Shared runtime for the RPC delegate ceremony: fetch the singleton
 * Effect context, provide it to the caller's program, and time the invocation
 * under the given label. Failures are never caught on behalf of the client
 *, a downstream failure rejects so TanStack Query surfaces real
 * errors. `getContext` stays injectable so the existing test seam survives.
 */
export async function runRpc<S, E, T>(
  options: {
    readonly label: string;
    readonly getContext: () => Promise<Context.Context<S>>;
  },
  program: (ctx: Context.Context<S>) => Effect.Effect<T, E, S>,
): Promise<T> {
  const start = Date.now();
  logger.debug(`${options.label}: RPC invocation received`);

  const ctx = await options.getContext();
  const result = await Effect.runPromise(program(ctx).pipe(Effect.provideContext(ctx)));
  logger.debug(`${options.label}: RPC completed`, {
    durationMs: Date.now() - start,
  });
  return result;
}
