import type {
  CommuteSchedule,
  FavouriteLineRef,
  FavouriteStationRef,
  FavouriteSurfaceRouteRef,
} from "~/domain/preferences/UserPreferences";
import type { UiLocale } from "~/domain/locale";

export interface PushSubscriptionRecord {
  readonly id: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly favouriteLines: readonly FavouriteLineRef[];
  readonly favouriteStations: readonly FavouriteStationRef[];
  readonly favouriteSurfaceRoutes: readonly FavouriteSurfaceRouteRef[];
  readonly commuteSchedules: readonly CommuteSchedule[];
  /** Locale used for feed selection and rider-visible notifications. Legacy rows default to English. */
  readonly locale?: UiLocale;
  readonly timezone: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Monotonic browser write revision; absent for legacy registrations. */
  readonly policyRevision?: number;
  /** Consecutive rejected transport attempts used for exponential retry delay. */
  readonly pushRetryCount?: number;
  /** Consecutive non-transient endpoint rejections; reaching the policy limit prunes it. */
  readonly pushHardFailureCount?: number;
  /** Earliest time this subscription may receive another push attempt. */
  readonly pushRetryAt?: number;
}

/** Operator bounds on push registration; every value is a positive integer. */
export interface PushRegistrationPolicy {
  /** New endpoints one client network may register per window. */
  readonly perClientLimit: number;
  readonly windowMs: number;
  /** Stored subscriptions beyond which new endpoints are refused. */
  readonly maxSubscriptions: number;
  /** A subscription never delivered to expires this long after it was first stored. */
  readonly undeliveredRetentionMs: number;
}

export type AlertDeliveryStatus = "active_sent" | "cleared_sent" | "cleared_silent";

export interface AlertDeliveryRecord {
  readonly id: string;
  readonly agencyId: string;
  readonly alertId: string;
  /**
   * Content-hash incident key (see `incidentKeyForAlert`). Survives upstream
   * id churn across fetches; `alertId` keeps the upstream id for deep links.
   */
  readonly incidentKey: string;
  readonly subscriptionId: string;
  readonly lineId?: string;
  readonly routeId?: string;
  readonly status: AlertDeliveryStatus;
  /** Locale of the feed used for this delivery; absent legacy values mean English. */
  readonly locale?: UiLocale;
  /** Last accepted push time; retained when recovery is observed outside the commute window. */
  readonly deliveredAt: number;
}

export interface PushPayload {
  readonly title: string;
  readonly body: string;
  readonly tag: string;
  readonly data?: {
    readonly url?: string;
    readonly agencyId?: string;
    readonly alertId?: string;
    readonly lineId?: string;
    readonly routeId?: string;
  };
}

export interface VapidKeys {
  readonly publicKey: string;
  readonly privateKey: string;
  readonly subject: string; // e.g. "mailto:admin@example.com"
}
