import { expect, it, vi } from "vitest";
import { makeTestManifest } from "../helpers/agency-fixtures";
import { parseNearbyRpcInput } from "~/services/nearby/rpcInput";
import {
  parseRoutesMetadataInput,
  parseRouteTrackingInput,
  parseSavedTransitInput,
} from "~/services/surface/SurfaceClient";
import { parseSavedStationsInput, parseStationDeparturesInput } from "~/services/StationsClient";

vi.mock("~/agencies/agencyCatalog", async () => {
  const { testAgencyCatalog } = await import("../helpers/agency-fixtures");
  return { agencyCatalog: testAgencyCatalog };
});

const agencyId = makeTestManifest().id;
const boundaries = [
  ["nearby", (locale: unknown) => parseNearbyRpcInput({ agencyId, lat: 43.5, lon: -79.5, locale })],
  [
    "saved transit",
    (locale: unknown) => parseSavedTransitInput({ agencyId, favouriteRoutes: [], locale }),
  ],
  [
    "route tracking",
    (locale: unknown) => parseRouteTrackingInput({ agencyId, routeId: "A", locale }),
  ],
  [
    "saved stations",
    (locale: unknown) => parseSavedStationsInput({ agencyId, stationNames: [], locale }),
  ],
  [
    "station departures",
    (locale: unknown) => parseStationDeparturesInput({ agencyId, stationId: "hub", locale }),
  ],
] as const;

const invalidLocales = [
  ["null", null],
  ["non-string", 123],
  ["empty", ""],
  ["blank", " "],
  ["malformed", "not_a_tag"],
  ["unsupported", "de-DE"],
] as const;

it.each(
  boundaries.flatMap(([boundary, parse]) =>
    invalidLocales.map(([invalid, locale]) => ({ boundary, parse, invalid, locale })),
  ),
)("$boundary rejects $invalid locales", ({ parse, locale }) => {
  expect(() => parse(locale)).toThrow(/locale/i);
});

it("bounds saved-transit favourite routes to 100 entries", () => {
  const route = (index: number) => `route-${index}`;
  const maximum = Array.from({ length: 100 }, (_, index) => route(index));
  const tooMany = [...maximum, route(100)];

  expect(parseSavedTransitInput({ agencyId, favouriteRoutes: maximum }).favouriteRoutes).toEqual(
    maximum,
  );
  expect(() => parseSavedTransitInput({ agencyId, favouriteRoutes: tooMany })).toThrow(/100/);
});

it("bounds route-metadata ids to 100 distinct entries", () => {
  const route = (index: number) => `route-${index}`;
  const maximum = Array.from({ length: 100 }, (_, index) => route(index));

  expect(
    parseRoutesMetadataInput({ agencyId, routeIds: [...maximum, " route-0 ", ""] }).routeIds,
  ).toEqual(maximum);
  expect(() => parseRoutesMetadataInput({ agencyId, routeIds: [...maximum, route(100)] })).toThrow(
    /100/,
  );
});

it.each([
  [
    "saved transit",
    (lat: unknown, lon: unknown) =>
      parseSavedTransitInput({ agencyId, favouriteRoutes: [], lat, lon } as never),
  ],
  [
    "saved stations",
    (lat: unknown, lon: unknown) =>
      parseSavedStationsInput({ agencyId, stationNames: [], lat, lon } as never),
  ],
] as const)("%s keeps only finite numeric rider coordinates", (_boundary, parse) => {
  expect(parse(43.5, -79.5)).toMatchObject({ lat: 43.5, lon: -79.5 });
  for (const invalid of ["43.5", Number.NaN, Number.POSITIVE_INFINITY, null, {}]) {
    const parsed = parse(invalid, invalid);
    expect(parsed.lat).toBeUndefined();
    expect(parsed.lon).toBeUndefined();
  }
});

it.each([
  [undefined, 0],
  [0, 0],
  [1, 1],
  ["1", 1],
])("route tracking reads direction %p as %p", (directionId, expected) => {
  expect(
    parseRouteTrackingInput({ agencyId, routeId: "A", directionId } as never).directionId,
  ).toBe(expected);
});

it.each([2, -1, 0.5, Number.NaN, "north", "1abc", "", null, {}])(
  "route tracking rejects direction %p",
  (directionId) => {
    expect(() => parseRouteTrackingInput({ agencyId, routeId: "A", directionId } as never)).toThrow(
      /directionId/,
    );
  },
);
