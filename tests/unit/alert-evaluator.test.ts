import { createCloudflareInvocationIo } from "~/infrastructure/http/InvocationIo";
import { describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import {
  isScheduleActive,
  doesAlertMatchSubscription,
  createLiveAlertEvaluatorService,
  AlertEvaluatorService,
  incidentKeyForAlert,
} from "~/services/notifications/AlertEvaluatorService";
import type { AgencyAlert, AgencySnapshot } from "~/agencies/types";
import type { CommuteSchedule } from "~/domain/preferences/UserPreferences";
import type {
  AlertDeliveryRecord,
  PushSubscriptionRecord,
  PushPayload,
} from "~/domain/notifications/types";
import {
  SubscriptionRepository,
  SubscriptionStorageError,
  createMemorySubscriptionRepository,
} from "~/infrastructure/storage/SubscriptionRepository";
import { logger } from "~/infrastructure/logging/logger";
import { createMockVapidClient } from "~/infrastructure/notifications/VapidClient";

// Fixtures date between August and October 2026; a fixed clock keeps retention from expiring them.
const memoryRepository = () =>
  createMemorySubscriptionRepository({ now: () => Date.parse("2026-09-15T12:00:00Z") });

describe("Commute Schedule Time Evaluation (isScheduleActive)", () => {
  const weekdaySchedule: CommuteSchedule = {
    id: "morning_commute",
    label: "Morning Commute",
    enabled: true,
    days: [1, 2, 3, 4, 5],
    start: "07:30",
    end: "09:30",
  };
  const overnightSchedule: CommuteSchedule = {
    id: "night_shift",
    label: "Night Shift",
    enabled: true,
    days: [3],
    start: "22:00",
    end: "02:00",
  };

  it.each([
    {
      label: "matching weekday inside the daytime window",
      schedule: weekdaySchedule,
      now: "2026-08-19T12:00:00Z",
      expected: true,
    },
    {
      label: "matching weekday outside the daytime window",
      schedule: weekdaySchedule,
      now: "2026-08-19T15:00:00Z",
      expected: false,
    },
    {
      label: "day omitted from the weekday window",
      schedule: weekdaySchedule,
      now: "2026-08-23T12:00:00Z",
      expected: false,
    },
    {
      label: "disabled matching window",
      schedule: { ...weekdaySchedule, id: "disabled", enabled: false },
      now: "2026-08-19T12:00:00Z",
      expected: false,
    },
    {
      label: "overnight window before midnight",
      schedule: overnightSchedule,
      now: "2026-08-20T03:00:00Z",
      expected: true,
    },
    {
      label: "overnight window after midnight",
      schedule: overnightSchedule,
      now: "2026-08-20T05:30:00Z",
      expected: true,
    },
    {
      label: "overnight window after its end time",
      schedule: overnightSchedule,
      now: "2026-08-20T06:30:00Z",
      expected: false,
    },
  ])("$label", ({ schedule, now, expected }) => {
    expect(isScheduleActive(schedule, "America/Toronto", new Date(now).getTime())).toBe(expected);
  });
});

describe("Alert Matching to Subscriptions (doesAlertMatchSubscription)", () => {
  const baseSub: PushSubscriptionRecord = {
    id: "sub_1",
    endpoint: "https://push.example.com/sub_1",
    p256dh: "key_p256dh",
    auth: "key_auth",
    favouriteLines: [
      { agencyId: "ttc", lineId: "1" },
      { agencyId: "ttc", lineId: "2" },
    ],
    favouriteStations: [
      { agencyId: "ttc", stationName: "Bloor-Yonge" },
      { agencyId: "ttc", stationName: "Union" },
    ],
    favouriteSurfaceRoutes: [
      { agencyId: "ttc", routeId: "504" },
      { agencyId: "ttc", routeId: "91" },
    ],
    commuteSchedules: [],
    timezone: "America/Toronto",
    createdAt: 1000,
    updatedAt: 1000,
  };

  const fixedNow = 1700000000000;

  it("matches alert for favourite subway line", () => {
    const alert: AgencyAlert = {
      id: "alert_line_1",
      kind: "suspension",
      affectedLineIds: ["1"],
      scope: "line",
      title: "Line 1: St Clair to Finch suspended",
      description: "Track work",
      severity: "severe",
      lifecycle: "active",
      startsAt: fixedNow,
      updatedAt: fixedNow,
    };

    expect(doesAlertMatchSubscription(alert, baseSub, "ttc").matches).toBe(true);
    expect(doesAlertMatchSubscription(alert, baseSub, "ttc").lineId).toBe("1");
  });

  it("matches a favourited line when it is not the first affected line", () => {
    const alert: AgencyAlert = {
      id: "alert_multi_line",
      kind: "suspension",
      affectedLineIds: ["1", "2"],
      scope: "line",
      title: "Lines 1 and 2 service suspended",
      description: "Shuttle buses are operating",
      severity: "severe",
      lifecycle: "active",
      startsAt: fixedNow,
      updatedAt: fixedNow,
    };
    const lineTwoOnly = {
      ...baseSub,
      favouriteLines: [{ agencyId: "ttc", lineId: "2" }],
      favouriteStations: [],
      favouriteSurfaceRoutes: [],
    };

    const result = doesAlertMatchSubscription(alert, lineTwoOnly, "ttc");

    expect(result.matches).toBe(true);
    expect(result.lineId).toBe("2");
  });

  it("scopes line favorites by agency when route numbers are reused", () => {
    const alert: AgencyAlert = {
      id: "kingston-line-number-2",
      kind: "suspension",
      affectedLineIds: ["2"],
      scope: "line",
      title: "Route 2 service suspended",
      severity: "severe",
      lifecycle: "active",
      startsAt: fixedNow,
      updatedAt: fixedNow,
    };
    const ttcLineTwoOnly = {
      ...baseSub,
      favouriteLines: [{ agencyId: "ttc", lineId: "2" }],
      favouriteStations: [],
      favouriteSurfaceRoutes: [],
    };

    expect(doesAlertMatchSubscription(alert, ttcLineTwoOnly, "kingston").matches).toBe(false);
    expect(doesAlertMatchSubscription(alert, ttcLineTwoOnly, "ttc").matches).toBe(true);
  });

  it("does not dispatch a same-number alert from an unrelated agency", async () => {
    const sentPushes: PushPayload[] = [];
    const mockVapidLayer = createMockVapidClient(async (_sub, payload) => {
      sentPushes.push(payload);
      return { success: true, statusCode: 201, expired: false };
    });
    const memorySubLayer = memoryRepository();
    const evaluatorLayer = createLiveAlertEvaluatorService();
    const layer = Layer.merge(evaluatorLayer, Layer.merge(memorySubLayer, mockVapidLayer)).pipe(
      Layer.provide(Layer.merge(memorySubLayer, mockVapidLayer)),
    );
    const fixedNow = new Date("2026-08-19T12:00:00Z").getTime();
    const testSub: PushSubscriptionRecord = {
      ...baseSub,
      commuteSchedules: [
        {
          id: "morn",
          label: "Morning",
          enabled: true,
          days: [1, 2, 3, 4, 5],
          start: "07:30",
          end: "09:30",
        },
      ],
    };

    const program = Effect.gen(function* () {
      const subRepo = yield* SubscriptionRepository;
      const evaluator = yield* AlertEvaluatorService;
      yield* subRepo.upsertSubscription(testSub);

      const result = yield* evaluator.evaluateAndDispatch(
        {
          agencyId: "kingston",
          generatedAt: fixedNow,
          freshness: "live",
          alerts: [
            {
              id: "kingston-route-2",
              kind: "suspension",
              affectedLineIds: ["2"],
              scope: "line",
              title: "Route 2 service suspended",
              severity: "severe",
              lifecycle: "active",
              startsAt: fixedNow,
              updatedAt: fixedNow,
            },
          ],
        },
        fixedNow,
      );

      expect(result.activePushesSent).toBe(0);
      expect(sentPushes).toHaveLength(0);
    }).pipe(Effect.provide(layer));

    await Effect.runPromise(program);
  });

  it("scopes station-name favorites by agency", () => {
    const alert: AgencyAlert = {
      id: "kingston-union",
      kind: "accessibility",
      scope: "network",
      title: "Union station elevator outage",
      severity: "severe",
      lifecycle: "active",
      startsAt: fixedNow,
      updatedAt: fixedNow,
    };
    const ttcStationOnly = {
      ...baseSub,
      favouriteLines: [],
      favouriteStations: [{ agencyId: "ttc", stationName: "Union" }],
      favouriteSurfaceRoutes: [],
    };

    expect(doesAlertMatchSubscription(alert, ttcStationOnly, "kingston").matches).toBe(false);
    expect(doesAlertMatchSubscription(alert, ttcStationOnly, "ttc").matches).toBe(true);
  });

  it.each([
    { label: "the canonical station", stationName: "Central", agencyId: "metro", expected: true },
    { label: "another agency", stationName: "Central", agencyId: "other-metro", expected: false },
    { label: "another station", stationName: "Uptown", agencyId: "metro", expected: false },
  ])("matches translated station alerts against $label", ({ stationName, agencyId, expected }) => {
    const alert: AgencyAlert = {
      id: "central-fr",
      kind: "accessibility",
      affectedStations: [{ stationName }],
      scope: "network",
      title: "Perturbation du service",
      severity: "severe",
      lifecycle: "active",
      startsAt: fixedNow,
      updatedAt: fixedNow,
    };
    const stationOnly = {
      ...baseSub,
      favouriteLines: [],
      favouriteStations: [{ agencyId: "metro", stationName: "Central" }],
      favouriteSurfaceRoutes: [],
    };

    expect(doesAlertMatchSubscription(alert, stationOnly, agencyId).matches).toBe(expected);
  });

  it("does not match a station favourite against a racetrack bus stop", () => {
    const alert: AgencyAlert = {
      id: "bus-stop-closure",
      kind: "suspension",
      affectedRouteIds: ["37A"],
      scope: "route",
      title:
        "37A Islington: Buses are not stopping near WOODBINE RACETRACK LOOP (MAIN ENTRANCE) due to a blocked road.",
      severity: "severe",
      lifecycle: "active",
      startsAt: fixedNow,
      updatedAt: fixedNow,
    };
    const subscription = {
      ...baseSub,
      favouriteLines: [{ agencyId: "metro", lineId: "2" }],
      favouriteStations: [{ agencyId: "metro", stationName: "Woodbine" }],
      favouriteSurfaceRoutes: [],
    };

    expect(doesAlertMatchSubscription(alert, subscription, "metro").matches).toBe(false);
  });

  it.each([
    { title: "Buses diverted via Woodbine Avenue", expected: false },
    { title: "Buses bypass Woodbine Station", expected: true },
    { title: "Buses bypass Woodbine Stationary Market", expected: false },
    { title: "Buses bypass EastWoodbine Station", expected: false },
    { title: "Buses bypass WOODBINE STATION", expected: true },
    {
      title: "No service between York and York University stations",
      stationName: "University",
      affectedStations: [
        { stationId: "york", stationName: "York" },
        { stationId: "york-university", stationName: "York University" },
      ],
      expected: false,
    },
    {
      title: "No service between College and Humber College stations",
      stationName: "Humber College",
      affectedStations: [{ stationId: "college", stationName: "College" }],
      expected: false,
    },
    {
      title: "No service between College and Humber College stations",
      stationName: "College",
      affectedStations: [{ stationId: "humber-college", stationName: "Humber College" }],
      expected: false,
    },
    {
      title: "No service between Duncanwoods and Humber College stations",
      stationName: "Humber College",
      affectedStations: [{ stationId: "humber-college", stationName: "Humber College" }],
      expected: true,
    },
    {
      title: "Line 6 Finch West: No service between Duncanwoods and Humber College stations",
      stationName: "College",
      affectedStations: [{ stationId: "humber-college", stationName: "Humber College" }],
      expected: false,
    },
    { title: "No service between Woodbine and Coxwell stations.", expected: true },
    { title: "No service between Coxwell and Woodbine stations.", expected: true },
    { title: "No service between Woodbine Racetrack and Islington stations.", expected: false },
    { title: "Service interrompu à la station Woodbine", expected: true },
    { title: "No service at Woodbine Station", stationName: "Woodbine Station", expected: true },
    { title: "No service at École Station", stationName: "École", expected: true },
    {
      title: "Line 2: No service at Woodbine Station",
      affectedStations: [{ stationName: "Line 2" }],
      expected: true,
    },
    {
      title: "Buses are not stopping near Woodbine Racetrack",
      affectedStations: [{ stationName: "Woodbine" }],
      expected: true,
    },
  ])(
    "uses station evidence for $title",
    ({ title, affectedStations, stationName = "Woodbine", expected }) => {
      const alert: AgencyAlert = {
        id: "station-evidence",
        kind: "suspension",
        scope: "route",
        title,
        affectedStations,
        severity: "severe",
        lifecycle: "active",
        startsAt: fixedNow,
        updatedAt: fixedNow,
      };
      const subscription = {
        ...baseSub,
        favouriteLines: [],
        favouriteStations: [{ agencyId: "metro", stationName }],
        favouriteSurfaceRoutes: [],
      };

      expect(doesAlertMatchSubscription(alert, subscription, "metro").matches).toBe(expected);
    },
  );

  it("matches alert for favourite station in description", () => {
    const alert: AgencyAlert = {
      id: "alert_station",
      kind: "accessibility",
      scope: "network",
      title: "Elevator Outage",
      description: "Elevator out of service at Bloor-Yonge station",
      severity: "severe",
      lifecycle: "active",
      startsAt: fixedNow,
      updatedAt: fixedNow,
    };

    expect(doesAlertMatchSubscription(alert, baseSub, "ttc").matches).toBe(true);
  });

  it("matches alert for favourite surface route", () => {
    const alert: AgencyAlert = {
      id: "alert_surface",
      kind: "delay",
      scope: "network",
      title: "504 King: Detour via Queen",
      description: "Construction on King St",
      severity: "severe",
      lifecycle: "active",
      startsAt: fixedNow,
      updatedAt: fixedNow,
    };

    expect(doesAlertMatchSubscription(alert, baseSub, "ttc").matches).toBe(true);
    expect(doesAlertMatchSubscription(alert, baseSub, "ttc").routeId).toBe("504");
  });

  it("matches a surface favourite only within its associated agency", () => {
    const alert: AgencyAlert = {
      id: "alert_501",
      kind: "delay",
      affectedRouteIds: ["501"],
      scope: "route",
      title: "501 delayed",
      severity: "degraded",
      lifecycle: "active",
      startsAt: fixedNow,
      updatedAt: fixedNow,
    };
    const kingstonOnly = {
      ...baseSub,
      favouriteLines: [],
      favouriteStations: [],
      favouriteSurfaceRoutes: [{ agencyId: "kingston", routeId: "501" }],
    };

    expect(doesAlertMatchSubscription(alert, kingstonOnly, "ttc").matches).toBe(false);
    expect(doesAlertMatchSubscription(alert, kingstonOnly, "kingston").matches).toBe(true);
  });

  it("rejects non-matching alerts", () => {
    const alert: AgencyAlert = {
      id: "alert_other",
      kind: "delay",
      affectedLineIds: ["4"],
      scope: "line",
      title: "Line 4: Single train operation",
      description: "Maintenance on Line 4",
      severity: "severe",
      lifecycle: "active",
      startsAt: fixedNow,
      updatedAt: fixedNow,
    };

    expect(doesAlertMatchSubscription(alert, baseSub, "ttc").matches).toBe(false);
  });

  it("still matches a favourited surface route via title text when structured attribution omits it", () => {
    // Ingest attributed this severe suspension to route 999 only; the user's
    // favourited 504 appears solely in the alert's title. Structured
    // attribution is consulted first, but a miss must not silently discard
    // the text safety net.
    const attributedElsewhere: AgencyAlert = {
      id: "alert_attributed_elsewhere",
      kind: "suspension",
      severity: "severe",
      lifecycle: "active",
      affectedRouteIds: ["999"],
      scope: "route",
      title: "504 King: Service suspended both directions",
      description: "Shuttle buses are operating",
      startsAt: fixedNow,
      updatedAt: fixedNow,
    };

    const result = doesAlertMatchSubscription(attributedElsewhere, baseSub, "ttc");
    expect(result.matches).toBe(true);
    expect(result.routeId).toBe("504");
  });
});

describe("incidentKeyForAlert (content-hash incident identity)", () => {
  const fixedNow = 1700000000000;
  const baseAlert: AgencyAlert = {
    id: "upstream-1",
    kind: "suspension",
    affectedLineIds: ["1"],
    scope: "line",
    title: "Line 1: St Clair to Finch suspended",
    description: "Signal failure",
    severity: "severe",
    lifecycle: "active",
    startsAt: fixedNow,
    updatedAt: fixedNow,
  };
  const keyFor = (alert: AgencyAlert, agencyId = "ttc") => incidentKeyForAlert(agencyId, alert);

  it.each([
    ["upstream id churn", { id: "upstream-2" }],
    ["title case and whitespace churn", { title: "  LINE 1: st clair TO finch SUSPENDED " }],
    ["corrected timestamps", { startsAt: fixedNow + 3_600_000, endsAt: fixedNow + 7_200_000 }],
    ["rewritten description", { description: "Signal problems near St Clair" }],
    ["missing description", { description: undefined }],
  ])("stays stable across %s", (_name, override) => {
    expect(keyFor({ ...baseAlert, ...override })).toBe(keyFor(baseAlert));
  });

  it("ignores attribution order", () => {
    const ordered: AgencyAlert = { ...baseAlert, affectedLineIds: ["1", "2"] };
    const shuffled: AgencyAlert = { ...baseAlert, affectedLineIds: ["2", "1"] };
    expect(keyFor(shuffled)).toBe(keyFor(ordered));
  });

  it.each([
    ["rewritten headline", { title: "Line 1: Finch to Sheppard suspended" }],
    ["different line", { affectedLineIds: ["2"] }],
    ["escalated severity", { severity: "degraded" as const }],
    ["reclassified kind", { kind: "delay" as const }],
  ])("changes for a new incident (%s)", (_name, override) => {
    expect(keyFor({ ...baseAlert, ...override })).not.toBe(keyFor(baseAlert));
  });

  it("scopes the same content by agency", () => {
    expect(keyFor(baseAlert, "go")).not.toBe(keyFor(baseAlert, "ttc"));
  });

  it("uses only an explicitly configured article identity for translated source variants", () => {
    const english: AgencyAlert = {
      ...baseAlert,
      id: "https://operator.example/e/1042",
      incidentIdentity: { namespace: "service-updates", value: "1042" },
    };
    const french: AgencyAlert = {
      ...english,
      id: "https://operator.example/f/1042",
      title: "Circuit 42 suspendu près de la station Centrale",
    };

    expect(keyFor(english)).toBe(keyFor(french));
    expect(keyFor(english, "go")).not.toBe(keyFor(french, "ttc"));
    expect(keyFor({ ...french, incidentIdentity: undefined })).not.toBe(keyFor(english));
  });

  it("keeps a declared article identity when translations classify differently", () => {
    const english: AgencyAlert = {
      ...baseAlert,
      incidentIdentity: { namespace: "service-updates", value: "1042" },
    };
    const french: AgencyAlert = {
      ...english,
      title: "Circuit 42 : retards importants",
      kind: "delay",
    };

    expect(keyFor(french)).toBe(keyFor(english));
  });
});

describe("AlertEvaluatorService Evaluation & Deduplication", () => {
  it("keeps delivery deduplication isolated when agencies reuse an alert id", async () => {
    const sentPushes: PushPayload[] = [];
    const mockVapidLayer = createMockVapidClient(async (_sub, payload) => {
      sentPushes.push(payload);
      return { success: true, statusCode: 201, expired: false };
    });
    const memorySubLayer = memoryRepository();
    const evaluatorLayer = createLiveAlertEvaluatorService();
    const layer = Layer.merge(evaluatorLayer, Layer.merge(memorySubLayer, mockVapidLayer)).pipe(
      Layer.provide(Layer.merge(memorySubLayer, mockVapidLayer)),
    );
    const fixedNow = new Date("2026-08-19T12:00:00Z").getTime();
    const testSub: PushSubscriptionRecord = {
      id: "sub_shared-alert-id",
      endpoint: "https://push.example.com/shared-alert-id",
      p256dh: "key_p256dh",
      auth: "key_auth",
      favouriteLines: [
        { agencyId: "ttc", lineId: "2" },
        { agencyId: "kingston", lineId: "2" },
      ],
      favouriteStations: [],
      favouriteSurfaceRoutes: [],
      commuteSchedules: [
        {
          id: "morn",
          label: "Morning",
          enabled: true,
          days: [1, 2, 3, 4, 5],
          start: "07:30",
          end: "09:30",
        },
      ],
      timezone: "America/Toronto",
      createdAt: fixedNow,
      updatedAt: fixedNow,
    };
    const snapshot = (agencyId: string): AgencySnapshot => ({
      agencyId,
      generatedAt: fixedNow,
      freshness: "live",
      alerts: [
        {
          id: "shared-provider-alert-id",
          kind: "suspension",
          affectedLineIds: ["2"],
          scope: "line",
          title: "Route 2 service suspended",
          severity: "severe",
          lifecycle: "active",
          startsAt: fixedNow,
          updatedAt: fixedNow,
        },
      ],
    });

    const program = Effect.gen(function* () {
      const subRepo = yield* SubscriptionRepository;
      const evaluator = yield* AlertEvaluatorService;
      yield* subRepo.upsertSubscription(testSub);

      expect(
        (yield* evaluator.evaluateAndDispatch(snapshot("ttc"), fixedNow)).activePushesSent,
      ).toBe(1);
      expect(
        (yield* evaluator.evaluateAndDispatch(snapshot("kingston"), fixedNow)).activePushesSent,
      ).toBe(1);
      expect(
        (yield* evaluator.evaluateAndDispatch(snapshot("ttc"), fixedNow)).activePushesSent,
      ).toBe(0);
      expect(sentPushes).toHaveLength(2);
      expect(sentPushes[0]?.tag).not.toBe(sentPushes[1]?.tag);
      expect(sentPushes.map((payload) => payload.data?.agencyId).sort()).toEqual([
        "kingston",
        "ttc",
      ]);
    }).pipe(Effect.provide(layer));

    await Effect.runPromise(program);
  });

  it("evaluates severe alerts, dispatches pushes, and deduplicates subsequent runs", async () => {
    const sentPushes: Array<{ subId: string; title: string }> = [];

    const mockVapidLayer = createMockVapidClient(async (sub, payload) => {
      sentPushes.push({ subId: sub.id, title: payload.title });
      return { success: true, statusCode: 201, expired: false };
    });

    const memorySubLayer = memoryRepository();
    const evaluatorLayer = createLiveAlertEvaluatorService();

    const layer = Layer.merge(evaluatorLayer, Layer.merge(memorySubLayer, mockVapidLayer)).pipe(
      Layer.provide(Layer.merge(memorySubLayer, mockVapidLayer)),
    );

    // 08:00 EDT on Wednesday (active morning commute)
    const fixedNow = new Date("2026-08-19T12:00:00Z").getTime();

    const testSub: PushSubscriptionRecord = {
      id: "sub_alice",
      endpoint: "https://push.example.com/alice",
      p256dh: "key_p256dh",
      auth: "key_auth",
      favouriteLines: [{ agencyId: "ttc", lineId: "1" }],
      favouriteStations: [],
      favouriteSurfaceRoutes: [],
      commuteSchedules: [
        {
          id: "morn",
          label: "Morning",
          enabled: true,
          days: [1, 2, 3, 4, 5],
          start: "07:30",
          end: "09:30",
        },
      ],
      timezone: "America/Toronto",
      createdAt: fixedNow,
      updatedAt: fixedNow,
    };

    const snapshot: AgencySnapshot = {
      agencyId: "ttc",
      generatedAt: fixedNow,
      freshness: "live",
      alerts: [
        {
          id: "severe_line_1",
          kind: "suspension",
          affectedLineIds: ["1"],
          scope: "line",
          title: "Line 1: St Clair to Finch Suspended",
          description: "Signal failure",
          severity: "severe",
          lifecycle: "active",
          startsAt: fixedNow,
          updatedAt: fixedNow,
        },
      ],
    };

    const program = Effect.gen(function* () {
      const subRepo = yield* SubscriptionRepository;
      const evaluator = yield* AlertEvaluatorService;

      // 1. Seed subscription
      yield* subRepo.upsertSubscription(testSub);

      // 2. First evaluation run: should dispatch push
      const res1 = yield* evaluator.evaluateAndDispatch(snapshot, fixedNow);
      expect(res1.activePushesSent).toBe(1);
      expect(sentPushes.length).toBe(1);
      expect(sentPushes[0].title).toContain("Line 1");

      // 3. Second evaluation run with same alert: should DEDUPLICATE (0 pushes sent)
      const res2 = yield* evaluator.evaluateAndDispatch(snapshot, fixedNow);
      expect(res2.activePushesSent).toBe(0);
      expect(sentPushes.length).toBe(1); // No new push sent!

      // 4. Third evaluation run with cleared alert: should dispatch RECOVERY notification
      const clearedSnapshot: AgencySnapshot = {
        ...snapshot,
        alerts: [], // Disruption cleared!
      };
      const res3 = yield* evaluator.evaluateAndDispatch(clearedSnapshot, fixedNow);
      expect(res3.clearedPushesSent).toBe(1);
      expect(sentPushes.length).toBe(2);
      expect(sentPushes[1].title).toContain("Service Resumed");
      expect(sentPushes[1].title).toContain("Line 1");
    }).pipe(Effect.provide(layer));

    await Effect.runPromise(program);
  });

  it("does not send expired severe alerts and recovers a previously active alert", async () => {
    const sentPushes: PushPayload[] = [];

    const mockVapidLayer = createMockVapidClient(async (_sub, payload) => {
      sentPushes.push(payload);
      return { success: true, statusCode: 201, expired: false };
    });

    const memorySubLayer = memoryRepository();
    const evaluatorLayer = createLiveAlertEvaluatorService();
    const layer = Layer.merge(evaluatorLayer, Layer.merge(memorySubLayer, mockVapidLayer)).pipe(
      Layer.provide(Layer.merge(memorySubLayer, mockVapidLayer)),
    );
    const fixedNow = new Date("2026-09-08T12:00:00Z").getTime();
    const testSub: PushSubscriptionRecord = {
      id: "sub_expired_alert",
      endpoint: "https://push.example.com/expired-alert",
      p256dh: "key_p256dh",
      auth: "key_auth",
      favouriteLines: [{ agencyId: "ttc", lineId: "2" }],
      favouriteStations: [],
      favouriteSurfaceRoutes: [],
      commuteSchedules: [
        {
          id: "morn",
          label: "Morning",
          enabled: true,
          days: [1, 2, 3, 4, 5],
          start: "07:30",
          end: "09:30",
        },
      ],
      timezone: "America/Toronto",
      createdAt: fixedNow,
      updatedAt: fixedNow,
    };
    const alert: AgencySnapshot["alerts"][number] = {
      id: "line-2-broadview-victoria-park",
      kind: "suspension",
      affectedLineIds: ["2"],
      scope: "line",
      title: "Line 2: No service between Broadview and Victoria Park stations",
      description: "Shuttle buses are running.",
      severity: "severe",
      lifecycle: "active",
      startsAt: fixedNow - 60_000,
      updatedAt: fixedNow,
    };

    const program = Effect.gen(function* () {
      const subRepo = yield* SubscriptionRepository;
      const evaluator = yield* AlertEvaluatorService;
      yield* subRepo.upsertSubscription(testSub);

      const activeResult = yield* evaluator.evaluateAndDispatch(
        {
          agencyId: "ttc",
          generatedAt: fixedNow,
          freshness: "live",
          alerts: [alert],
        },
        fixedNow,
      );
      expect(activeResult.activePushesSent).toBe(1);

      const endedResult = yield* evaluator.evaluateAndDispatch(
        {
          agencyId: "ttc",
          generatedAt: fixedNow,
          freshness: "live",
          alerts: [{ ...alert, lifecycle: "expired", endsAt: fixedNow - 1 }],
        },
        fixedNow,
      );
      expect(endedResult.activePushesSent).toBe(0);
      expect(endedResult.clearedPushesSent).toBe(1);
      expect(sentPushes).toHaveLength(2);
      expect(sentPushes[1]?.title).toContain("Service Resumed");
    }).pipe(Effect.provide(layer));

    await Effect.runPromise(program);
  });

  it("dispatches push payloads whose title and body contain visible non-whitespace text", async () => {
    const capturedPayloads: PushPayload[] = [];

    const mockVapidLayer = createMockVapidClient(async (_sub, payload) => {
      capturedPayloads.push(payload);
      return { success: true, statusCode: 201, expired: false };
    });

    const memorySubLayer = memoryRepository();
    const evaluatorLayer = createLiveAlertEvaluatorService();

    const layer = Layer.merge(evaluatorLayer, Layer.merge(memorySubLayer, mockVapidLayer)).pipe(
      Layer.provide(Layer.merge(memorySubLayer, mockVapidLayer)),
    );

    // 08:00 EDT on Wednesday (active morning commute)
    const fixedNow = new Date("2026-08-19T12:00:00Z").getTime();

    const testSub: PushSubscriptionRecord = {
      id: "sub_payload_invariant",
      endpoint: "https://push.example.com/payload-invariant",
      p256dh: "key_p256dh",
      auth: "key_auth",
      favouriteLines: [{ agencyId: "ttc", lineId: "1" }],
      favouriteStations: [],
      favouriteSurfaceRoutes: [],
      commuteSchedules: [
        {
          id: "morn",
          label: "Morning",
          enabled: true,
          days: [1, 2, 3, 4, 5],
          start: "07:30",
          end: "09:30",
        },
      ],
      timezone: "America/Toronto",
      createdAt: fixedNow,
      updatedAt: fixedNow,
    };

    const snapshot: AgencySnapshot = {
      agencyId: "ttc",
      generatedAt: fixedNow,
      freshness: "live",
      alerts: [
        {
          // Whitespace-only feed text survives the parser's || fallback chain
          // (headerText "   " is truthy) and must not yield a blank notification
          id: "severe_whitespace_text",
          kind: "suspension",
          affectedLineIds: ["1"],
          scope: "line",
          title: "   ",
          description: "   ",
          severity: "severe",
          lifecycle: "active",
          startsAt: fixedNow,
          updatedAt: fixedNow,
        },
      ],
    };

    const program = Effect.gen(function* () {
      const subRepo = yield* SubscriptionRepository;
      const evaluator = yield* AlertEvaluatorService;

      yield* subRepo.upsertSubscription(testSub);

      const res = yield* evaluator.evaluateAndDispatch(snapshot, fixedNow);
      expect(res.activePushesSent).toBe(1);
      expect(capturedPayloads.length).toBe(1);

      for (const payload of capturedPayloads) {
        expect(payload.title.trim().length).toBeGreaterThan(0);
        expect(payload.body.trim().length).toBeGreaterThan(0);
      }
    }).pipe(Effect.provide(layer));

    await Effect.runPromise(program);
  });

  it("dispatches a severe push for a favourited surface route when ingest attribution omits the route", async () => {
    const sentPushes: Array<{ subId: string; title: string }> = [];

    const mockVapidLayer = createMockVapidClient(async (sub, payload) => {
      sentPushes.push({ subId: sub.id, title: payload.title });
      return { success: true, statusCode: 201, expired: false };
    });

    const memorySubLayer = memoryRepository();
    const evaluatorLayer = createLiveAlertEvaluatorService();

    const layer = Layer.merge(evaluatorLayer, Layer.merge(memorySubLayer, mockVapidLayer)).pipe(
      Layer.provide(Layer.merge(memorySubLayer, mockVapidLayer)),
    );

    // 08:00 EDT on Wednesday (active morning commute)
    const fixedNow = new Date("2026-08-19T12:00:00Z").getTime();

    const testSub: PushSubscriptionRecord = {
      id: "sub_route_fan",
      endpoint: "https://push.example.com/route-fan",
      p256dh: "key_p256dh",
      auth: "key_auth",
      favouriteLines: [],
      favouriteStations: [],
      favouriteSurfaceRoutes: [{ agencyId: "ttc", routeId: "504" }],
      commuteSchedules: [
        {
          id: "morn",
          label: "Morning",
          enabled: true,
          days: [1, 2, 3, 4, 5],
          start: "07:30",
          end: "09:30",
        },
      ],
      timezone: "America/Toronto",
      createdAt: fixedNow,
      updatedAt: fixedNow,
    };

    const snapshot: AgencySnapshot = {
      agencyId: "ttc",
      generatedAt: fixedNow,
      freshness: "live",
      alerts: [
        {
          id: "severe_504_text_only_match",
          kind: "suspension",
          severity: "severe",
          lifecycle: "active",
          affectedRouteIds: ["999"],
          scope: "route",
          title: "504 King: Service suspended both directions",
          description: "Shuttle buses are operating",
          startsAt: fixedNow,
          updatedAt: fixedNow,
        },
      ],
    };

    const program = Effect.gen(function* () {
      const subRepo = yield* SubscriptionRepository;
      const evaluator = yield* AlertEvaluatorService;

      yield* subRepo.upsertSubscription(testSub);

      const res = yield* evaluator.evaluateAndDispatch(snapshot, fixedNow);
      expect(res.activePushesSent).toBe(1);
      expect(sentPushes.length).toBe(1);
      expect(sentPushes[0].title).toContain("504 King");
    }).pipe(Effect.provide(layer));

    await Effect.runPromise(program);
  });

  it("prunes expired subscriptions when push service returns 404/410", async () => {
    const mockVapidLayer = createMockVapidClient(async () => {
      return { success: false, statusCode: 410, expired: true, error: "Gone" };
    });

    const memorySubLayer = memoryRepository();
    const evaluatorLayer = createLiveAlertEvaluatorService();

    const layer = Layer.merge(evaluatorLayer, Layer.merge(memorySubLayer, mockVapidLayer)).pipe(
      Layer.provide(Layer.merge(memorySubLayer, mockVapidLayer)),
    );

    const fixedNow = new Date("2026-08-19T12:00:00Z").getTime();

    const expiredSub: PushSubscriptionRecord = {
      id: "sub_expired",
      endpoint: "https://push.example.com/expired",
      p256dh: "key_p256dh",
      auth: "key_auth",
      favouriteLines: [{ agencyId: "ttc", lineId: "1" }],
      favouriteStations: [],
      favouriteSurfaceRoutes: [],
      commuteSchedules: [
        {
          id: "morn",
          label: "Morning",
          enabled: true,
          days: [1, 2, 3, 4, 5],
          start: "07:30",
          end: "09:30",
        },
      ],
      timezone: "America/Toronto",
      createdAt: fixedNow,
      updatedAt: fixedNow,
    };

    const snapshot: AgencySnapshot = {
      agencyId: "ttc",
      generatedAt: fixedNow,
      freshness: "live",
      alerts: [
        {
          id: "severe_1",
          kind: "suspension",
          affectedLineIds: ["1"],
          title: "Suspension",
          description: "Major incident",
          severity: "severe",
          lifecycle: "active",
          scope: "line",
          startsAt: fixedNow,
          updatedAt: fixedNow,
        },
      ],
    };

    const program = Effect.gen(function* () {
      const subRepo = yield* SubscriptionRepository;
      const evaluator = yield* AlertEvaluatorService;

      yield* subRepo.upsertSubscription(expiredSub);
      expect((yield* subRepo.getActiveSubscriptions()).length).toBe(1);

      const res = yield* evaluator.evaluateAndDispatch(snapshot, fixedNow);
      expect(res.expiredSubscriptionsPruned).toBe(1);

      // Subscription should be pruned from repository
      expect((yield* subRepo.getActiveSubscriptions()).length).toBe(0);
    }).pipe(Effect.provide(layer));

    await Effect.runPromise(program);
  });

  it("does not re-push when the same incident is republished under a new upstream id", async () => {
    const sentPushes: PushPayload[] = [];
    const mockVapidLayer = createMockVapidClient(async (_sub, payload) => {
      sentPushes.push(payload);
      return { success: true, statusCode: 201, expired: false };
    });
    const memorySubLayer = memoryRepository();
    const evaluatorLayer = createLiveAlertEvaluatorService();
    const layer = Layer.merge(evaluatorLayer, Layer.merge(memorySubLayer, mockVapidLayer)).pipe(
      Layer.provide(Layer.merge(memorySubLayer, mockVapidLayer)),
    );
    // 08:00 EDT on Wednesday (active morning commute)
    const fixedNow = new Date("2026-08-19T12:00:00Z").getTime();
    const testSub: PushSubscriptionRecord = {
      id: "sub_id_churn",
      endpoint: "https://push.example.com/id-churn",
      p256dh: "key_p256dh",
      auth: "key_auth",
      favouriteLines: [{ agencyId: "ttc", lineId: "1" }],
      favouriteStations: [],
      favouriteSurfaceRoutes: [],
      commuteSchedules: [
        {
          id: "morn",
          label: "Morning",
          enabled: true,
          days: [1, 2, 3, 4, 5],
          start: "07:30",
          end: "09:30",
        },
      ],
      timezone: "America/Toronto",
      createdAt: fixedNow,
      updatedAt: fixedNow,
    };
    const incident = {
      kind: "suspension" as const,
      affectedLineIds: ["1"],
      scope: "line" as const,
      title: "Line 1: St Clair to Finch suspended",
      description: "Signal failure",
      severity: "severe" as const,
      lifecycle: "active" as const,
      startsAt: fixedNow,
      updatedAt: fixedNow,
    };

    const program = Effect.gen(function* () {
      const subRepo = yield* SubscriptionRepository;
      const evaluator = yield* AlertEvaluatorService;
      yield* subRepo.upsertSubscription(testSub);

      const first = yield* evaluator.evaluateAndDispatch(
        {
          agencyId: "ttc",
          generatedAt: fixedNow,
          freshness: "live",
          alerts: [{ ...incident, id: "feed-id-a" }],
        },
        fixedNow,
      );
      expect(first.activePushesSent).toBe(1);

      // Same incident, new upstream id and corrected timestamps: no re-push, no recovery.
      const second = yield* evaluator.evaluateAndDispatch(
        {
          agencyId: "ttc",
          generatedAt: fixedNow,
          freshness: "live",
          alerts: [{ ...incident, id: "feed-id-b", startsAt: fixedNow + 60_000 }],
        },
        fixedNow,
      );
      expect(second.activePushesSent).toBe(0);
      expect(second.clearedPushesSent).toBe(0);
      expect(sentPushes).toHaveLength(1);
      expect(sentPushes[0]?.tag).toBe(
        `transit-alert-ttc-${incidentKeyForAlert("ttc", { ...incident, id: "feed-id-a" })}`,
      );
    }).pipe(Effect.provide(layer));

    await Effect.runPromise(program);
  });

  it("closes the old incident and pushes the new one when the headline changes", async () => {
    const sentPushes: PushPayload[] = [];
    const mockVapidLayer = createMockVapidClient(async (_sub, payload) => {
      sentPushes.push(payload);
      return { success: true, statusCode: 201, expired: false };
    });
    const memorySubLayer = memoryRepository();
    const evaluatorLayer = createLiveAlertEvaluatorService();
    const layer = Layer.merge(evaluatorLayer, Layer.merge(memorySubLayer, mockVapidLayer)).pipe(
      Layer.provide(Layer.merge(memorySubLayer, mockVapidLayer)),
    );
    const fixedNow = new Date("2026-08-19T12:00:00Z").getTime();
    const testSub: PushSubscriptionRecord = {
      id: "sub_headline_change",
      endpoint: "https://push.example.com/headline-change",
      p256dh: "key_p256dh",
      auth: "key_auth",
      favouriteLines: [{ agencyId: "ttc", lineId: "1" }],
      favouriteStations: [],
      favouriteSurfaceRoutes: [],
      commuteSchedules: [
        {
          id: "morn",
          label: "Morning",
          enabled: true,
          days: [1, 2, 3, 4, 5],
          start: "07:30",
          end: "09:30",
        },
      ],
      timezone: "America/Toronto",
      createdAt: fixedNow,
      updatedAt: fixedNow,
    };
    const base = {
      id: "stable-feed-id",
      kind: "suspension" as const,
      affectedLineIds: ["1"],
      scope: "line" as const,
      severity: "severe" as const,
      lifecycle: "active" as const,
      startsAt: fixedNow,
      updatedAt: fixedNow,
    };

    const program = Effect.gen(function* () {
      const subRepo = yield* SubscriptionRepository;
      const evaluator = yield* AlertEvaluatorService;
      yield* subRepo.upsertSubscription(testSub);

      yield* evaluator.evaluateAndDispatch(
        {
          agencyId: "ttc",
          generatedAt: fixedNow,
          freshness: "live",
          alerts: [{ ...base, title: "Line 1: St Clair to Finch suspended" }],
        },
        fixedNow,
      );

      const res = yield* evaluator.evaluateAndDispatch(
        {
          agencyId: "ttc",
          generatedAt: fixedNow,
          freshness: "live",
          alerts: [{ ...base, title: "Line 1: Finch to Sheppard suspended" }],
        },
        fixedNow,
      );
      // New incident pushes; the superseded headline sends no all-clear —
      // service never resumed, its description just moved.
      expect(res.activePushesSent).toBe(1);
      expect(res.clearedPushesSent).toBe(0);
      expect(sentPushes).toHaveLength(2);

      // The stored row tracks the new key: no per-tick duplicate push loop.
      const steady = yield* evaluator.evaluateAndDispatch(
        {
          agencyId: "ttc",
          generatedAt: fixedNow,
          freshness: "live",
          alerts: [{ ...base, title: "Line 1: Finch to Sheppard suspended" }],
        },
        fixedNow,
      );
      expect(steady.activePushesSent).toBe(0);
      expect(steady.clearedPushesSent).toBe(0);
      expect(sentPushes).toHaveLength(2);
    }).pipe(Effect.provide(layer));

    await Effect.runPromise(program);
  });

  it("pushes again when identical content recurs after clearing", async () => {
    const sentPushes: PushPayload[] = [];
    const mockVapidLayer = createMockVapidClient(async (_sub, payload) => {
      sentPushes.push(payload);
      return { success: true, statusCode: 201, expired: false };
    });
    const memorySubLayer = memoryRepository();
    const evaluatorLayer = createLiveAlertEvaluatorService();
    const layer = Layer.merge(evaluatorLayer, Layer.merge(memorySubLayer, mockVapidLayer)).pipe(
      Layer.provide(Layer.merge(memorySubLayer, mockVapidLayer)),
    );
    const fixedNow = new Date("2026-08-19T12:00:00Z").getTime();
    const testSub: PushSubscriptionRecord = {
      id: "sub_recurrence",
      endpoint: "https://push.example.com/recurrence",
      p256dh: "key_p256dh",
      auth: "key_auth",
      favouriteLines: [{ agencyId: "ttc", lineId: "1" }],
      favouriteStations: [],
      favouriteSurfaceRoutes: [],
      commuteSchedules: [
        {
          id: "morn",
          label: "Morning",
          enabled: true,
          days: [1, 2, 3, 4, 5],
          start: "07:30",
          end: "09:30",
        },
      ],
      timezone: "America/Toronto",
      createdAt: fixedNow,
      updatedAt: fixedNow,
    };
    const recurrence = {
      kind: "suspension" as const,
      affectedLineIds: ["1"],
      scope: "line" as const,
      title: "Line 1: St Clair to Finch suspended",
      description: "Signal failure",
      severity: "severe" as const,
      lifecycle: "active" as const,
      startsAt: fixedNow,
      updatedAt: fixedNow,
    };
    const live = (id: string): AgencySnapshot => ({
      agencyId: "ttc",
      generatedAt: fixedNow,
      freshness: "live",
      alerts: [{ ...recurrence, id }],
    });
    const cleared: AgencySnapshot = {
      agencyId: "ttc",
      generatedAt: fixedNow,
      freshness: "live",
      alerts: [],
    };

    const program = Effect.gen(function* () {
      const subRepo = yield* SubscriptionRepository;
      const evaluator = yield* AlertEvaluatorService;
      yield* subRepo.upsertSubscription(testSub);

      expect(
        (yield* evaluator.evaluateAndDispatch(live("feed-first"), fixedNow)).activePushesSent,
      ).toBe(1);
      expect((yield* evaluator.evaluateAndDispatch(cleared, fixedNow)).clearedPushesSent).toBe(1);

      // Same content months later under a new upstream id: a new edge, a new push.
      const again = yield* evaluator.evaluateAndDispatch(live("feed-second"), fixedNow);
      expect(again.activePushesSent).toBe(1);
      expect(sentPushes).toHaveLength(3);
      expect(sentPushes[2]?.title).toContain("Line 1");
    }).pipe(Effect.provide(layer));

    await Effect.runPromise(program);
  });
});

describe("notification failure diagnostics", () => {
  it.each(["active", "recovery"] as const)(
    "records a sanitized %s rejection without suppressing retry",
    async (phase) => {
      const now = Date.parse("2026-08-19T12:00:00Z");
      const sub: PushSubscriptionRecord = {
        id: "private-subscription",
        endpoint: "https://private.example/device",
        p256dh: "private-key",
        auth: "private-auth",
        timezone: "America/Toronto",
        favouriteLines: [{ agencyId: "ttc", lineId: "2" }],
        favouriteStations: [],
        favouriteSurfaceRoutes: [],
        commuteSchedules: [
          {
            id: "morning",
            label: "Morning",
            enabled: true,
            days: [3],
            start: "07:30",
            end: "09:30",
          },
        ],
        createdAt: now,
        updatedAt: now,
      };
      const alert: AgencyAlert = {
        id: "closure",
        kind: "suspension",
        severity: "severe",
        scope: "line",
        lifecycle: "active",
        title: "Line 2 suspended",
        affectedLineIds: ["2"],
        startsAt: now,
        updatedAt: now,
      };
      const key = incidentKeyForAlert("ttc", alert);
      const repository = memoryRepository();
      const transport = createMockVapidClient(async () => ({
        success: false,
        expired: false,
        statusCode: 503,
        error: `${sub.endpoint} ${sub.auth} ${sub.p256dh}`,
      }));
      const deps = Layer.merge(repository, transport);
      const layer = Layer.merge(deps, createLiveAlertEvaluatorService().pipe(Layer.provide(deps)));
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
      const info = vi.spyOn(logger, "info").mockImplementation(() => {});
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const repo = yield* SubscriptionRepository;
            const evaluator = yield* AlertEvaluatorService;
            yield* repo.upsertSubscription(sub);
            if (phase === "recovery")
              yield* repo.recordDelivery({
                id: "previous",
                agencyId: "ttc",
                alertId: alert.id,
                incidentKey: key,
                subscriptionId: sub.id,
                status: "active_sent",
                deliveredAt: now - 1000,
                lineId: "2",
              });
            const summary = yield* evaluator.evaluateAndDispatch(
              {
                agencyId: "ttc",
                generatedAt: now,
                freshness: "live",
                alerts: phase === "active" ? [alert] : [],
              },
              now,
            );
            expect(summary.activePushesSent + summary.clearedPushesSent).toBe(0);
            const delivery = yield* repo.getDelivery("ttc", alert.id, sub.id);
            expect(delivery?.status ?? null).toBe(phase === "active" ? null : "active_sent");
          }).pipe(Effect.provide(layer)),
        );
        expect(warn).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            stage: "push",
            phase,
            agencyId: "ttc",
            alertId: "closure",
            outcome: "rejected",
            statusCode: 503,
            observedAt: expect.any(Number),
            elapsedMs: expect.any(Number),
          }),
        );
        const logs = JSON.stringify([...warn.mock.calls, ...info.mock.calls]);
        for (const secret of [sub.id, sub.endpoint, sub.p256dh, sub.auth])
          expect(logs).not.toContain(secret);
      } finally {
        warn.mockRestore();
        info.mockRestore();
      }
    },
  );
});

