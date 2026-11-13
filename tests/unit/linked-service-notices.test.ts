import { readFileSync } from "node:fs";
import { decodeLinkedServiceNotices } from "~/infrastructure/realtime/linkedServiceNotices";
import { it, expect } from "vitest";
import * as Effect from "effect/Effect";
import { fetchAgencyAlerts } from "~/infrastructure/realtime/fetchAgencyAlerts";
const now = Date.parse("2026-11-10T12:00:00Z");
const index =
  '<a data-alerts-type="notice" data-alerts-line="/7/" href="/one"><h3>First notice</h3></a><a data-alerts-type="notice" data-alerts-line="/8/" href="/two"><h3>Second notice</h3></a>';
const detail = (route: string) =>
  `<main><h1>Route ${route} detour</h1><div class="body-blocks"><p>Construction affects service.</p></div><div class="affected-lines"><span class="chip-large">${route}</span></div><div class="date-published">Publié le 10 novembre 2026</div></main>`;
it.each(["cloudflare", "self-hosted"] as const)(
  "reads every linked advisory and marks a failed detail stale on %s",
  async (hostingTarget) => {
    const options = {
      agencyId: "sample",
      sources: [
        {
          type: "web" as const,
          parser: "heading-service-notices" as const,
          url: "https://sample.test/board",
          cloudflareMaxCrawlPages: 10,
        },
      ],
      now: () => now,
      timeZone: "America/Toronto",
      hostingTarget,
    };
    const read = async (fail: boolean) =>
      Effect.runPromise(
        fetchAgencyAlerts({
          ...options,
          fetch: (async (input) => {
            const url = String(input);
            if (url.endsWith("/two") && fail) return new Response("offline", { status: 503 });
            return new Response(
              url.endsWith("/board") ? index : detail(url.endsWith("/one") ? "7" : "8"),
            );
          }) as typeof fetch,
        }),
      );
    const complete = await read(false);
    expect(complete.freshness).toBe("live");
    expect(complete.alerts.map((a) => a.title)).toEqual(["Route 7 detour", "Route 8 detour"]);
    const partial = await read(true);
    expect(partial.freshness).toBe("stale");
    expect(partial.alerts.map((a) => a.title)).toEqual(["Route 7 detour"]);
  },
);

const contract: { cases: { name: string; html: string; urls?: string[]; error?: boolean }[] } =
  JSON.parse(
    readFileSync(
      new URL("../fixtures/linked-service-notices/contract.json", import.meta.url),
      "utf8",
    ),
  );
it.each(contract.cases.filter((c) => !c.error))("$name", (entry) => {
  expect(
    decodeLinkedServiceNotices(entry.html, "https://example.test/board", now, "UTC")?.pageUrls,
  ).toEqual(entry.urls);
});
it.each(contract.cases.filter((c) => c.error))("$name", (entry) => {
  expect(() =>
    decodeLinkedServiceNotices(entry.html, "https://example.test/board", now, "UTC"),
  ).toThrow();
});

it.each([
  { requestTimeoutMs: 20, succeeds: false },
  { requestTimeoutMs: 200, succeeds: true },
])(
  "applies the web deadline to linked article requests: $requestTimeoutMs",
  async ({ requestTimeoutMs, succeeds }) => {
    const result = await Effect.runPromiseExit(
      fetchAgencyAlerts({
        agencyId: "slow-publisher",
        sources: [
          {
            type: "web",
            parser: "heading-service-notices",
            url: "https://slow.test/board",
            requestTimeoutMs,
          },
        ],
        hostingTarget: "cloudflare",
        now: () => now,
        timeZone: "UTC",
        fetch: (async (input, init) => {
          if (String(input).endsWith("/board"))
            return new Response(
              '<a data-alerts-type="notice" data-alerts-line="/7/" href="/one"><h3>First notice</h3></a>',
            );
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 60);
            init?.signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(new Error("aborted"));
              },
              { once: true },
            );
          });
          return new Response(detail("7"));
        }) as typeof fetch,
      }),
    );
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") throw new Error("Expected partial or complete snapshot");
    expect(result.value.freshness).toBe(succeeds ? "live" : "stale");
    expect(result.value.alerts).toHaveLength(succeeds ? 1 : 0);
  },
);

it("reconciles mixed update boards and follows active cards for stop scope and periods", async () => {
  const html =
    '<main><article class="featured-update-card"><a href="/detail"><span class="field--name-title">Route 7 closure</span><span>Active</span><div class="text-caption">Until further notice</div></a></article><h2>Road closure</h2><p>Route 8 diverted via Main.</p></main>';
  const fixtures = JSON.parse(
    readFileSync(
      new URL("../fixtures/heading-service-notices/contract.json", import.meta.url),
      "utf8",
    ),
  );
  const detail = fixtures.cases.find(
    (c: { name: string }) =>
      c.name === "linked update details retain published periods and stop scope",
  ).html;
  const result = await Effect.runPromise(
    fetchAgencyAlerts({
      agencyId: "sample",
      timeZone: "America/Toronto",
      now: () => Date.parse("2026-11-12T15:00:00Z"),
      stationIndex: [
        {
          id: "s",
          schematicId: "central",
          name: "Central",
          lat: 45,
          lon: -74,
          lines: ["7"],
          platformIds: ["s"],
        },
      ],
      sources: [
        {
          type: "web",
          parser: "heading-service-notices",
          url: "https://updates.example.test/board",
          routeNames: { "7": ["Route 7"] },
          stopNames: { s: ["Central"] },
        },
      ],
      fetch: async (input) => new Response(String(input).endsWith("/board") ? html : detail),
    }),
  );
  expect(result.freshness).toBe("live");
  expect(result.alerts.map((a) => a.title).sort()).toEqual(["Road closure", "Route 7 closure"]);
  expect(result.alerts.find((a) => a.title === "Route 7 closure")).toMatchObject({
    scope: "station",
    targets: [{ station: { stationId: "central", stationName: "Central" }, routeId: "7" }],
    startsAt: Date.parse("2026-11-12T14:00:00Z"),
    endsAt: Date.parse("2026-11-12T23:00:00Z"),
  });
});
