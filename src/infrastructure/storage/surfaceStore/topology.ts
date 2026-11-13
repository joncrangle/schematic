import * as Effect from "effect/Effect";
import type { StaticGtfsFeed } from "~/agencies/types";
import type { D1DatabaseBinding } from "../RuntimeBindings";
import type { BoundingBox } from "~/domain/surface/types";
import type { StaticSnapshot, TopologySource } from "~/domain/surface/topologySource";
import { TopologyError } from "~/domain/surface/topologySource";
import { logger } from "~/infrastructure/logging/logger";
import { makeSurfaceTopologyWriter, type SurfaceTopologyWriter } from "../SurfaceStoreWriter";
import type { RouteInterpretationConfig } from "~/agencies";
import type { SchematicStationIndexEntry } from "~/agencies/types";
import { crawlTopology, probeTopologyFreshness } from "./crawl";
import { fetchTopologySnapshot } from "./reads";
import { createD1SeedSyncStore, probeSeedTopologyFreshness, syncSeedTopology } from "./seedSync";
import type { GtfsProjectionConfig } from "~/infrastructure/gtfs/staticTopology";
import { readGtfsArchiveResponse } from "~/infrastructure/gtfs/archive";

/**
 * D1-backed TopologySource over the surface store seam.
 *
 * Reads the agency surface D1 tables through the shared read path
 * (`reads.fetchTopologySnapshot`) and crawls NextBus through the shared
 * crawl path (`crawl.crawlTopology`). Owns its TTL concern via
 * shouldRefreshTopology and syncTopology (ADR-0005).
 *
 * No `import from '~/agencies'`, core seam (ADR-0007). `fetch` is injected;
 * a NextBus sync without one fails loudly instead of reaching for the
 * global fetch.
 */
export interface D1TopologyReaderOptions {
  readonly d1: D1DatabaseBinding;
  readonly agencyId: string;
  readonly now?: () => number;
  readonly stationIndex?: readonly SchematicStationIndexEntry[];
}

export type D1TopologySourceOptions = D1TopologyReaderOptions & {
  /**
   * NextBus agency slug when it differs from `agencyId`. Declared here
   *, not on the manifest or any Core call site, so agency authors thread it
   * through their own `createTopologySource` adapter (ADR-0007 seam).
   */
  readonly nextbusSlug?: string;
  readonly fetch?: typeof fetch;
  readonly writer?: SurfaceTopologyWriter;
  readonly routeInterpretation?: RouteInterpretationConfig;
  readonly defaultRouteColor?: string;
} & (
    | {
        /** Static GTFS projection configuration, derived from the manifest by the provider factory. */
        readonly seedConfig?: GtfsProjectionConfig & {
          readonly feeds: readonly Pick<
            StaticGtfsFeed,
            "url" | "name" | "stationTimetables" | "zenbus" | "passio" | "samsaraStations"
          >[];
        };
        readonly source: "seed";
        /** Optional for seed, no crawl uses bounds. */
        readonly fallbackBounds?: BoundingBox;
      }
    | {
        /**
         * NextBus agencies require manifestFallbackBounds; misconfiguration fails sync loudly.
         * Thread via manifestFallbackBounds(manifest) in createAgencyProvider.
         */
        readonly source?: "nextbus";
        readonly fallbackBounds: BoundingBox;
      }
  );

