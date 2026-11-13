import { expect, it, vi } from "vitest";
import {
  compareSeedRows,
  syncSeedTopology,
  type SeedSyncStore,
  type SeedSyncMeta,
  type SeedRow,
  createD1SeedSyncStore,
  reconcileSeedTopology,
  SEED_TABLES,
  shouldRefreshSeedTopology,
} from "~/infrastructure/storage/surfaceStore/seedSync";
import { hashGtfsArchives, projectGtfsTopology } from "~/infrastructure/gtfs/staticTopology";
import { modesToGtfsRouteTypes } from "~/infrastructure/gtfs/config";
import { gtfsZip, topologyArchive } from "../helpers/gtfsArchive";
import type { D1DatabaseBinding } from "~/infrastructure/storage/RuntimeBindings";
import { readGtfsArchive } from "~/infrastructure/gtfs/archive";
import { TOPOLOGY_TTL_MS } from "~/domain/surface/topologySource";
import { logger } from "~/infrastructure/logging/logger";

const config = {
  id: "sample",
  routeTypes: new Set([3]),
  routeIdField: "id" as const,
  defaultColor: "#123456",
  defaultTextColor: "#FFFFFF",
};

it("matching archive hash costs zero writes and skips projection and table reads", async () => {
  const archives = [new Uint8Array([1, 2, 3])];
  const feedHash = await hashGtfsArchives(archives, config);
  const store: SeedSyncStore = {
    hasTopology: async () => true,
    readLastSync: async () => null,
    readMeta: async () => ({ feedHash, tableHashes: {} }),
    readTable: vi.fn(async () => []),
    commit: vi.fn(async () => {}),
  };
  expect(await syncSeedTopology({ config, archives: async () => archives, store })).toMatchObject({
    outcome: "unchanged",
    writes: 0,
  });
  expect(store.commit).not.toHaveBeenCalled();
  expect(store.readTable).not.toHaveBeenCalled();
});

it("reconciles a supplied projection without parsing the archive again", async () => {
  const topology = await projectGtfsTopology([topologyArchive()], config);
  const store = recordingStore(topology);
  const result = await syncSeedTopology({
    config,
    archives: async () => [new Uint8Array([1, 2, 3])],
    topology,
    store,
    verifyDestination: true,
  });

  expect(result).toEqual({ outcome: "unchanged", writes: 0 });
  expect(store.commit).not.toHaveBeenCalled();
});

it("treats malformed cached hashes as a miss and repairs destination drift", async () => {
  const archives = [topologyArchive()];
  const feedHash = await hashGtfsArchives(archives, config);
  const topology = await projectGtfsTopology(archives, config);
  const store = recordingStore(
    {
      ...topology,
      stops: topology.stops.map((row) => (row.id === "1" ? { ...row, name: "Damaged" } : row)),
    },
    { feedHash, tableHashes: null } as unknown as SeedSyncMeta,
  );

  expect(await syncSeedTopology({ config, archives: async () => archives, store })).toMatchObject({
    outcome: "updated",
    writes: 3,
  });
  expect(store.readTable).toHaveBeenCalledWith("stops", "sample");
  expect(
    vi.mocked(store.commit).mock.calls[0]![0].find((s) => s.sql.startsWith("INSERT INTO stops"))
      ?.values,
  ).toContain("Stop 1");
});

it("treats non-object reconciliation hashes as a miss", async () => {
  const topology = await projectGtfsTopology([topologyArchive()], config);
  const store = recordingStore({
    ...topology,
    stops: topology.stops.map((row) => (row.id === "1" ? { ...row, name: "Damaged" } : row)),
  });

  expect(
    await reconcileSeedTopology({
      agencyId: "sample",
      topology,
      feedHash: "current",
      store,
      meta: { feedHash: "current", tableHashes: null } as unknown as SeedSyncMeta,
    }),
  ).toMatchObject({ outcome: "updated", writes: 3 });
  expect(store.readTable).toHaveBeenCalledWith("stops", "sample");
});

