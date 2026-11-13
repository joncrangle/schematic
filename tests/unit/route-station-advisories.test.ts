import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeRouteStationAdvisories } from "~/infrastructure/realtime/routeStationAdvisoriesParser";

interface Case {
  readonly name: string;
  readonly html: string;
  readonly routeNames?: Readonly<Record<string, readonly string[]>>;
  readonly partial?: boolean;
  readonly notices?: readonly {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly routeIds: readonly string[];
    readonly stations?: readonly string[];
    readonly startsAt: string;
    readonly endsAt?: string;
  }[];
  readonly error?: boolean;
}

const contract = JSON.parse(
  readFileSync(
    new URL("../fixtures/route-station-advisories/contract.json", import.meta.url),
    "utf8",
  ),
) as { readonly timeZone: string; readonly cases: readonly Case[] };

const decode = (entry: Case) =>
  decodeRouteStationAdvisories(
    entry.html,
    "https://example.test/alerts",
    1_234,
    contract.timeZone,
    entry.routeNames,
  );

describe("route and station advisories", () => {
  it.each(contract.cases.filter((entry) => !entry.error))("$name", (entry) => {
    const feed = decode(entry);

    expect({ partial: feed.partial ?? false, alerts: feed.alerts }).toEqual({
      partial: entry.partial ?? false,
      alerts: entry.notices!.map(({ stations, startsAt, endsAt, ...notice }) => ({
        ...notice,
        startsAt: Date.parse(startsAt),
        ...(endsAt === undefined ? {} : { endsAt: Date.parse(endsAt) }),
        ...(stations
          ? {
              affectedStations: stations,
              targets: stations.map((stopId) => ({ stopId })),
            }
          : {}),
        updatedAt: 1_234,
      })),
    });
  });

  it.each(contract.cases.filter((entry) => entry.error))("$name", (entry) => {
    expect(() => decode(entry)).toThrow();
  });
});
