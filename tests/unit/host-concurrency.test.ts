import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createHostConcurrencyLimiter } from "~/infrastructure/http/hostConcurrency";
import {
  fetchDecodedFeeds,
  type DecodedFeedRequest,
} from "~/infrastructure/realtime/fetchDecodedFeeds";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("host concurrency limiter", () => {
  it("bounds concurrent tasks per host without delaying other hosts", async () => {
    const limiter = createHostConcurrencyLimiter(2);
    const gate = deferred();
    const started: string[] = [];
    const task = (host: string, label: string) =>
      limiter.run(`https://${host}/feed?id=${label}`, async () => {
        started.push(label);
        await gate.promise;
      });

    const runs = [
      task("boards.example.test", "a"),
      task("boards.example.test", "b"),
      task("boards.example.test", "c"),
      task("other.example.test", "x"),
    ];
    await flush();
    expect(started).toEqual(["a", "b", "x"]);

    gate.resolve();
    await Promise.all(runs);
    expect(started).toEqual(["a", "b", "x", "c"]);
  });

  it("admits waiting tasks in arrival order as slots free", async () => {
    const limiter = createHostConcurrencyLimiter(1);
    const gates = Array.from({ length: 3 }, deferred);
    const started: string[] = [];
    const runs = ["a", "b", "c"].map((label, index) =>
      limiter.run("https://boards.example.test/feed", async () => {
        started.push(label);
        await gates[index]!.promise;
      }),
    );
    await flush();
    expect(started).toEqual(["a"]);

    gates[0]!.resolve();
    await flush();
    expect(started).toEqual(["a", "b"]);

    gates[1]!.resolve();
    gates[2]!.resolve();
    await Promise.all(runs);
    expect(started).toEqual(["a", "b", "c"]);
  });

  it("releases a slot when its task rejects", async () => {
    const limiter = createHostConcurrencyLimiter(1);
    await expect(
      limiter.run("https://boards.example.test/a", () => Promise.reject(new Error("upstream"))),
    ).rejects.toThrow("upstream");
    await expect(limiter.run("https://boards.example.test/b", async () => "next")).resolves.toBe(
      "next",
    );
  });

  it("rejects a limit that could never admit a request", () => {
    expect(() => createHostConcurrencyLimiter(0)).toThrow(RangeError);
    expect(() => createHostConcurrencyLimiter(1.5)).toThrow(RangeError);
  });
});

describe("fetchDecodedFeeds host slots", () => {
  const feed = (url: string): DecodedFeedRequest<string, string> => ({
    url,
    format: "json",
    decode: (body) => Effect.succeed(new TextDecoder().decode(body)),
    mapError: (cause) => (cause instanceof Error ? cause.message : String(cause)),
  });

  it("starts each timeout only after the request holds its host slot", async () => {
    const slowFetch = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response("ok");
    }) as unknown as typeof fetch;
    const ids = Array.from({ length: 12 }, (_, index) => index);

    const result = await Effect.runPromise(
      fetchDecodedFeeds(
        ids.map((id) => feed(`https://boards.example.test/alerts?id=${id}`)),
        { fetch: slowFetch, timeoutMs: 200, hostLimiter: createHostConcurrencyLimiter(1) },
      ),
    );

    // Serialized, the last request queues past 200ms yet has its own full timeout.
    expect(result.firstError).toBeUndefined();
    expect(result.usable).toHaveLength(ids.length);
  });
});
