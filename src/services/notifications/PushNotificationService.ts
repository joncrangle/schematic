import type { UserPreferences } from "~/domain/preferences/UserPreferences";
import { getVapidPublicKey, type VapidKeyResponse } from "./NotificationClient";
import {
  mirrorPushSubscription,
  removePushSubscription,
  withPushDeadline,
} from "./PushSubscriptionSync";
import { buildSyncPushSubscriptionPayload } from "./PushSyncPayload";
import { logger } from "~/infrastructure/logging/logger";
import { getServiceWorkerScriptUrl } from "~/lib/serviceWorkerRegistration";

export type PushPermissionState = "prompt" | "granted" | "denied" | "unsupported";

export interface PushOperationResult {
  readonly success: boolean;
  readonly reason?:
    | "unsupported"
    | "permission_denied"
    | "vapid_unconfigured"
    | "subscription_failed"
    | "network_error"
    | "unknown";
  readonly message?: string;
}

export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function getPushPermission(): PushPermissionState {
  if (!isPushSupported()) return "unsupported";
  const perm = Notification.permission;
  if (perm === "granted" || perm === "denied") {
    return perm;
  }
  if (perm === "default") {
    return "prompt";
  }
  return "unsupported";
}

async function fetchVapidKey(): Promise<VapidKeyResponse> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      getVapidPublicKey(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Push key request timed out")), 6000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function getActiveServiceWorker(timeoutMs = 6000): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }

  try {
    let reg = await withPushDeadline(navigator.serviceWorker.getRegistration());
    if (!reg) {
      reg = await withPushDeadline(
        navigator.serviceWorker.register(getServiceWorkerScriptUrl()),
      ).catch(() => undefined);
    }

    if (reg?.active) {
      return reg;
    }

    const activeReg = await withPushDeadline(navigator.serviceWorker.ready, timeoutMs).catch(
      () => null,
    );
    if (activeReg?.active) {
      return activeReg;
    }

    const latest = await withPushDeadline(navigator.serviceWorker.getRegistration());
    if (latest?.active) {
      return latest;
    }

    return null;
  } catch (err) {
    logger.warn("PushNotificationService: getActiveServiceWorker failed", { err });
    return null;
  }
}

export async function isPushSubscribed(): Promise<boolean> {
  if (!isPushSupported()) return false;
  try {
    const reg = await getActiveServiceWorker(2000);
    if (!reg) return false;
    const sub = await withPushDeadline(reg.pushManager.getSubscription());
    return sub !== null;
  } catch (err) {
    logger.debug("PushNotificationService: isPushSubscribed failed", { err });
    return false;
  }
}

