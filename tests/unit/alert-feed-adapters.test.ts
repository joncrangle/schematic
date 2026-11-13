import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import {
  alertError,
  alertFeedAdapters,
  AlertFetchError,
  combineAlertFeeds,
  type AlertFeedContext,
} from "~/infrastructure/realtime/alertFeedAdapters";
import type { DecodedFeed } from "~/infrastructure/realtime/gtfsRealtimeDecoder";
import type { AlertSource } from "~/agencies/types";
import { fetchDecodedFeeds } from "~/infrastructure/realtime/fetchDecodedFeeds";
import { DEFAULT_FETCH_ATTEMPTS } from "~/infrastructure/realtime/fetchDecodedFeeds";
import type { HostingTarget } from "~/infrastructure/env/hostingTarget";
import { createFakeConditionalCache } from "../helpers/fake-conditional-cache";
import { logger } from "~/infrastructure/logging/logger";
import {
  concatBuffers,
  encodeAlertEntity,
  encodeFeed,
  encodeSubwayTripUpdateEntity,
} from "../helpers/gtfs-rt-binary";

const NOW = 1_800_000_000_000;
const UNKNOWN_GHD_HTML = readFileSync(
  join(import.meta.dirname, "../fixtures/ghd-news/challenge-interstitial.html"),
  "utf8",
);

function makeDecodedFeed(
  version: string,
  timestamp: number,
  alertIds: readonly string[],
): DecodedFeed {
  return {
    header: { version, timestamp },
    tripUpdates: [],
    vehiclePositions: [],
    alerts: alertIds.map((id) => ({
      id,
      title: `Alert ${id}`,
      startsAt: timestamp,
      updatedAt: timestamp,
    })),
  };
}

describe("combineAlertFeeds (pure feed fold)", () => {
  it("takes the version from the first feed and the max timestamp", () => {
    const combined = combineAlertFeeds([
      makeDecodedFeed("2.0", NOW - 60_000, ["a"]),
      makeDecodedFeed("json", NOW, ["b"]),
    ]);

    expect(combined.header).toEqual({ version: "2.0", timestamp: NOW });
  });

  it("concatenates alerts in feed order with empty trip and vehicle sections", () => {
    const combined = combineAlertFeeds([
      makeDecodedFeed("2.0", NOW, ["a", "b"]),
      makeDecodedFeed("2.0", NOW, ["c"]),
    ]);

    expect(combined.alerts.map((alert) => alert.id)).toEqual(["a", "b", "c"]);
    expect(combined.tripUpdates).toEqual([]);
    expect(combined.vehiclePositions).toEqual([]);
  });

  it("documents the empty-input fold as an empty combined feed", () => {
    const combined = combineAlertFeeds([]);

    expect(combined.alerts).toEqual([]);
    expect(combined.header.timestamp).toBe(0);
  });
});

