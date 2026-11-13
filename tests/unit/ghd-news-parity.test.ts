import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { extractGhdPageWithParse5 } from "~/infrastructure/realtime/ghdNewsServiceAdvisoriesParse5Extractor";
import {
  decodeGhdNewsServiceAdvisories,
  decodeGhdPage,
} from "~/infrastructure/realtime/ghdNewsServiceAdvisoriesParser";
import type { DecodedFeed } from "~/infrastructure/realtime/gtfsRealtimeDecoder";

/**
 * Recorded GHD Digital advisory pages, shared with the alert-feed daemon.
 *
 * `contract.json` is the one expectation both implementations must satisfy: the
 * Rust suite (`services/alert-feed-daemon/src/parsers/ghd_news.rs`) reads the
 * same three files and the same contract, so a template or rule change that
 * lands in one language and not the other fails CI instead of drifting. These
 * are trimmed copies of the live pages, byte for byte as the operators served
 * them on 2026-09-28; the README in this directory records the source URLs.
 */

const FIXTURE_DIR = join(import.meta.dirname, "../fixtures/ghd-news");

interface ParityAlert {
  readonly id: string;
  readonly title: string;
  readonly routeIds: readonly string[];
  readonly stopIds: readonly string[];
  /** The GTFS-RT effect name, or null when the decoder states none. */
  readonly effect: string | null;
  readonly startsAt: number;
  readonly endsAt: number;
}

interface ParityVariant {
  readonly file: string;
  /**
   * The age the agency that publishes this page actually ships, or `null` when
   * it ships none. One policy per operator, so the contract asserts what is
   * deployed rather than one age that suits nobody.
   */
  readonly maxAgeMinutes: number | null;
  /** Names items that carry no link of their own, so it is part of their identity. */
  readonly pageUrl?: string;
  readonly alerts: readonly ParityAlert[];
}

interface ParityContract {
  readonly timeZone: string;
  /** The fixed clock both implementations decode against, in epoch milliseconds. */
  readonly now: number;
  readonly recognizedEmptyPages: readonly string[];
  readonly unsupportedPages: readonly string[];
  readonly variants: readonly ParityVariant[];
  /** The accordion board decoded at several clocks, pinning its yearless-date rule. */
  readonly accordionClocks: {
    readonly file: string;
    readonly pageUrl: string;
    readonly clocks: readonly { readonly now: number; readonly alerts: readonly ParityAlert[] }[];
  };
}

const contract = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "contract.json"), "utf8"),
) as ParityContract;

/**
 * A fixed clock, so nothing in the expectation can drift with the wall clock. It
 * sits after the newest posting date in these fixtures, which is what makes
 * "anchored to the posting date, not to now" a checkable claim.
 */
const NOW = contract.now;
const SOURCE_URL = "https://example.test/news/service-alerts/";

let worker: Miniflare;
let workerDirectory: string;

beforeAll(async () => {
  workerDirectory = mkdtempSync(join(tmpdir(), "ttc-ghd-rewriter-"));
  const workerEntry = join(workerDirectory, "worker.mjs");
  const source = resolve(
    import.meta.dirname,
    "../../src/infrastructure/realtime/ghdNewsServiceAdvisoriesParser.ts",
  );
  const extractor = resolve(
    import.meta.dirname,
    "../../src/infrastructure/realtime/ghdNewsServiceAdvisoriesHtmlRewriterExtractor.ts",
  );
  const workerSource = `
    import { decodeGhdPage } from ${JSON.stringify(source)};
    import { extractGhdPageWithHTMLRewriter } from ${JSON.stringify(extractor)};
    export default {
      async fetch(request) {
        const input = await request.json();
        if (input.mode === "chunked-extraction") {
          const extracted = await extractGhdPageWithHTMLRewriter(input.html, { inputChunkBytes: 3 });
          return Response.json(extracted);
        }
        try {
          const decoded = await decodeGhdPage({ ...input, hostingTarget: "cloudflare" });
          return Response.json({ ...decoded, parse5Loaded: globalThis.__ghdParse5ExtractorLoaded === true });
        } catch (error) {
          return Response.json({ name: error?.name, message: error?.message }, { status: 422 });
        }
      }
    };
  `;
  await build({
    stdin: {
      contents: workerSource,
      resolveDir: process.cwd(),
      sourcefile: "ghd-worker.ts",
      loader: "ts",
    },
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "esm",
    outfile: workerEntry,
    plugins: [
      {
        name: "track-parse5-reference-load",
        setup(build) {
          build.onLoad({ filter: /ghdNewsServiceAdvisoriesParse5Extractor\.ts$/ }, () => ({
            contents: `
              globalThis.__ghdParse5ExtractorLoaded = true;
              export function extractGhdPageWithParse5() {
                throw new Error("Cloudflare decode loaded the parse5 reference extractor");
              }
            `,
            loader: "ts",
          }));
        },
      },
    ],
  });
  worker = new Miniflare(
    convertV4MiniflareOptions({
      script: readFileSync(workerEntry, "utf8"),
      modules: true,
      compatibilityDate: "2026-10-01",
    }),
  );
});