/**
 * Converts a base64 or base64url string to a Uint8Array for PushManager subscription.
 * Uses native Uint8Array.fromBase64 (Bun / Node 22+ / modern browsers) and Buffer.from where available.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  if (!base64String || typeof base64String !== "string") {
    return new Uint8Array(0);
  }
  if (typeof (Uint8Array as unknown as { fromBase64?: unknown }).fromBase64 === "function") {
    try {
      return (
        Uint8Array as unknown as {
          fromBase64: (s: string, opts: { alphabet: string }) => Uint8Array;
        }
      ).fromBase64(base64String, { alphabet: "base64url" });
    } catch {
      // fallback to Buffer or atob
    }
  }
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(base64String, "base64url"));
  }
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

type PreferenceSource = UserPreferences | (() => UserPreferences);
const readPreferences = (source: PreferenceSource) =>
  typeof source === "function" ? source() : source;

export async function subscribeToPush(preferences: PreferenceSource): Promise<PushOperationResult> {
  if (!isPushSupported()) {
    return {
      success: false,
      reason: "unsupported",
      message: "Push notifications are not supported by this browser.",
    };
  }

  try {
    const perm = await withPushDeadline(Notification.requestPermission());
    if (perm !== "granted") {
      return {
        success: false,
        reason: "permission_denied",
        message: "Notification permission was not granted by your browser.",
      };
    }

    let keyResponse: VapidKeyResponse;
    try {
      keyResponse = await fetchVapidKey();
    } catch (fetchErr) {
      logger.warn("PushNotificationService: failed to fetch VAPID key from server", { fetchErr });
      return {
        success: false,
        reason: "network_error",
        message: "Unable to contact server for push notification keys.",
      };
    }

    if (!keyResponse.configured || !keyResponse.publicKey) {
      logger.warn("PushNotificationService: server VAPID keys not configured", {
        error: keyResponse.error,
      });
      return {
        success: false,
        reason: "vapid_unconfigured",
        message:
          keyResponse.error ||
          "Server push notifications are not configured (missing VAPID keys in server environment).",
      };
    }

    const reg = await getActiveServiceWorker(5000);
    if (!reg) {
      return {
        success: false,
        reason: "subscription_failed",
        message: "Service Worker is not active or failed to register in your browser.",
      };
    }

    const applicationServerKey = urlBase64ToUint8Array(keyResponse.publicKey);
    if (applicationServerKey.length === 0) {
      return {
        success: false,
        reason: "vapid_unconfigured",
        message: "Invalid VAPID public key received from server.",
      };
    }

    const subOptions: PushSubscriptionOptionsInit = {
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey as BufferSource,
    };

    let subscription: PushSubscription;
    try {
      subscription = await withPushDeadline(reg.pushManager.subscribe(subOptions));
    } catch (subErr) {
      logger.warn("PushNotificationService: pushManager.subscribe failed", { subErr });
      return {
        success: false,
        reason: "subscription_failed",
        message: `Browser push registration failed: ${subErr instanceof Error ? subErr.message : String(subErr)}`,
      };
    }

    const subJson = subscription.toJSON();

    if (subJson.endpoint && subJson.keys?.p256dh && subJson.keys?.auth) {
      try {
        await mirrorPushSubscription(
          buildSyncPushSubscriptionPayload(
            {
              endpoint: subJson.endpoint,
              p256dh: subJson.keys.p256dh,
              auth: subJson.keys.auth,
            },
            readPreferences(preferences),
          ),
        );
        // Record which VAPID key produced this subscription so a later
        // server-side key rewrite can be detected and healed.
        storeVapidKey(keyResponse.publicKey);
        return { success: true };
      } catch (syncErr) {
        logger.warn("PushNotificationService: syncPushSubscription RPC failed", { syncErr });
        return {
          success: false,
          reason: "network_error",
          message: "Failed to save push subscription on the server.",
        };
      }
    }

    return {
      success: false,
      reason: "subscription_failed",
      message: "Browser generated invalid push subscription credentials.",
    };
  } catch (err) {
    logger.warn("PushNotificationService: subscribeToPush encountered error", { err });
    return {
      success: false,
      reason: "unknown",
      message: err instanceof Error ? err.message : "Failed to enable push notifications.",
    };
  }
}

export async function unsubscribeFromPush(): Promise<PushOperationResult> {
  if (!isPushSupported()) {
    return {
      success: false,
      reason: "unsupported",
      message: "Push notifications are not supported.",
    };
  }

  try {
    const reg = await getActiveServiceWorker(2000);
    if (!reg) {
      clearStoredVapidKey();
      return { success: true };
    }
    const sub = await withPushDeadline(reg.pushManager.getSubscription());

    if (sub) {
      try {
        await removePushSubscription(sub.endpoint);
      } catch (rpcErr) {
        logger.warn("PushNotificationService: deletePushSubscription RPC warning", { rpcErr });
      }
      await withPushDeadline(sub.unsubscribe());
    }

    clearStoredVapidKey();
    return { success: true };
  } catch (err) {
    logger.warn("PushNotificationService: unsubscribeFromPush failed", { err });
    return {
      success: false,
      reason: "unknown",
      message:
        err instanceof Error ? err.message : "Failed to unsubscribe from push notifications.",
    };
  }
}

// ---------------------------------------------------------------------------
// Detect-and-heal
//
// A subscription restricted to an older VAPID key is rejected by the gateway.
// Separately, stale payload-encryption credentials can prevent device receipt
// even after gateway acceptance. Two arms repair these distinct failures:
//
//   Reactive , the service worker posts {type:"push-unreadable"} to its
//               windows when a push arrives with no readable payload; the
//               page listens and heals (see registerPushHealListener).
//   Proactive, on app load, compare the locally stored VAPID public key
//               (persisted at subscribe time) against the server's current
//               key and heal on mismatch (see checkAndHealPushSubscription).
// ---------------------------------------------------------------------------

/** localStorage key holding the VAPID public key used at subscribe time. */
export const STORED_VAPID_KEY_STORAGE_KEY = "push-vapid-key";

/** localStorage key stamping the last heal attempt (epoch ms). */
export const HEAL_TIMESTAMP_STORAGE_KEY = "push-heal-at";

/** Minimum interval between heal attempts. */
export const HEAL_RATE_LIMIT_MS = 6 * 60 * 60 * 1000;

/** Message type broadcast by the service worker for undecryptable pushes. */
export const PUSH_UNREADABLE_MESSAGE_TYPE = "push-unreadable";

export type PushHealStatus = "healed" | "rate-limited" | "failed" | "not-needed";

function readStorageItem(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch (err) {
    logger.debug("PushNotificationService: localStorage read failed", { err });
    return null;
  }
}

function writeStorageItem(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch (err) {
    logger.debug("PushNotificationService: localStorage write failed", { err });
  }
}

function removeStorageItem(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch (err) {
    logger.debug("PushNotificationService: localStorage remove failed", { err });
  }
}

/** The VAPID public key that produced the currently stored subscription, if known. */
export function getStoredVapidKey(): string | null {
  const stored = readStorageItem(STORED_VAPID_KEY_STORAGE_KEY);
  return stored && stored.length > 0 ? stored : null;
}

function storeVapidKey(publicKey: string): void {
  writeStorageItem(STORED_VAPID_KEY_STORAGE_KEY, publicKey);
}

function clearStoredVapidKey(): void {
  removeStorageItem(STORED_VAPID_KEY_STORAGE_KEY);
}

