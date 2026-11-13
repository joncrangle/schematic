import { countries } from "../helpers/coverage-countries";
import { describe, expect, it } from "vitest";
import type { BrowserAgency } from "~/agencies/types";
import {
  agencySpanKilometers,
  boundaryOpacityForZoom,
  buildCoverageAgencies,
  buildCoverageView,
  createProjection,
  focusedCoverageCountry,
  coverageCountsForCountry,
  geographyPath,
  layoutLabels,
  outlineChunks,
  scaleBarFor,
  type CoverageAgency,
} from "~/components/network-coverage/coverageModel";
import type { CoverageGeography } from "~/components/network-coverage/generated/geography";
import { makeTestProvider } from "../helpers/agency-fixtures";

type ManifestOverrides = Parameters<typeof makeTestProvider>[0];

function browserAgency(overrides: ManifestOverrides = {}): BrowserAgency {
  const provider = makeTestProvider(overrides);
  return { manifest: provider.manifest, brandColor: provider.manifest.brandColor };
}

function coverageAgency(
  id: string,
  footprint: CoverageAgency["footprint"],
  center: CoverageAgency["center"],
): CoverageAgency {
  return {
    id,
    name: id,
    shortName: id,
    color: "#123456",
    glow: "#456789",
    status: "active",
    scope: "regional",
    countries: ["ca"],
    modes: ["bus"],
    bounds: [footprint],
    center,
    labelCenter: center,
    footprint,
    isCurrent: false,
  };
}

describe("coverage projection", () => {
  it("fits a longitude-corrected box without stretching it", () => {
    const projection = createProjection(
      { minLat: 40, maxLat: 50, minLon: -90, maxLon: -80 },
      100,
      100,
      0,
    );
    const topLeft = projection.project(-90, 50);
    const bottomRight = projection.project(-80, 40);

    expect(projection.scale).toBeCloseTo(10);
    expect(topLeft.y).toBeCloseTo(0);
    expect(topLeft.x).toBeCloseTo(14.64, 1);
    expect(bottomRight.y - topLeft.y).toBeCloseTo(100);
    expect(bottomRight.x - topLeft.x).toBeCloseTo(70.71, 1);
  });
});

describe("coverage scale bar", () => {
  it.each([1, 10, 100])("represents the labelled ground distance at zoom %s", (zoom) => {
    for (const unit of ["metric", "imperial"] as const) {
      const bar = scaleBarFor(10, zoom, unit);
      const kilometers = bar.distance * (unit === "imperial" ? 1.609344 : 1);
      expect(bar.length / (10 * zoom)).toBeCloseTo(kilometers / 111.32, 5);
      expect(bar.length).toBeLessThanOrEqual(140);
      expect(bar.unit).toBe(unit === "metric" ? "km" : "mi");
    }
  });
});

describe("horizontal coverage scale", () => {
  it.each([44, 70])("measures east-west distances at latitude %s", (latitude) => {
    const projection = createProjection(
      { minLat: 40, maxLat: 80, minLon: -140, maxLon: -50 },
      1200,
      800,
    );
    const start = projection.project(-100, latitude);
    const bar = scaleBarFor(projection.horizontalScaleAt(start.y), 4, "metric");
    const longitudeDelta = bar.distance / (111.32 * Math.cos((latitude * Math.PI) / 180));
    const end = projection.project(-100 + longitudeDelta, latitude);
    expect((end.x - start.x) * 4).toBeCloseTo(bar.length, 5);
  });
});

