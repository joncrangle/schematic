import { describe, expect, it } from "vitest";
import { decodeZenbusAlerts } from "~/infrastructure/realtime/zenbus/zenbusAlerts";
import { decodeLinkedServiceNotices } from "~/infrastructure/realtime/linkedServiceNotices";
import wall from "../fixtures/zenbus/messages.contract.json";
import news from "../fixtures/municipal-news/contract.json";

const bytesOf = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (s) => parseInt(s, 16));
const codeMap = (map: Readonly<Record<string, string | undefined>> | undefined) =>
  Object.fromEntries(
    Object.entries(map ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
describe("Zenbus message contract", () => {
  it.each(wall.cases.filter((row) => !row.error))("$name", (row) => {
    expect(
      JSON.parse(
        JSON.stringify(
          decodeZenbusAlerts(bytesOf(row.hex), wall.now, {
            timeZone: "America/Toronto",
            stopCodeMap: codeMap(row.stopCodeMap),
          }).alerts,
        ),
      ),
    ).toEqual(row.alerts);
  });
  it.each(wall.cases.filter((row) => row.error))("$name", (row) => {
    expect(() =>
      decodeZenbusAlerts(bytesOf(row.hex), wall.now, {
        timeZone: "America/Toronto",
        stopCodeMap: codeMap(row.stopCodeMap),
      }),
    ).toThrow();
  });
});
describe("Municipal news contract", () => {
  it.each(news.cases.filter((row) => !row.error))("$name", (row) => {
    const page = decodeLinkedServiceNotices(row.html, row.source, news.now, news.timeZone);
    expect(page?.pageUrls).toEqual(row.pageUrls);
    expect(page?.feed.alerts).toEqual(row.alerts);
  });
  it.each(news.cases.filter((row) => row.error))("$name", (row) => {
    expect(() =>
      decodeLinkedServiceNotices(row.html, row.source, news.now, news.timeZone),
    ).toThrow();
  });
});

it.each(["cloudflare", "self-hosted"] as const)(
  "preserves normalized relay periods and stop scope on %s",
  async (hostingTarget) => {
    const { Effect } = await import("effect");
    const { fetchAgencyAlerts } = await import("~/infrastructure/realtime/fetchAgencyAlerts");
    const now = wall.now;
    const alert = {
      id: "active",
      title: "Stop closure",
      startsAt: now - 1000,
      endsAt: now + 1000,
      updatedAt: now,
      effect: 1,
      stopScoped: true as const,
      routeIds: ["A"],
      targets: [{ routeId: "A", stopId: "closed" }],
    };
    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: `relay-${hostingTarget}`,
        sources: [
          {
            type: "json",
            parser: "normalized-alert-feed",
            url: `https://example.test/${hostingTarget}/normalized`,
          },
        ],
        fetch: async () =>
          Response.json({
            header: { version: "municipal-news", timestamp: now },
            tripUpdates: [],
            vehiclePositions: [],
            alerts: [
              alert,
              {
                ...alert,
                id: "expired",
                title: "Expired closure",
                startsAt: now - 10000,
                endsAt: now - 1000,
              },
            ],
          }),
        now: () => now,
        timeZone: "America/Toronto",
        hostingTarget,
      }),
    );
    expect(snapshot.freshness).toBe("live");
    expect(snapshot.alerts).toEqual([
      expect.objectContaining({
        id: "active",
        startsAt: now - 1000,
        endsAt: now + 1000,
        scope: "station",
        lifecycle: "active",
      }),
      expect.objectContaining({
        id: "expired",
        startsAt: now - 10000,
        endsAt: now - 1000,
        lifecycle: "expired",
      }),
    ]);
  },
);

it.each([
  { name: "incomplete document", partial: true, warning: false, freshness: "stale" },
  { name: "stale relay", partial: false, warning: true, freshness: "stale" },
  { name: "complete relay", partial: false, warning: false, freshness: "live" },
])("keeps normalized relay completeness honest: $name", async ({ partial, warning, freshness }) => {
  const { Effect } = await import("effect");
  const { fetchAgencyAlerts } = await import("~/infrastructure/realtime/fetchAgencyAlerts");
  const snapshot = await Effect.runPromise(
    fetchAgencyAlerts({
      agencyId: "normalized-completeness",
      sources: [
        { type: "json", parser: "normalized-alert-feed", url: "https://example.test/completeness" },
      ],
      fetch: async () =>
        Response.json(
          {
            header: { version: "municipal-news", timestamp: wall.now },
            tripUpdates: [],
            vehiclePositions: [],
            alerts: [],
            partial,
          },
          { headers: warning ? { Warning: '110 - "stale"' } : {} },
        ),
      now: () => wall.now,
      timeZone: "UTC",
      hostingTarget: "cloudflare",
    }),
  );
  expect(snapshot.freshness).toBe(freshness);
});
