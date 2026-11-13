import { describe, expect, it, vi } from "vitest";
import { logger } from "~/infrastructure/logging/logger";
import { Effect } from "effect";
import {
  SubscriptionRepository,
  createD1SubscriptionRepository,
  makeD1SubscriptionRepositoryService,
} from "~/infrastructure/storage/SubscriptionRepository";
import {
  ENSURE_SUBSCRIPTION_SCHEMA_SQL,
  SUBSCRIPTION_SCHEMA_VERSION,
} from "~/infrastructure/storage/subscriptionSchema";
import type {
  D1DatabaseBinding,
  D1PreparedStatement,
} from "~/infrastructure/storage/RuntimeBindings";
import type { PushSubscriptionRecord } from "~/domain/notifications/types";

/**
 * Phase 1 folded the eager schema-bootstrap resolver step into
 * the SQL adapter itself. These cases pin the resulting contract: the CREATE
 * TABLE bootstrap fires lazily on the FIRST operation, BEFORE that operation's
 * user SQL reaches the binding, and exactly once per binding identity.
 */

/** Hand-rolled binding that records how statements reach the database. */
function recordingMockDb(meta: { schema_version: number; pruned_at: number } | null = null): {
  db: D1DatabaseBinding;
  events: string[];
} {
  const events: string[] = [];
  // The repository's SQL is template literals with leading newlines and
  // indentation — flatten it so recorded events are readable assertions.
  const flatten = (sql: string) => sql.replace(/\s+/g, " ").trim();
  const db: D1DatabaseBinding = {
    prepare: (query: string) => {
      let boundValues: unknown[] = [];
      const stmt = {
        bind: (...values: unknown[]) => {
          boundValues = values;
          return stmt;
        },
        first: async <T>() => {
          events.push(`first:${flatten(query)} ${JSON.stringify(boundValues)}`);
          return (query.startsWith("SELECT schema_version") ? meta : null) as T;
        },
        all: async <T>() => {
          events.push(`all:${flatten(query)}`);
          return {
            results: (query.includes("pragma_table_info")
              ? [{ table_name: "push_subscriptions", name: "policy_revision" }]
              : []) as T[],
            success: true,
          };
        },
        run: async () => {
          events.push(`run:${flatten(query)}`);
          return { success: true };
        },
      };
      return Object.assign(stmt, { query: flatten(query) });
    },
    exec: async (sql: string) => {
      events.push(sql === ENSURE_SUBSCRIPTION_SCHEMA_SQL ? "exec:SCHEMA" : `exec:${sql}`);
    },
    batch: async (statements) => {
      events.push(
        `batch:${statements.map((s) => (s as unknown as { query: string }).query).join(" | ")}`,
      );
      return {};
    },
  };
  return { db, events };
}

function makeRecord(): PushSubscriptionRecord {
  return {
    id: "sub-lazy-schema",
    endpoint: "https://push.example.com/sub/1",
    p256dh: "p256dh-key",
    auth: "auth-key",
    favouriteLines: [{ agencyId: "ttc", lineId: "1" }],
    favouriteStations: [],
    favouriteSurfaceRoutes: [],
    commuteSchedules: [],
    timezone: "America/Toronto",
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  };
}