export function createD1TopologySource(opts: D1TopologySourceOptions): TopologySource {
  const { d1, agencyId, now = () => Date.now(), fetch: fetchFn } = opts;
  const nextbusSlug = opts.nextbusSlug ?? agencyId;
  const writer = opts.writer ?? makeSurfaceTopologyWriter({ agencyId, db: d1 });
  const fetchTopology = () =>
    Effect.tryPromise({
      try: (): Promise<StaticSnapshot> =>
        fetchTopologySnapshot(d1, {
          agencyId,
          now,
          stationIndex: opts.stationIndex,
          routeInterpretation: opts.routeInterpretation,
        }),
      catch: (cause) =>
        new TopologyError({
          agencyId,
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });

  if (opts.source === "seed") {
    return {
      fetchTopology,
      shouldRefreshTopology: () =>
        Effect.tryPromise({
          try: () => probeSeedTopologyFreshness(d1, agencyId, now),
          catch: (cause) => new TopologyError({ agencyId, message: String(cause), cause }),
        }),
      syncTopology: () =>
        Effect.tryPromise({
          try: async () => {
            const store = createD1SeedSyncStore(d1);
            if (!(await store.hasTopology(agencyId))) {
              logger.warn("Surface topology needs-seed", {
                agencyId,
                command: `bun scripts/seed.ts --agency=${agencyId}`,
              });
              return;
            }
            if (!opts.seedConfig || !fetchFn)
              throw new Error("Seed topology requires manifest configuration and injected fetch");
            const result = await syncSeedTopology({
              config: opts.seedConfig,
              store,
              now,
              archives: async () => {
                const archives: Uint8Array[] = [];
                for (const feed of opts.seedConfig!.feeds) {
                  if (feed.samsaraStations) {
                    const { buildSamsaraStationsArchive } =
                      await import("~/infrastructure/gtfs/samsaraStationsArchive");
                    archives.push(
                      await buildSamsaraStationsArchive({
                        feed: { ...feed, samsaraStations: feed.samsaraStations },
                        fetch: fetchFn,
                      }),
                    );
                    continue;
                  }
                  if (feed.passio) {
                    const { buildPassioArchive } =
                      await import("~/infrastructure/gtfs/passioArchive");
                    archives.push(
                      await buildPassioArchive({
                        feed: { ...feed, passio: feed.passio },
                        fetch: fetchFn,
                      }),
                    );
                    continue;
                  }
                  if (feed.zenbus) {
                    const { buildZenbusArchive } =
                      await import("~/infrastructure/gtfs/zenbusArchive");
                    archives.push(
                      await buildZenbusArchive({
                        feed: { ...feed, zenbus: feed.zenbus },
                        fetch: fetchFn,
                        now: now(),
                      }),
                    );
                    continue;
                  }
                  if (feed.stationTimetables) {
                    const { buildStationTimetableArchive } =
                      await import("~/infrastructure/gtfs/stationTimetableArchive");
                    archives.push(
                      await buildStationTimetableArchive({
                        feed: { ...feed, stationTimetables: feed.stationTimetables },
                        fetch: fetchFn,
                        now: now(),
                      }),
                    );
                    continue;
                  }
                  const response = await fetchFn(feed.url, {
                    headers: { Accept: "application/zip" },
                    signal: AbortSignal.timeout(60_000),
                  });
                  if (!response.ok)
                    throw new Error(`HTTP ${response.status} fetching GTFS ${feed.url}`);
                  archives.push(await readGtfsArchiveResponse(response));
                }
                return archives;
              },
            });
            logger.info("Seed topology refresh completed", {
              agencyId,
              outcome: result.outcome,
              writes: result.writes,
            });
            if (result.movedStops?.length)
              logger.warn(
                "Stops moved; manually regenerate stationIndex and regional interchanges, review and commit the generated artifacts",
                {
                  agencyId,
                  movedStops: result.movedStops,
                  commands: [
                    `bun scripts/seed.ts --agency=${agencyId} --db=sqlite`,
                    "bun scripts/seed.ts --interchange-only",
                  ],
                },
              );
          },
          catch: (cause) =>
            new TopologyError({
              agencyId,
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        }),
    };
  }

  // Fail fast at the topology entry: NextBus agencies
  // require manifestFallbackBounds. The late `fallbackBounds!` null-assert is
  // gone, a misconfigured caller throws here, at construction, not mid-sync.
  const fallbackBounds = opts.fallbackBounds;
  if (!fallbackBounds) {
    throw new Error(
      "surfaceStore/topology: fallbackBounds is required for NextBus agencies (thread manifestFallbackBounds)",
    );
  }

  return {
    fetchTopology,

    shouldRefreshTopology: () =>
      Effect.tryPromise({
        try: () => probeTopologyFreshness(d1, now, agencyId),
        catch: (cause) =>
          new TopologyError({
            agencyId,
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      }),

    syncTopology: () =>
      Effect.tryPromise({
        try: async () => {
          if (!fetchFn) {
            throw new Error(
              "surfaceStore/topology: fetch is required for NextBus sync (inject it, never the global)",
            );
          }
          logger.info("surfaceStore/topology: starting topology sync", { agencyId });
          await crawlTopology({
            d1,
            agencyId,
            agencySlug: nextbusSlug,
            fallbackBounds,
            fetchImpl: fetchFn,
            routeInterpretation: opts.routeInterpretation,
            defaultRouteColor: opts.defaultRouteColor,
            now,
            writer,
          });
        },
        catch: (cause) =>
          new TopologyError({
            agencyId,
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      }),
  };
}