describe("alertFeedAdapters", () => {
  const textBytes = (text: string): Uint8Array => new TextEncoder().encode(text);
  type FeedRequest = Parameters<AlertFeedContext["fetchDecoded"]>[0];

  /** Stub kernel that executes the adapter's decode against canned bodies. */
  function passThroughCtx(
    bodies: Record<string, string>,
    captured: FeedRequest[] = [],
    hostingTarget?: HostingTarget,
  ): AlertFeedContext {
    const fetchDecoded = ((request: FeedRequest) => {
      captured.push(request);
      const body = bodies[request.url];
      if (body === undefined) {
        return Effect.succeed({
          usable: [],
          firstError: new AlertFetchError({
            agencyId: "test-agency",
            source: request.source,
            message: `No stubbed body for ${request.url}`,
          }),
        });
      }
      return request.decode(textBytes(body)).pipe(
        Effect.match({
          onFailure: (cause) => ({
            usable: [],
            firstError:
              cause instanceof AlertFetchError
                ? cause
                : new AlertFetchError({
                    agencyId: "test-agency",
                    source: request.source,
                    message: cause instanceof Error ? cause.message : String(cause),
                    cause,
                  }),
          }),
          onSuccess: (value) => ({ usable: [value] }),
        }),
      );
    }) as AlertFeedContext["fetchDecoded"];
    return {
      agencyId: "test-agency",
      now: () => NOW,
      timeZone: "America/Toronto",
      hostingTarget,
      fetchDecoded,
    };
  }

  it("decodes gtfs-rt protobuf bytes and surfaces format options", async () => {
    const captured: FeedRequest[] = [];
    const source: AlertSource = { type: "gtfs-rt", url: "https://feeds.example.test/alerts" };
    const bytes = encodeFeed(NOW / 1_000, []);

    const ctx: AlertFeedContext = {
      agencyId: "test-agency",
      now: () => NOW,
      timeZone: "America/Toronto",
      fetchDecoded: ((request: FeedRequest) => {
        captured.push(request);
        return request.decode(bytes).pipe(
          Effect.match({
            onFailure: (cause) => ({
              usable: [],
              firstError:
                cause instanceof AlertFetchError
                  ? cause
                  : alertError(ctx, request.source, String(cause), cause),
            }),
            onSuccess: (feed) => ({ usable: [feed] }),
          }),
        );
      }) as AlertFeedContext["fetchDecoded"],
    };

    const result = await Effect.runPromise(alertFeedAdapters["gtfs-rt"](source, ctx));

    expect(result.header.timestamp).toBe(NOW);
    expect(result.alerts).toEqual([]);
    expect(captured[0]).toMatchObject({
      url: "https://feeds.example.test/alerts",
      format: "protobuf",
      source: "https://feeds.example.test/alerts",
    });
  });

  it("keeps the alerts that decode past a malformed entity and logs the skip once", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const bytes = concatBuffers(
      encodeFeed(NOW / 1_000, [
        encodeAlertEntity({ id: "alert-ok", selectors: [{ routeId: "504" }], effect: 1 }),
      ]),
      new Uint8Array([0x12, 0x40, 0x0a]),
    );
    const source: AlertSource = { type: "gtfs-rt", url: "https://feeds.example.test/alerts" };
    const ctx: AlertFeedContext = {
      agencyId: "test-agency",
      now: () => NOW,
      timeZone: "America/Toronto",
      fetchDecoded: ((request: FeedRequest) =>
        request.decode(bytes).pipe(
          Effect.match({
            onFailure: (cause) => ({
              usable: [],
              firstError: alertError(ctx, request.source, String(cause), cause),
            }),
            onSuccess: (feed) => ({ usable: [feed] }),
          }),
        )) as AlertFeedContext["fetchDecoded"],
    };

    const result = await Effect.runPromise(alertFeedAdapters["gtfs-rt"](source, ctx));

    expect(result.alerts.map((alert) => alert.id)).toEqual(["alert-ok"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "test-agency alert feed skipped 1 malformed entities",
      expect.objectContaining({ source: "https://feeds.example.test/alerts" }),
    );
    warn.mockRestore();
  });

  it("uses Hamilton's explicit media type through the GTFS-RT alert adapter", async () => {
    const bytes = encodeFeed(NOW / 1_000, []);
    const observedAccepts: (string | null)[] = [];
    const fakeFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const accept = new Headers(init?.headers).get("Accept");
      observedAccepts.push(accept);
      if (accept === "application/x-protobuf") return new Response("unsupported", { status: 406 });
      return new Response(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        { status: 200 },
      );
    });
    const source: AlertSource = {
      type: "gtfs-rt",
      url: "https://feeds.example.test/hamilton-alerts",
      format: "protobuf",
      accept: "application/octet-stream",
    };
    const ctx: AlertFeedContext = {
      agencyId: "hamilton",
      now: () => NOW,
      timeZone: "America/Toronto",
      fetchDecoded: (request) =>
        fetchDecodedFeeds(
          [
            {
              ...request,
              mapError: (cause) =>
                alertError(
                  ctx,
                  request.source,
                  cause instanceof Error ? cause.message : String(cause),
                ),
            },
          ],
          { fetch: fakeFetch as unknown as typeof fetch },
        ),
    };

    const result = await Effect.runPromise(alertFeedAdapters[source.type](source, ctx));

    expect(result.alerts).toEqual([]);
    expect(observedAccepts).toEqual(["application/octet-stream"]);
  });
  it("decodes a json payload with the caller clock", async () => {
    const captured: FeedRequest[] = [];
    const ctx = passThroughCtx(
      {
        "https://feeds.example.test/json": JSON.stringify([
          { id: "j1", title: "Planned work", effect: "MODIFIED_SERVICE" },
        ]),
      },
      captured,
    );
    const result = await Effect.runPromise(
      alertFeedAdapters.json(
        {
          type: "json",
          url: "https://feeds.example.test/json",
          parser: "generic-alert-feed",
        },
        ctx,
      ),
    );

    expect(result.alerts).toEqual([
      expect.objectContaining({ id: "j1", title: "Planned work", startsAt: NOW }),
    ]);
    expect(captured[0]?.format).toBeUndefined();
  });

  it("threads maxAgeMinutes into rss expiry", async () => {
    const publishedAt = "Sat, 29 Aug 2026 10:00:00 GMT";
    const ctx = passThroughCtx({
      "https://alerts.example.test/rss": `<rss version="2.0"><channel><item><guid>alert-1</guid><title>Route service advisory</title><description>Temporary change.</description><pubDate>${publishedAt}</pubDate></item></channel></rss>`,
    });
    const result = await Effect.runPromise(
      alertFeedAdapters.rss(
        { type: "rss", url: "https://alerts.example.test/rss", maxAgeMinutes: 60 },
        ctx,
      ),
    );

    expect(result.alerts).toEqual([
      expect.objectContaining({
        id: "alert-1",
        endsAt: Date.parse(publishedAt) + 60 * 60 * 1_000,
      }),
    ]);
  });

  it("crawls paginated web pages and concatenates advisories in order", async () => {
    const indexUrl = "https://news.example.test/serviceadvisories";
    const captured: FeedRequest[] = [];
    const ctx = passThroughCtx(
      {
        [indexUrl]: `
          <div class="blogItem"><div class="blogItem-contentContainer">
            <h2><a class="newsTitle" href="https://news.example.test/news/route-1.aspx">Route 1</a></h2>
            <p><strong>Routes affected</strong>: Route 1</p>
          </div></div>
          <div class="pagination-container"><a href="/serviceadvisories?page=2">2</a></div>`,
        [`${indexUrl}?page=2`]: `
          <div class="blogItem"><div class="blogItem-contentContainer">
            <h2><a class="newsTitle" href="https://news.example.test/news/route-2.aspx">Route 2</a></h2>
            <p><strong>Routes affected</strong>: Route 2</p>
          </div></div>`,
      },
      captured,
    );

    const result = await Effect.runPromise(
      alertFeedAdapters.web(
        {
          type: "web",
          url: indexUrl,
          parser: "ghd-news-service-advisories",
          maxAgeMinutes: 4320,
        },
        ctx,
      ),
    );

    expect(captured.map((request) => request.url)).toEqual([indexUrl, `${indexUrl}?page=2`]);
    expect(result.alerts.map((alert) => alert.id)).toEqual([
      "https://news.example.test/news/route-1.aspx",
      "https://news.example.test/news/route-2.aspx",
    ]);
  });

  it("dispatches a service announcement board without inventing stop or route scope", async () => {
    const url = "https://service.example.test/announcements";
    const ctx = passThroughCtx({
      [url]: "<main><h2>Service Announcement</h2><p>Service will not stop at Central Stop during construction.</p></main>",
    });

    const result = await Effect.runPromise(
      alertFeedAdapters.web(
        {
          type: "web",
          url,
          parser: "service-announcement-board",
        },
        ctx,
      ),
    );

    expect(result.alerts).toEqual([
      expect.objectContaining({
        title: "Service will not stop at Central Stop during construction.",
        startsAt: 0,
        routeIds: [],
      }),
    ]);
    expect(result.alerts[0]).not.toHaveProperty("targets");
    expect(result.alerts[0]).not.toHaveProperty("affectedStations");
    expect(result.alerts[0]).not.toHaveProperty("effect");
  });

  it("serves an advisory once when a paginator links the page it is already on", async () => {
    // A paginator whose first link is `?page=1` re-requests the page the adapter
    // already read, which serves the same cards. Without de-duplication by id
    // every card on the page would appear twice on the board.
    const indexUrl = "https://news.example.test/serviceadvisories";
    const ctx = passThroughCtx({
      [indexUrl]: `
        <div class="blogItem"><div class="blogItem-contentContainer">
          <h2><a class="newsTitle" href="https://news.example.test/news/route-1.aspx">Route 1</a></h2>
          <p><strong>Routes affected</strong>: Route 1</p>
        </div></div>
        <div class="blogItem"><div class="blogItem-contentContainer">
          <h2><a class="newsTitle" href="https://news.example.test/news/route-2.aspx">Route 2</a></h2>
          <p><strong>Routes affected</strong>: Route 2</p>
        </div></div>
        <div class="pagination-container">
          <a href="/serviceadvisories?page=1">1</a>
          <a href="/serviceadvisories?page=2">2</a>
        </div>`,
      [`${indexUrl}?page=1`]: `
        <div class="blogItem"><div class="blogItem-contentContainer">
          <h2><a class="newsTitle" href="https://news.example.test/news/route-1.aspx">Route 1</a></h2>
          <p><strong>Routes affected</strong>: Route 1</p>
        </div></div>
        <div class="blogItem"><div class="blogItem-contentContainer">
          <h2><a class="newsTitle" href="https://news.example.test/news/route-2.aspx">Route 2</a></h2>
          <p><strong>Routes affected</strong>: Route 2</p>
        </div></div>`,
      [`${indexUrl}?page=2`]: `
        <div class="blogItem"><div class="blogItem-contentContainer">
          <h2><a class="newsTitle" href="https://news.example.test/news/route-3.aspx">Route 3</a></h2>
          <p><strong>Routes affected</strong>: Route 3</p>
        </div></div>`,
    });

    const result = await Effect.runPromise(
      alertFeedAdapters.web(
        { type: "web", url: indexUrl, parser: "ghd-news-service-advisories", maxAgeMinutes: 4320 },
        ctx,
      ),
    );

    // Each advisory appears once, and the first occurrence is the one kept, so
    // the order is the index page's cards followed by the genuinely new one.
    expect(result.alerts.map((alert) => alert.id)).toEqual([
      "https://news.example.test/news/route-1.aspx",
      "https://news.example.test/news/route-2.aspx",
      "https://news.example.test/news/route-3.aspx",
    ]);
  });

  it("threads timeZone into web advisory date interpretation", async () => {
    const ctx = passThroughCtx({
      "https://news.example.test/serviceadvisories": `
        <div id="blogContentContainer"><div class="blogItem"><div class="blogItem-contentContainer">
          <h2><a class="newsTitle" href="https://news.example.test/news/route-1.aspx">Route 1</a></h2>
          <div class="blogPostDate"><p>Posted on Tuesday, August 25, 2026 03:00 PM</p></div>
          <p><strong>When</strong>: Monday, August 31, 2026, to Friday, September 4, 2026, between 7 a.m. and 7 p.m.</p>
          <p><strong>Reason</strong>: Paving</p>
          <p><strong>Routes affected</strong>: Route 1</p>
        </div></div></div>`,
    });

    const result = await Effect.runPromise(
      alertFeedAdapters.web(
        {
          type: "web",
          url: "https://news.example.test/serviceadvisories",
          parser: "ghd-news-service-advisories",
          maxAgeMinutes: 4320,
        },
        ctx,
      ),
    );

    expect(result.alerts).toEqual([
      expect.objectContaining({
        id: "https://news.example.test/news/route-1.aspx",
        startsAt: Date.UTC(2026, 7, 31, 11),
        endsAt: Date.UTC(2026, 8, 4, 23),
      }),
    ]);
  });

  it("requests web advisories using rider locale, agency locale, then English fallbacks", async () => {
    const captured: FeedRequest[] = [];
    const url = "https://news.example.test/serviceadvisories";
    const ctx = {
      ...passThroughCtx(
        {
          [url]: readFileSync(
            join(import.meta.dirname, "../fixtures/ghd-news/govstack-empty-newsfeed.html"),
            "utf8",
          ),
        },
        captured,
      ),
      locale: "fr-CA" as const,
      agencyLocale: "en-CA",
    };

    await Effect.runPromise(
      alertFeedAdapters.web({ type: "web", url, parser: "ghd-news-service-advisories" }, ctx),
    );

    expect(new Headers(captured[0]?.headers).get("Accept-Language")).toBe(
      "fr-CA,fr;q=0.9,en-CA;q=0.8,en;q=0.7",
    );
  });

  it("keeps every fallback acceptable when a BCP-47 tag has many subtags", async () => {
    const captured: FeedRequest[] = [];
    const url = "https://news.example.test/serviceadvisories";
    await Effect.runPromise(
      alertFeedAdapters.web(
        { type: "web", url, parser: "ghd-news-service-advisories" },
        {
          ...passThroughCtx(
            {
              [url]: readFileSync(
                join(import.meta.dirname, "../fixtures/ghd-news/govstack-empty-newsfeed.html"),
                "utf8",
              ),
            },
            captured,
          ),
          locale: "fr-CA",
          agencyLocale: "de-abcde-fghij-klmno-pqrst-uvwxy-1234-5678-a-foo-b-bar-c-baz",
        },
      ),
    );
    const header = new Headers(captured[0]?.headers).get("Accept-Language")!;
    const qualities = [...header.matchAll(/;q=([^,]+)/g)].map((match) => match[1]!);
    expect(header).toContain("en-CA;q=");
    expect(qualities.length).toBeGreaterThan(10);
    expect(qualities.every((quality) => /^0\.\d{1,3}$/.test(quality) && Number(quality) > 0)).toBe(
      true,
    );
  });

  it.each([
    { type: "gtfs-rt" as const, url: "https://feeds.example.test/alerts" },
    {
      type: "json" as const,
      url: "https://feeds.example.test/json",
      parser: "generic-alert-feed" as const,
    },
    { type: "rss" as const, url: "https://alerts.example.test/rss", maxAgeMinutes: 60 },
  ])("surfaces transport failure with source URL for $type", async (source) => {
    const failure = new AlertFetchError({
      agencyId: "test-agency",
      source: source.url,
      message: "transport down",
    });
    const failCtx: AlertFeedContext = {
      ...passThroughCtx({}),
      fetchDecoded: (() =>
        Effect.succeed({ usable: [], firstError: failure })) as AlertFeedContext["fetchDecoded"],
    };
    const error = await Effect.runPromise(
      Effect.flip(alertFeedAdapters[source.type](source, failCtx)),
    );
    expect(error).toBe(failure);
  });

  it.each([
    {
      type: "gtfs-rt" as const,
      source: { type: "gtfs-rt" as const, url: "https://feeds.example.test/alerts" },
      body: new Uint8Array([255, 255, 255]),
    },
    {
      type: "json" as const,
      source: {
        type: "json" as const,
        url: "https://feeds.example.test/json",
        parser: "generic-alert-feed" as const,
      },
      body: textBytes("{ malformed json"),
    },
    {
      type: "rss" as const,
      source: {
        type: "rss" as const,
        url: "https://alerts.example.test/rss",
        maxAgeMinutes: 60,
      },
      body: textBytes("<invalid xml><not closed"),
    },
  ])(
    "maps malformed payload decode error to AlertFetchError for $type",
    async ({ source, body }) => {
      const ctx: AlertFeedContext = {
        agencyId: "test-agency",
        now: () => NOW,
        timeZone: "America/Toronto",
        fetchDecoded: ((request: FeedRequest) =>
          request.decode(body).pipe(
            Effect.match({
              onFailure: (cause) => ({
                usable: [],
                firstError:
                  cause instanceof AlertFetchError
                    ? cause
                    : alertError(ctx, request.source, String(cause), cause),
              }),
              onSuccess: (feed) => ({ usable: [feed] }),
            }),
          )) as AlertFeedContext["fetchDecoded"],
      };

      const error = await Effect.runPromise(
        Effect.flip(alertFeedAdapters[source.type](source, ctx)),
      );

      expect(error).toBeInstanceOf(AlertFetchError);
      expect(error.source).toBe(source.url);
    },
  );

  it("keeps the pages that read when one subpage does not, and says the feed is partial", async () => {
    // One unreadable page is that page's problem, not the board's: the cards the
    // other pages carry are real advisories, and discarding them would leave a
    // rider looking at an empty detour board because page 2 500'd. The feed is
    // flagged partial so the caller can present it as the short read it is.
    const indexUrl = "https://news.example.test/serviceadvisories";
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const ctx = passThroughCtx({
      [indexUrl]: `
        <div class="blogItem"><div class="blogItem-contentContainer">
          <h2><a class="newsTitle" href="https://news.example.test/news/route-1.aspx">Route 1</a></h2>
          <p><strong>Routes affected</strong>: Route 1</p>
        </div></div>
        <div class="pagination-container">
          <a href="/serviceadvisories?page=2">2</a>
          <a href="/serviceadvisories?page=3">3</a>
        </div>`,
      [`${indexUrl}?page=3`]: `
        <div class="blogItem"><div class="blogItem-contentContainer">
          <h2><a class="newsTitle" href="https://news.example.test/news/route-3.aspx">Route 3</a></h2>
          <p><strong>Routes affected</strong>: Route 3</p>
        </div></div>`,
    });

    try {
      const result = await Effect.runPromise(
        alertFeedAdapters.web(
          {
            type: "web",
            url: indexUrl,
            parser: "ghd-news-service-advisories",
            maxAgeMinutes: 4320,
          },
          ctx,
        ),
      );

      expect(result.alerts.map((alert) => alert.id)).toEqual([
        "https://news.example.test/news/route-1.aspx",
        "https://news.example.test/news/route-3.aspx",
      ]);
      expect(result.partial).toBe(true);
      // The page that failed is named by its path and nothing more: a query string
      // is where a credential or an operator filter would be written down. The
      // reason follows the dash and is whatever the transport already redacted.
      expect(warn).toHaveBeenCalledOnce();
      const [summary] = warn.mock.calls[0]![0]!.split(" — ");
      expect(summary).toContain(indexUrl);
      expect(summary).not.toContain("?");
    } finally {
      warn.mockRestore();
    }
  });

  it("charges failed pages against the Workers crawl ceiling", async () => {
    const url = "https://news.example.test/board";
    const card = '<div class="blogItem"><a class="newsTitle">Route 1</a></div>';
    const links = (...pages: number[]) =>
      '<div class="pagination-container">' +
      pages.map((page) => `<a href="?page=${page}">${page}</a>`).join("") +
      "</div>";
    const captured: FeedRequest[] = [];
    const ctx = passThroughCtx(
      {
        [url]: card + links(2, 3),
        [`${url}?page=2`]: card + links(4),
        [`${url}?page=4`]: card,
      },
      captured,
      "cloudflare",
    );
    const result = await Effect.runPromise(alertFeedAdapters.web(webSource(url), ctx));
    expect(captured.map((request) => request.url)).toEqual([url, `${url}?page=2`, `${url}?page=3`]);
    expect(result.partial).toBe(true);
  });

  it("fails the source when the first page does not read", async () => {
    // The one failure that must escalate: with no page read there is nothing to
    // show, and an empty board presented as a clean one is the false all-clear
    // the staleness plumbing exists to prevent.
    const indexUrl = "https://news.example.test/serviceadvisories";
    const ctx = passThroughCtx({});

    const error = await Effect.runPromise(
      Effect.flip(
        alertFeedAdapters.web(
          {
            type: "web",
            url: indexUrl,
            parser: "ghd-news-service-advisories",
            maxAgeMinutes: 4320,
          },
          ctx,
        ),
      ),
    );

    expect(error).toMatchObject({
      source: indexUrl,
      message: expect.stringContaining(`No stubbed body for ${indexUrl}`),
    });
  });

  it("fails the first page when HTTP 200 contains a challenge instead of a recognized board", async () => {
    const indexUrl = "https://news.example.test/serviceadvisories";
    const ctx = passThroughCtx({ [indexUrl]: UNKNOWN_GHD_HTML });

    const error = await Effect.runPromise(
      Effect.flip(
        alertFeedAdapters.web(
          {
            type: "web",
            url: indexUrl,
            parser: "ghd-news-service-advisories",
            maxAgeMinutes: 4320,
          },
          ctx,
        ),
      ),
    );

    expect(error).toBeInstanceOf(AlertFetchError);
    expect(error).toMatchObject({
      source: indexUrl,
      cause: {
        name: "UnsupportedGhdPageError",
        message: expect.stringContaining("Unsupported GHD advisory page"),
      },
    });
  });

  it.each([
    {
      name: "spends one attempt per slow page on Cloudflare",
      hostingTarget: "cloudflare" as const,
      expectedAttempts: [undefined, undefined, 1, 1],
    },
    {
      name: "keeps the full retry ladder for slow pages off Cloudflare",
      hostingTarget: undefined,
      expectedAttempts: [undefined, undefined, DEFAULT_FETCH_ATTEMPTS, DEFAULT_FETCH_ATTEMPTS],
    },
  ])("$name", async ({ hostingTarget, expectedAttempts }) => {
    // Fast feeds never declare attempts, so the kernel default owns them on
    // every target. Slow feeds declare the hosting-capped value instead.
    const captured: FeedRequest[] = [];
    const fetchDecoded = ((request: FeedRequest) => {
      captured.push(request);
      const decoded =
        request.url === "https://feeds.example.test/web"
          ? { feed: makeDecodedFeed("ghd", NOW, ["a"]), pageUrls: [] }
          : makeDecodedFeed("2.0", NOW, ["a"]);
      return Effect.succeed({ usable: [decoded] });
    }) as AlertFeedContext["fetchDecoded"];
    const ctx: AlertFeedContext = {
      agencyId: "test-agency",
      now: () => NOW,
      timeZone: "America/Toronto",
      hostingTarget,
      fetchDecoded,
    };

    await Effect.runPromise(
      alertFeedAdapters["gtfs-rt"](
        { type: "gtfs-rt", url: "https://feeds.example.test/gtfs" },
        ctx,
      ),
    );
    await Effect.runPromise(
      alertFeedAdapters.json(
        { type: "json", url: "https://feeds.example.test/json", parser: "generic-alert-feed" },
        ctx,
      ),
    );
    await Effect.runPromise(
      alertFeedAdapters.rss(
        { type: "rss", url: "https://feeds.example.test/rss", maxAgeMinutes: 60 },
        ctx,
      ),
    );
    await Effect.runPromise(
      alertFeedAdapters.web(
        {
          type: "web",
          url: "https://feeds.example.test/web",
          parser: "ghd-news-service-advisories",
        },
        ctx,
      ),
    );

    expect(captured.map((request) => request.url)).toEqual([
      "https://feeds.example.test/gtfs",
      "https://feeds.example.test/json",
      "https://feeds.example.test/rss",
      "https://feeds.example.test/web",
    ]);
    expect(captured.map((request) => request.attempts)).toEqual(expectedAttempts);
  });

  /** A board of chained next-links, one advisory per page. */
  function chainedBoard(indexUrl: string, pages: number): Record<string, string> {
    const card = (name: string) => `
      <div class="blogItem"><div class="blogItem-contentContainer">
        <h2><a class="newsTitle" href="https://news.example.test/news/${name}.aspx">${name}</a></h2>
        <p><strong>Routes affected</strong>: ${name}</p>
      </div></div>`;
    const bodies: Record<string, string> = {};
    for (let page = 1; page <= pages; page += 1) {
      const url = page === 1 ? indexUrl : `${indexUrl}?page=${page}`;
      const next =
        page < pages
          ? `<div class="pagination-container"><a href="/serviceadvisories?page=${page + 1}">${page + 1}</a></div>`
          : "";
      bodies[url] = `${card(`Route ${page}`)}${next}`;
    }
    return bodies;
  }

  const webSource = (url: string): AlertSource => ({
    type: "web",
    url,
    parser: "ghd-news-service-advisories",
    maxAgeMinutes: 4320,
  });

  it("caps a Cloudflare crawl at three pages and reports the cut as partial", async () => {
    const indexUrl = "https://news.example.test/serviceadvisories";
    const captured: FeedRequest[] = [];
    const ctx = passThroughCtx(chainedBoard(indexUrl, 5), captured, "cloudflare");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    try {
      const result = await Effect.runPromise(alertFeedAdapters.web(webSource(indexUrl), ctx));

      // Every page read cleanly, yet the board is longer than the ceiling: the
      // unread remainder makes this a short read, never a complete one.
      expect(captured.map((request) => request.url)).toEqual([
        indexUrl,
        `${indexUrl}?page=2`,
        `${indexUrl}?page=3`,
      ]);
      expect(result.alerts.map((alert) => alert.id)).toEqual([
        "https://news.example.test/news/Route 1.aspx",
        "https://news.example.test/news/Route 2.aspx",
        "https://news.example.test/news/Route 3.aspx",
      ]);
      expect(result.partial).toBe(true);
      // The cut is logged, not silent: agency, board, pages read vs unread.
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toContain("test-agency advisory crawl stopped");
      expect(warn.mock.calls[0]?.[0]).toContain("3-page ceiling");
      expect(warn.mock.calls[0]?.[0]).toContain(indexUrl);
      expect(warn.mock.calls[0]?.[0]).toContain("read 3");
    } finally {
      warn.mockRestore();
    }
  });

  it("reads the whole chain under the full self-hosted ceiling", async () => {
    const indexUrl = "https://news.example.test/serviceadvisories";
    const captured: FeedRequest[] = [];
    const ctx = passThroughCtx(chainedBoard(indexUrl, 5), captured);

    const result = await Effect.runPromise(alertFeedAdapters.web(webSource(indexUrl), ctx));

    expect(captured).toHaveLength(5);
    expect(result.alerts).toHaveLength(5);
    expect(result.partial).toBeUndefined();
  });

  it.each([
    {
      name: "bounds a wide level at two fetches on Cloudflare",
      hostingTarget: "cloudflare" as const,
      maxPeak: 2,
      maxSubpages: 2,
    },
    {
      name: "keeps the unbounded per-level fanout off Cloudflare",
      hostingTarget: undefined,
      maxPeak: 5,
      maxSubpages: 5,
    },
  ])("$name", async ({ hostingTarget, maxPeak, maxSubpages }) => {
    // Five subpages behind one level and a gate: the peak in-flight count is
    // the fanout the adapter actually allowed, and the fetched count is the
    // page ceiling cutting the level short.
    const indexUrl = "https://news.example.test/serviceadvisories";
    const subpages = [2, 3, 4, 5, 6].map((page) => `${indexUrl}?page=${page}`);
    const bodies: Record<string, string> = {
      [indexUrl]: `
        <div class="blogItem"><div class="blogItem-contentContainer">
          <h2><a class="newsTitle" href="https://news.example.test/news/Route 1.aspx">Route 1</a></h2>
          <p><strong>Routes affected</strong>: Route 1</p>
        </div></div>
        <div class="pagination-container">
          <a href="/serviceadvisories?page=2">2</a>
          <a href="/serviceadvisories?page=3">3</a>
          <a href="/serviceadvisories?page=4">4</a>
          <a href="/serviceadvisories?page=5">5</a>
          <a href="/serviceadvisories?page=6">6</a>
        </div>`,
    };
    for (const url of subpages) {
      bodies[url] = `
        <div class="blogItem"><div class="blogItem-contentContainer">
          <h2><a class="newsTitle" href="https://news.example.test/news/${url}.aspx">Sub</a></h2>
          <p><strong>Routes affected</strong>: Sub</p>
        </div></div>`;
    }
    const gate = { inFlight: 0, peak: 0 };
    const fetched: string[] = [];
    const fetchDecoded = ((request: FeedRequest) =>
      Effect.promise(async () => {
        fetched.push(request.url);
        gate.inFlight += 1;
        gate.peak = Math.max(gate.peak, gate.inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        gate.inFlight -= 1;
      }).pipe(
        Effect.flatMap(() => {
          const body = bodies[request.url];
          if (body === undefined) {
            return Effect.succeed({
              usable: [],
              firstError: new AlertFetchError({
                agencyId: "test-agency",
                source: request.source,
                message: `No stubbed body for ${request.url}`,
              }),
            });
          }
          return request.decode(new TextEncoder().encode(body)).pipe(
            Effect.match({
              onFailure: (cause) => ({
                usable: [],
                firstError:
                  cause instanceof AlertFetchError
                    ? cause
                    : new AlertFetchError({
                        agencyId: "test-agency",
                        source: request.source,
                        message: cause instanceof Error ? cause.message : String(cause),
                        cause,
                      }),
              }),
              onSuccess: (value) => ({ usable: [value] }),
            }),
          );
        }),
      )) as AlertFeedContext["fetchDecoded"];
    const ctx: AlertFeedContext = {
      agencyId: "test-agency",
      now: () => NOW,
      timeZone: "America/Toronto",
      hostingTarget,
      fetchDecoded,
    };

    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const result = await Effect.runPromise(alertFeedAdapters.web(webSource(indexUrl), ctx));

      expect(gate.peak).toBeLessThanOrEqual(maxPeak);
      expect(fetched.filter((url) => url !== indexUrl)).toHaveLength(maxSubpages);
      const usesUnboundedLocalPool = hostingTarget === undefined;
      expect(gate.peak).toBeGreaterThan(usesUnboundedLocalPool ? 2 : 0);
      expect(result.partial).toBe(usesUnboundedLocalPool ? undefined : true);
      expect(warn).toHaveBeenCalledTimes(usesUnboundedLocalPool ? 0 : 1);
    } finally {
      warn.mockRestore();
    }
  });

  it("fetches a diamond's shared child once and stays honest about the ceiling", async () => {
    // Two siblings sharing a child must not fetch it twice, on either
    // target. Off Cloudflare the whole diamond fits and reads complete;
    // on Cloudflare the shared child falls past the ceiling and the feed
    // is partial — one fetch per URL either way.
    const indexUrl = "https://news.example.test/serviceadvisories";
    const card = (name: string, links: readonly number[] = []) => `
      <div class="blogItem"><div class="blogItem-contentContainer">
        <h2><a class="newsTitle" href="https://news.example.test/news/${name}.aspx">${name}</a></h2>
        <p><strong>Routes affected</strong>: ${name}</p>
      </div></div>${
        links.length === 0
          ? ""
          : `<div class="pagination-container">${links.map((page) => `<a href="/serviceadvisories?page=${page}">${page}</a>`).join("")}</div>`
      }`;
    const bodies: Record<string, string> = {
      [indexUrl]: card("Route 1", [2, 3]),
      [`${indexUrl}?page=2`]: card("Route 2", [4]),
      [`${indexUrl}?page=3`]: card("Route 3", [4]),
      [`${indexUrl}?page=4`]: card("Route 4"),
    };
    const selfHostedCaptured: FeedRequest[] = [];
    const selfHosted = await Effect.runPromise(
      alertFeedAdapters.web(webSource(indexUrl), passThroughCtx(bodies, selfHostedCaptured)),
    );
    expect(selfHostedCaptured.map((request) => request.url).sort()).toEqual(
      [indexUrl, `${indexUrl}?page=2`, `${indexUrl}?page=3`, `${indexUrl}?page=4`].sort(),
    );
    expect(selfHosted.alerts).toHaveLength(4);
    expect(selfHosted.partial).toBeUndefined();

    const cappedCaptured: FeedRequest[] = [];
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const capped = await Effect.runPromise(
        alertFeedAdapters.web(
          webSource(indexUrl),
          passThroughCtx(bodies, cappedCaptured, "cloudflare"),
        ),
      );
      // Index plus two siblings fill the ceiling; the shared child is never
      // fetched, let alone twice, and the cut is reported partial.
      expect(cappedCaptured.map((request) => request.url).sort()).toEqual(
        [indexUrl, `${indexUrl}?page=2`, `${indexUrl}?page=3`].sort(),
      );
      expect(capped.alerts).toHaveLength(3);
      expect(capped.partial).toBe(true);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it("treats trailing-slash variants of a queued page as the same page", async () => {
    const indexUrl = "https://news.example.test/board";
    const captured: FeedRequest[] = [];
    const ctx = passThroughCtx(
      {
        [indexUrl]: `
          <div class="blogItem"><div class="blogItem-contentContainer">
            <h2><a class="newsTitle" href="https://news.example.test/news/route-1.aspx">Route 1</a></h2>
            <p><strong>Routes affected</strong>: Route 1</p>
          </div></div>
          <div class="pagination-container">
            <a href="/board/">self with slash</a>
            <a href="/board?page=2">2</a>
          </div>`,
        [`${indexUrl}?page=2`]: `
          <div class="blogItem"><div class="blogItem-contentContainer">
            <h2><a class="newsTitle" href="https://news.example.test/news/route-2.aspx">Route 2</a></h2>
            <p><strong>Routes affected</strong>: Route 2</p>
          </div></div>`,
      },
      captured,
      "cloudflare",
    );

    const result = await Effect.runPromise(alertFeedAdapters.web(webSource(indexUrl), ctx));

    // `/board/` canonicalizes to the already-read index: fetched once per
    // canonical page, and nothing is left unread to report.
    expect(captured.map((request) => request.url)).toEqual([indexUrl, `${indexUrl}?page=2`]);
    expect(result.alerts).toHaveLength(2);
    expect(result.partial).toBeUndefined();
  });

  describe("conditional fetch across feed types", () => {
    /**
     * Production wiring with an injectable store: the real kernel, the real
     * adapter decodes, and a scripted upstream answering 200+ETag then 304.
     * A 304 carries no body, so any decode work on the second poll has nothing
     * to decode and fails or empties the feed — success with identical alerts
     * proves zero decode work happened.
     */
    function conditionalKernelCtx(
      fetchImpl: typeof globalThis.fetch,
      cache: Cache,
      now: () => number,
    ): AlertFeedContext {
      return {
        agencyId: "test-agency",
        now,
        timeZone: "America/Toronto",
        hostingTarget: "cloudflare",
        fetchDecoded: (request) =>
          fetchDecodedFeeds(
            [
              {
                ...request,
                mapError: (cause) =>
                  cause instanceof AlertFetchError
                    ? cause
                    : alertError(
                        { agencyId: "test-agency" },
                        request.source,
                        cause instanceof Error ? cause.message : String(cause),
                        cause,
                      ),
              },
            ],
            {
              fetch: fetchImpl,
              attempts: request.attempts ?? DEFAULT_FETCH_ATTEMPTS,
              retryDelayMs: 0,
              conditionalStore: { cache, now },
            },
          ),
      };
    }

    function scriptedBoard(first: Response): {
      fetch: typeof fetch;
      secondSendsValidator: () => string | null;
    } {
      let calls = 0;
      let validator: string | null = null;
      const fetch: typeof globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        calls += 1;
        if (calls === 1) return first;
        validator = new Headers(init?.headers).get("If-None-Match");
        return new Response(null, { status: 304 });
      }) as typeof fetch;
      return { fetch, secondSendsValidator: () => validator };
    }

    it("reuses an unchanged gtfs-rt protobuf board without decoding", async () => {
      const fake = createFakeConditionalCache();
      const nowRef = { now: NOW };
      const bytes = encodeFeed(NOW / 1_000, [
        encodeSubwayTripUpdateEntity({
          entityId: "trip-keep",
          routeId: "501",
          stopId: "stop-keep",
          arrivalTimeSec: NOW / 1_000 + 300,
        }),
      ]);
      const body = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      const { fetch, secondSendsValidator } = scriptedBoard(
        new Response(body, { status: 200, headers: { ETag: '"pb-1"' } }),
      );
      const ctx = conditionalKernelCtx(fetch, fake.cache, () => nowRef.now);
      const source: AlertSource = { type: "gtfs-rt", url: "https://feeds.example.test/alerts" };

      const first = await Effect.runPromise(alertFeedAdapters["gtfs-rt"](source, ctx));
      expect(first.tripUpdates).toHaveLength(1);
      expect(first.header.timestamp).toBe(NOW);

      nowRef.now = NOW + 60_000;
      const second = await Effect.runPromise(alertFeedAdapters["gtfs-rt"](source, ctx));

      expect(secondSendsValidator()).toBe('"pb-1"');
      expect(second.tripUpdates).toEqual(first.tripUpdates);
      expect(second.header.timestamp).toBe(NOW);
    });

    it("keeps translated GTFS-RT JSON cache entries separate by rider locale", async () => {
      const fake = createFakeConditionalCache();
      const requestValidators: (string | null)[] = [];
      const body = JSON.stringify({
        header: { gtfs_realtime_version: "2.0", timestamp: NOW / 1_000 },
        entity: [
          {
            id: "translated-alert",
            alert: {
              header_text: {
                translation: [
                  { text: "Service disruption", language: "en" },
                  { text: "Perturbation du service", language: "fr" },
                ],
              },
              description_text: {
                translation: [
                  { text: "Service is disrupted", language: "en" },
                  { text: "Le service est perturbé", language: "fr" },
                ],
              },
            },
          },
        ],
      });
      const fetch: typeof globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        const validator = new Headers(init?.headers).get("If-None-Match");
        requestValidators.push(validator);
        if (validator !== null) return new Response(null, { status: 304 });
        return new Response(body, { status: 200, headers: { ETag: '"translated-1"' } });
      }) as typeof globalThis.fetch;
      const ctx = conditionalKernelCtx(fetch, fake.cache, () => NOW);
      const source: AlertSource = {
        type: "gtfs-rt",
        format: "json",
        url: "https://feeds.example.test/translated-alerts",
      };

      const english = await Effect.runPromise(
        alertFeedAdapters["gtfs-rt"](source, { ...ctx, locale: "en-CA" }),
      );
      const french = await Effect.runPromise(
        alertFeedAdapters["gtfs-rt"](source, { ...ctx, locale: "fr-CA" }),
      );
      const frenchReused = await Effect.runPromise(
        alertFeedAdapters["gtfs-rt"](source, { ...ctx, locale: "fr-CA" }),
      );

      expect(english.alerts[0]?.title).toBe("Service disruption");
      expect(french.alerts[0]?.title).toBe("Perturbation du service");
      expect(frenchReused.alerts[0]?.title).toBe("Perturbation du service");
      expect(requestValidators).toEqual([null, null, '"translated-1"']);
    });

    it("keeps translated GTFS-RT JSON cache entries separate by agency locale", async () => {
      const fake = createFakeConditionalCache();
      const requestValidators: (string | null)[] = [];
      const body = JSON.stringify({
        header: { gtfs_realtime_version: "2.0", timestamp: NOW / 1_000 },
        entity: [
          {
            id: "agency-language-alert",
            alert: {
              header_text: {
                translation: [
                  { text: "Panne de service", language: "fr" },
                  { text: "Interrupción del servicio", language: "es-MX" },
                ],
              },
            },
          },
        ],
      });
      const fetch: typeof globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        const validator = new Headers(init?.headers).get("If-None-Match");
        requestValidators.push(validator);
        if (validator !== null) return new Response(null, { status: 304 });
        return new Response(body, { status: 200, headers: { ETag: '"agency-language-1"' } });
      }) as typeof globalThis.fetch;
      const ctx = conditionalKernelCtx(fetch, fake.cache, () => NOW);
      const source: AlertSource = {
        type: "gtfs-rt",
        format: "json",
        url: "https://feeds.example.test/agency-language-alerts",
      };

      const frenchAgency = await Effect.runPromise(
        alertFeedAdapters["gtfs-rt"](source, {
          ...ctx,
          locale: "en-CA",
          agencyLocale: "fr-CA",
        }),
      );
      const spanishAgency = await Effect.runPromise(
        alertFeedAdapters["gtfs-rt"](source, {
          ...ctx,
          locale: "en-CA",
          agencyLocale: "es-MX",
        }),
      );
      const spanishAgencyReused = await Effect.runPromise(
        alertFeedAdapters["gtfs-rt"](source, {
          ...ctx,
          locale: "en-CA",
          agencyLocale: "es-MX",
        }),
      );

      expect(frenchAgency.alerts[0]?.title).toBe("Panne de service");
      expect(spanishAgency.alerts[0]?.title).toBe("Interrupción del servicio");
      expect(spanishAgencyReused.alerts[0]?.title).toBe("Interrupción del servicio");
      expect(requestValidators).toEqual([null, null, '"agency-language-1"']);
    });

    it("reuses an unchanged json board without decoding", async () => {
      const fake = createFakeConditionalCache();
      const nowRef = { now: NOW };
      const body = JSON.stringify([
        { id: "j1", title: "Planned work", effect: "MODIFIED_SERVICE" },
      ]);
      const { fetch, secondSendsValidator } = scriptedBoard(
        new Response(body, { status: 200, headers: { ETag: '"json-1"' } }),
      );
      const ctx = conditionalKernelCtx(fetch, fake.cache, () => nowRef.now);
      const source: AlertSource = {
        type: "json",
        url: "https://feeds.example.test/json",
        parser: "generic-alert-feed",
      };

      const first = await Effect.runPromise(alertFeedAdapters.json(source, ctx));
      expect(first.alerts.map((alert) => alert.id)).toEqual(["j1"]);
      expect(first.alerts[0]?.startsAt).toBe(NOW);

      nowRef.now = NOW + 60_000;
      const second = await Effect.runPromise(alertFeedAdapters.json(source, ctx));

      // The reused alerts keep their decoded instants: a re-decode would have
      // stamped the caller clock of the second poll.
      expect(secondSendsValidator()).toBe('"json-1"');
      expect(second.alerts).toEqual(first.alerts);
      expect(second.header.timestamp).toBe(NOW + 60_000);
    });

    it("reuses an unchanged rss board without decoding", async () => {
      const fake = createFakeConditionalCache();
      const nowRef = { now: NOW };
      const body = `<rss version="2.0"><channel><item><guid>alert-1</guid><title>Route service advisory</title><description>Temporary change.</description><pubDate>Sat, 29 Aug 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
      const { fetch, secondSendsValidator } = scriptedBoard(
        new Response(body, { status: 200, headers: { ETag: '"rss-1"' } }),
      );
      const ctx = conditionalKernelCtx(fetch, fake.cache, () => nowRef.now);
      const source: AlertSource = {
        type: "rss",
        url: "https://alerts.example.test/rss",
        expiryPolicy: "feed-presence",
      };

      const first = await Effect.runPromise(alertFeedAdapters.rss(source, ctx));
      expect(first.alerts.map((alert) => alert.id)).toEqual(["alert-1"]);

      nowRef.now = NOW + 60_000;
      const second = await Effect.runPromise(alertFeedAdapters.rss(source, ctx));

      expect(secondSendsValidator()).toBe('"rss-1"');
      expect(second.alerts).toEqual(first.alerts);
      expect(second.header.timestamp).toBe(NOW + 60_000);
    });

    it("reuses an unchanged web board without decoding any page", async () => {
      const fake = createFakeConditionalCache();
      const nowRef = { now: NOW };
      const indexUrl = "https://news.example.test/serviceadvisories";
      const body = `
        <div class="blogItem"><div class="blogItem-contentContainer">
          <h2><a class="newsTitle" href="https://news.example.test/news/route-1.aspx">Route 1</a></h2>
          <p><strong>Routes affected</strong>: Route 1</p>
        </div></div>`;
      const { fetch, secondSendsValidator } = scriptedBoard(
        new Response(body, { status: 200, headers: { ETag: '"web-1"' } }),
      );
      const ctx = conditionalKernelCtx(fetch, fake.cache, () => nowRef.now);

      const first = await Effect.runPromise(alertFeedAdapters.web(webSource(indexUrl), ctx));
      expect(first.alerts.map((alert) => alert.id)).toEqual([
        "https://news.example.test/news/route-1.aspx",
      ]);
      expect(first.alerts[0]?.startsAt).toBe(NOW);

      nowRef.now = NOW + 60_000;
      const second = await Effect.runPromise(alertFeedAdapters.web(webSource(indexUrl), ctx));

      expect(secondSendsValidator()).toBe('"web-1"');
      expect(second.alerts).toEqual(first.alerts);
      expect(second.header.timestamp).toBe(NOW + 60_000);
    });
  });
});
