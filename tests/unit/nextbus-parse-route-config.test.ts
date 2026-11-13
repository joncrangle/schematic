import { describe, expect, it } from "vitest";
import { parseNextBusRouteConfigJson } from "~/domain/nextbus/parseRouteConfig";

describe("parseNextBusRouteConfigJson", () => {
  const fallbackBounds = {
    minLat: 43.6,
    maxLat: 43.8,
    minLon: -79.5,
    maxLon: -79.3,
  };

  it("prefers stopId over tag for stop.id and stop.code (matching GTFS seed identity)", () => {
    const payload = {
      route: {
        tag: "510",
        title: "510 - Spadina",
        stop: [
          {
            tag: "14339",
            stopId: "14816",
            title: "Spadina Station",
            lat: "43.6672",
            lon: "-79.4036",
          },
          {
            tag: "7162",
            stopId: "8132",
            title: "Spadina Ave At Sussex Ave",
            lat: "43.6642",
            lon: "-79.4026",
          },
        ],
        direction: [
          {
            tag: "510_0_510A",
            name: "South",
            title: "South - 510 Spadina towards Union Station",
            useForUI: "true",
            stop: [{ tag: "14339" }, { tag: "7162" }],
          },
        ],
      },
    };

    const result = parseNextBusRouteConfigJson(payload, {
      routeId: "510",
      fallbackBounds,
    });

    // All stops list has GTFS stopId
    expect(result.allStops).toHaveLength(2);
    expect(result.allStops[0]?.id).toBe("14816");
    expect(result.allStops[0]?.code).toBe("14816");
    expect(result.allStops[1]?.id).toBe("8132");
    expect(result.allStops[1]?.code).toBe("8132");

    // Direction stops resolve using tag references but yield stops with GTFS stopId
    const dir0 = result.detailsByDir.get(0);
    expect(dir0).toBeDefined();
    expect(dir0!.stops).toHaveLength(2);
    expect(dir0!.stops[0]?.id).toBe("14816");
    expect(dir0!.stops[1]?.id).toBe("8132");
  });

  it("falls back to tag when stopId is absent (e.g. arrival/loop stops)", () => {
    const payload = {
      route: {
        tag: "510",
        title: "510 - Spadina",
        stop: [
          {
            tag: "14339_ar",
            title: "Spadina Station Drop-off",
            lat: "43.6672",
            lon: "-79.4036",
          },
        ],
        direction: [
          {
            tag: "510_1_510A",
            name: "North",
            title: "North - 510 Spadina towards Spadina Station",
            useForUI: "true",
            stop: [{ tag: "14339_ar" }],
          },
        ],
      },
    };

    const result = parseNextBusRouteConfigJson(payload, {
      routeId: "510",
      fallbackBounds,
    });

    expect(result.allStops[0]?.id).toBe("14339_ar");
    expect(result.allStops[0]?.code).toBeUndefined();
  });
});
