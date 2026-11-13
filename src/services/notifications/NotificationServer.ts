import "server-only";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { getRequestEvent } from "@solidjs/web";

import { getActiveAgency } from "~/agencies";
import { DEFAULT_UI_LOCALE, findSupportedLocale } from "~/domain/locale";
import { UiLocaleSchema } from "~/domain/localeSchema";
import type { PushSubscriptionRecord } from "~/domain/notifications/types";
import {
  CommuteScheduleSchema,
  FavouriteLineRefSchema,
  FavouriteStationRefSchema,
  FavouriteSurfaceRouteRefSchema,
} from "~/domain/preferences/UserPreferences";
import {
  SubscriptionRepository,
  LiveSubscriptionRepositoryLayer,
} from "~/infrastructure/storage/SubscriptionRepository";
import { createVapidClientLayer } from "~/infrastructure/notifications/VapidClient";
import {
  TestPushService,
  buildTestPayload,
  createTestPushService,
} from "~/services/notifications/TestPushService";
import { isDevServer } from "~/lib/devFlags";
import { getPushRegistrationPolicy, getVapidConfig } from "~/infrastructure/env/ServerEnv";
import { rateLimitClientIp } from "~/infrastructure/http/clientIp";
import { isAllowedPushEndpoint } from "~/infrastructure/notifications/PushEndpoint";
import { logger } from "~/infrastructure/logging/logger";
import type {
  TestPushTriggerInput,
  TriggerTestPushResult,
  VapidKeyResponse,
} from "./NotificationClient";

// ---------------------------------------------------------------------------

const RegistrationSchema = Schema.Struct({
  endpoint: Schema.NonEmptyString,
  p256dh: Schema.NonEmptyString,
  auth: Schema.NonEmptyString,
  favouriteLines: Schema.Array(FavouriteLineRefSchema),
  favouriteStations: Schema.Array(FavouriteStationRefSchema),
  favouriteSurfaceRoutes: Schema.Array(FavouriteSurfaceRouteRefSchema),
  commuteSchedules: Schema.Array(CommuteScheduleSchema),
  locale: Schema.optional(UiLocaleSchema),
  timezone: Schema.optional(Schema.NonEmptyString),
  policyRevision: Schema.optional(Schema.Number),
});

const DeletionSchema = Schema.Struct({
  endpoint: Schema.NonEmptyString,
  policyRevision: Schema.optional(Schema.Number),
});

const MAX_FUTURE_POLICY_REVISION_MS = 24 * 60 * 60 * 1000;

function canonicalizeRegistrationLocale(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  if (!("locale" in record)) return input;
  const locale = findSupportedLocale(record.locale);
  return locale ? { ...record, locale } : input;
}

function validateEndpointAndRevision(data: { endpoint: string; policyRevision?: number }) {
  if (
    data.policyRevision !== undefined &&
    (!Number.isSafeInteger(data.policyRevision) ||
      data.policyRevision < 1 ||
      data.policyRevision > Date.now() + MAX_FUTURE_POLICY_REVISION_MS)
  )
    throw new Error();
  if (!isAllowedPushEndpoint(data.endpoint)) throw new Error();
}

