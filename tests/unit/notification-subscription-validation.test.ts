import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import {
  handleSyncPushSubscription,
  handleDeletePushSubscription,
} from "~/services/notifications/NotificationServer";
import type { SyncPushSubscriptionInput } from "~/services/notifications/NotificationClient";
import { getActiveAgency } from "~/agencies";
import {
  SubscriptionRepository,
  MemorySubscriptionRepositoryLive,
} from "~/infrastructure/storage/SubscriptionRepository";

vi.mock("~/infrastructure/storage/SubscriptionRepository", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/infrastructure/storage/SubscriptionRepository")>();
  return { ...actual, LiveSubscriptionRepositoryLayer: actual.MemorySubscriptionRepositoryLive };
});

// Registration limits have their own suite; this one checks validation only.
beforeAll(() => vi.stubEnv("PUSH_REGISTRATION_LIMIT", "1000"));
afterAll(() => vi.unstubAllEnvs());

async function validPolicy(): Promise<SyncPushSubscriptionInput> {
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
    commuteSchedules: [
      { id: "morning", label: "Morning", days: [3], enabled: true, start: "07:30", end: "09:30" },
    ],
    locale: "fr-CA",
    timezone: "America/Toronto",
  };
}

describe("notification subscription registration boundary", () => {
  it("stores a validated anonymous subscription policy", async () => {
    const policy = await validPolicy();
    expect(await handleSyncPushSubscription(policy)).toEqual({ success: true });
    const subscriptions = await Effect.runPromise(
      Effect.flatMap(SubscriptionRepository, (repo) => repo.getActiveSubscriptions()).pipe(
        Effect.provide(MemorySubscriptionRepositoryLive),
      ),
    );
    expect(subscriptions.find((sub) => sub.endpoint === policy.endpoint)).toMatchObject(policy);
  });

  it("defaults a legacy registration without locale to English", async () => {
    const policy = { ...(await validPolicy()) };
    delete policy.locale;
    expect(await handleSyncPushSubscription(policy)).toEqual({ success: true });
    const subscriptions = await Effect.runPromise(
      Effect.flatMap(SubscriptionRepository, (repo) => repo.getActiveSubscriptions()).pipe(
        Effect.provide(MemorySubscriptionRepositoryLive),
      ),
    );
    expect(subscriptions.find((sub) => sub.endpoint === policy.endpoint)?.locale).toBe("en-CA");
  });

  it("defaults a registration without a timezone to the active agency's timezone", async () => {
    const policy = { ...(await validPolicy()) };
    delete policy.timezone;
    expect(await handleSyncPushSubscription(policy)).toEqual({ success: true });
    const subscriptions = await Effect.runPromise(
      Effect.flatMap(SubscriptionRepository, (repo) => repo.getActiveSubscriptions()).pipe(
        Effect.provide(MemorySubscriptionRepositoryLive),
      ),
    );
    expect(subscriptions.find((sub) => sub.endpoint === policy.endpoint)?.timezone).toBe(
      getActiveAgency().manifest.timezone,
    );
  });

  it("canonicalizes a supported language alias before validating the registration locale", async () => {
    const policy = { ...(await validPolicy()), locale: "fr-FR" };
    expect(await handleSyncPushSubscription(policy)).toEqual({ success: true });
    const subscriptions = await Effect.runPromise(
      Effect.flatMap(SubscriptionRepository, (repo) => repo.getActiveSubscriptions()).pipe(
        Effect.provide(MemorySubscriptionRepositoryLive),
      ),
    );
    expect(subscriptions.find((sub) => sub.endpoint === policy.endpoint)?.locale).toBe("fr-CA");
  });

  it.each([
    [
      "malformed commute time",
      {
        commuteSchedules: [
          { id: "bad", label: "Bad", enabled: true, days: [3], start: "8:00", end: "25:00" },
        ],
      },
    ],
    ["unqualified route", { favouriteSurfaceRoutes: ["A"] }],
    ["invalid policy revision", { policyRevision: -1 }],
    ["invalid timezone", { timezone: "Mars/Transit" }],
    ["unsupported locale", { locale: "de-DE" }],
    ["invalid encryption key", { p256dh: "private-invalid-key" }],
    ["invalid authentication secret", { auth: "private-invalid-auth" }],
    ["insecure endpoint", { endpoint: "http://push.example/private-endpoint" }],
    ["untrusted push host", { endpoint: "https://attacker.example/push" }],
    ["IP-literal push host", { endpoint: "https://127.0.0.1/push" }],
    ["IPv6 push host", { endpoint: "https://[::1]/push" }],
    ["userinfo on trusted host", { endpoint: "https://user:password@fcm.googleapis.com/push" }],
    [
      "trusted-name prefix on attacker host",
      { endpoint: "https://fcm.googleapis.com.attacker.example/push" },
    ],
    ["lookalike Apple host", { endpoint: "https://evilpush.apple.com/push" }],
    ["non-default push port", { endpoint: "https://fcm.googleapis.com:8443/push" }],
    ["oversized endpoint", { endpoint: `https://fcm.googleapis.com/${"x".repeat(2048)}` }],
    ["oversized line ID", { favouriteLines: [{ agencyId: "metro", lineId: "L".repeat(129) }] }],
    [
      "oversized station name",
      { favouriteStations: [{ agencyId: "metro", stationName: "S".repeat(201) }] },
    ],
    [
      "too many favourite lines",
      {
        favouriteLines: Array.from({ length: 101 }, (_, index) => ({
          agencyId: "metro",
          lineId: `line-${index}`,
        })),
      },
    ],
    [
      "too many commute schedules",
      {
        commuteSchedules: Array.from({ length: 11 }, (_, index) => ({
          id: `schedule-${index}`,
          label: `Schedule ${index}`,
          enabled: true,
          days: [1],
          start: "07:00",
          end: "08:00",
        })),
      },
    ],
  ])("rejects %s without storing it or exposing credentials", async (_label, override) => {
    const policy = { ...(await validPolicy()), ...override };
    const before = await Effect.runPromise(
      Effect.flatMap(SubscriptionRepository, (repo) => repo.getActiveSubscriptions()).pipe(
        Effect.provide(MemorySubscriptionRepositoryLive),
      ),
    );
    await expect(handleSyncPushSubscription(policy)).rejects.toMatchObject({
      message: "Invalid push subscription",
    });
    const after = await Effect.runPromise(
      Effect.flatMap(SubscriptionRepository, (repo) => repo.getActiveSubscriptions()).pipe(
        Effect.provide(MemorySubscriptionRepositoryLive),
      ),
    );
    expect(after).toEqual(before);
  });

  it("rejects a policy revision more than one day ahead of server time", async () => {
    const policy = {
      ...(await validPolicy()),
      policyRevision: Date.now() + 24 * 60 * 60 * 1000 + 60_000,
    };
    await expect(handleSyncPushSubscription(policy)).rejects.toMatchObject({
      message: "Invalid push subscription",
    });
  });

  it.each([
    "https://fcm.googleapis.com/fcm/send/fake-token",
    "https://push.services.mozilla.com/wpush/v2/fake-token",
    "https://updates.push.services.mozilla.com/wpush/v2/fake-token",
    "https://east.notify.windows.com/w/?token=fake-token",
    "https://web.push.apple.com/fake-token",
    "https://region.push.apple.com/fake-token",
  ])("accepts a known browser push service endpoint: %s", async (endpoint) => {
    const policy = { ...(await validPolicy()), endpoint };
    expect(await handleSyncPushSubscription(policy)).toEqual({ success: true });
  });

  it("allows an operator-configured exact push host while keeping port checks", async () => {
    const original = process.env.PUSH_ENDPOINT_HOSTS;
    process.env.PUSH_ENDPOINT_HOSTS = "push.example.net, 127.0.0.1";
    try {
      expect(
        await handleSyncPushSubscription({
          ...(await validPolicy()),
          endpoint: "https://push.example.net/device/1",
        }),
      ).toEqual({ success: true });
      await expect(
        handleSyncPushSubscription({
          ...(await validPolicy()),
          endpoint: "https://push.example.net:8443/device/2",
        }),
      ).rejects.toMatchObject({ message: "Invalid push subscription" });
      await expect(
        handleSyncPushSubscription({
          ...(await validPolicy()),
          endpoint: "https://127.0.0.1/device/3",
        }),
      ).rejects.toMatchObject({ message: "Invalid push subscription" });
    } finally {
      if (original === undefined) delete process.env.PUSH_ENDPOINT_HOSTS;
      else process.env.PUSH_ENDPOINT_HOSTS = original;
    }
  });
});

