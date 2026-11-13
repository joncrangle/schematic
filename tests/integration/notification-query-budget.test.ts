import { describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import type { AgencySnapshot } from "~/agencies/types";
import type { PushSubscriptionRecord } from "~/domain/notifications/types";
import { createInvocationBudget } from "~/infrastructure/http/InvocationIo";
import { createMockVapidClient } from "~/infrastructure/notifications/VapidClient";
import type { SendPushResult } from "~/infrastructure/notifications/VapidClient";
import {
  SubscriptionRepository,
  makeD1SubscriptionRepositoryService,
} from "~/infrastructure/storage/SubscriptionRepository";
import {
  AlertEvaluatorService,
  createLiveAlertEvaluatorService,
} from "~/services/notifications/AlertEvaluatorService";
import { createMemoryD1 } from "../helpers/memoryD1";

const now = Date.parse("2026-10-09T12:00:00Z");
const snapshot: AgencySnapshot = {
  agencyId: "fictional",
  generatedAt: now,
  freshness: "live",
  alerts: [
    {
      id: "incident",
      title: "Line A suspended",
      kind: "suspension",
      severity: "severe",
      lifecycle: "active",
      scope: "line",
      affectedLineIds: ["A"],
      startsAt: now,
      updatedAt: now,
    },
  ],
};
const subscriber = (id: string): PushSubscriptionRecord => ({
  id,
  endpoint: `https://example.test/${id}`,
  p256dh: "fictional",
  auth: "fictional",
  timezone: "UTC",
  favouriteLines: [{ agencyId: "fictional", lineId: "A" }],
  favouriteStations: [],
  favouriteSurfaceRoutes: [],
  commuteSchedules: [
    {
      id: "all-day",
      label: "All day",
      enabled: true,
      days: [0, 1, 2, 3, 4, 5, 6],
      start: "00:00",
      end: "23:59",
    },
  ],
  // Stored at real time so retention pruning never drops the fixture.
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

async function fixture(
  ids: readonly string[],
  send = vi.fn<() => Promise<SendPushResult>>(async () => ({
    success: true,
    expired: false,
    statusCode: 201,
  })),
) {
  const db = await createMemoryD1();
  let queries = 0;
  const prepare = db.prepare;
  const underlying = new WeakMap<ReturnType<typeof prepare>, ReturnType<typeof prepare>>();
  db.prepare = (sql) => {
    let statement = prepare(sql);
    const recorded: ReturnType<typeof prepare> = {
      bind: (...values) => {
        statement = statement.bind(...values);
        return recorded;
      },
      first: (column) => {
        queries++;
        return statement.first(column);
      },
      all: () => {
        queries++;
        return statement.all();
      },
      run: () => {
        queries++;
        return statement.run();
      },
    };
    underlying.set(recorded, statement);
    return recorded;
  };
  const batch = db.batch;
  db.batch = (statements) => {
    queries += statements.length;
    return batch(statements.map((statement) => underlying.get(statement) ?? statement));
  };
  const exec = db.exec;
  db.exec = (sql) => {
    queries += sql.split(";").filter((part) => part.trim()).length;
    return exec(sql);
  };
  const repository = makeD1SubscriptionRepositoryService(db, { fallbackTimezone: "UTC" });
  const subscriptions = ids.map(subscriber);
  for (const sub of subscriptions) await Effect.runPromise(repository.upsertSubscription(sub));
  const layer = createLiveAlertEvaluatorService().pipe(
    Layer.provide(
      Layer.merge(Layer.succeed(SubscriptionRepository, repository), createMockVapidClient(send)),
    ),
  );
  const evaluator = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* AlertEvaluatorService;
    }).pipe(Effect.provide(layer)),
  );
  return {
    db,
    repository,
    subscriptions,
    evaluator,
    send,
    count: () => queries,
    reset: () => {
      queries = 0;
    },
    bounded: (limit: number) => {
      const queryBudget = createInvocationBudget(limit);
      return {
        queryBudget,
        repository: makeD1SubscriptionRepositoryService(db, {
          fallbackTimezone: "UTC",
          queryBudget,
        }),
      };
    },
  };
}

