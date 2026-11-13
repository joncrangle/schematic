import { interpretSnapshot } from "../../src/domain/interpretSnapshot";
import { makeTestProvider } from "../helpers/agency-fixtures";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { decodeHeadingServiceNotices } from "../../src/infrastructure/realtime/headingServiceNoticesParser";
import { reconcilePublishedRestorations } from "../../src/domain/alerts/publishedRestorations";
import type { AgencyAlert } from "../../src/agencies/types";

type Case = {
  now?: number;
  timeZone?: string;
  publicationReference?: { publicationYear: number; validFrom: string; validThrough: string };
  clearStatementNames?: string[];
  name: string;
  html: string;
  notices?: {
    title: string;
    description: string;
    startsAt?: number;
    periodStartsAt?: number;
    id?: string;
    effect?: string;
    tripScoped?: boolean;
    stopScoped?: boolean;
    updatedAt?: number;
    endsAt?: number;
    routeIds?: string[];
    affectedStations?: string[];
    targets?: { stopId?: string; routeId?: string; directionText?: string }[];
  }[];
  stopNames?: Record<string, string[]>;
  routeNames?: Record<string, string[]>;
  error?: boolean;
};
const contract: { cases: Case[] } = JSON.parse(
  readFileSync(
    new URL("../fixtures/heading-service-notices/contract.json", import.meta.url),
    "utf8",
  ),
);

describe("heading service notices", () => {
  it.each(contract.cases.filter((entry) => !entry.error))("$name", (entry) => {
    expect(
      decodeHeadingServiceNotices(
        entry.html,
        "https://example.test/board",
        entry.now ?? 1234,
        entry.routeNames,
        entry.stopNames,
        entry.timeZone,
        entry.publicationReference,
        entry.clearStatementNames,
      ).alerts,
    ).toEqual(
      entry.notices!.map(({ periodStartsAt, ...notice }) => ({
        ...notice,
        id:
          notice.id ??
          `https://example.test/board#${notice.updatedAt ?? notice.startsAt ?? ""}${notice.updatedAt === undefined && notice.startsAt === undefined ? "" : "-"}${notice.title}`,
        startsAt: periodStartsAt ?? notice.startsAt ?? 0,
        updatedAt: notice.updatedAt ?? entry.now ?? 1234,
        routeIds: notice.routeIds ?? [],
      })),
    );
  });
  it.each(contract.cases.filter((entry) => entry.error))("$name", (entry) => {
    expect(() =>
      decodeHeadingServiceNotices(
        entry.html,
        "https://example.test/board",
        entry.now ?? 1234,
        entry.routeNames,
        entry.stopNames,
        entry.timeZone,
        entry.publicationReference,
        entry.clearStatementNames,
      ),
    ).toThrow();
  });
  it("keeps two named station advisories as independent points", () => {
    const feed = decodeHeadingServiceNotices(
      "<main><p>October 14, 2026</p><h4>East and West station hours</h4><p>Ticket offices close at six.</p></main>",
      "https://example.test/board",
      1791993600000,
      {},
      { East: ["East"], West: ["West"] },
    );
    const snapshot = interpretSnapshot(feed, {
      agencyId: "sample",
      now: 1791993600000,
    });
    expect(snapshot.alerts[0]).toMatchObject({
      scope: "station",
      affectedStations: [{ stationName: "East" }, { stationName: "West" }],
      targets: [{ station: { stationName: "East" } }, { station: { stationName: "West" } }],
    });
    expect(snapshot.alerts[0].fromStation).toBeUndefined();
    expect(snapshot.alerts[0].toStation).toBeUndefined();
  });
});

it("does not revive an expired article when it is polled in a later year", () => {
  const article = contract.cases.find((entry) => entry.timeZone)!;
  const now = Date.parse("2030-01-01T12:00:00Z");
  const feed = decodeHeadingServiceNotices(
    article.html,
    "https://example.test/board",
    now,
    {},
    {},
    article.timeZone,
  );
  const snapshot = interpretSnapshot(feed, { agencyId: "sample", now });
  expect(snapshot.alerts.filter((alert) => alert.lifecycle === "active")).toEqual([]);
});

