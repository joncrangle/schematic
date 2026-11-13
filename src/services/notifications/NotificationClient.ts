import type {
  CommuteSchedule,
  FavouriteLineRef,
  FavouriteStationRef,
  FavouriteSurfaceRouteRef,
} from "~/domain/preferences/UserPreferences";
import type { UiLocale } from "~/domain/locale";
import type { TestPushSummary } from "~/services/notifications/TestPushService";
import {
  handleDeletePushSubscription,
  handleGetVapidPublicKey,
  handleSyncPushSubscription,
  handleTriggerTestPush,
} from "./NotificationServer";

// ---------------------------------------------------------------------------
// Shared push-subscription RPC surface.
//
// Input/output types plus thin "use server" wrappers. The implementations
// live server-only in NotificationServer (VAPID secrets, storage layers).
// Each wrapper validates nothing itself. Every argument is treated as
// untrusted and the server body owns all policy, including the dev-only
// gate on triggerTestPush.
// ---------------------------------------------------------------------------

export interface SyncPushSubscriptionInput {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly favouriteLines: readonly FavouriteLineRef[];
  readonly favouriteStations: readonly FavouriteStationRef[];
  readonly favouriteSurfaceRoutes: readonly FavouriteSurfaceRouteRef[];
  readonly commuteSchedules: readonly CommuteSchedule[];
  /** Omitted by older clients; the server treats those registrations as English. */
  readonly locale?: UiLocale;
  readonly timezone?: string;
  readonly policyRevision?: number;
}

export async function syncPushSubscription(
  data: SyncPushSubscriptionInput,
): Promise<{ success: boolean }> {
  "use server";
  return handleSyncPushSubscription(data);
}

export async function deletePushSubscription(data: {
  endpoint: string;
  policyRevision?: number;
}): Promise<{ success: boolean }> {
  "use server";
  return handleDeletePushSubscription(data);
}

export interface TestPushTriggerInput {
  readonly title?: string;
  readonly body?: string;
}

export interface TriggerTestPushResult extends TestPushSummary {
  readonly ok: boolean;
  readonly message?: string;
}

/**
 * Dev-only RPC that sends a test push notification to every active subscription.
 * Delegates to handleTriggerTestPush, which hard-rejects outside dev.
 */
export async function triggerTestPush(data: TestPushTriggerInput): Promise<TriggerTestPushResult> {
  "use server";
  return handleTriggerTestPush(data);
}

export interface VapidKeyResponse {
  readonly configured: boolean;
  readonly publicKey: string | null;
  readonly error?: string;
}

export async function getVapidPublicKey(): Promise<VapidKeyResponse> {
  "use server";
  return handleGetVapidPublicKey();
}

export { urlBase64ToUint8Array } from "./PushNotificationService";