function recordingStore(
  rows: Record<string, readonly SeedRow[]>,
  meta: SeedSyncMeta | null = null,
): SeedSyncStore {
  return {
    hasTopology: async () => true,
    readLastSync: async () => null,
    readMeta: async () => meta,
    readTable: vi.fn(async (table) => [...(rows[table] ?? [])]),
    commit: vi.fn(async () => {}),
  };
}

it("an explicit seed can repair an empty agency even if stale hash metadata survived", async () => {
  const archives = [topologyArchive()];
  const store = recordingStore(
    {},
    { feedHash: await hashGtfsArchives(archives, config), tableHashes: {} },
  );
  store.hasTopology = async () => false;
  expect(
    await syncSeedTopology({
      config,
      archives: async () => archives,
      store,
      allowInitialSeed: true,
    }),
  ).toMatchObject({ outcome: "updated", writes: 16 });
  expect(store.commit).toHaveBeenCalledTimes(1);
});

it("verified reconciliation repairs child rows despite matching table hashes, but writes nothing to an intact destination", async () => {
  const topology = await projectGtfsTopology([topologyArchive()], config);
  const firstStore = recordingStore({});
  await reconcileSeedTopology({
    agencyId: "sample",
    topology,
    feedHash: "same",
    store: firstStore,
  });
  const metadata = vi.mocked(firstStore.commit).mock.calls[0][0].at(-2)!;
  const meta = {
    feedHash: String(metadata.values[1]),
    tableHashes: JSON.parse(String(metadata.values[2])),
  };
  const store = recordingStore(topology, meta);
  const input = { agencyId: "sample", topology, feedHash: "same", store, verifyDestination: true };
  expect(await reconcileSeedTopology(input)).toEqual({ outcome: "unchanged", writes: 0 });
  expect(store.commit).not.toHaveBeenCalled();
  vi.mocked(store.readTable).mockImplementation(async (table) =>
    table === "route_stops" ? topology.route_stops.slice(1) : [...topology[table]],
  );
  expect(await reconcileSeedTopology(input)).toMatchObject({ outcome: "updated", writes: 3 });
  const [statements] = vi.mocked(store.commit).mock.calls[0];
  expect(statements[0]).toMatchObject({
    sql: expect.stringContaining("INSERT INTO route_stops"),
    values: ["sample", "r", 0, 1, "1"],
  });
  expect(statements).toHaveLength(3);
});

it.each(["sync", "reconcile"])(
  "verified %s ignores invalid cached metadata during repair and no-op",
  async (operation) => {
    const archives = [topologyArchive()];
    const topology = await projectGtfsTopology(archives, config);
    const store = recordingStore({
      ...topology,
      stops: topology.stops.map((row) => (row.id === "1" ? { ...row, name: "Damaged" } : row)),
    });
    store.readMeta = vi.fn(async () => JSON.parse("INVALID JSON"));
    const run = () =>
      operation === "sync"
        ? syncSeedTopology({
            config,
            archives: async () => archives,
            store,
            verifyDestination: true,
          })
        : reconcileSeedTopology({
            agencyId: config.id,
            topology,
            feedHash: "same",
            store,
            verifyDestination: true,
          });
    expect(await run()).toMatchObject({ outcome: "updated", writes: 3 });
    expect(store.readMeta).not.toHaveBeenCalled();
    expect(vi.mocked(store.commit).mock.calls[0][0][0]).toMatchObject({
      sql: expect.stringContaining("INSERT INTO stops"),
      values: expect.arrayContaining(["1", "Stop 1"]),
    });
    vi.mocked(store.readTable).mockImplementation(async (table) => [...topology[table]]);
    vi.mocked(store.commit).mockClear();
    expect(await run()).toEqual({ outcome: "unchanged", writes: 0 });
    expect(store.readMeta).not.toHaveBeenCalled();
    expect(store.commit).not.toHaveBeenCalled();
  },
);

