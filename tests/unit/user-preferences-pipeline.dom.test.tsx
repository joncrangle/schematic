// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@solidjs/web/server-functions", () => ({
  invoke: (fn: (...args: unknown[]) => unknown, _options: unknown, ...args: unknown[]) =>
    fn(...args),
}));
import { cleanup, render } from "@solidjs/testing-library";
import { DEFAULT_PREFERENCES, type UserPreferences } from "~/domain/preferences/UserPreferences";

vi.mock("~/services/notifications/NotificationClient", () => ({
  syncPushSubscription: vi.fn().mockResolvedValue({ success: true }),
  getVapidPublicKey: vi.fn().mockResolvedValue({ configured: true, publicKey: "AQID" }),
  deletePushSubscription: vi.fn().mockResolvedValue({ success: true }),
}));

import {
  syncPushSubscription,
  getVapidPublicKey,
} from "~/services/notifications/NotificationClient";
import * as PushNotificationService from "~/services/notifications/PushNotificationService";
import {
  UserPreferencesProvider,
  useUserPreferences,
  type UserPreferencesContextValue,
} from "~/context/UserPreferencesContext";
import {
  PREFERENCES_STORAGE_KEY,
  type PreferencesStorage,
} from "~/infrastructure/storage/PreferencesStorage";
import { MemoryLocalStorage } from "../helpers/fixtures";

const syncPushSubscriptionMock = vi.mocked(syncPushSubscription);

const FAKE_SUBSCRIPTION_JSON = {
  endpoint: "https://fcm.googleapis.com/fcm/send/test-endpoint",
  keys: { p256dh: "test-p256dh-key", auth: "test-auth-key" },
};

beforeEach(() => {
  const storage = new MemoryLocalStorage();
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  vi.stubGlobal("localStorage", storage);
  document.documentElement.removeAttribute("data-reduced-motion");
});

function stubActivePushSubscription(
  ready: Promise<{
    pushManager: {
      getSubscription: () => Promise<{ toJSON: () => typeof FAKE_SUBSCRIPTION_JSON }>;
    };
  }> = Promise.resolve({
    pushManager: {
      getSubscription: async () => ({ toJSON: () => FAKE_SUBSCRIPTION_JSON }),
    },
  }),
) {
  vi.stubGlobal("PushManager", {});
  vi.stubGlobal("Notification", { permission: "default" });
  const serviceWorker = {
    getRegistration: async () => ({
      active: {},
      pushManager: { getSubscription: async () => null },
    }),
    ready,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: serviceWorker,
  });
  return serviceWorker;
}

