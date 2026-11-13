import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { makeTestProvider } from "../helpers/agency-fixtures";
import { AgencyTaskRunner } from "~/services/AgencyTaskRunner";
import { normalizeRouteId, normalizeRouteIdList } from "~/domain/routeId";
import { interpretSnapshot } from "~/domain/interpretSnapshot";
import { matchAlertsForRoute } from "~/domain/surface/surfaceAlerts";
import { doesAlertMatchSubscription } from "~/services/notifications/AlertEvaluatorService";
import type { PushSubscriptionRecord } from "~/domain/notifications/types";
import type { AgencySnapshot, RouteIdNormalization } from "~/agencies/types";
import type { EvaluationSummary } from "~/services/notifications/AlertEvaluatorService";
import type { DecodedFeed, GenericAlert } from "~/infrastructure/realtime/gtfsRealtimeDecoder";

const NOW = 1_800_000_000_000;
const routeIdNormalization = {
  stripPrefix: "line",
  extractPattern: "\\b([12456])\\b",
};

function feed(alerts: readonly GenericAlert[]): DecodedFeed {
  return {
    header: { version: "2.0", timestamp: NOW },
    tripUpdates: [],
    vehiclePositions: [],
    alerts,
  };
}

describe("manifest route ID and alert-title policies", () => {
  it("keeps route IDs unchanged by default and normalizes them with the declared rule", () => {
    expect(normalizeRouteId("  LINE 1  ")).toBe("LINE 1");
    expect(normalizeRouteId("LINEAR")).toBe("LINEAR");
    expect(normalizeRouteId("LINE 1", routeIdNormalization)).toBe("1");
    expect(normalizeRouteId("LINE1", routeIdNormalization)).toBe("1");
    expect(normalizeRouteId("LINEAR", routeIdNormalization)).toBe("LINEAR");
    expect(normalizeRouteIdList(["LINE 1", "1", "LINEAR"], routeIdNormalization)).toEqual([
      "1",
      "LINEAR",
    ]);
  });

  it("applies the same declared route rule to interpreted alerts and route queries", () => {
    const alerts: GenericAlert[] = [
      {
        id: "prefixed-copy",
        title: "Line 1: Track work",
        description: "Track work between two stations",
        routeIds: ["LINE 1"],
        startsAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "unprefixed-copy",
        title: "Track work",
        description: "Track work between two stations",
        routeIds: ["LINE 1"],
        startsAt: NOW,
        updatedAt: NOW,
      },
    ];
    const neutral = interpretSnapshot(feed(alerts), { agencyId: "sample", now: NOW });
    const manifest = makeTestProvider({
      id: "sample",
      alertInterpretation: {
        lineIds: ["1"],
        routeIdNormalization,
        stripLinePrefixFromTitle: true,
      },
    }).manifest;
    const configured = interpretSnapshot(feed(alerts), {
      agencyId: "sample",
      now: NOW,
      manifest,
    });

    expect(neutral.alerts).toHaveLength(2);
    expect(neutral.alerts[0]?.affectedRouteIds).toEqual(["LINE 1"]);
    expect(configured.alerts).toHaveLength(1);
    expect(configured.alerts[0]?.affectedRouteIds).toEqual(["1"]);
    expect(matchAlertsForRoute("LINE 1", configured.alerts, routeIdNormalization)).toHaveLength(1);
    expect(matchAlertsForRoute("LINE 1", configured.alerts)).toHaveLength(0);

    const subscription: PushSubscriptionRecord = {
      id: "subscription",
      endpoint: "https://push.example.test/subscription",
      p256dh: "public-key",
      auth: "auth-secret",
      favouriteLines: [],
      favouriteStations: [],
      favouriteSurfaceRoutes: [{ agencyId: "sample", routeId: "LINE 1" }],
      commuteSchedules: [],
      timezone: "America/Toronto",
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(
      doesAlertMatchSubscription(
        configured.alerts[0]!,
        subscription,
        "sample",
        routeIdNormalization,
      ).matches,
    ).toBe(true);
  });

  it("strips a line title prefix only when the manifest opts in", () => {
    const alerts: GenericAlert[] = [
      {
        id: "prefixed",
        title: "Line 7: Elevator maintenance",
        description: "Elevator maintenance",
        startsAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "plain",
        title: "Elevator maintenance",
        description: "Elevator maintenance",
        startsAt: NOW,
        updatedAt: NOW,
      },
    ];
    const plain = interpretSnapshot(feed(alerts), { agencyId: "sample", now: NOW });
    const configured = interpretSnapshot(feed(alerts), {
      agencyId: "sample",
      now: NOW,
      manifest: makeTestProvider({
        id: "sample",
        alertInterpretation: { stripLinePrefixFromTitle: true },
      }).manifest,
    });

    expect(plain.alerts).toHaveLength(2);
    expect(configured.alerts).toHaveLength(1);
  });

  it("passes the provider's route policy into notification evaluation", async () => {
    const provider = makeTestProvider({
      id: "sample",
      alertInterpretation: { routeIdNormalization },
    });
    let observed: RouteIdNormalization | undefined;
    const summary: EvaluationSummary = {
      activeAlertsEvaluated: 0,
      subscriptionsChecked: 0,
      activePushesSent: 0,
      clearedPushesSent: 0,
      expiredSubscriptionsPruned: 0,
      rejectedSubscriptionsPruned: 0,
    };
    const evaluator = {
      getRequiredLocales: () => Effect.succeed(["en-CA"] as const),
      evaluateAndDispatch: (
        _snapshot: AgencySnapshot,
        _now?: number,
        options?: { readonly routeIdNormalization?: RouteIdNormalization },
      ) => {
        observed = options?.routeIdNormalization;
        return Effect.succeed(summary);
      },
    };
    const runner = new AgencyTaskRunner({
      providers: () => [provider],
      vapidConfig: () => ({
        publicKey: "public",
        privateKey: "private",
        subject: "mailto:test@example.test",
      }),
      buildStack: () => Effect.succeed({ evaluator }),
    });

    await runner.evaluateSnapshot(provider, {
      agencyId: "sample",
      sourceUpdatedAt: NOW,
      generatedAt: NOW,
      freshness: "live",
      alerts: [],
    });

    expect(observed).toEqual(routeIdNormalization);
  });
});