it.each(["empty", "missing-stop", "missing-route"])(
  "invalid source projection %s cannot create a destructive plan",
  async (kind) => {
    const before = await projectGtfsTopology([topologyArchive()], config);
    const topology = { ...before };
    if (kind === "empty") topology.routes = [];
    if (kind === "missing-stop")
      topology.route_stops = [{ ...topology.route_stops[0], stop_id: "unknown" }];
    if (kind === "missing-route")
      topology.route_shapes = [{ ...topology.route_shapes[0], route_id: "unknown" }];
    const store = recordingStore(before);
    await expect(
      reconcileSeedTopology({ agencyId: "sample", topology, feedHash: "new", store }),
    ).rejects.toThrow(/Invalid|Missing|Empty/);
    expect(store.commit).not.toHaveBeenCalled();
  },
);

it.each(["legacy", "repacked"])(
  "%s effective topology no-op does not backfill hashes or stamp freshness",
  async (kind) => {
    const before = await projectGtfsTopology([topologyArchive()], config);
    const meta =
      kind === "legacy"
        ? null
        : { feedHash: await hashGtfsArchives([topologyArchive()], config), tableHashes: {} };
    const store = recordingStore(before, meta);
    expect(
      await syncSeedTopology({
        config,
        archives: async () => [topologyArchive({ marker: "repacked" })],
        store,
      }),
    ).toEqual({ outcome: "unchanged", writes: 0 });
    expect(store.commit).not.toHaveBeenCalled();
  },
);

it("removes a retired stop by exact keys after the complete replacement is projected", async () => {
  const store = recordingStore(await projectGtfsTopology([topologyArchive()], config));
  expect(
    await syncSeedTopology({
      config,
      archives: async () => [topologyArchive({ removed: true })],
      store,
    }),
  ).toMatchObject({ outcome: "updated", writes: 7 });
  const [statements] = vi.mocked(store.commit).mock.calls[0];
  expect(
    statements
      .filter(
        (s) => s.sql.startsWith("DELETE") && !s.sql.startsWith("DELETE FROM route_trip_terminals"),
      )
      .map((s) => [s.sql, s.values]),
  ).toEqual([
    [
      "DELETE FROM stop_routes WHERE agency_id = ? AND route_id = ? AND stop_id = ?",
      ["sample", "r", "3"],
    ],
    [
      "DELETE FROM route_stops WHERE agency_id = ? AND route_id = ? AND direction_id = ? AND stop_sequence = ?",
      ["sample", "r", 0, 3],
    ],
    ["DELETE FROM stops WHERE agency_id = ? AND id = ?", ["sample", "3"]],
  ]);
});

it("table hashes suppress stable table reads when another stop moves", async () => {
  const firstStore = recordingStore(await projectGtfsTopology([topologyArchive()], config));
  await syncSeedTopology({
    config,
    archives: async () => [topologyArchive({ moved: true })],
    store: firstStore,
  });
  const metadata = vi.mocked(firstStore.commit).mock.calls[0][0].at(-2)!;
  const meta = {
    feedHash: String(metadata.values[1]),
    tableHashes: JSON.parse(String(metadata.values[2])),
  };
  const nextStore = recordingStore(
    await projectGtfsTopology([topologyArchive({ moved: true })], config),
    meta,
  );
  await syncSeedTopology({ config, archives: async () => [topologyArchive()], store: nextStore });
  expect(vi.mocked(nextStore.readTable).mock.calls).toEqual([["stops", "sample"]]);
  expect(vi.mocked(nextStore.commit).mock.calls[0][0]).toHaveLength(3);
});

it("an empty runtime database reports needs-seed without a fetch or commit", async () => {
  const store = recordingStore({});
  store.hasTopology = async () => false;
  const archives = vi.fn(async () => [topologyArchive()]);
  expect(await syncSeedTopology({ config, archives, store })).toEqual({
    outcome: "needs-seed",
    writes: 0,
  });
  expect(archives).not.toHaveBeenCalled();
  expect(store.commit).not.toHaveBeenCalled();
});

