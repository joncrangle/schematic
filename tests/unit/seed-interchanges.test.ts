import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as registry from "~/agencies/registry";
import * as seedCore from "../../scripts/lib/gtfs-seeder-core";
import { runSeeder } from "../../scripts/seed";

vi.mock("~/agencies/agencyCatalog", async () => {
  const { testAgencyCatalog } = await import("../helpers/agency-fixtures");
  return { agencyCatalog: testAgencyCatalog };
});

let root: string;
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

it.each([false, true])(
  "writes the second artifact independently while preserving the first, missing dependencies: %s",
  async (missingDependencies) => {
    root = mkdtempSync(join(tmpdir(), "interchange-regions-"));
    const base = seedCore.getAllAgencySeedConfigs()[0];
    vi.spyOn(registry, "allProviders").mockReturnValue([]);
    const configs = [
      { ...base, id: "alpha", scopePath: "ca/first/alpha" },
      { ...base, id: "beta", scopePath: "ca/second/beta" },
      { ...base, id: "gamma", scopePath: "ca/second/gamma" },
    ];
    for (const region of ["first", "second"]) {
      mkdirSync(join(root, "src/agencies/ca", region), { recursive: true });
    }
    const firstPath = join(root, "src/agencies/ca/first/interchanges.jsonc");
    const previous =
      "// Preserve this artifact byte for byte\n" +
      JSON.stringify(
        missingDependencies
          ? [
              {
                id: "existing-hub",
                endpoints: [
                  { agencyId: "alpha", stationName: "Central" },
                  { agencyId: "unseeded", stationName: "Central" },
                ],
              },
            ]
          : [],
      ) +
      "\n";
    writeFileSync(firstPath, previous);
    if (missingDependencies) {
      writeFileSync(
        join(root, "src/agencies/ca/first/interchanges.overrides.json"),
        JSON.stringify({
          hubs: [],
          exclusions: [
            {
              left: { agencyId: "alpha", stationName: "Central", feedStopIds: ["absent"] },
              right: { agencyId: "beta", stationName: "Central" },
            },
          ],
          isolated: [{ agencyId: "alpha", stationName: "Central", feedStopIds: ["absent"] }],
        }),
      );
    }
    const db = join(root, "transit.db");
    writeFileSync(db, "fixture");
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(seedCore, "getAllAgencySeedConfigs").mockReturnValue(configs);
    vi.spyOn(seedCore, "getAgencySeedConfig").mockImplementation((id) =>
      configs.find((c) => c.id === id),
    );
    vi.spyOn(seedCore, "resolveAgencySqlitePath").mockReturnValue(db);
    vi.spyOn(seedCore, "readSeededTables").mockImplementation((_path, id) =>
      id === "alpha"
        ? []
        : [
            { table: "routes", rows: [{ id: "rail", route_type: 2 }] },
            {
              table: "stops",
              rows: [
                { id: "central", name: "Central", lat: 45, lon: -73, routes_json: '["rail"]' },
              ],
            },
          ],
    );
    await runSeeder({
      agencies: missingDependencies ? ["alpha", "beta"] : ["beta"],
      dbTarget: "sqlite",
      fetchArchives: async () => ({
        buffers: base.feeds.map(() => Buffer.from("fixture")),
        failures: [],
      }),
      seedAgency: async () => db,
    });
    const secondPath = join(root, "src/agencies/ca/second/interchanges.jsonc");
    expect(existsSync(secondPath)).toBe(true);
    expect(readFileSync(secondPath, "utf8")).toContain('"beta"');
    expect(readFileSync(firstPath, "utf8")).toBe(previous);
  },
);

it.each([
  { scope: "regional" as const, scopePath: "us/border/zeta" },
  { scope: "national" as const, scopePath: "ca/nat/zeta" },
  { scope: "international" as const, scopePath: "intl/zeta" },
])(
  "a $scope operator connects across regions without duplicating hubs",
  async ({ scope, scopePath }) => {
    root = mkdtempSync(join(tmpdir(), "interchange-cross-region-"));
    const base = seedCore.getAllAgencySeedConfigs()[0];
    vi.spyOn(registry, "allProviders").mockReturnValue([]);
    const configs = [
      { ...base, id: "alpha", scopePath: "ca/first/alpha" },
      { ...base, id: "beta", scopePath: "ca/second/beta" },
      { ...base, id: "zeta", scope, scopePath },
    ];
    const db = join(root, "transit.db");
    writeFileSync(db, "fixture");
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(seedCore, "getAllAgencySeedConfigs").mockReturnValue(configs);
    vi.spyOn(seedCore, "getAgencySeedConfig").mockImplementation((id) =>
      configs.find((c) => c.id === id),
    );
    vi.spyOn(seedCore, "resolveAgencySqlitePath").mockReturnValue(db);
    vi.spyOn(seedCore, "readSeededTables").mockImplementation((_path, id) => [
      { table: "routes", rows: [{ id: "rail", route_type: 2 }] },
      {
        table: "stops",
        rows: (id === "zeta" ? [45, 46] : id === "alpha" ? [45] : [46]).map((lat) => ({
          id: `central-${lat}`,
          name: `Central ${lat}`,
          lat,
          lon: -73,
          routes_json: '["rail"]',
        })),
      },
    ]);
    await runSeeder({
      agencies: ["zeta"],
      dbTarget: "sqlite",
      fetchArchives: async () => ({
        buffers: base.feeds.map(() => Buffer.from("fixture")),
        failures: [],
      }),
      seedAgency: async () => db,
    });
    const readHubs = (region: string) =>
      JSON.parse(
        readFileSync(join(root, "src/agencies", region, "interchanges.jsonc"), "utf8").replace(
          /^\s*\/\/.*$/gm,
          "",
        ),
      );
    expect(readHubs("ca/first")).toMatchObject([
      { endpoints: [{ agencyId: "alpha" }, { agencyId: "zeta" }] },
    ]);
    expect(readHubs("ca/second")).toMatchObject([
      { endpoints: [{ agencyId: "beta" }, { agencyId: "zeta" }] },
    ]);
    expect(
      existsSync(
        join(
          root,
          "src/agencies",
          scopePath.split("/").slice(0, -1).join("/"),
          "interchanges.jsonc",
        ),
      ),
    ).toBe(false);
  },
);