/**
 * Re-provisions the push subscription under the server's current VAPID keys:
 * rate-limited tear-down followed by a fresh subscribe + sync.
 *
 * Errors are swallowed and logged, healing is opportunistic and must never
 * surface as an unhandled rejection to callers like event handlers.
 */
export async function healPushSubscription(preferences: PreferenceSource): Promise<PushHealStatus> {
  const lastAttemptRaw = readStorageItem(HEAL_TIMESTAMP_STORAGE_KEY);
  const lastAttempt = lastAttemptRaw ? Number(lastAttemptRaw) : Number.NaN;
  if (
    Number.isFinite(lastAttempt) &&
    lastAttempt > 0 &&
    Date.now() - lastAttempt < HEAL_RATE_LIMIT_MS
  ) {
    logger.info("PushNotificationService: heal skipped (rate-limited)");
    return "rate-limited";
  }
  // Stamp before attempting so a crashed attempt still throttles retries.
  writeStorageItem(HEAL_TIMESTAMP_STORAGE_KEY, String(Date.now()));

  logger.warn("PushNotificationService: healing push subscription (stale VAPID keys suspected)");
  try {
    const unsubscribed = await unsubscribeFromPush();
    if (!unsubscribed.success) {
      logger.warn("PushNotificationService: heal failed at unsubscribe", {
        reason: unsubscribed.reason,
      });
      return "failed";
    }

    const resubscribed = await subscribeToPush(preferences);
    if (!resubscribed.success) {
      logger.warn("PushNotificationService: heal failed at resubscribe", {
        reason: resubscribed.reason,
      });
      return "failed";
    }

    logger.info("PushNotificationService: push subscription healed");
    return "healed";
  } catch (err) {
    logger.warn("PushNotificationService: heal encountered unexpected error", { err });
    return "failed";
  }
}

/**
 * Proactive arm: when a live subscription exists but was minted with a
 * different VAPID public key than the server currently serves, re-provision
 * it. Returns "not-needed" whenever there is nothing actionable, including
 * when the server has no configured key, since tearing down a possibly-working
 * subscription without being able to recreate one would only lose coverage.
 */
export async function checkAndHealPushSubscription(
  preferences: PreferenceSource,
): Promise<PushHealStatus> {
  if (!isPushSupported()) return "not-needed";

  try {
    const registration = await getActiveServiceWorker(2000);
    const subscription = registration
      ? await withPushDeadline(registration.pushManager.getSubscription())
      : null;
    if (!subscription) return "not-needed";

    let keyResponse: VapidKeyResponse;
    try {
      keyResponse = await fetchVapidKey();
    } catch (fetchErr) {
      logger.warn("PushNotificationService: heal check could not fetch VAPID key", {
        fetchErr,
      });
      return "failed";
    }

    if (!keyResponse.configured || !keyResponse.publicKey) {
      return "not-needed";
    }

    // The browser's key is authoritative. Missing/stale local bookkeeping
    // alone must not destroy a working subscription or hide a real mismatch.
    const browserKey = subscription.options?.applicationServerKey;
    const serverKey = urlBase64ToUint8Array(keyResponse.publicKey);
    const keyMatches = browserKey
      ? new Uint8Array(browserKey).length === serverKey.length &&
        new Uint8Array(browserKey).every((byte, index) => byte === serverKey[index])
      : getStoredVapidKey() === keyResponse.publicKey;
    if (keyMatches) {
      storeVapidKey(keyResponse.publicKey);
      return "not-needed";
    }

    logger.info("PushNotificationService: stored VAPID key differs from server key");
    return await healPushSubscription(preferences);
  } catch (err) {
    logger.warn("PushNotificationService: heal check failed", { err });
    return "failed";
  }
}

/**
 * Reactive arm: listen for the service worker's undecryptable-push signal and
 * heal in response. Returns a disposer for onCleanup. Safe to call on the
 * server (no-op without navigator.serviceWorker).
 *
 * Must be called from an init path (onMount-style), never inside a reactive effect:
 * this is a pure external-subscription setup/teardown, not derived state.
 */
export function registerPushHealListener(
  getPreferences: () => UserPreferences,
  onHeal?: () => void,
): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return () => {};
  }

  const serviceWorker = navigator.serviceWorker;
  // Partial/stubbed implementations exist in non-browser embeddings; only
  // wire up when the full EventTarget surface is available.
  if (
    !serviceWorker ||
    typeof serviceWorker.addEventListener !== "function" ||
    typeof serviceWorker.removeEventListener !== "function"
  ) {
    return () => {};
  }

  const handler = (event: MessageEvent): void => {
    const data = event.data as { type?: unknown } | null | undefined;
    if (data?.type !== PUSH_UNREADABLE_MESSAGE_TYPE) return;

    logger.warn("PushNotificationService: received unreadable-push signal from service worker");
    if (onHeal) {
      onHeal();
      return;
    }
    void healPushSubscription(getPreferences).catch((err) => {
      logger.warn("PushNotificationService: reactive heal failed", { err });
    });
  };

  serviceWorker.addEventListener("message", handler);
  return () => {
    serviceWorker.removeEventListener("message", handler);
  };
}