it.each([
  [false, 1000, 1001, true],
  [true, null, 1001, true],
  [true, 1000, 1000 + 6 * 86400_000 - 1, false],
  [true, 1000, 1000 + 6 * 86400_000, true],
  [true, 1000, 1000 + 7 * 86400_000, true],
])(
  "seed freshness is read-only: present=%s, stamp=%s, now=%s",
  async (present, stamp, now, due) => {
    const store = recordingStore({});
    store.hasTopology = async () => present;
    store.readLastSync = vi.fn(async () => stamp);
    expect(await shouldRefreshSeedTopology(store, "sample", now)).toBe(due);
    expect(store.commit).not.toHaveBeenCalled();
    expect(store.readLastSync).toHaveBeenCalledTimes(present ? 1 : 0);
  },
);

it("refreshes when a weekly run starts shortly before the previous run finished", async () => {
  const store = recordingStore({});
  store.readLastSync = async () => 1000;

  expect(await shouldRefreshSeedTopology(store, "sample", 1000 + TOPOLOGY_TTL_MS - 18_000)).toBe(
    true,
  );
});

it.each(["not json", "[]", "null", '{"routes":false}'])(
  "treats malformed D1 hash metadata %s as missing",
  async (tableHashesJson) => {
    const statement = {
      bind: () => statement,
      all: async () => ({ success: true, results: [{ name: "seed_topology_meta" }] }),
      first: async () => ({ feed_hash: "feed-hash", table_hashes_json: tableHashesJson }),
    };
    const db = { prepare: () => statement } as unknown as D1DatabaseBinding;

    await expect(createD1SeedSyncStore(db).readMeta("sample")).resolves.toBeNull();
  },
);

it.each(["fetch", "parse", "crc"])("%s failure leaves storage untouched", async (kind) => {
  const store = recordingStore(await projectGtfsTopology([topologyArchive()], config));
  const corrupted = topologyArchive();
  corrupted[50] ^= 1;
  const archives = async () => {
    if (kind === "fetch") throw new Error("upstream down");
    return [kind === "parse" ? gtfsZip({ "routes.txt": "nope\n" }) : corrupted];
  };
  await expect(syncSeedTopology({ config, archives, store })).rejects.toThrow();
  expect(store.commit).not.toHaveBeenCalled();
});

it("preflights every compressed archive before the first hash, including injected loaders", async () => {
  const oversized = new Uint8Array(128 * 1024 * 1024 + 1);
  const digest = vi.spyOn(crypto.subtle, "digest").mockRejectedValue(new Error("Unexpected hash"));
  const store = recordingStore({});
  try {
    expect(() => readGtfsArchive(oversized)).toThrow(/archive.*limit/i);
    await expect(
      syncSeedTopology({
        config,
        store,
        archives: async () => [topologyArchive(), oversized],
      }),
    ).rejects.toThrow(/archive.*limit/i);
    expect(digest).not.toHaveBeenCalled();
    expect(store.commit).not.toHaveBeenCalled();
  } finally {
    digest.mockRestore();
  }
});

it.each(["header", "blank", "ignored stop", "selected stop", "final record", "UTF-8 record"])(
  "bounds a deflated oversized physical CSV %s before committing",
  async (kind) => {
    const huge = "x".repeat(1024 * 1024 + 1);
    const header = "stop_id,stop_name,stop_lat,stop_lon\n";
    const active = "1,Main,43,-79\n";
    const record =
      kind === "header"
        ? `stop_id,stop_name,stop_lat,stop_lon,${huge}\n${active}`
        : kind === "blank"
          ? `${header}${" ".repeat(1024 * 1024 + 1)}\n${active}`
          : kind === "ignored stop"
            ? `${header}${active}unused,${huge},43,-79\n`
            : `${header}1,${kind === "UTF-8 record" ? "é".repeat(600_000) : huge},43,-79${kind === "final record" ? "" : "\n"}`;
    const archive = gtfsZip(
      {
        "routes.txt": "route_id,route_type\nr,3\n",
        "trips.txt": "route_id,trip_id\nr,t\n",
        "stop_times.txt": "trip_id,stop_id,stop_sequence\nt,1,1\n",
        "stops.txt": record,
      },
      true,
    );
    const store = recordingStore({});
    await expect(
      syncSeedTopology({ config, store, archives: async () => [archive] }),
    ).rejects.toThrow(/CSV record.*limit/i);
    expect(store.commit).not.toHaveBeenCalled();
  },
);