async function validateRegistration(input: unknown) {
  try {
    const data = Schema.decodeUnknownSync(RegistrationSchema)(
      canonicalizeRegistrationLocale(input),
    );
    if (
      data.favouriteLines.length > 100 ||
      data.favouriteStations.length > 100 ||
      data.favouriteSurfaceRoutes.length > 100 ||
      data.commuteSchedules.length > 10 ||
      (data.timezone !== undefined && data.timezone.length > 64) ||
      data.p256dh.length > 128 ||
      data.auth.length > 64 ||
      data.favouriteLines.some((item) => item.agencyId.length > 128 || item.lineId.length > 128) ||
      data.favouriteStations.some(
        (item) => item.agencyId.length > 128 || item.stationName.length > 200,
      ) ||
      data.favouriteSurfaceRoutes.some(
        (item) => item.agencyId.length > 128 || item.routeId.length > 128,
      ) ||
      data.commuteSchedules.some(
        (schedule) => schedule.id.length > 128 || schedule.label.length > 100,
      )
    )
      throw new Error();
    validateEndpointAndRevision(data);
    const timezone = data.timezone ?? getActiveAgency().manifest.timezone;
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    if (![data.p256dh, data.auth].every((value) => /^[A-Za-z0-9_-]+={0,2}$/.test(value)))
      throw new Error();
    const publicKey = Buffer.from(data.p256dh, "base64url");
    if (
      publicKey.length !== 65 ||
      publicKey[0] !== 4 ||
      Buffer.from(data.auth, "base64url").length !== 16
    )
      throw new Error();
    await crypto.subtle.importKey(
      "raw",
      publicKey,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    return { ...data, timezone };
  } catch {
    // Schema and crypto failures may include input. Never expose keys/endpoints.
    throw new Error("Invalid push subscription");
  }
}
// Server-only push-subscription RPC implementations. This module is
// server-only (VAPID secrets and storage layers); the shared
// NotificationClient module keeps only input/output types and the
// "use server" wrapper stubs whose bodies call in here.
// ---------------------------------------------------------------------------

/**
 * Stores a registration. New endpoints are bounded per client network and per
 * instance; a refusal throws a generic error the client reports as a failed save.
 */
export async function handleSyncPushSubscription(
  input: unknown,
  request: Request | undefined = getRequestEvent()?.request,
): Promise<{ success: boolean }> {
  const data = await validateRegistration(input);
  const clientIp = request ? rateLimitClientIp(request) : null;
  const record: PushSubscriptionRecord = {
    id: `sub_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
    endpoint: data.endpoint,
    p256dh: data.p256dh,
    auth: data.auth,
    favouriteLines: data.favouriteLines,
    favouriteStations: data.favouriteStations,
    favouriteSurfaceRoutes: data.favouriteSurfaceRoutes,
    commuteSchedules: data.commuteSchedules,
    locale: data.locale ?? DEFAULT_UI_LOCALE,
    timezone: data.timezone,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    policyRevision: data.policyRevision,
  };

  const program = Effect.gen(function* () {
    const repo = yield* SubscriptionRepository;
    const admission = yield* repo.admitRegistration(
      data.endpoint,
      clientIp,
      getPushRegistrationPolicy(),
      Date.now(),
    );
    if (admission === "client_limited" || admission === "instance_full") return admission;
    yield* repo.upsertSubscription(record);
    return admission;
  }).pipe(Effect.provide(LiveSubscriptionRepositoryLayer));

  const admission = await Effect.runPromise(program);
  if (admission === "client_limited" || admission === "instance_full") {
    logger.warn("NotificationServer: push registration refused", {
      reason: admission === "client_limited" ? "rate limited" : "subscription ceiling reached",
    });
    throw new Error("Push subscription not accepted");
  }
  return { success: true };
}

export async function handleDeletePushSubscription(input: unknown): Promise<{ success: boolean }> {
  let data;
  try {
    data = Schema.decodeUnknownSync(DeletionSchema)(input);
    validateEndpointAndRevision(data);
  } catch {
    throw new Error("Invalid push subscription");
  }
  const program = Effect.gen(function* () {
    const repo = yield* SubscriptionRepository;
    yield* repo.deleteSubscriptionByEndpoint(data.endpoint, data.policyRevision ?? 0);
  }).pipe(Effect.provide(LiveSubscriptionRepositoryLayer));

  await Effect.runPromise(program);
  return { success: true };
}

/**
 * Handler body for the dev-only triggerTestPush RPC, extracted so the
 * security boundary is directly unit-testable.
 *
 * HARD SECURITY BOUNDARY: rejects outside development environments regardless
 * of client UI gating, because server functions remain reachable in deployed
 * (production) environments.
 */
export async function handleTriggerTestPush(
  data?: TestPushTriggerInput,
): Promise<TriggerTestPushResult> {
  if (!isDevServer()) {
    throw new Error("Test push notifications are disabled outside development environments.");
  }

  const vapidKeys = getVapidConfig();

  if (!vapidKeys) {
    logger.warn("NotificationClient: triggerTestPush no-op — VAPID keys not configured");
    return {
      ok: false,
      total: 0,
      sent: 0,
      failed: 0,
      expiredSubscriptionsPruned: 0,
      message:
        "VAPID keys are not configured on the server. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in .env, then restart the dev server.",
    };
  }

  const payload = buildTestPayload({ title: data?.title, body: data?.body });

  try {
    const vapidLayer = createVapidClientLayer(vapidKeys);
    const serviceLayer = createTestPushService().pipe(
      Layer.provide(Layer.merge(LiveSubscriptionRepositoryLayer, vapidLayer)),
    );

    const program = Effect.gen(function* () {
      const testPush = yield* TestPushService;
      return yield* testPush.sendTestPush(payload);
    }).pipe(Effect.provide(serviceLayer));

    const summary = await Effect.runPromise(program);

    logger.info("NotificationClient: dev test push dispatched", { ...summary });

    return { ok: true, ...summary };
  } catch (err) {
    logger.warn("NotificationClient: triggerTestPush failed", { err: String(err) });
    return {
      ok: false,
      total: 0,
      sent: 0,
      failed: 0,
      expiredSubscriptionsPruned: 0,
      message: `Failed to send test notification: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

export async function handleGetVapidPublicKey(): Promise<VapidKeyResponse> {
  logger.debug("getVapidPublicKey: RPC invocation received");
  // Same accessor the scheduler gate uses, one VAPID config truth.
  const vapidKeys = getVapidConfig();

  if (!vapidKeys) {
    logger.warn(
      "NotificationClient: VAPID keys not configured on server (VAPID_PUBLIC_KEY is missing). Push notifications cannot be registered.",
    );
    return {
      configured: false,
      publicKey: null,
      error:
        "VAPID keys not configured on server. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in .env.",
    };
  }

  logger.debug("getVapidPublicKey: returning configured public key");
  return {
    configured: true,
    publicKey: vapidKeys.publicKey,
  };
}
