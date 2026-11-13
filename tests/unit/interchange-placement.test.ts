import { describe, expect, it } from "vitest";
import {
  buildMapModel,
  normalizeInterchangeBadgeRequests,
  placeInterchangeBadges,
} from "~/core/map";
import type { Schematic } from "~/agencies/types";
import type { InterchangeBadgeAgency } from "~/core/map";
import type { InterchangeHub } from "~/domain/map/Interchange";
import { makeTestSchematic } from "../helpers/agency-fixtures";
import { planInterchangeLayout } from "../../scripts/lib/interchange-placement";

const schematic = makeTestSchematic({
  viewBoxWidth: 400,
  viewBoxHeight: 300,
  viewport: { bounds: { minX: 0, maxX: 400, minY: 0, maxY: 300 }, minZoom: 0.5, maxZoom: 4 },
  lines: [
    {
      id: "a",
      name: "A",
      color: "red",
      points: [
        { x: 30, y: 150 },
        { x: 370, y: 150 },
      ],
    },
  ],
  stations: [
    {
      id: "central",
      name: "Central",
      x: 200,
      y: 150,
      lines: ["a"],
      label: { x: 200, y: 120, anchor: "middle" },
    },
  ],
});
const schematics = new Map([
  ["local", schematic],
  ["regional-long-id", schematic],
]);
const agencies: readonly InterchangeBadgeAgency[] = [
  {
    agencyId: "local",
    name: "Local",
    shortName: "L",
    modes: ["rail"],
    schematicStationIds: ["central"],
  },
  {
    agencyId: "regional-long-id",
    name: "Regional",
    shortName: "R",
    modes: ["bus"],
    schematicStationIds: ["central"],
  },
  { agencyId: "mapless", name: "Mapless", modes: ["bus"], schematicStationIds: [] },
];
const hub: InterchangeHub = {
  id: "transfer",
  endpoints: [
    { agencyId: "local", stationId: "central", stationName: "Central" },
    { agencyId: "regional-long-id", stationId: "central", stationName: "Central" },
    { agencyId: "mapless", stationName: "Street stop", feedStopIds: ["stop"] },
  ],
};

describe("offline interchange placement", () => {
  it("positions only the row the runtime draws, correcting a distant phantom-width placement", () => {
    const previous = [{ ...hub, badgeOffsets: { local: { dx: -137, dy: 0 } } }];
    const result = planInterchangeLayout([hub], schematics, { agencies, previous });
    const badges = placeInterchangeBadges(
      buildMapModel(schematic),
      normalizeInterchangeBadgeRequests("local", result.hubs, agencies),
      "full",
    );
    expect(badges).toHaveLength(1);
    expect(badges[0]?.agencyLabel).toBe("R");
    expect(Math.hypot(badges[0]!.x - 200, badges[0]!.y - 150)).toBeLessThan(70);
    expect(result.changes).toContainEqual(
      expect.objectContaining({
        agencyId: "local",
        hubId: "transfer",
        previous: { dx: -137, dy: 0 },
      }),
    );
  });

  it("keeps a valid prior placement when an unrelated walking node is added and is stable on reseed", () => {
    const previous = [
      { ...hub, badgeOffsets: { local: { dx: 0, dy: 28 }, "regional-long-id": { dx: 0, dy: 28 } } },
    ];
    const extra: InterchangeHub = {
      id: "new-walk",
      endpoints: [
        { agencyId: "local", stationId: "other", stationName: "Other" },
        {
          agencyId: "regional-long-id",
          stationId: "central",
          stationName: "Central",
          walkingMarkers: { local: { dx: 0, dy: 45, label: "Regional Central" } },
        },
      ],
    };
    const expanded = {
      ...schematic,
      stations: [
        ...schematic.stations,
        {
          id: "other",
          name: "Other",
          x: 80,
          y: 80,
          lines: ["a"],
          label: { x: 50, y: 55, anchor: "middle" as const },
        },
      ],
    };
    const maps = new Map(schematics).set("local", expanded);
    const first = planInterchangeLayout([extra, hub], maps, { agencies, previous });
    expect(first.hubs.find((x) => x.id === hub.id)?.badgeOffsets?.local).toEqual({ dx: 0, dy: 28 });
    const second = planInterchangeLayout([hub, extra], maps, { agencies, previous: first.hubs });
    expect(second.hubs).toEqual(first.hubs);
    expect(second.changes).toEqual([]);
  });

  it("reports an unsatisfiable crowded map rather than hiding the conflict or moving an authored badge", () => {
    const reviewed = { ...hub, badgeOffsets: { local: { dx: 0, dy: 28 } } };
    const crowded = {
      ...schematic,
      stations: [
        ...schematic.stations,
        {
          id: "blocker",
          name: "Blocking caption",
          x: 200,
          y: 178,
          lines: ["a"],
          label: { x: 200, y: 178, anchor: "middle" as const },
        },
      ],
    };
    const result = planInterchangeLayout([reviewed], new Map(schematics).set("local", crowded), {
      agencies,
    });
    expect(result.hubs[0]?.badgeOffsets?.local).toEqual({ dx: 0, dy: 28 });
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({
        agencyId: "local",
        hubId: "transfer",
        kind: "badge",
        obstacle: expect.stringContaining("blocker"),
      }),
    );
  });
});