describe("invocation budget deferral", () => {
  it("retries deferred recipients next cycle while deduping accepted sends and retaining subscriptions", async () => {
    const now = Date.parse("2026-10-09T12:00:00Z");
    const upstream = vi.fn(async () => new Response(null, { status: 201 }));
    const mockVapid = createMockVapidClient(async (_sub, _payload, options) => {
      const response = await options!.fetch!("https://push.example.test/send");
      return { success: response.ok, statusCode: response.status, expired: false };
    });
    const repository = memoryRepository();
    const dependencies = Layer.merge(repository, mockVapid);
    const layer = Layer.merge(createLiveAlertEvaluatorService(), dependencies).pipe(
      Layer.provide(dependencies),
    );
    const snapshot: AgencySnapshot = {
      agencyId: "fictional",
      generatedAt: now,
      freshness: "live",
      alerts: [
        {
          id: "incident",
          title: "Line A suspended",
          kind: "suspension",
          severity: "severe",
          lifecycle: "active",
          scope: "line",
          affectedLineIds: ["A"],
          startsAt: now,
          updatedAt: now,
        },
      ],
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* SubscriptionRepository;
        const evaluator = yield* AlertEvaluatorService;
        for (const id of ["one", "two", "three"])
          yield* repo.upsertSubscription({
            id,
            endpoint: `https://push.example.test/${id}`,
            p256dh: "fictional-key",
            auth: "fictional-auth",
            timezone: "UTC",
            favouriteLines: [{ agencyId: "fictional", lineId: "A" }],
            favouriteStations: [],
            favouriteSurfaceRoutes: [],
            commuteSchedules: [
              {
                id: "all-day",
                label: "All day",
                enabled: true,
                days: [0, 1, 2, 3, 4, 5, 6],
                start: "00:00",
                end: "23:59",
              },
            ],
            createdAt: now,
            updatedAt: now,
          });
        const firstIo = createCloudflareInvocationIo({ fetch: upstream as typeof fetch, limit: 2 });
        const first = yield* evaluator.evaluateAndDispatch(snapshot, now, {
          sendOptions: firstIo.sendOptions,
        });
        expect(first.activePushesSent).toBe(2);
        expect(first.expiredSubscriptionsPruned).toBe(0);
        const nextIo = createCloudflareInvocationIo({ fetch: upstream as typeof fetch, limit: 2 });
        const next = yield* evaluator.evaluateAndDispatch(snapshot, now, {
          sendOptions: nextIo.sendOptions,
        });
        expect(next.activePushesSent).toBe(1);
        expect(next.expiredSubscriptionsPruned).toBe(0);
        expect(yield* repo.getActiveSubscriptions()).toHaveLength(3);
        for (const id of ["one", "two", "three"])
          expect(yield* repo.getDeliveriesForSubscription("fictional", id)).toHaveLength(1);
      }).pipe(Effect.provide(layer)),
    );
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it("rotates the recipient start so a persistent rejection cannot starve later recipients", async () => {
    const now = Date.parse("2026-10-09T12:00:00Z");
    const attempted: string[] = [];
    const upstream = vi.fn(async (url: string) => {
      const id = new URL(url).pathname.slice(1);
      attempted.push(id);
      return new Response(null, { status: id === "one" ? 503 : 201 });
    });
    const mockVapid = createMockVapidClient(async (sub, _payload, options) => {
      const response = await options!.fetch!(sub.endpoint);
      return { success: response.ok, statusCode: response.status, expired: false };
    });
    const repository = memoryRepository();
    const dependencies = Layer.merge(repository, mockVapid);
    const layer = Layer.merge(createLiveAlertEvaluatorService(), dependencies).pipe(
      Layer.provide(dependencies),
    );
    const snapshot: AgencySnapshot = {
      agencyId: "fictional",
      generatedAt: now,
      freshness: "live",
      alerts: [
        {
          id: "incident",
          title: "Line A suspended",
          kind: "suspension",
          severity: "severe",
          lifecycle: "active",
          scope: "line",
          affectedLineIds: ["A"],
          startsAt: now,
          updatedAt: now,
        },
      ],
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* SubscriptionRepository;
        const evaluator = yield* AlertEvaluatorService;
        for (const id of ["one", "two", "three"])
          yield* repo.upsertSubscription({
            id,
            endpoint: `https://push.example.test/${id}`,
            p256dh: "fictional-key",
            auth: "fictional-auth",
            timezone: "UTC",
            favouriteLines: [{ agencyId: "fictional", lineId: "A" }],
            favouriteStations: [],
            favouriteSurfaceRoutes: [],
            commuteSchedules: [
              {
                id: "all-day",
                label: "All day",
                enabled: true,
                days: [0, 1, 2, 3, 4, 5, 6],
                start: "00:00",
                end: "23:59",
              },
            ],
            createdAt: now,
            updatedAt: now,
          });

        for (const recipientOffset of [0, 1, 2]) {
          const io = createCloudflareInvocationIo({
            fetch: upstream as typeof fetch,
            limit: 1,
          });
          const summary = yield* evaluator.evaluateAndDispatch(snapshot, now, {
            sendOptions: io.sendOptions,
            recipientOffset,
          });
          expect(summary.activePushesSent).toBe(recipientOffset === 0 ? 0 : 1);
        }
      }).pipe(Effect.provide(layer)),
    );

    // The first subscriber always rejects, but each later cadence puts the
    // next subscriber at the head of the one-request invocation budget.
    expect(attempted).toEqual(["one", "two", "three"]);
  });
});

