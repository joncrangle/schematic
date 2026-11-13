/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoked } = vi.hoisted(() => ({ invoked: vi.fn() }));
vi.mock("@solidjs/web/server-functions", () => ({
  invoke: (fn: (...args: unknown[]) => unknown, options: unknown, ...args: unknown[]) =>
    invoked(fn, options, ...args),
}));

import {
  mirrorPushSubscription,
  removePushSubscription,
} from "~/services/notifications/PushSubscriptionSync";
import type { SyncPushSubscriptionInput } from "~/services/notifications/NotificationClient";

class LocalStorageStub {
  private values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const payload: SyncPushSubscriptionInput = {
  endpoint: "https://push.example.test/subscription",
  p256dh: "fixture-key",
  auth: "fixture-auth",
  favouriteLines: [],
  favouriteStations: [],
  favouriteSurfaceRoutes: [],
  commuteSchedules: [],
};

describe("PushSubscriptionSync public interface", () => {
  let storage: LocalStorageStub;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    storage = new LocalStorageStub();
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
    invoked.mockReset().mockResolvedValue({ success: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps revisions increasing across calls, reloads, and a rolled-back clock", async () => {
    await mirrorPushSubscription(payload);
    const first = invoked.mock.calls[0]![2] as SyncPushSubscriptionInput;
    vi.setSystemTime(1_699_999_000_000);
    await removePushSubscription(payload.endpoint);
    const second = invoked.mock.calls[1]![2] as { policyRevision: number };
    expect(second.policyRevision).toBeGreaterThan(first.policyRevision!);

    vi.resetModules();
    const reloaded = await import("~/services/notifications/PushSubscriptionSync");
    await reloaded.mirrorPushSubscription(payload);
    const third = invoked.mock.calls[2]![2] as SyncPushSubscriptionInput;
    expect(third.policyRevision).toBeGreaterThan(second.policyRevision);
  });

  it("retains in-memory ordering when localStorage is disabled", async () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("disabled");
      },
    });
    await mirrorPushSubscription(payload);
    await removePushSubscription(payload.endpoint);
    const revisions = invoked.mock.calls.map(
      (call) => (call[2] as { policyRevision: number }).policyRevision,
    );
    expect(revisions[1]).toBeGreaterThan(revisions[0]!);
  });

  it("aborts an RPC that exceeds the ten second deadline", async () => {
    let signal: AbortSignal | undefined;
    invoked.mockImplementation((_fn, options) => {
      signal = (options as { signal: AbortSignal }).signal;
      return new Promise(() => {});
    });
    const pending = mirrorPushSubscription(payload);
    const rejection = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(signal?.aborted).toBe(true);
  });
});
