import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeRouteNoticeIndex } from "~/infrastructure/realtime/routeNoticeIndexParser";

interface Case {
  readonly name: string;
  readonly html: string;
  readonly routeNames?: Readonly<Record<string, readonly string[]>>;
  readonly partial?: boolean;
  readonly notices?: readonly {
    readonly url: string;
    readonly title: string;
    readonly description: string;
    readonly routeIds: readonly string[];
  }[];
  readonly error?: boolean;
}

const contract = JSON.parse(
  readFileSync(new URL("../fixtures/route-notice-index/contract.json", import.meta.url), "utf8"),
) as { readonly cases: readonly Case[] };

describe("route notice index", () => {
  it.each(contract.cases.filter((entry) => !entry.error))("$name", (entry) => {
    const feed = decodeRouteNoticeIndex(
      entry.html,
      "https://example.test/notices",
      1_234,
      entry.routeNames,
    );

    expect({
      partial: feed.partial ?? false,
      alerts: feed.alerts.map((alert) => ({
        id: alert.id,
        title: alert.title,
        description: alert.description,
        routeIds: alert.routeIds,
        startsAt: alert.startsAt,
        updatedAt: alert.updatedAt,
        effect: alert.effect,
      })),
    }).toEqual({
      partial: entry.partial ?? false,
      alerts: entry.notices!.map((notice) => ({
        id: notice.url,
        title: notice.title,
        description: notice.description,
        routeIds: notice.routeIds,
        startsAt: 0,
        updatedAt: 1_234,
        effect: undefined,
      })),
    });
  });

  it.each(contract.cases.filter((entry) => entry.error))("$name", (entry) => {
    expect(() =>
      decodeRouteNoticeIndex(entry.html, "https://example.test/notices", 1_234, entry.routeNames),
    ).toThrow();
  });
});
