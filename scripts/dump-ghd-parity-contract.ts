import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { GenericAlert } from "~/infrastructure/realtime/gtfsRealtimeDecoder";
import { decodeGhdNewsServiceAdvisories } from "~/infrastructure/realtime/ghdNewsServiceAdvisoriesParser";

/**
 * Regenerates `tests/fixtures/ghd-news/contract.json`, the cross-language
 * expectation the Core and alert-feed-daemon parity suites both assert against.
 *
 * The contract is generated rather than hand-written so it cannot encode a
 * mistake from either side. Run it, then run both suites: if the daemon's decode
 * of the same recorded pages disagrees, its test fails and the difference is
 * real rather than baked into the expectation.
 *
 *   bun scripts/dump-ghd-parity-contract.ts
 *   cargo test -p alert-feed-daemon test_matches_the_shared_parity_contract
 *   bun run test tests/unit/ghd-news-parity.test.ts
 */

const FIXTURE_DIR = join(import.meta.dirname, "../tests/fixtures/ghd-news");
const CONTRACT_PATH = join(FIXTURE_DIR, "contract.json");

/** A fixed clock, after the newest posting date in the fixtures. */
const NOW = Date.UTC(2026, 8, 28, 16);
const TIME_ZONE = "America/Toronto";

/**
 * The max age each shipped agency declares, in minutes, and `null` for the
 * agencies that declare none.
 *
 * These are the policies `src/agencies/agencyCatalog.ts` and the daemon's
 * agency modules actually ship, and they are per variant because they differ per
 * operator. A single shared number would assert agreement on a policy no agency
 * runs; carrying the real one is what makes a divergence in the policy, not only
 * in the parsing, fail here.
 */
const MAX_AGE_MINUTES: Readonly<Record<string, number | null>> = {
  "yrt-blog-item.html": null,
  "milton-blog-item.html": 10_080,
  "drt-feed-list.html": 20_160,
  "drt-feed-list-page2.html": 20_160,
  "thunderbay-anchored-accordion.html": null,
  "dated-news-headlines.html": null,
};

/**
 * Clocks the yearless dates of the accordion board are decoded at, so the year
 * rule is pinned before, across, and long after New Year and not only at the
 * recording date. Epoch milliseconds.
 */
const ACCORDION_CLOCKS = [
  Date.UTC(2026, 8, 20, 16),
  Date.UTC(2026, 8, 28, 16),
  Date.UTC(2026, 9, 14, 16),
  Date.UTC(2027, 0, 1, 4, 30),
  Date.UTC(2027, 0, 3, 16),
  Date.UTC(2027, 5, 15, 16),
  Date.UTC(2027, 11, 20, 16),
];

const contract = JSON.parse(readFileSync(CONTRACT_PATH, "utf8")) as {
  variants: { file: string; pageUrl?: string }[];
  accordionClocks: { file: string; pageUrl: string };
  recognizedEmptyPages: string[];
  unsupportedPages: string[];
};

/** What both implementations can produce for one alert. */
function projectAlert(alert: GenericAlert) {
  return {
    id: alert.id,
    title: alert.title,
    routeIds: alert.routeIds ?? [],
    stopIds: alert.affectedStations ?? [],
    effect: alert.effect === undefined ? null : String(alert.effect),
    startsAt: alert.startsAt,
    endsAt: alert.endsAt ?? 0,
  };
}

const regenerated = {
  timeZone: TIME_ZONE,
  now: NOW,
  recognizedEmptyPages: contract.recognizedEmptyPages,
  unsupportedPages: contract.unsupportedPages,
  variants: await Promise.all(
    contract.variants.map(async ({ file, pageUrl }) => {
      const maxAgeMinutes = MAX_AGE_MINUTES[file];
      if (maxAgeMinutes === undefined) {
        throw new Error(`no max age declared for ${file}`);
      }
      return {
        file,
        // `null` is the agency's own "no max age": its postings state their period.
        maxAgeMinutes,
        // Only the accordion board names its items by page, so only it carries one.
        ...(pageUrl === undefined ? {} : { pageUrl }),
        alerts: (
          await decodeGhdNewsServiceAdvisories({
            html: readFileSync(join(FIXTURE_DIR, file), "utf8"),
            now: NOW,
            timeZone: TIME_ZONE,
            maxAgeMinutes: maxAgeMinutes ?? undefined,
            pageUrl,
          })
        ).alerts.map(projectAlert),
      };
    }),
  ),
  // The accordion board decoded at several clocks: its yearless start dates
  // resolve against the clock, so one clock cannot pin the rule.
  accordionClocks: {
    file: contract.accordionClocks.file,
    pageUrl: contract.accordionClocks.pageUrl,
    clocks: await Promise.all(
      ACCORDION_CLOCKS.map(async (now) => ({
        now,
        alerts: (
          await decodeGhdNewsServiceAdvisories({
            html: readFileSync(join(FIXTURE_DIR, contract.accordionClocks.file), "utf8"),
            now,
            timeZone: TIME_ZONE,
            pageUrl: contract.accordionClocks.pageUrl,
          })
        ).alerts.map(projectAlert),
      })),
    ),
  },
};

writeFileSync(CONTRACT_PATH, `${JSON.stringify(regenerated, null, 2)}\n`);
console.log(`wrote ${regenerated.variants.length} fixtures to ${CONTRACT_PATH}`);
