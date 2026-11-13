import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { createInvocationBudget } from "~/infrastructure/http/InvocationIo";
import {
  accountRequestQueries,
  runWithRequestQueryBudget,
} from "~/infrastructure/storage/requestQueryBudget";
import type { D1DatabaseBinding } from "~/infrastructure/storage/RuntimeBindings";

const rawBinding = (): D1DatabaseBinding => ({
  prepare: () => ({
    bind() {
      return this;
    },
    first: async () => null,
    all: async () => ({ results: [], success: true }),
    run: async () => ({ success: true }),
  }),
  exec: async () => undefined,
  batch: async () => [],
});

describe("request query budget", () => {
  it("charges queries issued from Effect fibers after timer and yield hops", async () => {
    const db = accountRequestQueries(rawBinding());
    const budget = createInvocationBudget(3);

    const outcome = await runWithRequestQueryBudget(
      () =>
        Effect.runPromise(
          Effect.gen(function* () {
            yield* Effect.promise(() => db.prepare("SELECT 1").first());
            yield* Effect.sleep("1 millis");
            yield* Effect.promise(() => db.prepare("SELECT 1").all());
            yield* Effect.yieldNow;
            yield* Effect.promise(() => db.batch([db.prepare("SELECT 1")]));
            return yield* Effect.tryPromise(() => db.prepare("SELECT 1").first());
          }).pipe(Effect.flip),
        ),
      budget,
    );

    expect(budget.remaining).toBe(0);
    expect((outcome as { cause?: { _tag?: string } }).cause?._tag).toBe("InvocationBudgetExceeded");
  });

  it("leaves queries outside a request uncharged", async () => {
    const db = accountRequestQueries(rawBinding());

    await expect(db.prepare("SELECT 1").first()).resolves.toBeNull();
  });
});