describe("coverage agency model", () => {
  it("uses the declared focus and falls back to the bounds midpoint", () => {
    const agencies = buildCoverageAgencies(
      [
        browserAgency({
          id: "focused",
          focus: { lat: 43.7, lon: -79.4 },
          bounds: [{ minLat: 43, maxLat: 45, minLon: -81, maxLon: -78 }],
        }),
        browserAgency({
          id: "centered",
          bounds: [{ minLat: 43, maxLat: 45, minLon: -81, maxLon: -79 }],
        }),
      ],
      "focused",
      countries,
    );

    expect(agencies.find((agency) => agency.id === "focused")?.center).toEqual({
      lat: 43.7,
      lon: -79.4,
    });
    expect(agencies.find((agency) => agency.id === "focused")?.isCurrent).toBe(true);
    expect(agencies.find((agency) => agency.id === "centered")?.center).toEqual({
      lat: 44,
      lon: -80,
    });
  });

  it("keeps a marker on a cloud when the focus lands between disjoint bounds", () => {
    const [agency] = buildCoverageAgencies(
      [
        browserAgency({
          id: "disjoint",
          bounds: [
            { minLat: 43, maxLat: 45, minLon: -80, maxLon: -78 },
            { minLat: 46, maxLat: 46.5, minLon: -75, maxLon: -74.5 },
          ],
        }),
      ],
      undefined,
      countries,
    );

    expect(agency?.center.lat).toBeLessThan(45);
    expect(agency?.center.lon).toBeLessThan(-78);
  });

  it("anchors a network label at the station nearest the network midpoint", () => {
    const [agency] = buildCoverageAgencies(
      [
        browserAgency({
          id: "national",
          scope: "national",
          focus: { lat: 43.7, lon: -79.4 },
          bounds: [
            { minLat: 43.6, maxLat: 43.7, minLon: -79.5, maxLon: -79.3 },
            { minLat: 49.8, maxLat: 49.9, minLon: -97.2, maxLon: -97.0 },
            { minLat: 49.2, maxLat: 49.3, minLon: -123.2, maxLon: -123.0 },
          ],
        }),
      ],
      undefined,
      countries,
    );

    expect(agency?.center).toEqual({ lat: 43.7, lon: -79.4 });
    expect(agency?.labelCenter.lat).toBeCloseTo(49.85);
    expect(agency?.labelCenter.lon).toBeCloseTo(-97.1);
  });

  it("anchors equally sized disjoint zones inside a declared zone", () => {
    const bounds = [
      { minLat: 43, maxLat: 44, minLon: -80, maxLon: -79 },
      { minLat: 46, maxLat: 47, minLon: -75, maxLon: -74 },
    ];
    const [agency] = buildCoverageAgencies(
      [browserAgency({ id: "split", bounds })],
      undefined,
      countries,
    );
    expect(
      bounds.some(
        (box) =>
          agency.center.lat >= box.minLat &&
          agency.center.lat <= box.maxLat &&
          agency.center.lon >= box.minLon &&
          agency.center.lon <= box.maxLon,
      ),
    ).toBe(true);
  });

  it("uses the declared footprint union", () => {
    const [agency] = buildCoverageAgencies(
      [
        browserAgency({
          id: "footprint",
          bounds: [
            { minLat: 43, maxLat: 44, minLon: -80, maxLon: -79 },
            { minLat: 45, maxLat: 46, minLon: -76, maxLon: -75 },
          ],
        }),
      ],
      undefined,
      countries,
    );

    expect(agency?.footprint).toEqual({
      minLat: 43,
      maxLat: 46,
      minLon: -80,
      maxLon: -75,
    });
  });

  it("reports the longest service span in kilometres", () => {
    const span = agencySpanKilometers(
      coverageAgency(
        "span",
        { minLat: 43, maxLat: 44, minLon: -80, maxLon: -79 },
        { lat: 43.5, lon: -79.5 },
      ),
    );

    expect(span).toBe(111);
  });
});

describe("coverage view", () => {
  it("frames only the southern plate when southern agencies are mapped", () => {
    const agencies = [
      coverageAgency(
        "south",
        { minLat: 43, maxLat: 44, minLon: -80, maxLon: -79 },
        { lat: 43.5, lon: -79.5 },
      ),
      coverageAgency(
        "north",
        { minLat: 49, maxLat: 50, minLon: -85, maxLon: -84 },
        { lat: 49.5, lon: -84.5 },
      ),
    ];

    const view = buildCoverageView(agencies);

    expect(view.focusBounds.maxLat).toBeCloseTo(44.08);
    expect(view.focusBounds.minLat).toBeCloseTo(42.92);
  });

  it("falls back to every mapped agency when none are southern", () => {
    const agencies = [
      coverageAgency(
        "north",
        { minLat: 49, maxLat: 50, minLon: -85, maxLon: -84 },
        { lat: 49.5, lon: -84.5 },
      ),
    ];

    const view = buildCoverageView(agencies);

    expect(view.focusBounds.maxLat).toBeCloseTo(50.08);
  });
});

describe("coverage boundaries", () => {
  it("hides admin-1 borders at continent scale and fades them in when zoomed", () => {
    expect(boundaryOpacityForZoom(1)).toBe(0);
    expect(boundaryOpacityForZoom(3)).toBe(0);
    expect(boundaryOpacityForZoom(5)).toBeGreaterThan(0);
    expect(boundaryOpacityForZoom(7)).toBeGreaterThan(boundaryOpacityForZoom(5));
    expect(boundaryOpacityForZoom(20)).toBe(boundaryOpacityForZoom(7));
  });
});