it("uses fresh per-call subscription snapshots without rereading or capturing them", async () => {
  const { SubscriptionStorageError } =
    await import("~/infrastructure/storage/SubscriptionRepository");
  const read = vi.fn(() =>
    Effect.fail(new SubscriptionStorageError({ message: "unexpected read" })),
  );
  const repository = Layer.effect(
    SubscriptionRepository,
    Effect.gen(function* () {
      const memory = yield* SubscriptionRepository;
      return { ...memory, getActiveSubscriptions: read };
    }).pipe(Effect.provide(memoryRepository())),
  );
  const layer = createLiveAlertEvaluatorService().pipe(
    Layer.provide(
      Layer.merge(
        repository,
        createMockVapidClient(async () => ({ success: true, statusCode: 201, expired: false })),
      ),
    ),
  );
  const subscription: PushSubscriptionRecord = {
    id: "cycle-subscriber",
    endpoint: "https://example.test/cycle-push",
    auth: "fictional",
    p256dh: "fictional",
    favouriteLines: [{ agencyId: "sample", lineId: "A" }],
    favouriteStations: [],
    favouriteSurfaceRoutes: [],
    commuteSchedules: [
      {
        id: "all-day",
        label: "All day",
        enabled: true,
        days: [0, 1, 2, 3, 4, 5, 6],
        start: "00:00",
        end: "23:59",
      },
    ],
    timezone: "America/Toronto",
    createdAt: 0,
    updatedAt: 0,
  };
  const snapshot: AgencySnapshot = {
    agencyId: "sample",
    freshness: "live",
    generatedAt: 0,
    alerts: [],
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const evaluator = yield* AlertEvaluatorService;
      const first = yield* evaluator.evaluateAndDispatch(snapshot, 0, {
        subscriptions: [subscription],
      });
      const second = yield* evaluator.evaluateAndDispatch(snapshot, 0, { subscriptions: [] });
      expect(first.subscriptionsChecked).toBe(1);
      expect(second.subscriptionsChecked).toBe(0);
      expect(read).not.toHaveBeenCalled();
      const fallback = yield* Effect.exit(evaluator.evaluateAndDispatch(snapshot, 0));
      expect(fallback._tag).toBe("Failure");
      expect(read).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(layer)),
  );
});

