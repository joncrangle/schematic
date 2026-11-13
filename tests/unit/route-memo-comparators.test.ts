import { describe, expect, it } from "vitest";
import { areAgencyAlertsEqual, isAgencyAlertContentEqual } from "~/lib/routeMemoComparators";
import { makeAlert } from "../helpers/fixtures";

describe("isAgencyAlertContentEqual", () => {
  it("treats an updatedAt-only re-poll as equal", () => {
    const base = makeAlert({ id: "a1", updatedAt: 100 });
    const restamped = { ...base, updatedAt: 200 };
    expect(isAgencyAlertContentEqual(base, restamped)).toBe(true);
  });

  it("breaks equality when the id changes", () => {
    const base = makeAlert({ id: "a1" });
    expect(isAgencyAlertContentEqual(base, { ...base, id: "a2" })).toBe(false);
  });

  it.each([
    ["title", "Different title"],
    ["description", "Different description"],
    ["kind", "suspension"],
    ["severity", "severe"],
    ["lifecycle", "expired"],
    ["scope", "line"],
    ["serviceChange", "detour"],
    ["startsAt", 999_999],
    ["endsAt", 888_888],
  ] as const)("breaks equality when %s changes", (field, value) => {
    const base = makeAlert({ id: "a1" });
    const changed = { ...base, [field]: value } as typeof base;
    expect(isAgencyAlertContentEqual(base, changed)).toBe(false);
  });

  it("compares line and route attribution elementwise", () => {
    const base = makeAlert({ id: "a1", affectedLineIds: ["1"], affectedRouteIds: ["52"] });
    expect(isAgencyAlertContentEqual(base, { ...base, affectedLineIds: ["2"] })).toBe(false);
    expect(isAgencyAlertContentEqual(base, { ...base, affectedRouteIds: ["97"] })).toBe(false);
    expect(isAgencyAlertContentEqual(base, { ...base })).toBe(true);
  });

  it("compares station references, targets, and outages", () => {
    const base = makeAlert({
      id: "a1",
      affectedStations: [{ stationId: "union", stationName: "Union" }],
      fromStation: { stationId: "union", stationName: "Union" },
      toStation: { stationId: "king", stationName: "King" },
      targets: [{ routeId: "1", station: { stationId: "union", stationName: "Union" } }],
    });
    expect(isAgencyAlertContentEqual(base, structuredClone(base))).toBe(true);
    expect(
      isAgencyAlertContentEqual(base, {
        ...base,
        fromStation: { stationId: "queen", stationName: "Queen" },
      }),
    ).toBe(false);
  });
});

describe("areAgencyAlertsEqual", () => {
  it("treats fresh-but-content-identical payloads as equal despite new stamps", () => {
    const prev = [makeAlert({ id: "a1", updatedAt: 100 }), makeAlert({ id: "a2", updatedAt: 100 })];
    const next = prev.map((alert) => ({ ...alert, updatedAt: 200 }));
    expect(areAgencyAlertsEqual(prev, next)).toBe(true);
  });

  it("breaks equality when any member's content changes", () => {
    const prev = [makeAlert({ id: "a1" }), makeAlert({ id: "a2" })];
    const next = [{ ...prev[0]!, title: "Changed" }, prev[1]!];
    expect(areAgencyAlertsEqual(prev, next)).toBe(false);
  });

  it("breaks equality when membership changes", () => {
    const prev = [makeAlert({ id: "a1" })];
    expect(areAgencyAlertsEqual(prev, [...prev, makeAlert({ id: "a2" })])).toBe(false);
    expect(areAgencyAlertsEqual(prev, [])).toBe(false);
  });
});
