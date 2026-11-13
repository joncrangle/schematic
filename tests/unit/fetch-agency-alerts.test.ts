import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { fetchAgencyAlerts, AlertFetchError } from "~/infrastructure/realtime/fetchAgencyAlerts";
import { isAlertSourceActive } from "~/infrastructure/realtime/alertSourceActivity";
import { createFakeConditionalCache } from "../helpers/fake-conditional-cache";
import { logger } from "~/infrastructure/logging/logger";
import {
  resetHostingTargetProbeForTesting,
  setMiniflareProbeForTesting,
} from "~/infrastructure/env/hostingTarget";
import type { AlertSource } from "~/agencies/types";
import type { AlertFeedAdapter } from "~/infrastructure/realtime/alertFeedAdapters";
import type { DecodedFeed } from "~/infrastructure/realtime/gtfsRealtimeDecoder";
import { encodeFeed, encodeAlertEntity } from "../helpers/gtfs-rt-binary";

const { adapterStubs } = vi.hoisted(() => ({
  adapterStubs: new Map<AlertSource["type"], AlertFeedAdapter>(),
}));

// Delegating mock: per-test stubs override, everything else runs the real
// adapters — one canonical home for the fetchAgencyAlerts seam.
vi.mock("~/infrastructure/realtime/alertFeedAdapters", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("~/infrastructure/realtime/alertFeedAdapters")>();
  const dispatch =
    (type: AlertSource["type"]): AlertFeedAdapter =>
    (source, ctx) =>
      (adapterStubs.get(type) ?? original.alertFeedAdapters[type])(source, ctx);
  return {
    ...original,
    alertFeedAdapters: {
      "gtfs-rt": dispatch("gtfs-rt"),
      json: dispatch("json"),
      rss: dispatch("rss"),
      web: dispatch("web"),
    },
  };
});

const NOW = 1_800_000_000_000;
const UNKNOWN_GHD_HTML = readFileSync(
  join(import.meta.dirname, "../fixtures/ghd-news/challenge-interstitial.html"),
  "utf8",
);

beforeEach(() => {
  adapterStubs.clear();
});

