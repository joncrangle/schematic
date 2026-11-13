import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeRouteStatusTable } from "~/infrastructure/realtime/routeStatusTableParser";

interface Case {
  readonly name: string;
  readonly html: string;
  readonly routeNames?: Readonly<Record<string, readonly string[]>>;
  readonly partial?: boolean;
  readonly notices?: readonly {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly routeIds: readonly string[];
  }[];
  readonly error?: boolean;
}

const contract = JSON.parse(
  readFileSync(new URL("../fixtures/route-status-table/contract.json", import.meta.url), "utf8"),
) as { readonly cases: readonly Case[] };

describe("route status table", () => {
  it.each(contract.cases.filter((entry) => !entry.error))("$name", (entry) => {
    const feed = decodeRouteStatusTable(
      entry.html,
      "https://example.test/status",
      1_234,
      entry.routeNames,
    );

    expect({ partial: feed.partial ?? false, alerts: feed.alerts }).toEqual({
      partial: entry.partial ?? false,
      alerts: entry.notices!.map((notice) => ({ ...notice, startsAt: 0, updatedAt: 1_234 })),
    });
  });

  it.each(contract.cases.filter((entry) => entry.error))("$name", (entry) => {
    expect(() =>
      decodeRouteStatusTable(entry.html, "https://example.test/status", 1_234, entry.routeNames),
    ).toThrow();
  });
});
