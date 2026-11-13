// @vitest-environment happy-dom
/** @vitest-environment happy-dom */
import { describe, expect, it, afterEach, vi } from "vitest";
import { Effect, Layer } from "effect";
import { evaluateDevStatus } from "~/lib/devFlags";
import {
  buildTestPayload,
  createTestPushService,
  TestPushService,
  TEST_PUSH_DEFAULT_TITLE,
} from "~/services/notifications/TestPushService";
import { handleTriggerTestPush } from "~/services/notifications/NotificationServer";
import type { TestPushTriggerInput } from "~/services/notifications/NotificationClient";
import type { PushSubscriptionRecord } from "~/domain/notifications/types";
import {
  SubscriptionRepository,
  createMemorySubscriptionRepository,
} from "~/infrastructure/storage/SubscriptionRepository";
import { createMockVapidClient } from "~/infrastructure/notifications/VapidClient";

vi.mock("~/infrastructure/storage/SubscriptionRepository", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/infrastructure/storage/SubscriptionRepository")>();
  return {
    ...actual,
    LiveSubscriptionRepositoryLayer: actual.MemorySubscriptionRepositoryLive,
  };
});

describe("evaluateDevStatus (pure decision core)", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalGlobalEnv = (globalThis as { env?: unknown }).env;

  const setGlobalEnv = (env: Record<string, string | undefined> | undefined) => {
    (globalThis as { env?: unknown }).env = env;
  };

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    setGlobalEnv(originalGlobalEnv as Record<string, string | undefined> | undefined);
  });

  // A genuine build-time flag is strictly boolean and always wins.
  // live bug: bun run dev under @cloudflare/vite-plugin serves a DEV=true
  // bundle while wrangler.jsonc vars put NODE_ENV="production" into local
  // workerd's process.env mirror AND globalThis.env bindings.
  it("trusts a true build flag over NODE_ENV=production in BOTH runtimes", () => {
    process.env.NODE_ENV = "production";
    setGlobalEnv({ NODE_ENV: "production" });
    expect(evaluateDevStatus(true)).toBe(true);
  });

  it("rejects on a false build flag even when NODE_ENV is unset everywhere (old fail-open closed)", () => {
    delete process.env.NODE_ENV;
    setGlobalEnv(undefined);
    expect(evaluateDevStatus(false)).toBe(false);
  });

  // Non-boolean flags (absent in scripts, stringified in exotic runtimes)
  // defer to the runtime NODE_ENV fallback.
  it("falls back on a non-boolean flag: rejects when NODE_ENV says production", () => {
    process.env.NODE_ENV = "production";
    setGlobalEnv(undefined);
    expect(evaluateDevStatus(undefined)).toBe(false);
  });

  it("falls back on a non-boolean flag: allows when NODE_ENV is development", () => {
    process.env.NODE_ENV = "development";
    setGlobalEnv(undefined);
    expect(evaluateDevStatus(undefined)).toBe(true);
  });
});

describe("buildTestPayload", () => {
  it("produces a clearly-test payload with defaults", () => {
    const payload = buildTestPayload();

    expect(payload.title).toBe(TEST_PUSH_DEFAULT_TITLE);
    expect(TEST_PUSH_DEFAULT_TITLE).toContain("🧪");
    expect(payload.body.length).toBeGreaterThan(0);
    expect(payload.tag.startsWith("test-push-")).toBe(true);
    expect(payload.data?.url).toBe("/");
  });

  it("honours custom title and body", () => {
    const payload = buildTestPayload({ title: "Custom title", body: "Custom body" });

    expect(payload.title).toBe("Custom title");
    expect(payload.body).toBe("Custom body");
  });

  it("falls back to defaults for empty or whitespace-only customizations", () => {
    const payload = buildTestPayload({ title: "   ", body: "" });

    expect(payload.title).toBe(TEST_PUSH_DEFAULT_TITLE);
    expect(payload.body.length).toBeGreaterThan(0);
  });

  it("coerces non-string customizations to defaults instead of producing garbage", () => {
    // RPC JSON payloads can carry any shape despite the declared types
    // (e.g. title: 123 from a tampered/hand-rolled request body).
    const payload = buildTestPayload({
      title: 123 as unknown as string,
      body: { malicious: true } as unknown as string,
    });

    expect(payload.title).toBe(TEST_PUSH_DEFAULT_TITLE);
    expect(payload.body).not.toContain("malicious");
  });

  it("generates a unique tag per call so renotify is never deduped away", () => {
    const first = buildTestPayload();
    const second = buildTestPayload({ title: "again" });

    expect(first.tag).not.toBe(second.tag);
    expect(first.tag.startsWith("test-push-")).toBe(true);
    expect(second.tag.startsWith("test-push-")).toBe(true);
  });
});

