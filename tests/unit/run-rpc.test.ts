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

  const failWith = async (failure: unknown) => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const ctx = await makeCtx("failing");
    await expect(
      runRpc(
        { label: "probe", agencyId: "sample", getContext: () => Promise.resolve(ctx) },
        () => Effect.fail(failure) as unknown as Effect.Effect<never>,
      ),
    ).rejects.toBe(failure);
    return errorSpy.mock.calls[0]?.[1] as { error: string; cause?: string; agencyId: string };
  };

  it("logs a failed call with its agency and cause chain", async () => {
    const failure = new Error("outer", {
      cause: new TypeError("middle", { cause: new RangeError("inner") }),
    });

    expect(await failWith(failure)).toEqual({
      agencyId: "sample",
      error: "Error: outer",
      cause: "TypeError: middle <- RangeError: inner",
    });
  });

  it.each([
    "https://user:SECRET@feed.test/a?signature=SECRET",
    'https://feed.test/?key="SECRET"',
    "wss://feed.test/SECRET?token=SECRET",
    "ftp://user:SECRET@feed.test/SECRET",
    "feed.test/v1/SECRET/gtfs",
    "/gtfs?sig=SECRET",
    "/gtfs?a=1&sig=SECRET",
    "Ocp-Apim-Subscription-Key: SECRET",
    '{"x-feed-token":"SECRET"}',
    "https%3A%2F%2Ffeed.test%2F%3Fkey%3DSECRET",
    "Authorization: Bearer SECRET",
    "Authorization: Token SECRET",
    "bearer SECRET",
    "key: SECRET",
    "access_token: SECRET",
    '{"token":"SECRET"}',
    "api-key=SECRET",
  ])("keeps credentials out of the log for %s", async (message) => {
    const logged = await failWith(new Error(`failed ${message}`, { cause: message }));

    expect(JSON.stringify(logged)).not.toContain("SECRET");
  });

  it("removes opaque tokens and invalid failure names", async () => {
    const token = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4";
    const failure = Object.assign(new Error(`rejected ${token}`), { name: "key: SECRET" });

    expect((await failWith(failure)).error).toBe("rejected [redacted]");
  });

  it.each([
    ["HTTP 503 fetching https://api.feed.test/gtfs/rt", "HTTP 503 fetching https://api.feed.test"],
    [
      "UNIQUE constraint failed: feed_cache.key: SQLITE_CONSTRAINT",
      "UNIQUE constraint failed: feed_cache.key: SQLITE_CONSTRAINT",
    ],
    ["HTTP 401: authorization failed upstream", "HTTP 401: authorization failed upstream"],
    ["Missing secret: FEED_SAMPLE_KEY", "Missing secret: FEED_SAMPLE_KEY"],
  ])("keeps diagnostic text in %s", async (message, expected) => {
    expect((await failWith(new Error(message))).error).toBe(`Error: ${expected}`);
  });

  it("limits a logged agency id", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const failure = new Error("failed");

    await expect(
      runRpc(
        { label: "probe", agencyId: "a".repeat(100), getContext: () => Promise.reject(failure) },
        () => Effect.succeed(null),
      ),
    ).rejects.toBe(failure);

    expect((errorSpy.mock.calls[0]?.[1] as { agencyId: string }).agencyId).toHaveLength(64);
  });

  it.each([
    ["a tagged failure", { _tag: "FeedFailure", status: 503 }, "FeedFailure: status 503"],
    ["a plain object", { status: 500 }, "status 500"],
    ["a string", "offline", "offline"],
    ["an object with nothing printable", Object.create(null), "Unprintable failure"],
    [
      "an object whose fields throw",
      {
        get message(): string {
          throw new Error("unreadable");
        },
      },
      "Unprintable failure",
    ],
  ])("describes %s and still rejects with it", async (_name, failure, error) => {
    expect((await failWith(failure)).error).toBe(error);
  });

  it.each([
    ["repeated query markers", "?".repeat(5_000)],
    ["repeated separators", "&a".repeat(2_500)],
    ["repeated host labels", "a.".repeat(2_500)],
    ["repeated scheme characters", "a+".repeat(2_500)],
    ["repeated token characters", "a/".repeat(2_500)],
    ["repeated credential prefixes", "key-".repeat(1_250)],
  ])("redacts %s without stalling the failed request", async (_name, message) => {
    const startedAt = performance.now();

    await failWith(new Error(message, { cause: new Error(message) }));

    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  it("limits logged failure text", async () => {
    expect((await failWith(new Error("x".repeat(1_000)))).error).toHaveLength(300);
  });

  it("logs when the context cannot be built", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const failure = new Error("binding unavailable");

    await expect(
      runRpc({ label: "probe", getContext: () => Promise.reject(failure) }, () =>
        Effect.succeed(null),
      ),
    ).rejects.toBe(failure);

    expect(errorSpy).toHaveBeenCalledWith("probe: RPC failed", {
      error: "Error: binding unavailable",
    });
  });
});