function stubInactivePushSubscription() {
  vi.stubGlobal("PushManager", {});
  vi.stubGlobal("Notification", { permission: "default" });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      ready: Promise.resolve({
        pushManager: { getSubscription: async () => null },
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
}

interface CapturedContext {
  value?: UserPreferencesContextValue;
}

function renderPreferencesHarness(captured: CapturedContext, storage?: PreferencesStorage) {
  function Probe() {
    captured.value = useUserPreferences();
    return null;
  }
  render(() => (
    <UserPreferencesProvider storage={storage}>
      <Probe />
    </UserPreferencesProvider>
  ));
}

async function waitForLoaded(captured: CapturedContext) {
  expect(captured.value?.isLoaded()).toBe(false);
  for (let i = 0; i < 100 && !captured.value?.isLoaded(); i += 1) {
    await vi.advanceTimersByTimeAsync(10);
  }
  expect(captured.value?.isLoaded()).toBe(true);
}

function flushPersistencePipeline() {
  return vi.advanceTimersByTimeAsync(50);
}

function readPersistedPreferences(): UserPreferences {
  const raw = window.localStorage.getItem(PREFERENCES_STORAGE_KEY);
  expect(raw).toBeTruthy();
  return JSON.parse(raw as string) as UserPreferences;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator as { serviceWorker?: unknown }, "serviceWorker");
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe("UserPreferences hydration and optimistic mutations", () => {
  it.each([
    {
      label: "keeps a pre-load favourite-line mutation",
      hydrated: DEFAULT_PREFERENCES,
      mutate: (preferences: UserPreferencesContextValue) =>
        preferences.setPreference("favouriteLines", [{ agencyId: "ttc", lineId: "1" }]),
      assertOptimistic: (preferences: UserPreferencesContextValue) =>
        expect(preferences.preferences.favouriteLines).toEqual([{ agencyId: "ttc", lineId: "1" }]),
      assertHydrated: (preferences: UserPreferencesContextValue) =>
        expect(preferences.preferences.favouriteLines).toEqual([{ agencyId: "ttc", lineId: "1" }]),
    },
    {
      label: "replays a pre-load surface-route toggle against hydrated preferences",
      hydrated: {
        ...DEFAULT_PREFERENCES,
        favouriteLines: [{ agencyId: "ttc", lineId: "2" }],
        favouriteSurfaceRoutes: [{ agencyId: "ttc", routeId: "501" }],
      },
      mutate: (preferences: UserPreferencesContextValue) =>
        preferences.toggleFavouriteSurfaceRoute("ttc", "501"),
      assertOptimistic: (preferences: UserPreferencesContextValue) =>
        expect(preferences.preferences.favouriteSurfaceRoutes).toEqual([
          { agencyId: "ttc", routeId: "501" },
        ]),
      assertHydrated: (preferences: UserPreferencesContextValue) => {
        expect(preferences.preferences.favouriteSurfaceRoutes).toEqual([]);
        expect(preferences.preferences.favouriteLines).toEqual([{ agencyId: "ttc", lineId: "2" }]);
      },
    },
  ])("$label", async ({ hydrated, mutate, assertOptimistic, assertHydrated }) => {
    vi.useFakeTimers();
    let resolveLoad!: (preferences: typeof hydrated) => void;
    const save = vi.fn().mockResolvedValue(undefined);
    const captured: CapturedContext = {};
    renderPreferencesHarness(captured, {
      load: () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
      save,
    });

    mutate(captured.value!);
    assertOptimistic(captured.value!);
    expect(save).toHaveBeenCalled();

    resolveLoad(hydrated);
    await waitForLoaded(captured);
    assertHydrated(captured.value!);
  });

  it("keeps optimistic state applied when persistence fails", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockRejectedValue(new Error("storage unavailable"));
    const captured: CapturedContext = {};
    renderPreferencesHarness(captured, {
      load: vi.fn().mockResolvedValue(DEFAULT_PREFERENCES),
      save,
    });
    await waitForLoaded(captured);

    captured.value?.setPreference("favouriteLines", [{ agencyId: "ttc", lineId: "1" }]);
    await flushPersistencePipeline();

    expect(captured.value?.preferences.favouriteLines).toEqual([{ agencyId: "ttc", lineId: "1" }]);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ favouriteLines: [{ agencyId: "ttc", lineId: "1" }] }),
    );
  });

  it.each([
    {
      label: "reduced-motion override",
      stored: { ...DEFAULT_PREFERENCES, reducedMotion: "reduce" as const },
      assertLoaded: (preferences: UserPreferencesContextValue) =>
        expect(preferences.preferences.reducedMotion).toBe("reduce"),
    },
    {
      label: "favourites and reduced motion together",
      stored: {
        ...DEFAULT_PREFERENCES,
        favouriteLines: [
          { agencyId: "ttc", lineId: "1" },
          { agencyId: "ttc", lineId: "2" },
        ],
        reducedMotion: "reduce" as const,
      },
      assertLoaded: (preferences: UserPreferencesContextValue) => {
        expect(preferences.preferences.favouriteLines).toHaveLength(2);
        expect(preferences.preferences.reducedMotion).toBe("reduce");
      },
    },
  ])(
    "hydrates $label without storage writes and repairs the push mirror",
    async ({ stored, assertLoaded }) => {
      vi.useFakeTimers();
      stubActivePushSubscription();
      window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(stored));
      const setItemSpy = vi.spyOn(window.localStorage, "setItem");
      const captured: CapturedContext = {};
      renderPreferencesHarness(captured);
      await waitForLoaded(captured);
      await vi.advanceTimersByTimeAsync(5000);

      assertLoaded(captured.value!);
      expect(document.documentElement.getAttribute("data-reduced-motion")).toBe("true");
      expect(setItemSpy.mock.calls.filter(([key]) => key === PREFERENCES_STORAGE_KEY)).toHaveLength(
        0,
      );
      expect(syncPushSubscriptionMock).toHaveBeenCalledOnce();
      expect(syncPushSubscriptionMock.mock.calls[0]?.[0].favouriteLines).toEqual(
        stored.favouriteLines,
      );
    },
  );
});