it("accepts a deflated physical CSV record exactly at the byte limit", async () => {
  const archive = gtfsZip(
    {
      "routes.txt": "route_id,route_type\nr,3\n",
      "trips.txt": "route_id,trip_id\nr,t\n",
      "stop_times.txt": "trip_id,stop_id,stop_sequence\nt,1,1\n",
      "stops.txt":
        "stop_id,stop_name,stop_lat,stop_lon\n" + " ".repeat(1024 * 1024) + "\n1,Main,43,-79\n",
    },
    true,
  );
  expect((await projectGtfsTopology([archive], config)).stops.map((row) => row.id)).toEqual(["1"]);
});

function malformedStopArchive(
  stopTimes = "t,1,1\n",
  badStop = "101453,University / Queen, Southwest Entrance,43.650639,-79.386841\n",
) {
  return gtfsZip({
    "routes.txt": "route_id,route_type\nr,3\n",
    "trips.txt": "route_id,trip_id\nr,t\n",
    "stop_times.txt": "trip_id,stop_id,stop_sequence\n" + stopTimes,
    "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\n1,Active,43,-79\n" + badStop,
  });
}

it("projects active stops while ignoring an unreferenced stop with an unquoted comma", async () => {
  const topology = await projectGtfsTopology([malformedStopArchive()], config);
  expect(topology.stops).toEqual([
    {
      agency_id: "sample",
      id: "1",
      code: null,
      name: "Active",
      lat: 43,
      lon: -79,
      wheelchair: 0,
      parent_station: null,
      routes_json: '["r"]',
    },
  ]);
  expect(topology.stop_routes).toEqual([{ agency_id: "sample", route_id: "r", stop_id: "1" }]);
});

it.each([
  ["referenced row width", "t,1,1\nt,101453,2\n", undefined, "Invalid CSV row in stops.txt"],
  [
    "unreferenced quote syntax",
    "t,1,1\n",
    '101453,"Unterminated,43,-79\n',
    "Unterminated GTFS CSV field",
  ],
])("rejects malformed %s before committing", async (_kind, stopTimes, badStop, error) => {
  const store = recordingStore({});
  await expect(
    syncSeedTopology({
      config,
      store,
      allowInitialSeed: true,
      verifyDestination: true,
      archives: async () => [malformedStopArchive(stopTimes, badStop)],
    }),
  ).rejects.toThrow(error);
  expect(store.commit).not.toHaveBeenCalled();
});

it("the keyed comparator normalizes unordered stop membership and rejects cross-agency rows", () => {
  const stop = { agency_id: "sample", id: "a", lat: 43, lon: -79, routes_json: '["a","b"]' };
  expect(
    compareSeedRows("stops", [stop], [{ ...stop, routes_json: '["b","a","b"]' }], "sample"),
  ).toEqual({ upserts: [], deletes: [] });
  expect(() =>
    compareSeedRows("stops", [{ ...stop, agency_id: "other" }], [stop], "sample"),
  ).toThrow(/Unscoped/);
});

it("a failed D1 batch is never retried as sequential writes", async () => {
  const run = vi.fn(),
    batch = vi.fn(async () => {
      throw new Error("batch refused");
    });
  const statement = { bind: () => statement, run };
  const db = { prepare: () => statement, batch } as unknown as D1DatabaseBinding;
  await expect(
    createD1SeedSyncStore(db).commit([
      { sql: "DELETE FROM stops WHERE agency_id = ? AND id = ?", values: ["sample", "1"] },
    ]),
  ).rejects.toThrow("batch refused");
  expect(batch).toHaveBeenCalledTimes(1);
  expect(run).not.toHaveBeenCalled();
});

