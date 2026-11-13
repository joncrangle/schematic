import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { parseNextBusRouteConfigJson } from "~/domain/nextbus/parseRouteConfig";
import type { RouteDetails, SurfaceStop } from "~/domain/surface/types";
import {
  makeSurfaceTopologyWriter,
  type FetchedRouteTopology,
} from "~/infrastructure/storage/SurfaceStoreWriter";
import { crawlTopology } from "~/infrastructure/storage/surfaceStore/crawl";
import { createMemoryD1 } from "../helpers/memoryD1";

const BOUNDS = { minLat: 43.6, maxLat: 43.8, minLon: -79.5, maxLon: -79.3 };

interface CrawlFixture {
  readonly routeJson: unknown;
  readonly detailsByDir: Map<number, RouteDetails>;
  readonly allStops: readonly SurfaceStop[];
}

function routeJson(tag: string, title: string, headsign0: string): unknown {
  return {
    route: {
      tag,
      title,
      color: "DA251D",
      oppositeColor: "FFFFFF",
      latMin: "43.6",
      latMax: "43.8",
      lonMin: "-79.5",
      lonMax: "-79.3",
      stop: [
        { tag: "s1", title: "Queen & Yonge", lat: "43.65", lon: "-79.38", stopId: "1001" },
        { tag: "s2", title: "Queen & Bay", lat: "43.651", lon: "-79.381", stopId: "1002" },
      ],
      direction: [
        {
          tag: `${tag}_0`,
          title: headsign0,
          name: "East",
          useForUI: "true",
          stop: [{ tag: "s1" }, { tag: "s2" }],
        },
        {
          tag: `${tag}_1`,
          title: "Westbound",
          name: "West",
          stop: [{ tag: "s2" }, { tag: "s1" }],
        },
      ],
    },
  };
}

function parseFixture(tag: string, title: string, headsign0 = "Eastbound"): CrawlFixture {
  const routeJsonValue = routeJson(tag, title, headsign0);
  const { detailsByDir, allStops } = parseNextBusRouteConfigJson(routeJsonValue, {
    routeId: tag,
    fallbackBounds: BOUNDS,
  });
  return { routeJson: routeJsonValue, detailsByDir, allStops };
}

async function seedFixture(fixture: CrawlFixture, agencyId = "ttc") {
  const d1 = await createMemoryD1();
  const writer = makeSurfaceTopologyWriter({ agencyId, db: d1 });
  for (const details of fixture.detailsByDir.values()) {
    await Effect.runPromise(
      writer.reconcileRoute({
        routeId: details.route.id,
        detailsByDirection: new Map([[details.shape.directionId, details]]),
        allStops: fixture.allStops,
      }),
    );
  }
  return d1;
}

function fetchMock(routeJsonByTag: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("command=routeList")) {
      return new Response(
        JSON.stringify({ route: Object.keys(routeJsonByTag).map((tag) => ({ tag })) }),
        { status: 200 },
      );
    }
    const tag = new URL(url).searchParams.get("r") ?? "";
    return new Response(JSON.stringify(routeJsonByTag[tag] ?? {}), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("crawlTopology writer seam", () => {
  it("submits one complete route to the writer and leaves unchanged metadata alone", async () => {
    const fixture = parseFixture("501", "501-Queen");
    const d1 = await seedFixture(fixture);
    const calls: FetchedRouteTopology[] = [];

    await crawlTopology({
      d1,
      agencyId: "ttc",
      agencySlug: "ttc",
      fallbackBounds: BOUNDS,
      fetchImpl: fetchMock({ "501": fixture.routeJson }),
      writer: {
        reconcileRoute: (fetched) => {
          calls.push(fetched);
          return Effect.succeed({ outcome: "unchanged" as const, routeId: fetched.routeId });
        },
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.routeId).toBe("501");
    const meta = await d1
      .prepare("SELECT agency_id FROM topology_meta WHERE agency_id = ?")
      .bind("ttc")
      .first<{ agency_id: string }>();
    expect(meta).toBeNull();
  });

  it("submits both fetched directions in one reconciliation call", async () => {
    const fixture = parseFixture("501", "501-Queen");
    const d1 = await seedFixture(fixture);
    const changed = parseFixture("501", "501-Queen", "Eastbound to Neville Park");
    const calls: FetchedRouteTopology[] = [];

    await crawlTopology({
      d1,
      agencyId: "ttc",
      agencySlug: "ttc",
      fallbackBounds: BOUNDS,
      fetchImpl: fetchMock({ "501": changed.routeJson }),
      writer: {
        reconcileRoute: (fetched) => {
          calls.push(fetched);
          return Effect.succeed({ outcome: "updated" as const, routeId: fetched.routeId });
        },
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.routeId).toBe("501");
    expect([...calls[0]!.detailsByDirection.keys()]).toEqual([0, 1]);
  });

  it("submits each fetched route once, including cache misses", async () => {
    const fixture = parseFixture("501", "501-Queen");
    const d1 = await seedFixture(fixture);
    const fresh = parseFixture("999", "999-Test");
    const calls: FetchedRouteTopology[] = [];

    await crawlTopology({
      d1,
      agencyId: "ttc",
      agencySlug: "ttc",
      fallbackBounds: BOUNDS,
      fetchImpl: fetchMock({ "501": fixture.routeJson, "999": fresh.routeJson }),
      writer: {
        reconcileRoute: (fetched) => {
          calls.push(fetched);
          return Effect.succeed({ outcome: "updated" as const, routeId: fetched.routeId });
        },
      },
    });

    expect(calls.map((fetched) => fetched.routeId)).toEqual(["501", "999"]);
  });
});
