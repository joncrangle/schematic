import { describe, expect, it } from "vitest";
import type { AlertSource } from "~/agencies/types";
import {
  CYCLE_SUBREQUEST_BUDGET,
  coldPollingSubrequestsForCycle,
  coldPollingSubrequestsForSources,
  type AgencyAlertSourceInventory,
} from "~/services/notifications/cycleBudget";

const gtfs = (url: string): AlertSource => ({ type: "gtfs-rt", url });
const json = (url: string): AlertSource => ({
  type: "json",
  url,
  parser: "generic-alert-feed",
});
const rss = (url: string): AlertSource => ({ type: "rss", url, maxAgeMinutes: 60 });
const web = (url: string): Extract<AlertSource, { type: "web" }> => ({
  type: "web",
  url,
  parser: "ghd-news-service-advisories",
});

describe("coldPollingSubrequestsForSources (per-agency formula)", () => {
  it("charges the declared Workers crawl ceiling before scheduling an agency", () => {
    expect(
      coldPollingSubrequestsForSources(
        [
          { ...web("a"), cloudflareMaxCrawlPages: 10 },
          { ...web("b"), cloudflareMaxCrawlPages: 4 },
          { type: "json", parser: "mapstrat-broadcast", url: "https://example.test/broadcast" },
        ],
        "slow",
      ),
    ).toBe(45);
  });

  it("charges fast feeds their full retry ladder and skips slow-only agencies on the fast cadence", () => {
    expect(coldPollingSubrequestsForSources([gtfs("a"), gtfs("b"), json("c")], "fast")).toBe(9);
    expect(coldPollingSubrequestsForSources([web("a")], "fast")).toBe(0);
  });

  it("charges one capped crawl per web board and one fetch per rss on the slow cadence", () => {
    expect(coldPollingSubrequestsForSources([web("a")], "slow")).toBe(9);
    expect(coldPollingSubrequestsForSources([rss("a")], "slow")).toBe(3);
    expect(coldPollingSubrequestsForSources([gtfs("a")], "slow")).toBe(0);
  });

  it("charges an AnyRide message read one POST per polled stop, on the fast cadence", () => {
    const stops = Array.from({ length: 12 }, (_value, index) => ({
      stopId: `S${index}`,
      routeIds: ["A"],
    }));
    const anyRide: AlertSource = {
      type: "anyride-messages",
      url: "https://anyride.example.test/api",
      operatorPrefix: "70",
      stops,
    };
    expect(coldPollingSubrequestsForSources([anyRide], "fast")).toBe(12);
    expect(coldPollingSubrequestsForSources([anyRide], "slow")).toBe(0);
    expect(
      coldPollingSubrequestsForSources(
        [
          {
            type: "anyride-messages",
            url: "https://alerts.example.test/x.json",
            relay: "daemon-document",
          },
        ],
        "fast",
      ),
    ).toBe(3);
  });

  it("counts full-fetch fallback for the opposite cadence", () => {
    // Every page can miss its local cache and cost lookup + fetch + put.
    const mixed = [gtfs("a"), web("b"), rss("c")];
    expect(coldPollingSubrequestsForSources(mixed, "fast")).toBe(3 + 9 + 3);
    expect(coldPollingSubrequestsForSources(mixed, "slow")).toBe(3 + 9 + 3);
  });
});

describe("coldPollingSubrequestsForCycle (registry totals)", () => {
  const agencies: readonly AgencyAlertSourceInventory[] = [
    { agencyId: "fast-only", sources: [gtfs("a"), json("b")] },
    { agencyId: "slow-only", sources: [web("c")] },
    { agencyId: "mixed", sources: [gtfs("d"), web("e")] },
  ];
  const gated: readonly AgencyAlertSourceInventory[] = [
    {
      agencyId: "gated",
      sources: [
        {
          type: "web",
          url: "https://example.test/gated",
          parser: "ghd-news-service-advisories",
          runtimes: ["self-hosted"],
        },
      ],
    },
  ];
  const secretGated: readonly AgencyAlertSourceInventory[] = [
    {
      agencyId: "secret",
      sources: [
        { type: "gtfs-rt", url: "https://example.test/secret", baseUrlSecretName: "FEED_PROXY" },
      ],
    },
  ];

  it("estimates cold polling costs per cadence under the invocation budget", () => {
    // fast-only 6, mixed 3+9 cold reads, slow-only skipped.
    expect(coldPollingSubrequestsForCycle(agencies, "fast", "cloudflare")).toBe(18);
    // slow-only 9, mixed 3+9 cold reads, fast-only skipped.
    expect(coldPollingSubrequestsForCycle(agencies, "slow", "cloudflare")).toBe(21);
    expect(coldPollingSubrequestsForCycle(agencies, "fast", "cloudflare")).toBeLessThan(
      CYCLE_SUBREQUEST_BUDGET,
    );
    expect(coldPollingSubrequestsForCycle(agencies, "slow", "cloudflare")).toBeLessThan(
      CYCLE_SUBREQUEST_BUDGET,
    );
  });

  it("costs nothing for runtimes-gated sources on the gated-out target", () => {
    expect(coldPollingSubrequestsForCycle(gated, "slow", "cloudflare")).toBe(0);
    expect(coldPollingSubrequestsForCycle(gated, "slow", "self-hosted")).toBe(9);
  });

  it("costs nothing for unprovisioned base URLs and bounds the provisioned worst case", () => {
    expect(coldPollingSubrequestsForCycle(secretGated, "fast", "cloudflare")).toBe(0);
    expect(
      coldPollingSubrequestsForCycle(secretGated, "fast", "cloudflare", () => "provisioned"),
    ).toBe(3);
  });
});