it("ignores late mirrors and healing deletes without losing the current subscription identity", async () => {
  const policy = await validPolicy();
  await handleSyncPushSubscription({ ...policy, policyRevision: 1 });
  const read = () =>
    Effect.runPromise(
      Effect.flatMap(SubscriptionRepository, (repo) => repo.getActiveSubscriptions()).pipe(
        Effect.provide(MemorySubscriptionRepositoryLive),
      ),
    );
  const original = (await read()).find((sub) => sub.endpoint === policy.endpoint)!;
  await handleSyncPushSubscription({
    ...policy,
    policyRevision: 3,
    favouriteLines: [{ agencyId: "metro", lineId: "B" }],
  });
  await handleSyncPushSubscription({ ...policy, policyRevision: 2 });
  await handleSyncPushSubscription(policy);
  await handleDeletePushSubscription({ endpoint: policy.endpoint, policyRevision: 2 });
  const current = (await read()).find((sub) => sub.endpoint === policy.endpoint)!;
  expect(current.favouriteLines).toEqual([{ agencyId: "metro", lineId: "B" }]);
  expect(current.id).toBe(original.id);
  await handleDeletePushSubscription({ endpoint: policy.endpoint, policyRevision: 4 });
  await handleSyncPushSubscription({ ...policy, policyRevision: 2 });
  expect((await read()).find((sub) => sub.endpoint === policy.endpoint)).toBeUndefined();
});

it.each([null, { endpoint: 42, policyRevision: 1 }, { endpoint: "http://push.example/invalid" }])(
  "rejects malformed deletion input before storage",
  async (input) => {
    await expect(handleDeletePushSubscription(input)).rejects.toMatchObject({
      message: "Invalid push subscription",
    });
  },
);