describe("coverage geometry", () => {
  const longRing = [
    ...Array.from({ length: 100 }, (_, index) => [-80 + index * 0.1, 44] as const),
    ...Array.from({ length: 100 }, (_, index) => [-70.1 - index * 0.1, 43] as const),
  ];
  const hole = [
    [-76, 43.4],
    [-75, 43.4],
    [-75, 43.6],
    [-76, 43.6],
  ] as const;
  it.each([
    { name: "an open ring", polygon: { outer: longRing }, rings: [longRing] },
    { name: "a closed ring", polygon: { outer: [...longRing, longRing[0]] }, rings: [longRing] },
    {
      name: "a ring with a hole",
      polygon: { outer: longRing, holes: [hole, [[-74, 43.5]] as const] },
      rings: [longRing, hole],
    },
  ])("cuts $name into cell-sized outline runs that draw every edge once", ({ polygon, rings }) => {
    const edge = (a: readonly number[], b: readonly number[]) => `${a.join()}>${b.join()}`;
    const runs = outlineChunks({ polygons: [polygon] }, 4).flat();
    const span = (run: readonly (readonly number[])[], axis: number) =>
      Math.max(...run.map((point) => point[axis])) - Math.min(...run.map((point) => point[axis]));

    expect(runs.filter((run) => run.length > 2 && (span(run, 0) > 4 || span(run, 1) > 4))).toEqual(
      [],
    );
    expect(
      runs.flatMap((run) => run.slice(1).map((point, index) => edge(run[index], point))).sort(),
    ).toEqual(
      rings
        .flatMap((ring) => ring.map((point, index) => edge(point, ring[(index + 1) % ring.length])))
        .sort(),
    );
  });

  it("draws outer rings and holes as one path", () => {
    const geography: CoverageGeography = {
      id: "test",
      label: "Test",
      source: "fixture",
      sourceFeature: "fixture",
      bounds: { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 },
      polygons: [
        {
          outer: [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
          holes: [
            [
              [0.2, 0.2],
              [0.4, 0.2],
              [0.4, 0.4],
              [0.2, 0.2],
            ],
          ],
        },
      ],
    };

    const path = geographyPath(geography, (lon, lat) => ({ x: lon, y: lat }));

    expect(path.match(/Z/g)).toHaveLength(2);
    expect(path.startsWith("M")).toBe(true);
  });
});

describe("coverage label layout", () => {
  it("gives the preferred label first choice and separates a colliding label", () => {
    const high = { id: "high", x: 50, y: 50, text: "High", priority: 2 };
    const placements = layoutLabels(
      [{ id: "low", x: 50, y: 50, text: "Low", priority: 0 }, high],
      100,
      100,
    );

    expect(placements.get("high")).toEqual(layoutLabels([high], 100, 100).get("high"));
    expect([...placements.keys()].sort()).toEqual(["high", "low"]);
    expect(placements.get("low")).not.toEqual(placements.get("high"));
  });

  it("drops labels that cannot fit inside the map", () => {
    const placements = layoutLabels(
      [{ id: "edge", x: 0, y: 0, text: "Edge", priority: 0 }],
      100,
      100,
    );

    expect(placements.size).toBe(0);
  });
});

describe("country coverage counts", () => {
  const agencies = buildCoverageAgencies(
    [
      browserAgency({ id: "local", jurisdiction: { country: "ca" } }),
      browserAgency({
        id: "national",
        scope: "national",
        jurisdiction: { country: "us" },
        bounds: [{ minLat: 40.7, maxLat: 40.8, minLon: -74.1, maxLon: -74 }],
      }),
      browserAgency({
        id: "cross-border",
        scope: "international",
        jurisdiction: { country: "ca" },
        bounds: [
          { minLat: 43.6, maxLat: 43.8, minLon: -79.5, maxLon: -79.3 },
          { minLat: 40.7, maxLat: 40.8, minLon: -74.1, maxLon: -74 },
        ],
      }),
    ],
    undefined,
    countries,
  );

  it.each([
    [{ lat: 43.7, lon: -79.4 }, "ca", { total: 2, regional: 1, national: 0, international: 1 }],
    [{ lat: 40.75, lon: -74.05 }, "us", { total: 2, regional: 0, national: 1, international: 1 }],
    [{ lat: 19, lon: -99 }, undefined, { total: 0, regional: 0, national: 0, international: 0 }],
    [{ lat: 0, lon: 0 }, undefined, { total: 0, regional: 0, national: 0, international: 0 }],
  ] as const)("counts agencies serving the country at %j", (center, country, counts) => {
    expect(focusedCoverageCountry(center, countries)).toBe(country);
    expect(coverageCountsForCountry(agencies, country)).toEqual(counts);
  });
});

it.each([
  [{ lat: 49.2827, lon: -123.1207 }, "ca"],
  [{ lat: 46.5075, lon: -84.2955 }, "ca"],
  [{ lat: 48.610282, lon: -93.38655 }, "ca"],
  [{ lat: 49.01, lon: -100 }, "ca"],
  [{ lat: 48.99, lon: -100 }, "us"],
  [{ lat: 40.7506, lon: -73.9935 }, "us"],
] as const)("classifies coastal transit locations %j", (point, country) => {
  expect(focusedCoverageCountry(point, countries)).toBe(country);
});

it.each(["regional", "national", "international"] as const)(
  "counts cross-border %s service in both countries",
  (scope) => {
    const agencies = buildCoverageAgencies(
      [
        browserAgency({
          id: "cross-border",
          scope,
          jurisdiction: { country: "ca" },
          bounds: [
            { minLat: 43.69, maxLat: 43.71, minLon: -79.41, maxLon: -79.39 },
            { minLat: 40.7505, maxLat: 40.7507, minLon: -73.9936, maxLon: -73.9934 },
          ],
        }),
      ],
      undefined,
      countries,
    );
    expect(coverageCountsForCountry(agencies, "ca")[scope]).toBe(1);
    expect(coverageCountsForCountry(agencies, "us")[scope]).toBe(1);
  },
);