describe("locale-aware notification delivery history", () => {
  it("does not resend a translated article and silently retires old-language history on an empty snapshot", async () => {
    const now = Date.parse("2026-08-19T12:00:00Z");
    const sent: PushPayload[] = [];
    const subscription: PushSubscriptionRecord = {
      id: "locale-subscription",
      endpoint: "https://push.example/device",
      p256dh: "public-key",
      auth: "auth-key",
      locale: "fr-CA",
      timezone: "America/Toronto",
      favouriteLines: [{ agencyId: "metro", lineId: "A" }],
      favouriteStations: [],
      favouriteSurfaceRoutes: [],
      commuteSchedules: [
        { id: "workday", label: "Workday", enabled: true, days: [3], start: "07:30", end: "09:30" },
      ],
      createdAt: now,
      updatedAt: now,
    };
    const englishAlert: AgencyAlert = {
      id: "https://operator.example/e/1042",
      kind: "suspension",
      scope: "line",
      affectedLineIds: ["A"],
      title: "Central station detour",
      description: "Service is rerouted near Central station.",
      incidentIdentity: { namespace: "service-updates", value: "1042" },
      severity: "severe",
      lifecycle: "active",
      startsAt: now,
      updatedAt: now,
    };
    const frenchAlert: AgencyAlert = {
      ...englishAlert,
      id: "https://operator.example/f/1042",
      title: "Déviation à la station Centrale",
      description: "Le service est dévié près de la station Centrale.",
    };
    const repository = memoryRepository();
    const transport = createMockVapidClient(async (_sub, payload) => {
      sent.push(payload);
      return { success: true, statusCode: 201, expired: false };
    });
    const dependencies = Layer.merge(repository, transport);
    const layer = Layer.merge(
      dependencies,
      createLiveAlertEvaluatorService().pipe(Layer.provide(dependencies)),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* SubscriptionRepository;
        const evaluator = yield* AlertEvaluatorService;
        yield* repo.upsertSubscription(subscription);
        yield* repo.recordDelivery({
          id: "english-delivery",
          agencyId: "metro",
          alertId: englishAlert.id,
          incidentKey: incidentKeyForAlert("metro", englishAlert),
          subscriptionId: subscription.id,
          locale: "en-CA",
          status: "active_sent",
          deliveredAt: now - 60_000,
          lineId: "A",
        });

        const summary = yield* evaluator.evaluateAndDispatch(
          { agencyId: "metro", generatedAt: now, freshness: "live", alerts: [frenchAlert] },
          now,
          { locale: "fr-CA" },
        );
        const oldDelivery = yield* repo.getDelivery("metro", englishAlert.id, subscription.id);
        const newDelivery = yield* repo.getDelivery("metro", frenchAlert.id, subscription.id);

        expect(summary).toMatchObject({ activePushesSent: 0, clearedPushesSent: 0 });
        expect(oldDelivery?.status).toBe("active_sent");
        expect(oldDelivery?.locale).toBe("en-CA");
        expect(newDelivery).toBeNull();
        expect(incidentKeyForAlert("metro", englishAlert)).toBe(
          incidentKeyForAlert("metro", frenchAlert),
        );
        expect(sent).toHaveLength(0);

        yield* evaluator.evaluateAndDispatch(
          { agencyId: "metro", generatedAt: now + 30_000, freshness: "stale", alerts: [] },
          now + 30_000,
          { locale: "fr-CA" },
        );
        expect((yield* repo.getDelivery("metro", englishAlert.id, subscription.id))?.status).toBe(
          "active_sent",
        );

        const recovery = yield* evaluator.evaluateAndDispatch(
          { agencyId: "metro", generatedAt: now + 60_000, freshness: "live", alerts: [] },
          now + 60_000,
          { locale: "fr-CA" },
        );
        expect(recovery.clearedPushesSent).toBe(0);
        expect((yield* repo.getDelivery("metro", englishAlert.id, subscription.id))?.status).toBe(
          "cleared_silent",
        );
        expect(sent).toHaveLength(0);
      }).pipe(Effect.provide(layer)),
    );
  });

  it.each(["A", "B"] as const)(
    "silently clears an ended configured article while another incident remains on line %s",
    async (currentLineId) => {
      const now = Date.parse("2026-08-19T12:00:00Z");
      const subscription: PushSubscriptionRecord = {
        id: `v2-reconcile-${currentLineId}`,
        endpoint: `https://push.example/v2-reconcile-${currentLineId}`,
        p256dh: "public-key",
        auth: "auth-key",
        locale: "fr-CA",
        timezone: "America/Toronto",
        favouriteLines: [
          { agencyId: "metro", lineId: "A" },
          { agencyId: "metro", lineId: "B" },
        ],
        favouriteStations: [],
        favouriteSurfaceRoutes: [],
        commuteSchedules: [
          {
            id: "workday",
            label: "Workday",
            enabled: true,
            days: [3],
            start: "07:30",
            end: "09:30",
          },
        ],
        createdAt: now,
        updatedAt: now,
      };
      const englishAlert: AgencyAlert = {
        id: `english-article-${currentLineId}`,
        incidentIdentity: { namespace: "updates", value: "article-A" },
        kind: "suspension",
        scope: "line",
        affectedLineIds: ["A"],
        title: "Line A suspended",
        severity: "severe",
        lifecycle: "active",
        startsAt: now,
        updatedAt: now,
      };
      const frenchAlert: AgencyAlert = {
        ...englishAlert,
        id: `french-article-${currentLineId}`,
        incidentIdentity: { namespace: "updates", value: "article-B" },
        affectedLineIds: [currentLineId],
        title: `Circuit ${currentLineId} suspendu`,
      };
      const repository = memoryRepository();
      const dependencies = Layer.merge(
        repository,
        createMockVapidClient(async () => ({ success: true, statusCode: 201, expired: false })),
      );
      const layer = Layer.merge(
        dependencies,
        createLiveAlertEvaluatorService().pipe(Layer.provide(dependencies)),
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* SubscriptionRepository;
          const evaluator = yield* AlertEvaluatorService;
          yield* repo.upsertSubscription(subscription);
          yield* repo.recordDelivery({
            id: "old-configured-delivery",
            agencyId: "metro",
            alertId: englishAlert.id,
            incidentKey: incidentKeyForAlert("metro", englishAlert),
            subscriptionId: subscription.id,
            locale: "en-CA",
            status: "active_sent",
            deliveredAt: now - 60_000,
            lineId: "A",
          });

          const summary = yield* evaluator.evaluateAndDispatch(
            { agencyId: "metro", generatedAt: now, freshness: "live", alerts: [frenchAlert] },
            now,
            { locale: "fr-CA" },
          );

          expect(summary.activePushesSent).toBe(1);
          expect((yield* repo.getDelivery("metro", englishAlert.id, subscription.id))?.status).toBe(
            "cleared_silent",
          );
          expect((yield* repo.getDelivery("metro", frenchAlert.id, subscription.id))?.status).toBe(
            "active_sent",
          );
        }).pipe(Effect.provide(layer)),
      );
    },
  );

  it("silently clears a legacy route delivery when no current severe alert affects that route", async () => {
    const now = Date.parse("2026-08-19T12:00:00Z");
    const subscription: PushSubscriptionRecord = {
      id: "route-target-subscription",
      endpoint: "https://push.example/route-target",
      p256dh: "public-key",
      auth: "auth-key",
      locale: "fr-CA",
      timezone: "America/Toronto",
      favouriteLines: [],
      favouriteStations: [],
      favouriteSurfaceRoutes: [
        { agencyId: "metro", routeId: "42" },
        { agencyId: "metro", routeId: "43" },
      ],
      commuteSchedules: [
        { id: "workday", label: "Workday", enabled: true, days: [3], start: "07:30", end: "09:30" },
      ],
      createdAt: now,
      updatedAt: now,
    };
    const englishAlert: AgencyAlert = {
      id: "english-route-42",
      kind: "suspension",
      scope: "route",
      affectedRouteIds: ["42"],
      title: "Route 42 suspended",
      severity: "severe",
      lifecycle: "active",
      startsAt: now,
      updatedAt: now,
    };
    const frenchAlert: AgencyAlert = {
      ...englishAlert,
      id: "french-route-43",
      affectedRouteIds: ["43"],
      title: "Route 43 suspended",
    };
    const repository = memoryRepository();
    const dependencies = Layer.merge(
      repository,
      createMockVapidClient(async () => ({ success: true, statusCode: 201, expired: false })),
    );
    const layer = Layer.merge(
      dependencies,
      createLiveAlertEvaluatorService().pipe(Layer.provide(dependencies)),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* SubscriptionRepository;
        const evaluator = yield* AlertEvaluatorService;
        yield* repo.upsertSubscription(subscription);
        yield* repo.recordDelivery({
          id: "old-route-delivery",
          agencyId: "metro",
          alertId: englishAlert.id,
          incidentKey: incidentKeyForAlert("metro", englishAlert),
          subscriptionId: subscription.id,
          locale: "en-CA",
          status: "active_sent",
          deliveredAt: now - 60_000,
          routeId: "42",
        });

        const summary = yield* evaluator.evaluateAndDispatch(
          { agencyId: "metro", generatedAt: now, freshness: "live", alerts: [frenchAlert] },
          now,
          { locale: "fr-CA" },
        );

        expect(summary.activePushesSent).toBe(1);
        expect((yield* repo.getDelivery("metro", englishAlert.id, subscription.id))?.status).toBe(
          "cleared_silent",
        );
        expect((yield* repo.getDelivery("metro", frenchAlert.id, subscription.id))?.status).toBe(
          "active_sent",
        );
      }).pipe(Effect.provide(layer)),
    );
  });

  it("keeps a targetless legacy row while any severe incident remains, then clears it on empty", async () => {
    const now = Date.parse("2026-08-19T12:00:00Z");
    const subscription: PushSubscriptionRecord = {
      id: "generic-target-subscription",
      endpoint: "https://push.example/generic-target",
      p256dh: "public-key",
      auth: "auth-key",
      locale: "fr-CA",
      timezone: "America/Toronto",
      favouriteLines: [{ agencyId: "metro", lineId: "A" }],
      favouriteStations: [],
      favouriteSurfaceRoutes: [],
      commuteSchedules: [
        { id: "workday", label: "Workday", enabled: true, days: [3], start: "07:30", end: "09:30" },
      ],
      createdAt: now,
      updatedAt: now,
    };
    const englishAlert: AgencyAlert = {
      id: "english-generic-target",
      kind: "suspension",
      scope: "network",
      title: "Central station service suspended",
      severity: "severe",
      lifecycle: "active",
      startsAt: now,
      updatedAt: now,
    };
    const unrelatedAlert: AgencyAlert = {
      ...englishAlert,
      id: "french-line-b",
      scope: "line",
      affectedLineIds: ["B"],
      title: "Line B suspended",
    };
    const repository = memoryRepository();
    const dependencies = Layer.merge(
      repository,
      createMockVapidClient(async () => ({ success: true, statusCode: 201, expired: false })),
    );
    const layer = Layer.merge(
      dependencies,
      createLiveAlertEvaluatorService().pipe(Layer.provide(dependencies)),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* SubscriptionRepository;
        const evaluator = yield* AlertEvaluatorService;
        yield* repo.upsertSubscription(subscription);
        yield* repo.recordDelivery({
          id: "old-generic-delivery",
          agencyId: "metro",
          alertId: englishAlert.id,
          incidentKey: incidentKeyForAlert("metro", englishAlert),
          subscriptionId: subscription.id,
          locale: "en-CA",
          status: "active_sent",
          deliveredAt: now - 60_000,
        });

        yield* evaluator.evaluateAndDispatch(
          { agencyId: "metro", generatedAt: now, freshness: "live", alerts: [unrelatedAlert] },
          now,
          { locale: "fr-CA" },
        );
        expect((yield* repo.getDelivery("metro", englishAlert.id, subscription.id))?.status).toBe(
          "active_sent",
        );

        yield* evaluator.evaluateAndDispatch(
          { agencyId: "metro", generatedAt: now + 60_000, freshness: "live", alerts: [] },
          now + 60_000,
          { locale: "fr-CA" },
        );
        expect((yield* repo.getDelivery("metro", englishAlert.id, subscription.id))?.status).toBe(
          "cleared_silent",
        );
      }).pipe(Effect.provide(layer)),
    );
  });

  it("refreshes locale evidence when an active alert remains under the same upstream ID", async () => {
    const now = Date.parse("2026-08-19T12:00:00Z");
    const subscription: PushSubscriptionRecord = {
      id: "stable-id-subscription",
      endpoint: "https://push.example/stable-id",
      p256dh: "public-key",
      auth: "auth-key",
      locale: "fr-CA",
      timezone: "America/Toronto",
      favouriteLines: [{ agencyId: "metro", lineId: "A" }],
      favouriteStations: [],
      favouriteSurfaceRoutes: [],
      commuteSchedules: [
        { id: "workday", label: "Workday", enabled: true, days: [3], start: "07:30", end: "09:30" },
      ],
      createdAt: now,
      updatedAt: now,
    };
    const englishAlert: AgencyAlert = {
      id: "stable-operator-id",
      kind: "suspension",
      scope: "line",
      affectedLineIds: ["A"],
      title: "Central station suspended",
      severity: "severe",
      lifecycle: "active",
      startsAt: now,
      updatedAt: now,
    };
    const frenchAlert = { ...englishAlert, title: "Service interrompu à la station Centrale" };
    const sent: PushPayload[] = [];
    const repository = memoryRepository();
    const dependencies = Layer.merge(
      repository,
      createMockVapidClient(async (_sub, payload) => {
        sent.push(payload);
        return { success: true, statusCode: 201, expired: false };
      }),
    );
    const layer = Layer.merge(
      dependencies,
      createLiveAlertEvaluatorService().pipe(Layer.provide(dependencies)),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* SubscriptionRepository;
        const evaluator = yield* AlertEvaluatorService;
        yield* repo.upsertSubscription(subscription);
        yield* repo.recordDelivery({
          id: "english-stable-delivery",
          agencyId: "metro",
          alertId: englishAlert.id,
          incidentKey: incidentKeyForAlert("metro", englishAlert),
          subscriptionId: subscription.id,
          locale: "en-CA",
          status: "active_sent",
          deliveredAt: now - 60_000,
          lineId: "A",
        });

        const summary = yield* evaluator.evaluateAndDispatch(
          { agencyId: "metro", generatedAt: now, freshness: "live", alerts: [frenchAlert] },
          now,
          { locale: "fr-CA" },
        );
        const current = yield* repo.getDelivery("metro", englishAlert.id, subscription.id);

        expect(summary.activePushesSent).toBe(1);
        expect(summary.clearedPushesSent).toBe(0);
        expect(current).toMatchObject({
          status: "active_sent",
          locale: "fr-CA",
          incidentKey: incidentKeyForAlert("metro", frenchAlert),
        });

        const nextSummary = yield* evaluator.evaluateAndDispatch(
          {
            agencyId: "metro",
            generatedAt: now + 60_000,
            freshness: "live",
            alerts: [frenchAlert],
          },
          now + 60_000,
          { locale: "fr-CA" },
        );

        expect(nextSummary.activePushesSent).toBe(0);
        expect(sent).toHaveLength(1);
      }).pipe(Effect.provide(layer)),
    );
  });

  it("preserves a rejected line-A alert while active, then reconciles it when only line B remains", async () => {
    const now = Date.parse("2026-08-19T12:00:00Z");
    const subscription: PushSubscriptionRecord = {
      id: "rejected-locale-subscription",
      endpoint: "https://push.example/rejected-locale",
      p256dh: "public-key",
      auth: "auth-key",
      locale: "fr-CA",
      timezone: "America/Toronto",
      favouriteLines: [
        { agencyId: "metro", lineId: "A" },
        { agencyId: "metro", lineId: "B" },
      ],
      favouriteStations: [],
      favouriteSurfaceRoutes: [],
      commuteSchedules: [
        { id: "workday", label: "Workday", enabled: true, days: [3], start: "07:30", end: "09:30" },
      ],
      createdAt: now,
      updatedAt: now,
    };
    const englishAlert: AgencyAlert = {
      id: "source-id-a",
      kind: "suspension",
      scope: "line",
      affectedLineIds: ["A"],
      title: "Central station suspended",
      severity: "severe",
      lifecycle: "active",
      startsAt: now,
      updatedAt: now,
    };
    const frenchAlertA: AgencyAlert = {
      ...englishAlert,
      title: "Service interrompu à la station Centrale",
    };
    const frenchAlertB: AgencyAlert = {
      ...frenchAlertA,
      id: "source-id-b",
      affectedLineIds: ["B"],
      title: "Line B suspended near Central station",
    };
    const attempted: PushPayload[] = [];
    const repository = memoryRepository();
    const dependencies = Layer.merge(
      repository,
      createMockVapidClient(async (_sub, payload) => {
        attempted.push(payload);
        return payload.title.includes("Service interrompu")
          ? { success: false, statusCode: 503, expired: false }
          : { success: true, statusCode: 201, expired: false };
      }),
    );
    const layer = Layer.merge(
      dependencies,
      createLiveAlertEvaluatorService().pipe(Layer.provide(dependencies)),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* SubscriptionRepository;
        const evaluator = yield* AlertEvaluatorService;
        yield* repo.upsertSubscription(subscription);
        yield* repo.recordDelivery({
          id: "accepted-english-delivery",
          agencyId: "metro",
          alertId: englishAlert.id,
          incidentKey: incidentKeyForAlert("metro", englishAlert),
          subscriptionId: subscription.id,
          locale: "en-CA",
          status: "active_sent",
          deliveredAt: now - 60_000,
          lineId: "A",
        });

        const rejectedSummary = yield* evaluator.evaluateAndDispatch(
          { agencyId: "metro", generatedAt: now, freshness: "live", alerts: [frenchAlertA] },
          now,
          { locale: "fr-CA" },
        );
        const afterRejectedPush = yield* repo.getDelivery(
          "metro",
          frenchAlertA.id,
          subscription.id,
        );

        expect(rejectedSummary.activePushesSent).toBe(0);
        expect(afterRejectedPush).toMatchObject({
          status: "active_sent",
          locale: "en-CA",
          incidentKey: incidentKeyForAlert("metro", englishAlert),
        });

        const churnSummary = yield* evaluator.evaluateAndDispatch(
          {
            agencyId: "metro",
            generatedAt: now + 120_000,
            freshness: "live",
            alerts: [frenchAlertB],
          },
          now + 120_000,
          { locale: "fr-CA" },
        );
        const oldDelivery = yield* repo.getDelivery("metro", englishAlert.id, subscription.id);
        const newDelivery = yield* repo.getDelivery("metro", frenchAlertB.id, subscription.id);

        expect(churnSummary).toMatchObject({ activePushesSent: 1, clearedPushesSent: 0 });
        expect(oldDelivery).toMatchObject({ status: "cleared_silent", locale: "en-CA" });
        expect(newDelivery).toMatchObject({
          status: "active_sent",
          locale: "fr-CA",
          incidentKey: incidentKeyForAlert("metro", frenchAlertB),
        });
        expect(attempted).toHaveLength(2);

        const unrelatedSummary = yield* evaluator.evaluateAndDispatch(
          {
            agencyId: "metro",
            generatedAt: now + 180_000,
            freshness: "live",
            alerts: [frenchAlertB],
          },
          now + 180_000,
          { locale: "fr-CA" },
        );
        expect(unrelatedSummary.activePushesSent).toBe(0);
        expect((yield* repo.getDelivery("metro", englishAlert.id, subscription.id))?.status).toBe(
          "cleared_silent",
        );
        expect((yield* repo.getDelivery("metro", frenchAlertB.id, subscription.id))?.status).toBe(
          "active_sent",
        );
        expect(attempted).toHaveLength(2);

        const emptySummary = yield* evaluator.evaluateAndDispatch(
          { agencyId: "metro", generatedAt: now + 240_000, freshness: "live", alerts: [] },
          now + 240_000,
          { locale: "fr-CA" },
        );
        expect(emptySummary.clearedPushesSent).toBe(1);
        expect((yield* repo.getDelivery("metro", frenchAlertB.id, subscription.id))?.status).toBe(
          "cleared_sent",
        );
        expect(attempted).toHaveLength(3);
        expect(attempted[2]?.title).toContain("Service rétabli");
      }).pipe(Effect.provide(layer)),
    );
  });

  it("preserves old-locale evidence through an inactive commute before a new-locale ID-churn push", async () => {
    const inactiveAt = Date.parse("2026-08-19T12:00:00Z");
    const activeAt = Date.parse("2026-08-19T13:00:00Z");
    const subscription: PushSubscriptionRecord = {
      id: "inactive-locale-subscription",
      endpoint: "https://push.example/inactive-locale",
      p256dh: "public-key",
      auth: "auth-key",
      locale: "fr-CA",
      timezone: "America/Toronto",
      favouriteLines: [{ agencyId: "metro", lineId: "A" }],
      favouriteStations: [],
      favouriteSurfaceRoutes: [],
      commuteSchedules: [
        { id: "workday", label: "Workday", enabled: true, days: [3], start: "08:30", end: "09:30" },
      ],
      createdAt: inactiveAt,
      updatedAt: inactiveAt,
    };
    const englishAlert: AgencyAlert = {
      id: "inactive-source-id-a",
      kind: "suspension",
      scope: "line",
      affectedLineIds: ["A"],
      title: "Central station suspended",
      severity: "severe",
      lifecycle: "active",
      startsAt: inactiveAt,
      updatedAt: inactiveAt,
    };
    const frenchAlertA: AgencyAlert = {
      ...englishAlert,
      title: "Service interrompu à la station Centrale",
    };
    const frenchAlertB: AgencyAlert = { ...frenchAlertA, id: "inactive-source-id-b" };
    const sent: PushPayload[] = [];
    const repository = memoryRepository();
    const dependencies = Layer.merge(
      repository,
      createMockVapidClient(async (_sub, payload) => {
        sent.push(payload);
        return { success: true, statusCode: 201, expired: false };
      }),
    );
    const layer = Layer.merge(
      dependencies,
      createLiveAlertEvaluatorService().pipe(Layer.provide(dependencies)),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* SubscriptionRepository;
        const evaluator = yield* AlertEvaluatorService;
        yield* repo.upsertSubscription(subscription);
        yield* repo.recordDelivery({
          id: "accepted-inactive-english-delivery",
          agencyId: "metro",
          alertId: englishAlert.id,
          incidentKey: incidentKeyForAlert("metro", englishAlert),
          subscriptionId: subscription.id,
          locale: "en-CA",
          status: "active_sent",
          deliveredAt: inactiveAt - 60_000,
          lineId: "A",
        });

        const inactiveSummary = yield* evaluator.evaluateAndDispatch(
          { agencyId: "metro", generatedAt: inactiveAt, freshness: "live", alerts: [frenchAlertA] },
          inactiveAt,
          { locale: "fr-CA" },
        );
        const afterInactiveCycle = yield* repo.getDelivery(
          "metro",
          frenchAlertA.id,
          subscription.id,
        );

        expect(inactiveSummary.activePushesSent).toBe(0);
        expect(afterInactiveCycle).toMatchObject({
          status: "active_sent",
          locale: "en-CA",
          incidentKey: incidentKeyForAlert("metro", englishAlert),
        });

        const activeSummary = yield* evaluator.evaluateAndDispatch(
          { agencyId: "metro", generatedAt: activeAt, freshness: "live", alerts: [frenchAlertB] },
          activeAt,
          { locale: "fr-CA" },
        );
        const oldDelivery = yield* repo.getDelivery("metro", englishAlert.id, subscription.id);
        const newDelivery = yield* repo.getDelivery("metro", frenchAlertB.id, subscription.id);

        expect(activeSummary).toMatchObject({ activePushesSent: 1, clearedPushesSent: 0 });
        expect(oldDelivery).toMatchObject({ status: "active_sent", locale: "en-CA" });
        expect(newDelivery).toMatchObject({ status: "active_sent", locale: "fr-CA" });
        expect(sent).toHaveLength(1);
        expect(sent[0]?.title).toContain("Service interrompu à la station Centrale");

        const emptySummary = yield* evaluator.evaluateAndDispatch(
          { agencyId: "metro", generatedAt: activeAt + 60_000, freshness: "live", alerts: [] },
          activeAt + 60_000,
          { locale: "fr-CA" },
        );
        expect(emptySummary.clearedPushesSent).toBe(1);
        expect((yield* repo.getDelivery("metro", englishAlert.id, subscription.id))?.status).toBe(
          "cleared_silent",
        );
        expect((yield* repo.getDelivery("metro", frenchAlertB.id, subscription.id))?.status).toBe(
          "cleared_sent",
        );
      }).pipe(Effect.provide(layer)),
    );
  });
});