it.each(["rotated label", "route badge", "walking station"])(
  "reserves %s geometry before placing a new row",
  (obstacle) => {
    let map: Schematic = {
      ...schematic,
      stations: [
        { ...schematic.stations[0]!, label: { x: 200, y: 220, anchor: "middle" as const } },
      ],
    };
    let hubs: readonly InterchangeHub[] = [hub];
    if (obstacle === "rotated label") {
      map = {
        ...map,
        stations: [
          ...map.stations,
          {
            id: "blocker",
            name: "Caption",
            x: 350,
            y: 250,
            lines: ["a"],
            label: { x: 180, y: 122, rot: 180, anchor: "end" },
          },
        ],
      };
    } else if (obstacle === "route badge") {
      map = {
        ...map,
        badges: [{ line: "a", num: "A", x: 200, y: 122, color: "red", textColor: "white" }],
      };
    } else {
      map = {
        ...map,
        stations: [
          ...map.stations,
          {
            id: "other",
            name: "Other",
            x: 140,
            y: 80,
            lines: ["a"],
            label: { x: 100, y: 55, anchor: "middle" },
          },
        ],
      };
      hubs = [
        hub,
        {
          id: "walk",
          endpoints: [
            { agencyId: "local", stationId: "other", stationName: "Other" },
            {
              agencyId: "regional-long-id",
              stationId: "central",
              stationName: "Central",
              walkingMarkers: { local: { dx: 60, dy: 42, label: "Peer" } },
            },
          ],
          badgeOffsets: { local: { dx: 130, dy: 42 } },
        },
      ];
    }
    const result = planInterchangeLayout(hubs, new Map(schematics).set("local", map), { agencies });
    const row = result.hubs.find((h) => h.id === hub.id)!;
    expect(row.badgeOffsets?.local).not.toEqual({ dx: 0, dy: -28 });
    expect(result.conflicts.filter((c) => c.agencyId === "local" && c.hubId === hub.id)).toEqual(
      [],
    );
  },
);

it("reports missing room for an automatic row and preserves the station relationships", () => {
  const tiny = {
    ...schematic,
    viewport: { ...schematic.viewport, bounds: { minX: 185, maxX: 215, minY: 135, maxY: 165 } },
  };
  const result = planInterchangeLayout([hub], new Map(schematics).set("local", tiny), { agencies });
  expect(result.conflicts).toContainEqual(
    expect.objectContaining({
      agencyId: "local",
      hubId: "transfer",
      kind: "badge",
      obstacle: "viewport",
    }),
  );
  expect(result.hubs[0]?.endpoints).toEqual(hub.endpoints);
});

it("rejects a distant compact row even when its full row reaches the source", () => {
  const third: InterchangeBadgeAgency = { ...agencies[1]!, agencyId: "third", shortName: "T" };
  const multi = {
    ...hub,
    endpoints: [
      ...hub.endpoints,
      { agencyId: "third", stationId: "central", stationName: "Central" },
    ],
  };
  const clean = {
    ...schematic,
    lines: [],
    stations: [{ ...schematic.stations[0]!, label: { x: 200, y: 230, anchor: "middle" as const } }],
  };
  const result = planInterchangeLayout(
    [multi],
    new Map(schematics).set("local", clean).set("third", schematic),
    {
      agencies: [...agencies, third],
      previous: [{ ...multi, badgeOffsets: { local: { dx: 80, dy: 0 } } }],
    },
  );
  expect(result.hubs[0]?.badgeOffsets?.local).not.toEqual({ dx: 80, dy: 0 });
});