describe("UserPreferences persistence and agency qualification", () => {
  it.each(["line", "surface-route"] as const)(
    "qualifies identical %s ids by agency and persists add/remove transitions",
    async (kind) => {
      vi.useFakeTimers();
      const captured: CapturedContext = {};
      renderPreferencesHarness(captured);
      await waitForLoaded(captured);

      const add = (agencyId: string) =>
        kind === "line"
          ? captured.value?.toggleFavouriteLine(agencyId, "2")
          : captured.value?.toggleFavouriteSurfaceRoute(agencyId, "501");
      const expected = (agencyId: string) =>
        kind === "line" ? { agencyId, lineId: "2" } : { agencyId, routeId: "501" };

      add("ttc");
      add("kingston");
      await flushPersistencePipeline();

      expect(captured.value?.preferences.favouriteLines).toEqual(
        kind === "line" ? [expected("ttc"), expected("kingston")] : [],
      );
      expect(captured.value?.preferences.favouriteSurfaceRoutes).toEqual(
        kind === "surface-route" ? [expected("ttc"), expected("kingston")] : [],
      );
      const firstPersisted = readPersistedPreferences();
      expect(
        kind === "line" ? firstPersisted.favouriteLines : firstPersisted.favouriteSurfaceRoutes,
      ).toEqual([expected("ttc"), expected("kingston")]);

      add("ttc");
      await flushPersistencePipeline();

      expect(
        kind === "line"
          ? captured.value?.preferences.favouriteLines
          : captured.value?.preferences.favouriteSurfaceRoutes,
      ).toEqual([expected("kingston")]);
      const secondPersisted = readPersistedPreferences();
      expect(
        kind === "line" ? secondPersisted.favouriteLines : secondPersisted.favouriteSurfaceRoutes,
      ).toEqual([expected("kingston")]);
    },
  );

  it("persists non-push UI preferences without mirroring them", async () => {
    vi.useFakeTimers();
    stubActivePushSubscription();
    const setItemSpy = vi.spyOn(window.localStorage, "setItem");
    const captured: CapturedContext = {};
    renderPreferencesHarness(captured);
    await waitForLoaded(captured);
    await vi.advanceTimersByTimeAsync(1000);
    syncPushSubscriptionMock.mockClear();

    captured.value?.setPreference("dateOrder", "dmy");
    captured.value?.setPreference("timeFormat", "24h");
    captured.value?.setPreference("unitSystem", "imperial");
    captured.value?.setPreference("reducedMotion", "reduce");
    captured.value?.setPreference("showReducedSpeedZones", false);
    captured.value?.setPreference("interchangeBadgeVisibility", "hidden");
    await flushPersistencePipeline();
    await vi.advanceTimersByTimeAsync(5000);

    expect(setItemSpy.mock.calls.filter(([key]) => key === PREFERENCES_STORAGE_KEY)).toHaveLength(
      6,
    );
    expect(readPersistedPreferences()).toMatchObject({
      dateOrder: "dmy",
      timeFormat: "24h",
      unitSystem: "imperial",
    });
    expect(syncPushSubscriptionMock).not.toHaveBeenCalled();
    expect(document.documentElement.getAttribute("data-reduced-motion")).toBe("true");
    expect(readPersistedPreferences()).toMatchObject({
      reducedMotion: "reduce",
      showReducedSpeedZones: false,
      interchangeBadgeVisibility: "hidden",
    });
  });

  it("persists agency favourites without treating them as push-relevant", async () => {
    vi.useFakeTimers();
    stubActivePushSubscription();
    const captured: CapturedContext = {};
    renderPreferencesHarness(captured);
    await waitForLoaded(captured);
    await vi.advanceTimersByTimeAsync(1000);
    syncPushSubscriptionMock.mockClear();

    captured.value?.toggleFavouriteAgency("go");
    await flushPersistencePipeline();
    expect(captured.value?.preferences.favouriteAgencies).toEqual(["go"]);
    expect(readPersistedPreferences().favouriteAgencies).toEqual(["go"]);

    await vi.advanceTimersByTimeAsync(5000);
    expect(syncPushSubscriptionMock).not.toHaveBeenCalled();

    captured.value?.toggleFavouriteAgency("go");
    await flushPersistencePipeline();
    expect(captured.value?.preferences.favouriteAgencies).toEqual([]);
    expect(readPersistedPreferences().favouriteAgencies).toEqual([]);
  });

  it("re-derives reduced motion when the OS preference changes", async () => {
    vi.useFakeTimers();
    let osReducedMotion = false;
    const changeListeners = new Set<(event: { matches: boolean }) => void>();
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation(() => ({
        matches: osReducedMotion,
        addEventListener: (_: string, listener: (event: { matches: boolean }) => void) =>
          changeListeners.add(listener),
        removeEventListener: (_: string, listener: (event: { matches: boolean }) => void) =>
          changeListeners.delete(listener),
      })),
    );
    const captured: CapturedContext = {};
    renderPreferencesHarness(captured);
    await waitForLoaded(captured);

    expect(document.documentElement.getAttribute("data-reduced-motion")).toBe("false");
    captured.value?.setPreference("reducedMotion", "reduce");
    await flushPersistencePipeline();
    expect(document.documentElement.getAttribute("data-reduced-motion")).toBe("true");

    osReducedMotion = true;
    for (const listener of changeListeners) listener({ matches: true });
    captured.value?.setPreference("reducedMotion", "system");
    await flushPersistencePipeline();
    expect(document.documentElement.getAttribute("data-reduced-motion")).toBe("true");

    for (const listener of changeListeners) listener({ matches: false });
    await flushPersistencePipeline();
    expect(document.documentElement.getAttribute("data-reduced-motion")).toBe("false");
  });
});