describe("createD1SubscriptionRepository lazy schema bootstrap", () => {
  it("reads outstanding deliveries for a recipient batch in one agency-scoped query", async () => {
    const { db, events } = recordingMockDb();
    const repository = makeD1SubscriptionRepositoryService(db, {
      fallbackTimezone: "America/Toronto",
    });

    const deliveries = await Effect.runPromise(
      repository.getDeliveriesForSubscriptions("fictional-agency", ["sub-one", "sub-two"]),
    );

    expect(deliveries).toEqual([]);
    const historyReads = events.filter(
      (event) => event.startsWith("all:") && event.includes("json_each"),
    );
    expect(historyReads).toHaveLength(1);
    expect(historyReads[0]).toContain("json_each");
    expect(historyReads[0]).toContain("status = 'active_sent'");
  });

  it("executes the schema bootstrap before the first operation's user SQL", async () => {
    const { db, events } = recordingMockDb();

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* SubscriptionRepository;
        return yield* repo.upsertSubscription(makeRecord());
      }).pipe(
        Effect.provide(createD1SubscriptionRepository(db, { fallbackTimezone: "America/Toronto" })),
      ),
    );

    expect(events[0]).toContain("first:SELECT schema_version, pruned_at FROM subscription_meta");
    expect(events[1]).toBe("exec:SCHEMA");
    expect(events.at(-1)).toContain("run:INSERT INTO push_subscriptions");
    expect(events).toContain(
      "exec:ALTER TABLE push_subscriptions ADD COLUMN locale TEXT NOT NULL DEFAULT 'en-CA'",
    );
    expect(events).toContain(
      "exec:ALTER TABLE alert_deliveries ADD COLUMN locale TEXT NOT NULL DEFAULT 'en-CA'",
    );
    expect(events).toContain(
      "exec:ALTER TABLE alert_deliveries ADD COLUMN terminal_at INTEGER NOT NULL DEFAULT 0",
    );
    expect(events).toContain(
      "exec:CREATE INDEX IF NOT EXISTS idx_alert_deliveries_terminal ON alert_deliveries(terminal_at, delivered_at) WHERE status IN ('cleared_sent', 'cleared_silent')",
    );
  });

  it("skips the bootstrap with a single read when the database is at the current schema version", async () => {
    const { db, events } = recordingMockDb({
      schema_version: SUBSCRIPTION_SCHEMA_VERSION,
      pruned_at: Date.now(),
    });
    const repository = makeD1SubscriptionRepositoryService(db, {
      fallbackTimezone: "America/Toronto",
    });

    await Effect.runPromise(repository.getActiveSubscriptions());
    await Effect.runPromise(repository.getActiveSubscriptions());

    expect(events).toHaveLength(3);
    expect(events[0]).toContain("first:SELECT schema_version, pruned_at FROM subscription_meta");
    expect(events.slice(1).every((event) => event.startsWith("all:SELECT subscription.id"))).toBe(
      true,
    );
  });

  it("re-runs the bootstrap and records the version when the database is behind", async () => {
    const { db, events } = recordingMockDb({
      schema_version: SUBSCRIPTION_SCHEMA_VERSION - 1,
      pruned_at: Date.now(),
    });

    await Effect.runPromise(
      makeD1SubscriptionRepositoryService(db, {
        fallbackTimezone: "America/Toronto",
      }).getActiveSubscriptions(),
    );

    expect(events).toContain("exec:SCHEMA");
    const marker = events.findIndex((event) => event.includes("SET schema_version"));
    expect(marker).toBeGreaterThan(events.indexOf("exec:SCHEMA"));
    expect(events[marker]).toContain(`[${SUBSCRIPTION_SCHEMA_VERSION}]`);
  });

  it("does not mistake a database failure for a missing schema", async () => {
    const { db, events } = recordingMockDb();
    const prepare = db.prepare;
    db.prepare = (query) => {
      const stmt = prepare(query);
      if (query.startsWith("SELECT schema_version")) {
        stmt.first = async () => {
          throw new Error("D1 overloaded");
        };
      }
      return stmt;
    };

    const exit = await Effect.runPromiseExit(
      makeD1SubscriptionRepositoryService(db, {
        fallbackTimezone: "America/Toronto",
      }).getActiveSubscriptions(),
    );

    expect(exit._tag).toBe("Failure");
    expect(events).not.toContain("exec:SCHEMA");
  });

  it("prunes at most once a day across isolates by persisting the prune time", async () => {
    const day = 24 * 60 * 60 * 1000;
    const stale = recordingMockDb({
      schema_version: SUBSCRIPTION_SCHEMA_VERSION,
      pruned_at: Date.now() - day - 1000,
    });
    const staleRepository = makeD1SubscriptionRepositoryService(stale.db, {
      fallbackTimezone: "America/Toronto",
    });
    await Effect.runPromise(staleRepository.getActiveSubscriptions());
    await Effect.runPromise(staleRepository.getActiveSubscriptions());

    const batches = stale.events.filter((event) => event.startsWith("batch:"));
    expect(batches).toHaveLength(1);
    expect(batches[0]!.match(/DELETE FROM/g)).toHaveLength(7);
    expect(batches[0]).toContain("UPDATE subscription_meta SET pruned_at = ? WHERE id = 1");

    const recent = recordingMockDb({
      schema_version: SUBSCRIPTION_SCHEMA_VERSION,
      pruned_at: Date.now() - 60_000,
    });
    await Effect.runPromise(
      makeD1SubscriptionRepositoryService(recent.db, {
        fallbackTimezone: "America/Toronto",
      }).getActiveSubscriptions(),
    );
    expect(recent.events.filter((event) => event.startsWith("batch:"))).toEqual([]);
  });

  it("bootstraps exactly once across subsequent operations", async () => {
    const { db, events } = recordingMockDb();
    const layer = createD1SubscriptionRepository(db, { fallbackTimezone: "America/Toronto" });

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* SubscriptionRepository;
        yield* repo.upsertSubscription(makeRecord());
        yield* repo.getActiveSubscriptions();
        yield* repo.getActiveSubscriptions();
      }).pipe(Effect.provide(layer)),
    );

    expect(events.filter((event) => event === "exec:SCHEMA")).toHaveLength(1);
    expect(events.at(-1)).toContain("all:SELECT subscription.id, subscription.endpoint");
  });

  it("shares concurrent and successful bootstrap across adapters of the same binding", async () => {
    const { db, events } = recordingMockDb();
    const first = makeD1SubscriptionRepositoryService(db, { fallbackTimezone: "America/Toronto" });
    const second = makeD1SubscriptionRepositoryService(db, {
      fallbackTimezone: "Europe/Stockholm",
    });
    await Promise.all([
      Effect.runPromise(first.getActiveSubscriptions()),
      Effect.runPromise(second.getActiveSubscriptions()),
    ]);
    await Effect.runPromise(
      makeD1SubscriptionRepositoryService(db, {
        fallbackTimezone: "America/Toronto",
      }).getActiveSubscriptions(),
    );
    expect(events.filter((event) => event === "exec:SCHEMA")).toHaveLength(1);
    expect(events.filter((event) => event.includes("pragma_table_info"))).toHaveLength(1);
  });

  it("retries failed bootstrap on the same binding", async () => {
    const { db, events } = recordingMockDb();
    const exec = db.exec;
    let fail = true;
    db.exec = async (sql) => {
      if (fail) throw new Error("temporary database failure");
      return exec(sql);
    };
    const first = makeD1SubscriptionRepositoryService(db, { fallbackTimezone: "America/Toronto" });
    expect((await Effect.runPromiseExit(first.getActiveSubscriptions()))._tag).toBe("Failure");
    fail = false;
    await Effect.runPromise(
      makeD1SubscriptionRepositoryService(db, {
        fallbackTimezone: "America/Toronto",
      }).getActiveSubscriptions(),
    );
    expect(events.filter((event) => event === "exec:SCHEMA")).toHaveLength(1);
  });

  it("maps an empty stored timezone onto the resolved agency's manifest default", async () => {
    const row = {
      id: "sub-blank-tz",
      endpoint: "https://push.example.com/sub/2",
      auth: "auth-key",
      favourite_lines_json: null,
      favourite_stations_json: null,
      favourite_routes_json: null,
      commute_schedules_json: "[]",
      timezone: "",
      created_at: 1,
      updated_at: 1,
    };
    const rowDb: D1DatabaseBinding = {
      prepare: (_query: string) => {
        const stmt: D1PreparedStatement = {
          bind: () => stmt,
          first: async () => null,
          all: async <T>() => ({ results: [row] as T[], success: true }),
          run: async () => ({ success: true }),
        };
        return stmt;
      },
      exec: async () => {},
      batch: async () => ({}),
    };
    const subscriptions = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* SubscriptionRepository;
        return yield* repo.getActiveSubscriptions();
      }).pipe(
        Effect.provide(
          createD1SubscriptionRepository(rowDb, { fallbackTimezone: "Europe/Stockholm" }),
        ),
      ),
    );

    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0].timezone).toBe("Europe/Stockholm");
    const second = makeD1SubscriptionRepositoryService(rowDb, {
      fallbackTimezone: "America/Vancouver",
    });
    expect((await Effect.runPromise(second.getActiveSubscriptions()))[0]?.timezone).toBe(
      "America/Vancouver",
    );
    expect(subscriptions[0].locale).toBe("en-CA");
  });

  it.each([
    { favourite_lines_json: "not-json" },
    { favourite_routes_json: '["unqualified-route"]' },
    { commute_schedules_json: '[{"enabled":true,"start":"25:00"}]' },
  ])(
    "isolates a malformed stored policy while returning valid subscribers: %j",
    async (invalid) => {
      const row = {
        id: "sub-invalid-json",
        endpoint: "https://push.example.com/sub/invalid",
        p256dh: "p256dh-key",
        auth: "auth-key",
        favourite_lines_json: "[]",
        favourite_stations_json: "[]",
        favourite_routes_json: "[]",
        commute_schedules_json: "[]",
        timezone: "Europe/Stockholm",
        created_at: 1,
        updated_at: 1,
      };
      const validRow = { ...row, id: "valid-device", endpoint: "https://push.example/valid" };
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
      const rowDb: D1DatabaseBinding = {
        prepare: (_query: string) => {
          const stmt: D1PreparedStatement = {
            bind: () => stmt,
            first: async () => null,
            all: async <T>() => ({
              results: [{ ...row, ...invalid }, validRow] as T[],
              success: true,
            }),
            run: async () => ({ success: true }),
          };
          return stmt;
        },
        exec: async () => {},
        batch: async () => ({}),
      };

      try {
        const subscriptions = await Effect.runPromise(
          Effect.gen(function* () {
            const repo = yield* SubscriptionRepository;
            return yield* repo.getActiveSubscriptions();
          }).pipe(
            Effect.provide(
              createD1SubscriptionRepository(rowDb, { fallbackTimezone: "Europe/Stockholm" }),
            ),
          ),
        );
        expect(subscriptions.map((sub) => sub.id)).toEqual(["valid-device"]);
        expect(warn).toHaveBeenCalledWith(
          "SubscriptionRepository: invalid subscription policies skipped",
          { count: 1 },
        );
        expect(JSON.stringify(warn.mock.calls)).not.toContain(row.endpoint);
      } finally {
        warn.mockRestore();
      }
    },
  );
});