it("does not let an invalid previous row displace a valid prior neighbour", () => {
  const map = {
    ...schematic,
    stations: [
      { id: "first", name: "First", x: 150, y: 150, lines: ["a"], label: { x: 150, y: 110 } },
      { id: "second", name: "Second", x: 300, y: 150, lines: ["a"], label: { x: 300, y: 110 } },
    ],
  };
  const first = {
    ...hub,
    id: "first",
    endpoints: [{ ...hub.endpoints[0]!, stationId: "first" }, hub.endpoints[1]!],
  };
  const second = {
    ...hub,
    id: "second",
    endpoints: [{ ...hub.endpoints[0]!, stationId: "second" }, hub.endpoints[1]!],
  };
  const result = planInterchangeLayout([first, second], new Map(schematics).set("local", map), {
    agencies,
    previous: [
      { ...first, badgeOffsets: { local: { dx: 0, dy: 28 } } },
      { ...second, badgeOffsets: { local: { dx: -150, dy: 28 } } },
    ],
  });
  expect(result.hubs.find((h) => h.id === "first")?.badgeOffsets?.local).toEqual({ dx: 0, dy: 28 });
  expect(result.hubs.find((h) => h.id === "second")?.badgeOffsets?.local).not.toEqual({
    dx: -150,
    dy: 28,
  });
});

it("reports a walking node and caption outside the drawable viewport", () => {
  const map = {
    ...schematic,
    stations: [
      { ...schematic.stations[0]!, x: 350, label: { x: 300, y: 210, anchor: "middle" as const } },
    ],
  };
  const walking = {
    ...hub,
    endpoints: [
      hub.endpoints[0]!,
      {
        ...hub.endpoints[1]!,
        walkingMarkers: { local: { dx: 60, dy: 0, label: "Regional Central" } },
      },
    ],
    badgeOffsets: { local: { dx: 10, dy: -35 } },
  };
  const result = planInterchangeLayout([walking], new Map(schematics).set("local", map), {
    agencies,
  });
  expect(result.conflicts).toContainEqual({
    agencyId: "local",
    hubId: "transfer",
    kind: "walking",
    obstacle: "viewport",
  });
});

it("reports a badge that reads as belonging to a different nearby station", () => {
  const map = {
    ...schematic,
    stations: [
      { ...schematic.stations[0]!, label: { x: 200, y: 100 } },
      {
        id: "neighbour",
        name: "Neighbour",
        x: 300,
        y: 150,
        lines: ["a"],
        label: { x: 300, y: 100 },
      },
    ],
    lines: [],
  };
  const reviewed = { ...hub, badgeOffsets: { local: { dx: 55, dy: 0 } } };
  const result = planInterchangeLayout([reviewed], new Map(schematics).set("local", map), {
    agencies,
  });
  expect(result.conflicts).toContainEqual({
    agencyId: "local",
    hubId: "transfer",
    kind: "badge",
    obstacle: "station-association:node:neighbour",
  });
});

it("does not reserve the empty corners of a rotated label's bounding box", () => {
  const map = {
    ...schematic,
    lines: [],
    stations: [
      {
        id: "central",
        name: "Central",
        x: 80,
        y: 62,
        lines: ["a"],
        label: { x: 80, y: 20, anchor: "middle" as const },
      },
      {
        id: "caption",
        name: "Long caption",
        x: 350,
        y: 250,
        lines: ["a"],
        label: { x: 80, y: 145, rot: -45, anchor: "start" as const },
      },
    ],
  };
  const previous = [{ ...hub, badgeOffsets: { local: { dx: 0, dy: 28 } } }];
  const result = planInterchangeLayout([hub], new Map(schematics).set("local", map), {
    agencies,
    previous,
  });
  expect(result.hubs[0]?.badgeOffsets?.local).toEqual({ dx: 0, dy: 28 });
  expect(result.conflicts.filter((c) => c.agencyId === "local")).toEqual([]);
});

it("settles crowded rows before returning so an unchanged reseed does not reflow", () => {
  const geometry = [
    ["s0", 143, 131, 315, 175],
    ["s1", 85, 82, 251, 152],
    ["s2", 116, 110, 92, 228],
    ["s4", 96, 129, 78, 174],
    ["s5", 176, 141, 212, 220],
    ["s6", 217, 74, 258, 185],
  ] as const;
  const local = {
    ...schematic,
    lines: [],
    stations: geometry.map(([id, x, y, lx, ly]) => ({
      id,
      name: `Station ${id}`,
      x,
      y,
      lines: ["a"],
      label: { x: lx, y: ly, anchor: "middle" as const },
    })),
  };
  const crowded = ["s0", "s2"].map((id) => ({
    ...hub,
    id,
    endpoints: [{ ...hub.endpoints[0]!, stationId: id }, hub.endpoints[1]!],
  }));
  const maps = new Map(schematics).set("local", local);
  const first = planInterchangeLayout(crowded, maps, { agencies });
  const second = planInterchangeLayout([...crowded].reverse(), maps, {
    agencies,
    previous: first.hubs,
  });
  expect(second.hubs).toEqual(first.hubs);
  expect(second.changes).toEqual([]);
  expect(first.conflicts.length).toBeGreaterThan(0);
});