describe("fetchAgencyAlerts (Core alert-source seam)", () => {
  it.each(["cloudflare", "self-hosted"] as const)(
    "keeps a successfully read empty TransLoc announcements board live on %s",
    async (hostingTarget) => {
      const snapshot = await Effect.runPromise(
        fetchAgencyAlerts({
          agencyId: "sample",
          sources: [
            {
              type: "json",
              parser: "transloc-messages",
              url: `https://sample.test/${hostingTarget}/announcements`,
            },
          ],
          fetch: vi.fn(async () => Response.json([])),
          now: () => NOW,
          timeZone: "America/Whitehorse",
          hostingTarget,
        }),
      );
      expect(snapshot).toMatchObject({ freshness: "live", alerts: [] });
    },
  );

  it("keeps verified yearless web archives live on a complete read and stale after reference expiry", async () => {
    const html =
      '<main><div class="service-update"><h4>October 19 3:51pm</h4><p>Upper Hot Springs is closed until further notice.</p></div></main>';
    const source: AlertSource = {
      type: "web",
      url: "https://example.test/updates",
      parser: "heading-service-notices",
      publicationReference: {
        publicationYear: 2026,
        validFrom: "2026-09-30",
        validThrough: "2026-11-30",
      },
      stopNames: { hot: ["Upper Hot Springs"] },
    };
    const read = (now: number, page = html) =>
      Effect.runPromise(
        fetchAgencyAlerts({
          agencyId: "sample",
          sources: [source, { type: "gtfs-rt", url: "https://example.test/alerts.pb" }],
          fetch: vi.fn(async (input) =>
            String(input).endsWith("alerts.pb")
              ? new Response(new Uint8Array(encodeFeed(now / 1000, [])))
              : new Response(page, { headers: { "content-type": "text/html" } }),
          ),
          now: () => now,
          timeZone: "America/Edmonton",
          hostingTarget: "self-hosted",
        }),
      );
    const live = await read(Date.parse("2026-10-27T12:00:00Z"));
    const expiredReference = await read(Date.parse("2026-12-01T12:00:00Z"));
    const malformed = await read(
      Date.parse("2026-10-27T12:00:00Z"),
      '<main><div class="service-update"><p>Upper Hot Springs is closed.</p></div></main>',
    );
    const failed = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "sample",
        sources: [source, { type: "gtfs-rt", url: "https://example.test/alerts.pb" }],
        fetch: vi.fn(async (input) => {
          if (String(input).endsWith("alerts.pb"))
            return new Response(
              new Uint8Array(encodeFeed(Date.parse("2026-10-27T12:00:00Z") / 1000, [])),
            );
          throw new Error("required update page unavailable");
        }),
        now: () => Date.parse("2026-10-27T12:00:00Z"),
        timeZone: "America/Edmonton",
        hostingTarget: "self-hosted",
      }),
    );
    expect(live.freshness).toBe("live");
    expect(live.alerts).toMatchObject([
      { scope: "station", affectedStations: [{ stationName: "hot" }] },
    ]);
    expect(expiredReference.freshness).toBe("stale");
    expect(malformed.freshness).toBe("stale");
    expect(failed.freshness).toBe("stale");
  });

  it.each([
    { mode: "failed", mixed: false, freshness: "stale" },
    { mode: "unmatched", mixed: false, freshness: "live" },
    { mode: "failed", mixed: true, freshness: "stale" },
    { mode: "unmatched", mixed: true, freshness: "live" },
  ])(
    "drops shared-feed trips the index lacks, stale only when the lookup failed: $mode, mixed=$mixed",
    async ({ mode, mixed, freshness }) => {
      const bytes = encodeFeed(NOW / 1000, [
        encodeAlertEntity({
          id: "unknown-trip",
          selectors: [...(mixed ? [{ routeId: "A" }] : []), { tripId: "new-trip" }],
          effect: 1,
        }),
      ]);
      const snapshot = await Effect.runPromise(
        fetchAgencyAlerts({
          agencyId: "sample",
          sources: [{ type: "gtfs-rt", url: "https://sample.test/shared" }],
          sourceAgencyIds: ["operator-a"],
          getSourceAgencyScope: () =>
            Effect.succeed({ routeIds: new Set(["A"]), stopIds: new Set<string>() }),
          getRoutesForTrips: () =>
            mode === "failed"
              ? Effect.fail(new Error("Static asset unavailable"))
              : Effect.succeed(new Map()),
          fetch: vi.fn(async () => new Response(new Uint8Array(bytes))),
          now: () => NOW,
          timeZone: "UTC",
          hostingTarget: "self-hosted",
        }),
      );
      expect(snapshot.freshness).toBe(freshness);
      expect(snapshot.alerts.map((alert) => alert.id)).toEqual(mixed ? ["unknown-trip"] : []);
      expect(snapshot.alerts[0]?.affectedRouteIds).toEqual(mixed ? ["A"] : undefined);
    },
  );

  it("keeps a shared feed live when its unattributed selectors belong to another operator, across 304 revalidation", async () => {
    const fake = createFakeConditionalCache();
    const bytes = encodeFeed(NOW / 1000, [
      encodeAlertEntity({ id: "ours", selectors: [{ routeId: "A" }], effect: 1 }),
      encodeAlertEntity({ id: "foreign-route", selectors: [{ routeId: "Z" }], effect: 1 }),
      encodeAlertEntity({ id: "foreign-stop", selectors: [{ stopId: "Q" }], effect: 1 }),
      encodeAlertEntity({ id: "foreign-trip", selectors: [{ tripId: "Q-trip" }], effect: 1 }),
    ]);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(new Uint8Array(bytes), { headers: { ETag: '"same"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const read = () =>
      Effect.runPromise(
        fetchAgencyAlerts({
          agencyId: "sample",
          sources: [{ type: "gtfs-rt", url: "https://sample.test/shared" }],
          sourceAgencyIds: ["operator-a"],
          getSourceAgencyScope: () =>
            Effect.succeed({ routeIds: new Set(["A"]), stopIds: new Set(["S"]) }),
          fetch,
          now: () => NOW,
          timeZone: "UTC",
          hostingTarget: "cloudflare",
          conditionalCache: fake.cache,
        }),
      );
    const snapshots = [await read(), await read()];
    expect(snapshots.map((snapshot) => snapshot.freshness)).toEqual(["live", "live"]);
    expect(snapshots.map((snapshot) => snapshot.alerts.map((alert) => alert.id))).toEqual([
      ["ours"],
      ["ours"],
    ]);
  });

  it("keeps a shared feed stale across 304 revalidation after a failed trip lookup dropped a trip", async () => {
    const fake = createFakeConditionalCache();
    const bytes = encodeFeed(NOW / 1000, [
      encodeAlertEntity({ id: "unknown-trip", selectors: [{ tripId: "new-trip" }], effect: 1 }),
    ]);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(new Uint8Array(bytes), { headers: { ETag: '"same"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const read = () =>
      Effect.runPromise(
        fetchAgencyAlerts({
          agencyId: "sample",
          sources: [{ type: "gtfs-rt", url: "https://sample.test/shared" }],
          sourceAgencyIds: ["operator-a"],
          getSourceAgencyScope: () =>
            Effect.succeed({ routeIds: new Set(["A"]), stopIds: new Set<string>() }),
          getRoutesForTrips: () => Effect.fail(new Error("Static asset unavailable")),
          fetch,
          now: () => NOW,
          timeZone: "UTC",
          hostingTarget: "cloudflare",
          conditionalCache: fake.cache,
        }),
      );
    const snapshots = [await read(), await read()];
    expect(snapshots.map((snapshot) => snapshot.freshness)).toEqual(["stale", "stale"]);
  });

  it("retains independent alerts as stale when shared-feed static membership is unavailable", async () => {
    const bytes = encodeFeed(NOW / 1000, [
      encodeAlertEntity({ id: "shared", selectors: [{ routeId: "A" }], effect: 1 }),
    ]);
    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "sample",
        sources: [
          { type: "gtfs-rt", url: "https://sample.test/shared" },
          { type: "json", parser: "generic-alert-feed", url: "https://sample.test/independent" },
        ],
        sourceAgencyIds: ["operator-a"],
        getSourceAgencyScope: () => Effect.fail(new Error("Static asset unavailable")),
        fetch: vi.fn<typeof globalThis.fetch>(async (input) =>
          String(input).endsWith("shared")
            ? new Response(new Uint8Array(bytes))
            : new Response(
                JSON.stringify([
                  {
                    id: "independent",
                    title: "Service suspended",
                    activePeriod: { start: new Date(NOW).toISOString() },
                  },
                ]),
              ),
        ),
        now: () => NOW,
        timeZone: "UTC",
        hostingTarget: "self-hosted",
      }),
    );
    expect(snapshot.freshness).toBe("stale");
    expect(snapshot.alerts.map((alert) => alert.id)).toEqual(["independent"]);
  });

  it.each([true, false])(
    "keeps successful entity-only fetches live with matching or fallback wording, matched=%s",
    async (matched) => {
      const machine: DecodedFeed = {
        header: { version: "1.0", timestamp: NOW },
        tripUpdates: [],
        vehiclePositions: [],
        alerts: [
          {
            id: "incident",
            title: "Transit Alert",
            effect: "NO_SERVICE",
            targets: [{ routeId: "R1", stopId: "S1" }],
            tripIds: ["T1"],
            tripScoped: true,
            startsAt: NOW,
            updatedAt: NOW,
          },
        ],
      };
      adapterStubs.set("gtfs-rt", () => Effect.succeed(machine));
      const snapshot = await Effect.runPromise(
        fetchAgencyAlerts({
          agencyId: "sample",
          sources: [
            { type: "gtfs-rt", url: "https://sample.test/entities", entityOnly: true },
            { type: "json", parser: "generic-alert-feed", url: "https://sample.test/board" },
          ],
          fetch: vi.fn<typeof globalThis.fetch>(
            async () =>
              new Response(
                JSON.stringify(
                  matched
                    ? [
                        {
                          id: "incident",
                          title: "Trip starts late",
                          description: "Board at Central instead.",
                          targets: [{ routeId: "R1", stopId: "S1" }],
                          tripIds: ["T1"],
                          tripScoped: true,
                          activePeriod: { start: new Date(NOW).toISOString() },
                        },
                      ]
                    : [],
                ),
              ),
          ),
          now: () => NOW,
          timeZone: "UTC",
          hostingTarget: "self-hosted",
        }),
      );
      expect(snapshot.freshness).toBe("live");
      expect(snapshot.alerts).toHaveLength(1);
      expect(snapshot.alerts).toMatchObject(
        matched
          ? [
              {
                title: "Trip starts late",
                description: "Board at Central instead.",
                scope: "trip",
                severity: "degraded",
              },
            ]
          : [
              {
                title: "Cancelled departures",
                description:
                  "The operator reports cancelled departures for the affected trips but has not published further details.",
                scope: "trip",
                severity: "degraded",
              },
            ],
      );
    },
  );
  it("dispatches heading notices with declared route scope and retains machine alerts when the page fails", async () => {
    const sources: AlertSource[] = [
      { type: "json", parser: "generic-alert-feed", url: "https://sample.test/machine" },
      {
        type: "web",
        parser: "heading-service-notices",
        url: "https://sample.test/page",
        routeNames: { R: ["River Bus"] },
      },
    ];
    let html = "<main><h2>River Bus Detour</h2><p>Use Main Street.</p></main>";
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (input) =>
        new Response(
          input.toString().endsWith("/page")
            ? html
            : JSON.stringify([
                {
                  id: "machine",
                  title: "Stop closed",
                  route: "Q",
                  stops: ["S"],
                  effect: "NO_SERVICE",
                },
              ]),
        ),
    );
    const read = () =>
      Effect.runPromise(
        fetchAgencyAlerts({
          agencyId: "fictional-transit",
          sources,
          fetch,
          now: () => NOW,
          hostingTarget: "cloudflare",
          timeZone: "America/Toronto",
        }),
      );
    const healthy = await read();
    expect(healthy.freshness).toBe("live");
    expect(healthy.alerts.find((alert) => alert.title === "River Bus Detour")).toMatchObject({
      scope: "route",
      affectedRouteIds: ["R"],
    });
    html = "<main><h2>Schedules</h2></main>";
    const partial = await read();
    expect(partial.freshness).toBe("stale");
    expect(partial.alerts.map((alert) => alert.id)).toContain("machine");
  });
  it("reports a verified update-card archive as live with its stop closure", async () => {
    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "fictional-transit",
        sources: [
          {
            type: "web",
            parser: "heading-service-notices",
            url: "https://sample.test/page",
            routeNames: { "1": ["Route 1"] },
            stopNames: { east: ["East Stop"] },
            publicationReference: {
              publicationYear: 2026,
              validFrom: "2026-09-30",
              validThrough: "2026-11-30",
            },
          },
        ],
        fetch: vi.fn<typeof globalThis.fetch>(
          async () =>
            new Response(
              '<main><div class="service-update"><h4>October 19 3:51pm</h4><p>Route 1: East Stop is closed until further notice.</p></div></main>',
            ),
        ),
        now: () => Date.parse("2026-10-27T12:00:00Z"),
        hostingTarget: "cloudflare",
        timeZone: "UTC",
      }),
    );
    expect(snapshot.freshness).toBe("live");
    expect(snapshot.alerts).toHaveLength(1);
    expect(snapshot.alerts[0]).toMatchObject({
      scope: "station",
      affectedStations: [{ stationName: "east" }],
    });
  });
  it.each([
    { label: "an empty broadcast", payload: [], freshness: "live" },
    {
      label: "an active broadcast",
      payload: [
        { id: 0, message: "Detour", routeNum: 41, stopNum: 0, type: "Alert", isForDetour: true },
      ],
      freshness: "live",
    },
  ])("reports $label as $freshness", async ({ payload, freshness }) => {
    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "fictional-transit",
        sources: [
          { type: "json", parser: "mapstrat-broadcast", url: "https://sample.test/broadcast" },
        ],
        fetch: vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(payload))),
        now: () => NOW,
        hostingTarget: "cloudflare",
        timeZone: "America/Toronto",
      }),
    );
    expect(snapshot.freshness).toBe(freshness);
  });

  it("keeps a nonempty source stale when its declared coverage is partial", async () => {
    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "fictional-transit",
        sources: [
          {
            type: "json",
            parser: "generic-alert-feed",
            url: "https://sample.test/notices",
            coverage: "partial",
          },
        ],
        fetch: vi.fn<typeof globalThis.fetch>(
          async () =>
            new Response(
              JSON.stringify([
                { id: "known", title: "Route 41 detour", route: "41", effect: "DETOUR" },
              ]),
            ),
        ),
        now: () => NOW,
        hostingTarget: "cloudflare",
        timeZone: "America/Toronto",
      }),
    );
    expect(snapshot.freshness).toBe("stale");
    expect(snapshot.alerts).toHaveLength(1);
    expect(snapshot.alerts[0]?.title).toBe("Route 41 detour");
  });

  it.each([
    { label: "a malformed record", body: '[{"message":"Malformed"}]', status: 200 },
    { label: "an empty object", body: "{}", status: 200 },
    { label: "null", body: "null", status: 200 },
    { label: "a non-array object", body: '{"message":"Detour"}', status: 200 },
    { label: "truncated JSON", body: '[{"id":0,"message":"Detour"', status: 200 },
    { label: "an empty array on HTTP 500", body: "[]", status: 500 },
    { label: "an empty array on HTTP 404", body: "[]", status: 404 },
  ])("rejects $label instead of returning a quiet broadcast board", async ({ body, status }) => {
    await expect(
      Effect.runPromise(
        fetchAgencyAlerts({
          agencyId: "fictional-transit",
          sources: [
            { type: "json", parser: "mapstrat-broadcast", url: "https://sample.test/broadcast" },
          ],
          fetch: vi.fn<typeof globalThis.fetch>(async () => new Response(body, { status })),
          now: () => NOW,
          hostingTarget: "cloudflare",
          timeZone: "America/Toronto",
        }),
      ),
    ).rejects.toBeInstanceOf(AlertFetchError);
  });

  it.each([
    {
      label: "truncated advisory page",
      source: {
        type: "json",
        parser: "attribute-advisories",
        url: "https://sample.test/advisories",
      },
      payload: {
        data: [
          {
            id: 17,
            attributes: {
              title: "Road works",
              description: "Stop temporarily closed",
              startDate: "01-09-2026",
              endDate: "18-12-2026",
            },
          },
        ],
        meta: { pagination: { total: 2 } },
      },
      expected: "stale",
    },
    {
      label: "empty broadcast",
      source: { type: "json", parser: "mapstrat-broadcast", url: "https://sample.test/broadcast" },
      payload: [],
      expected: "live",
    },
    {
      label: "nonempty broadcast",
      source: { type: "json", parser: "mapstrat-broadcast", url: "https://sample.test/broadcast" },
      payload: [
        { id: 0, message: "Detour", routeNum: 41, stopNum: 0, type: "Alert", isForDetour: true },
      ],
      expected: "live",
    },
  ] as const)(
    "distinguishes incomplete JSON from a recovered proxy on 304: $label",
    async ({ source, payload, expected }) => {
      const fake = createFakeConditionalCache();
      const responses = [
        new Response(JSON.stringify(payload), {
          headers: { ETag: '"proxy"', Warning: '110 - "Response is Stale"' },
        }),
        new Response(null, { status: 304 }),
      ];
      const fetch = vi.fn<typeof globalThis.fetch>(async () => responses.shift()!);
      const poll = () =>
        Effect.runPromise(
          fetchAgencyAlerts({
            agencyId: "fictional-transit",
            sources: [source],
            fetch,
            now: () => NOW,
            timeZone: "UTC",
            hostingTarget: "cloudflare",
            conditionalCache: fake.cache,
          }),
        );
      expect((await poll()).freshness).toBe("stale");
      expect((await poll()).freshness).toBe(expected);
    },
  );

  it("posts the declared search body and exposes a truncated board as stale", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            totalCount: 2,
            value: [
              {
                document: {
                  Title: "Trunk A",
                  RouteTitle: "Trunk A",
                  Detour: "Roadworks",
                  RoutesAffected: "/works.pdf",
                },
              },
            ],
          }),
        ),
    );
    const body = { searchOptions: { size: 1 } };
    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "fictional-transit",
        sources: [
          {
            type: "json",
            parser: "eum-search-advisories",
            url: "https://sample.test/search",
            method: "POST",
            body,
          },
        ],
        fetch,
        now: () => NOW,
        hostingTarget: "cloudflare",
        timeZone: "America/Toronto",
      }),
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST", body: JSON.stringify(body) });
    expect(snapshot.freshness).toBe("stale");
    expect(snapshot.alerts[0]).toMatchObject({
      title: "Trunk A: Roadworks",
      affectedRouteIds: ["Trunk A"],
    });
  });

  it.each([
    { limit: undefined, expected: "stale", count: 3 },
    { limit: 4, expected: "live", count: 4 },
  ])("honours a declared Workers page ceiling: $limit", async ({ limit, expected, count }) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const page = new URL(String(input)).searchParams.get("page") ?? "1";
      const links =
        page === "1"
          ? '<ul class="pagination"><a href="?page=2">2</a><a href="?page=3">3</a><a href="?page=4">4</a></ul>'
          : "";
      return new Response(
        `<div class="blogItem"><div class="blogItem-contentContainer"><h2><a class="newsTitle" href="/news/${page}">Service advisory ${page}</a></h2><p>Published update.</p></div></div>${links}`,
      );
    });
    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "fictional",
        hostingTarget: "cloudflare",
        timeZone: "UTC",
        now: () => NOW,
        fetch,
        sources: [
          {
            type: "web",
            parser: "ghd-news-service-advisories",
            url: "https://example.test/board",
            cloudflareMaxCrawlPages: limit,
          },
        ],
      }),
    );
    expect(snapshot.freshness).toBe(expected);
    expect(snapshot.alerts).toHaveLength(count);
    expect(fetch).toHaveBeenCalledTimes(count);
  });

  it("keeps an expired generic JSON alert expired when its end has no start", async () => {
    const end = Date.parse("2020-01-01T00:00:00Z");
    const body = JSON.stringify([{ title: "Expired notice", expires_at: "2020-01-01T00:00:00Z" }]);
    const result = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "fictional-transit",
        sources: [
          { type: "json", url: "https://sample.test/alerts", parser: "generic-alert-feed" },
        ],
        fetch: vi.fn<typeof globalThis.fetch>(async () => new Response(body)),
        now: () => NOW,
        timeZone: "America/Toronto",
        hostingTarget: "self-hosted",
        manifest: { locale: "en-CA" },
      }),
    );

    expect(result.alerts[0]).toMatchObject({
      title: "Expired notice",
      lifecycle: "expired",
      startsAt: end,
      endsAt: end,
    });
  });

  it("keeps generated JSON alert ids stable and scoped to each configured source", async () => {
    const body = JSON.stringify([{ title: "Unnumbered closure", routes: ["R7"] }]);
    const sources: AlertSource[] = [
      { type: "json", url: "https://sample.test/alerts-a", parser: "generic-alert-feed" },
      { type: "json", url: "https://sample.test/alerts-b", parser: "generic-alert-feed" },
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(body));
    const read = (source: AlertSource, now: number) =>
      Effect.runPromise(
        fetchAgencyAlerts({
          agencyId: "fictional-transit",
          sources: [source],
          fetch,
          now: () => now,
          timeZone: "America/Toronto",
          hostingTarget: "self-hosted",
          manifest: { locale: "en-CA" },
        }),
      );

    const first = await read(sources[0]!, NOW);
    const sameSource = await read(sources[0]!, NOW + 60_000);
    const otherSource = await read(sources[1]!, NOW);

    expect(first.alerts[0]?.id).toMatch(/^json-alert-[0-9a-f]{16}$/u);
    expect(sameSource.alerts[0]?.id).toBe(first.alerts[0]?.id);
    expect(otherSource.alerts[0]?.id).not.toBe(first.alerts[0]?.id);
  });

  it("falls back to an available required language variant without marking the snapshot incomplete", async () => {
    const body = readFileSync(
      join(import.meta.dirname, "../fixtures/rss-proxy/issue326-english.xml"),
      "utf8",
    );
    const sources: AlertSource[] = (["en", "fr"] as const).map((language) => ({
      type: "rss",
      url: `https://placeholder.example.test/updates-${language}.xml`,
      language,
      languageGroup: "updates",
      expiryPolicy: "feed-presence",
      runtimes: ["cloudflare"],
      baseUrlSecretName: `FEED_${language.toUpperCase()}_PROXY_BASE`,
      requiredForCompleteness: true,
    }));
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(body));
    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "fictional-transit",
        sources,
        fetch,
        now: () => Date.parse("2026-10-10T14:00:00Z"),
        timeZone: "America/Toronto",
        hostingTarget: "cloudflare",
        locale: "fr-CA",
        manifest: { locale: "en-CA" },
        getSecret: (name) =>
          name === "FEED_EN_PROXY_BASE" ? "https://proxy.example.test/feeds" : undefined,
      }),
    );

    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://proxy.example.test/feeds/updates-en.xml",
    );
    expect(snapshot.freshness).toBe("live");
  });

  it.each(["en-CA", "fr-CA"] as const)(
    "preserves declared article identity through the %s RSS adapter path",
    async (locale) => {
      const sources: AlertSource[] = (["en", "fr"] as const).map((language) => ({
        type: "rss",
        url: `https://operator.example.test/${language}/updates.xml`,
        language,
        languageGroup: "service-updates",
        expiryPolicy: "feed-presence",
        routeIdsFromTitle: true,
        incidentIdentityPattern: "/articles/(\\d+)(?:[/?#]|$)",
        runtimes: ["self-hosted"],
      }));
      const fixture = (language: string) =>
        readFileSync(
          join(import.meta.dirname, `../fixtures/rss-proxy/issue326-${language}.xml`),
          "utf8",
        );
      const fetch = vi.fn<typeof globalThis.fetch>(
        async (input) =>
          new Response(fixture(String(input).includes("/fr/") ? "french" : "english")),
      );
      const snapshot = await Effect.runPromise(
        fetchAgencyAlerts({
          agencyId: "fictional-transit",
          sources,
          fetch,
          now: () => Date.parse("2026-10-10T14:00:00Z"),
          timeZone: "America/Toronto",
          hostingTarget: "self-hosted",
          locale,
        }),
      );

      expect(snapshot.freshness).toBe("live");
      expect(snapshot.alerts[0]?.incidentIdentity).toEqual({
        namespace: "service-updates",
        value: "1042",
      });
      expect(snapshot.alerts[0]?.title).toContain(locale === "fr-CA" ? "Circuit 42" : "Route 42");
    },
  );

  it.each(["self-hosted", "cloudflare"] as const)(
    "selects the French variant after runtime filtering on %s",
    async (hostingTarget) => {
      const body = readFileSync(
        join(import.meta.dirname, "../fixtures/rss-proxy/french-routes-and-categories.xml"),
        "utf8",
      );
      const sources: AlertSource[] = (["en", "fr"] as const).flatMap((language) => [
        {
          type: "rss",
          url: `https://operator.example.test/${language}/updates.xml`,
          language,
          languageGroup: "updates",
          expiryPolicy: "feed-presence",
          routeCategoryPrefix: "affectedRoutes-",
          routeIdsFromTitle: true,
          runtimes: ["self-hosted"],
        },
        {
          type: "rss",
          url: `https://placeholder.example.test/updates-${language}.xml`,
          language,
          languageGroup: "updates",
          expiryPolicy: "feed-presence",
          routeCategoryPrefix: "affectedRoutes-",
          routeIdsFromTitle: true,
          runtimes: ["cloudflare"],
          baseUrlSecretName: "FEED_PROXY_BASE",
          requiredForCompleteness: true,
        },
      ]);
      const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(body));
      const snapshot = await Effect.runPromise(
        fetchAgencyAlerts({
          agencyId: "fictional-transit",
          sources,
          fetch,
          now: () => Date.parse("2026-10-10T14:00:00Z"),
          timeZone: "America/Toronto",
          hostingTarget,
          locale: "fr-CA",
          getSecret: () => "https://proxy.example.test/feeds",
          schematic: {
            stations: [
              { id: "first", name: "Première", x: 0, y: 0, lines: [] },
              { id: "second", name: "Deuxième", x: 1, y: 1, lines: [] },
            ],
          },
        }),
      );
      expect(fetch).toHaveBeenCalledOnce();
      expect(String(fetch.mock.calls[0]?.[0])).toBe(
        hostingTarget === "cloudflare"
          ? "https://proxy.example.test/feeds/updates-fr.xml"
          : "https://operator.example.test/fr/updates.xml",
      );
      expect(snapshot.freshness).toBe("live");
      expect(snapshot.alerts[0]).toMatchObject({
        title: "Déviation : Circuits 42 et 43",
        affectedRouteIds: ["42", "43"],
      });
      expect(snapshot.alerts[1]).toMatchObject({
        title: "Service interrompu : Circuit 44",
        severity: "severe",
        fromStation: { stationId: "first", stationName: "Première" },
        toStation: { stationId: "second", stationName: "Deuxième" },
      });
    },
  );

  it.each([110, 111])(
    "preserves RSS proxy metadata and current stale warning %s through conditional reuse",
    async (warning) => {
      const body = readFileSync(
        join(import.meta.dirname, "../fixtures/rss-proxy/routes-and-categories.xml"),
        "utf8",
      );
      let now = Date.parse("2026-10-10T14:00:00Z");
      const cache = createFakeConditionalCache();
      const source: AlertSource = {
        type: "rss",
        url: "https://alerts.example.test/fictional.xml",
        expiryPolicy: "feed-presence",
        routeCategoryPrefix: "affectedRoutes-",
        routeIdsFromTitle: true,
        runtimes: ["cloudflare"],
        baseUrlSecretName: "FEED_PROXY_BASE",
        requiredForCompleteness: true,
        auth: { type: "header", headerName: "x-feed-token", secretName: "FEED_PROXY_TOKEN" },
      };
      const responses = [
        new Response(body, { headers: { ETag: '"rss-board"' } }),
        new Response(null, {
          status: 304,
          headers: { Warning: `${warning} - "Response is Stale"` },
        }),
        new Response(body, {
          headers: { ETag: '"rss-board"', Warning: `${warning} - "Response is Stale"` },
        }),
        new Response(null, { status: 304 }),
      ];
      const fetch = vi.fn<typeof globalThis.fetch>(async (_url, _init) => responses.shift()!);
      const snapshots = [];
      for (let index = 0; index < 4; index += 1) {
        snapshots.push(
          await Effect.runPromise(
            fetchAgencyAlerts({
              agencyId: "fictional-transit",
              sources: [source],
              fetch,
              now: () => now,
              timeZone: "America/Toronto",
              hostingTarget: "cloudflare",
              conditionalCache: cache.cache,
              getSecret: (name) =>
                name === "FEED_PROXY_BASE"
                  ? "https://proxy.example.test/alerts"
                  : "fictional-token",
              manifest: {
                alertInterpretation: {
                  rules: [
                    {
                      match: { sourceField: "rssCategory", sourceValue: "Detours" },
                      result: { kind: "information", severity: "normal", serviceChange: "detour" },
                    },
                  ],
                },
              },
            }),
          ),
        );
        now += 60_000;
      }
      expect(snapshots.map((snapshot) => snapshot.freshness)).toEqual([
        "live",
        "stale",
        "stale",
        "live",
      ]);
      expect(snapshots[0]?.alerts[0]).toMatchObject({
        id: "detour-42",
        kind: "information",
        serviceChange: "detour",
        affectedRouteIds: ["42", "43"],
        startsAt: Date.parse("2026-10-10T12:00:00Z"),
      });
      expect(snapshots[3]?.alerts).toEqual(snapshots[0]?.alerts);
      expect(fetch.mock.calls).toHaveLength(4);
      for (const [url, init] of fetch.mock.calls) {
        expect(String(url)).toBe("https://proxy.example.test/alerts/fictional.xml");
        expect(new Headers(init?.headers).get("x-feed-token")).toBe("fictional-token");
      }
      expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("If-None-Match")).toBe(
        '"rss-board"',
      );
    },
  );

  it("keeps a successfully received quiet feed live while retaining its old source timestamp", async () => {
    const source: AlertSource = {
      type: "gtfs-rt",
      url: "https://example.test/go-alerts",
    };
    const bytes = encodeFeed((NOW - 2 * 60 * 60 * 1_000) / 1_000, []);
    const body = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const fetch = vi.fn(async () => new Response(body));

    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "go",
        sources: [source],
        fetch: fetch as unknown as typeof globalThis.fetch,
        now: () => NOW,
        timeZone: "America/Toronto",
      }),
    );

    expect(snapshot).toMatchObject({
      agencyId: "go",
      generatedAt: NOW,
      sourceUpdatedAt: NOW - 2 * 60 * 60 * 1_000,
      freshness: "live",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports a stale board when a source that always has a standing alert returns none", async () => {
    const source: AlertSource = {
      type: "gtfs-rt",
      url: "https://example.test/standing-alerts",
      emptyIsStale: true,
    };
    const bytes = encodeFeed(NOW / 1_000, []);
    const body = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const fetch = vi.fn(async () => new Response(body));

    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "fictional-transit",
        sources: [source],
        fetch: fetch as unknown as typeof globalThis.fetch,
        now: () => NOW,
        timeZone: "America/Toronto",
      }),
    );

    expect(snapshot.freshness).toBe("stale");
    expect(snapshot.alerts).toEqual([]);
  });

  it("retries a failing alert source before recovering", async () => {
    const source: AlertSource = {
      type: "gtfs-rt",
      url: "https://example.test/go-alerts",
    };
    const bytes = encodeFeed((NOW - 2 * 60 * 60 * 1_000) / 1_000, []);
    const body = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls += 1;
      if (calls < 3) return new Response("upstream", { status: 500 });
      return new Response(body.slice(0));
    });

    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "go",
        sources: [source],
        fetch: fetch as unknown as typeof globalThis.fetch,
        now: () => NOW,
        timeZone: "America/Toronto",
      }),
    );

    expect(snapshot.freshness).toBe("live");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("fast-paths empty sources to unavailable freshness", async () => {
    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "ttc",
        sources: [],
        fetch: vi.fn() as unknown as typeof fetch,
        now: () => NOW,
        timeZone: "America/Toronto",
      }),
    );

    expect(snapshot).toMatchObject({
      agencyId: "ttc",
      generatedAt: NOW,
      freshness: "unavailable",
      alerts: [],
    });
  });

  it("keeps a short agency-local JSON alert active when the feed appends Z to wall-clock time", async () => {
    const now = Date.parse("2026-09-17T11:39:00.000Z");
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            routes: [
              {
                id: "line-1-security-incident",
                route: "1",
                headerText:
                  "Line 1 Yonge-University: No subway service between Finch and Sheppard-Yonge stations.",
                effect: "NO_SERVICE",
                activePeriod: {
                  start: "2026-09-17T07:36:20.303Z",
                  end: "2026-09-17T07:51:20.303Z",
                },
              },
            ],
          }),
        ),
    );

    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "ttc",
        sources: [
          {
            type: "json",
            url: "https://alerts.ttc.ca/api/alerts/live-alerts",
            parser: "generic-alert-feed",
            timestampMode: "agency-local-wall-clock",
          },
        ],
        fetch: fetch as unknown as typeof globalThis.fetch,
        now: () => now,
        timeZone: "America/Toronto",
        manifest: { alertInterpretation: { lineIds: ["1"] } },
      }),
    );

    expect(snapshot.alerts).toEqual([
      expect.objectContaining({
        id: "line-1-security-incident",
        affectedLineIds: ["1"],
        severity: "severe",
        lifecycle: "active",
      }),
    ]);
  });

  it("validates partial results as stale without wire fixtures", async () => {
    adapterStubs.set("gtfs-rt", () =>
      Effect.succeed({
        header: { version: "2.0", timestamp: NOW },
        tripUpdates: [],
        vehiclePositions: [],
        alerts: [
          {
            id: "mocked-1",
            title: "Mocked alert",
            startsAt: NOW - 1_000,
            updatedAt: NOW,
            effect: "SIGNIFICANT_DELAYS",
            routeIds: ["1"],
          },
        ],
      } satisfies DecodedFeed),
    );
    adapterStubs.set("json", () =>
      Effect.fail(
        new AlertFetchError({ agencyId: "ttc", source: "https://mock.test/json", message: "down" }),
      ),
    );

    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "ttc",
        sources: [
          { type: "gtfs-rt", url: "https://mock.test/gtfs" },
          { type: "json", url: "https://mock.test/json", parser: "generic-alert-feed" },
        ],
        fetch: vi.fn() as unknown as typeof fetch,
        now: () => NOW,
        timeZone: "America/Toronto",
      }),
    );

    expect(snapshot.freshness).toBe("stale");
    expect(snapshot.alerts.map((alert) => alert.id)).toEqual(["mocked-1"]);
  });

  it.each([
    {
      label: "daily quota",
      message: "D1_ERROR: account daily rows read limit reached",
      failureClass: "d1-daily-quota",
    },
    {
      label: "query time limit",
      message: "D1_ERROR: exceeded query time limit",
      failureClass: "d1-limit",
    },
    {
      label: "schema failure",
      message: "D1_ERROR: no such table: routes",
      failureClass: "storage-schema",
    },
    { label: "database failure", message: "D1_ERROR: connection failed", failureClass: "d1-error" },
    { label: "source failure", message: "request failed", failureClass: "source" },
  ])(
    "logs $label without printing its URL, query, or error text",
    async ({ message, failureClass }) => {
      const secretUrl = "https://alerts.example.test/feed?token=private-alert-token";
      adapterStubs.set("json", () =>
        Effect.fail(
          new AlertFetchError({
            agencyId: "fictional-transit",
            source: secretUrl,
            message: "request failed with private-alert-token",
            cause: new Error(`${message} private-alert-token`),
          }),
        ),
      );
      adapterStubs.set("rss", () =>
        Effect.succeed({
          header: { version: "2.0", timestamp: NOW },
          tripUpdates: [],
          vehiclePositions: [],
          alerts: [],
        } satisfies DecodedFeed),
      );
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

      const snapshot = await Effect.runPromise(
        fetchAgencyAlerts({
          agencyId: "fictional-transit",
          sources: [
            { type: "json", url: secretUrl, parser: "generic-alert-feed" },
            { type: "rss", url: "https://alerts.example.test/notices.xml", maxAgeMinutes: 60 },
          ],
          fetch: vi.fn() as unknown as typeof fetch,
          now: () => NOW,
          timeZone: "UTC",
        }),
      );

      expect(snapshot.freshness).toBe("stale");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("alert source failed"),
        expect.objectContaining({
          agencyId: "fictional-transit",
          sourceType: "json",
          failureClass,
        }),
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain("private-alert-token");
      warn.mockRestore();
    },
  );

  it("does not resolve a base URL secret outside the FEED_ namespace", async () => {
    const source = {
      type: "gtfs-rt",
      url: "https://alerts.example.test/feed",
      baseUrlSecretName: "VAPID_PRIVATE_KEY",
    } satisfies AlertSource;
    const getSecret = vi.fn(() => "private-vapid-value");
    const fetch = vi.fn();

    expect(isAlertSourceActive(source, "self-hosted", getSecret)).toBe(false);
    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "fictional-transit",
        sources: [source],
        fetch: fetch as unknown as typeof globalThis.fetch,
        now: () => NOW,
        timeZone: "UTC",
        hostingTarget: "self-hosted",
        getSecret,
      }),
    );

    expect(snapshot.freshness).toBe("unavailable");
    expect(getSecret).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("marks the snapshot stale when a source was only read in part", async () => {
    // A paginated board that lost a page still has real advisories worth showing,
    // but the rider is looking at a hole in it. The verdict has to be the one a
    // wholly failed source gets, or the hole renders as an all-clear.
    adapterStubs.set("web", () =>
      Effect.succeed({
        header: { version: "ghd", timestamp: NOW },
        tripUpdates: [],
        vehiclePositions: [],
        alerts: [{ id: "web-1", title: "Web Alert 1", startsAt: NOW, updatedAt: NOW }],
        partial: true,
      }),
    );

    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "drt",
        sources: [
          {
            type: "web",
            url: "https://example.test/drt",
            parser: "ghd-news-service-advisories",
            maxAgeMinutes: 20160,
          },
        ],
        fetch: vi.fn() as unknown as typeof fetch,
        now: () => NOW,
        timeZone: "America/Toronto",
      }),
    );

    expect(snapshot.freshness).toBe("stale");
    expect(snapshot.alerts.map((alert) => alert.id)).toEqual(["web-1"]);
  });

  it("marks a snapshot stale when a successful 200 web response is a GHD challenge page", async () => {
    const bytes = encodeFeed(NOW / 1_000, []);
    const body = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      input.toString().includes("/drt-web")
        ? new Response(UNKNOWN_GHD_HTML)
        : new Response(body.slice(0)),
    );

    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "drt",
        sources: [
          { type: "gtfs-rt", url: "https://feeds.example.test/drt-rt" },
          {
            type: "web",
            url: "https://feeds.example.test/drt-web",
            parser: "ghd-news-service-advisories",
            maxAgeMinutes: 20_160,
          },
        ],
        fetch: fetch as unknown as typeof globalThis.fetch,
        now: () => NOW,
        timeZone: "America/Toronto",
        hostingTarget: "cloudflare",
      }),
    );

    expect(snapshot.freshness).toBe("stale");
    expect(snapshot.alerts).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fails with the first rejection when every source rejects", async () => {
    adapterStubs.set("json", () =>
      Effect.fail(
        new AlertFetchError({ agencyId: "ttc", source: "https://mock.test/json", message: "down" }),
      ),
    );
    adapterStubs.set("rss", () =>
      Effect.fail(
        new AlertFetchError({ agencyId: "ttc", source: "https://mock.test/rss", message: "down" }),
      ),
    );

    const error = await Effect.runPromise(
      Effect.flip(
        fetchAgencyAlerts({
          agencyId: "ttc",
          sources: [
            { type: "json", url: "https://mock.test/json", parser: "generic-alert-feed" },
            { type: "rss", url: "https://mock.test/rss", maxAgeMinutes: 60 },
          ],
          fetch: vi.fn() as unknown as typeof fetch,
          now: () => NOW,
          timeZone: "America/Toronto",
        }),
      ),
    );

    expect(error).toBeInstanceOf(AlertFetchError);
    expect(error).toMatchObject({ source: "https://mock.test/json", message: "down" });
  });

  it("skips sources with enabled: false and returns unavailable when no sources remain", async () => {
    const fetch = vi.fn();
    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "yrt",
        sources: [
          {
            type: "web",
            url: "https://example.test/yrt-alerts",
            parser: "ghd-news-service-advisories",
            maxAgeMinutes: 4320,
            enabled: false,
          },
        ],
        fetch: fetch as unknown as typeof globalThis.fetch,
        now: () => NOW,
        timeZone: "America/Toronto",
      }),
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(snapshot.freshness).toBe("unavailable");
    expect(snapshot.alerts).toEqual([]);
  });

  it.each([
    {
      target: "cloudflare" as const,
      expectedWebCalls: 0,
      expectedGtfsCalls: 1,
      expectedAlertIds: ["gtfs-1"],
    },
    {
      target: "self-hosted" as const,
      expectedWebCalls: 1,
      expectedGtfsCalls: 1,
      expectedAlertIds: ["web-1", "gtfs-1"],
    },
  ])(
    "filters sources by hostingTarget ($target)",
    async ({ target, expectedWebCalls, expectedGtfsCalls, expectedAlertIds }) => {
      const webStub = vi.fn(() =>
        Effect.succeed({
          header: { version: "ghd", timestamp: NOW },
          tripUpdates: [],
          vehiclePositions: [],
          alerts: [{ id: "web-1", title: "Web Alert 1", startsAt: NOW, updatedAt: NOW }],
        }),
      );
      const gtfsStub = vi.fn(() =>
        Effect.succeed({
          header: { version: "2.0", timestamp: NOW },
          tripUpdates: [],
          vehiclePositions: [],
          alerts: [{ id: "gtfs-1", title: "GTFS Alert 1", startsAt: NOW, updatedAt: NOW }],
        }),
      );
      adapterStubs.set("web", webStub);
      adapterStubs.set("gtfs-rt", gtfsStub);

      const sources: AlertSource[] = [
        {
          type: "web",
          url: "https://example.test/yrt-web",
          parser: "ghd-news-service-advisories",
          maxAgeMinutes: 4320,
          runtimes: ["self-hosted"],
        },
        {
          type: "gtfs-rt",
          url: "http://example.test/yrt-gtfs",
        },
      ];

      const snapshot = await Effect.runPromise(
        fetchAgencyAlerts({
          agencyId: "yrt",
          sources,
          fetch: vi.fn() as unknown as typeof fetch,
          now: () => NOW,
          timeZone: "America/Toronto",
          hostingTarget: target,
        }),
      );

      expect(webStub).toHaveBeenCalledTimes(expectedWebCalls);
      expect(gtfsStub).toHaveBeenCalledTimes(expectedGtfsCalls);
      expect(snapshot.alerts.map((a) => a.id)).toEqual(expectedAlertIds);
    },
  );

  it("treats Miniflare local development as self-hosted so local workerd keeps self-hosted sources active", async () => {
    const webStub = vi.fn(() =>
      Effect.succeed({
        header: { version: "ghd", timestamp: NOW },
        tripUpdates: [],
        vehiclePositions: [],
        alerts: [{ id: "web-1", title: "Web Alert 1", startsAt: NOW, updatedAt: NOW }],
      }),
    );
    adapterStubs.set("web", webStub);

    const sources: AlertSource[] = [
      {
        type: "web",
        url: "https://example.test/yrt-web",
        parser: "ghd-news-service-advisories",
        maxAgeMinutes: 4320,
        runtimes: ["self-hosted"],
      },
    ];

    setMiniflareProbeForTesting(true);
    try {
      const snapshot = await Effect.runPromise(
        fetchAgencyAlerts({
          agencyId: "yrt",
          sources,
          fetch: vi.fn() as unknown as typeof fetch,
          now: () => NOW,
          timeZone: "America/Toronto",
        }),
      );

      expect(webStub).toHaveBeenCalledOnce();
      expect(snapshot.alerts.map((a) => a.id)).toEqual(["web-1"]);
    } finally {
      resetHostingTargetProbeForTesting();
    }
  });

  it("drops alert source to unavailable when baseUrlSecretName is unprovisioned", async () => {
    const gtfsStub = vi.fn(() =>
      Effect.succeed({
        header: { version: "gtfs", timestamp: NOW },
        tripUpdates: [],
        vehiclePositions: [],
        alerts: [{ id: "proxy-alert", title: "Proxy Alert", startsAt: NOW, updatedAt: NOW }],
      }),
    );
    adapterStubs.set("gtfs-rt", gtfsStub);

    const sources: AlertSource[] = [
      {
        type: "gtfs-rt",
        url: "https://alerts.example.com/yrt.pb",
        baseUrlSecretName: "FEED_ALERT_PROXY_BASE_URL",
      },
    ];

    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "yrt",
        sources,
        fetch: vi.fn() as unknown as typeof fetch,
        now: () => NOW,
        timeZone: "America/Toronto",
        getSecret: () => undefined,
      }),
    );

    expect(gtfsStub).not.toHaveBeenCalled();
    expect(snapshot.freshness).toBe("unavailable");
  });

  it.each([
    { required: true, enabled: true, runtimes: ["cloudflare"] as const, freshness: "stale" },
    { required: false, enabled: true, runtimes: ["cloudflare"] as const, freshness: "live" },
    { required: true, enabled: false, runtimes: ["cloudflare"] as const, freshness: "live" },
    { required: true, enabled: true, runtimes: ["self-hosted"] as const, freshness: "live" },
  ])(
    "preserves completeness when a proxy is unprovisioned: $required/$enabled/$runtimes",
    async ({ required, enabled, runtimes, freshness }) => {
      const bytes = encodeFeed(NOW / 1_000, []);
      const body = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      const fetch = vi.fn(async () => new Response(body));
      const snapshot = await Effect.runPromise(
        fetchAgencyAlerts({
          agencyId: "fictional-transit",
          sources: [
            { type: "gtfs-rt", url: "https://example.test/official.pb" },
            {
              type: "gtfs-rt",
              url: "https://example.test/board.pb",
              baseUrlSecretName: "FEED_BOARD_PROXY",
              requiredForCompleteness: required,
              enabled,
              runtimes,
            },
          ],
          hostingTarget: "cloudflare",
          fetch,
          now: () => NOW,
          timeZone: "America/Toronto",
          getSecret: () => undefined,
        }),
      );
      expect(fetch).toHaveBeenCalledOnce();
      expect(snapshot.alerts).toEqual([]);
      expect(snapshot.freshness).toBe(freshness);
    },
  );

  it("selects one grouped language feed and retains an independent complementary source", async () => {
    const sources: AlertSource[] = [
      {
        type: "rss",
        url: "https://example.test/updates-en",
        language: "en",
        languageGroup: "updates",
        expiryPolicy: "feed-presence",
      },
      {
        type: "rss",
        url: "https://example.test/updates-fr",
        language: "fr",
        languageGroup: "updates",
        expiryPolicy: "feed-presence",
      },
      {
        type: "rss",
        url: "https://example.test/accessibility",
        expiryPolicy: "feed-presence",
      },
    ];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const title = url.endsWith("updates-fr")
        ? "Déviation : Circuit 20"
        : url.endsWith("accessibility")
          ? "Ascenseur: Station Blair"
          : "English update";
      return new Response(
        `<rss><channel><item><guid>${url}</guid><title>${title}</title></item></channel></rss>`,
      );
    });

    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "sample",
        sources,
        fetch: fetch as typeof globalThis.fetch,
        now: () => NOW,
        timeZone: "America/Toronto",
        locale: "fr-CA",
        manifest: { locale: "en-CA", alertInterpretation: undefined },
      }),
    );

    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "https://example.test/updates-fr",
      "https://example.test/accessibility",
    ]);
    expect(snapshot.alerts.map((alert) => alert.title)).toEqual([
      "Déviation : Circuit 20",
      "Ascenseur: Station Blair",
    ]);
  });

  it("retains alerts from a language group with no supported fallback", async () => {
    const sources: AlertSource[] = [
      {
        type: "rss",
        url: "https://example.test/updates-es",
        language: "es",
        languageGroup: "updates",
        expiryPolicy: "feed-presence",
      },
      {
        type: "rss",
        url: "https://example.test/accessibility",
        expiryPolicy: "feed-presence",
      },
    ];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const title = url.endsWith("updates-es") ? "Servicio suspendido" : "Ascensor cerrado";
      return new Response(
        `<rss><channel><item><guid>${url}</guid><title>${title}</title></item></channel></rss>`,
      );
    });

    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "sample",
        sources,
        fetch: fetch as typeof globalThis.fetch,
        now: () => NOW,
        timeZone: "America/Toronto",
        locale: "fr-CA",
        manifest: { locale: "en-CA", alertInterpretation: undefined },
      }),
    );

    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "https://example.test/updates-es",
      "https://example.test/accessibility",
    ]);
    expect(snapshot.alerts.map((alert) => alert.title)).toEqual([
      "Servicio suspendido",
      "Ascensor cerrado",
    ]);
    expect(snapshot.freshness).toBe("live");
  });

  it("fails honestly when baseUrlSecretName contains a malformed URL", async () => {
    const sources: AlertSource[] = [
      {
        type: "gtfs-rt",
        url: "https://alerts.example.com/yrt.pb",
        baseUrlSecretName: "FEED_ALERT_PROXY_BASE_URL",
      },
    ];

    const error = await Effect.runPromise(
      Effect.flip(
        fetchAgencyAlerts({
          agencyId: "yrt",
          sources,
          fetch: vi.fn() as unknown as typeof fetch,
          now: () => NOW,
          timeZone: "America/Toronto",
          getSecret: (name) =>
            name === "FEED_ALERT_PROXY_BASE_URL" ? "ht!tp://malformed-url" : undefined,
        }),
      ),
    );

    expect(error.message).toContain("Invalid base URL secret FEED_ALERT_PROXY_BASE_URL");
    expect(JSON.stringify(error)).not.toContain("ht!tp://malformed-url");
  });

  it("rewrites the outbound URL and preserves subpaths through fetchAgencyAlerts when baseUrlSecretName is provisioned", async () => {
    const bytes = encodeFeed(NOW / 1_000, []);
    const body = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const mockFetch = vi.fn(async () => new Response(body));

    const source: AlertSource = {
      type: "gtfs-rt",
      url: "https://alerts.example.com/api/yrt.pb?filter=active",
      baseUrlSecretName: "FEED_ALERT_PROXY_BASE_URL",
    };

    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "yrt",
        sources: [source],
        fetch: mockFetch as unknown as typeof fetch,
        now: () => NOW,
        timeZone: "America/Toronto",
        getSecret: (name) =>
          name === "FEED_ALERT_PROXY_BASE_URL"
            ? "https://proxy.example.com:8443/tunnel-prefix?gw_auth=1"
            : undefined,
      }),
    );

    expect(snapshot.freshness).toBe("live");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://proxy.example.com:8443/tunnel-prefix/api/yrt.pb?gw_auth=1&filter=active",
      expect.anything(),
    );
  });

  it("fetches a mixed agency wholly into a live snapshot when every source succeeds", async () => {
    // Option C: routing selects agencies, never sources. A mixed agency reads
    // its slow boards on the fast cycle too, so a fully successful fetch is
    // live and dispatchable — never narrowed-stale.
    const gtfsStub = vi.fn(() =>
      Effect.succeed({
        header: { version: "2.0", timestamp: NOW },
        tripUpdates: [],
        vehiclePositions: [],
        alerts: [{ id: "fast-1", title: "Fast Alert 1", startsAt: NOW, updatedAt: NOW }],
      }),
    );
    const webStub = vi.fn(() =>
      Effect.succeed({
        header: { version: "ghd", timestamp: NOW },
        tripUpdates: [],
        vehiclePositions: [],
        alerts: [{ id: "web-1", title: "Web Alert 1", startsAt: NOW, updatedAt: NOW }],
      }),
    );
    adapterStubs.set("gtfs-rt", gtfsStub);
    adapterStubs.set("web", webStub);

    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "grt",
        sources: [
          { type: "gtfs-rt", url: "https://example.test/grt-gtfs" },
          {
            type: "web",
            url: "https://example.test/grt-web",
            parser: "ghd-news-service-advisories",
          },
        ],
        fetch: vi.fn() as unknown as typeof fetch,
        now: () => NOW,
        timeZone: "America/Toronto",
      }),
    );

    expect(gtfsStub).toHaveBeenCalledOnce();
    expect(webStub).toHaveBeenCalledOnce();
    expect(snapshot.freshness).toBe("live");
    expect(snapshot.alerts.map((alert) => alert.id).sort()).toEqual(["fast-1", "web-1"]);
  });

  it("serves a mixed agency stale when its slow crawl truncates at the ceiling", async () => {
    // The fast source succeeds but the board is longer than the Cloudflare
    // ceiling: the surviving pages are worth showing, yet the snapshot must
    // stay stale so the evaluator preserves history instead of dispatching a
    // short read as the whole board.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const gtfsStub = vi.fn(() =>
        Effect.succeed({
          header: { version: "2.0", timestamp: NOW },
          tripUpdates: [],
          vehiclePositions: [],
          alerts: [{ id: "fast-1", title: "Fast Alert 1", startsAt: NOW, updatedAt: NOW }],
        }),
      );
      adapterStubs.set("gtfs-rt", gtfsStub);
      const indexUrl = "https://example.test/grt-web";
      const card = (name: string, next?: number) => `
        <div class="blogItem"><div class="blogItem-contentContainer">
          <h2><a class="newsTitle" href="https://example.test/news/${name}.aspx">${name}</a></h2>
          <p><strong>Routes affected</strong>: ${name}</p>
        </div></div>${
          next === undefined
            ? ""
            : `<div class="pagination-container"><a href="/grt-web?page=${next}">${next}</a></div>`
        }`;
      const bodies: Record<string, string> = {
        [indexUrl]: card("Route 1", 2),
        [`${indexUrl}?page=2`]: card("Route 2", 3),
        [`${indexUrl}?page=3`]: card("Route 3", 4),
        [`${indexUrl}?page=4`]: card("Route 4", 5),
        [`${indexUrl}?page=5`]: card("Route 5"),
      };
      const fetchedUrls: string[] = [];
      const mockFetch = vi.fn(async (url: string) => {
        fetchedUrls.push(url);
        const body = bodies[url];
        return body === undefined
          ? new Response(null, { status: 404 })
          : new Response(body, { status: 200 });
      });

      const snapshot = await Effect.runPromise(
        fetchAgencyAlerts({
          agencyId: "grt",
          sources: [
            { type: "gtfs-rt", url: "https://example.test/grt-gtfs" },
            {
              type: "web",
              url: indexUrl,
              parser: "ghd-news-service-advisories",
            },
          ],
          fetch: mockFetch as unknown as typeof fetch,
          now: () => NOW,
          timeZone: "America/Toronto",
          hostingTarget: "cloudflare",
        }),
      );

      expect(gtfsStub).toHaveBeenCalledOnce();
      expect(fetchedUrls.filter((url) => url.startsWith(indexUrl))).toEqual([
        indexUrl,
        `${indexUrl}?page=2`,
        `${indexUrl}?page=3`,
      ]);
      expect(snapshot.freshness).toBe("stale");
      expect(snapshot.alerts.map((alert) => alert.id)).toContain("fast-1");
    } finally {
      warn.mockRestore();
    }
  });

  it("does not reuse decoded scope from another static identity generation", async () => {
    const fake = createFakeConditionalCache();
    const headers: (string | null)[] = [];
    const bytes = encodeFeed(NOW / 1000, []);
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      headers.push(new Headers(init?.headers).get("If-None-Match"));
      return new Response(new Uint8Array(bytes), { headers: { ETag: '"feed-a"' } });
    });
    const read = (identityGeneration: string) =>
      Effect.runPromise(
        fetchAgencyAlerts({
          agencyId: "sample",
          sources: [{ type: "gtfs-rt", url: "https://sample.test/alerts" }],
          fetch,
          identityGeneration,
          conditionalCache: fake.cache,
          hostingTarget: "cloudflare",
          now: () => NOW,
          timeZone: "UTC",
        }),
      );
    await read("generation-a");
    await read("generation-b");
    expect(headers).toEqual([null, null]);
    expect(fake.storedUrls()).toHaveLength(2);
  });

  it("hashes conditional-cache entries while fetching the full authed URL", async () => {
    // GO's feed carries its key in the query string. The cache identity must
    // hold no secret material; the upstream request keeps proving identity.
    const fake = createFakeConditionalCache();
    const bytes = encodeFeed((NOW - 2 * 60 * 60 * 1_000) / 1_000, []);
    const body = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const requestedUrls: string[] = [];
    const mockFetch = vi.fn(async (url: string) => {
      requestedUrls.push(url);
      return new Response(body.slice(0), { status: 200, headers: { ETag: '"go-1"' } });
    });
    const source: AlertSource = {
      type: "gtfs-rt",
      url: "https://example.test/go-alerts",
      auth: { type: "query_param", parameterName: "key", secretName: "FEED_KEY" },
    };

    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "go",
        sources: [source],
        fetch: mockFetch as unknown as typeof fetch,
        now: () => NOW,
        timeZone: "America/Toronto",
        hostingTarget: "cloudflare",
        conditionalCache: fake.cache,
        getSecret: (name) => (name === "FEED_KEY" ? "super-secret-value" : undefined),
      }),
    );

    expect(snapshot.freshness).toBe("live");
    expect(requestedUrls).toEqual(["https://example.test/go-alerts?key=super-secret-value"]);
    expect(fake.storedUrls()).toHaveLength(1);
    expect(fake.storedUrls()[0]).not.toContain("super-secret-value");
    expect(fake.storedUrls()[0]).not.toContain("key=");
  });

  it("walks the full retry ladder for a slow source on self-hosted runtimes", async () => {
    // No adapter stubs: the real web adapter and kernel observe the attempts.
    let calls = 0;
    const mockFetch = vi.fn(async () => {
      calls += 1;
      if (calls < 3) return new Response("upstream", { status: 500 });
      return new Response(
        '<section class="content component listing-component usn_cmp_newsfeed"><p>No articles were found.</p></section>',
        { status: 200 },
      );
    });

    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "drt",
        sources: [
          {
            type: "web",
            url: "https://example.test/drt",
            parser: "ghd-news-service-advisories",
          },
        ],
        fetch: mockFetch as unknown as typeof fetch,
        now: () => NOW,
        timeZone: "America/Toronto",
        hostingTarget: "self-hosted",
      }),
    );

    expect(snapshot.freshness).toBe("live");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("spends a single attempt on a slow source on Cloudflare and fails honestly", async () => {
    const mockFetch = vi.fn(async () => new Response("upstream", { status: 500 }));

    const error = await Effect.runPromise(
      Effect.flip(
        fetchAgencyAlerts({
          agencyId: "drt",
          sources: [
            {
              type: "web",
              url: "https://example.test/drt",
              parser: "ghd-news-service-advisories",
            },
          ],
          fetch: mockFetch as unknown as typeof fetch,
          now: () => NOW,
          timeZone: "America/Toronto",
          hostingTarget: "cloudflare",
        }),
      ),
    );

    expect(error).toBeInstanceOf(AlertFetchError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("caps cross-source fanout at two concurrent sources on Cloudflare", async () => {
    let inFlight = 0;
    let peak = 0;
    adapterStubs.set("gtfs-rt", (source) =>
      Effect.promise(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return {
          header: { version: "2.0", timestamp: NOW },
          tripUpdates: [],
          vehiclePositions: [],
          alerts: [{ id: `peak-${source.url}`, title: "Peak", startsAt: NOW, updatedAt: NOW }],
        };
      }),
    );

    await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "ttc",
        sources: [1, 2, 3, 4].map((index) => ({
          type: "gtfs-rt" as const,
          url: `https://example.test/peak-${index}`,
        })),
        fetch: vi.fn() as unknown as typeof fetch,
        now: () => NOW,
        timeZone: "America/Toronto",
        hostingTarget: "cloudflare",
      }),
    );

    expect(peak).toBeLessThanOrEqual(2);
  });

  it("keeps the unbounded cross-source fanout on self-hosted runtimes", async () => {
    let inFlight = 0;
    let peak = 0;
    adapterStubs.set("gtfs-rt", (source) =>
      Effect.promise(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return {
          header: { version: "2.0", timestamp: NOW },
          tripUpdates: [],
          vehiclePositions: [],
          alerts: [{ id: `peak-${source.url}`, title: "Peak", startsAt: NOW, updatedAt: NOW }],
        };
      }),
    );

    await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "ttc",
        sources: [1, 2, 3, 4].map((index) => ({
          type: "gtfs-rt" as const,
          url: `https://example.test/peak-${index}`,
        })),
        fetch: vi.fn() as unknown as typeof fetch,
        now: () => NOW,
        timeZone: "America/Toronto",
        hostingTarget: "self-hosted",
      }),
    );

    expect(peak).toBeGreaterThan(2);
  });

  it("reuses an unchanged board across evaluation cycles without decoding", async () => {
    // No adapter stubs: the real gtfs-rt adapter and kernel observe the
    // injected store end to end. The second cycle's 304 carries no body, so
    // any decode work would fail or empty the snapshot — a live snapshot with
    // identical alerts proves zero decode work happened.
    const fake = createFakeConditionalCache();
    const bytes = encodeFeed((NOW - 2 * 60 * 60 * 1_000) / 1_000, []);
    const body = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    let calls = 0;
    let revalidationValidator: string | null = null;
    const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        return new Response(body.slice(0), { status: 200, headers: { ETag: '"cycle-1"' } });
      }
      revalidationValidator = new Headers(init?.headers).get("If-None-Match");
      return new Response(null, { status: 304 });
    });
    const source: AlertSource = { type: "gtfs-rt", url: "https://example.test/go-alerts" };
    const cycle = (now: number) =>
      Effect.runPromise(
        fetchAgencyAlerts({
          agencyId: "go",
          sources: [source],
          fetch: mockFetch as unknown as typeof fetch,
          now: () => now,
          timeZone: "America/Toronto",
          hostingTarget: "cloudflare",
          conditionalCache: fake.cache,
        }),
      );

    const first = await cycle(NOW);
    expect(first.freshness).toBe("live");

    const second = await cycle(NOW + 60_000);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(revalidationValidator).toBe('"cycle-1"');
    expect(second.freshness).toBe("live");
    expect(second.alerts).toEqual(first.alerts);
    expect(second.generatedAt).toBe(NOW + 60_000);
    expect(second.sourceUpdatedAt).toBe(first.sourceUpdatedAt);
  });

  it("preserves stale proxy evidence on 200 and 304 and clears it on healthy revalidation", async () => {
    const fake = createFakeConditionalCache();
    const bytes = encodeFeed(NOW / 1000, []);
    const responses = [
      new Response(new Uint8Array(bytes).buffer, {
        headers: { ETag: '"proxy"', Warning: '110 - "Response is Stale"' },
      }),
      new Response(null, { status: 304, headers: { Warning: '110 - "Response is Stale"' } }),
      new Response(null, { status: 304 }),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const poll = () =>
      Effect.runPromise(
        fetchAgencyAlerts({
          agencyId: "fictional",
          sources: [{ type: "gtfs-rt", url: "https://example.test/proxy.pb" }],
          fetch: fetchImpl as typeof fetch,
          now: () => NOW,
          timeZone: "UTC",
          hostingTarget: "cloudflare",
          conditionalCache: fake.cache,
        }),
      );
    expect((await poll()).freshness).toBe("stale");
    expect((await poll()).freshness).toBe("stale");
    expect((await poll()).freshness).toBe("live");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("reuses recent opposite-cadence observations and fetches on a cold or expired cache", async () => {
    const fake = createFakeConditionalCache();
    let now = NOW;
    const urls: string[] = [];
    const sources: AlertSource[] = [
      { type: "json", url: "https://example.test/fast", parser: "generic-alert-feed" },
      { type: "rss", url: "https://example.test/slow", expiryPolicy: "feed-presence" },
    ];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(
        url.endsWith("fast")
          ? JSON.stringify([{ id: "fast", title: "Service suspended" }])
          : "<rss><channel><item><guid>slow</guid><title>Line 2 suspended</title></item></channel></rss>",
      );
    });
    const cycle = (sourceTypes: AlertSource["type"][]) =>
      Effect.runPromise(
        fetchAgencyAlerts({
          agencyId: "fictional",
          sources,
          fetch: fetchImpl as typeof fetch,
          now: () => now,
          timeZone: "UTC",
          hostingTarget: "cloudflare",
          conditionalCache: fake.cache,
          sourceTypes,
        }),
      );
    const cold = await cycle(["json", "gtfs-rt"]);
    expect(cold.freshness).toBe("live");
    expect([...urls].sort()).toEqual([sources[0]!.url, sources[1]!.url].sort());
    const slow = await cycle(["web", "rss"]);
    expect(slow.freshness).toBe("live");
    expect(slow.alerts.map((alert) => alert.id)).toEqual(["fast", "slow"]);
    expect([...urls].sort()).toEqual([sources[0]!.url, sources[1]!.url, sources[1]!.url].sort());
    now += 60_000;
    const fast = await cycle(["json", "gtfs-rt"]);
    expect(fast.freshness).toBe("live");
    expect(fast.alerts.map((alert) => alert.id)).toEqual(["fast", "slow"]);
    expect([...urls].sort()).toEqual(
      [sources[0]!.url, sources[1]!.url, sources[1]!.url, sources[0]!.url].sort(),
    );
    now += 16 * 60_000 + 1;
    expect((await cycle(["json", "gtfs-rt"])).freshness).toBe("live");
    expect(urls.filter((url) => url.endsWith("slow"))).toHaveLength(3);
  });

  it("keeps self-hosted cycles unconditional without an injected store", async () => {
    const bytes = encodeFeed((NOW - 2 * 60 * 60 * 1_000) / 1_000, []);
    const body = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const sentValidators: (string | null)[] = [];
    const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      sentValidators.push(headers.get("If-None-Match"), headers.get("If-Modified-Since"));
      return new Response(body.slice(0), { status: 200 });
    });
    const source: AlertSource = { type: "gtfs-rt", url: "https://example.test/go-alerts" };
    const cycle = () =>
      Effect.runPromise(
        fetchAgencyAlerts({
          agencyId: "go",
          sources: [source],
          fetch: mockFetch as unknown as typeof fetch,
          now: () => NOW,
          timeZone: "America/Toronto",
          hostingTarget: "self-hosted",
        }),
      );

    const first = await cycle();
    const second = await cycle();

    expect(first.freshness).toBe("live");
    expect(second.freshness).toBe("live");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(sentValidators).toEqual([null, null, null, null]);
  });
});

