import { describe, expect, it } from "vitest";
import { Context, Effect, Layer } from "effect";
import { memoizedLayerContext } from "~/services/memoizedLayerContext";

/**
 * Canonical home for the generic per-agency layer-context memo:
 * successful builds are memoized per key once resolved, concurrent first
 * callers do not share an in-flight build across request contexts, rejected
 * builds are retried, and keys stay isolated. Composition-specific sharing
 * (one store for both Surface Transit tags) lives in
 * tests/unit/surface-transit-context.test.ts.
 */

class Probe extends Context.Service<Probe, { readonly id: number }>()("test/MemoProbe") {}

describe("memoizedLayerContext", () => {
  it("memoizes a successful build so repeat callers share one context", async () => {
    let builds = 0;
    const getContext = memoizedLayerContext(() => {
      builds += 1;
      return Layer.succeed(Probe, Probe.of({ id: builds }));
    });

    const first = await getContext("ttc");
    const second = await getContext("ttc");

    expect(builds).toBe(1);
    expect(second).toBe(first);
    expect(Context.get(second, Probe).id).toBe(1);
  });

  it("does not share an in-flight build across concurrent first callers", async () => {
    let builds = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const getContext = memoizedLayerContext(() => {
      builds += 1;
      return Layer.effect(
        Probe,
        Effect.as(
          Effect.promise(() => gate),
          Probe.of({ id: builds }),
        ),
      );
    });

    const pending = [getContext("ttc"), getContext("ttc"), getContext("ttc")];
    release();
    const [a, b, c] = await Promise.all(pending);

    expect(builds).toBe(3);
    expect(new Set([a, b, c]).size).toBe(3);

    const cached = await getContext("ttc");
    expect(builds).toBe(3);
    expect([a, b, c]).toContain(cached);
  });

  it("evicts a rejected build so the next caller retries", async () => {
    let builds = 0;
    const getContext = memoizedLayerContext(() => {
      builds += 1;
      return builds === 1
        ? Layer.effect(Probe, Effect.fail(new Error("boom")))
        : Layer.succeed(Probe, Probe.of({ id: builds }));
    });

    await expect(getContext("ttc")).rejects.toThrow("boom");
    const recovered = await getContext("ttc");

    expect(builds).toBe(2);
    expect(Context.get(recovered, Probe).id).toBe(2);
  });

  it("isolates builds across agency keys", async () => {
    const seen: string[] = [];
    const getContext = memoizedLayerContext((agencyId: string) => {
      seen.push(agencyId);
      return Layer.succeed(Probe, Probe.of({ id: seen.length }));
    });

    const ttc = await getContext("ttc");
    const go = await getContext("go");

    expect(ttc).not.toBe(go);
    expect(Context.get(ttc, Probe).id).toBe(1);
    expect(Context.get(go, Probe).id).toBe(2);
    expect(seen).toEqual(["ttc", "go"]);
  });
});