afterAll(async () => {
  await worker?.dispose();
  if (workerDirectory) rmSync(workerDirectory, { recursive: true, force: true });
});

async function decodeFixture(
  variant: ParityVariant,
  hostingTarget: "self-hosted" | "cloudflare" = "self-hosted",
): Promise<readonly ParityAlert[]> {
  const html = readFileSync(join(FIXTURE_DIR, variant.file), "utf8");
  const feed =
    hostingTarget === "self-hosted"
      ? await decodeGhdNewsServiceAdvisories({
          html,
          now: NOW,
          timeZone: contract.timeZone,
          maxAgeMinutes: variant.maxAgeMinutes ?? undefined,
          pageUrl: variant.pageUrl,
        })
      : await decodeGhdPage({
          html,
          hostingTarget,
          pageUrl: variant.pageUrl ?? SOURCE_URL,
          now: NOW,
          timeZone: contract.timeZone,
          maxAgeMinutes: variant.maxAgeMinutes ?? undefined,
        }).then((result) => result.feed);
  return feed.alerts.map((alert) => ({
    id: alert.id,
    title: alert.title.replace(/\s+/gu, " ").trim(),
    routeIds: alert.routeIds ?? [],
    stopIds: alert.affectedStations ?? [],
    effect: alert.effect === undefined ? null : String(alert.effect),
    startsAt: alert.startsAt,
    endsAt: alert.endsAt ?? 0,
  }));
}

