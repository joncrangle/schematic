import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { PushPayload } from "~/domain/notifications/types";
import {
  SubscriptionRepository,
  SubscriptionStorageError,
} from "~/infrastructure/storage/SubscriptionRepository";
import { VapidClient } from "~/infrastructure/notifications/VapidClient";
import { logger } from "~/infrastructure/logging/logger";

export const TEST_PUSH_DEFAULT_TITLE = "🧪 Test notification";
export const TEST_PUSH_DEFAULT_BODY = "Transit push pipeline test — safe to ignore.";

const TEST_PUSH_TAG_PREFIX = "test-push-";

let testPushTagCounter = 0;

export interface TestPayloadCustomizations {
  readonly title?: string;
  readonly body?: string;
}

/**
 * Coerces untrusted input to trimmed text. RPC JSON can carry any shape
 * despite the declared types (e.g. title: 123), so non-strings and blank
 * values collapse to "" and the payload falls back to its defaults.
 */
function sanitizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Builds the PushPayload for a dev-triggered test notification.
 * The tag is unique per call so the service worker's `renotify: true`
 * behaviour is never swallowed by same-tag dedupe on the client.
 */
export function buildTestPayload(custom?: TestPayloadCustomizations): PushPayload {
  const title = sanitizeText(custom?.title) || TEST_PUSH_DEFAULT_TITLE;
  const body = sanitizeText(custom?.body) || TEST_PUSH_DEFAULT_BODY;
  const tag = `${TEST_PUSH_TAG_PREFIX}${Date.now()}-${(testPushTagCounter += 1)}`;

  return { title, body, tag, data: { url: "/" } };
}

export interface TestPushSummary {
  readonly total: number;
  readonly sent: number;
  readonly failed: number;
  readonly expiredSubscriptionsPruned: number;
}

export interface TestPushServiceApi {
  readonly sendTestPush: (
    payload: PushPayload,
  ) => Effect.Effect<TestPushSummary, SubscriptionStorageError>;
}

export class TestPushService extends Context.Service<TestPushService, TestPushServiceApi>()(
  "TestPushService",
) {}

type SendOutcome = "sent" | "failed" | "expired";

/**
 * Dev-only service that sends a test payload directly to every active push
 * subscription. Unlike AlertEvaluatorService there is no commute-window gate
 * and no delivery dedupe; expired (404/410) subscriptions are pruned exactly
 * the same way.
 */
export function createTestPushService(): Layer.Layer<
  TestPushService,
  never,
  SubscriptionRepository | VapidClient
> {
  return Layer.effect(
    TestPushService,
    Effect.gen(function* () {
      const subRepo = yield* SubscriptionRepository;
      const vapid = yield* VapidClient;

      return TestPushService.of({
        sendTestPush: (payload: PushPayload) =>
          Effect.gen(function* () {
            const subscriptions = yield* subRepo.getActiveSubscriptions();

            let sent = 0;
            let failed = 0;
            let expiredSubscriptionsPruned = 0;

            for (const sub of subscriptions) {
              // One broken endpoint must not block delivery to the rest of the batch.
              const outcome = yield* vapid.sendNotification(sub, payload).pipe(
                Effect.map((result): SendOutcome => {
                  if (result.expired) return "expired";
                  return result.success ? "sent" : "failed";
                }),
                Effect.catch((err) =>
                  Effect.sync(() => {
                    logger.warn("TestPushService: sendNotification failed", {
                      subId: sub.id,
                      err: String(err),
                    });
                    return "failed" as SendOutcome;
                  }),
                ),
              );

              switch (outcome) {
                case "expired": {
                  yield* subRepo.deleteSubscriptionByEndpoint(sub.endpoint);
                  expiredSubscriptionsPruned += 1;
                  break;
                }
                case "sent": {
                  sent += 1;
                  break;
                }
                case "failed": {
                  failed += 1;
                  break;
                }
              }
            }

            logger.info("TestPushService: dev test push complete", {
              total: subscriptions.length,
              sent,
              failed,
              expiredSubscriptionsPruned,
            });

            return { total: subscriptions.length, sent, failed, expiredSubscriptionsPruned };
          }),
      });
    }),
  );
}