it("reports unrelated route crossings near the smaller peer end of a walk", () => {
  const local = {
    ...schematic,
    stations: [
      { ...schematic.stations[0]!, y: 100, lines: ["a", "b", "c", "d"], label: { x: 200, y: 50 } },
    ],
    lines: [
      {
        ...schematic.lines[0]!,
        points: [
          { x: 30, y: 160 },
          { x: 370, y: 160 },
        ],
      },
    ],
  };
  const walking = {
    ...hub,
    endpoints: [
      hub.endpoints[0]!,
      { ...hub.endpoints[1]!, walkingMarkers: { local: { dx: 0, dy: 80, label: "Peer" } } },
    ],
  };
  const result = planInterchangeLayout([walking], new Map(schematics).set("local", local), {
    agencies,
  });
  expect(result.conflicts).toContainEqual({
    agencyId: "local",
    hubId: "transfer",
    kind: "walking",
    obstacle: "route:a",
  });
});

it.each([60, 250])(
  "falls back from an invalid walk to the reviewed ordinary row at dx %s",
  (dx) => {
    const local = {
      ...schematic,
      lines: [],
      stations: [
        { ...schematic.stations[0]!, x: 350, label: { x: 300, y: 210, anchor: "middle" as const } },
      ],
    };
    const walking = {
      ...hub,
      endpoints: [
        hub.endpoints[0]!,
        { ...hub.endpoints[1]!, walkingMarkers: { local: { dx, dy: 0, label: "Peer" } } },
      ],
      badgeOffsets: { local: { dx, dy: 28 } },
    };
    const result = planInterchangeLayout([walking], new Map(schematics).set("local", local), {
      agencies,
      previous: [{ ...hub, badgeOffsets: { local: { dx: 0, dy: -28 } } }],
    });
    expect(result.hubs[0]?.endpoints[1]?.walkingMarkers?.local).toBeUndefined();
    expect(result.hubs[0]?.badgeOffsets?.local).toEqual({ dx: 0, dy: -28 });
    expect(result.walkingFallbacks).toContainEqual(
      expect.objectContaining({
        agencyId: "local",
        hubId: "transfer",
        targetAgencyId: "regional-long-id",
        targetStationId: "central",
      }),
    );
  },
);

it("reports the former peer-relative badge when falling back and remains stable", () => {
  const walking = {
    ...hub,
    endpoints: [
      hub.endpoints[0]!,
      { ...hub.endpoints[1]!, walkingMarkers: { local: { dx: 250, dy: 0, label: "Peer" } } },
    ],
    badgeOffsets: { local: { dx: 250, dy: 28 } },
  };
  const first = planInterchangeLayout([walking], schematics, { agencies, previous: [walking] });
  expect(first.changes).toContainEqual(
    expect.objectContaining({
      agencyId: "local",
      hubId: "transfer",
      previous: { dx: 250, dy: 28 },
    }),
  );
  const second = planInterchangeLayout([walking], schematics, { agencies, previous: first.hubs });
  expect(second.hubs).toEqual(first.hubs);
  expect(second.changes).toEqual([]);
});

it("can clear a tall interchange node without treating its own capsule as a distant station", () => {
  const map = {
    ...schematic,
    viewport: { ...schematic.viewport, bounds: { minX: 160, maxX: 240, minY: 0, maxY: 300 } },
    lines: [],
    stations: [
      { ...schematic.stations[0]!, lines: ["a", "b", "c", "d"], label: { x: 200, y: 230 } },
    ],
  };
  const result = planInterchangeLayout([hub], new Map(schematics).set("local", map), { agencies });
  expect(result.conflicts.filter((c) => c.agencyId === "local")).toEqual([]);
});

it("fits a multi-agency row above a station by stacking within a narrow viewport", () => {
  const peer = { ...agencies[1]!, agencyId: "third", shortName: "T" };
  const multi = {
    ...hub,
    endpoints: [
      ...hub.endpoints,
      { agencyId: "third", stationId: "central", stationName: "Central" },
    ],
  };
  const map = {
    ...schematic,
    viewport: { ...schematic.viewport, bounds: { minX: 160, maxX: 240, minY: 0, maxY: 300 } },
    stations: [{ ...schematic.stations[0]!, label: { x: 200, y: 230 } }],
  };
  const result = planInterchangeLayout(
    [multi],
    new Map(schematics).set("local", map).set("third", schematic),
    { agencies: [...agencies, peer] },
  );
  expect(result.hubs[0]?.badgeOffsets?.local?.layout).toBe("vertical");
  expect(result.conflicts.filter((c) => c.agencyId === "local")).toEqual([]);
});
