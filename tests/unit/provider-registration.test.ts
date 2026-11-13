import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { validateProvider } from "../../src/agencies/validateProvider";
import { createAgencyProvider, createLazySource } from "../../src/agencies/createAgencyProvider";
import { allProviders } from "../../src/agencies/registry";
import type { AgencyAlert, AgencyProvider, Schematic } from "../../src/agencies/types";
import { deriveLineStatuses } from "../../src/domain/interpretSnapshot";
import { buildMapModel } from "../../src/core/map";
import { decodeGhdNewsServiceAdvisories } from "../../src/infrastructure/realtime/ghdNewsServiceAdvisoriesParser";
import { makeMinimalSchematic } from "../helpers/fixtures";
import {
  makeStationSchematic,
  makeTestManifest,
  makeTestProvider,
} from "../helpers/agency-fixtures";
import {
  concatBuffers,
  encodeFeedHeader,
  encodeSurfaceVehiclePositionEntity,
  encodeSubwayTripUpdateEntity,
} from "../helpers/gtfs-rt-binary";

it("retries a lazy source load after the first load rejects", async () => {
  let attempts = 0;
  const loadSource = createLazySource(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("transient source load failure");
    return { ready: true };
  });

  await expect(loadSource()).rejects.toThrow("transient source load failure");
  await expect(loadSource()).resolves.toEqual({ ready: true });
  await expect(loadSource()).resolves.toEqual({ ready: true });
  expect(attempts).toBe(2);
});

const sampleManifestConfig = makeTestManifest();
const jsonProvider = makeTestProvider({
  alerts: [
    {
      type: "gtfs-rt",
      format: "json",
      url: "https://example.test/Gtfs/Feed/Alerts",
      auth: { type: "query_param", parameterName: "key", secretName: "FEED_API_KEY" },
    },
    {
      type: "gtfs-rt",
      format: "json",
      url: "https://example.test/UP/Gtfs/Feed/Alerts",
      auth: { type: "query_param", parameterName: "key", secretName: "FEED_API_KEY" },
    },
  ],
});
const newsProvider = makeTestProvider({
  alerts: [
    {
      type: "web",
      url: "https://example.test/Modules/News/en/serviceadvisories",
      parser: "ghd-news-service-advisories",
      maxAgeMinutes: 10080,
    },
  ],
});

const sampleProvider = makeTestProvider({
  alerts: [
    { type: "gtfs-rt", url: "https://example.test/alerts/subway?format=binary" },
    { type: "gtfs-rt", url: "https://example.test/alerts/streetcar?format=binary" },
    { type: "json", url: "https://example.test/live-alerts", parser: "generic-alert-feed" },
  ],
});
const sampleManifest = sampleProvider.manifest;

