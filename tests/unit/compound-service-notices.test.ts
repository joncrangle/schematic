import { expect, it } from "vitest";
import { interpretSnapshot } from "~/domain/interpretSnapshot";
import type { GenericAlert } from "~/infrastructure/realtime/gtfsRealtimeDecoder";

const bulletin: GenericAlert = {
  id: "bulletin",
  title: "January transit update",
  startsAt: Date.parse("2027-01-01T06:00:00Z"),
  updatedAt: Date.parse("2027-01-01T06:00:00Z"),
  effect: "DETOUR",
  description:
    "There will be no transit on January 11 - Public holiday\nThe parade takes place January 28. Transit will be rerouted until 1 p.m.",
};
it.each([
  ["2027-01-09T15:00:00Z", "upcoming", "normal"],
  ["2027-01-11T15:00:00Z", "active", "severe"],
  ["2027-01-12T15:00:00Z", "expired", "severe"],
])(
  "keeps the dated cancellation separate from the other event at %s",
  (now, lifecycle, severity) => {
    const snapshot = interpretSnapshot(
      {
        header: { version: "test", timestamp: Date.parse(now) },
        tripUpdates: [],
        vehiclePositions: [],
        alerts: [bulletin],
      },
      {
        agencyId: "sample",
        now: Date.parse(now),
        interpretation: {
          titleDateTimezone: "America/Regina",
          rules: [
            {
              match: { textIncludes: ["no transit"] },
              result: { kind: "suspension", severity: "severe" },
            },
          ],
        },
      },
    );
    expect(snapshot.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "bulletin#cancellation-2027-01-11",
          lifecycle,
          severity,
          startsAt: Date.parse("2027-01-11T06:00:00Z"),
          endsAt: Date.parse("2027-01-12T06:00:00Z"),
        }),
        expect.objectContaining({
          id: "bulletin",
          description: "The parade takes place January 28. Transit will be rerouted until 1 p.m.",
          serviceChange: "detour",
        }),
      ]),
    );
    expect(snapshot.alerts).toHaveLength(2);
  },
);

it("preserves the last cancelled day of a range in a compound bulletin", () => {
  const now = Date.parse("2027-01-12T15:00:00Z");
  const snapshot = interpretSnapshot(
    {
      header: { version: "test", timestamp: now },
      tripUpdates: [],
      vehiclePositions: [],
      alerts: [
        {
          ...bulletin,
          description:
            "There will be no transit on January 11 - January 12\nA separate parade is planned later in the month.",
        },
      ],
    },
    {
      agencyId: "sample",
      now,
      interpretation: {
        titleDateTimezone: "America/Regina",
        rules: [
          {
            match: { textIncludes: ["no transit"] },
            result: { kind: "suspension", severity: "severe" },
          },
        ],
      },
    },
  );
  expect(snapshot.alerts).toContainEqual(
    expect.objectContaining({
      id: "bulletin#cancellation-2027-01-11",
      lifecycle: "active",
      endsAt: Date.parse("2027-01-13T06:00:00Z"),
    }),
  );
});

it("uses the service date at the start of a cancellation title rather than its posting date", () => {
  const now = Date.parse("2027-01-09T15:00:00Z");
  const snapshot = interpretSnapshot(
    {
      header: { version: "test", timestamp: now },
      tripUpdates: [],
      vehiclePositions: [],
      alerts: [
        {
          ...bulletin,
          title: "Monday January 11, there will be no transit service due to a holiday.",
          description: undefined,
          effect: undefined,
          endsAt: Date.parse("2027-01-12T06:00:00Z"),
        },
      ],
    },
    {
      agencyId: "sample",
      now,
      interpretation: {
        titleDateTimezone: "America/Regina",
        rules: [
          {
            match: { textIncludes: ["no transit"] },
            result: { kind: "suspension", severity: "severe" },
          },
        ],
      },
    },
  );
  expect(snapshot.alerts).toContainEqual(
    expect.objectContaining({
      lifecycle: "upcoming",
      startsAt: Date.parse("2027-01-11T06:00:00Z"),
      endsAt: Date.parse("2027-01-12T06:00:00Z"),
    }),
  );
});

it("does not infer a cancellation date from an unrelated no-prefix notice", async () => {
  const { publishedImpactPeriod } = await import("~/domain/alerts/publishedImpactPeriod");
  expect(
    publishedImpactPeriod(
      { ...bulletin, title: "Monday January 11, there will be no shelter at this stop." },
      "America/Regina",
    ),
  ).toBeUndefined();
});

it.each([
  "The following routes will operate on Remembrance Day – Wednesday November 11.",
  "Vous prévoyez de prendre l’autobus le 11 novembre? Les circuits suivants seront en service.",
  "Are you looking to use the bus on Nov. 11? The following routes will be operating on Remembrance Day.",
])("dates holiday service using its published year: %s", async (description) => {
  const { publishedImpactPeriod } = await import("~/domain/alerts/publishedImpactPeriod");
  expect(
    publishedImpactPeriod(
      {
        ...bulletin,
        title: description.startsWith("Vous") ? "Service de transport le jour du Souvenir" : "Remembrance Day Service",
        description,
        startsAt: Date.parse("2026-11-02T12:00:00Z"),
        updatedAt: Date.parse("2027-11-01T12:00:00Z"),
      },
      "America/Regina",
    ),
  ).toEqual({
    startsAt: Date.parse("2026-11-11T06:00:00Z"),
    endsAt: Date.parse("2026-11-12T06:00:00Z"),
  });
});
