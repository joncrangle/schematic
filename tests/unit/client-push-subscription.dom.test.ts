// @vitest-environment happy-dom
/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@solidjs/web/server-functions", () => ({
  invoke: (fn: (...args: unknown[]) => unknown, _options: unknown, ...args: unknown[]) =>
    fn(...args),
}));
import { MemoryLocalStorage } from "../helpers/fixtures";
import {
  checkAndHealPushSubscription,
  getStoredVapidKey,
  healPushSubscription,
  registerPushHealListener,
  subscribeToPush,
  unsubscribeFromPush,
  urlBase64ToUint8Array,
  HEAL_TIMESTAMP_STORAGE_KEY,
  STORED_VAPID_KEY_STORAGE_KEY,
} from "~/services/notifications/PushNotificationService";
import { DEFAULT_PREFERENCES, type UserPreferences } from "~/domain/preferences/UserPreferences";
import {
  buildSyncPushSubscriptionPayload,
  resolveLocalTimezone,
} from "~/services/notifications/PushSyncPayload";

const { getVapidKeyMock, syncMock, deleteMock } = vi.hoisted(() => ({
  getVapidKeyMock: vi.fn(),
  syncMock: vi.fn(),
  deleteMock: vi.fn(),
}));

// The three network-touching server fns are replaced file-wide; every other
// export (urlBase64ToUint8Array etc.) stays real. Defaults are re-seeded in
// beforeEach so the pre-existing cases below keep their original semantics.
vi.mock("~/services/notifications/NotificationClient", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/services/notifications/NotificationClient")>();
  return {
    ...actual,
    getVapidPublicKey: getVapidKeyMock,
    syncPushSubscription: syncMock,
    deletePushSubscription: deleteMock,
  };
});

const SERVER_KEY_A =
  "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-TsZAbjTkPIUUKNdARYnnEWhqqU";
const SERVER_KEY_B =
  "AABBCCDDEEFF00112233445566778899aabbccddeeff00112233445566778899aabbcCddeEff0011223344556677889";
const originalWindowFetch = Object.getOwnPropertyDescriptor(window, "fetch");
let browserFetch: ReturnType<typeof vi.fn>;

function makePrefs(): UserPreferences {
  return {
    version: 1,
    dateOrder: "locale",
    timeFormat: "locale",
    unitSystem: "locale",
    spelling: "locale",
    locale: "en-CA",
    reducedMotion: "system",
    showReducedSpeedZones: true,
    interchangeBadgeVisibility: "compact",
    favouriteLines: [{ agencyId: "ttc", lineId: "1" }],
    favouriteStations: [],
    favouriteSurfaceRoutes: [],
    favouriteAgencies: [],
    commuteSchedules: [],
    agency: "auto",
  };
}