describe("UserPreferences push and debounce policy", () => {
  it("waits for hydration before healing and remirrors the saved subscription policy", async () => {
    vi.useFakeTimers();
    stubActivePushSubscription();
    const heal = vi
      .spyOn(PushNotificationService, "checkAndHealPushSubscription")
      .mockResolvedValue("not-needed");
    let resolveLoad!: (preferences: UserPreferences) => void;
    const load = new Promise<UserPreferences>((resolve) => {
      resolveLoad = resolve;
    });
    const captured: CapturedContext = {};
    renderPreferencesHarness(captured, { load: () => load, save: async () => {} });
    await vi.advanceTimersByTimeAsync(2000);
    expect(heal).not.toHaveBeenCalled();
    const saved = { ...DEFAULT_PREFERENCES, favouriteLines: [{ agencyId: "metro", lineId: "A" }] };
    resolveLoad(saved);
    await vi.advanceTimersByTimeAsync(1100);
    expect(heal).toHaveBeenCalledOnce();
    const source = heal.mock.calls[0]![0];
    expect(typeof source === "function" ? source() : source).toMatchObject({
      favouriteLines: saved.favouriteLines,
    });
    expect(syncPushSubscriptionMock).toHaveBeenCalledWith(
      expect.objectContaining({ favouriteLines: saved.favouriteLines }),
    );
  });

  it("serializes slow mirrors so the newest preferences reach the server last", async () => {
    vi.useFakeTimers();
    stubActivePushSubscription();
    const captured: CapturedContext = {};
    renderPreferencesHarness(captured);
    await waitForLoaded(captured);
    let completeFirst!: () => void;
    syncPushSubscriptionMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeFirst = () => resolve({ success: true });
        }),
    );
    captured.value!.toggleFavouriteLine("metro", "A");
    await vi.advanceTimersByTimeAsync(1000);
    captured.value!.toggleFavouriteLine("metro", "B");
    await vi.advanceTimersByTimeAsync(1000);
    expect(syncPushSubscriptionMock).toHaveBeenCalledTimes(1);
    completeFirst();
    await vi.advanceTimersByTimeAsync(1000);
    expect(syncPushSubscriptionMock).toHaveBeenCalledTimes(2);
    expect(syncPushSubscriptionMock.mock.calls[1]?.[0].favouriteLines).toEqual([
      { agencyId: "metro", lineId: "A" },
      { agencyId: "metro", lineId: "B" },
    ]);
  });

  it("retries a failed preference mirror without requiring another edit", async () => {
    vi.useFakeTimers();
    stubActivePushSubscription();
    syncPushSubscriptionMock.mockRejectedValueOnce(new Error("offline"));
    const captured: CapturedContext = {};
    renderPreferencesHarness(captured);
    await waitForLoaded(captured);
    captured.value!.toggleFavouriteLine("metro", "A");
    await vi.advanceTimersByTimeAsync(1000);
    expect(syncPushSubscriptionMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(syncPushSubscriptionMock).toHaveBeenCalledTimes(2);
    expect(syncPushSubscriptionMock.mock.calls[1]?.[0].favouriteLines).toEqual([
      { agencyId: "metro", lineId: "A" },
    ]);
  });

  it("repairs a failed mirror on reconnect after exhausting automatic retries", async () => {
    vi.useFakeTimers();
    stubActivePushSubscription();
    syncPushSubscriptionMock.mockRejectedValue(new Error("offline"));
    const captured: CapturedContext = {};
    renderPreferencesHarness(captured);
    await waitForLoaded(captured);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(syncPushSubscriptionMock).toHaveBeenCalledTimes(4);
    syncPushSubscriptionMock.mockResolvedValue({ success: true });
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(syncPushSubscriptionMock).toHaveBeenCalledTimes(5);
    cleanup();
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(syncPushSubscriptionMock).toHaveBeenCalledTimes(5);
  });

  it("does not sync after unmount while service worker readiness is pending", async () => {
    vi.useFakeTimers();
    let resolveReady!: (registration: {
      pushManager: {
        getSubscription: () => Promise<{ toJSON: () => typeof FAKE_SUBSCRIPTION_JSON }>;
      };
    }) => void;
    stubActivePushSubscription(
      new Promise((resolve) => {
        resolveReady = resolve;
      }),
    );
    const captured: CapturedContext = {};
    renderPreferencesHarness(captured);
    await waitForLoaded(captured);
    await vi.advanceTimersByTimeAsync(1000);
    cleanup();
    resolveReady({
      pushManager: { getSubscription: async () => ({ toJSON: () => FAKE_SUBSCRIPTION_JSON }) },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(syncPushSubscriptionMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "favourite line",
      mutate: (preferences: UserPreferencesContextValue) =>
        preferences.toggleFavouriteLine("ttc", "1"),
      expectedPayload: { favouriteLines: [{ agencyId: "ttc", lineId: "1" }] },
    },
    {
      label: "favourite station",
      mutate: (preferences: UserPreferencesContextValue) =>
        preferences.setPreference("favouriteStations", (previous) => [
          ...previous,
          { agencyId: "ttc", stationName: "Bloor-Yonge" },
        ]),
      expectedPayload: {
        favouriteStations: [{ agencyId: "ttc", stationName: "Bloor-Yonge" }],
      },
    },
  ])("persists a $label once before one delayed mirror", async ({ mutate, expectedPayload }) => {
    vi.useFakeTimers();
    stubActivePushSubscription();
    const setItemSpy = vi.spyOn(window.localStorage, "setItem");
    const captured: CapturedContext = {};
    renderPreferencesHarness(captured);
    await waitForLoaded(captured);

    mutate(captured.value!);
    await flushPersistencePipeline();

    expect(setItemSpy.mock.calls.filter(([key]) => key === PREFERENCES_STORAGE_KEY)).toHaveLength(
      1,
    );
    expect(syncPushSubscriptionMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);

    expect(syncPushSubscriptionMock).toHaveBeenCalledOnce();
    expect(syncPushSubscriptionMock.mock.calls[0]?.[0]).toMatchObject(expectedPayload);
    expect(readPersistedPreferences()).toMatchObject(expectedPayload);
    expect(setItemSpy.mock.calls.filter(([key]) => key === PREFERENCES_STORAGE_KEY)).toHaveLength(
      1,
    );
  });

  it("waits exactly 1,000 ms before the first push mirror", async () => {
    vi.useFakeTimers();
    stubActivePushSubscription();
    const captured: CapturedContext = {};
    renderPreferencesHarness(captured);
    await waitForLoaded(captured);

    captured.value?.toggleFavouriteLine("ttc", "1");
    await vi.advanceTimersByTimeAsync(999);
    expect(syncPushSubscriptionMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(syncPushSubscriptionMock).toHaveBeenCalledOnce();
  });

  it("coalesces rapid push-relevant mutations into the latest state", async () => {
    vi.useFakeTimers();
    stubActivePushSubscription();
    const captured: CapturedContext = {};
    renderPreferencesHarness(captured);
    await waitForLoaded(captured);

    captured.value?.toggleFavouriteLine("ttc", "1");
    await vi.advanceTimersByTimeAsync(600);
    captured.value?.toggleFavouriteLine("ttc", "2");
    await vi.advanceTimersByTimeAsync(600);
    captured.value?.toggleFavouriteLine("ttc", "2");
    await vi.advanceTimersByTimeAsync(1000);

    expect(syncPushSubscriptionMock).toHaveBeenCalledOnce();
    expect(syncPushSubscriptionMock.mock.calls[0]?.[0].favouriteLines).toEqual([
      { agencyId: "ttc", lineId: "1" },
    ]);
  });

  it("does not move the original push deadline when a non-push preference changes", async () => {
    vi.useFakeTimers();
    stubActivePushSubscription();
    const captured: CapturedContext = {};
    renderPreferencesHarness(captured);
    await waitForLoaded(captured);

    captured.value?.setPreference("favouriteLines", [{ agencyId: "ttc", lineId: "1" }]);
    await vi.advanceTimersByTimeAsync(600);
    captured.value?.setPreference("reducedMotion", "reduce");
    await vi.advanceTimersByTimeAsync(399);
    expect(syncPushSubscriptionMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(syncPushSubscriptionMock).toHaveBeenCalledOnce();
  });

  it.each(["unsupported", "inactive"] as const)(
    "skips the mirror when push support is %s",
    async (state) => {
      vi.useFakeTimers();
      const supportSpy =
        state === "unsupported"
          ? vi.spyOn(PushNotificationService, "isPushSupported").mockReturnValue(false)
          : undefined;
      if (state === "inactive") stubInactivePushSubscription();
      const captured: CapturedContext = {};
      renderPreferencesHarness(captured);
      await waitForLoaded(captured);

      captured.value?.toggleFavouriteLine("ttc", "1");
      await vi.advanceTimersByTimeAsync(5000);

      expect((supportSpy?.mock.calls.length ?? 0) > 0).toBe(state === "unsupported");
      expect(syncPushSubscriptionMock).not.toHaveBeenCalled();
    },
  );

  it("skips the mirror when service-worker readiness rejects", async () => {
    vi.useFakeTimers();
    let rejectReady!: (reason: unknown) => void;
    const ready = new Promise<{
      pushManager: {
        getSubscription: () => Promise<{ toJSON: () => typeof FAKE_SUBSCRIPTION_JSON }>;
      };
    }>((_resolve, reject) => {
      rejectReady = reject;
    });
    void ready.catch(() => undefined);
    stubActivePushSubscription(ready);
    const captured: CapturedContext = {};
    renderPreferencesHarness(captured);
    await waitForLoaded(captured);

    captured.value?.toggleFavouriteLine("ttc", "1");
    await vi.advanceTimersByTimeAsync(999);
    rejectReady(new Error("service worker unavailable"));
    await vi.advanceTimersByTimeAsync(1);

    expect(syncPushSubscriptionMock).not.toHaveBeenCalled();
  });

  it("mirrors reset defaults after applying them optimistically", async () => {
    vi.useFakeTimers();
    stubActivePushSubscription();
    window.localStorage.setItem(
      PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_PREFERENCES,
        favouriteLines: [{ agencyId: "ttc", lineId: "1" }],
        reducedMotion: "reduce",
      }),
    );
    const setItemSpy = vi.spyOn(window.localStorage, "setItem");
    const captured: CapturedContext = {};
    renderPreferencesHarness(captured);
    await waitForLoaded(captured);
    expect(document.documentElement.getAttribute("data-reduced-motion")).toBe("true");

    setItemSpy.mockClear();
    captured.value?.resetPreferences();
    await flushPersistencePipeline();

    expect(captured.value?.preferences.reducedMotion).toBe("system");
    expect(document.documentElement.getAttribute("data-reduced-motion")).toBe("false");
    expect(setItemSpy.mock.calls.filter(([key]) => key === PREFERENCES_STORAGE_KEY)).toHaveLength(
      1,
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(syncPushSubscriptionMock.mock.calls[0]?.[0]).toMatchObject({
      commuteSchedules: DEFAULT_PREFERENCES.commuteSchedules,
      favouriteLines: [],
    });
  });

  it("persists commute-schedule add, update, and removal transitions", async () => {
    vi.useFakeTimers();
    stubActivePushSubscription();
    const captured: CapturedContext = {};
    renderPreferencesHarness(captured);
    await waitForLoaded(captured);

    captured.value?.addCommuteSchedule({
      id: "cs-1",
      label: "Morning",
      enabled: true,
      days: [1, 2, 3, 4, 5],
      start: "07:30",
      end: "09:30",
    });
    captured.value?.updateCommuteSchedule("cs-1", { label: "Morning commute" });
    await flushPersistencePipeline();
    await vi.advanceTimersByTimeAsync(1000);

    expect(
      readPersistedPreferences().commuteSchedules.find((schedule) => schedule.id === "cs-1")?.label,
    ).toBe("Morning commute");
    expect(
      syncPushSubscriptionMock.mock.calls[0]?.[0].commuteSchedules.find(
        (schedule) => schedule.id === "cs-1",
      )?.label,
    ).toBe("Morning commute");

    captured.value?.removeCommuteSchedule("cs-1");
    await flushPersistencePipeline();
    await vi.advanceTimersByTimeAsync(1000);

    expect(
      readPersistedPreferences().commuteSchedules.some((schedule) => schedule.id === "cs-1"),
    ).toBe(false);
    expect(
      syncPushSubscriptionMock.mock.calls[1]?.[0].commuteSchedules.some(
        (schedule) => schedule.id === "cs-1",
      ),
    ).toBe(false);
  });
});

describe("UserPreferences lifecycle cleanup", () => {
  it("removes the service-worker message listener on unmount", async () => {
    vi.useFakeTimers();
    const serviceWorker = stubActivePushSubscription();
    const captured: CapturedContext = {};
    renderPreferencesHarness(captured);
    await waitForLoaded(captured);

    const registration = serviceWorker.addEventListener.mock.calls.find(
      ([type]) => type === "message",
    );
    expect(registration).toBeDefined();

    cleanup();

    expect(serviceWorker.removeEventListener).toHaveBeenCalledWith("message", registration?.[1]);
  });

  it("persists immediately but cancels a pending push mirror on unmount", async () => {
    vi.useFakeTimers();
    stubActivePushSubscription();
    const setItemSpy = vi.spyOn(window.localStorage, "setItem");
    const captured: CapturedContext = {};
    renderPreferencesHarness(captured);
    await waitForLoaded(captured);

    captured.value?.toggleFavouriteStation("ttc", "705");
    cleanup();
    await vi.advanceTimersByTimeAsync(5000);

    expect(setItemSpy.mock.calls.filter(([key]) => key === PREFERENCES_STORAGE_KEY)).toHaveLength(
      1,
    );
    expect(syncPushSubscriptionMock).not.toHaveBeenCalled();
  });
});

describe("push reconciliation review regressions", () => {
  it("mirrors the latest favourites after a reactive heal finishes", async () => {
    vi.useFakeTimers();
    const worker = stubActivePushSubscription();
    vi.spyOn(PushNotificationService, "checkAndHealPushSubscription").mockResolvedValue(
      "not-needed",
    );
    vi.stubGlobal("Notification", {
      permission: "granted",
      requestPermission: async () => "granted",
    });
    const subscription = { toJSON: () => FAKE_SUBSCRIPTION_JSON, unsubscribe: async () => true };
    Object.defineProperty(worker, "getRegistration", {
      value: async () => ({
        active: {},
        pushManager: {
          getSubscription: async () => subscription,
          subscribe: async () => subscription,
        },
      }),
    });
    const captured: CapturedContext = {};
    renderPreferencesHarness(captured);
    await waitForLoaded(captured);
    captured.value!.setPreference("favouriteLines", [{ agencyId: "metro", lineId: "A" }]);
    await vi.advanceTimersByTimeAsync(1000);
    syncPushSubscriptionMock.mockClear();
    let releaseHeal!: () => void;
    let serverLines: unknown;
    syncPushSubscriptionMock
      .mockImplementationOnce(
        (input) =>
          new Promise((resolve) => {
            releaseHeal = () => {
              serverLines = input.favouriteLines;
              resolve({ success: true });
            };
          }),
      )
      .mockImplementation(async (input) => {
        serverLines = input.favouriteLines;
        return { success: true };
      });
    const handler = worker.addEventListener.mock.calls.find(([type]) => type === "message")![1];
    handler({ data: { type: PushNotificationService.PUSH_UNREADABLE_MESSAGE_TYPE } });
    await vi.advanceTimersByTimeAsync(1000);
    captured.value!.setPreference("favouriteLines", [{ agencyId: "metro", lineId: "B" }]);
    await vi.advanceTimersByTimeAsync(1000);
    releaseHeal();
    await vi.advanceTimersByTimeAsync(1000);
    expect(serverLines).toEqual([{ agencyId: "metro", lineId: "B" }]);
  });

  it("recovers from a stalled startup mirror after an edit and reconnect", async () => {
    vi.useFakeTimers();
    stubActivePushSubscription();
    vi.spyOn(PushNotificationService, "checkAndHealPushSubscription").mockResolvedValue(
      "not-needed",
    );
    syncPushSubscriptionMock.mockImplementationOnce(() => new Promise(() => {}));
    const captured: CapturedContext = {};
    renderPreferencesHarness(captured);
    await waitForLoaded(captured);
    await vi.advanceTimersByTimeAsync(1000);
    captured.value!.setPreference("favouriteLines", [{ agencyId: "metro", lineId: "B" }]);
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(syncPushSubscriptionMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        favouriteLines: [{ agencyId: "metro", lineId: "B" }],
      }),
    );
  });
});

