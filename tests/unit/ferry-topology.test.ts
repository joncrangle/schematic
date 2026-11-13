import { expect, it } from "vitest";
import { modesToGtfsRouteTypes } from "~/infrastructure/gtfs/config";
import { inferRouteType } from "~/domain/surface/types";
import { parseRouteType, routeTypeToCode } from "~/infrastructure/storage/surfaceRowMappers";

it("retains ferry identity through mode selection, storage, and route interpretation", () => {
  expect(modesToGtfsRouteTypes(["bus", "ferry"])).toEqual(new Set([3, 4]));
  expect(parseRouteType(routeTypeToCode("ferry"))).toBe("ferry");
  expect(inferRouteType("harbour", { routeTypeRules: [{ routeType: "ferry", routeIds: ["harbour"] }] })).toBe("ferry");
});
