import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestManifest } from "../helpers/agency-fixtures";
import { makeMinimalSchematic } from "../helpers/fixtures";
import { Effect, Layer } from "effect";
import {
  captureServerEnvChannels,
  clearServerEnvChannels,
  setGlobalEnvChannel,
} from "../helpers/env-channels";
import type { AgencyAlert, AgencyProvider, AgencySnapshot } from "~/agencies/types";
import type { CommuteSchedule } from "~/domain/preferences/UserPreferences";
import type { PushSubscriptionRecord } from "~/domain/notifications/types";
import type { UiLocale } from "~/domain/locale";

/**
 * Multi-agency background evaluation (ADR-0007): the cron evaluation
 * cycle iterates allProviders() and evaluates each agency's snapshot through
 * the generic port with the shared notification store and VAPID stack — adding a
 * registered agency requires zero cron changes to be evaluated.
 */

const fixtures = vi.hoisted(() => ({
  providers: [] as AgencyProvider[],
  seeds: {} as Record<string, PushSubscriptionRecord[]>,
  notificationsSeeds: [] as PushSubscriptionRecord[],
  sent: [] as Array<{ endpoint: string; title: string; data?: Record<string, unknown> }>,
}));

const { loggerMocks } = vi.hoisted(() => ({
  loggerMocks: {
    getLevel: () => "info",
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const { devProxyOriginMock } = vi.hoisted(() => ({
  devProxyOriginMock: vi.fn(),
}));

vi.mock("~/infrastructure/logging/logger", () => ({ logger: loggerMocks }));

vi.mock("~/services/devRequestOrigin", () => ({
  getDevRequestOrigin: devProxyOriginMock,
}));

vi.mock("~/agencies/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/agencies/registry")>();
  return {
    ...actual,
    allProviders: () => fixtures.providers,
  };
});

vi.mock("~/infrastructure/storage/SubscriptionRepository", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/infrastructure/storage/SubscriptionRepository")>();
  return {
    ...actual,
    createLiveNotificationsRepositoryLayer: () =>
      Layer.effect(
        actual.SubscriptionRepository,
        Effect.gen(function* () {
          const repo = yield* actual.SubscriptionRepository.pipe(
            Effect.provide(actual.createMemorySubscriptionRepository()),
          );
          const seeds =
            fixtures.notificationsSeeds.length > 0
              ? fixtures.notificationsSeeds
              : Object.values(fixtures.seeds).flat();
          for (const sub of seeds) {
            yield* repo.upsertSubscription(sub);
          }
          return repo;
        }),
      ),
  };
});

vi.mock("~/infrastructure/notifications/VapidClient", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/infrastructure/notifications/VapidClient")>();
  return {
    ...actual,
    createVapidClientLayer: () =>
      actual.createMockVapidClient(async (sub, payload) => {
        fixtures.sent.push({
          endpoint: sub.endpoint,
          title: payload.title,
          data: payload.data as Record<string, unknown>,
        });
        return { success: true, statusCode: 201, expired: false };
      }),
  };
});

let runEvaluationCycle: () => Promise<void>;

// 2026-08-19T12:00:00Z is Wednesday 08:00 EDT — inside the fixture commute window.
const FIXED_NOW = new Date("2026-08-19T12:00:00Z").getTime();
const vapidVarNames = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"] as const;
const restoreEnvChannels = captureServerEnvChannels(vapidVarNames);

