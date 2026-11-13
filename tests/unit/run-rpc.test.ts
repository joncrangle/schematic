import { afterEach, describe, expect, it, vi } from "vitest";
import { Context, Effect, Layer } from "effect";
import { runRpc } from "~/services/runRpc";
import { logger } from "~/infrastructure/logging/logger";

/**
 * Canonical home for the shared RPC runtime contract: fetch the
 * singleton context once, provide it to the caller's program, time the
 * invocation under the given label, and never catch on behalf of the client
 * — downstream failures reject.
 */

class Probe extends Context.Service<Probe, { readonly marker: string }>()("test/RpcProbe") {}

const makeCtx = async (marker: string): Promise<Context.Context<Probe>> =>
  Effect.runPromise(Effect.scoped(Layer.build(Layer.succeed(Probe, Probe.of({ marker })))));

describe("runRpc helper contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches the context once and hands that exact context to the program", async () => {
    const ctx = await makeCtx("singleton");
    const getContext = vi.fn(() => Promise.resolve(ctx));

    const observed = await runRpc<Probe, never, Context.Context<Probe>>(
      { label: "probe", getContext },
      (received) => Effect.succeed(received),
    );

    expect(observed).toBe(ctx);
    expect(getContext).toHaveBeenCalledTimes(1);
  });

  it("provides the context so a service-tag-requiring program runs without wiring", async () => {
    const ctx = await makeCtx("provided");

    const marker = await runRpc({ label: "probe", getContext: () => Promise.resolve(ctx) }, () =>
      Effect.gen(function* () {
        const probe = yield* Probe;
        return probe.marker;
      }),
    );

    expect(marker).toBe("provided");
  });

  it("records elapsed time on the completion diagnostic", async () => {
    const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(1_042);
    const ctx = await makeCtx("timed");

    await runRpc({ label: "probe", getContext: () => Promise.resolve(ctx) }, () =>
      Effect.succeed(null),
    );

    expect(
      debugSpy.mock.calls.some(
        (call) => (call[1] as { durationMs?: number } | undefined)?.durationMs === 42,
      ),
    ).toBe(true);
  });

  it("propagates program failure to the caller instead of catching", async () => {
    const boom = new Error("downstream exploded");
    const ctx = await makeCtx("failing");

    await expect(
      runRpc(
        { label: "probe", getContext: () => Promise.resolve(ctx) },
        () => Effect.fail(boom) as unknown as Effect.Effect<never>,
      ),
    ).rejects.toBe(boom);
  });
});
