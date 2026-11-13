import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgencyAlert } from "~/agencies/types";
import { incidentKeyForAlert } from "~/services/notifications/AlertEvaluatorService";
import { replayNotificationEvaluation } from "~/services/notifications/NotificationDiagnostics";

const now = Date.parse("2026-08-19T12:00:00Z");
const alert: AgencyAlert = {
  id: "closure",
  kind: "suspension",
  scope: "line",
  title: "Line 2 suspended",
  affectedLineIds: ["2"],
  severity: "severe",
  lifecycle: "active",
  startsAt: now,
  updatedAt: now,
};
const subscription = {
  timezone: "America/Toronto",
  commuteSchedules: [
    { id: "morning", label: "Morning", enabled: true, days: [3], start: "07:30", end: "09:30" },
  ],
  favouriteLines: [{ agencyId: "ttc", lineId: "2" }],
  favouriteStations: [],
  favouriteSurfaceRoutes: [],
  endpoint: "https://private.example/device",
  auth: "private-auth",
  p256dh: "private-key",
};

afterEach(() => vi.unstubAllGlobals());

describe("offline notification replay", () => {
  it.each([
    { label: "commute window closed", reason: "commute-inactive", time: now + 4 * 60 * 60 * 1000 },
    { label: "alert is not severe", reason: "not-severe", alert: { ...alert, severity: "normal" } },
    { label: "alert is expired", reason: "not-active", alert: { ...alert, lifecycle: "expired" } },
    {
      label: "favorite belongs to another agency",
      reason: "favourites-unmatched",
      subscription: { ...subscription, favouriteLines: [{ agencyId: "go", lineId: "2" }] },
    },
    {
      label: "incident already accepted",
      reason: "incident-already-sent",
      deliveries: [
        {
          agencyId: "ttc",
          alertId: "older-id",
          incidentKey: incidentKeyForAlert("ttc", alert),
          status: "active_sent",
          deliveredAt: now - 1000,
        },
      ],
    },
    { label: "eligible incident", reason: undefined },
  ])("reports $label without network or private subscription fields", async (variant) => {
    const network = vi.fn(() => {
      throw new Error("Network must not run during replay");
    });
    vi.stubGlobal("fetch", network);
    const report = await replayNotificationEvaluation({
      now: variant.time ?? now,
      snapshot: {
        agencyId: "ttc",
        generatedAt: now,
        freshness: "live",
        alerts: [variant.alert ?? alert],
      },
      subscription: variant.subscription ?? subscription,
      deliveries: variant.deliveries ?? [],
    });
    expect(report.transport).toBe("mock");
    expect(report.summary.activePushesSent).toBe(variant.reason ? 0 : 1);
    expect(
      report.events.filter((event) => event.stage === "skip").map((event) => event.reason),
    ).toEqual(variant.reason ? [variant.reason] : []);
    expect(network).not.toHaveBeenCalled();
    const output = JSON.stringify(report);
    for (const secret of [subscription.endpoint, subscription.auth, subscription.p256dh])
      expect(output).not.toContain(secret);
  });

  it("replays recovery from captured delivery facts", async () => {
    const report = await replayNotificationEvaluation({
      now,
      subscription,
      snapshot: { agencyId: "ttc", generatedAt: now, freshness: "live", alerts: [] },
      deliveries: [
        {
          agencyId: "ttc",
          alertId: alert.id,
          incidentKey: incidentKeyForAlert("ttc", alert),
          status: "active_sent",
          deliveredAt: now - 1000,
          lineId: "2",
        },
      ],
    });
    expect(report.events).toContainEqual(
      expect.objectContaining({ stage: "push", phase: "recovery", outcome: "accepted" }),
    );
    expect(report.summary.clearedPushesSent).toBe(1);
  });

  it.each(["invalid timezone", "unbounded snapshot", "nonfinite time", "invalid preferences"])(
    "rejects %s without exposing input",
    async (kind) => {
      const input = {
        now: kind === "nonfinite time" ? Infinity : now,
        snapshot: {
          agencyId: "ttc",
          generatedAt: now,
          freshness: "live",
          alerts:
            kind === "unbounded snapshot"
              ? Array.from({ length: 1001 }, (_, index) => ({ ...alert, id: String(index) }))
              : [alert],
        },
        subscription: {
          ...subscription,
          timezone: kind === "invalid timezone" ? "private-auth" : subscription.timezone,
          favouriteLines:
            kind === "invalid preferences" ? "private-auth" : subscription.favouriteLines,
        },
      };
      await expect(replayNotificationEvaluation(input)).rejects.toThrow(/^Invalid replay input:/);
    },
  );
});
