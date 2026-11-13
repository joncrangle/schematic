vi.mock("~/agencies/agencyCatalog", async () => {
  const { testAgencyCatalog } = await import("../helpers/agency-fixtures");
  return { agencyCatalog: testAgencyCatalog };
});
import { describe, afterEach, expect, it, vi } from "vitest";
import type { AgencyProvider } from "../../src/agencies/types";
import {
  allProviders,
  dangerouslyRegisterProvider,
  dangerouslyResetProviders,
} from "../../src/agencies/registry";
import {
  deriveAgencySeedConfig,
  fetchFeedArchive,
  fetchAllAgencyArchives,
  FeedFetchError,
  getAgencySeedConfig,
  getAllAgencySeedConfigs,
  matchesAgencyScope,
  deriveDirectionLabel,
  escapeSqlValue,
  resolveAgencySqlitePath,
  resolveDataDir,
  resolveGtfsFeedCachePath,
  resolveSeedD1Target,
  seedAgencySqlite,
  TRANSIT_SEED_ONLY_STATEMENTS,
  type AgencySeedConfig,
  type GtfsFeedSource,
} from "../../scripts/lib/gtfs-seeder-core";
import { join, resolve } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  parseCliArgs,
  buildAgencySelectOptions,
  formatStationIndexDriftWarnings,
  replaceStationIndexInSchematic,
  runSeeder,
} from "../../scripts/seed";
import { makeTestProvider } from "../helpers/agency-fixtures";
import { gtfsZip, topologyArchive } from "../helpers/gtfsArchive";
import { projectGtfsTopology } from "~/infrastructure/gtfs/staticTopology";

const registeredSeedableIds = allProviders()
  .filter((provider) => provider.staticTopology?.feeds?.length)
  .map((provider) => provider.manifest.id);

