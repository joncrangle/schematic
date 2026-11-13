vi.mock("~/agencies/agencyCatalog", async () => {
  const { testAgencyCatalog } = await import("../helpers/agency-fixtures");
  return { agencyCatalog: testAgencyCatalog };
});
import { describe, expect, it, vi } from "vitest";
import {
  formatCountdown,
  formatClockCountdown,
  calculateSecondsRemaining,
  formatDistance,
  agencyBadgeStyle,
  routeBadgeStyle,
} from "~/components/nearby/nearbyHelpers";
import { contrastTextColorForLine } from "~/domain/lineColors";

import { fr } from "~/i18n/fr";
import {
  englishMessageFormatter,
  pluralFromDictionary,
  translateFromDictionary,
  type MessageFormatter,
} from "~/i18n/translate";

it("formats grace timer digits in the selected numbering system", () => {
  expect(formatClockCountdown(125)).toBe("2:05");
  const formatter = {
    formatNumber: (value: number, options?: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat("ar-EG", options).format(value),
  };
  expect(formatClockCountdown(125, formatter)).toBe("٢:٠٥");
});

describe("Nearby Transit UI Helpers (Seam 1: Countdowns & Route Badges)", () => {
  const now = 1700000000000; // Fixed epoch ms

  it("formats countdown as 'Due' when less than or equal to 60 seconds", () => {
    const arrivalTime = now + 45 * 1000; // 45s in future
    const remaining = calculateSecondsRemaining(arrivalTime, now);
    expect(remaining).toBe(45);
    expect(formatCountdown(arrivalTime, now)).toBe("Due");
  });

  it("formats countdown in minutes when greater than 60 seconds", () => {
    const arrivalTime = now + 180 * 1000; // 3 min
    expect(formatCountdown(arrivalTime, now)).toBe("3 min");

    const arrivalTime2 = now + 650 * 1000; // ~11 min
    expect(formatCountdown(arrivalTime2, now)).toBe("11 min");
  });

  it("clamps expired countdowns to 'Due' and never displays negative numbers", () => {
    const pastArrivalTime = now - 30 * 1000; // 30s in past
    const remaining = calculateSecondsRemaining(pastArrivalTime, now);
    expect(remaining).toBe(0);
    expect(formatCountdown(pastArrivalTime, now)).toBe("Due");
  });

  it("formats distance in meters under 1000m and kilometers at/above 1000m", () => {
    expect(formatDistance(110)).toBe("110m away");
    expect(formatDistance(45)).toBe("45m away");
    expect(formatDistance(850)).toBe("850m away");
    expect(formatDistance(1200)).toBe("1.2 km away");
    expect(formatDistance(123456)).toBe("123.5 km away");
  });

  it("localizes countdown and distance formatting through the shared formatter", () => {
    const formatter: MessageFormatter = {
      t: (key, ...[params]) => translateFromDictionary(key, fr, params),
      formatNumber: (value, options) => new Intl.NumberFormat("fr-CA", options).format(value),
      plural: (key, count, ...[params]) => pluralFromDictionary(key, count, fr, "fr-CA", params),
    };

    expect(formatCountdown(now + 180_000, now, formatter)).toBe("3 min");
    expect(formatDistance(1200, formatter)).toBe("À 1,2 km");
  });

  it.each([
    ["sample", { "background-color": "#123456", color: "#fedcba", "border-color": "#123456" }],
    ["regional", { "background-color": "#ffffff", color: "#000000", "border-color": "#ffffff" }],
    ["unknown", { "background-color": "#4b5563", color: "#ffffff", "border-color": "#4b5563" }],
  ])("uses declared branding or fallback for %s", (agencyId, style) => {
    expect(agencyBadgeStyle(agencyId)).toEqual(style);
  });
  it.each([
    [{ routeColor: "#005596" }, { "background-color": "#005596", color: "#ffffff" }],
    [{ routeColor: "#FFC20E" }, { "background-color": "#FFC20E", color: "#000000" }],
    [{ agencyId: "sample" }, { "background-color": "#123456", color: "#fedcba" }],
    [{ agencyId: "regional" }, { "background-color": "#ffffff", color: "#000000" }],
    [
      { agencyId: "sample", routeColor: "#000000", routeTextColor: "#abcdef" },
      { "background-color": "#000000", color: "#abcdef" },
    ],
    [{ routeType: "streetcar" }, { "background-color": "#64748B", color: "#ffffff" }],
  ])("resolves explicit route colors before branding and mode defaults: %o", (params, style) => {
    expect(routeBadgeStyle(params)).toEqual(style);
  });

  it("isNumericLineId correctly identifies short numeric line numbers and rejects named/overflow lines", async () => {
    const { isNumericLineId } = await import("~/components/nearby/LineBadgeCircle");
    expect(isNumericLineId("1")).toBe(true);
    expect(isNumericLineId("2")).toBe(true);
    expect(isNumericLineId("4")).toBe(true);
    expect(isNumericLineId("5")).toBe(true);
    expect(isNumericLineId("504")).toBe(false);
    expect(isNumericLineId("blue")).toBe(false);
    expect(isNumericLineId("purple")).toBe(false);
    expect(isNumericLineId("orange")).toBe(false);
    expect(isNumericLineId("yellow")).toBe(false);
    expect(isNumericLineId("")).toBe(false);
  });

  it("lineChipStyle derives contrasting background and text colors", async () => {
    const { lineChipStyle } = await import("~/components/nearby/LineBadgeCircle");
    expect(lineChipStyle("#FFC20E")).toEqual({
      "background-color": "#FFC20E",
      color: "#000000",
    });
    expect(lineChipStyle("#005596")).toEqual({
      "background-color": "#005596",
      color: "#ffffff",
    });
    expect(lineChipStyle(undefined)).toEqual({
      "background-color": undefined,
      color: undefined,
    });
  });
});

describe("contrastTextColorForLine", () => {
  it.each([
    ["#ffcb05", "#000000"], // Very light yellow (L ≈ 0.78)
    ["#f58220", "#000000"], // Light orange (L ≈ 0.58)
    ["#939598", "#000000"], // Medium gray (L ≈ 0.58)
    ["#ffffff", "#000000"], // Pure white (L = 1)
    ["#00a651", "#ffffff"], // Dark green (L ≈ 0.49)
    ["#b30075", "#ffffff"], // Dark magenta (L ≈ 0.18)
    ["#c32d38", "#ffffff"], // Dark red (L ≈ 0.29)
    ["#000000", "#ffffff"], // pure black extreme (L = 0)
  ])("%s background renders %s label text", (background, expected) => {
    expect(contrastTextColorForLine(background)).toBe(expected);
  });
});

it.each([
  [110, "360 ft away"],
  [10, "30 ft away"],
  [100, "330 ft away"],
  [160, "520 ft away"],
  [160.9344, "0.1 mi away"],
  [1200, "0.7 mi away"],
  [1609.344, "1.0 mi away"],
])("formats %s metres in imperial units", (meters, expected) => {
  expect(formatDistance(meters, { ...englishMessageFormatter, unitSystem: () => "imperial" })).toBe(
    expected,
  );
});
