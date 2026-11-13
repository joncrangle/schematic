import { describe, expect, it } from "vitest";
import { stationLabelLeaderStart } from "~/core/map/interchange-geometry";

describe("station label leaders", () => {
  it.each([
    { isInterchange: false, lines: ["a"], labelX: 140, labelY: 100, x: 104.8, y: 100 },
    { isInterchange: false, lines: ["a"], labelX: 60, labelY: 60, x: 96.60589, y: 96.60589 },
    { isInterchange: true, lines: ["a", "b"], labelX: 100, labelY: 140, x: 100, y: 110.7 },
    { isInterchange: true, lines: ["a", "b"], labelX: 60, labelY: 100, x: 93.8, y: 100 },
    { isInterchange: true, lines: ["a", "b", "c", "d"], labelX: 100, labelY: 60, x: 100, y: 82.1 },
  ])("starts at the visible marker edge for $labelX,$labelY", ({ x, y, ...station }) => {
    const start = stationLabelLeaderStart({ ...station, x: 100, y: 100 });
    expect(start?.x).toBeCloseTo(x, 4);
    expect(start?.y).toBeCloseTo(y, 4);
  });

  it("follows a rounded interchange corner rather than its bounding box", () => {
    const start = stationLabelLeaderStart({
      x: 0,
      y: 0,
      labelX: 20,
      labelY: 30,
      isInterchange: true,
      lines: ["a", "b"],
    });
    expect(start?.x).toBeCloseTo(5.568, 2);
    expect(start?.y).toBeCloseTo(8.352, 2);
  });

  it("omits a leader when the caption anchor is inside the marker", () => {
    expect(
      stationLabelLeaderStart({
        x: 100,
        y: 100,
        labelX: 100,
        labelY: 100,
        isInterchange: false,
        lines: ["a"],
      }),
    ).toBeUndefined();
  });
});
