import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeDisruptionDetailsTable } from "~/infrastructure/realtime/disruptionDetailsTableParser";

type Case = {
  name: string;
  html: string;
  routeNames?: Record<string, string[]>;
  error?: boolean;
  notices?: { title: string; startsAt: number; routeIds: string[]; stationIds: string[] }[];
};
const contract: { cases: Case[] } = JSON.parse(
  readFileSync(
    new URL("../fixtures/disruption-details-table/contract.json", import.meta.url),
    "utf8",
  ),
);
describe("disruption details table", () => {
  it.each(contract.cases.filter((entry) => !entry.error))("$name", (entry) => {
    const feed = decodeDisruptionDetailsTable(
      entry.html,
      "https://example.test/status",
      1234,
      "America/Edmonton",
      entry.routeNames,
    );
    expect(feed.alerts).toEqual(
      entry.notices!.map((notice) => ({
        title: notice.title,
        startsAt: notice.startsAt,
        routeIds: notice.routeIds,
        ...(notice.stationIds.length
          ? {
              affectedStations: notice.stationIds,
              targets: notice.stationIds.map((stopId) => ({ stopId })),
            }
          : {}),
        id: `https://example.test/status#${notice.title}`,
        updatedAt: 1234,
      })),
    );
  });
  it.each(contract.cases.filter((entry) => entry.error))("$name", (entry) => {
    expect(() =>
      decodeDisruptionDetailsTable(
        entry.html,
        "https://example.test/status",
        1234,
        "America/Edmonton",
        entry.routeNames,
      ),
    ).toThrow();
  });
});