describe("notification invocation query budget", () => {
  it("refuses a push before transport when its outcome cannot be reserved", async () => {
    const f = await fixture(["one"]);
    const bounded = f.bounded(4);
    const result = await Effect.runPromiseExit(
      f.evaluator.evaluateAndDispatch(snapshot, now, {
        subscriptions: f.subscriptions,
        repository: bounded.repository,
      }),
    );
    expect(result._tag).toBe("Failure");
    expect(f.send).not.toHaveBeenCalled();
    expect(bounded.queryBudget.remaining).toBe(2);
    expect(
      await Effect.runPromise(f.repository.getDelivery("fictional", "incident", "one")),
    ).toBeNull();
  });

  it("counts cold bootstrap and refuses the first query beyond capacity", async () => {
    const f = await fixture([]);
    // Marker read, 17 schema statements, column inspection, delivery backfill,
    // two delivery triggers, terminal index, and version marker; the prune
    // batch is the first query over budget.
    const bounded = f.bounded(24);
    expect((await Effect.runPromiseExit(bounded.repository.getActiveSubscriptions()))._tag).toBe(
      "Failure",
    );
    expect(f.count()).toBe(24);
    expect(bounded.queryBudget.remaining).toBe(0);
    const retry = f.bounded(1);
    await Effect.runPromise(retry.repository.getDelivery("fictional", "none", "none"));
    expect(f.count()).toBe(25);
  });

  it("reads one marker on a warm database in a cold isolate and skips the bootstrap", async () => {
    const f = await fixture([]);
    await Effect.runPromise(f.repository.getActiveSubscriptions());
    f.reset();
    // A fresh binding wrapper stands in for a new isolate: no in-memory state
    // is shared, but the database already holds the version and prune marker.
    const isolate: typeof f.db = { prepare: f.db.prepare, exec: f.db.exec, batch: f.db.batch };
    const queryBudget = createInvocationBudget(2);
    const coldRepository = makeD1SubscriptionRepositoryService(isolate, {
      fallbackTimezone: "UTC",
      queryBudget,
    });
    await Effect.runPromise(coldRepository.getActiveSubscriptions());
    // Version marker read plus the subscriber read; no bootstrap or prune.
    expect(f.count()).toBe(2);
    expect(queryBudget.remaining).toBe(0);
  });

  it("charges daily subscription, tombstone, claim, and terminal-history cleanup to the budget", async () => {
    const f = await fixture([]);
    await Effect.runPromise(f.repository.getDelivery("fictional", "none", "none"));
    f.reset();

    // Seven deletes plus the prune marker are refused as a unit.
    const refused = f.bounded(7);
    expect((await Effect.runPromiseExit(refused.repository.getActiveSubscriptions()))._tag).toBe(
      "Failure",
    );
    expect(f.count()).toBe(0);

    const cleanup = f.bounded(8);
    expect((await Effect.runPromiseExit(cleanup.repository.getActiveSubscriptions()))._tag).toBe(
      "Failure",
    );
    expect(f.count()).toBe(8);
    expect(cleanup.queryBudget.remaining).toBe(0);

    const nextRead = f.bounded(1);
    expect((await Effect.runPromiseExit(nextRead.repository.getActiveSubscriptions()))._tag).toBe(
      "Success",
    );
    expect(f.count()).toBe(9);
    expect(nextRead.queryBudget.remaining).toBe(0);
  });

  it("batches a warmed 49-recipient empty cycle including both preflight reads", async () => {
    const f = await fixture(Array.from({ length: 49 }, (_, index) => `sub-${index}`));
    await Effect.runPromise(f.repository.getActiveSubscriptions());
    f.reset();
    const bounded = f.bounded(50);
    const subscriptions = await Effect.runPromise(bounded.repository.getActiveSubscriptions());
    await Effect.runPromise(bounded.repository.getOutstandingDeliveryTargets());
    const result = await Effect.runPromiseExit(
      f.evaluator.evaluateAndDispatch({ ...snapshot, alerts: [] }, now, {
        subscriptions,
        repository: bounded.repository,
        outstandingSubscriptionIds: [],
      }),
    );
    expect(result._tag).toBe("Success");
    expect(f.count()).toBe(3);
    expect(f.send).not.toHaveBeenCalled();
    expect(snapshot.freshness).toBe("live");
  });

  it("persists an accepted push after ordinary query capacity is exhausted", async () => {
    const send = vi.fn<() => Promise<SendPushResult>>();
    const f = await fixture(["one"], send);
    f.reset();
    const bounded = f.bounded(8);
    send.mockImplementation(async () => {
      await Effect.runPromise(bounded.repository.getOutstandingDeliveryTargets());
      expect(bounded.queryBudget.remaining).toBe(0);
      return { success: true, expired: false, statusCode: 201 };
    });
    const summary = await Effect.runPromise(
      f.evaluator.evaluateAndDispatch(snapshot, now, {
        subscriptions: f.subscriptions,
        repository: bounded.repository,
      }),
    );
    expect(summary.activePushesSent).toBe(1);
    expect(f.count()).toBe(7);
    expect(bounded.queryBudget.remaining).toBe(1);
    expect(
      (await Effect.runPromise(f.repository.getDelivery("fictional", "incident", "one")))?.status,
    ).toBe("active_sent");
  });

  it("keeps endpoint expiry pruning atomic and returns unused mutation capacity", async () => {
    const f = await fixture(
      ["expired"],
      vi.fn(async () => ({ success: false, expired: true, statusCode: 410 })),
    );
    f.reset();
    const bounded = f.bounded(7);
    const summary = await Effect.runPromise(
      f.evaluator.evaluateAndDispatch(snapshot, now, {
        subscriptions: f.subscriptions,
        repository: bounded.repository,
      }),
    );
    expect(summary.expiredSubscriptionsPruned).toBe(1);
    expect(f.count()).toBe(5);
    expect(bounded.queryBudget.remaining).toBe(2);
    expect(await Effect.runPromise(f.repository.getActiveSubscriptions())).toEqual([]);
    await Effect.runPromise(f.repository.upsertSubscription(f.subscriptions[0]!));
    expect(await Effect.runPromise(f.repository.getActiveSubscriptions())).toEqual([]);
  });

  it("releases failed attempt reservations and retries with a fresh rotated invocation", async () => {
    const f = await fixture(
      ["one", "two"],
      vi.fn(async () => ({ success: false, expired: false, statusCode: 503 })),
    );
    const first = f.bounded(10);
    expect(
      (
        await Effect.runPromiseExit(
          f.evaluator.evaluateAndDispatch(snapshot, now, {
            subscriptions: f.subscriptions,
            repository: first.repository,
          }),
        )
      )._tag,
    ).toBe("Success");
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(first.queryBudget.remaining).toBe(2);
    expect(
      await Effect.runPromise(f.repository.getDelivery("fictional", "incident", "one")),
    ).toBeNull();
    f.send.mockResolvedValue({ success: true, expired: false, statusCode: 201 });
    const next = f.bounded(7);
    expect(
      (
        await Effect.runPromiseExit(
          f.evaluator.evaluateAndDispatch(snapshot, now + 120_000, {
            subscriptions: f.subscriptions,
            repository: next.repository,
            recipientOffset: 1,
          }),
        )
      )._tag,
    ).toBe("Failure");
    expect(
      (await Effect.runPromise(f.repository.getDelivery("fictional", "incident", "two")))?.status,
    ).toBe("active_sent");
    const complete = f.bounded(7);
    const summary = await Effect.runPromise(
      f.evaluator.evaluateAndDispatch(snapshot, now + 120_000, {
        subscriptions: f.subscriptions,
        repository: complete.repository,
      }),
    );
    expect(summary.activePushesSent).toBe(1);
    expect(f.send).toHaveBeenCalledTimes(4);
  });

  it("reserves enough capacity to tombstone a subscription on its fifth hard rejection", async () => {
    const send = vi.fn(async () => ({ success: false, expired: false, statusCode: 400 }));
    const f = await fixture(["hard-failure"], send);
    for (const minutes of [0, 2, 6, 14]) {
      await Effect.runPromise(f.evaluator.evaluateAndDispatch(snapshot, now + minutes * 60_000));
    }
    f.reset();
    const bounded = f.bounded(7);
    const summary = await Effect.runPromise(
      f.evaluator.evaluateAndDispatch(snapshot, now + 30 * 60_000, {
        subscriptions: f.subscriptions,
        repository: bounded.repository,
      }),
    );

    expect(send).toHaveBeenCalledTimes(5);
    expect(summary.rejectedSubscriptionsPruned).toBe(1);
    expect(f.count()).toBe(7);
    expect(bounded.queryBudget.remaining).toBe(0);
    expect(await Effect.runPromise(f.repository.getActiveSubscriptions())).toEqual([]);
    await Effect.runPromise(f.repository.upsertSubscription(f.subscriptions[0]!));
    expect(await Effect.runPromise(f.repository.getActiveSubscriptions())).toEqual([]);
  });

  it.each(["silent", "push"] as const)(
    "counts %s recovery reads and writes without losing deferred incidents",
    async (mode) => {
      const f = await fixture(["one"]);
      const delivery = {
        id: "previous",
        agencyId: "fictional",
        alertId: "incident",
        incidentKey: "previous-key",
        subscriptionId: "one",
        status: "active_sent" as const,
        deliveredAt: 123,
        lineId: undefined,
        routeId: undefined,
        locale: "en-CA" as const,
      };
      await Effect.runPromise(f.repository.recordDelivery(delivery));
      const subscriptions =
        mode === "silent"
          ? f.subscriptions.map((sub) => ({ ...sub, commuteSchedules: [] }))
          : f.subscriptions;
      const unavailable = f.bounded(mode === "silent" ? 2 : 3);
      expect(
        (
          await Effect.runPromiseExit(
            f.evaluator.evaluateAndDispatch({ ...snapshot, alerts: [] }, now, {
              subscriptions,
              repository: unavailable.repository,
            }),
          )
        )._tag,
      ).toBe("Failure");
      expect(f.send).not.toHaveBeenCalled();
      expect(
        await Effect.runPromise(f.repository.getDelivery("fictional", "incident", "one")),
      ).toEqual(delivery);
      f.reset();
      const retry = f.bounded(mode === "silent" ? 3 : 7);
      await Effect.runPromise(
        f.evaluator.evaluateAndDispatch({ ...snapshot, alerts: [] }, now, {
          subscriptions,
          repository: retry.repository,
        }),
      );
      expect(f.count()).toBe(mode === "silent" ? 3 : 6);
      const cleared = await Effect.runPromise(
        f.repository.getDelivery("fictional", "incident", "one"),
      );
      expect(cleared?.status).toBe(mode === "silent" ? "cleared_silent" : "cleared_sent");
      expect(cleared?.deliveredAt).toBe(mode === "silent" ? 123 : now);
      expect(f.send).toHaveBeenCalledTimes(mode === "silent" ? 0 : 1);
    },
  );
});
