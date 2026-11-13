import { describe, expect, it } from "vitest";

import { labelsForRoute } from "~/infrastructure/storage/surfaceStore/reads";

/**
 * The D1 read path's contribution to the three-source direction precedence.
 *
 * `buildDirectionLabels` reads a bearing out of a headsign first, then falls
 * back to the bearing of the shape's own geometry. Both call sites in
 * `reads.ts` build their facts map through `labelsForRoute`, and both used to
 * hand it a headsign with no polyline, so source two could never fire on the
 * D1 or topology path. `NearbyTransit` passes `RouteDetails`, which do carry a
 * polyline, so the same route could state a direction in the nearby panel and
 * not in the topology read. The label is rider-facing either way, so the two
 * paths have to agree on which sources they offer.
 *
 * These polylines are encoded from two points at a shared latitude, with
 * longitude increasing and then decreasing, so they run east and west.
 */
const EASTBOUND = "_bohG~sijN?_pR";
const WESTBOUND = "_bohG~bviN?~oR";

describe("labelsForRoute resolves the direction from the stored shape", () => {
  it("reads a stated bearing from the headsign alone", () => {
    // Source one needs no geometry, which is why the missing polyline went
    // unnoticed: every headsign that names a direction still worked.
    const labels = labelsForRoute([{ directionId: 0, headsign: "West to Dundas West" }], "504");

    expect(labels[0].label).toBe("Westbound");
  });

  it("falls back to the shape's own bearing when the headsign states none", () => {
    // Source two, and the reason the polyline has to be threaded through. A GO
    // headsign names a terminal and never a compass word, so every rail
    // direction in the product is decided by this source.
    const labels = labelsForRoute(
      [
        { directionId: 0, headsign: "LW - Aldershot GO", polyline: EASTBOUND },
        { directionId: 1, headsign: "LW - Union Station GO", polyline: WESTBOUND },
      ],
      "LW",
    );

    expect(labels[0].label).toBe("Eastbound");
    expect(labels[1].label).toBe("Westbound");
    // The destination stays the operator's terminal, not a derived guess.
    expect(labels[0].destination).toBe("Aldershot GO");
  });

  it("leaves the direction out when neither source states one", () => {
    // No invented compass word: an empty headsign and no geometry means no
    // direction, which is the honest answer rather than a canonical literal.
    const labels = labelsForRoute([{ directionId: 0, headsign: "", polyline: "" }], "504");

    expect(labels[0].label).toBe("");
  });

  it("labels both directions of one route from the same facts", () => {
    // One call per route, so the two directions resolve from one another's
    // context rather than each in isolation.
    const labels = labelsForRoute(
      [
        { directionId: 0, headsign: "LW - Aldershot GO", polyline: WESTBOUND },
        { directionId: 1, headsign: "LW - Union Station GO", polyline: EASTBOUND },
      ],
      "LW",
    );

    expect(labels[0].label).toBe("Westbound");
    expect(labels[1].label).toBe("Eastbound");
  });
});