describe("validateProvider", () => {
  it("accepts a provider carrying only the mandatory regions", () => {
    const minimal: AgencyProvider = {
      manifest: sampleManifest,
      staticTopology: {},
      schematic: makeMinimalSchematic(),
    };
    expect(() => validateProvider(minimal)).not.toThrow();
  });

  it("accepts a provider without a schematic for mapless agencies", () => {
    const mapless: AgencyProvider = {
      manifest: sampleManifest,
      staticTopology: {},
      schematic: makeMinimalSchematic(),
    };
    delete (mapless as { schematic?: unknown }).schematic;
    expect(() => validateProvider(mapless)).not.toThrow();
  });

  it.each([
    {
      label: "manifest mode outside the vocabulary",
      mutate: (p: AgencyProvider): AgencyProvider => ({
        ...p,
        manifest: { ...p.manifest, modes: ["submarine" as (typeof p.manifest.modes)[number]] },
      }),
      section: "manifest",
    },
    {
      label: "realtime feed with an unknown wire format",
      mutate: (p: AgencyProvider): AgencyProvider => ({
        ...p,
        realtime: {
          feeds: [
            {
              kind: "trip_updates",
              url: "https://example.com/feed",
              format: "xml" as "json",
            },
          ],
        },
      }),
      section: "realtime.feeds[0]",
    },
    {
      label: "schematic viewport zoom outside numeric range",
      mutate: (p: AgencyProvider): AgencyProvider => ({
        ...p,
        schematic: {
          ...p.schematic!,
          viewport: {
            ...p.schematic!.viewport,
            minZoom: "free" as unknown as number,
          },
        },
      }),
      section: "schematic",
    },
    {
      label: "alert source with an unknown parser",
      mutate: (p: AgencyProvider): AgencyProvider => ({
        ...p,
        alerts: [
          {
            type: "json",
            url: "https://example.test/live-alerts",
            parser: "unknown" as "generic-alert-feed",
          },
        ],
      }),
      section: "alerts[0]",
    },
  ])("rejects a provider with $label", ({ mutate, section }) => {
    let message = "";
    try {
      validateProvider(mutate(sampleProvider));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(`"${sampleManifest.id}"`);
    expect(message).toContain(section);
  });
});

describe("registry fail-fast registration", () => {
  it("forwards proximity realtime filters through the declarative provider port", async () => {
    const provider = createAgencyProvider({
      manifest: {
        ...sampleManifestConfig,
        realtime: {
          feeds: [
            { kind: "vehicle_positions", url: "https://example.test/vehicles", format: "protobuf" },
            { kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" },
          ],
        },
      },
    });
    const tripBytes = concatBuffers(
      encodeFeedHeader(1_700_000_000),
      encodeSubwayTripUpdateEntity({
        entityId: "trip-501",
        routeId: "501",
        stopId: "stop-1",
        arrivalTimeSec: 1_700_000_300,
      }),
      encodeSubwayTripUpdateEntity({
        entityId: "trip-504",
        routeId: "504",
        stopId: "stop-1",
        arrivalTimeSec: 1_700_000_360,
      }),
    );
    const vehicleBytes = concatBuffers(
      encodeFeedHeader(1_700_000_000),
      encodeSurfaceVehiclePositionEntity({
        entityId: "vehicle-501",
        tripId: "trip-501",
        routeId: "501",
        latitude: 43.65,
        longitude: -79.38,
      }),
      encodeSurfaceVehiclePositionEntity({
        entityId: "vehicle-504",
        tripId: "trip-504",
        routeId: "504",
        latitude: 43.65,
        longitude: -79.38,
      }),
    );
    const fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const body = String(input).includes("vehicles") ? vehicleBytes : tripBytes;
      return new Response(
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
        { status: 200 },
      );
    };

    const source = provider.createRealtimeSource!({ fetch: fetch as typeof globalThis.fetch });
    const snapshot = await Effect.runPromise(
      source.fetchRealtime(
        { agencyId: "sample", generatedAt: 1, routes: [] },
        { routeIds: new Set(["501"]), stopIds: new Set(["stop-1"]) },
      ),
    );

    expect(snapshot.arrivals.map((arrival) => arrival.routeId)).toEqual(["501"]);
    expect(snapshot.vehicles.map((vehicle) => vehicle.routeId)).toEqual(["501"]);
  });

  it("loads every declared alert source for a multi-mode provider", async () => {
    const calls: string[] = [];
    const fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      calls.push(url);
      if (url.includes("live-alerts")) {
        return new Response(JSON.stringify({ routes: [], accessibility: [] }), { status: 200 });
      }
      return new Response(new Uint8Array(), { status: 200 });
    };

    await sampleProvider.snapshot?.get({
      fetch: fetch as typeof globalThis.fetch,
      now: () => 1_800_000_000_000,
    });

    expect(calls).toEqual(
      expect.arrayContaining([
        "https://example.test/alerts/subway?format=binary",
        "https://example.test/alerts/streetcar?format=binary",
        "https://example.test/live-alerts",
      ]),
    );
  });

  it("applies authentication declared on an alert source", async () => {
    const authenticatedProvider = jsonProvider;
    const headers: Headers[] = [];
    const calls: string[] = [];
    await authenticatedProvider.snapshot?.get({
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(String(input));
        headers.push(new Headers(init?.headers));
        return new Response(
          JSON.stringify({
            header: { gtfs_realtime_version: "2.0", timestamp: 0 },
            entity: [],
          }),
          { status: 200 },
        );
      }) as unknown as typeof globalThis.fetch,
      now: () => 1_800_000_000_000,
      getSecret: (name) => (name === "FEED_API_KEY" ? "alert-key" : undefined),
    });

    expect(calls).toEqual(
      expect.arrayContaining([
        "https://example.test/Gtfs/Feed/Alerts?key=alert-key",
        "https://example.test/UP/Gtfs/Feed/Alerts?key=alert-key",
      ]),
    );
    expect(headers[0]?.get("Accept")).toBe("application/json");
  });

  it("retries a transient alert-feed failure before rejecting the snapshot", async () => {
    const authenticatedProvider = jsonProvider;
    const attempts = new Map<string, number>();
    await authenticatedProvider.snapshot?.get({
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input);
        const count = (attempts.get(url) ?? 0) + 1;
        attempts.set(url, count);
        if (url.includes("/Gtfs/Feed/Alerts") && !url.includes("/UP/") && count === 1) {
          return new Response("temporary upstream failure", { status: 503 });
        }
        return new Response(
          JSON.stringify({
            header: { gtfs_realtime_version: "2.0", timestamp: 0 },
            entity: [],
          }),
          { status: 200 },
        );
      }) as unknown as typeof globalThis.fetch,
      now: () => 1_800_000_000_000,
      getSecret: (name) => (name === "FEED_API_KEY" ? "alert-key" : undefined),
    });

    const standardAlertsUrl = [...attempts.keys()].find(
      (url) => url.includes("/Gtfs/Feed/Alerts") && !url.includes("/UP/"),
    );
    expect(standardAlertsUrl).toBeDefined();
    expect(attempts.get(standardAlertsUrl!)).toBe(2);
  });

  it("does not retry a rate-limited alert feed", async () => {
    const authenticatedProvider = jsonProvider;
    const attempts = new Map<string, number>();

    await expect(
      authenticatedProvider.snapshot?.get({
        fetch: (async (input: RequestInfo | URL) => {
          const url = String(input);
          attempts.set(url, (attempts.get(url) ?? 0) + 1);
          return new Response("rate limited", { status: 429 });
        }) as unknown as typeof globalThis.fetch,
        now: () => 1_800_000_000_000,
        getSecret: (name) => (name === "FEED_API_KEY" ? "alert-key" : undefined),
      }),
    ).rejects.toThrow(/HTTP 429/);

    const standardAlertsUrl = [...attempts.keys()].find(
      (url) => url.includes("/Gtfs/Feed/Alerts") && !url.includes("/UP/"),
    );
    expect(standardAlertsUrl).toBeDefined();
    expect(attempts.get(standardAlertsUrl!)).toBe(1);
  });

  it("decodes a generic RSS alert source through the provider port", async () => {
    const provider = createAgencyProvider({
      manifest: {
        ...sampleManifestConfig,
        alerts: [
          {
            type: "rss",
            url: "https://alerts.example.test/rss",
            maxAgeMinutes: 24 * 60,
            routeIdsFromTitle: true,
          },
        ],
      },
    });
    const publishedAt = "Sat, 29 Aug 2026 10:00:00 GMT";
    const snapshot = await provider.snapshot!.get({
      fetch: (async () =>
        new Response(
          `<rss version="2.0"><channel><item><guid>alert-1</guid><title>Route 42 service advisory</title><description><![CDATA[Service is operating with a temporary change.]]></description><pubDate>${publishedAt}</pubDate></item></channel></rss>`,
          { status: 200 },
        )) as unknown as typeof globalThis.fetch,
      now: () => Date.parse("2026-08-29T12:00:00Z"),
    });

    expect(snapshot.alerts).toEqual([
      expect.objectContaining({
        id: "alert-1",
        title: "Route 42 service advisory",
        affectedRouteIds: ["42"],
        description: "Service is operating with a temporary change.",
        kind: "information",
        startsAt: Date.parse(publishedAt),
        endsAt: Date.parse(publishedAt) + 24 * 60 * 60 * 1000,
      }),
    ]);
  });

  it("handles namespaced Atom fields and explicit expiry without regex parsing", async () => {
    const provider = createAgencyProvider({
      manifest: {
        ...sampleManifestConfig,
        alerts: [
          {
            type: "rss",
            url: "https://alerts.example.test/atom",
            maxAgeMinutes: 60,
          },
        ],
      },
    });
    const snapshot = await provider.snapshot!.get({
      fetch: (async () =>
        new Response(
          `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
            <entry>
              <id>atom-1</id>
              <title>Route 7 advisory</title>
              <link rel="alternate" href="https://alerts.example.test/atom-1" />
              <summary>Temporary change &amp; detour.</summary>
              <published>2026-08-29T10:00:00Z</published>
              <expirationDate>2026-08-29T11:00:00Z</expirationDate>
            </entry>
          </feed>`,
          { status: 200 },
        )) as unknown as typeof globalThis.fetch,
      now: () => Date.parse("2026-08-29T12:00:00Z"),
    });

    expect(snapshot.alerts).toEqual([
      expect.objectContaining({
        id: "atom-1",
        title: "Route 7 advisory",
        description: "Temporary change & detour.",
        lifecycle: "expired",
        startsAt: Date.parse("2026-08-29T10:00:00Z"),
        endsAt: Date.parse("2026-08-29T11:00:00Z"),
      }),
    ]);
  });

  it("returns an unavailable empty snapshot when alerts are omitted", async () => {
    const provider = createAgencyProvider({
      manifest: { ...sampleManifestConfig, alerts: [] },
    });
    const snapshot = await provider.snapshot!.get({
      fetch: (() => {
        throw new Error("an alertless provider must not fetch");
      }) as unknown as typeof globalThis.fetch,
      now: () => 1_800_000_000_000,
    });

    expect(snapshot).toEqual({
      agencyId: "sample",
      generatedAt: 1_800_000_000_000,
      freshness: "unavailable",
      alerts: [],
    });
  });

  it("rejects a snapshot with an invalid generated timestamp", async () => {
    const provider = createAgencyProvider({
      manifest: { ...sampleManifestConfig, alerts: [] },
    });

    await expect(
      provider.snapshot!.get({
        fetch: (() => {
          throw new Error("an alertless provider must not fetch");
        }) as unknown as typeof globalThis.fetch,
        now: () => Number.NaN,
      }),
    ).rejects.toThrow("Normalized snapshot failed contract validation");
  });

  it("normalizes GHD service-advisory HTML into an upcoming route alert", async () => {
    const html = `
      <div id="blogContentContainer">
        <div class="blogItem">
          <div class="blogItem-contentContainer">
            <h2><a class="newsTitle" href="https://example.test/en/news/route-detour.aspx">Route 101 detour</a></h2>
            <div class="blogPostDate"><p>Posted on Tuesday, August 25, 2026 03:00 PM</p></div>
            <p><strong>When</strong>: Monday, August 31, 2026, to Friday, September 4, 2026, between 7 a.m. and 7 p.m.</p>
            <p><strong>Reason</strong>: Paving</p>
            <p><strong>Routes affected</strong>: 101 - Cross town</p>
            <p>Stops 9001, 9002, 9003, 9004 will not be serviced.</p>
          </div>
        </div>
      </div>`;
    const snapshot = await newsProvider.snapshot!.get({
      fetch: (async () =>
        new Response(html, { status: 200 })) as unknown as typeof globalThis.fetch,
      now: () => Date.parse("2026-08-29T12:00:00Z"),
    });

    expect(snapshot.alerts).toEqual([
      expect.objectContaining({
        id: "https://example.test/en/news/route-detour.aspx",
        title: "Route 101 detour",
        lifecycle: "upcoming",
        kind: "upcoming",
        affectedRouteIds: ["101"],
        startsAt: Date.UTC(2026, 7, 31, 11),
        endsAt: Date.UTC(2026, 8, 4, 23),
        affectedStations: [
          { stationName: "9001" },
          { stationName: "9002" },
          { stationName: "9003" },
          { stationName: "9004" },
        ],
      }),
    ]);
    expect(snapshot.alerts[0]?.description).toContain("Paving");
  });

  it("loads additional GHD advisory pages when the index is paginated", async () => {
    const firstPage = `
      <div class="blogItem"><div class="blogItem-contentContainer">
        <h2><a class="newsTitle" href="https://example.test/en/news/route-101.aspx">Route 101 detour</a></h2>
        <p><strong>Routes affected</strong>: 101</p>
      </div></div>
      <div class="pagination-container"><a href="/Modules/News/en/serviceadvisories?page=2">2</a></div>`;
    const secondPage = `
      <div class="blogItem"><div class="blogItem-contentContainer">
        <h2><a class="newsTitle" href="https://example.test/en/news/route-202.aspx">Route 202 detour</a></h2>
        <p><strong>Routes affected</strong>: 202</p>
      </div></div>`;
    const calls: string[] = [];
    const snapshot = await newsProvider.snapshot!.get({
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        return new Response(url.includes("page=2") ? secondPage : firstPage, { status: 200 });
      }) as unknown as typeof globalThis.fetch,
      now: () => Date.parse("2026-08-29T12:00:00Z"),
    });

    expect(calls).toEqual([
      "https://example.test/Modules/News/en/serviceadvisories",
      "https://example.test/Modules/News/en/serviceadvisories?page=2",
    ]);
    expect(snapshot.alerts.map((alert) => alert.affectedRouteIds)).toEqual([["101"], ["202"]]);
  });

  it("keeps all route mentions and structured detour meaning from nested GHD markup", async () => {
    const html = `
      <section class="blogItem">
        <div class="blogItem-contentContainer">
          <h2><a class="newsTitle" href="/en/news/82-valley.aspx"><span>82</span> – Valleymede</a></h2>
          <p><strong>Reason</strong>: Construction</p>
          <p><strong>Routes affected</strong>: 82 – Valleymede <strong>and</strong> 83A – Trench</p>
          <p><strong>Detour</strong>: Buses will use an alternate route.</p>
        </div>
      </section>`;

    const snapshot = await newsProvider.snapshot!.get({
      fetch: (async () =>
        new Response(html, { status: 200 })) as unknown as typeof globalThis.fetch,
      now: () => Date.parse("2026-08-29T12:00:00Z"),
    });

    expect(snapshot.alerts[0]).toEqual(
      expect.objectContaining({
        affectedRouteIds: ["82", "83A"],
        kind: "information",
        severity: "normal",
        serviceChange: "detour",
        description: expect.stringContaining("Construction"),
      }),
    );
  });

  /**
   * These vectors mirror `test_parse_standard_route_tokens` in
   * `services/alert-feed-daemon/src/util/text.rs`, which is the Rust counterpart
   * of this tokenizer and the authoritative side of the pair. The daemon renders
   * the same GHD module through `parse_standard_route_tokens`; the Core parser
   * must agree with it, so if these two ever disagree, the Rust expectation
   * wins and the TypeScript tokenizer is what gets corrected.
   */
  it.each([
    {
      case: "the shared route-token vector",
      routes: "101, 77A, and 202B / 303; Detour via a highway and a street",
      expected: ["101", "77A", "202B", "303"],
    },
    {
      case: "a slash-joined group inside a title",
      routes: "Route 101/202 detour - Sept. 25",
      expected: ["101", "202"],
    },
    {
      case: "a longer slash-joined group",
      routes: "Route 101/202/303 detour",
      expected: ["101", "202", "303"],
    },
    {
      case: "a bare number in prose",
      routes: "the 5 stops on a local street",
      expected: [],
    },
    {
      case: "a number after a roadway word",
      routes: "detour via a highway and a street",
      expected: [],
    },
  ])("tokenizes GHD routes: $case", async ({ routes, expected }) => {
    const snapshot = await routeIdsFromAdvisory(routes);

    expect(snapshot.alerts[0]?.affectedRouteIds ?? []).toEqual(expected);
  });

  it("expires an advisory the page never dates, so an unpruned archive cannot reach riders", async () => {
    // The module keeps every advisory it publishes, and these pages state no
    // period, so nothing but the declared max age retires a notice.
    const advisory = (title: string, postedOn: string) => `
      <div class="blogItem"><div class="blogItem-contentContainer">
        <h2><a class="newsTitle" href="/en/news/${title.replace(/\W+/g, "-")}.aspx">${title}</a></h2>
        <div class="blogPostDate"><p>Posted on ${postedOn}</p></div>
        <p>Stops 9001 will not be serviced.</p>
      </div></div>`;

    const now = Date.parse("2026-09-26T20:00:00Z");
    const snapshot = await newsProvider.snapshot!.get({
      fetch: (async () =>
        new Response(
          advisory("Route 101 stops closed", "September 22, 2026") +
            advisory("Advisory from a previous year", "January 9, 2024"),
          { status: 200 },
        )) as unknown as typeof fetch,
      now: () => now,
    });

    const byTitle = Object.fromEntries(
      snapshot.alerts.map((alert) => [alert.title, alert.lifecycle]),
    );
    expect(byTitle["Route 101 stops closed"]).toBe("active");
    expect(byTitle["Advisory from a previous year"]).toBe("expired");

    // The panel only renders active alerts, so the expired one is unreachable.
    expect(
      snapshot.alerts.filter((alert) => alert.lifecycle === "active").map((a) => a.title),
    ).toEqual(["Route 101 stops closed"]);
  });

  it("still prefers a stated end date over the source max age", async () => {
    const now = Date.parse("2026-08-29T12:00:00Z");
    const snapshot = await newsProvider.snapshot!.get({
      fetch: (async () =>
        new Response(
          `
          <div class="blogItem"><div class="blogItem-contentContainer">
            <h2><a class="newsTitle" href="https://example.test/en/news/route-detour.aspx">Route 101 detour</a></h2>
            <p><strong>When</strong>: Monday, August 31, 2026, to Friday, September 4, 2026, between 7 a.m. and 7 p.m.</p>
            <p><strong>Routes affected</strong>: 101</p>
          </div></div>`,
          { status: 200 },
        )) as unknown as typeof fetch,
      now: () => now,
    });

    expect(snapshot.alerts[0]).toEqual(
      expect.objectContaining({
        lifecycle: "upcoming",
        startsAt: Date.UTC(2026, 7, 31, 11),
        endsAt: Date.UTC(2026, 8, 4, 23),
      }),
    );
  });

  it("resolves a posting date in the declared zone, not the host zone", async () => {
    // The page publishes a wall clock with no offset. Resolving it against the
    // host's zone would shift every period by the host's offset, which is how the
    // two GHD parsers came to disagree. A zone the host is never in keeps
    // host-local parsing from passing by accident.
    const html = `
      <div class="blogItem"><div class="blogItem-contentContainer">
        <h2><a class="newsTitle" href="/en/news/a.aspx">Route 101 detour</a></h2>
        <div class="blogPostDate"><p>Posted on Tuesday, August 25, 2026 03:00 PM</p></div>
        <p><strong>Routes affected</strong>: 101</p>
      </div></div>`;

    const feed = await decodeGhdNewsServiceAdvisories({
      html,
      now: Date.parse("2026-09-26T20:00:00Z"),
      timeZone: "Asia/Tokyo",
      maxAgeMinutes: 10_080,
    });

    // 15:00 in Tokyo, which is UTC+9 all year.
    expect(new Date(feed.alerts[0]!.startsAt!).toISOString()).toBe("2026-08-25T06:00:00.000Z");
  });
});