describe("notification recovery regressions", () => {
  const now = Date.parse("2026-10-14T12:00:00Z");
  const schedule: CommuteSchedule = {
    id: "all-day",
    label: "All day",
    enabled: true,
    days: [0, 1, 2, 3, 4, 5, 6],
    start: "00:00",
    end: "23:59",
  };
  const makeSubscription = (
    id: string,
    lineId = "A",
    locale: PushSubscriptionRecord["locale"] = "en-CA",
  ): PushSubscriptionRecord => ({
    id,
    endpoint: `https://push.example.test/${id}`,
    p256dh: "fictional-key",
    auth: "fictional-auth",
    locale,
    timezone: "UTC",
    favouriteLines: [{ agencyId: "fictional", lineId }],
    favouriteStations: [],
    favouriteSurfaceRoutes: [],
    commuteSchedules: [schedule],
    createdAt: now,
    updatedAt: now,
  });
  const makeDelivery = (
    subscriptionId: string,
    lineId = "A",
    locale: AlertDeliveryRecord["locale"] = "en-CA",
  ): AlertDeliveryRecord => ({
    id: `delivery-${subscriptionId}`,
    agencyId: "fictional",
    alertId: "ended-alert",
    incidentKey: "ended-incident",
    subscriptionId,
    lineId,
    status: "active_sent",
    deliveredAt: now - 60_000,
    locale,
  });
  const emptyLiveSnapshot: AgencySnapshot = {
    agencyId: "fictional",
    generatedAt: now,
    freshness: "live",
    alerts: [],
  };

  it("logs a recipient storage failure and continues with other recipients", async () => {
    let failLegacyCleanup = false;
    const repository = Layer.effect(
      SubscriptionRepository,
      Effect.gen(function* () {
        const memory = yield* SubscriptionRepository;
        return {
          ...memory,
          recordDelivery: (delivery: AlertDeliveryRecord) => {
            if (
              failLegacyCleanup &&
              delivery.subscriptionId === "storage-failure" &&
              delivery.id === "prior-delivery" &&
              delivery.status === "cleared_silent"
            ) {
              return Effect.fail(
                new SubscriptionStorageError({ message: "Subscription was removed mid-run" }),
              );
            }
            return memory.recordDelivery(delivery);
          },
        };
      }).pipe(Effect.provide(memoryRepository())),
    );
    const sentTo: string[] = [];
    const dependencies = Layer.merge(
      repository,
      createMockVapidClient(async (subscription) => {
        sentTo.push(subscription.id);
        return { success: true, statusCode: 201, expired: false };
      }),
    );
    const layer = Layer.merge(
      dependencies,
      createLiveAlertEvaluatorService().pipe(Layer.provide(dependencies)),
    );
    const alert: AgencyAlert = {
      id: "current-alert",
      kind: "suspension",
      scope: "line",
      affectedLineIds: ["A"],
      title: "Line A suspended",
      severity: "severe",
      lifecycle: "active",
      startsAt: now,
      updatedAt: now,
    };
    const incidentKey = incidentKeyForAlert("fictional", alert);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* SubscriptionRepository;
          const evaluator = yield* AlertEvaluatorService;
          yield* repo.upsertSubscription(makeSubscription("storage-failure", "A", "fr-CA"));
          yield* repo.upsertSubscription(makeSubscription("healthy-recipient"));
          yield* repo.recordDelivery({
            ...makeDelivery("storage-failure", "A", "en-CA"),
            id: "prior-delivery",
            alertId: "prior-alert",
            incidentKey,
          });
          failLegacyCleanup = true;

          const summary = yield* evaluator.evaluateAndDispatch(
            { ...emptyLiveSnapshot, alerts: [alert] },
            now,
          );

          expect(summary.activePushesSent).toBe(2);
          expect(
            (yield* repo.getDelivery("fictional", "current-alert", "healthy-recipient"))?.status,
          ).toBe("active_sent");
          expect(
            (yield* repo.getDelivery("fictional", "prior-alert", "storage-failure"))?.status,
          ).toBe("active_sent");
        }).pipe(Effect.provide(layer)),
      );

      expect(sentTo).toEqual(["storage-failure", "healthy-recipient"]);
      expect(warn).toHaveBeenCalledWith(
        "AlertEvaluator: subscription storage failed",
        expect.objectContaining({ subscriptionId: "storage-failure" }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it.each(["line", "route"] as const)(
    "silently clears recovery history when its %s is no longer a favourite",
    async (target) => {
      const sent: PushPayload[] = [];
      const repository = memoryRepository();
      const dependencies = Layer.merge(
        repository,
        createMockVapidClient(async (_subscription, payload) => {
          sent.push(payload);
          return { success: true, statusCode: 201, expired: false };
        }),
      );
      const layer = Layer.merge(
        dependencies,
        createLiveAlertEvaluatorService().pipe(Layer.provide(dependencies)),
      );
      const subscriptionId = `removed-${target}`;
      const subscription =
        target === "line"
          ? makeSubscription(subscriptionId, "B")
          : {
              ...makeSubscription(subscriptionId),
              favouriteLines: [],
              favouriteSurfaceRoutes: [{ agencyId: "fictional", routeId: "43" }],
            };
      const delivery =
        target === "line"
          ? makeDelivery(subscriptionId, "A")
          : { ...makeDelivery(subscriptionId), lineId: undefined, routeId: "42" };

      await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* SubscriptionRepository;
          const evaluator = yield* AlertEvaluatorService;
          yield* repo.upsertSubscription(subscription);
          yield* repo.recordDelivery(delivery);

          const summary = yield* evaluator.evaluateAndDispatch(emptyLiveSnapshot, now);

          expect(summary.clearedPushesSent).toBe(0);
          expect(sent).toHaveLength(0);
          expect(
            (yield* repo.getDelivery("fictional", "ended-alert", subscriptionId))?.status,
          ).toBe("cleared_silent");
        }).pipe(Effect.provide(layer)),
      );
    },
  );

  it("keeps recovery for legacy line-tagged station matches while station favourites remain", async () => {
    const sent: PushPayload[] = [];
    const dependencies = Layer.merge(
      memoryRepository(),
      createMockVapidClient(async (_subscription, payload) => {
        sent.push(payload);
        return { success: true, statusCode: 201, expired: false };
      }),
    );
    const layer = Layer.merge(
      dependencies,
      createLiveAlertEvaluatorService().pipe(Layer.provide(dependencies)),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* SubscriptionRepository;
        const evaluator = yield* AlertEvaluatorService;
        const subscription = {
          ...makeSubscription("station-recipient"),
          favouriteLines: [],
          favouriteStations: [{ agencyId: "fictional", stationName: "Hub" }],
        };
        yield* repo.upsertSubscription(subscription);
        yield* repo.recordDelivery(makeDelivery(subscription.id, "A"));
        const summary = yield* evaluator.evaluateAndDispatch(emptyLiveSnapshot, now);
        expect(summary.clearedPushesSent).toBe(1);
        expect(sent).toHaveLength(1);
        expect((yield* repo.getDelivery("fictional", "ended-alert", subscription.id))?.status).toBe(
          "cleared_sent",
        );
      }).pipe(Effect.provide(layer)),
    );
  });

  it("URL-encodes a recovery line target", async () => {
    const lineId = "A & B/7?";
    const sent: PushPayload[] = [];
    const repository = memoryRepository();
    const dependencies = Layer.merge(
      repository,
      createMockVapidClient(async (_subscription, payload) => {
        sent.push(payload);
        return { success: true, statusCode: 201, expired: false };
      }),
    );
    const layer = Layer.merge(
      dependencies,
      createLiveAlertEvaluatorService().pipe(Layer.provide(dependencies)),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* SubscriptionRepository;
        const evaluator = yield* AlertEvaluatorService;
        yield* repo.upsertSubscription(makeSubscription("encoded-line", lineId));
        yield* repo.recordDelivery(makeDelivery("encoded-line", lineId));

        const summary = yield* evaluator.evaluateAndDispatch(emptyLiveSnapshot, now);

        expect(summary.clearedPushesSent).toBe(1);
        expect(sent[0]?.data?.url).toBe(`/?line=${encodeURIComponent(lineId)}`);
      }).pipe(Effect.provide(layer)),
    );
  });

  it.each(["stale", "unavailable"] as const)(
    "preserves same-locale recovery history for a %s snapshot",
    async (freshness) => {
      const sent: PushPayload[] = [];
      const diagnostics: Array<{ stage: string; reason?: string }> = [];
      const repository = memoryRepository();
      const dependencies = Layer.merge(
        repository,
        createMockVapidClient(async (_subscription, payload) => {
          sent.push(payload);
          return { success: true, statusCode: 201, expired: false };
        }),
      );
      const layer = Layer.merge(
        dependencies,
        createLiveAlertEvaluatorService({ onDiagnostic: (event) => diagnostics.push(event) }).pipe(
          Layer.provide(dependencies),
        ),
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* SubscriptionRepository;
          const evaluator = yield* AlertEvaluatorService;
          yield* repo.upsertSubscription(makeSubscription("same-locale"));
          yield* repo.recordDelivery(makeDelivery("same-locale"));

          yield* evaluator.evaluateAndDispatch(
            { ...emptyLiveSnapshot, freshness, alerts: [] },
            now,
          );

          expect((yield* repo.getDelivery("fictional", "ended-alert", "same-locale"))?.status).toBe(
            "active_sent",
          );
        }).pipe(Effect.provide(layer)),
      );

      expect(sent).toHaveLength(0);
      expect(diagnostics).toContainEqual(
        expect.objectContaining({ stage: "skip", reason: "snapshot-not-live" }),
      );
    },
  );
});