/**
 * Wire-format regression guard: local miniflare D1's exec() splits
 * input on newlines, so every statement in the schema bootstrap must live on
 * ONE physical line. node/bun sqlite tolerate multi-line SQL, so only this
 * string-shape assertion can catch a regression to pretty-printed DDL.
 */
describe("ENSURE_SUBSCRIPTION_SCHEMA_SQL wire format", () => {
  it("keeps every statement on a single physical line joined by ';\\n'", () => {
    expect(ENSURE_SUBSCRIPTION_SCHEMA_SQL.trim().length).toBeGreaterThan(0);
    for (const fragment of ENSURE_SUBSCRIPTION_SCHEMA_SQL.split(";\n")) {
      expect(fragment.replace(/\s+$/, "")).not.toContain("\n");
    }
  });
});

describe("outstanding notification agency selection", () => {
  it("reads outstanding targets through a covering partial index instead of cleared history", async () => {
    const { createMemoryD1 } = await import("../helpers/memoryD1");
    const db = await createMemoryD1();
    const prepare = db.prepare;
    let outstandingQuery = "";
    db.prepare = (query) => {
      if (query.includes("SELECT DISTINCT delivery.agency_id")) outstandingQuery = query;
      return prepare(query);
    };
    const repository = makeD1SubscriptionRepositoryService(db, {
      fallbackTimezone: "America/Toronto",
    });
    await Effect.runPromise(repository.getOutstandingDeliveryTargets());
    expect(outstandingQuery).not.toBe("");
    const plan = await db
      .prepare(`EXPLAIN QUERY PLAN ${outstandingQuery}`)
      .all<{ detail: string }>();
    expect(plan.results?.map((row) => row.detail).join("\n")).toContain(
      "USING COVERING INDEX idx_alert_deliveries_outstanding",
    );
    expect(plan.results?.map((row) => row.detail).join("\n")).not.toContain("USE TEMP B-TREE");
  });

  it.each(["memory", "sqlite"] as const)(
    "finds active agencies for existing subscribers after favourites change (%s)",
    async (adapter) => {
      const { createMemorySubscriptionRepository } =
        await import("~/infrastructure/storage/SubscriptionRepository");
      const { createMemoryD1 } = await import("../helpers/memoryD1");
      const layer =
        adapter === "memory"
          ? createMemorySubscriptionRepository()
          : createD1SubscriptionRepository(await createMemoryD1(), {
              fallbackTimezone: "America/Toronto",
            });
      await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* SubscriptionRepository;
          const sub = { ...makeRecord(), favouriteLines: [] };
          const deleted = { ...sub, id: "deleted", endpoint: "https://example.test/deleted" };
          yield* repo.upsertSubscription(sub);
          yield* repo.upsertSubscription(deleted);
          for (const [index, agencyId, status, subscriptionId] of [
            [0, "old-favourite", "active_sent", sub.id],
            [1, "old-favourite", "active_sent", sub.id],
            [2, "already-cleared", "cleared_sent", sub.id],
            [3, "silently-cleared", "cleared_silent", sub.id],
            [4, "deleted-subscriber", "active_sent", deleted.id],
          ] as const) {
            yield* repo.recordDelivery({
              id: `delivery-${index}`,
              alertId: `alert-${index}`,
              incidentKey: `incident-${index}`,
              agencyId,
              status,
              subscriptionId,
              deliveredAt: 0,
            });
          }
          yield* repo.deleteSubscriptionById(deleted.id);
          const targets = yield* repo.getOutstandingDeliveryTargets();
          expect(targets).toEqual([{ agencyId: "old-favourite", subscriptionId: sub.id }]);
        }).pipe(Effect.provide(layer)),
      );
    },
  );
});