interface FakeSubscription {
  endpoint: string;
  toJSON: () => {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
  unsubscribe: ReturnType<typeof vi.fn>;
  options?: { applicationServerKey: ArrayBuffer };
}

function makeFakeSubscription(): FakeSubscription {
  return {
    endpoint: "https://fcm.googleapis.com/fcm/send/fake-endpoint",
    toJSON: () => ({
      endpoint: "https://fcm.googleapis.com/fcm/send/fake-endpoint",
      keys: { p256dh: "fake-p256dh", auth: "fake-auth" },
    }),
    unsubscribe: vi.fn(async () => {}),
  };
}

/**
 * Installs a navigator.serviceWorker stub whose registration exposes a
 * pushManager with the given live subscription; `subscribe` yields fresh
 * subscriptions (as a browser would with the new applicationServerKey).
 */
function setupServiceWorkerWorld(options: {
  subscription?: FakeSubscription | null;
  onSubscribe?: () => FakeSubscription;
}) {
  const subscribe = vi.fn(options.onSubscribe ?? ((): FakeSubscription => makeFakeSubscription()));
  const registration = {
    active: {} as unknown,
    pushManager: {
      getSubscription: vi.fn(async () => options.subscription ?? null),
      subscribe,
    },
  };
  Object.defineProperty(navigator, "serviceWorker", {
    value: {
      getRegistration: vi.fn(async () => registration),
      ready: Promise.resolve(registration),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    configurable: true,
  });
  return { registration, subscribe };
}

function stubPushGlobalsGranted() {
  vi.stubGlobal("Notification", {
    permission: "granted",
    requestPermission: vi.fn().mockResolvedValue("granted"),
  });
  vi.stubGlobal("PushManager", {});
}

describe("Client Push Subscription Helpers & Lifecycle", () => {
  beforeEach(() => {
    // All notification server functions are mocked above. A browser request
    // here would be an accidental dependency and otherwise remains active
    // until happy-dom aborts it while tearing down the test window.
    browserFetch = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", browserFetch);
    Object.defineProperty(window, "fetch", {
      configurable: true,
      writable: true,
      value: browserFetch,
    });

    const storage = new MemoryLocalStorage();
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
    vi.stubGlobal("localStorage", storage);

    getVapidKeyMock.mockReset();
    syncMock.mockReset();
    deleteMock.mockReset();
    // Mirror the unconfigured-server default the real RPC produces in tests.
    getVapidKeyMock.mockResolvedValue({
      configured: false,
      publicKey: null,
      error: "VAPID keys not configured",
    });
    syncMock.mockResolvedValue({ success: true });
    deleteMock.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    expect(browserFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    if (originalWindowFetch) Object.defineProperty(window, "fetch", originalWindowFetch);
  });

  it("decodes URL-safe base64 VAPID keys to exact bytes", () => {
    // Hand-computed vectors pin the URL-safe alphabet (- and _) handling,
    // which is where a homegrown decoder would silently corrupt keys.
    expect(Array.from(urlBase64ToUint8Array("-A"))).toEqual([0xf8]);
    expect(Array.from(urlBase64ToUint8Array("_w"))).toEqual([0xff]);

    const rawKey =
      "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-TsZAbjTkPIUUKNdARYnnEWhqqU";
    const bytes = urlBase64ToUint8Array(rawKey);
    // An uncompressed P-256 application key: 65 bytes starting with the 0x04 point prefix.
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(0x04);
    // Cross-check the full payload against Node's reference base64 decoder.
    const expected = Uint8Array.from(
      Buffer.from(rawKey.replaceAll("-", "+").replaceAll("_", "/"), "base64"),
    );
    expect(Array.from(bytes)).toEqual(Array.from(expected));

    // Empty input yields an empty array rather than throwing.
    expect(urlBase64ToUint8Array("").length).toBe(0);
  });

  it("returns permission_denied error result gracefully when push notification permission is not granted", async () => {
    vi.stubGlobal("Notification", {
      permission: "denied",
      requestPermission: vi.fn().mockResolvedValue("denied"),
    });
    vi.stubGlobal("PushManager", {});
    Object.defineProperty(navigator, "serviceWorker", {
      value: { ready: Promise.resolve({}) },
      configurable: true,
    });

    const result = await subscribeToPush(makePrefs());
    expect(result.success).toBe(false);
    expect(result.reason).toBe("permission_denied");
    expect(result.message).toContain("permission");

    vi.unstubAllGlobals();
  });

  it("returns vapid_unconfigured or network_error when VAPID keys are missing", async () => {
    vi.stubGlobal("Notification", {
      permission: "granted",
      requestPermission: vi.fn().mockResolvedValue("granted"),
    });
    vi.stubGlobal("PushManager", {});
    Object.defineProperty(navigator, "serviceWorker", {
      value: { ready: Promise.resolve({}) },
      configurable: true,
    });

    const result = await subscribeToPush(makePrefs());
    expect(result.success).toBe(false);
    expect(["vapid_unconfigured", "network_error"]).toContain(result.reason);
    expect(result.message).toBeTruthy();

    vi.unstubAllGlobals();
  });

  describe("stored VAPID key persistence", () => {
    it("records the VAPID public key used at subscribe time and getStoredVapidKey reads it back", async () => {
      stubPushGlobalsGranted();
      getVapidKeyMock.mockResolvedValue({ configured: true, publicKey: SERVER_KEY_A });
      setupServiceWorkerWorld({});

      const result = await subscribeToPush(makePrefs());
      expect(result.success).toBe(true);
      expect(syncMock).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem(STORED_VAPID_KEY_STORAGE_KEY)).toBe(SERVER_KEY_A);
      expect(getStoredVapidKey()).toBe(SERVER_KEY_A);

      vi.unstubAllGlobals();
    });

    it("does not record a stored key when subscription fails", async () => {
      stubPushGlobalsGranted();
      getVapidKeyMock.mockResolvedValue({
        configured: true,
        publicKey: SERVER_KEY_A,
      });
      setupServiceWorkerWorld({});
      syncMock.mockRejectedValue(new Error("server down"));

      const result = await subscribeToPush(makePrefs());
      expect(result.success).toBe(false);
      expect(localStorage.getItem(STORED_VAPID_KEY_STORAGE_KEY)).toBeNull();

      vi.unstubAllGlobals();
    });

    it("removes the stored VAPID key after a successful unsubscribe", async () => {
      vi.stubGlobal("Notification", { permission: "granted" });
      vi.stubGlobal("PushManager", {});
      localStorage.setItem(STORED_VAPID_KEY_STORAGE_KEY, SERVER_KEY_A);

      const sub = makeFakeSubscription();
      setupServiceWorkerWorld({ subscription: sub });

      const result = await unsubscribeFromPush();
      expect(result.success).toBe(true);
      expect(deleteMock).toHaveBeenCalledTimes(1);
      expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem(STORED_VAPID_KEY_STORAGE_KEY)).toBeNull();

      vi.unstubAllGlobals();
    });
  });

  describe("push subscription healing", () => {
    it("finishes a stalled key health check without destroying the subscription", async () => {
      stubPushGlobalsGranted();
      const sub = makeFakeSubscription();
      setupServiceWorkerWorld({ subscription: sub });
      getVapidKeyMock.mockImplementation(() => new Promise(() => {}));
      vi.useFakeTimers();
      try {
        const check = checkAndHealPushSubscription(makePrefs());
        await vi.advanceTimersByTimeAsync(6100);
        expect(await Promise.race([check, Promise.resolve("still-pending")])).toBe("failed");
        expect(sub.unsubscribe).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("heals a browser key mismatch even when local bookkeeping matches the server", async () => {
      stubPushGlobalsGranted();
      localStorage.setItem(STORED_VAPID_KEY_STORAGE_KEY, SERVER_KEY_A);
      getVapidKeyMock.mockResolvedValue({ configured: true, publicKey: SERVER_KEY_A });
      const sub = makeFakeSubscription();
      sub.options = {
        applicationServerKey: new Uint8Array(urlBase64ToUint8Array(SERVER_KEY_B)).buffer,
      };
      setupServiceWorkerWorld({ subscription: sub });
      expect(await checkAndHealPushSubscription(makePrefs())).toBe("healed");
      expect(sub.unsubscribe).toHaveBeenCalledOnce();
    });

    it.each([null, SERVER_KEY_B])(
      "uses the browser's matching key without tearing down when local bookkeeping is %s",
      async (storedKey) => {
        stubPushGlobalsGranted();
        if (storedKey) localStorage.setItem(STORED_VAPID_KEY_STORAGE_KEY, storedKey);
        getVapidKeyMock.mockResolvedValue({ configured: true, publicKey: SERVER_KEY_A });
        const sub = makeFakeSubscription();
        sub.options = {
          applicationServerKey: new Uint8Array(urlBase64ToUint8Array(SERVER_KEY_A)).buffer,
        };
        setupServiceWorkerWorld({ subscription: sub });
        expect(await checkAndHealPushSubscription(makePrefs())).toBe("not-needed");
        expect(sub.unsubscribe).not.toHaveBeenCalled();
        expect(localStorage.getItem(STORED_VAPID_KEY_STORAGE_KEY)).toBe(SERVER_KEY_A);
      },
    );

    it("heals a subscribed client whose stored VAPID key differs from the server key", async () => {
      stubPushGlobalsGranted();
      localStorage.setItem(STORED_VAPID_KEY_STORAGE_KEY, SERVER_KEY_A);
      getVapidKeyMock.mockResolvedValue({ configured: true, publicKey: SERVER_KEY_B });
      const staleSub = makeFakeSubscription();
      setupServiceWorkerWorld({ subscription: staleSub });

      const status = await checkAndHealPushSubscription(makePrefs());

      // Heal = tear down the stale subscription first (InvalidStateError
      // otherwise), then re-subscribe under the current server key.
      expect(status).toBe("healed");
      expect(staleSub.unsubscribe).toHaveBeenCalledTimes(1);
      expect(deleteMock).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem(STORED_VAPID_KEY_STORAGE_KEY)).toBe(SERVER_KEY_B);
      expect(syncMock).toHaveBeenCalledTimes(1);
      // The attempt is stamped so repeats stay rate-limited.
      expect(localStorage.getItem(HEAL_TIMESTAMP_STORAGE_KEY)).toBeTruthy();
      vi.unstubAllGlobals();
    });

    it("is a no-op when the stored VAPID key matches the server key", async () => {
      stubPushGlobalsGranted();
      localStorage.setItem(STORED_VAPID_KEY_STORAGE_KEY, SERVER_KEY_A);
      getVapidKeyMock.mockResolvedValue({ configured: true, publicKey: SERVER_KEY_A });
      const sub = makeFakeSubscription();
      setupServiceWorkerWorld({ subscription: sub });

      const status = await checkAndHealPushSubscription(makePrefs());

      expect(status).toBe("not-needed");
      expect(sub.unsubscribe).not.toHaveBeenCalled();
      expect(deleteMock).not.toHaveBeenCalled();
      expect(syncMock).not.toHaveBeenCalled();
      expect(localStorage.getItem(HEAL_TIMESTAMP_STORAGE_KEY)).toBeNull();
      vi.unstubAllGlobals();
    });

    it("is a no-op when there is no live subscription", async () => {
      stubPushGlobalsGranted();
      localStorage.setItem(STORED_VAPID_KEY_STORAGE_KEY, SERVER_KEY_A);
      getVapidKeyMock.mockResolvedValue({ configured: true, publicKey: SERVER_KEY_B });
      setupServiceWorkerWorld({ subscription: null });

      const status = await checkAndHealPushSubscription(makePrefs());

      expect(status).toBe("not-needed");
      expect(getVapidKeyMock).not.toHaveBeenCalled();
      expect(syncMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("skips healing when the last attempt was less than six hours ago", async () => {
      stubPushGlobalsGranted();
      const oneHourAgo = String(Date.now() - 60 * 60 * 1000);
      localStorage.setItem(HEAL_TIMESTAMP_STORAGE_KEY, oneHourAgo);
      localStorage.setItem(STORED_VAPID_KEY_STORAGE_KEY, SERVER_KEY_A);
      getVapidKeyMock.mockResolvedValue({ configured: true, publicKey: SERVER_KEY_B });
      const sub = makeFakeSubscription();
      setupServiceWorkerWorld({ subscription: sub });

      const status = await checkAndHealPushSubscription(makePrefs());

      expect(status).toBe("rate-limited");
      expect(sub.unsubscribe).not.toHaveBeenCalled();
      expect(syncMock).not.toHaveBeenCalled();
      // A skipped check does not refresh the stamp.
      expect(localStorage.getItem(HEAL_TIMESTAMP_STORAGE_KEY)).toBe(oneHourAgo);
      vi.unstubAllGlobals();
    });

    it("heals again once the rate-limit window has elapsed", async () => {
      stubPushGlobalsGranted();
      const sevenHoursAgo = String(Date.now() - 7 * 60 * 60 * 1000);
      localStorage.setItem(HEAL_TIMESTAMP_STORAGE_KEY, sevenHoursAgo);
      localStorage.setItem(STORED_VAPID_KEY_STORAGE_KEY, SERVER_KEY_A);
      getVapidKeyMock.mockResolvedValue({ configured: true, publicKey: SERVER_KEY_B });
      const staleSub = makeFakeSubscription();
      setupServiceWorkerWorld({ subscription: staleSub });

      const status = await healPushSubscription(makePrefs());

      expect(status).toBe("healed");
      expect(staleSub.unsubscribe).toHaveBeenCalledTimes(1);
      expect(Number(localStorage.getItem(HEAL_TIMESTAMP_STORAGE_KEY))).toBeGreaterThan(
        Number(sevenHoursAgo),
      );
      vi.unstubAllGlobals();
    });

    it("reports failed without throwing when resubscription breaks mid-heal", async () => {
      stubPushGlobalsGranted();
      localStorage.setItem(STORED_VAPID_KEY_STORAGE_KEY, SERVER_KEY_A);
      getVapidKeyMock
        .mockResolvedValueOnce({ configured: true, publicKey: SERVER_KEY_B }) // proactive check
        .mockResolvedValueOnce({ configured: true, publicKey: SERVER_KEY_B }) // unsubscribe path n/a
        .mockResolvedValue({ configured: true, publicKey: SERVER_KEY_B }); // resubscribe
      syncMock.mockRejectedValue(new Error("sync exploded"));
      const staleSub = makeFakeSubscription();
      setupServiceWorkerWorld({ subscription: staleSub });

      const status = await checkAndHealPushSubscription(makePrefs());

      expect(status).toBe("failed");
      expect(staleSub.unsubscribe).toHaveBeenCalledTimes(1);
      vi.unstubAllGlobals();
    });

    it("heals when the service worker reports an undecryptable push via postMessage", async () => {
      stubPushGlobalsGranted();
      localStorage.setItem(STORED_VAPID_KEY_STORAGE_KEY, SERVER_KEY_A);
      getVapidKeyMock.mockResolvedValue({ configured: true, publicKey: SERVER_KEY_B });
      const staleSub = makeFakeSubscription();
      setupServiceWorkerWorld({ subscription: staleSub });

      const serviceWorker = (
        navigator as unknown as {
          serviceWorker: {
            addEventListener: ReturnType<typeof vi.fn>;
            removeEventListener: ReturnType<typeof vi.fn>;
          };
        }
      ).serviceWorker;

      const dispose = registerPushHealListener(() => makePrefs());

      // Wrong message type must be ignored.
      const registeredHandler = serviceWorker.addEventListener.mock.calls.find(
        ([type]) => type === "message",
      )?.[1] as (event: { data?: unknown }) => void;
      expect(registeredHandler).toBeTypeOf("function");

      registeredHandler({ data: { type: "something-else" } });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(staleSub.unsubscribe).not.toHaveBeenCalled();

      // The SW's unreadable-push signal triggers the heal path.
      registeredHandler({ data: { type: "push-unreadable" } });
      await vi.waitFor(() => expect(staleSub.unsubscribe).toHaveBeenCalled());
      await vi.waitFor(() => expect(syncMock).toHaveBeenCalledTimes(1));
      expect(localStorage.getItem(STORED_VAPID_KEY_STORAGE_KEY)).toBe(SERVER_KEY_B);

      dispose();
      expect(serviceWorker.removeEventListener).toHaveBeenCalledWith("message", registeredHandler);
      vi.unstubAllGlobals();
    });
  });
});

describe("Push sync subscription payload builder", () => {
  const credentials = {
    endpoint: "https://fcm.googleapis.com/fcm/send/sample_endpoint",
    p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA",
    auth: "5K0e3mYQ4v9a",
  };

  const slices = {
    locale: "fr-CA" as const,
    favouriteLines: [
      { agencyId: "ttc", lineId: "1" },
      { agencyId: "ttc", lineId: "2" },
    ],
    favouriteStations: [{ agencyId: "ttc", stationName: "Bloor-Yonge" }],
    favouriteSurfaceRoutes: [{ agencyId: "ttc", routeId: "504" }],
    commuteSchedules: DEFAULT_PREFERENCES.commuteSchedules,
  };

  it("builds the exact SyncPushSubscriptionInput shape from credentials and preference slices", () => {
    const payload = buildSyncPushSubscriptionPayload(credentials, slices, "America/Toronto");

    expect(payload).toEqual({
      endpoint: "https://fcm.googleapis.com/fcm/send/sample_endpoint",
      p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA",
      auth: "5K0e3mYQ4v9a",
      favouriteLines: [
        { agencyId: "ttc", lineId: "1" },
        { agencyId: "ttc", lineId: "2" },
      ],
      favouriteStations: [{ agencyId: "ttc", stationName: "Bloor-Yonge" }],
      favouriteSurfaceRoutes: [{ agencyId: "ttc", routeId: "504" }],
      commuteSchedules: DEFAULT_PREFERENCES.commuteSchedules,
      locale: "fr-CA",
      timezone: "America/Toronto",
    });
  });

  it("defaults the timezone to the resolved local timezone when omitted", () => {
    const payload = buildSyncPushSubscriptionPayload(credentials, slices);
    expect(payload.timezone).toBe(resolveLocalTimezone());
  });

  it("does not leak non-push-relevant preference fields into the payload", () => {
    const payload = buildSyncPushSubscriptionPayload(credentials, slices, "America/Toronto");
    const keys = Object.keys(payload).sort();
    expect(keys).toEqual(
      [
        "auth",
        "commuteSchedules",
        "endpoint",
        "favouriteLines",
        "favouriteStations",
        "favouriteSurfaceRoutes",
        "locale",
        "p256dh",
        "timezone",
      ].sort(),
    );
    expect("reducedMotion" in payload).toBe(false);
    expect("showReducedSpeedZones" in payload).toBe(false);
  });

  it("omits the timezone when Intl refuses so the server applies its fallback", () => {
    const stubbedFormat = vi.spyOn(Intl, "DateTimeFormat").mockReturnValue({
      resolvedOptions: () => ({ timeZone: undefined }),
    } as unknown as Intl.DateTimeFormat);
    try {
      expect(buildSyncPushSubscriptionPayload(credentials, slices)).not.toHaveProperty("timezone");
    } finally {
      stubbedFormat.mockRestore();
    }
  });
});