it("rail mode ingests light rail (route_type 0) alongside heavy rail", async () => {
  expect(modesToGtfsRouteTypes(["rail", "bus"])).toEqual(new Set([0, 2, 3]));
  // Existing agencies are unaffected: no new codes enter their projections.
  expect(modesToGtfsRouteTypes(["subway", "streetcar", "bus"])).toEqual(new Set([1, 0, 3]));
  expect(modesToGtfsRouteTypes(["bus"])).toEqual(new Set([3]));

  const archive = gtfsZip({
    "routes.txt":
      "route_id,route_short_name,route_long_name,route_type\n301,301,ION light rail,0\n1,1,Queen-River,3\n",
    "trips.txt":
      "route_id,trip_id,direction_id,shape_id,trip_headsign\n301,t1,0,s,301 Conestoga\n1,t2,0,s,Queen\n",
    "stop_times.txt": "trip_id,stop_id,stop_sequence\nt1,6001,1\nt2,1001,1\n",
    "stops.txt":
      "stop_id,stop_name,stop_lat,stop_lon\n6001,Conestoga Station - Southbound,43.5,-80.5\n1001,Queen,43.4,-80.4\n",
    "shapes.txt":
      "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\ns,43.5,-80.5,1\ns,43.4,-80.4,2\n",
  });
  const topology = await projectGtfsTopology([archive], {
    ...config,
    routeTypes: modesToGtfsRouteTypes(["rail", "bus"]),
  });
  expect(topology["routes"]?.map((row) => row["id"])).toEqual(expect.arrayContaining(["301", "1"]));
});

it("multi-archive projection keeps route folding, first route/stop and last child-key precedence", async () => {
  const first = topologyArchive();
  const second = gtfsZip({
    "routes.txt":
      "route_id,route_short_name,route_long_name,route_type\nr2,10,Ignored route title,3\nrail,20,Rail,2\n",
    "trips.txt":
      "route_id,trip_id,direction_id,shape_id,trip_headsign\nr2,t,0,s,South - Main\nrail,railtrip,0,s,Rail\n",
    "stop_times.txt": "trip_id,stop_id,stop_sequence\nt,2,1\nrailtrip,excluded,1\n",
    "stops.txt":
      "stop_id,stop_name,stop_lat,stop_lon\n2,Ignored stop title,45,-77\nexcluded,Excluded,45,-77\n",
    "shapes.txt": "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\ns,45,-77,1\ns,46,-76,2\n",
  });
  const store = recordingStore({});
  expect(
    await syncSeedTopology({
      config: { ...config, routeIdField: "short_name" },
      archives: async () => [first, second],
      store,
      allowInitialSeed: true,
    }),
  ).toMatchObject({ outcome: "updated", writes: 16 });
  const statements = vi.mocked(store.commit).mock.calls[0][0];
  expect(statements.find((s) => s.sql.startsWith("INSERT INTO routes"))?.values).toEqual([
    "sample",
    "10",
    "10",
    "Main",
    3,
    "#123456",
    "#FFFFFF",
  ]);
  expect(statements.filter((s) => s.sql.startsWith("INSERT INTO stops"))).toHaveLength(3);
  expect(statements.find((s) => s.sql.startsWith("INSERT INTO route_stops"))?.values).toEqual([
    "sample",
    "10",
    0,
    1,
    "2",
  ]);
  expect(statements.find((s) => s.sql.startsWith("INSERT INTO route_shapes"))?.values).toEqual(
    expect.arrayContaining(["South - Main", 45, 46, -77, -76, "Southbound"]),
  );
});

