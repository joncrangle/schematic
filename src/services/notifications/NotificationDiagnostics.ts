import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { AgencySnapshotSchema } from "~/agencies/types";
import type { UiLocale } from "~/domain/locale";
import { UiLocaleSchema } from "~/domain/localeSchema";
import {
  CommuteScheduleSchema,
  FavouriteLineRefSchema,
  FavouriteStationRefSchema,
  FavouriteSurfaceRouteRefSchema,
} from "~/domain/preferences/UserPreferences";
import {
  SubscriptionRepository,
  createMemorySubscriptionRepository,
} from "~/infrastructure/storage/SubscriptionRepository";
import { createMockVapidClient } from "~/infrastructure/notifications/VapidClient";
import {
  AlertEvaluatorService,
  createLiveAlertEvaluatorService,
  type EvaluationDiagnostic,
} from "./AlertEvaluatorService";

const ReplaySchema = Schema.Struct({
  now: Schema.Number,
  snapshot: AgencySnapshotSchema,
  subscription: Schema.Struct({
    locale: Schema.optional(UiLocaleSchema),
    timezone: Schema.NonEmptyString,
    commuteSchedules: Schema.Array(CommuteScheduleSchema),
    favouriteLines: Schema.Array(FavouriteLineRefSchema),
    favouriteStations: Schema.Array(FavouriteStationRefSchema),
    favouriteSurfaceRoutes: Schema.Array(FavouriteSurfaceRouteRefSchema),
  }),
  deliveries: Schema.optional(
    Schema.Array(
      Schema.Struct({
        agencyId: Schema.NonEmptyString,
        alertId: Schema.NonEmptyString,
        incidentKey: Schema.NonEmptyString,
        lineId: Schema.optional(Schema.String),
        routeId: Schema.optional(Schema.String),
        locale: Schema.optional(UiLocaleSchema),
        status: Schema.Literals(["active_sent", "cleared_sent", "cleared_silent"]),
        deliveredAt: Schema.Number,
      }),
    ),
  ),
});

/** Offline replay of production eligibility and dedupe with one anonymous subscription. */
export async function replayNotificationEvaluation(input: unknown) {
  // Decode errors can contain input values. The CLI and callers receive a safe error.
  let replay: Schema.Schema.Type<typeof ReplaySchema>;
  try {
    replay = Schema.decodeUnknownSync(ReplaySchema)(input);
    if (!Number.isFinite(new Date(replay.now).getTime()) || replay.now < 0) throw new Error();
    new Intl.DateTimeFormat("en-US", { timeZone: replay.subscription.timezone });
    const bounded = [
      replay.snapshot.alerts,
      replay.deliveries ?? [],
      replay.subscription.commuteSchedules,
      replay.subscription.favouriteLines,
      replay.subscription.favouriteStations,
      replay.subscription.favouriteSurfaceRoutes,
    ];
    if (bounded.some((values) => values.length > 1000)) throw new Error();
    if (
      replay.deliveries?.some(
        (delivery) =>
          !Number.isFinite(delivery.deliveredAt) ||
          delivery.deliveredAt < 0 ||
          delivery.agencyId !== replay.snapshot.agencyId,
      )
    )
      throw new Error();
  } catch {
    throw new Error(
      "Invalid replay input: check snapshot, preferences, deliveries, timezone, and epoch time; limit alerts and deliveries to 1000 each.",
    );
  }

  const events: EvaluationDiagnostic[] = [];
  const repository = createMemorySubscriptionRepository({ now: () => replay.now });
  const transport = createMockVapidClient(async () => ({
    success: true,
    statusCode: 201,
    expired: false,
  }));
  const dependencies = Layer.merge(repository, transport);
  const evaluator = createLiveAlertEvaluatorService({
    onDiagnostic: (event) => events.push(event),
  });
  const layer = Layer.merge(dependencies, evaluator.pipe(Layer.provide(dependencies)));

  const summary = await Effect.runPromise(
    Effect.gen(function* () {
      const repo = yield* SubscriptionRepository;
      yield* repo.upsertSubscription({
        ...replay.subscription,
        id: "diagnostic",
        endpoint: "https://diagnostic.invalid/mock",
        p256dh: "unused",
        auth: "unused",
        createdAt: replay.now,
        updatedAt: replay.now,
      });
      for (const [index, delivery] of (replay.deliveries ?? []).entries()) {
        yield* repo.recordDelivery({
          ...delivery,
          id: `diagnostic-${index}`,
          subscriptionId: "diagnostic",
        });
      }
      const service = yield* AlertEvaluatorService;
      return yield* service.evaluateAndDispatch(replay.snapshot, replay.now, {
        locale: replay.subscription.locale as UiLocale | undefined,
      });
    }).pipe(Effect.provide(layer)),
  );

  return { mode: "offline-replay" as const, transport: "mock" as const, summary, events };
}