it("retires component outages from their published date range", () => {
  const now = Date.parse("2026-11-07T12:00:00Z");
  const feed = decodeHeadingServiceNotices(
    '<div class="maincontentparct"><div class="alert-body"><h2><span class="title-text">October 19 - November 6, 2026: East Station elevator temporarily closed</span></h2><p>Use the replacement shuttle.</p></div></div>',
    "https://example.test/board",
    now,
  );
  const snapshot = interpretSnapshot(feed, {
    agencyId: "sample",
    now,
    interpretation: { titleDateTimezone: "America/Edmonton" },
  });
  expect(snapshot.alerts[0].lifecycle).toBe("expired");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Edmonton",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(snapshot.alerts[0].endsAt);
  expect(parts.filter((part) => part.type !== "literal").map((part) => part.value)).toEqual([
    "2026",
    "11",
    "07",
    "00",
  ]);
});

it("keeps an undated archive closure stop-scoped and marks the source stale on later reads", () => {
  const html =
    '<main><div class="service-update"><h4>October 19 3:51pm</h4><p>Route 1: East Stop is closed today until further notice.</p></div><div class="service-update"><h4>October 17 10:00am</h4><p>Route 1: no closures.</p></div></main>';
  const read = (now: number) =>
    decodeHeadingServiceNotices(
      html,
      "https://example.test/board",
      now,
      { "1": ["Route 1"] },
      { east: ["East Stop"] },
    );
  expect(() => read(Date.parse("2027-10-20T12:00:00Z"))).toThrow();
});

it("decodes a year-verified update archive completely with dated bounded scope", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  const html = `<main>
    <div class="service-update"><h4>October 21 11:33am</h4><p>Sample Update: Due to unforeseen circumstances, we will be cancelling the following 8X bus routes: 4:30pm and 5:37pm.</p></div>
    <div class="service-update"><h4>October 19 3:51pm</h4><p>Route 1: East Stop is closed until further notice.</p></div>
    <div class="service-update"><h4>October 14 9:00am</h4><p>Route 7 will be temporarily suspended today, October 14, from 4:51 p.m. until October 16.</p></div>
    <div class="service-update"><h4>October 16 8:00am</h4><p>Routes 1, 2 and 8X have moved back to North High School.</p></div>
  </main>`;
  const feed = decodeHeadingServiceNotices(
    html,
    "https://example.test/board",
    now,
    { "1": ["Route 1"], "2": ["Route 2"], "7": ["Route 7"], "8X": ["Route 8X", "8X"] },
    { hot: ["East Stop"] },
    "America/Edmonton",
    { publicationYear: 2026, validFrom: "2026-09-30", validThrough: "2026-11-30" },
  );
  expect(feed.partial).toBeUndefined();
  expect(feed.alerts).toHaveLength(4);
  const snapshot = interpretSnapshot(feed, {
    agencyId: "sample",
    now,
    manifest: makeTestProvider({
      alertInterpretation: {
        lineIds: ["1", "2", "7", "8X"],
        rules: [
          {
            match: { textIncludes: ["cancelling the following", "temporarily suspended today"] },
            result: { kind: "delay", severity: "degraded" },
          },
        ],
      },
    }).manifest,
  });
  expect(snapshot.freshness).toBe("live");
  expect(snapshot.alerts.find((alert) => alert.title.startsWith("October 21"))).toMatchObject({
    kind: "delay",
    severity: "degraded",
    affectedRouteIds: ["8X"],
  });
  expect(snapshot.alerts.find((alert) => alert.title.startsWith("October 14"))).toMatchObject({
    kind: "delay",
    severity: "degraded",
    affectedRouteIds: ["7"],
  });
  expect(feed.alerts.find((alert) => alert.title.startsWith("October 19"))).toMatchObject({
    routeIds: ["1"],
    affectedStations: ["hot"],
    targets: [{ stopId: "hot", routeId: "1" }],
  });
  expect(feed.alerts.find((alert) => alert.title.startsWith("October 14"))).toMatchObject({
    startsAt: Date.parse("2026-10-14T22:51:00Z"),
  });
  expect(feed.alerts.find((alert) => alert.title.startsWith("October 14"))?.endsAt).toBeDefined();
  expect(feed.alerts.find((alert) => alert.title.startsWith("October 21"))?.endsAt).toBeDefined();
});