it("selects tied canonical shapes and trips independently of trips.txt row order", async () => {
  const buildArchive = (tripRows: readonly string[]) =>
    gtfsZip({
      "routes.txt": "route_id,route_type\nr,3\n",
      "trips.txt": "route_id,trip_id,direction_id,shape_id\n" + tripRows.join("\n") + "\n",
      "stop_times.txt":
        "trip_id,stop_id,stop_sequence\n" +
        [
          "z-first,z1,1",
          "z-first,z2,2",
          "z-other,other1,1",
          "z-other,other2,2",
          "a-canonical,a1,1",
          "a-canonical,a2,2",
          "z-second,z3,1",
          "z-second,z4,2",
        ].join("\n") +
        "\n",
      "stops.txt":
        "stop_id,stop_name,stop_lat,stop_lon\n" +
        ["z1", "z2", "other1", "other2", "a1", "a2", "z3", "z4"]
          .map((id) => `${id},${id},43,-79`)
          .join("\n") +
        "\n",
      "shapes.txt":
        "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n" +
        "a-shape,43,-79,1\na-shape,44,-78,2\nz-shape,45,-77,1\nz-shape,46,-76,2\n",
    });
  const trips = [
    "r,z-first,0,z-shape",
    "r,z-other,0,a-shape",
    "r,a-canonical,0,a-shape",
    "r,z-second,0,z-shape",
  ];
  const forward = await projectGtfsTopology([buildArchive(trips)], config);
  const reorderedTrips = [...trips.slice(2), ...trips.slice(0, 2)];
  const reordered = await projectGtfsTopology([buildArchive(reorderedTrips)], config);
  const canonical = (topology: Awaited<ReturnType<typeof projectGtfsTopology>>) => ({
    shape: topology.route_shapes.map(({ min_lat, max_lat }) => [min_lat, max_lat]),
    stops: topology.route_stops
      .map(({ stop_sequence, stop_id }) => [Number(stop_sequence), String(stop_id)] as const)
      .sort(([left], [right]) => left - right),
  });

  expect(canonical(reordered)).toEqual(canonical(forward));
  expect(canonical(forward)).toEqual({
    shape: [[43, 44]],
    stops: [
      [1, "a1"],
      [2, "a2"],
    ],
  });
  const store = recordingStore(forward);
  expect(
    await syncSeedTopology({
      config,
      archives: async () => [buildArchive(reorderedTrips)],
      store,
    }),
  ).toEqual({ outcome: "unchanged", writes: 0 });
  expect(store.commit).not.toHaveBeenCalled();
});

it("uses the longest trip for shape-less directions and warns", async () => {
  const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
  const buildArchive = (tripRows: readonly string[]) =>
    gtfsZip({
      "routes.txt": "route_id,route_type\nr,3\n",
      "trips.txt": "route_id,trip_id,direction_id,trip_headsign\n" + tripRows.join("\n") + "\n",
      "stop_times.txt":
        "trip_id,stop_id,stop_sequence\n" +
        [
          "z-long,z1,1",
          "z-long,z2,2",
          "z-long,z3,3",
          "a-long,a1,1",
          "a-long,a2,2",
          "a-long,a3,3",
          "short,s1,1",
          "short,s2,2",
        ].join("\n") +
        "\n",
      "stops.txt":
        "stop_id,stop_name,stop_lat,stop_lon\n" +
        ["z1", "z2", "z3", "a1", "a2", "a3", "s1", "s2"]
          .map((id) => `${id},${id},43,-79`)
          .join("\n") +
        "\n",
    });

  try {
    const trips = ["r,z-long,0,Town", "r,a-long,0,Town", "r,short,0,Town"];
    const forward = await projectGtfsTopology([buildArchive(trips)], config);
    const reversed = await projectGtfsTopology([buildArchive([...trips].reverse())], config);
    const canonicalStops = (topology: Awaited<ReturnType<typeof projectGtfsTopology>>) =>
      topology.route_stops
        .map(({ stop_sequence, stop_id }) => [Number(stop_sequence), String(stop_id)] as const)
        .sort(([left], [right]) => left - right);

    expect(forward.route_shapes).toEqual([]);
    expect(canonicalStops(forward)).toEqual([
      [1, "a1"],
      [2, "a2"],
      [3, "a3"],
    ]);
    expect(canonicalStops(reversed)).toEqual(canonicalStops(forward));
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("no shape"),
      expect.objectContaining({
        agencyId: "sample",
        routeId: "r",
        directionId: 0,
        tripId: "a-long",
      }),
    );
    expect(warning).toHaveBeenCalledTimes(2);
  } finally {
    warning.mockRestore();
  }
});