it.each([false, true])(
  "discovers new holiday details and reports failed article reads honestly: %s",
  async (failArticle) => {
    const fixture = JSON.parse(
      readFileSync(join(import.meta.dirname, "../fixtures/ghd-news/linked-article.json"), "utf8"),
    );
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      String(input).endsWith("/holiday")
        ? new Response(failArticle ? "unavailable" : fixture.article, {
            status: failArticle ? 503 : 200,
          })
        : new Response(fixture.board),
    );
    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "fictional",
        sources: [
          {
            type: "web",
            parser: "ghd-news-service-advisories",
            url: "https://sample.test/board",
            maxAgeMinutes: 1440,
          },
        ],
        fetch,
        now: () => Date.parse("2026-10-12T16:00:00Z"),
        hostingTarget: "cloudflare",
        timeZone: "America/Toronto",
        manifest: {
          alertInterpretation: {
            lineIds: ["A", "B"],
            routeNames: { A: ["no City Transit service"], B: ["no City Transit service"] },
            rules: [
              {
                match: { textIncludes: ["no City Transit service"] },
                result: { kind: "suspension", severity: "severe" },
              },
            ],
          },
        },
      }),
    );
    expect(snapshot.freshness).toBe(failArticle ? "stale" : "live");
    expect(
      snapshot.alerts
        .filter((a) => a.severity === "severe")
        .map(({ affectedLineIds, startsAt, endsAt }) => ({ affectedLineIds, startsAt, endsAt })),
    ).toEqual(
      failArticle
        ? []
        : [{ affectedLineIds: ["A", "B"], startsAt: fixture.startsAt, endsAt: fixture.endsAt }],
    );
    expect(fetch.mock.calls.map(([url]) => String(url))).toContain("https://sample.test/holiday");
  },
);

it("substitutes the receipt instant in a publication-filter URL before fetching", async () => {
  const urls: string[] = [];
  const snapshot = await Effect.runPromise(
    fetchAgencyAlerts({
      agencyId: "sample",
      now: () => NOW,
      timeZone: "UTC",
      hostingTarget: "self-hosted",
      sources: [
        { type: "json", parser: "generic-alert-feed", url: "https://sample.test/notices?at={now}" },
      ],
      fetch: async (input) => {
        urls.push(String(input));
        return Response.json([]);
      },
    }),
  );
  expect(urls.map((url) => new URL(url).searchParams.get("at"))).toEqual([
    new Date(NOW).toISOString(),
  ]);
  expect(snapshot.freshness).toBe("live");
});