describe("recipient work selection", () => {
  it("batches history only for active favourites and outstanding recovery targets", async () => {
    const now = Date.parse("2026-10-14T12:00:00Z");
    const activeSchedule: CommuteSchedule = {
      id: "active",
      label: "Active",
      enabled: true,
      days: [0, 1, 2, 3, 4, 5, 6],
      start: "00:00",
      end: "23:59",
    };
    const sleepingSchedule: CommuteSchedule = {
      ...activeSchedule,
      id: "sleeping",
      start: "00:00",
      end: "01:00",
    };
    const recipient = (
      id: string,
      favouriteAgency: string | undefined,
      commuteSchedules: readonly CommuteSchedule[],
    ): PushSubscriptionRecord => ({
      id,
      endpoint: `https://push.example.test/${id}`,
      auth: "fictional-auth",
      p256dh: "fictional-key",
      favouriteLines:
        favouriteAgency === undefined ? [] : [{ agencyId: favouriteAgency, lineId: "A" }],
      favouriteStations: [],
      favouriteSurfaceRoutes: [],
      commuteSchedules: [...commuteSchedules],
      timezone: "UTC",
      createdAt: now,
      updatedAt: now,
    });
    const recipients: PushSubscriptionRecord[] = [
      recipient("active-favourite", "fictional", [activeSchedule]),
      recipient("sleeping-favourite", "fictional", [sleepingSchedule]),
      recipient("unrelated-recipient", "another-agency", [activeSchedule]),
      recipient("removed-favourite", undefined, []),
    ];
    const recorded = vi.fn();
    const batchRead = vi.fn();
    const legacyRead = vi.fn();
    const repository = await Effect.runPromise(
      Effect.gen(function* () {
        const memory = yield* SubscriptionRepository;
        for (const recipient of recipients) yield* memory.upsertSubscription(recipient);
        yield* memory.recordDelivery({
          id: "outstanding-delivery",
          agencyId: "fictional",
          alertId: "ended-incident",
          incidentKey: "ended-key",
          subscriptionId: "removed-favourite",
          status: "active_sent",
          deliveredAt: now - 60_000,
        });
        return {
          ...memory,
          getDeliveriesForSubscriptions: (agencyId: string, subscriptionIds: readonly string[]) => {
            batchRead(agencyId, subscriptionIds);
            return memory.getDeliveriesForSubscriptions(agencyId, subscriptionIds);
          },
          getDeliveriesForSubscription: (agencyId: string, subscriptionId: string) => {
            legacyRead(agencyId, subscriptionId);
            return memory.getDeliveriesForSubscription(agencyId, subscriptionId);
          },
          recordDelivery: (delivery: AlertDeliveryRecord) => {
            recorded(delivery);
            return memory.recordDelivery(delivery);
          },
        };
      }).pipe(Effect.provide(memoryRepository())),
    );
    const deps = Layer.merge(
      Layer.succeed(SubscriptionRepository, repository),
      createMockVapidClient(async () => ({ success: true, statusCode: 201, expired: false })),
    );
    const evaluatorLayer = createLiveAlertEvaluatorService().pipe(Layer.provide(deps));
    const snapshot: AgencySnapshot = {
      agencyId: "fictional",
      generatedAt: now,
      freshness: "live",
      alerts: [],
    };

    const summary = await Effect.runPromise(
      Effect.gen(function* () {
        const evaluator = yield* AlertEvaluatorService;
        return yield* evaluator.evaluateAndDispatch(snapshot, now, {
          subscriptions: recipients,
          repository,
        });
      }).pipe(Effect.provide(evaluatorLayer)),
    );

    expect(batchRead).toHaveBeenCalledTimes(1);
    expect(batchRead).toHaveBeenCalledWith("fictional", ["active-favourite", "removed-favourite"]);
    expect(legacyRead).not.toHaveBeenCalled();
    expect(recorded).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: "removed-favourite",
        status: "cleared_silent",
      }),
    );
    expect(summary.subscriptionsChecked).toBe(2);
  });
});
