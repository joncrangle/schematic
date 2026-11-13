import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allProviders } from "~/agencies/registry";
import { getAgencySeedConfig } from "../../scripts/lib/gtfs-seeder-core";
import { compileStaticStationIndex, normalizeSchematicFormatting } from "../../scripts/seed";
import * as staticTopology from "~/infrastructure/gtfs/staticTopology";
import { gtfsZip } from "../helpers/gtfsArchive";

vi.mock("~/agencies/agencyCatalog", async () => {
  const { testAgencyCatalog } = await import("../helpers/agency-fixtures");
  return { agencyCatalog: testAgencyCatalog };
});

vi.mock("~/infrastructure/gtfs/staticTopology", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/infrastructure/gtfs/staticTopology")>();
  return {
    ...actual,
    projectGtfsTopology: vi.fn(actual.projectGtfsTopology),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stationIndexArchive(): Uint8Array {
  return gtfsZip(
    {
      "routes.txt": "route_id,route_short_name,route_long_name,route_type\nroute,1,Local,1\n",
      "trips.txt":
        "route_id,service_id,trip_id,direction_id,shape_id,trip_headsign\nroute,weekday,trip,0,shape,Hub\n",
      "stop_times.txt":
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence\ntrip,08:00:00,08:00:00,hub-platform,1\n",
      "stops.txt":
        "stop_id,stop_code,stop_name,stop_lat,stop_lon,location_type,parent_station\nhub-parent,hub-code,Hub,43.65,-79.38,1,\nhub-platform,,Hub Platform,43.651,-79.381,0,hub-parent\n",
      "shapes.txt":
        "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nshape,43.65,-79.38,1\nshape,43.66,-79.37,2\n",
    },
    true,
  );
}

function corruptEntryCrc(source: Uint8Array, name: string): Uint8Array {
  const bytes = new Uint8Array(source);
  const view = new DataView(bytes.buffer);
  let offset = view.getUint32(bytes.length - 6, true);
  while (view.getUint32(offset, true) === 0x02014b50) {
    const nameLength = view.getUint16(offset + 28, true);
    const entryName = new TextDecoder().decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );
    if (entryName === name) {
      view.setUint32(offset + 16, view.getUint32(offset + 16, true) ^ 1, true);
      return bytes;
    }
    offset +=
      46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  throw new Error(`Missing ZIP entry ${name}`);
}

describe("station-index seed steps", () => {
  it("compiles fictional station identities from the bounded archive reader and reuses its topology", async () => {
    const config = getAgencySeedConfig("sample");
    const provider = allProviders().find((candidate) => candidate.manifest.id === "sample");
    expect(config).toBeDefined();
    expect(provider?.schematic).toBeDefined();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const archive = stationIndexArchive();
    const topology = await staticTopology.projectGtfsTopology([archive], config!);
    vi.mocked(staticTopology.projectGtfsTopology).mockClear();
    vi.mocked(staticTopology.projectGtfsTopology).mockResolvedValue(topology);
    vi.stubGlobal("Bun", { spawnSync: vi.fn(() => ({ exitCode: 0 })) });

    const tempRoot = mkdtempSync(join(tmpdir(), "station-index-fixture-"));
    try {
      const schematicPath = join(tempRoot, "src/agencies", config!.scopePath, "schematic.json");
      mkdirSync(join(tempRoot, "src/agencies", config!.scopePath), { recursive: true });
      writeFileSync(schematicPath, `${JSON.stringify(provider!.schematic, null, 2)}\n`);

      const originalPopular = provider!.manifest.popularSurfaceRoutes;
      Object.assign(provider!.manifest, { popularSurfaceRoutes: ["route"] });
      try {
        await compileStaticStationIndex(
          { ...config!, routeIdField: "id" },
          [Buffer.from(archive)],
          { topology, schematicPath },
        );
      } finally {
        Object.assign(provider!.manifest, { popularSurfaceRoutes: originalPopular });
      }
      expect(warn.mock.calls.flat().join(" ")).not.toContain("popular routes missing");

      const schematic = JSON.parse(readFileSync(schematicPath, "utf8"));
      const hub = schematic.stationIndex.find(
        (station: { schematicId?: string }) => station.schematicId === "hub",
      );
      expect(hub).toMatchObject({
        id: "feed-hub",
        name: "Hub",
        lines: ["1", "2"],
        platformIds: ["hub-platform"],
        departureRouteIds: ["route"],
        lat: 43.65,
        lon: -79.38,
      });
      expect(staticTopology.projectGtfsTopology).not.toHaveBeenCalled();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects a station-index input whose stops CRC does not match", async () => {
    const config = getAgencySeedConfig("sample");
    const validArchive = stationIndexArchive();
    const topology = await staticTopology.projectGtfsTopology([validArchive], config!);
    vi.mocked(staticTopology.projectGtfsTopology).mockClear();
    vi.mocked(staticTopology.projectGtfsTopology).mockResolvedValue(topology);
    const badArchive = corruptEntryCrc(validArchive, "stops.txt");
    const tempRoot = mkdtempSync(join(tmpdir(), "station-index-crc-"));
    try {
      const schematicPath = join(tempRoot, "src/agencies", config!.scopePath, "schematic.json");
      mkdirSync(join(tempRoot, "src/agencies", config!.scopePath), { recursive: true });
      const provider = allProviders().find((candidate) => candidate.manifest.id === "sample");
      writeFileSync(schematicPath, `${JSON.stringify(provider!.schematic, null, 2)}\n`);

      await expect(
        compileStaticStationIndex(config!, [Buffer.from(badArchive)], { topology, schematicPath }),
      ).rejects.toThrow(/invalid GTFS ZIP payload stops\.txt/i);
      expect(staticTopology.projectGtfsTopology).not.toHaveBeenCalled();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses the available formatter for a schematic path", () => {
    const spawnSync = vi.fn((args: readonly string[]) => ({ exitCode: args.length ? 0 : 1 }));
    vi.stubGlobal("Bun", { spawnSync });

    normalizeSchematicFormatting("/tmp/sample/schematic.json", "sample");

    expect(spawnSync).toHaveBeenCalledOnce();
    expect(spawnSync.mock.calls[0]?.[0]).toEqual([
      expect.stringContaining("oxfmt"),
      "/tmp/sample/schematic.json",
    ]);
  });

  it("reports when formatting is unavailable and keeps seeding non-fatal", () => {
    const spawnSync = vi.fn(() => {
      throw new Error("formatter missing");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("Bun", { spawnSync });

    expect(() =>
      normalizeSchematicFormatting("/tmp/sample/schematic.json", "sample"),
    ).not.toThrow();

    expect(spawnSync).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[seed:sample:station-index] formatter unavailable"),
    );
  });
});
