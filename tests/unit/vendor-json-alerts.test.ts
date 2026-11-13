import { interpretSnapshot } from "~/domain/interpretSnapshot";
import { Effect, Schema } from "effect";
import { AlertSourceSchema, JsonAlertParserSchema } from "~/agencies/types";
import { describe, expect, it } from "vitest";
import { normalizeVendorJsonAlerts } from "~/infrastructure/realtime/vendorJsonAlerts";
import { decodeGenericJsonAlertFeed } from "~/infrastructure/realtime/genericJsonAlertDecoder";
import contract from "../fixtures/vendor-json/contract.json";

describe("vendor JSON advisory contracts", () => {
  it.each(contract.valid)("normalizes $name", ({ parser, payload, expected }) => {
    expect(
      normalizeVendorJsonAlerts(payload, Schema.decodeUnknownSync(JsonAlertParserSchema)(parser)),
    ).toEqual(expected);
  });
  it.each(contract.invalid)("rejects $name", ({ parser, payload }) => {
    expect(() =>
      normalizeVendorJsonAlerts(payload, Schema.decodeUnknownSync(JsonAlertParserSchema)(parser)),
    ).toThrow();
  });
  it("keeps rendered closures at stops and cancellations at trips through interpretation", async () => {
    const payload = contract.valid
      .filter((entry) => entry.parser === "rendered-advisory-board")
      .flatMap<unknown>((entry) => entry.expected.alerts);
    const feed = await Effect.runPromise(
      decodeGenericJsonAlertFeed(payload, Date.parse("2026-10-24T00:00:00Z")),
    );
    const snapshot = interpretSnapshot(feed, {
      agencyId: "sample",
      now: Date.parse("2026-10-24T00:00:00Z"),
    });
    expect(snapshot.alerts.filter((alert) => alert.scope === "station")).toHaveLength(1);
    expect(snapshot.alerts.find((alert) => alert.scope === "trip")).toMatchObject({
      severity: "degraded",
    });
    expect(
      snapshot.alerts.filter((alert) => alert.severity === "severe" && alert.scope === "route"),
    ).toHaveLength(0);
  });
  it("rejects a JSON request body without POST", () => {
    expect(() =>
      Schema.decodeUnknownSync(AlertSourceSchema)({
        type: "json",
        parser: "generic-alert-feed",
        url: "https://sample.test/alerts",
        body: {},
      }),
    ).toThrow();
  });
  it("keeps distinct zero-ID route detours and restricts a stop notice to its stop", async () => {
    const { alerts } = normalizeVendorJsonAlerts(
      [
        { id: 0, message: "Detour", routeNum: 41, stopNum: 0, isForDetour: true, type: "Alert" },
        { id: 0, message: "Detour", routeNum: 42, stopNum: 0, isForDetour: true, type: "Alert" },
        {
          id: 0,
          message: "Stop closed",
          routeNum: 41,
          stopNum: 81,
          isForDetour: true,
          type: "Alert",
        },
      ],
      "mapstrat-broadcast",
    );
    const feed = await Effect.runPromise(decodeGenericJsonAlertFeed(alerts, 1_800_000_000_000));
    expect(new Set(feed.alerts.map((a) => a.id)).size).toBe(3);
    expect(feed.alerts.map((a) => a.routeIds)).toEqual([["41"], ["42"], ["41"]]);
    expect(feed.alerts[2].targets).toEqual([{ stopId: "81" }]);
  });
  it("interprets displayed clock deadlines in the agency timezone", async () => {
    const { alerts } = normalizeVendorJsonAlerts(
      {
        totalCount: 1,
        value: [
          {
            document: {
              Title: "Trunk A",
              RouteTitle: "Trunk A",
              Detour: "Race",
              RoutesAffected: "/race.pdf",
              Approx_x002e_StartDate: "Sunday, October 18, 2026, Start of Service",
              Approx_x002e_EndDate: "Sunday, October 18, 2026, 11:00 AM",
            },
          },
        ],
      },
      "eum-search-advisories",
    );
    const feed = await Effect.runPromise(
      decodeGenericJsonAlertFeed(alerts, 1_800_000_000_000, {
        timestampMode: "agency-local-wall-clock",
        timeZone: "America/Toronto",
      }),
    );
    expect(feed.alerts[0].startsAt).toBe(Date.parse("2026-10-18T04:00:00Z"));
    expect(feed.alerts[0].endsAt).toBe(Date.parse("2026-10-18T15:00:00Z"));
  });
});