describe("GTFS Seeder Core & Configurations", () => {
  it.each(["explicit", "official"])(
    "bounds the %s archive download before consuming an oversized body",
    async (source) => {
      const pull = vi.fn((controller) => controller.close());
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(body, { headers: { "content-length": "134217729" } })),
      );
      vi.stubEnv("DATA_DIR", "/nonexistent-gtfs-limit-test");
      try {
        await expect(
          fetchFeedArchive(
            { url: "https://example.test/gtfs.zip", cacheFileName: "fixture.zip" },
            "sample",
            source === "explicit" ? "https://example.test/explicit.zip" : undefined,
          ),
        ).rejects.toThrow(/archive.*limit/i);
        expect(pull).not.toHaveBeenCalled();
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(body.locked).toBe(false);
      } finally {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
      }
    },
  );

  it("replaces a schematic station index without rewriting unrelated JSON", () => {
    const source = `{
  "sequences": {"A": ["Central"]},
  "stationIndex": [{"id":"old","name":"Old","lat":1,"lon":2,"lines":["A"],"platformIds":[]}]
}
`;
    const stationIndex = [
      {
        id: "central-id",
        name: "Central",
        lat: 43.1,
        lon: -79.1,
        lines: ["A"],
        platformIds: ["central-platform"],
      },
    ];

    const updated = replaceStationIndexInSchematic(source, stationIndex);

    expect(JSON.parse(updated)).toMatchObject({ sequences: { A: ["Central"] }, stationIndex });
  });

  describe("Agency config derivation from manifests", () => {
    it("discovers all registered seedable agencies via getAllAgencySeedConfigs", () => {
      const configs = getAllAgencySeedConfigs();
      const ids = configs.map((c) => c.id);
      expect(ids).toEqual(
        [...registeredSeedableIds].sort((left, right) => left.localeCompare(right)),
      );
    });

    it.each([
      {
        label: "omitted",
        settings: {},
        defaultColor: "#64748B",
        defaultTextColor: "#FFFFFF",
        routeIdField: "id",
      },
      {
        label: "empty colors",
        settings: { defaultColor: "", defaultTextColor: "" },
        defaultColor: "#64748B",
        defaultTextColor: "#FFFFFF",
        routeIdField: "id",
      },
      {
        label: "explicit",
        settings: {
          defaultColor: "#123456",
          defaultTextColor: "#ABCDEF",
          routeIdField: "short_name" as const,
        },
        defaultColor: "#123456",
        defaultTextColor: "#ABCDEF",
        routeIdField: "short_name",
      },
    ])(
      "derives valid AgencySeedConfig with $label projection settings",
      ({ settings, defaultColor, defaultTextColor, routeIdField }) => {
        const syntheticProvider: AgencyProvider = {
          manifest: {
            id: "fake-transit",
            name: "Fake Transit",
            locale: "en-CA",
            timezone: "America/Toronto",
            bounds: [{ minLat: 40, maxLat: 45, minLon: -80, maxLon: -75 }],
            modes: ["rail", "bus", "streetcar", "subway"] as const,
            stationService: { routeType: "bus" },
            attribution: { name: "Fake", url: "https://fake.test", license: "MIT" },
            status: "experimental" as const,
          },
          staticTopology: {
            feeds: [
              { name: "Primary", url: "https://fake.test/gtfs.zip", cacheFileName: "fake.zip" },
            ],
            ...settings,
          },
          schematic: {
            viewBoxWidth: 100,
            viewBoxHeight: 100,
            lines: [],
            stations: [],
            viewport: {
              bounds: { minX: 0, maxX: 100, minY: 0, maxY: 100 },
              minZoom: 1,
              maxZoom: 2,
            },
            geoProjection: {
              refLonWest: -80,
              refLonEast: -75,
              refXWest: 0,
              refXEast: 100,
              refLatNorth: 45,
              refLatSouth: 40,
              refYNorth: 0,
              refYSouth: 100,
            },
          },
        };

        const derived = deriveAgencySeedConfig(syntheticProvider);
        expect(derived.id).toBe("fake-transit");
        expect(derived.name).toBe("Fake Transit");
        expect(derived.bindingName).toBe("DB_TRANSIT");
        expect(derived.dbFileName).toBe("transit.db");
        expect(derived.defaultColor).toBe(defaultColor);
        expect(derived.defaultTextColor).toBe(defaultTextColor);
        expect(derived.routeTypes.has(0)).toBe(true); // streetcar
        expect(derived.routeTypes.has(1)).toBe(true); // subway topology serves the route strip
        expect(derived.routeTypes.has(2)).toBe(true); // rail
        expect(derived.routeTypes.has(3)).toBe(true); // bus
        expect(derived.routeIdField).toBe(routeIdField);
      },
    );
  });

  describe("CLI argument parser (parseCliArgs)", () => {
    it("parses empty arguments", () => {
      expect(parseCliArgs([])).toEqual({
        agencies: [],
        dbTarget: undefined,
        zipArg: undefined,
      });
    });

    it("parses single agency flag", () => {
      expect(parseCliArgs(["--agency=regional"])).toEqual({
        agencies: ["regional"],
        dbTarget: undefined,
        zipArg: undefined,
      });
    });

    it("expands --agency=all to all configured agencies", () => {
      const parsed = parseCliArgs(["--agency=all"]);
      expect(parsed.agencies).toEqual(
        [...registeredSeedableIds].sort((left, right) => left.localeCompare(right)),
      );
    });

    it("labels the select-all row without listing agencies", () => {
      const options = buildAgencySelectOptions(getAllAgencySeedConfigs());
      expect(options[0]).toMatchObject({ id: "all", label: "All agencies" });
      expect(options[0]?.label).not.toContain("(");
    });

    it("indents member agencies beneath their region header", () => {
      const options = buildAgencySelectOptions(getAllAgencySeedConfigs());
      const header = options.find((option) => option.isHeader);
      expect(header?.group).toBeDefined();
      const members = options.filter(
        (option) => !option.isHeader && option.id !== "all" && option.group === header?.group,
      );
      expect(members.length).toBeGreaterThan(0);
      for (const member of members) expect(member.indent).toBe(1);
    });

    it("parses comma-separated agencies without duplicates", () => {
      const parsed = parseCliArgs(["--agency=sample,regional,sample"]);
      expect(parsed.agencies).toEqual(["sample", "regional"]);
    });

    it("selects agencies by hierarchical scope or canonical agency path", () => {
      const scope = "ca/on";
      const expectedScopeIds = getAllAgencySeedConfigs()
        .filter((config) => matchesAgencyScope(config, scope))
        .map((config) => config.id);
      const parsedScope = parseCliArgs([`--scope=${scope}`]);

      expect(parsedScope.agencies).toEqual(expectedScopeIds);
      const hamilton = getAllAgencySeedConfigs().find((config) =>
        matchesAgencyScope(config, scope),
      );
      expect(hamilton).toBeDefined();
      expect(parsedScope.agencies).toContain(hamilton!.id);
      expect(parsedScope.agencies.every((agencyId) => getAgencySeedConfig(agencyId))).toBe(true);
      expect(parseCliArgs(["--agency=ca/on/regional"]).agencies).toEqual(["ca/on/regional"]);
      expect(matchesAgencyScope(getAgencySeedConfig("regional")!, scope)).toBe(true);
      expect(matchesAgencyScope(getAgencySeedConfig("regional")!, "intl")).toBe(false);
    });

    it("parses --db flag correctly", () => {
      expect(parseCliArgs(["--db=sqlite"]).dbTarget).toBe("sqlite");
      expect(parseCliArgs(["--db=d1"]).dbTarget).toBe("d1");
      expect(parseCliArgs(["--db=both"]).dbTarget).toBe("both");
      expect(parseCliArgs(["--db=remote"]).dbTarget).toBe("remote");
      expect(() => parseCliArgs(["--db=invalid"])).toThrow(/invalid --db value/i);
    });

    it("parses --zip flag", () => {
      expect(parseCliArgs(["--zip=/tmp/data.zip"]).zipArg).toBe("/tmp/data.zip");
    });

    it("rejects a zip override for multiple agencies", () => {
      expect(() => parseCliArgs(["--agency=sample,regional", "--zip=/tmp/data.zip"])).toThrow(
        /--zip can only be used with one agency/i,
      );
    });

    it("does not let the seeder API ignore a zip override for multiple agencies", async () => {
      const fetchArchives = vi.fn();
      await expect(
        runSeeder({
          agencies: ["sample", "regional"],
          dbTarget: "sqlite",
          zipArg: "/tmp/data.zip",
          fetchArchives,
        }),
      ).rejects.toThrow(/--zip can only be used with one agency/i);
      expect(fetchArchives).not.toHaveBeenCalled();
    });

    it("detects help flags", () => {
      expect(parseCliArgs(["-h"]).isHelp).toBe(true);
      expect(parseCliArgs(["--help"]).isHelp).toBe(true);
    });

    it("accepts interchange-only mode without selecting a database target", () => {
      expect(parseCliArgs(["--interchange-only"])).toMatchObject({
        agencies: [],
        interchangesOnly: true,
      });
    });
  });

  describe("deriveDirectionLabel", () => {
    // The headsign is the operator's claim about where a rider ends up, so a
    // compass word inside it is authoritative and no label is invented in its
    // absence. The canonical per-route-type literal is not a substitute: it
    // labelled a "Westbound to Brampton" bus "Southbound".
    it("uses the compass the operator stated alongside a separator", () => {
      expect(deriveDirectionLabel("East - 504 King to Dundas West Station")).toBe("Eastbound");
      expect(deriveDirectionLabel("South - 6 Bay to Bloor")).toBe("Southbound");
    });

    it("reads a leading compass word the separator grammar would skip", () => {
      expect(deriveDirectionLabel("Westbound to Brampton")).toBe("Westbound");
      expect(deriveDirectionLabel("North to Steeles Ave")).toBe("Northbound");
    });

    it("states no compass when the headsign carries none to read", () => {
      expect(deriveDirectionLabel("Fairway Station")).toBe("");
      expect(deriveDirectionLabel("51 HEREFORD EAST")).toBe("");
      expect(deriveDirectionLabel("")).toBe("");
    });

    it("leaves the label empty for a headsign it cannot read", () => {
      expect(deriveDirectionLabel("Express Special")).toBe("");
    });
  });

  describe("resolveSeedD1Target", () => {
    it("defaults to the DB_TRANSIT binding when no flags are given", () => {
      expect(resolveSeedD1Target([])).toMatchObject({
        bindingName: "DB_TRANSIT",
      });
    });

    it.each(registeredSeedableIds)("resolves to DB_TRANSIT for --agency=%s", (agencyId) => {
      expect(resolveSeedD1Target([`--agency=${agencyId}`])).toEqual({
        agencyId,
        bindingName: "DB_TRANSIT",
      });
    });

    it("lets --binding override the derived name", () => {
      expect(resolveSeedD1Target(["--agency=regional", "--binding=DB_CUSTOM"])).toEqual({
        agencyId: "regional",
        bindingName: "DB_CUSTOM",
      });
    });

    it("ignores positional and unrelated flags", () => {
      expect(resolveSeedD1Target(["--target=d1", "./data/transit.db"])).toMatchObject({
        bindingName: "DB_TRANSIT",
      });
    });

    it("rejects an empty --agency value", () => {
      expect(() => resolveSeedD1Target(["--agency="])).toThrow(/--agency/);
    });
  });

  describe("SQL generation helpers", () => {
    it("escapes SQL values securely", () => {
      expect(escapeSqlValue("King St 'West'")).toBe("'King St ''West'''");
      expect(escapeSqlValue(null)).toBe("NULL");
      expect(escapeSqlValue(undefined)).toBe("NULL");
      expect(escapeSqlValue(42)).toBe("42");
      expect(escapeSqlValue(true)).toBe("1");
      expect(escapeSqlValue(false)).toBe("0");
    });

    it("keeps literal newlines off the wire via char(10) concatenation", () => {
      const fragment = `INSERT INTO t (v) VALUES (${escapeSqlValue("line1\nline2")});`;
      expect(fragment).toBe("INSERT INTO t (v) VALUES ('line1' || char(10) || 'line2');");
      expect(fragment.includes("\n")).toBe(false);
    });

    it("rejects unsupported SQL literal types", () => {
      expect(() => escapeSqlValue(Symbol("unsupported"))).toThrow(
        "escapeSqlValue: unsupported value type symbol",
      );
    });
  });

  describe("seed schema composition", () => {
    it("owns only seed-specific tables outside the surface module", () => {
      const seedSql = TRANSIT_SEED_ONLY_STATEMENTS.join("\n");
      for (const table of [
        "feed_metadata",
        "transit_snapshots",
        "transit_network",
        "transit_upcoming",
      ]) {
        expect(seedSql).toContain(table);
      }
      for (const surfaceTable of [
        "routes (",
        "stops (",
        "route_shapes (",
        "route_stops (",
        "stop_routes (",
        "topology_meta (",
      ]) {
        expect(seedSql).not.toContain(`CREATE TABLE IF NOT EXISTS ${surfaceTable}`);
      }
    });

    it("keeps every seed-only statement on a single physical line", () => {
      for (const statement of TRANSIT_SEED_ONLY_STATEMENTS) {
        expect(statement).not.toContain("\n");
      }
      const sql = `${TRANSIT_SEED_ONLY_STATEMENTS.join(";\n")};`;
      for (const fragment of sql.split(";\n")) {
        expect(fragment.replace(/\s+$/, "")).not.toContain("\n");
      }
    });
  });

  describe("resolveAgencySqlitePath", () => {
    const config = getAgencySeedConfig("regional")!;

    it("prefers explicit dbPath argument", () => {
      expect(resolveAgencySqlitePath(config, "/custom/path.db")).toBe("/custom/path.db");
    });

    it("resolves against DATA_DIR directory when set", () => {
      const prevDataDir = process.env.DATA_DIR;
      try {
        process.env.DATA_DIR = "/custom/data";
        expect(resolveAgencySqlitePath(config)).toBe(resolve("/custom/data", "transit.db"));
      } finally {
        if (prevDataDir === undefined) delete process.env.DATA_DIR;
        else process.env.DATA_DIR = prevDataDir;
      }
    });

    it("resolves feed cache path against DATA_DIR", () => {
      const prevDataDir = process.env.DATA_DIR;
      try {
        process.env.DATA_DIR = "/custom/gtfs-cache";
        expect(resolveDataDir()).toBe(resolve("/custom/gtfs-cache"));
        expect(resolveGtfsFeedCachePath({ url: "", cacheFileName: "kingston-gtfs.zip" })).toBe(
          resolve("/custom/gtfs-cache", "kingston-gtfs.zip"),
        );
      } finally {
        if (prevDataDir === undefined) delete process.env.DATA_DIR;
        else process.env.DATA_DIR = prevDataDir;
      }
    });
  });

  describe("unavailable feeds", () => {
    const feed: GtfsFeedSource = {
      name: "Sample",
      url: "https://example.test/gtfs.zip",
      cacheFileName: "sample-gtfs.zip",
    };
    const cachedArchive = Buffer.from("PKcached-archive-bytes");

    /** The two shapes an outage takes: a rejected request or a non-OK status. */
    const outages = [
      { name: "network failure", download: () => Promise.reject(new TypeError("fetch failed")) },
      {
        name: "non-OK response",
        download: () =>
          Promise.resolve(new Response("unavailable", { status: 503, statusText: "Unavailable" })),
      },
    ];

    /** The freshness HEAD reports a newer archive, so the seeder commits to a GET. */
    function stubDownload(download: () => Promise<Response>) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: unknown, init?: RequestInit) =>
          (init?.method ?? "GET").toUpperCase() === "HEAD"
            ? new Response(null, { status: 200, headers: { "content-length": "999999" } })
            : download(),
        ),
      );
    }

    function captureWarnings(): string[] {
      const warnings: string[] = [];
      vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      });
      vi.spyOn(console, "log").mockImplementation(() => {});
      return warnings;
    }

    /** A throwaway DATA_DIR so no test reads or writes the real cache. */
    function useTempDataDir(label: string): string {
      const dataDir = mkdtempSync(join(tmpdir(), `seed-${label}-`));
      vi.stubEnv("DATA_DIR", dataDir);
      return dataDir;
    }

    afterEach(() => {
      dangerouslyResetProviders();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });

    it.each(outages)(
      "seeds from the cached archive and leaves it untouched after a $name",
      async ({ download }) => {
        const dataDir = useTempDataDir("cached");
        const cachePath = join(dataDir, feed.cacheFileName);
        writeFileSync(cachePath, cachedArchive);
        stubDownload(download);

        try {
          expect(await fetchFeedArchive(feed, "sample")).toEqual(cachedArchive);
          // A failed download must never rewrite or truncate the last good archive.
          expect(readFileSync(cachePath)).toEqual(cachedArchive);
        } finally {
          rmSync(dataDir, { recursive: true, force: true });
        }
      },
    );

    it.each(outages)("reports an uncached feed as skipped after a $name", async ({ download }) => {
      const dataDir = useTempDataDir("uncached");
      const warnings = captureWarnings();
      stubDownload(download);

      try {
        await expect(fetchFeedArchive(feed, "sample")).rejects.toBeInstanceOf(FeedFetchError);
        expect(warnings.join("\n")).toContain(`${feed.cacheFileName} download failed`);
        expect(existsSync(join(dataDir, feed.cacheFileName))).toBe(false);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it("preserves metadata for concurrently downloaded feeds", async () => {
      const dataDir = useTempDataDir("concurrent-meta");
      const feeds = [
        { url: "https://example.test/first.zip", cacheFileName: "first.zip" },
        { url: "https://example.test/second.zip", cacheFileName: "second.zip" },
      ];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          expect(init?.method ?? "GET").toBe("GET");
          const first = String(input).includes("first");
          return new Response(first ? "first archive" : "second archive", {
            headers: { etag: first ? '"first-etag"' : '"second-etag"' },
          });
        }),
      );

      await Promise.all(feeds.map((feed) => fetchFeedArchive(feed, "sample")));

      expect(
        JSON.parse(readFileSync(join(dataDir, ".gtfs-cache-meta.json"), "utf8")),
      ).toMatchObject({
        "first.zip": { etag: '"first-etag"' },
        "second.zip": { etag: '"second-etag"' },
      });
    });

    function registerFictionalMultiFeedAgency() {
      const provider = makeTestProvider({
        id: "fictional-multi-feed",
        name: "Fictional Multi-feed Transit",
        staticTopology: {
          source: "seed",
          feeds: [
            {
              name: "Bus feed",
              url: "https://example.test/bus.zip",
              cacheFileName: "fictional-bus.zip",
            },
            {
              name: "Rail feed",
              url: "https://example.test/rail.zip",
              cacheFileName: "fictional-rail.zip",
            },
          ],
        },
      });
      dangerouslyRegisterProvider(provider);
      return deriveAgencySeedConfig(provider);
    }

    function registerFictionalSingleFeedAgency() {
      const provider = makeTestProvider({
        id: "fictional-single-feed",
        name: "Fictional Local Transit",
        staticTopology: {
          source: "seed",
          feeds: [
            {
              name: "Local feed",
              url: "https://example.test/local.zip",
              cacheFileName: "fictional-local.zip",
            },
          ],
        },
      });
      dangerouslyRegisterProvider(provider);
      return deriveAgencySeedConfig(provider);
    }

    it("skips an agency with an empty required GTFS file before seeding other agencies", async () => {
      const incomplete = registerFictionalMultiFeedAgency();
      const healthy = registerFictionalSingleFeedAgency();
      const warnings = captureWarnings();
      const emptyStopTimes = Buffer.from(
        gtfsZip({
          "routes.txt": "route_id,route_type\nr,3\n",
          "trips.txt": "route_id,trip_id\nr,t\n",
          "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\nP,Main,43,-79\n",
          "stop_times.txt": "",
        }),
      );
      const complete = Buffer.from(topologyArchive());
      const committed: string[] = [];
      const compileInterchangesStep = vi.fn();
      const result = await runSeeder({
        agencies: [incomplete.id, healthy.id],
        dbTarget: "sqlite",
        fetchArchives: async (config) => ({
          buffers: config.id === incomplete.id ? [complete, emptyStopTimes] : [complete],
          failures: [],
        }),
        seedAgency: async (config, buffers) => {
          await projectGtfsTopology(buffers, config);
          committed.push(config.id);
          return undefined;
        },
        compileInterchangesStep,
      });
      expect(result.skippedAgencyIds).toEqual([incomplete.id]);
      expect(result.seededAgencyIds).toEqual([healthy.id]);
      expect(committed).toEqual([healthy.id]);
      expect(warnings.join("\n")).toContain("stop_times.txt is empty");
      expect(compileInterchangesStep).toHaveBeenCalledWith(
        new Map(),
        [incomplete.id, healthy.id],
        [healthy.id],
      );
    });

    it("propagates seed failures other than incomplete feed input", async () => {
      const config = registerFictionalSingleFeedAgency();
      captureWarnings();
      await expect(
        runSeeder({
          agencies: [config.id],
          dbTarget: "sqlite",
          fetchArchives: async () => ({ buffers: [Buffer.from(topologyArchive())], failures: [] }),
          seedAgency: async () => {
            throw new Error("database unavailable");
          },
          compileInterchangesStep: vi.fn(),
        }),
      ).rejects.toThrow("database unavailable");
    });

    it("skips a fictional multi-feed agency when one feed returns FeedFetchError", async () => {
      const config = registerFictionalMultiFeedAgency();
      const healthyConfig = registerFictionalSingleFeedAgency();
      const dataDir = useTempDataDir("partial-multifeed");
      const warnings = captureWarnings();
      const fetch = vi.fn(async (input: RequestInfo | URL) =>
        String(input) === config.feeds[1].url
          ? new Response("unavailable", { status: 503, statusText: "Unavailable" })
          : new Response("archive"),
      );
      vi.stubGlobal("fetch", fetch);
      const compileInterchangesStep = vi.fn();
      const seedAgency = vi.fn(async (seedConfig: AgencySeedConfig) => {
        writeFileSync(join(dataDir, `${seedConfig.id}.db`), "seeded");
        return undefined;
      });

      try {
        const result = await runSeeder({
          agencies: [config.id, healthyConfig.id],
          dbTarget: "sqlite",
          seedAgency,
          compileInterchangesStep,
        });

        expect(result).toMatchObject({
          requestedAgencyIds: [config.id, healthyConfig.id],
          seededAgencyIds: [healthyConfig.id],
          skippedAgencyIds: [config.id],
        });
        expect(result.skippedFeeds).toHaveLength(1);
        expect(result.skippedFeeds[0]).toMatchObject({
          agencyId: config.id,
          feed: config.feeds[1],
          reason: expect.stringContaining("HTTP 503"),
        });
        expect(fetch).toHaveBeenCalledTimes(3);
        expect(seedAgency.mock.calls.map(([candidate]) => candidate.id)).toEqual([
          healthyConfig.id,
        ]);
        expect(compileInterchangesStep).toHaveBeenCalledTimes(1);
        expect(existsSync(join(dataDir, `${config.id}.db`))).toBe(false);
        expect(existsSync(join(dataDir, `${healthyConfig.id}.db`))).toBe(true);
        expect(existsSync(join(dataDir, "transit.db"))).toBe(false);
        expect(warnings.join("\n")).toContain("Skipped 1 agency(ies)");
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it("refuses to seed when archive count is incomplete even without a reported failure", async () => {
      const config = registerFictionalMultiFeedAgency();
      const dataDir = useTempDataDir("missing-multifeed-archive");
      const topologyPath = join(dataDir, "topology-write.txt");
      const compileInterchangesStep = vi.fn();
      const seedAgency = vi.fn(async () => {
        writeFileSync(topologyPath, "seeded");
        return undefined;
      });

      try {
        const result = await runSeeder({
          agencies: [config.id],
          dbTarget: "sqlite",
          fetchArchives: async () => ({ buffers: [Buffer.from("bus archive")], failures: [] }),
          seedAgency,
          compileInterchangesStep,
        });

        expect(result.skippedAgencyIds).toEqual([config.id]);
        expect(result.skippedFeeds).toEqual([]);
        expect(seedAgency).not.toHaveBeenCalled();
        expect(compileInterchangesStep).toHaveBeenCalledTimes(1);
        expect(existsSync(topologyPath)).toBe(false);
        expect(existsSync(join(dataDir, "transit.db"))).toBe(false);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it("rejects a multi-feed SQLite sync before creating its database when archives are missing", async () => {
      const config = registerFictionalMultiFeedAgency();
      const dataDir = useTempDataDir("sync-count-guard");
      const dbPath = join(dataDir, "nested", "transit.db");

      try {
        await expect(
          seedAgencySqlite(config, [Buffer.from("bus archive")], dbPath),
        ).rejects.toThrow(/archive count.*1.*2|2.*declared feeds/i);
        expect(existsSync(join(dataDir, "nested"))).toBe(false);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    });
  });
  describe("feed archive cache freshness", () => {
    const feed: GtfsFeedSource = {
      name: "Sample feed",
      url: "https://example.test/gtfs.zip",
      cacheFileName: "sample-gtfs.zip",
    };
    const cachedArchive = Buffer.from("PK-cached-fictional-feed");
    const downloadedArchive = Buffer.from("PK-downloaded-fictional-feed");
    const dataDirs: string[] = [];

    function createDataDir(label: string): string {
      const dataDir = mkdtempSync(join(tmpdir(), `seed-${label}-`));
      dataDirs.push(dataDir);
      vi.stubEnv("DATA_DIR", dataDir);
      return dataDir;
    }

    function createCache(metadata: Record<string, unknown> = {}): string {
      const dataDir = createDataDir("freshness");
      writeFileSync(join(dataDir, feed.cacheFileName), cachedArchive);
      writeFileSync(
        join(dataDir, ".gtfs-cache-meta.json"),
        JSON.stringify({ [feed.cacheFileName]: metadata }),
      );
      return dataDir;
    }

    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      for (const dataDir of dataDirs.splice(0)) rmSync(dataDir, { recursive: true, force: true });
    });

    it.each([
      {
        name: "a 304 response",
        metadata: { etag: '"v1"' },
        head: () => new Response(null, { status: 304 }),
        expected: cachedArchive,
        expectedGetRequests: 0,
      },
      {
        name: "a matching ETag and content length",
        metadata: { etag: '"v1"' },
        head: () =>
          new Response(null, {
            headers: { etag: '"v1"', "content-length": String(cachedArchive.length) },
          }),
        expected: cachedArchive,
        expectedGetRequests: 0,
      },
      {
        name: "a matching Last-Modified value and content length",
        metadata: { lastModified: "Wed, 15 Jan 2025 12:00:00 GMT" },
        head: () =>
          new Response(null, {
            headers: {
              "last-modified": "Wed, 15 Jan 2025 12:00:00 GMT",
              "content-length": String(cachedArchive.length),
            },
          }),
        expected: cachedArchive,
        expectedGetRequests: 0,
      },
      {
        name: "a matching content length without a matching validator",
        metadata: { etag: '"old"' },
        head: () =>
          new Response(null, {
            headers: { etag: '"new"', "content-length": String(cachedArchive.length) },
          }),
        expected: downloadedArchive,
        expectedGetRequests: 1,
      },
      {
        name: "a rejected HEAD request",
        metadata: { etag: '"v1"' },
        head: () => Promise.reject(new TypeError("network unavailable")),
        expected: cachedArchive,
        expectedGetRequests: 0,
      },
    ])(
      "chooses the cache or download for $name and requests GET the expected number of times",
      async ({ metadata, head, expected, expectedGetRequests }) => {
        createCache(metadata);
        const methods: string[] = [];
        vi.stubGlobal(
          "fetch",
          vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            const method = (init?.method ?? "GET").toUpperCase();
            methods.push(method);
            return method === "HEAD" ? await head() : new Response(downloadedArchive);
          }),
        );

        expect(await fetchFeedArchive(feed, "fictional-cache-case")).toEqual(expected);
        expect(methods.filter((method) => method === "HEAD")).toHaveLength(1);
        expect(methods.filter((method) => method === "GET")).toHaveLength(expectedGetRequests);
      },
    );

    it("throws when the cached file disappears after a 304 freshness response", async () => {
      const dataDir = createCache({ etag: '"v1"' });
      const cachePath = join(dataDir, feed.cacheFileName);
      const methods: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          const method = (init?.method ?? "GET").toUpperCase();
          methods.push(method);
          if (method === "HEAD") {
            unlinkSync(cachePath);
            return new Response(null, { status: 304 });
          }
          return new Response(downloadedArchive);
        }),
      );

      await expect(fetchFeedArchive(feed, "fictional-cache-case")).rejects.toThrow(
        /Cached GTFS archive disappeared/,
      );
      expect(methods).toEqual(["HEAD"]);
    });

    it("writes a successful download and its validators to the cache", async () => {
      const dataDir = createDataDir("download");
      const methods: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          methods.push((init?.method ?? "GET").toUpperCase());
          return new Response(downloadedArchive, {
            headers: {
              etag: '"downloaded"',
              "last-modified": "Thu, 16 Jan 2025 12:00:00 GMT",
            },
          });
        }),
      );

      expect(await fetchFeedArchive(feed, "fictional-cache-case")).toEqual(downloadedArchive);
      expect(methods).toEqual(["GET"]);
      expect(readFileSync(join(dataDir, feed.cacheFileName))).toEqual(downloadedArchive);
      expect(
        JSON.parse(readFileSync(join(dataDir, ".gtfs-cache-meta.json"), "utf8")),
      ).toMatchObject({
        [feed.cacheFileName]: {
          etag: '"downloaded"',
          lastModified: "Thu, 16 Jan 2025 12:00:00 GMT",
          size: downloadedArchive.length,
        },
      });
    });

    it("rejects an explicit example.test URL when the response is not OK", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("unavailable", { status: 503, statusText: "Unavailable" })),
      );

      await expect(
        fetchFeedArchive(feed, "fictional-explicit-url", "https://example.test/override.zip"),
      ).rejects.toThrow("Failed to download GTFS feed: 503 Unavailable");
      expect(fetch).toHaveBeenCalledWith("https://example.test/override.zip", {
        headers: { Accept: "*/*" },
      });
    });

    it("rejects a missing explicit local path without fetching", async () => {
      const dataDir = createDataDir("missing-local");
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        fetchFeedArchive(feed, "fictional-local-path", join(dataDir, "missing.zip")),
      ).rejects.toThrow(/ZIP file not found/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rethrows non-feed failures from a fictional multi-feed archive fetch", async () => {
      createDataDir("oversized-feed");
      const config = deriveAgencySeedConfig(
        makeTestProvider({
          id: "fictional-oversized-feed",
          name: "Fictional Oversized Feed",
          staticTopology: {
            source: "seed",
            feeds: [
              {
                name: "Oversized feed",
                url: "https://example.test/oversized.zip",
                cacheFileName: "oversized.zip",
              },
              {
                name: "Healthy feed",
                url: "https://example.test/healthy.zip",
                cacheFileName: "healthy.zip",
              },
            ],
          },
        }),
      );
      const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("oversized")
          ? new Response(null, { headers: { "content-length": "134217729" } })
          : new Response("healthy archive"),
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(fetchAllAgencyArchives(config)).rejects.toThrow(
        "GTFS archive exceeds the compressed byte limit",
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("station index drift warnings", () => {
    const healthyIndex = [
      {
        id: "a",
        schematicId: "a",
        name: "A",
        lat: 1,
        lon: 1,
        lines: ["1"],
        platformIds: ["p1"],
      },
    ];

    it("stays silent when every curated station and route resolves", () => {
      expect(
        formatStationIndexDriftWarnings("test", {
          sequences: { "1": ["a"] },
          stationIndex: healthyIndex,
          aliasCandidates: [],
          unmatchedPlatforms: [],
          popularRoutes: ["1"],
          feedRouteIds: ["1"],
          routeLineMap: {},
        }),
      ).toEqual([]);
    });

    it("names stranded stations, alias candidates, unmatched platforms, and missing routes", () => {
      const warnings = formatStationIndexDriftWarnings("test", {
        sequences: { "1": ["a", "b"] },
        stationIndex: healthyIndex,
        aliasCandidates: [{ stopName: "Avenue Station", schematicId: "a" }],
        unmatchedPlatforms: [
          { stopId: "x1", name: "Ghost", parentStation: "zzz", knownParent: false },
        ],
        popularRoutes: ["1", "9"],
        feedRouteIds: ["1"],
        routeLineMap: {},
      });

      expect(warnings).toHaveLength(4);
      expect(warnings[0]).toContain("b");
      expect(warnings[1]).toContain('"Avenue Station" → a');
      expect(warnings[2]).toContain("x1 (Ghost)");
      expect(warnings[3]).toContain("9");
    });
  });
});
