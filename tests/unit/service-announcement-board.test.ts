import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeServiceAnnouncementBoard } from "~/infrastructure/realtime/serviceAnnouncementBoardParser";

interface Case {
  readonly name: string;
  readonly html: string;
  readonly routeNames?: Readonly<Record<string, readonly string[]>>;
  readonly notices?: readonly {
    readonly title: string;
    readonly description?: string;
    readonly routeIds?: readonly string[];
  }[];
  readonly error?: boolean;
}

const contract = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/service-announcement-board/contract.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { readonly cases: readonly Case[] };

describe("service announcement board", () => {
  it.each(contract.cases.filter((entry) => !entry.error))("$name", (entry) => {
    const feed = decodeServiceAnnouncementBoard(
      entry.html,
      "https://example.test/announcements",
      1_234,
      entry.routeNames,
    );

    expect(
      feed.alerts.map((alert) => ({
        id: alert.id,
        title: alert.title,
        description: alert.description,
        routeIds: alert.routeIds,
        startsAt: alert.startsAt,
        updatedAt: alert.updatedAt,
        effect: alert.effect,
      })),
    ).toEqual(
      entry.notices!.map((notice) => ({
        id: `https://example.test/announcements#${[notice.title, notice.description].filter(Boolean).join(" ")}`,
        title: notice.title,
        description: notice.description,
        routeIds: notice.routeIds ?? [],
        startsAt: 0,
        updatedAt: 1_234,
        effect: undefined,
      })),
    );
  });

  it.each(contract.cases.filter((entry) => entry.error))("$name", (entry) => {
    expect(() =>
      decodeServiceAnnouncementBoard(
        entry.html,
        "https://example.test/announcements",
        1_234,
        entry.routeNames,
      ),
    ).toThrow();
  });
});
