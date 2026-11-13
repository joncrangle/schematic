import { invoke } from "@solidjs/web/server-functions";
import {
  deletePushSubscription,
  syncPushSubscription,
  type SyncPushSubscriptionInput,
} from "./NotificationClient";

const REVISION_STORAGE_KEY = "push-policy-revision";
let lastRevision = 0;

// Retain ordering across reloads and clock changes. Endpoints are not stored here.
function nextRevision(): number {
  let stored = 0;
  try {
    stored = Number(window.localStorage.getItem(REVISION_STORAGE_KEY)) || 0;
  } catch {
    /* Storage can be disabled. */
  }
  lastRevision = Math.max(
    Date.now(),
    lastRevision + 1,
    Number.isSafeInteger(stored) && stored >= 0 && stored < Number.MAX_SAFE_INTEGER - 1000
      ? stored + 1
      : 0,
  );
  try {
    window.localStorage.setItem(REVISION_STORAGE_KEY, String(lastRevision));
  } catch {
    /* In-memory ordering still applies. */
  }
  return lastRevision;
}

/** Await one browser operation; timing out stops its caller before the next write. */
export async function withPushDeadline<T>(
  operation: Promise<T>,
  timeoutMs = 10_000,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error("Push subscription operation timed out"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function callPushRpc<A extends readonly unknown[], R>(
  fn: (...args: A) => Promise<R>,
  ...args: A
): Promise<R> {
  const controller = new AbortController();
  return withPushDeadline(invoke(fn, { signal: controller.signal }, ...args), 10_000, () =>
    controller.abort(),
  );
}

/** Bounded writes, with a revision that the repository checks atomically. */
export function mirrorPushSubscription(
  input: SyncPushSubscriptionInput,
): Promise<{ success: boolean }> {
  return callPushRpc(syncPushSubscription, { ...input, policyRevision: nextRevision() });
}

export function removePushSubscription(endpoint: string): Promise<{ success: boolean }> {
  return callPushRpc(deletePushSubscription, { endpoint, policyRevision: nextRevision() });
}