it("retires only the older matching route hub relocation when a later restoration appears", () => {
  const day = (value: string) => Date.parse(`${value}T12:00:00Z`);
  const alert = (
    value: Partial<AgencyAlert> & Pick<AgencyAlert, "id" | "title" | "description" | "updatedAt">,
  ): AgencyAlert => ({
    kind: "suspension",
    severity: "severe",
    lifecycle: "active",
    scope: "route",
    startsAt: value.updatedAt,
    ...value,
  });
  const relocation = alert({
    id: "old-hub",
    title: "Route 8X temporary stop",
    description:
      "Route 8X will move to a temporary stop near North Highschool Transit Hub while construction is underway.",
    updatedAt: day("2026-10-15"),
    affectedRouteIds: ["8X"],
    kind: "information",
    severity: "normal",
  });
  const restoration = alert({
    id: "hub-restored",
    title: "Routes 1, 2 and 8X moved back to the North High School Transit Hub",
    description: "Regular service returned to North High School Transit Hub.",
    updatedAt: day("2026-10-16"),
    affectedRouteIds: ["1", "2", "8X"],
    kind: "information",
    severity: "normal",
  });
  const boundedRelocation = alert({
    id: "bounded-hub",
    title: "Routes 1 and 2 temporarily stopping at the North High School Field",
    description:
      "Routes 1 and 2 are stopping at the field instead of the North High School Transit Hub until October 16.",
    updatedAt: day("2026-10-13"),
    endsAt: day("2026-10-17"),
    affectedRouteIds: ["1", "2"],
    kind: "information",
    severity: "normal",
  });
  const newerDelay = alert({
    id: "new-delay",
    title: "Route 8X delay",
    description: "Route 8X is experiencing traffic delays.",
    updatedAt: day("2026-10-20"),
    affectedRouteIds: ["8X"],
    kind: "delay",
    severity: "degraded",
  });
  const newerClosure = alert({
    id: "new-closure",
    title: "Route 1 closure",
    description: "Route 1 is closed at Downtown due to a road incident.",
    updatedAt: day("2026-10-18"),
    affectedRouteIds: ["1"],
  });
  const stopClosure = alert({
    id: "hot-springs",
    title: "East Stop closure",
    description: "East Stop is closed until further notice.",
    updatedAt: day("2026-10-19"),
    scope: "station",
    affectedStations: [{ stationName: "East Stop" }],
  });
  const result = reconcilePublishedRestorations(
    [relocation, restoration, boundedRelocation, newerDelay, newerClosure, stopClosure],
    day("2026-10-27"),
  );
  expect(result[0]).toMatchObject({ endsAt: restoration.updatedAt, lifecycle: "expired" });
  expect(result[2].endsAt).toBe(boundedRelocation.endsAt);
  expect(result[3].endsAt).toBeUndefined();
  expect(result[4].endsAt).toBeUndefined();
  expect(result[5].endsAt).toBeUndefined();
});

it("refuses an update archive after its date reference expires", () => {
  expect(() =>
    decodeHeadingServiceNotices(
      '<main><div class="service-update"><h4>October 19 3:51pm</h4><p>East Stop is closed until further notice.</p></div></main>',
      "https://example.test/board",
      Date.parse("2026-12-01T12:00:00Z"),
      {},
      {},
      "America/Edmonton",
      { publicationYear: 2026, validFrom: "2026-09-30", validThrough: "2026-11-30" },
    ),
  ).toThrow();
});