async function decodeFixtureInWorkers(variant: ParityVariant): Promise<{
  readonly feed: DecodedFeed;
  readonly pageUrls: readonly string[];
  readonly parse5Loaded: boolean;
}> {
  const response = await worker.dispatchFetch("https://worker.test/decode", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      html: readFileSync(join(FIXTURE_DIR, variant.file), "utf8"),
      pageUrl: variant.pageUrl ?? SOURCE_URL,
      now: NOW,
      timeZone: contract.timeZone,
      maxAgeMinutes: variant.maxAgeMinutes ?? undefined,
    }),
  });
  if (!response.ok)
    throw new Error(`Miniflare GHD decode failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as {
    readonly feed: DecodedFeed;
    readonly pageUrls: readonly string[];
    readonly parse5Loaded: boolean;
  };
}

function parityProjection(feed: DecodedFeed): readonly ParityAlert[] {
  return feed.alerts.map((alert) => ({
    id: alert.id,
    title: alert.title.replace(/\s+/gu, " ").trim(),
    routeIds: alert.routeIds ?? [],
    stopIds: alert.affectedStations ?? [],
    effect: alert.effect === undefined ? null : String(alert.effect),
    startsAt: alert.startsAt,
    endsAt: alert.endsAt ?? 0,
  }));
}

describe("GHD Digital advisory parity", () => {
  it("still rejects an invalid zone while choosing default years", async () => {
    const html = readFileSync(join(FIXTURE_DIR, contract.variants[0]!.file), "utf8");
    await expect(
      decodeGhdNewsServiceAdvisories({ html, now: NOW, timeZone: "Invalid/Zone" }),
    ).rejects.toThrow(RangeError);
  });

  it.each(contract.recognizedEmptyPages)(
    "accepts only the verified empty news-feed state from %s",
    async (file) => {
      const html = readFileSync(join(FIXTURE_DIR, file), "utf8");
      const reference = await decodeGhdPage({
        html,
        hostingTarget: "self-hosted",
        pageUrl: SOURCE_URL,
        now: NOW,
        timeZone: contract.timeZone,
      });

      expect(reference.feed.alerts).toEqual([]);
      expect(reference.pageUrls).toEqual([]);

      const response = await worker.dispatchFetch("https://worker.test/decode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          html,
          pageUrl: SOURCE_URL,
          now: NOW,
          timeZone: contract.timeZone,
        }),
      });
      expect(response.status).toBe(200);
      const streamed = (await response.json()) as {
        readonly feed: DecodedFeed;
        readonly pageUrls: readonly string[];
        readonly parse5Loaded: boolean;
      };
      expect(streamed.feed.alerts).toEqual([]);
      expect(streamed.pageUrls).toEqual([]);
      expect(streamed.parse5Loaded).toBe(false);
    },
  );

  it.each(contract.unsupportedPages)(
    "rejects unknown 200 HTML instead of returning an all-clear: %s",
    async (file) => {
      const html = readFileSync(join(FIXTURE_DIR, file), "utf8");
      await expect(
        decodeGhdNewsServiceAdvisories({ html, now: NOW, timeZone: contract.timeZone }),
      ).rejects.toThrow("Unsupported GHD advisory page");

      const response = await worker.dispatchFetch("https://worker.test/decode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          html,
          pageUrl: SOURCE_URL,
          now: NOW,
          timeZone: contract.timeZone,
        }),
      });
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        name: "UnsupportedGhdPageError",
        message: expect.stringContaining("Unsupported GHD advisory page"),
      });
    },
  );

  it("keeps stylesheet and script contents out of the advisory description", async () => {
    const html = `<li class="gs-feed-list-item">
      <a class="gs-feed-list-title" href="/news/posts/diversion.aspx">Detour - Route 407</a>
      <span class="gs-feed-list-description"><style>.detour { color: red; }</style><p>We&rsquo;ve moved the stop &ndash; use platform B.</p><script>track('read');</script></span>
      <span class="gs-feed-list-date">September 28, 2026</span>
    </li>`;
    const feed = await decodeGhdNewsServiceAdvisories({
      html,
      now: NOW,
      timeZone: "America/Toronto",
    });
    expect(feed.alerts[0]?.description).toBe("We’ve moved the stop – use platform B.");
  });
  it.each(contract.variants.map((variant) => [variant.file, variant] as const))(
    "decodes %s to the alerts the alert-feed daemon serves",
    async (_file, variant) => {
      await expect(decodeFixture(variant)).resolves.toEqual(variant.alerts);
    },
  );

  it.each(contract.variants.map((variant) => [variant.file, variant] as const))(
    "matches the parse5 reference in real Workers HTMLRewriter for %s and avoids loading parse5",
    async (_file, variant) => {
      const reference = await decodeGhdPage({
        html: readFileSync(join(FIXTURE_DIR, variant.file), "utf8"),
        hostingTarget: "self-hosted",
        pageUrl: variant.pageUrl ?? SOURCE_URL,
        now: NOW,
        timeZone: contract.timeZone,
        maxAgeMinutes: variant.maxAgeMinutes ?? undefined,
      });
      const streamed = await decodeFixtureInWorkers(variant);
      expect(parityProjection(streamed.feed)).toEqual(parityProjection(reference.feed));
      expect(streamed.pageUrls).toEqual(reference.pageUrls);
      expect(streamed.parse5Loaded).toBe(false);
    },
  );

  it("keeps entities, block boundaries, and inline text intact across split UTF-8 chunks", async () => {
    const html = `<div class="blogItem"><h2><a class="newsTitle" href="/news/route-58.aspx?x=1&amp;y=2&amp;amp;z=3&amp=4">Route <strong>58</strong> &ndash; King</a></h2><div class="blogItem-contentContainer"><p><strong>Routes affected</strong>: 58 &amp; 59</p><p>We&rsquo;ve moved <em>the stop</em> – use platform B.</p><p>Entity edge: one &amp;amp; two &amp three.</p><p>Ignore <script>window.fake = '<p>wrong</p>';</script>this tracking code.</p><p>Ignore <style>.fake { color: red }</style>these styles.</p></div></div><div class="pagination-container"><a href="?page=2&amp;x=1&amp;amp;y=2&amp=3">2</a><a href="https://outside.test/other">external</a></div>`;
    const expected = JSON.parse(JSON.stringify(extractGhdPageWithParse5(html)));
    const response = await worker.dispatchFetch("https://worker.test/chunked", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "chunked-extraction", html }),
    });
    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toEqual(expected);
  });

  it.each([
    [
      "omitted paragraph end tags between fields",
      `<div class="blogItem"><h2><a class="newsTitle" href="/news/route-58.aspx">Route 58</a></h2><div class="blogItem-contentContainer"><p>Routes affected: 58<p>Stops: 123</div></div>`,
    ],
    [
      "an unclosed content and card at end of input",
      `<div class="blogItem"><h2><a class="newsTitle" href="/news/route-58.aspx">Route 58</a></h2><div class="blogItem-contentContainer"><p>Routes affected: 58`,
    ],
    [
      "inline prose touching valid nested blocks and field text",
      `<div class="blogItem"><a class="newsTitle" href="/news/route-58.aspx">Route 58</a><div class="blogItem-contentContainer">Alpha<div>Beta</div>Gamma<p>Routes affected: <strong>58</strong><div>and 59</div></div></div>`,
    ],
    [
      "mixed markers, with the higher priority template nested inside another card",
      `<div class="gs-feed-list-item"><a class="gs-feed-list-title" href="/news/outer">Outer card</a><div class="gs-feed-list-description"><div class="blogItem"><a class="newsTitle" href="/news/inner">Inner card</a><div class="blogItem-contentContainer">Routes affected: 11</div></div></div><span class="gs-feed-list-date">September 28, 2026</span></div>`,
    ],
    [
      "inline entities split by markup and a literal encoded ampersand",
      `<div class="blogItem"><h2><a class="newsTitle" href="/news/route-58.aspx?x=1&amp;amp;y=2">Route <strong>58</strong> &amp;amp; <em>King</em></a></h2><div class="blogItem-contentContainer"><p>Routes <strong>affected</strong>: 58 &amp; 59</p></div></div>`,
    ],
    [
      "implicit paragraph end closes a content-field capture",
      `<div class="blogItem"><a class="newsTitle">Route 58</a><p class="blogItem-contentContainer">Routes affected: 58<p>Routes affected: 59</div>`,
    ],
    [
      "implicit list-item end closes a content-field capture",
      `<div class="blogItem"><a class="newsTitle">Route 58</a><ul><li class="blogItem-contentContainer">Routes affected: 58<li>Routes affected: 59</ul></div>`,
    ],
    [
      "implicit heading end closes a content-field capture",
      `<div class="blogItem"><a class="newsTitle">Route 58</a><h2 class="blogItem-contentContainer">Routes affected: 58<h3>Routes affected: 59</h3></div>`,
    ],
    [
      "implicit anchor end closes a title before a sibling link",
      `<div class="blogItem"><a class="newsTitle" href="/one">Route 58<a href="/two">Other link</a><div class="blogItem-contentContainer">Routes affected: 58</div></div>`,
    ],
    [
      "character references in class names are decoded before matching",
      `<div class="blog&#73;tem"><a class="newsTitle">Route 58</a><div class="blogItem-contentContainer">Routes affected: 58</div></div>`,
    ],
    [
      "section start closes a paragraph even though it is not a text block",
      `<div class="blogItem"><a class="newsTitle">Route 58</a><div class="blogItem-contentContainer"><p>Routes affected: 58<section>Stops: 123</section></div></div>`,
    ],
    [
      "list start closes a paragraph before its first item",
      `<div class="blogItem"><a class="newsTitle">Route 58</a><div class="blogItem-contentContainer"><p>Routes affected: 58<ul><li>Stops: 123</li></ul></div></div>`,
    ],
    [
      "template content stays out of document extraction",
      `<div class="blogItem"><a class="newsTitle">Route 58</a><div class="blogItem-contentContainer"><template>Stops: 123</template>Routes affected: 58</div></div>`,
    ],
    [
      "anchors without href do not become empty pagination links",
      `<div class="pagination-container"><a>no href</a></div>`,
    ],
    [
      "implicit definition term closure ends its content field",
      `<div class="blogItem"><a class="newsTitle">Route 58</a><dl><dt class="blogItem-contentContainer">Routes affected: 58<dd>Stops: 123</dl></div>`,
    ],
    [
      "implicit table cell closure ends its content field",
      `<div class="blogItem"><a class="newsTitle">Route 58</a><table><tr><td class="blogItem-contentContainer">Routes affected: 58<td>Stops: 123</tr></table></div>`,
    ],
    [
      "implicit option closure ends its content field",
      `<div class="blogItem"><a class="newsTitle">Route 58</a><select><option class="blogItem-contentContainer">Routes affected: 58<option>Stops: 123</select></div>`,
    ],
    [
      "paragraph closes before a definition description starts",
      `<div class="blogItem"><a class="newsTitle">Route 58</a><div class="blogItem-contentContainer"><p>Routes affected: 58<dd>Stops: 123</dd></div></div>`,
    ],
    [
      "paragraph closes before a list item starts",
      `<div class="blogItem"><a class="newsTitle">Route 58</a><div class="blogItem-contentContainer"><p>Routes affected: 58<li>Stops: 123</li></div></div>`,
    ],
    [
      "an accordion tab whose link is left open before its body",
      `<section class="usn_cmp_anchoredaccordion"><div class="anchored-accordion"><p class="tab"><a class="anchored-accordion-item" href="#c1">Detour Route 58</p><div class="repeatable-content"><div class="text"><p>Beginning Monday, October 5</p></div></div></div></section>`,
    ],
    [
      "an accordion tab with no body sibling",
      `<section class="usn_cmp_anchoredaccordion"><div class="anchored-accordion"><p class="tab"><a class="anchored-accordion-item" href="#c1">Detour Route 58</a></p><p>Not a body</p></div></section>`,
    ],
    [
      "an accordion body with inline markup, script, style, and a line break",
      `<section class="usn_cmp_anchoredaccordion"><div class="anchored-accordion"><p class="tab"><a class="anchored-accordion-item" href="#c1">Detour <strong>Route 58</strong></a></p><div class="repeatable-content"><div class="text"><p>Stop <b>1234</b><br>Routes 1 and 2<script>x()</script><style>.a{}</style></p></div></div></div></section>`,
    ],
    [
      "an accordion tab outside its board section is ignored",
      `<div class="anchored-accordion"><p class="tab"><a class="anchored-accordion-item" href="#c1">Detour Route 58</a></p><div class="repeatable-content">Body</div></div>`,
    ],
    [
      "an empty accordion board with its heading",
      `<section class="usn_cmp_anchoredaccordion"><div class="text"><h3>Transit Detours and  Service Alerts</h3></div><div class="anchored-accordion"></div></section>`,
    ],
    [
      "an empty accordion board with a different heading",
      `<section class="usn_cmp_anchoredaccordion"><div class="text"><h3>Something else</h3></div><div class="anchored-accordion"></div></section>`,
    ],
    [
      "a repeated list item closes the previous advisory card",
      `<ul><li class="blogItem"><a class="newsTitle">Route 58</a><div class="blogItem-contentContainer">Routes affected: 58</div><li class="blogItem"><a class="newsTitle">Route 59</a><div class="blogItem-contentContainer">Routes affected: 59</div></ul>`,
    ],
  ] as const)("matches the reference for adversarial markup: %s", async (_name, html) => {
    const expected = extractGhdPageWithParse5(html);
    const response = await worker.dispatchFetch("https://worker.test/adversarial", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "chunked-extraction", html }),
    });
    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toEqual(expected);
  });

  it("keeps outer advisory fields across a nested table without returning an empty board", async () => {
    const html = `<div class="blogItem"><a class="newsTitle">Route 58</a><table><tr><td class="blogItem-contentContainer">Outer prose before<table><tr><td>Inner table text</td></tr></table><p>Routes affected: 58</p>Outer prose after</td></tr></table></div>`;
    const reference = await decodeGhdPage({
      html,
      hostingTarget: "self-hosted",
      pageUrl: SOURCE_URL,
      now: NOW,
      timeZone: contract.timeZone,
    });
    const response = await worker.dispatchFetch("https://worker.test/decode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ html, pageUrl: SOURCE_URL, now: NOW, timeZone: contract.timeZone }),
    });
    expect(response.ok).toBe(true);
    const streamed = (await response.json()) as {
      readonly feed: DecodedFeed;
      readonly pageUrls: readonly string[];
      readonly parse5Loaded: boolean;
    };
    expect(parityProjection(streamed.feed)).toEqual(parityProjection(reference.feed));
    expect(streamed.feed.alerts).toHaveLength(1);
    expect(streamed.feed.alerts[0]?.routeIds).toEqual(["58"]);
    expect(streamed.feed.alerts[0]?.description).toContain("Routes affected: 58");
    expect(streamed.parse5Loaded).toBe(false);
  });

  it.each([
    [
      "an outer anchor is implicitly closed around a card",
      `<a href="/wrapper"><div class="blogItem"><a class="newsTitle" href="/alert">Route 58</a><div class="blogItem-contentContainer">Routes affected: 58</div></div></a>`,
    ],
    [
      "an outer heading is implicitly closed around a card",
      `<h2><div class="blogItem"><a class="newsTitle" href="/alert">Route 58</a><h3>Details</h3><div class="blogItem-contentContainer">Routes affected: 58</div></div></h2>`,
    ],
  ] as const)(
    "fails closed when HTML recovery can change advisory ownership: %s",
    async (_name, html) => {
      const reference = await decodeGhdPage({
        html,
        hostingTarget: "self-hosted",
        pageUrl: SOURCE_URL,
        now: NOW,
        timeZone: contract.timeZone,
      });
      expect(reference.feed.alerts).not.toHaveLength(0);

      const response = await worker.dispatchFetch("https://worker.test/decode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ html, pageUrl: SOURCE_URL, now: NOW, timeZone: contract.timeZone }),
      });
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({ name: "UnsupportedGhdMarkupError" });
    },
  );

  it("uses the reference extractor when Cloudflare HTMLRewriter is unavailable", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "HTMLRewriter");
    try {
      Object.defineProperty(globalThis, "HTMLRewriter", {
        configurable: true,
        value: undefined,
      });
      const html = readFileSync(join(FIXTURE_DIR, "yrt-blog-item.html"), "utf8");
      const actual = await decodeGhdPage({
        html,
        hostingTarget: "cloudflare",
        pageUrl: SOURCE_URL,
        now: NOW,
        timeZone: contract.timeZone,
      });
      const expected = await decodeGhdPage({
        html,
        hostingTarget: "self-hosted",
        pageUrl: SOURCE_URL,
        now: NOW,
        timeZone: contract.timeZone,
      });
      expect(parityProjection(actual.feed)).toEqual(parityProjection(expected.feed));
      expect(actual.pageUrls).toEqual(expected.pageUrls);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "HTMLRewriter", descriptor);
      else Reflect.deleteProperty(globalThis, "HTMLRewriter");
    }
  });

  it("resolves query-only pagination against the page URL and keeps same-origin links", async () => {
    const html = `<div class="blogItem"><h2><a class="newsTitle" href="/news/route-58.aspx">Route 58 – King</a></h2><div class="blogItem-contentContainer"><p>Posted on September 28, 2026</p></div></div><div class="pagination-container"><a href="?page=2&amp;sort=recent">Next</a><a href="/news/service-alerts/?page=3">3</a><a href="https://outside.test/news?page=4">4</a></div>`;
    const decoded = await decodeGhdPage({
      html,
      hostingTarget: "self-hosted",
      pageUrl: "https://example.test/news/service-alerts/?page=1",
      now: NOW,
      timeZone: contract.timeZone,
    });
    expect(decoded.pageUrls).toEqual([
      "https://example.test/news/service-alerts/?page=2&sort=recent",
      "https://example.test/news/service-alerts/?page=3",
    ]);
  });

  it("never retires an advisory before it starts", async () => {
    // The declared max age is what bounds a posting that states no end, and a
    // retirement earlier than the advisory's own start would render it as
    // already over the moment the operator posted it.
    for (const variant of contract.variants) {
      // An end of 0 is the contract's spelling of "states no end": an open item.
      const bounded = (await decodeFixture(variant)).filter((alert) => alert.endsAt !== 0);
      for (const alert of bounded) {
        expect(alert.endsAt).toBeGreaterThanOrEqual(alert.startsAt);
      }
    }
  });

  it("applies each agency's own max age, and only where it ships one", async () => {
    // Three agencies, three policies, enforced against the real values. The
    // contract carries the age each operator actually ships, so a divergence in
    // the *policy* fails here rather than hiding behind a shared fiction.
    const byFile = (file: string) => contract.variants.find((variant) => variant.file === file)!;

    // YRT ships no max age: its postings state their own period, and the contract
    // carries `null` to say so explicitly rather than omitting the field.
    expect(byFile("yrt-blog-item.html").maxAgeMinutes).toBeNull();

    // Milton and DRT ship different ages, in minutes: a week and a fortnight.
    expect(byFile("milton-blog-item.html").maxAgeMinutes).toBe(10_080);
    expect(byFile("drt-feed-list.html").maxAgeMinutes).toBe(20_160);

    // A posting that states no end is retired exactly one max age after the date
    // the page published, which is what makes each shipped number load-bearing
    // rather than decorative. An age belonging to a different agency would move
    // these spans and fail here.
    const spans = async (file: string) => {
      const variant = byFile(file);
      return (await decodeFixture(variant))
        .filter((alert) => alert.endsAt - alert.startsAt === variant.maxAgeMinutes! * 60_000)
        .map((alert) => alert.title);
    };
    // Milton: every card on the page states no end, so every one is aged out.
    await expect(spans("milton-blog-item.html")).resolves.toHaveLength(4);
    // DRT states a period on most of its cards; these two are aged out instead.
    await expect(spans("drt-feed-list.html")).resolves.toEqual([
      "Temporary Bus Stop Closure - Stop #94191 - Thickson Northbound @ Rossland (North Side Stop)",
      "Detour - Trulls Road from Avondale Drive to Sandringham Drive, Route 421",
    ]);
  });

  it("anchors feed-list postings to the date the page published, not to now", async () => {
    // DRT renders its posting date bare and abbreviated, with no `Posted on`
    // prefix. Falling back to `now` here would put a September 15 detour's start
    // at the current time and render it as live today, which is the false green
    // the whole posting-date rule exists to prevent.
    const drt = contract.variants.find((variant) => variant.file === "drt-feed-list.html");
    expect(drt).toBeDefined();
    const posted = (await decodeFixture(drt!)).find((alert) => alert.stopIds.includes("94191"));
    expect(posted).toBeDefined();

    // 2026-09-22 00:00 in America/Toronto: the posting date, resolved in the
    // agency's zone rather than the host's.
    expect(posted!.startsAt).toBe(Date.UTC(2026, 8, 22, 4));
    expect(posted!.startsAt).toBeLessThan(NOW);

    // `When: Extended until Thursday, December 31, 2026` states a retirement and
    // no opening, so the posting date is the honest start. It has to be the
    // posting date: anchoring it to `now` would hide an advisory that has been
    // running since 2025, and the max age alone would have retired it five months
    // before the end it states.
    const page2 = contract.variants.find((variant) => variant.file === "drt-feed-list-page2.html");
    expect(page2).toBeDefined();
    const retirement = await decodeFixture(page2!);
    expect(retirement).toHaveLength(1);
    expect(retirement[0]!.startsAt).toBe(Date.UTC(2025, 7, 6, 4));
    expect(retirement[0]!.startsAt).toBeLessThan(NOW);
    // 2026-12-31 23:59:59 in America/Toronto: the stated end, not the max age.
    expect(retirement[0]!.endsAt).toBe(Date.UTC(2027, 0, 1, 4, 59, 59));
  });

  it("keeps the posting year when the agency's date crosses UTC New Year", async () => {
    const html = `<li class="gs-feed-list-item"><a class="gs-feed-list-title" href="/news/year-boundary">Route 58</a><p class="gs-feed-list-description">When: January 2</p><span class="gs-feed-list-date">December 31</span></li>`;
    const feed = await decodeGhdNewsServiceAdvisories({
      html,
      now: Date.UTC(2026, 0, 1, 2),
      timeZone: "America/Toronto",
    });

    expect(feed.alerts[0]?.updatedAt).toBe(Date.UTC(2025, 11, 31, 5));
    expect(feed.alerts[0]?.startsAt).toBe(Date.UTC(2025, 0, 2, 5));
  });

  it("keeps prose numbers out of the route list", async () => {
    const drt = contract.variants.find((variant) => variant.file === "drt-feed-list.html");
    const advisory = (await decodeFixture(drt!)).find((alert) => alert.stopIds.includes("94191"));
    // `905, 920` is the route list; the stop numbers and the "September 22" in
    // the prose beneath it must never be read as routes.
    expect(advisory!.routeIds).toEqual(["905", "920"]);
    expect(advisory!.routeIds).not.toContain("22");
    expect(advisory!.routeIds).not.toContain("94191");
  });

  it("keeps a lettered route suffix and drops a lettered route prefix alike", async () => {
    const drt = contract.variants.find((variant) => variant.file === "drt-feed-list.html");
    const alerts = await decodeFixture(drt!);
    // `905C` is digits plus a trailing letter: a real DRT route.
    expect(alerts.find((alert) => alert.title.includes("Port Perry"))!.routeIds).toEqual([
      "618",
      "905C",
    ]);
    // `N1` is letters first, which is outside the shared token vocabulary. The
    // daemon's `parse_standard_route_tokens` drops it identically, so the two
    // implementations cannot disagree by inventing a route one of them has.
    expect(alerts.find((alert) => alert.title.includes("Kingston Rd"))!.routeIds).toEqual([
      "900",
      "920",
    ]);
  });

  it("retires an advisory whose title announces that a disruption has ended", async () => {
    const html = `
      <div class="blogItem">
        <a class="newsTitle" href="/alerts/route-58-ended">Emergency detour ended on Route 58</a>
        <div class="blogItem-contentContainer">
          <p>Posted on September 28, 2026</p>
          <p>The emergency detour on Route 58 has ended.</p>
        </div>
      </div>
    `;
    const feed = await decodeGhdNewsServiceAdvisories({
      html,
      now: NOW,
      timeZone: contract.timeZone,
    });
    expect(feed.alerts).toHaveLength(1);
    const alert = feed.alerts[0]!;
    expect(alert.endsAt).toBeLessThanOrEqual(NOW);
    expect(alert.effect).toBeUndefined();
  });

  describe("anchored-accordion board", () => {
    const accordion = contract.variants.find(
      (variant) => variant.file === "thunderbay-anchored-accordion.html",
    )!;
    const accordionHtml = readFileSync(join(FIXTURE_DIR, accordion.file), "utf8");
    const board = (title: string, bodyLine: string) =>
      `<section class="usn_cmp_anchoredaccordion"><div class="anchored-accordion"><p class="tab"><a class="anchored-accordion-item" href="#collapse_1">${title}</a></p><div class="repeatable-content"><div class="text"><p>${bodyLine}</p></div></div></div></section>`;

    it("decodes the recorded board with an expired notice, open-ended notices, and stop scope", async () => {
      const alerts = await decodeFixture(accordion);
      expect(alerts.map((alert) => alert.routeIds)).toEqual([
        ["15"],
        ["12", "16"],
        ["1", "2", "11", "13"],
        ["2", "11", "13"],
      ]);
      // Only the notice that states an end has one, and that end is in the past.
      expect(alerts.map((alert) => alert.endsAt !== 0 && alert.endsAt < NOW)).toEqual([
        false,
        false,
        false,
        true,
      ]);
      // "approximately August 3, 2026" ends at the end of that day in Toronto.
      expect(alerts[3]!.endsAt).toBe(Date.UTC(2026, 7, 4, 3, 59, 59));
      // "approximately four weeks" and "late Fall 2026" are not dates.
      expect(alerts.slice(0, 3).map((alert) => alert.endsAt)).toEqual([0, 0, 0]);
      // "Beginning Monday, October 5" has no year: the nearest one is 2026.
      expect(alerts[0]!.startsAt).toBe(Date.UTC(2026, 9, 5, 4));
      // East End lists streets, not stop ids, so it attributes to routes only.
      expect(alerts[1]!.stopIds).toEqual([]);
    });

    it.each(
      contract.accordionClocks.clocks.map(
        (clock) => [new Date(clock.now).toISOString(), clock] as const,
      ),
    )("decodes the recorded board at %s to the alerts the daemon serves", async (_iso, clock) => {
      const feed = await decodeGhdNewsServiceAdvisories({
        html: accordionHtml,
        now: clock.now,
        timeZone: contract.timeZone,
        pageUrl: contract.accordionClocks.pageUrl,
      });
      expect(parityProjection(feed)).toEqual(clock.alerts);
    });

    it("uses a stated weekday to keep last year's notice active the next June", async () => {
      const feed = await decodeGhdNewsServiceAdvisories({
        html: board("Detour", "Beginning Tuesday, November 3"),
        now: Date.UTC(2027, 5, 15, 16),
        timeZone: contract.timeZone,
      });
      expect(feed.alerts[0]!.startsAt).toBe(Date.UTC(2026, 10, 3, 5));
      expect(feed.alerts[0]!.startsAt).toBeLessThan(Date.UTC(2027, 5, 15, 16));
    });

    it("uses the nearest occurrence when an open-ended date has no year or weekday", async () => {
      const feed = await decodeGhdNewsServiceAdvisories({
        html: board("Detour", "Beginning November 3"),
        now: Date.UTC(2027, 5, 15, 16),
        timeZone: contract.timeZone,
      });
      expect(feed.alerts[0]!.startsAt).toBe(Date.UTC(2027, 10, 3, 4));
    });

    it("ends a yearless period on the first occurrence after its start", async () => {
      const feed = await decodeGhdNewsServiceAdvisories({
        html: board("Detour", "From December 28 to January 4"),
        now: Date.UTC(2026, 11, 27, 16),
        timeZone: contract.timeZone,
      });
      expect(feed.alerts[0]!.startsAt).toBe(Date.UTC(2026, 11, 28, 5));
      expect(feed.alerts[0]!.endsAt).toBe(Date.UTC(2027, 0, 5, 4, 59, 59));
    });

    it.each([
      ["Route 5 detour", "DETOUR"],
      ["Route 5 delays", undefined],
      ["Route 5 trips cancelled", undefined],
    ])("reads %j as a %s effect only when it states a detour", async (title, effect) => {
      const feed = await decodeGhdNewsServiceAdvisories({
        html: board(title, "Beginning Monday, October 5"),
        now: NOW,
        timeZone: contract.timeZone,
      });
      expect(feed.alerts[0]!.effect).toBe(effect);
    });

    it("never reads a renamed tab as an empty board", async () => {
      await expect(
        decodeGhdNewsServiceAdvisories({
          html: readFileSync(join(FIXTURE_DIR, "thunderbay-accordion-renamed-tab.html"), "utf8"),
          now: NOW,
          timeZone: contract.timeZone,
        }),
      ).rejects.toThrow("Unsupported GHD advisory page");
    });

    it("gives an item the same identity with or without the transient NEW marker", async () => {
      const decode = async (title: string) =>
        (
          await decodeGhdNewsServiceAdvisories({
            html: board(title, "Beginning Monday, October 5"),
            now: NOW,
            timeZone: contract.timeZone,
            pageUrl: "https://example.test/alerts/",
          })
        ).alerts[0]!.id;
      const withMarker = await decode("Beverly detour (Route 15) - NEW");
      expect(withMarker).toBe("https://example.test/alerts/#beverly-detour-route-15");
      await expect(decode("Beverly detour (Route 15)")).resolves.toBe(withMarker);
    });

    it.each([
      ["Beginning Monday, December 28", Date.UTC(2027, 0, 3, 17), Date.UTC(2026, 11, 28, 5)],
      ["Beginning Monday, January 4", Date.UTC(2026, 11, 28, 17), Date.UTC(2027, 0, 4, 5)],
      ["Beginning Monday, June 22, 2026", Date.UTC(2027, 0, 3, 17), Date.UTC(2026, 5, 22, 4)],
    ])("reads %s against %d with its most recent occurrence", async (line, now, expected) => {
      const feed = await decodeGhdNewsServiceAdvisories({
        html: board("Detour", line),
        now,
        timeZone: contract.timeZone,
      });
      expect(feed.alerts[0]!.startsAt).toBe(expected);
    });

    it.each([
      ["Route 12 and Route 5 detour", ["12", "5"]],
      ["Routes 1/2/11/13 will detour.", ["1", "2", "11", "13"]],
      ["Routes 12 East End and 16 Balmoral will operate on detour.", ["12", "16"]],
      ["Route Changes", []],
      ["Route 15 will not operate along 2nd Street, 12 times a day.", ["15"]],
      ["Routes 12 and 16 run. Also see 20 and 22.", ["12", "16"]],
      ["Stop 1869 on Highway 11 near 3 Bridge Street", []],
    ])("reads route phrases from %j", async (line, routeIds) => {
      const feed = await decodeGhdNewsServiceAdvisories({
        html: board("Notice", line),
        now: NOW,
        timeZone: contract.timeZone,
      });
      expect(feed.alerts[0]!.routeIds ?? []).toEqual(routeIds);
    });

    it("streams the recorded board in Workers with the same extraction as the reference", async () => {
      const response = await worker.dispatchFetch("https://worker.test/chunked", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "chunked-extraction", html: accordionHtml }),
      });
      expect(response.ok).toBe(true);
      const streamed = (await response.json()) as ReturnType<typeof extractGhdPageWithParse5>;
      expect(streamed).toEqual(JSON.parse(JSON.stringify(extractGhdPageWithParse5(accordionHtml))));
      expect(streamed.variant).toBe("anchored-accordion");
      expect(streamed.advisories).toHaveLength(4);
    });

    it("tells a missing board from an empty one", async () => {
      const decode = (file: string) =>
        decodeGhdNewsServiceAdvisories({
          html: readFileSync(join(FIXTURE_DIR, file), "utf8"),
          now: NOW,
          timeZone: contract.timeZone,
        });
      // The operator's own empty board is zero advisories, as a rider sees it.
      await expect(decode("thunderbay-anchored-accordion-empty.html")).resolves.toMatchObject({
        alerts: [],
      });
      // A board that vanished, or an item without a body, is unreadable and
      // never an empty result.
      await expect(decode("thunderbay-accordion-missing-section.html")).rejects.toThrow(
        "Unsupported GHD advisory page",
      );
      await expect(decode("thunderbay-accordion-tab-without-body.html")).rejects.toThrow(
        "Unsupported GHD advisory page",
      );
    });
  });
});
