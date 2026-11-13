import type { UserPreferences } from "~/domain/preferences/UserPreferences";
import type { SyncPushSubscriptionInput } from "./NotificationClient";

/**
 * Credentials lifted off a browser PushSubscription JSON payload. Shared by the
 * preferences-context mirror and `subscribeToPush` so both callers post the
 * exact same payload shape.
 */
export interface PushSubscriptionCredentials {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

/** Preference slices mirrored onto the server-side subscription record. */
export type PushRelevantPreferenceSlices = Pick<
  UserPreferences,
  "favouriteLines" | "favouriteStations" | "favouriteSurfaceRoutes" | "commuteSchedules" | "locale"
>;

/**
 * Resolves the client's IANA timezone, or `undefined` when the platform
 * refuses to report one. The server then applies the active agency's
 * manifest timezone (see NotificationServer).
 */
export function resolveLocalTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Single source of truth for the push subscription sync payload. Both the
 * debounced mirror in UserPreferencesContext and `subscribeToPush` in
 * PushNotificationService build their request bodies through this function.
 */
export function buildSyncPushSubscriptionPayload(
  credentials: PushSubscriptionCredentials,
  preferences: PushRelevantPreferenceSlices,
  timezone: string | undefined = resolveLocalTimezone(),
): SyncPushSubscriptionInput {
  return {
    endpoint: credentials.endpoint,
    p256dh: credentials.p256dh,
    auth: credentials.auth,
    favouriteLines: preferences.favouriteLines,
    favouriteStations: preferences.favouriteStations,
    favouriteSurfaceRoutes: preferences.favouriteSurfaceRoutes,
    commuteSchedules: preferences.commuteSchedules,
    locale: preferences.locale,
    ...(timezone === undefined ? {} : { timezone }),
  };
}
