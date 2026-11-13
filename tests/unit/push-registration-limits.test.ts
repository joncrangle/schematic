import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, type Layer } from "effect";
import type { PushSubscriptionRecord } from "~/domain/notifications/types";
import { logger } from "~/infrastructure/logging/logger";
import {
  SubscriptionRepository,
  createD1SubscriptionRepository,
  createMemorySubscriptionRepository,
  makeD1SubscriptionRepositoryService,
  type AlertDeliveryClaim,
} from "~/infrastructure/storage/SubscriptionRepository";
import { handleSyncPushSubscription } from "~/services/notifications/NotificationServer";
import type { SyncPushSubscriptionInput } from "~/services/notifications/NotificationClient";
import { createMemoryD1 } from "../helpers/memoryD1";

let repositoryLayer: Layer.Layer<SubscriptionRepository> = createMemorySubscriptionRepository();

vi.mock("~/infrastructure/storage/SubscriptionRepository", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/infrastructure/storage/SubscriptionRepository")>();
  return {
    ...actual,
    get LiveSubscriptionRepositoryLayer() {
      return repositoryLayer;
    },
  };
});

const hour = 60 * 60 * 1000;
const day = 24 * hour;

async function registration(
  overrides: Partial<SyncPushSubscriptionInput> = {},
): Promise<SyncPushSubscriptionInput> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`,
    p256dh: Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64url"),
    auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url"),
    favouriteLines: [{ agencyId: "metro", lineId: "A" }],
    favouriteStations: [],
    favouriteSurfaceRoutes: [],
    commuteSchedules: [],
    timezone: "America/Toronto",
    policyRevision: 1,
    ...overrides,
  };
}

type Headers = Record<string, string>;

const request = (headers: Headers = {}, workers = false) =>
  Object.assign(
    new Request("https://schematic.test/_server", { headers }),
    workers ? { cf: {} } : {},
  );

const from = (ip: string) => request({ "x-forwarded-for": `198.18.0.1, ${ip}` });

const register = async (source: Request) =>
  handleSyncPushSubscription(await registration(), source);

describe.each([
  ["memory", async () => createMemorySubscriptionRepository()],
  [
    "sqlite",
    async () => createD1SubscriptionRepository(await createMemoryD1(), { fallbackTimezone: "UTC" }),
  ],
] as const)("push registration limits (%s)", (_adapter, makeLayer) => {
  beforeEach(async () => {
    repositoryLayer = await makeLayer();
    vi.stubEnv("PUSH_REGISTRATION_LIMIT", "2");
    vi.stubEnv("PUSH_REGISTRATION_WINDOW_MINUTES", "60");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-11-12T10:05:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("refuses new endpoints from a client over its limit without exposing the request", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    await register(from("203.0.113.7"));
    await register(from("203.0.113.7"));
    const refused = await registration();

    const error = await handleSyncPushSubscription(refused, from("203.0.113.7")).catch(
      (cause: unknown) => cause as Error,
    );

    expect(error).toBeInstanceOf(Error);
    const exposed = `${(error as Error).message} ${JSON.stringify(warn.mock.calls)}`;
    for (const secret of [refused.endpoint, refused.p256dh, refused.auth, "203.0.113.7"])
      expect(exposed).not.toContain(secret);
    await expect(register(from("198.51.100.4"))).resolves.toEqual({ success: true });
  });

  it("re-syncs an existing endpoint while its client is at the limit", async () => {
    const stored = await registration();
    await handleSyncPushSubscription(stored, from("203.0.113.7"));
    await register(from("203.0.113.7"));

    await expect(
      handleSyncPushSubscription(
        { ...stored, policyRevision: 2, favouriteLines: [{ agencyId: "metro", lineId: "B" }] },
        from("203.0.113.7"),
      ),
    ).resolves.toEqual({ success: true });
  });

  it("admits the client again once the window ends", async () => {
    await register(from("203.0.113.7"));
    await register(from("203.0.113.7"));
    await expect(register(from("203.0.113.7"))).rejects.toThrow();

    vi.setSystemTime(Date.parse("2026-11-12T11:00:00Z"));

    await expect(register(from("203.0.113.7"))).resolves.toEqual({ success: true });
  });

  it.each<[string, Headers, Headers]>([
    ["callers without a client IP", {}, {}],
    [
      "addresses in one IPv6 /64",
      { "x-forwarded-for": "2001:db8:1:2::10" },
      { "x-forwarded-for": "[2001:0db8:0001:0002:ffff::1]:443" },
    ],
    [
      "source ports of one IPv4 address",
      { "x-forwarded-for": "203.0.113.9:5678" },
      { "x-forwarded-for": "::ffff:203.0.113.9" },
    ],
    [
      "unparseable forwarded addresses",
      { "x-forwarded-for": "unknown-1" },
      { "x-forwarded-for": "unknown-2" },
    ],
    [
      "forged cf-connecting-ip headers outside Workers",
      { "cf-connecting-ip": "192.0.2.1", "x-forwarded-for": "203.0.113.5" },
      { "cf-connecting-ip": "192.0.2.2", "x-forwarded-for": "203.0.113.5" },
    ],
  ])("limits %s together", async (_label, first, second) => {
    await register(request(first));
    await register(request(second));

    await expect(register(request(first))).rejects.toThrow();
  });

  it("keys on cf-connecting-ip rather than forwarded hops on Workers", async () => {
    const workers = (ip: string) =>
      request({ "cf-connecting-ip": ip, "x-forwarded-for": "203.0.113.5" }, true);
    await register(workers("192.0.2.1"));
    await register(workers("192.0.2.1"));

    await expect(register(workers("192.0.2.2"))).resolves.toEqual({ success: true });
  });

  it("refuses new endpoints at the instance ceiling while existing endpoints re-sync", async () => {
    vi.stubEnv("PUSH_SUBSCRIPTION_CEILING", "2");
    const stored = await registration();
    await handleSyncPushSubscription(stored, from("203.0.113.1"));
    await register(from("203.0.113.2"));

    await expect(register(from("203.0.113.3"))).rejects.toThrow();
    await expect(
      handleSyncPushSubscription({ ...stored, policyRevision: 2 }, from("203.0.113.1")),
    ).resolves.toEqual({ success: true });
  });
});

describe("push registration storage", () => {
  afterEach(() => vi.unstubAllEnvs());

  const policy = {
    perClientLimit: 5,
    windowMs: hour,
    maxSubscriptions: 100,
    undeliveredRetentionMs: 30 * day,
  };

  it("stores only a salted client hash and drops the salt once the window ends", async () => {
    const db = await createMemoryD1();
    const repository = makeD1SubscriptionRepositoryService(db, { fallbackTimezone: "UTC" });
    const start = Date.parse("2026-11-12T10:00:00Z");
    await Effect.runPromise(
      repository.admitRegistration("https://push.test/a", "203.0.113.7", policy, start),
    );
    const firstSalt = await db
      .prepare("SELECT salt FROM push_registration_windows")
      .first<{ salt: string }>();
    const keys = await db
      .prepare("SELECT client_key FROM push_registration_counts")
      .all<{ client_key: string }>();
    expect(keys.results?.map((row) => row.client_key).join()).not.toContain("203.0.113");

    await Effect.runPromise(
      repository.admitRegistration("https://push.test/b", "203.0.113.7", policy, start + hour),
    );

    const salts = await db
      .prepare("SELECT salt FROM push_registration_windows")
      .all<{ salt: string }>();
    expect(salts.results?.map((row) => row.salt)).not.toContain(firstSalt?.salt);
    expect(salts.results).toHaveLength(1);
  });

  const subscription = (
    id: string,
    createdAt: number,
    updatedAt = createdAt,
  ): PushSubscriptionRecord => ({
    id,
    endpoint: `https://push.test/${id}`,
    p256dh: "fictional-p256dh",
    auth: "fictional-auth",
    favouriteLines: [],
    favouriteStations: [],
    favouriteSurfaceRoutes: [],
    commuteSchedules: [],
    timezone: "UTC",
    createdAt,
    updatedAt,
  });

  it.each(["memory", "sqlite"] as const)(
    "expires a never-delivered subscription the retention window after it was stored (%s)",
    async (adapter) => {
      vi.stubEnv("PUSH_UNDELIVERED_RETENTION_DAYS", "30");
      const layer =
        adapter === "memory"
          ? createMemorySubscriptionRepository()
          : createD1SubscriptionRepository(await createMemoryD1(), {
              fallbackTimezone: "UTC",
            });
      const stale = Date.now() - 40 * day;
      const claim: AlertDeliveryClaim = {
        agencyId: "fictional",
        alertId: "alert",
        incidentKey: "v1-incident",
        subscriptionId: "delivered",
        localeScope: "en-CA",
        locale: "en-CA",
        phase: "active",
        ownerToken: "owner",
        claimedAt: stale,
        expiresAt: stale + 30_000,
      };
      const remaining = await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* SubscriptionRepository;
          yield* repo.upsertSubscription(subscription("delivered", stale));
          yield* repo.upsertSubscription(subscription("never-delivered", stale));
          yield* repo.upsertSubscription(subscription("recent", Date.now()));
          yield* repo.upsertSubscription(subscription("re-synced", stale, Date.now()));
          yield* repo.claimDelivery(claim);
          yield* repo.completeDeliveryClaim(claim, {
            id: "delivery",
            agencyId: "fictional",
            alertId: "alert",
            incidentKey: "v1-incident",
            subscriptionId: "delivered",
            status: "active_sent",
            deliveredAt: stale,
            locale: "en-CA",
          });
          return yield* repo.getActiveSubscriptions();
        }).pipe(Effect.provide(layer)),
      );

      expect(remaining.map((sub) => sub.id).sort()).toEqual(["delivered", "recent"]);
    },
  );

  it.each([
    ["before the delivery column", ""],
    ["after an interrupted backfill", ", last_delivered_at INTEGER NOT NULL DEFAULT 0"],
  ])("keeps subscriptions stored before delivery tracking existed (%s)", async (_label, column) => {
    const db = await createMemoryD1();
    const stale = Date.now() - 40 * day;
    await db.exec(
      `CREATE TABLE push_subscriptions (id TEXT PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, favourite_lines_json TEXT, favourite_stations_json TEXT, favourite_routes_json TEXT, commute_schedules_json TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'America/Toronto', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL${column})`,
    );
    await db.exec(
      "CREATE TABLE subscription_meta (id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL DEFAULT 0, pruned_at INTEGER NOT NULL DEFAULT 0)",
    );
    await db.exec("INSERT INTO subscription_meta (id, schema_version, pruned_at) VALUES (1, 1, 0)");
    await db
      .prepare(
        "INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, commute_schedules_json, created_at, updated_at) VALUES ('legacy', 'https://push.test/legacy', 'k', 'a', '[]', ?, ?)",
      )
      .bind(stale, stale)
      .run();

    const remaining = await Effect.runPromise(
      Effect.flatMap(SubscriptionRepository, (repo) => repo.getActiveSubscriptions()).pipe(
        Effect.provide(createD1SubscriptionRepository(db, { fallbackTimezone: "UTC" })),
      ),
    );

    expect(remaining.map((sub) => sub.id)).toEqual(["legacy"]);
  });
});
