import * as Effect from "effect/Effect";
import type { D1DatabaseBinding } from "../RuntimeBindings";
import type { RouteInterpretationConfig } from "~/agencies";
import type { BoundingBox, RouteDetails, SurfaceStop } from "~/domain/surface/types";
import { TOPOLOGY_TTL_MS } from "~/domain/surface/topologySource";
import { parseNextBusRouteConfigJson } from "~/domain/nextbus/parseRouteConfig";
import { logger } from "~/infrastructure/logging/logger";
import type { SurfaceTopologyWriter } from "../SurfaceStoreWriter";
import { ensureSurfaceSchema } from "./schema";

/**
 * Surface store crawl path.
 *
 * Single home for every live NextBus read: the route-list fetch, the
 * per-route routeConfig fetch+parse, the explicit topology crawl, and the
 * freshness probe. Both the topology sync and the explicit per-route fetcher
 * delegate here; parsing stays in the pure domain grammar
 * (`parseNextBusRouteConfigJson`). The route-list HTTP + tag extraction moved
 * here verbatim from the deleted NextBusGateway so this seam owns all
 * NextBus wire I/O, nothing imports `~/infrastructure/nextbus/NextBusGateway`
 * anymore.
 *
 * `fetch` is always injected, this module never touches the ambient
 * fetch, so unit probes stay offline.
 */

export interface RouteConfigResult {
  readonly detailsByDirection: ReadonlyMap<number, RouteDetails>;
  readonly allStops: readonly SurfaceStop[];
}

/**
 * Live-fetch context threaded through every NextBus read:
 * bundles the agencySlug/fallbackBounds/fetchImpl/routeInterpretation data
 * clump so routeConfig + crawl inputs share one seam.
 */
export interface FetchContext {
  readonly agencySlug: string;
  readonly fallbackBounds: BoundingBox;
  readonly fetchImpl: typeof fetch;
  readonly routeInterpretation?: RouteInterpretationConfig;
  readonly defaultRouteColor?: string;
}

/** Live NextBus route list for one agency slug over the injected fetch. */
export async function fetchNextBusRouteTags(
  agencySlug: string,
  fetchImpl: typeof fetch,
): Promise<readonly string[]> {
  const qs = new URLSearchParams({ a: agencySlug, command: "routeList" });
  const url = `https://webservices.nextbus.com/service/publicJSONFeed?${qs.toString()}`;
  const resp = await fetchImpl(url);
  if (!resp.ok) throw new Error(`NextBus routeList ${resp.status}`);
  const json = (await resp.json()) as { route?: Array<{ tag: string }> | { tag: string } };
  const routes = json.route;
  const list = routes === undefined ? [] : Array.isArray(routes) ? routes : [routes];
  return list.map((r) => r.tag);
}

export type FetchRouteConfigInput = FetchContext & {
  readonly routeId: string;
};

