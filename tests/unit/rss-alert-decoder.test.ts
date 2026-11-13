import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeRssAlertFeed } from "~/infrastructure/realtime/rssAlertDecoder";

const NOW = 1_750_000_000_000;
const PUBLISHED_AT = "Sat, 29 Aug 2026 10:00:00 GMT";

function rssItem(inner: string): string {
  return `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item><guid>alert-1</guid><pubDate>${PUBLISHED_AT}</pubDate>${inner}</item></channel></rss>`;
}

function decode(xml: string) {
  return decodeRssAlertFeed(xml, { now: NOW, maxAgeMinutes: 60 });
}

describe("decodeRssAlertFeed HTML stripping", () => {
  const fixtureDirectory = join(import.meta.dirname, "../fixtures/rss-proxy");
  const contract: { valid: string[]; invalid: string[] } = JSON.parse(
    readFileSync(join(fixtureDirectory, "contract.json"), "utf8"),
  );
  it.each(contract.invalid)("rejects incomplete or unsupported RSS documents: %s", (file) => {
    expect(() => decode(readFileSync(join(fixtureDirectory, file), "utf8"))).toThrow();
  });
  it.each(contract.valid)("accepts the shared forwarding contract: %s", (file) => {
    const feed = decode(readFileSync(join(fixtureDirectory, file), "utf8"));
    expect(feed.header.version).toBe("rss");
    expect(feed.partial).toBeUndefined();
  });
  it("keeps feed-present postings active regardless of age while honoring explicit expiry", () => {
    const xml = `<rss><channel>
      <item><title>Standing notice</title><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
      <item><title>Ended notice</title><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate><endDate>Tue, 02 Jan 2024 00:00:00 GMT</endDate></item>
    </channel></rss>`;
    const feed = decodeRssAlertFeed(xml, { now: NOW, expiryPolicy: "feed-presence" });
    expect(feed.alerts[0]?.endsAt).toBeUndefined();
    expect(feed.alerts[1]?.endsAt).toBe(Date.parse("2024-01-02T00:00:00Z"));
  });

  it.each([
    ["without a publication date", ""],
    ["with a publication date after expiry", "<pubDate>Wed, 01 Jan 2025 00:00:00 GMT</pubDate>"],
  ])("keeps an expired end when the start is inferred %s", (_label, publication) => {
    const end = Date.parse("Tue, 02 Jan 2024 00:00:00 GMT");
    const xml = `<rss><channel><item><title>Expired notice</title>${publication}<endDate>Tue, 02 Jan 2024 00:00:00 GMT</endDate></item></channel></rss>`;
    const alert = decodeRssAlertFeed(xml, { now: NOW, expiryPolicy: "feed-presence" }).alerts[0];

    expect(alert).toMatchObject({ startsAt: end, endsAt: end });
  });

  it("drops an explicit end that precedes an explicit start", () => {
    const startsAt = Date.parse("2026-10-14T14:00:00Z");
    const xml = `<rss><channel><item><title>Planned notice</title><startDate>2026-10-14T14:00:00Z</startDate><endDate>2020-01-01T00:00:00Z</endDate></item></channel></rss>`;
    const alert = decodeRssAlertFeed(xml, { now: NOW, expiryPolicy: "feed-presence" }).alerts[0];

    expect(alert?.startsAt).toBe(startsAt);
    expect(alert?.endsAt).toBeUndefined();
  });

  it("builds stable fallback ids from source scope and article content", () => {
    const xml = "<rss><channel><item><title>Unnumbered notice</title></item></channel></rss>";
    const decodeFor = (sourceScope: string, now = NOW) =>
      decodeRssAlertFeed(xml, { now, expiryPolicy: "feed-presence", sourceScope });

    const first = decodeFor("https://sample.test/news-a").alerts[0];
    const sameSource = decodeFor("https://sample.test/news-a").alerts[0];
    const sameSourceLater = decodeFor("https://sample.test/news-a", NOW + 60_000).alerts[0];
    const otherSource = decodeFor("https://sample.test/news-b").alerts[0];

    expect(first?.id).toMatch(/^rss-alert-[0-9a-f]{16}$/u);
    expect(sameSource?.id).toBe(first?.id);
    expect(sameSourceLater?.id).toBe(first?.id);
    expect(otherSource?.id).not.toBe(first?.id);
  });

  it("extracts the same declared incident identity from translated RSS links", () => {
    const pattern = "/articles/(\\d+)(?:[/?#]|$)";
    const english = decodeRssAlertFeed(
      readFileSync(join(fixtureDirectory, "issue326-english.xml"), "utf8"),
      {
        now: NOW,
        expiryPolicy: "feed-presence",
        incidentIdentityPattern: pattern,
        incidentIdentityNamespace: "service-updates",
      },
    );
    const french = decodeRssAlertFeed(
      readFileSync(join(fixtureDirectory, "issue326-french.xml"), "utf8"),
      {
        now: NOW,
        expiryPolicy: "feed-presence",
        incidentIdentityPattern: pattern,
        incidentIdentityNamespace: "service-updates",
      },
    );

    expect(english.alerts[0]?.id).not.toBe(french.alerts[0]?.id);
    expect(english.alerts[0]?.incidentIdentity).toEqual({
      namespace: "service-updates",
      value: "1042",
    });
    expect(french.alerts[0]?.incidentIdentity).toEqual(english.alerts[0]?.incidentIdentity);
  });

  it("uses declared category route metadata before title fallback, including leading route titles", () => {
    const xml = `<rss><channel>
      <item><title>Detour: 42 East</title><category>Detours</category><category>routes-42, 43</category></item>
      <item><title>44B Central : Cancelled trip</title></item>
    </channel></rss>`;
    const feed = decodeRssAlertFeed(xml, {
      now: NOW,
      maxAgeMinutes: 60,
      routeCategoryPrefix: "routes-",
      routeIdsFromTitle: true,
    });
    expect(feed.alerts.map((alert) => alert.routeIds)).toEqual([["42", "43"], ["44B"]]);
    expect(feed.alerts[0]?.sourceFields).toMatchObject({ rssCategory: "Detours" });
  });
  it("attributes only explicit route and line lists in titles when requested", () => {
    const feed = decodeRssAlertFeed(
      rssItem(
        `<title>Detour: Routes 42, 43 and 44B near Highway 417</title><description>Stop 9001 closed on October 7.</description>`,
      ),
      { now: NOW, maxAgeMinutes: 60, routeIdsFromTitle: true },
    );
    expect(feed.alerts[0]?.routeIds).toEqual(["42", "43", "44B"]);
  });

  it("reads explicit French circuit and itinerary lists without treating incidental numbers as routes", () => {
    const feed = decodeRssAlertFeed(
      `<rss><channel>
        <item><title>Déviation : Circuits 11, 57, 58, 81 et 691 en direction est</title></item>
        <item><title>Déviation : Itinéraire 162 et 163 pendant les travaux</title></item>
        <item><title>Service de bus affecté: Centre-ville 417</title></item>
      </channel></rss>`,
      { now: NOW, expiryPolicy: "feed-presence", routeIdsFromTitle: true },
    );

    expect(feed.alerts.map((alert) => alert.routeIds)).toEqual([
      ["11", "57", "58", "81", "691"],
      ["162", "163"],
      undefined,
    ]);
  });

  it.each([
    { field: "description" },
    { field: "content:encoded" },
    { field: "summary" },
    { field: "content" },
  ])("strips OC Transpo-shaped CMS HTML from $field into plain text", ({ field }) => {
    const feed = decode(
      rssItem(
        `<title>Route 75 detour</title><${field}><![CDATA[<div><p>First paragraph.</p><p>Second &amp; paragraph<br/>with break.</p></div>]]></${field}>`,
      ),
    );

    expect(feed.alerts[0]?.description).toBe("First paragraph.\nSecond & paragraph\nwith break.");
    expect(feed.alerts[0]?.description).not.toContain("<");
  });

  it("strips markup from the title while keeping the entry", () => {
    const feed = decode(
      rssItem(
        `<title><![CDATA[<strong>Route 75</strong> detour]]></title><description>Planned work.</description>`,
      ),
    );

    expect(feed.alerts[0]?.title).toBe("Route 75 detour");
    expect(feed.alerts[0]?.title).not.toContain("<");
  });

  it("omits embedded stylesheet and script contents from rider text", () => {
    const feed = decode(
      rssItem(
        `<title>Route 42 diversion</title><description><![CDATA[<style>.detour { color: red; }</style><p>We&rsquo;ve moved the stop &ndash; use platform B.</p><script>track('read');</script>]]></description>`,
      ),
    );

    expect(feed.alerts[0]?.description).toBe("We’ve moved the stop – use platform B.");
  });

  it("strips escaped CMS HTML and decodes entities", () => {
    const feed = decode(
      rssItem(
        `<title>Detour &amp; delays</title><description>&lt;p&gt;Stop closed &amp;amp; relocated.&lt;br/&gt;See details.&lt;/p&gt;</description>`,
      ),
    );

    expect(feed.alerts[0]?.title).toBe("Detour & delays");
    expect(feed.alerts[0]?.description).toBe("Stop closed & relocated.\nSee details.");
    expect(feed.alerts[0]?.description).not.toContain("<");
  });

  it("rejects title-less entries instead of proving an empty feed", () => {
    expect(() =>
      decode(
        rssItem(
          `<description><![CDATA[<p><strong>Lifted title</strong> body text.</p>]]></description>`,
        ),
      ),
    ).toThrow();
  });

  it("passes plain-text titles and descriptions through whitespace-normalized", () => {
    const feed = decode(
      rssItem(
        `<title>  Route   service   advisory </title><description>Temporary change.</description>`,
      ),
    );

    expect(feed.alerts[0]?.title).toBe("Route service advisory");
    expect(feed.alerts[0]?.description).toBe("Temporary change.");
  });
});