it.each([false, true])(
  "streamed CSV retains partial lines in stored/deflated archives, deflated=%s",
  async (deflated) => {
    const archive = gtfsZip(
      {
        "routes.txt": "route_id,route_type\nr,3\n",
        "trips.txt": "route_id,trip_id,shape_id\nr,t,s\n",
        "stop_times.txt":
          "trip_id,stop_id,stop_sequence\n" +
          "unselected,ignored,4\n".repeat(5000) +
          "t,1,1\nt,2,2\nt,3,3\n",
        "stops.txt":
          'stop_id,stop_name,stop_lat,stop_lon\n1,"Bay, North",43,-79\n2,"Quoted ""name""",43,-79\n3,Québec,43,-79\n',
        "shapes.txt":
          "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\ns,43,-79,1\ns,44,-78,2\n",
      },
      deflated,
    );
    const store = recordingStore({});
    expect(
      await syncSeedTopology({
        config,
        store,
        allowInitialSeed: true,
        archives: async () => [archive],
      }),
    ).toMatchObject({ outcome: "updated", writes: 15 });
    const rows = vi
      .mocked(store.commit)
      .mock.calls[0][0].filter((s) => s.sql.startsWith("INSERT INTO stops"));
    expect(rows.map((s) => s.values[3])).toEqual(["Bay, North", 'Quoted "name"', "Québec"]);
  },
);

it("one relocated stop writes one stop and bounded metadata, leaving stable routes alone", async () => {
  const before = await projectGtfsTopology([topologyArchive()], config);
  const store: SeedSyncStore = {
    hasTopology: async () => true,
    readLastSync: async () => null,
    readMeta: async () => null,
    readTable: async (table) => [...(before[table] ?? [])],
    commit: vi.fn(async () => {}),
  };
  const result = await syncSeedTopology({
    config,
    archives: async () => [topologyArchive({ moved: true })],
    store,
    now: () => 1234,
  });
  expect(result).toMatchObject({
    outcome: "updated",
    writes: 3,
    movedStops: [{ id: "1", before: [43, -79], after: [44, -79] }],
  });
  const [statements] = vi.mocked(store.commit).mock.calls[0];
  expect(statements).toHaveLength(3);
  expect(statements[0]).toMatchObject({
    sql: expect.stringContaining("INSERT INTO stops"),
    values: expect.arrayContaining(["1", 44]),
  });
  expect(statements.map((s) => s.sql).join("\n")).not.toMatch(/INSERT INTO routes|DELETE FROM/);
  expect(statements.at(-1)?.values).toEqual(["sample", 1234]);
});

it("seeds every table the projection produces, not a hand-maintained subset", async () => {
  // The remote D1 path builds its topology from SEEDED_TABLES, and the
  // reconciler filters its own table list by what the caller supplies. A table
  // missing from SEEDED_TABLES is therefore dropped without error while the
  // seed still reports success. route_direction_trips shipped in exactly that
  // state: written to SQLite, never migrated, and the app then resolved no
  // trip-to-direction joins at all.
  const projected = await projectGtfsTopology([topologyArchive()], config);
  const produced = Object.keys(projected).filter((table) => table !== "feed_metadata");
  const seededTables = Object.keys(SEED_TABLES);

  for (const table of produced) expect(seededTables).toContain(table);
  // Derived from the reconciler's list, so the two cannot drift apart again.
  expect(seededTables).toContain("route_direction_trips");
  expect(new Set(seededTables).size).toBe(seededTables.length);
});

it("retains declared vehicle-only services in the seed without fabricating stops or shapes", async () => {
  const vehicleOnlyRoutes = [{ id: "rural", shortName: "R", longName: "Rural vehicles" }];
  const augmented = { ...config, vehicleOnlyRoutes };
  const archives = [topologyArchive()];
  const topology = await projectGtfsTopology(archives, augmented);
  expect(topology.routes).toContainEqual(expect.objectContaining({ id: "rural", short_name: "R" }));
  expect(topology.route_shapes.filter((row) => row.route_id === "rural")).toEqual([]);
  expect(topology.route_stops.filter((row) => row.route_id === "rural")).toEqual([]);
  expect(await hashGtfsArchives(archives, augmented)).not.toBe(
    await hashGtfsArchives(archives, config),
  );
});