function makeSub(overrides: Partial<PushSubscriptionRecord> = {}): PushSubscriptionRecord {
  const now = Date.now();
  return {
    id: "sub_1",
    endpoint: "https://push.example.com/sub_1",
    p256dh: "key_p256dh",
    auth: "key_auth",
    favouriteLines: [],
    favouriteStations: [],
    favouriteSurfaceRoutes: [],
    commuteSchedules: [],
    timezone: "America/Toronto",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function buildTestHarness(
  mockSend: (
    sub: PushSubscriptionRecord,
    payload: { title: string },
  ) => Promise<{
    success: boolean;
    statusCode: number;
    expired: boolean;
    error?: string;
  }>,
) {
  const memorySubLayer = createMemorySubscriptionRepository();
  const mockVapidLayer = createMockVapidClient(mockSend);
  const serviceLayer = createTestPushService();

  const layer = Layer.merge(serviceLayer, Layer.merge(memorySubLayer, mockVapidLayer)).pipe(
    Layer.provide(Layer.merge(memorySubLayer, mockVapidLayer)),
  );

  return layer;
}

describe("TestPushService", () => {
  it("sends the payload to every active subscription, ignoring commute windows and dedupe", async () => {
    const sent: Array<{ subId: string; title: string }> = [];
    const layer = buildTestHarness(async (sub, payload) => {
      sent.push({ subId: sub.id, title: payload.title });
      return { success: true, statusCode: 201, expired: false };
    });

    const payload = buildTestPayload({ title: "Pipeline check" });

    const program = Effect.gen(function* () {
      const repo = yield* SubscriptionRepository;
      const testPush = yield* TestPushService;

      // One subscription with no schedule and one whose commute window is
      // almost certainly inactive right now — both must still receive the push.
      yield* repo.upsertSubscription(
        makeSub({ id: "sub_a", endpoint: "https://push.example.com/a" }),
      );
      yield* repo.upsertSubscription(
        makeSub({
          id: "sub_b",
          endpoint: "https://push.example.com/b",
          commuteSchedules: [
            {
              id: "morn",
              label: "Morning",
              enabled: true,
              days: [1, 2, 3, 4, 5],
              start: "03:00",
              end: "03:05",
            },
          ],
        }),
      );

      const summary = yield* testPush.sendTestPush(payload);

      expect(summary.total).toBe(2);
      expect(summary.sent).toBe(2);
      expect(summary.failed).toBe(0);
      expect(summary.expiredSubscriptionsPruned).toBe(0);
      expect(sent.length).toBe(2);
      expect(sent.every((p) => p.title === "Pipeline check")).toBe(true);
    }).pipe(Effect.provide(layer));

    await Effect.runPromise(program);
  });

  it("prunes subscriptions whose push service responds 404/410", async () => {
    const layer = buildTestHarness(async () => ({
      success: false,
      statusCode: 410,
      expired: true,
      error: "Gone",
    }));

    const program = Effect.gen(function* () {
      const repo = yield* SubscriptionRepository;
      const testPush = yield* TestPushService;

      yield* repo.upsertSubscription(makeSub({ id: "sub_dead" }));
      expect((yield* repo.getActiveSubscriptions()).length).toBe(1);

      const summary = yield* testPush.sendTestPush(buildTestPayload());

      expect(summary.expiredSubscriptionsPruned).toBe(1);
      expect(summary.sent).toBe(0);
      expect((yield* repo.getActiveSubscriptions()).length).toBe(0);
    }).pipe(Effect.provide(layer));

    await Effect.runPromise(program);
  });

  it("counts failed (non-expired) sends without aborting the batch", async () => {
    const layer = buildTestHarness(async (sub) => {
      if (sub.endpoint.includes("dead")) {
        return { success: false, statusCode: 500, expired: false, error: "boom" };
      }
      return { success: true, statusCode: 201, expired: false };
    });

    const program = Effect.gen(function* () {
      const repo = yield* SubscriptionRepository;
      const testPush = yield* TestPushService;

      yield* repo.upsertSubscription(
        makeSub({ id: "sub_dead", endpoint: "https://push.example.com/dead" }),
      );
      yield* repo.upsertSubscription(
        makeSub({ id: "sub_alive", endpoint: "https://push.example.com/alive" }),
      );

      const summary = yield* testPush.sendTestPush(buildTestPayload());

      expect(summary.total).toBe(2);
      expect(summary.sent).toBe(1);
      expect(summary.failed).toBe(1);
      expect(summary.expiredSubscriptionsPruned).toBe(0);
    }).pipe(Effect.provide(layer));

    await Effect.runPromise(program);
  });

  it("survives a thrown VapidError from one subscription and still sends to the rest", async () => {
    const layer = buildTestHarness(async (sub) => {
      if (sub.endpoint.includes("throw")) {
        throw new Error("network exploded");
      }
      return { success: true, statusCode: 201, expired: false };
    });

    const program = Effect.gen(function* () {
      const repo = yield* SubscriptionRepository;
      const testPush = yield* TestPushService;

      yield* repo.upsertSubscription(
        makeSub({ id: "sub_throw", endpoint: "https://push.example.com/throw" }),
      );
      yield* repo.upsertSubscription(
        makeSub({ id: "sub_ok", endpoint: "https://push.example.com/ok" }),
      );

      const summary = yield* testPush.sendTestPush(buildTestPayload());

      expect(summary.sent).toBe(1);
      expect(summary.failed).toBe(1);
    }).pipe(Effect.provide(layer));

    await Effect.runPromise(program);
  });

  it("sends nothing when there are no active subscriptions", async () => {
    const sent: Array<string> = [];
    const layer = buildTestHarness(async (sub) => {
      sent.push(sub.id);
      return { success: true, statusCode: 201, expired: false };
    });

    const program = Effect.gen(function* () {
      const testPush = yield* TestPushService;

      const summary = yield* testPush.sendTestPush(buildTestPayload());

      expect(summary.total).toBe(0);
      expect(summary.sent).toBe(0);
      expect(sent.length).toBe(0);
    }).pipe(Effect.provide(layer));

    await Effect.runPromise(program);
  });
});

describe("triggerTestPush handler logic", () => {
  const originals: Record<string, string | undefined> = {
    NODE_ENV: process.env.NODE_ENV,
    VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
    VAPID_SUBJECT: process.env.VAPID_SUBJECT,
  };
  const originalGlobalEnv = (globalThis as { env?: unknown }).env;

  const setGlobalEnv = (env: Record<string, string | undefined> | undefined) => {
    (globalThis as { env?: unknown }).env = env;
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const [name, value] of Object.entries(originals)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    setGlobalEnv(originalGlobalEnv as Record<string, string | undefined> | undefined);
  });

  it("hard-rejects in production even when the client asks nicely", async () => {
    vi.stubEnv("DEV", false);
    process.env.NODE_ENV = "production";
    process.env.VAPID_PUBLIC_KEY = "pk_test_prod";
    process.env.VAPID_PRIVATE_KEY = "sk_test_prod";
    setGlobalEnv(undefined);

    const input: TestPushTriggerInput = { title: "please send" };

    await expect(handleTriggerTestPush(input)).rejects.toThrow(
      /disabled outside development environments/i,
    );
  });

  it("allows bindings-only production env when the bundle is a dev build", async () => {
    vi.stubEnv("DEV", true);
    delete process.env.NODE_ENV;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    setGlobalEnv({
      NODE_ENV: "production",
      VAPID_PUBLIC_KEY: "pk_test_local_workerd",
      VAPID_PRIVATE_KEY: "sk_test_local_workerd",
    });

    const result = await handleTriggerTestPush({ title: "hello" });

    expect(result.ok).toBe(true);
    expect(result.sent).toBe(0);
  });

  it("returns an actionable ok:false result in dev when VAPID keys are absent", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    setGlobalEnv({});

    const result = await handleTriggerTestPush({ title: "hello" });

    expect(result.ok).toBe(false);
    expect(result.sent).toBe(0);
    expect(result.message).toMatch(/VAPID/i);
  });

  it("resolves ok:true in dev with configured keys and no subscriptions", async () => {
    process.env.NODE_ENV = "development";
    process.env.VAPID_PUBLIC_KEY = "pk_test_dev";
    process.env.VAPID_PRIVATE_KEY = "sk_test_dev";
    setGlobalEnv({});

    const result = await handleTriggerTestPush({ title: "hello", body: "body" });

    expect(result.ok).toBe(true);
    expect(result.total).toBe(0);
    expect(result.sent).toBe(0);
  });

  it("tolerates non-string input values instead of throwing on payload build", async () => {
    process.env.NODE_ENV = "development";
    process.env.VAPID_PUBLIC_KEY = "pk_test_dev";
    process.env.VAPID_PRIVATE_KEY = "sk_test_dev";
    setGlobalEnv({});

    const hostile = { title: 123, body: { evil: true } } as unknown as TestPushTriggerInput;

    const result = await handleTriggerTestPush(hostile);

    expect(result.ok).toBe(true);
    expect(result.sent).toBe(0);
  });
});