describe("push health recovery regressions", () => {
  it("retries failed VAPID health check when connectivity returns", async () => {
    vi.useFakeTimers();
    const sw = stubActivePushSubscription();
    vi.stubGlobal("Notification", {
      permission: "granted",
      requestPermission: async () => "granted",
    });
    const sub = {
      toJSON: () => FAKE_SUBSCRIPTION_JSON,
      options: { applicationServerKey: new Uint8Array([4, 5, 6]).buffer },
      unsubscribe: vi.fn(async () => true),
    };
    Object.defineProperty(sw, "getRegistration", {
      value: async () => ({
        active: {},
        pushManager: { getSubscription: async () => sub, subscribe: async () => sub },
      }),
    });
    vi.mocked(getVapidPublicKey).mockRejectedValueOnce(new Error("offline"));
    const captured: CapturedContext = {};
    renderPreferencesHarness(captured);
    await waitForLoaded(captured);
    await vi.advanceTimersByTimeAsync(1000);
    expect(getVapidPublicKey).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(30000);
    expect(vi.mocked(getVapidPublicKey).mock.calls.length).toBeGreaterThan(1);
    expect(sub.unsubscribe).toHaveBeenCalled();
  });
  it("releases a stalled browser registration without dispatching after its late completion", async () => {
    vi.useFakeTimers();
    const sw = stubActivePushSubscription();
    vi.stubGlobal("Notification", {
      permission: "granted",
      requestPermission: async () => "granted",
    });
    const sub = {
      toJSON: () => FAKE_SUBSCRIPTION_JSON,
      options: { applicationServerKey: new Uint8Array([4, 5, 6]).buffer },
      unsubscribe: async () => true,
    };
    let finishRegistration!: (subscription: typeof sub) => void;
    Object.defineProperty(sw, "getRegistration", {
      value: async () => ({
        active: {},
        pushManager: {
          getSubscription: async () => sub,
          subscribe: async () =>
            new Promise((resolve) => {
              finishRegistration = resolve;
            }),
        },
      }),
    });
    const captured: CapturedContext = {};
    renderPreferencesHarness(captured);
    await waitForLoaded(captured);
    await vi.advanceTimersByTimeAsync(1000);
    captured.value!.toggleFavouriteLine("metro", "B");
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(60000);
    expect(syncPushSubscriptionMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ favouriteLines: [{ agencyId: "metro", lineId: "B" }] }),
    );
    syncPushSubscriptionMock.mockClear();
    finishRegistration(sub);
    await vi.advanceTimersByTimeAsync(1000);
    expect(syncPushSubscriptionMock).not.toHaveBeenCalled();
  });
});