/** Runs one advisory's "Routes affected" value through the real GHD parser. */
async function routeIdsFromAdvisory(routes: string) {
  const html = `
    <div class="blogItem"><div class="blogItem-contentContainer">
      <h2><a class="newsTitle" href="/en/news/advisory.aspx">Service advisory</a></h2>
      <p><strong>Routes affected</strong>: ${routes}</p>
    </div></div>`;
  return newsProvider.snapshot!.get({
    fetch: (async () => new Response(html, { status: 200 })) as unknown as typeof fetch,
    now: () => Date.parse("2026-09-26T12:00:00Z"),
  });
}

interface Violation {
  readonly providerId: string;
  readonly check: string;
  readonly detail: string;
}

const LADDER = ["normal", "degraded", "severe"] as const;

function ladderAlert(severity: (typeof LADDER)[number]): AgencyAlert {
  return {
    id: `conformance-${severity}`,
    kind: "delay",
    severity,
    lifecycle: "active",
    scope: "network",
    affectedLineIds: [],
    title: `synthetic ${severity} alert`,
    startsAt: 0,
    updatedAt: 0,
  };
}

function collectConformanceViolations(
  providers: readonly AgencyProvider[],
  deriveStatuses: typeof deriveLineStatuses = deriveLineStatuses,
): readonly Violation[] {
  const violations: Violation[] = [];
  const seenIds = new Set<string>();

  for (const provider of providers) {
    const id = provider.manifest.id;
    const record = (check: string, detail: string) =>
      violations.push({ providerId: id, check, detail });

    try {
      validateProvider(provider);
    } catch (error) {
      record("contract-validation", String(error));
    }

    if (seenIds.has(id)) {
      record("unique-agency-id", `"${id}" registered more than once`);
    }
    seenIds.add(id);

    const declaredLineIds = provider.schematic?.lines.map((line) => line.id) ?? [];

    if (provider.schematic) {
      try {
        const topology = buildMapModel(provider.schematic);
        const declared = new Set(declaredLineIds);

        for (const station of provider.schematic.stations) {
          for (const lineId of station.lines) {
            if (!declared.has(lineId)) {
              record(
                "schematic-compiles",
                `station "${station.name}" references undeclared line "${lineId}"`,
              );
            }
          }
        }

        if (topology.lineList.length !== provider.schematic.lines.length) {
          record("schematic-compiles", "compiled line list diverged from declaration");
        }
      } catch (error) {
        record("schematic-compiles", String(error));
      }
    }

    if (typeof provider.snapshot?.get !== "function") {
      record("snapshot-port", "alert-centric snapshot.get is not implemented");
    }

    if (provider.manifest.stationService && typeof provider.createStationsSource !== "function") {
      record("stations-source-port", "stationService agency declares no createStationsSource");
    }

    if (typeof provider.createTopologySource === "function") {
      const feeds = provider.staticTopology?.feeds ?? [];
      if (feeds.length === 0) {
        record(
          "topology-seeding-port",
          "provider with createTopologySource declares no staticTopology.feeds",
        );
      } else {
        for (const [idx, feed] of feeds.entries()) {
          if (!feed.url || !feed.url.startsWith("http")) {
            record(
              "topology-seeding-port",
              `feed[${idx}] has missing or invalid URL "${feed.url}"`,
            );
          }
        }
      }
    }

    const statuses = deriveStatuses(
      LADDER.map((severity) => ({
        ...ladderAlert(severity),
        affectedLineIds: declaredLineIds,
      })),
      declaredLineIds,
    );

    for (const lineId of declaredLineIds) {
      const status = statuses[lineId];
      if (!status) {
        record("severity-mapping-total", `no status derived for line "${lineId}"`);
      } else if (!LADDER.includes(status.severity as (typeof LADDER)[number])) {
        record("severity-mapping-total", `line "${lineId}" severity outside ladder`);
      }
    }
  }

  return violations;
}