beforeEach(async () => {
  // Fresh scheduler module per test: the per-agency evaluation stack
  // cache is deliberately per-isolate state, so tests must not share it.
  vi.resetModules();
  ({ runEvaluationCycle } = await import("~/services/notifications/ProductionScheduler"));
  clearServerEnvChannels(vapidVarNames);
  setGlobalEnvChannel({ VAPID_PUBLIC_KEY: "pk-test", VAPID_PRIVATE_KEY: "sk-test" });
  devProxyOriginMock.mockReturnValue("http://127.0.0.1:3000");
  fixtures.providers = [];
  fixtures.seeds = {};
  fixtures.notificationsSeeds = [];
  fixtures.sent = [];
  vi.useFakeTimers({ now: FIXED_NOW, toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  restoreEnvChannels();
  vi.clearAllMocks();
});

function makeCommuteSchedule(): CommuteSchedule {
  return {
    id: "morning_commute",
    label: "Morning Commute",
    enabled: true,
    days: [1, 2, 3, 4, 5],
    start: "07:30",
    end: "09:30",
  };
}

function makeSub(
  id: string,
  favouriteLines: string[],
  agencyId: string,
  locale: UiLocale = "en-CA",
): PushSubscriptionRecord {
  return {
    id,
    endpoint: `https://push.example.com/${id}`,
    p256dh: `key_p256dh_${id}`,
    auth: `key_auth_${id}`,
    favouriteLines: favouriteLines.map((lineId) => ({ agencyId, lineId })),
    favouriteStations: [],
    favouriteSurfaceRoutes: [],
    commuteSchedules: [makeCommuteSchedule()],
    locale,
    timezone: "America/Toronto",
    createdAt: FIXED_NOW - 1000,
    updatedAt: FIXED_NOW - 1000,
  };
}

function makeProvider(
  id: string,
  options: {
    snapshotFactory?: (ctx: {
      readonly devProxyOrigin?: string;
      readonly locale?: UiLocale;
    }) => Promise<AgencySnapshot>;
  } = {},
): AgencyProvider {
  return {
    manifest: {
      id,
      name: `${id.toUpperCase()} Transit`,
      locale: "en-CA",
      timezone: "America/Toronto",
      bounds: [{ minLat: 43, maxLat: 44, minLon: -80, maxLon: -79 }],
      modes: ["bus"],
      stationService: { routeType: "bus" },
      attribution: { name: `${id} Open Data`, url: `https://${id}.example.com`, license: "CC-BY" },
      status: "active",
    },
    staticTopology: {},
    schematic: makeMinimalSchematic(),
    ...(options.snapshotFactory ? { snapshot: { get: options.snapshotFactory } } : {}),
  };
}

function makeSevereAlert(id: string, lineId: string, title: string): AgencyAlert {
  return {
    id,
    kind: "suspension",
    affectedLineIds: [lineId],
    title,
    description: `${title} (fixture)`,
    severity: "severe",
    lifecycle: "active",
    scope: "line",
    startsAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  };
}

function makeSnapshot(agencyId: string, alerts: AgencyAlert[]): () => Promise<AgencySnapshot> {
  return async () => ({
    agencyId,
    generatedAt: FIXED_NOW,
    freshness: "live",
    alerts,
  });
}

function makeHealthyBeta(): {
  provider: AgencyProvider;
  subscriber: PushSubscriptionRecord;
  alert: AgencyAlert;
} {
  const alert = makeSevereAlert("beta-alert-1", "4", "Beta crosstown suspended");
  return {
    provider: makeProvider("beta", { snapshotFactory: makeSnapshot("beta", [alert]) }),
    subscriber: makeSub("bob", ["4"], "beta"),
    alert,
  };
}

describe("runEvaluationCycle multi-agency iteration", () => {
  it("passes the dev feed proxy origin to scheduled snapshot adapters", async () => {
    let observedProxyOrigin: string | undefined;
    fixtures.providers = [
      makeProvider("go", {
        snapshotFactory: async (ctx) => {
          observedProxyOrigin = ctx.devProxyOrigin;
          return makeSnapshot("go", [])();
        },
      }),
    ];
    fixtures.notificationsSeeds = [makeSub("proxy-rider", ["1"], "go")];

    await runEvaluationCycle();

    expect(observedProxyOrigin).toBe("http://127.0.0.1:3000");
  });

  it("fetches one snapshot per subscribed locale and evaluates it only for that locale", async () => {
    const observedLocales: UiLocale[] = [];
    const provider = makeProvider("metro", {
      snapshotFactory: async ({ locale }) => {
        const resolvedLocale = locale ?? "en-CA";
        observedLocales.push(resolvedLocale);
        return makeSnapshot("metro", [
          makeSevereAlert(
            resolvedLocale === "fr-CA" ? "fr-incident" : "en-incident",
            "A",
            resolvedLocale === "fr-CA" ? "Service interrompu sur la ligne A" : "Line A suspended",
          ),
        ])();
      },
    });
    fixtures.providers = [provider];
    const englishSubscriber = makeSub("english-rider", ["A"], "metro", "en-CA");
    const frenchSubscriber = makeSub("french-rider", ["A"], "metro", "fr-CA");
    const unrelatedSubscriber = makeSub("unrelated-rider", ["A"], "another-agency", "fr-CA");
    fixtures.notificationsSeeds = [englishSubscriber, frenchSubscriber, unrelatedSubscriber];

    await runEvaluationCycle();

    expect([...observedLocales].sort()).toEqual(["en-CA", "fr-CA"]);
    expect(fixtures.sent).toHaveLength(2);
    expect(fixtures.sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpoint: englishSubscriber.endpoint,
          title: expect.stringContaining("Line A suspended"),
        }),
        expect.objectContaining({
          endpoint: frenchSubscriber.endpoint,
          title: expect.stringContaining("Service interrompu sur la ligne A"),
        }),
      ]),
    );
  });

  it("continues with French subscribers when the English snapshot fetch fails", async () => {
    const observedLocales: UiLocale[] = [];
    const provider = makeProvider("metro", {
      snapshotFactory: async ({ locale }) => {
        const resolvedLocale = locale ?? "en-CA";
        observedLocales.push(resolvedLocale);
        if (resolvedLocale === "en-CA") throw new Error("English source unavailable");
        return makeSnapshot("metro", [
          makeSevereAlert("fr-incident", "A", "Service interrompu sur la ligne A"),
        ])();
      },
    });
    fixtures.providers = [provider];
    const englishSubscriber = makeSub("english-rider", ["A"], "metro", "en-CA");
    const frenchSubscriber = makeSub("french-rider", ["A"], "metro", "fr-CA");
    fixtures.notificationsSeeds = [englishSubscriber, frenchSubscriber];

    await expect(runEvaluationCycle()).rejects.toThrow(/metro/);

    expect(observedLocales).toEqual(["en-CA", "fr-CA"]);
    expect(fixtures.sent).toEqual([
      expect.objectContaining({
        endpoint: frenchSubscriber.endpoint,
        title: expect.stringContaining("Service interrompu sur la ligne A"),
      }),
    ]);
  });

  it("polls an unfollowed agency in the default locale when another agency has subscribers", async () => {
    const agencyId = makeTestManifest().id;
    const fetchedLocales: (UiLocale | undefined)[] = [];
    fixtures.providers = [
      makeProvider(agencyId, {
        snapshotFactory: async ({ locale }) => {
          fetchedLocales.push(locale);
          return makeSnapshot(agencyId, [])();
        },
      }),
    ];
    fixtures.notificationsSeeds = [makeSub("other-agency-rider", ["A"], "another-agency", "fr-CA")];

    await runEvaluationCycle();

    expect(fetchedLocales).toEqual(["en-CA"]);
  });

  it("rejects a snapshot whose agency id does not match its provider", async () => {
    const alert = makeSevereAlert("wrong-agency-alert", "9", "Wrong agency snapshot");
    fixtures.providers = [
      makeProvider("alpha", { snapshotFactory: makeSnapshot("beta", [alert]) }),
    ];
    fixtures.seeds.alpha = [makeSub("alice", ["9"], "alpha")];

    await expect(runEvaluationCycle()).rejects.toThrowError(/evaluate-alerts failed/);
    expect(fixtures.sent).toHaveLength(0);
  });

  it("evaluates every registered provider through its own snapshot port and dispatches per-agency pushes", async () => {
    const alphaAlert = makeSevereAlert("alpha-alert-1", "9", "Alpha downtown loop suspended");
    const beta = makeHealthyBeta();
    fixtures.providers = [
      makeProvider("alpha", { snapshotFactory: makeSnapshot("alpha", [alphaAlert]) }),
      beta.provider,
    ];
    fixtures.seeds.alpha = [makeSub("alice", ["9"], "alpha")];
    fixtures.seeds.beta = [beta.subscriber];

    await runEvaluationCycle();

    const endpoints = fixtures.sent.map((send) => send.endpoint).sort();
    expect(endpoints).toEqual(["https://push.example.com/alice", "https://push.example.com/bob"]);
    const alphaSend = fixtures.sent.find((send) => send.endpoint.endsWith("alice"));
    const betaSend = fixtures.sent.find((send) => send.endpoint.endsWith("bob"));
    expect(alphaSend?.title).toContain("Alpha downtown loop suspended");
    expect(alphaSend?.data?.alertId).toBe("alpha-alert-1");
    expect(betaSend?.title).toContain(beta.alert.title);
    expect(betaSend?.data?.alertId).toBe(beta.alert.id);
  });

  it("does not match a global subscription against an unrelated alert", async () => {
    const alphaAlert = makeSevereAlert("alpha-alert-1", "9", "Alpha line nine halted");
    const betaAlert = makeSevereAlert("beta-alert-2", "4", "Beta line four blocked");
    fixtures.providers = [
      makeProvider("alpha", { snapshotFactory: makeSnapshot("alpha", [alphaAlert]) }),
      makeProvider("beta", { snapshotFactory: makeSnapshot("beta", [betaAlert]) }),
    ];
    fixtures.seeds.alpha = [makeSub("alice", ["9"], "alpha")];

    await runEvaluationCycle();

    expect(fixtures.sent).toHaveLength(1);
    expect(fixtures.sent[0]?.endpoint).toBe("https://push.example.com/alice");
    expect(fixtures.sent[0]?.data?.alertId).toBe("alpha-alert-1");
  });

  it("reads browser-synced subscriptions from the dedicated notification store", async () => {
    const alert = makeSevereAlert(
      "line-2-alert",
      "2",
      "Line 2 suspended between Ossington and Woodbine",
    );
    fixtures.providers = [makeProvider("ttc", { snapshotFactory: makeSnapshot("ttc", [alert]) })];
    fixtures.notificationsSeeds = [makeSub("alice", ["2"], "ttc")];

    await runEvaluationCycle();

    expect(fixtures.sent).toHaveLength(1);
    expect(fixtures.sent[0]?.endpoint).toBe("https://push.example.com/alice");
    expect(fixtures.sent[0]?.data?.alertId).toBe("line-2-alert");
  });

  it("still evaluates healthy agencies when a snapshot port fails, then rejects the cycle", async () => {
    const beta = makeHealthyBeta();
    fixtures.providers = [
      makeProvider("alpha", {
        snapshotFactory: async () => {
          throw new Error("alpha feed exploded");
        },
      }),
      beta.provider,
    ];
    fixtures.seeds.beta = [beta.subscriber];
    fixtures.notificationsSeeds = [beta.subscriber, makeSub("alpha-rider", ["1"], "alpha")];

    await expect(runEvaluationCycle()).rejects.toThrowError(/alpha/);

    expect(fixtures.sent).toHaveLength(1);
    expect(fixtures.sent[0]?.endpoint).toBe("https://push.example.com/bob");
    expect(fixtures.sent[0]?.data?.alertId).toBe(beta.alert.id);
  });

  it("skips providers without a snapshot port without failing the cycle", async () => {
    const beta = makeHealthyBeta();
    fixtures.providers = [makeProvider("gamma"), beta.provider];
    fixtures.seeds.beta = [beta.subscriber];

    await runEvaluationCycle();

    expect(
      loggerMocks.debug.mock.calls.some(
        ([message, details]) =>
          String(message).includes("no snapshot port") &&
          (details as { agencyId?: string } | undefined)?.agencyId === "gamma",
      ),
    ).toBe(true);
    expect(fixtures.sent).toHaveLength(1);
    expect(fixtures.sent[0]?.endpoint).toBe("https://push.example.com/bob");
  });
});