/** Live NextBus routeConfig fetch+parse for one route over the injected fetch. */
export async function fetchLiveRouteConfig(
  input: FetchRouteConfigInput,
): Promise<RouteConfigResult> {
  const { routeId, agencySlug, fallbackBounds, fetchImpl, routeInterpretation, defaultRouteColor } =
    input;
  if (!fallbackBounds) {
    throw new Error(
      "surfaceStore/crawl: fallbackBounds is required (thread manifestFallbackBounds)",
    );
  }
  const url = `https://webservices.nextbus.com/service/publicJSONFeed?command=routeConfig&a=${encodeURIComponent(agencySlug)}&r=${encodeURIComponent(routeId)}`;
  const resp = await fetchImpl(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching routeConfig for ${routeId}`);
  const data = (await resp.json()) as unknown;
  const { detailsByDir, allStops } = parseNextBusRouteConfigJson(data, {
    routeId,
    fallbackBounds,
    routeInterpretation,
    defaultRouteColor,
  });
  return { detailsByDirection: detailsByDir, allStops };
}

interface TopologyMetaRow {
  readonly last_sync: number;
}

/**
 * Freshness probe shared by every topology source: an empty routes table or
 * a missing/stale topology_meta row needs a refresh.
 */
export async function probeTopologyFreshness(
  d1: D1DatabaseBinding,
  now: () => number,
  agencyId: string = "ttc",
): Promise<boolean> {
  await ensureSurfaceSchema(d1);
  const countRow = await d1
    .prepare("SELECT COUNT(*) as cnt FROM routes WHERE agency_id = ?")
    .bind(agencyId)
    .first<{ cnt: number }>();
  const cnt = Number((countRow as unknown as { cnt: number })?.cnt ?? 0);
  if (cnt === 0) return true;
  const meta = await d1
    .prepare("SELECT last_sync as last_sync FROM topology_meta WHERE agency_id = ? LIMIT 1")
    .bind(agencyId)
    .first<TopologyMetaRow>();
  if (!meta) return true;
  return now() - Number(meta.last_sync) >= TOPOLOGY_TTL_MS;
}

export interface CrawlTopologyInput extends FetchContext {
  readonly d1: D1DatabaseBinding;
  readonly agencyId: string;
  readonly now?: () => number;
  readonly writer: SurfaceTopologyWriter;
}

/**
 * Explicit NextBus crawl: route list, then routeConfig per tag in batches of
 * 20, persisted through the injected writer. A failed route config is
 * skipped with a warning (its absence is repaired on a later crawl); a
 * missing fallbackBounds fails loudly. Request-path reads never fetch,
 * so this explicit crawl (sequenced by SurfaceTopologyRefresh) is the live
 * topology repair path alongside seeding.
 *
 * Each fetched route is handed to the agency-bound writer once. The writer
 * owns validation, comparison, minimal statement planning, and atomic commit;
 * unchanged routes return a zero-write outcome without exposing row tactics
 * to this crawl.
 */
export async function crawlTopology(input: CrawlTopologyInput): Promise<void> {
  const {
    d1,
    agencyId,
    agencySlug,
    fallbackBounds,
    fetchImpl,
    routeInterpretation,
    defaultRouteColor,
    now = () => Date.now(),
    writer,
  } = input;
  await ensureSurfaceSchema(d1);
  if (!fallbackBounds) {
    throw new Error(
      "surfaceStore/crawl: fallbackBounds is required (thread manifestFallbackBounds)",
    );
  }
  logger.info("surfaceStore/crawl: starting topology sync", { agencyId });
  const startTime = Date.now();
  let topologyChanged = false;
  const routeTags = await fetchNextBusRouteTags(agencySlug, fetchImpl);
  logger.info("surfaceStore/crawl: fetched route list for sync", {
    agencyId,
    count: routeTags.length,
  });
  for (let i = 0; i < routeTags.length; i += 20) {
    const batch = routeTags.slice(i, i + 20);
    const configs = await Promise.all(
      batch.map(async (tag) => {
        try {
          return {
            routeId: tag,
            result: await fetchLiveRouteConfig({
              routeId: tag,
              agencySlug,
              fallbackBounds,
              fetchImpl,
              routeInterpretation,
              defaultRouteColor,
            }),
          };
        } catch (err) {
          if (err instanceof Error && err.message.includes("fallbackBounds is required")) {
            throw err;
          }
          logger.warn("surfaceStore/crawl: route config fetch failed, skipping route", {
            agencyId,
            routeTag: tag,
            err: String(err),
          });
          return {
            routeId: tag,
            result: {
              detailsByDirection: new Map<number, RouteDetails>(),
              allStops: [] as SurfaceStop[],
            },
          };
        }
      }),
    );
    for (const { routeId, result } of configs) {
      const outcome = await Effect.runPromise(
        writer.reconcileRoute({
          routeId,
          detailsByDirection: result.detailsByDirection,
          allStops: result.allStops,
        }),
      );
      if (outcome.outcome === "updated") {
        topologyChanged = true;
      }
    }
  }
  // A no-op crawl must remain read-only. In particular, do not update the
  // freshness row when every route matched the cached topology; otherwise a
  // scheduled refresh still consumes a D1/SQLite write despite no route data
  // changing. Both SQL adapters use this shared crawl policy.
  if (topologyChanged) {
    await d1
      .prepare(
        "INSERT INTO topology_meta (agency_id, last_sync) VALUES (?, ?) ON CONFLICT(agency_id) DO UPDATE SET last_sync = excluded.last_sync",
      )
      .bind(agencyId, now())
      .run();
  }
  const elapsed = Date.now() - startTime;
  logger.info("surfaceStore/crawl: topology sync completed", {
    agencyId,
    routeCount: routeTags.length,
    elapsedMs: elapsed,
  });
}
