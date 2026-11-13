import { describe, expect, it } from "vitest";
import {
  filterNearbyStops,
  isEquivalentNearbyStop,
  isSameStop,
} from "~/domain/surface/revalidation";
import type { SurfaceStop } from "~/domain/surface/types";

function stopFixture(id: string, routes: readonly string[] = []): SurfaceStop {
  return {
    id,
    name: `Stop ${id}`,
    lat: 43.65,
    lon: -79.38,
    wheelchair: 1,
    routes,
  };
}

describe("revalidation: filterNearbyStops proximity boundary", () => {
  it("selects stops within the radius sorted by distance", () => {
    const near = { ...stopFixture("near"), lat: 43.6505 };
    const far = { ...stopFixture("far"), lat: 43.655 };
    const beyond = { ...stopFixture("beyond"), lat: 43.66 };

    const nearby = filterNearbyStops([beyond, far, near], 43.65, -79.38, 700);

    expect(nearby.map((entry) => entry.stop.id)).toEqual(["near", "far"]);
    expect(nearby[0].distanceMeters).toBeLessThan(nearby[1].distanceMeters);
  });

  it.each([
    [43.651, 2],
    [43.65, 1],
  ])("reports walking time for latitude %f as %i minutes", (lat, walkingMinutes) => {
    const stop = { ...stopFixture("walk"), lat };
    const nearby = filterNearbyStops([stop], 43.65, -79.38, 1500);

    expect(nearby[0].walkingMinutes).toBe(walkingMinutes);
  });

  it("keeps a stop inside the 1.5 km radius when the bbox edge rounds outward", () => {
    const rider = { lat: 43.63759781208061, lon: -79.53351055762522 };
    const stop = {
      ...stopFixture("594", ["49"]),
      name: "Bloor St West at Tremont Rd East Side",
      lat: 43.637886,
      lon: -79.55211,
    };

    const nearby = filterNearbyStops([stop], rider.lat, rider.lon, 1500);

    expect(nearby).toHaveLength(1);
    expect(nearby[0]?.distanceMeters).toBeLessThanOrEqual(1500);
  });
});

describe("revalidation: isSameStop predicate", () => {
  it("matches identical stop id", () => {
    const s1 = stopFixture("14816");
    const s2 = stopFixture("14816");
    expect(isSameStop(s1, s2)).toBe(true);
  });

  it("matches when stop codes match", () => {
    const s1: SurfaceStop = { ...stopFixture("14339"), code: "14816" };
    const s2: SurfaceStop = { ...stopFixture("14816"), code: "14816" };
    expect(isSameStop(s1, s2)).toBe(true);
  });

  it("matches when cached id matches live code", () => {
    const cached: SurfaceStop = stopFixture("14816");
    const live: SurfaceStop = { ...stopFixture("14339"), code: "14816" };
    expect(isSameStop(cached, live)).toBe(true);
  });

  it("matches when live id matches cached code", () => {
    const cached: SurfaceStop = { ...stopFixture("14339"), code: "14816" };
    const live: SurfaceStop = stopFixture("14816");
    expect(isSameStop(cached, live)).toBe(true);
  });

  it("returns false when ids and codes differ", () => {
    const s1: SurfaceStop = { ...stopFixture("14339"), code: "14816" };
    const s2: SurfaceStop = { ...stopFixture("7162"), code: "8132" };
    expect(isSameStop(s1, s2)).toBe(false);
  });
});

describe("revalidation: nearby stop alias predicate", () => {
  it("matches a nearby same-corridor stop alias", () => {
    const live = {
      ...stopFixture("live-alias"),
      name: "Main Street At First Avenue",
      lat: 10,
      lon: 20,
    };
    const cached = {
      ...stopFixture("cached-topology"),
      name: "Main Street At Third Avenue",
      lat: 10.001,
      lon: 20,
    };

    expect(isEquivalentNearbyStop(live, cached)).toBe(true);
  });

  it("does not match a nearby stop on an unrelated street", () => {
    const live = {
      ...stopFixture("stale"),
      name: "North Street At First Avenue",
      lat: 10,
      lon: 20,
    };
    const cached = {
      ...stopFixture("actual"),
      name: "South Street At Second Avenue",
      lat: 10.001,
      lon: 20,
    };

    expect(isEquivalentNearbyStop(live, cached)).toBe(false);
  });
});