describe("provider conformance kit", () => {
  const providers = allProviders();
  const validProvider = makeTestProvider({ id: "conformance-fixture" });
  const badSchematic = makeStationSchematic(["North", "South"], "R1");
  const providerWithUnlistedStationLine: Schematic = {
    ...badSchematic,
    stations: badSchematic.stations.map((station) => ({ ...station, lines: ["missing-line"] })),
  };
  const invalidManifest = {
    ...validProvider.manifest,
    status: "pending",
  } as unknown as AgencyProvider["manifest"];

  it.each([
    {
      check: "contract-validation",
      providers: [{ ...validProvider, manifest: invalidManifest }],
    },
    {
      check: "unique-agency-id",
      providers: [validProvider, validProvider],
    },
    {
      check: "schematic-compiles",
      providers: [{ ...validProvider, schematic: providerWithUnlistedStationLine }],
    },
    {
      check: "snapshot-port",
      providers: [{ ...validProvider, snapshot: undefined }],
    },
    {
      check: "stations-source-port",
      providers: [{ ...validProvider, createStationsSource: undefined }],
    },
    {
      check: "topology-seeding-port",
      providers: [
        {
          ...validProvider,
          staticTopology: { ...validProvider.staticTopology, feeds: [] },
        },
      ],
    },
    {
      check: "severity-mapping-total",
      providers: [validProvider],
      deriveStatuses: () => ({}),
    },
  ])("reports a broken provider for $check", ({ check, providers, deriveStatuses }) => {
    const violations = collectConformanceViolations(providers, deriveStatuses);

    expect(violations.map((violation) => violation.check)).toContain(check);
  });

  it("registered agency modules conform on every check", () => {
    expect(providers.length).toBeGreaterThan(0);
    expect(collectConformanceViolations(providers)).toEqual([]);
  });
});
