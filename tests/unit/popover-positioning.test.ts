import { describe, expect, it } from "vitest";
import { calculatePopoverPosition } from "../../src/components/map/popovers/popoverPosition";

describe("Popover Positioning & Screen Bounding Box Clamping", () => {
  const defaultPopoverSize = { width: 280, height: 200 };
  const defaultContainerSize = { width: 400, height: 800 };
  const padding = 12;

  it("should center popover horizontally and place above anchor when space permits", () => {
    const anchor = { x: 200, y: 400 };
    const pos = calculatePopoverPosition(anchor, defaultPopoverSize, defaultContainerSize, {
      topOffset: 8,
      padding,
    });

    // Horizontally centered: 200 - 280/2 = 60
    expect(pos.x).toBe(60);
    // Vertically placed above: 400 - 8 - 200 = 192
    expect(pos.y).toBe(192);
    expect(pos.placement).toBe("top");
    // Arrow centered: 200 - 60 = 140
    expect(pos.arrowLeft).toBe(140);
  });

  it("should clamp popover within left screen boundary when anchor is near left edge", () => {
    const anchor = { x: 10, y: 400 };
    const pos = calculatePopoverPosition(anchor, defaultPopoverSize, defaultContainerSize, {
      topOffset: 8,
      padding,
    });

    // Left edge must not be less than padding (12)
    expect(pos.x).toBe(padding);
    expect(pos.x + defaultPopoverSize.width).toBeLessThanOrEqual(
      defaultContainerSize.width - padding,
    );

    // Arrow should be clamped to arrowPadding (16) instead of going off to the left
    expect(pos.arrowLeft).toBe(16);
  });

  it("should clamp popover within right screen boundary when anchor is near right edge", () => {
    const anchor = { x: 395, y: 400 };
    const pos = calculatePopoverPosition(anchor, defaultPopoverSize, defaultContainerSize, {
      topOffset: 8,
      padding,
    });

    const expectedMaxLeft = defaultContainerSize.width - padding - defaultPopoverSize.width; // 400 - 12 - 280 = 108
    expect(pos.x).toBe(expectedMaxLeft);
    expect(pos.x + defaultPopoverSize.width).toBe(defaultContainerSize.width - padding);

    // Arrow should be clamped near right corner (280 - 16 = 264)
    expect(pos.arrowLeft).toBe(defaultPopoverSize.width - 16);
  });

  it("should flip popover below anchor when near top edge of the screen", () => {
    const anchor = { x: 200, y: 50 };
    const pos = calculatePopoverPosition(anchor, defaultPopoverSize, defaultContainerSize, {
      topOffset: 8,
      bottomOffset: 8,
      padding,
    });

    expect(pos.placement).toBe("bottom");
    // Placed below: anchor.y + bottomOffset = 50 + 8 = 58
    expect(pos.y).toBe(58);
    expect(pos.y).toBeGreaterThanOrEqual(padding);
    expect(pos.y + defaultPopoverSize.height).toBeLessThanOrEqual(
      defaultContainerSize.height - padding,
    );
  });

  it("should place popover above anchor and clamp inside screen when near bottom edge", () => {
    const anchor = { x: 200, y: 780 };
    const pos = calculatePopoverPosition(anchor, defaultPopoverSize, defaultContainerSize, {
      topOffset: 8,
      bottomOffset: 8,
      padding,
    });

    expect(pos.placement).toBe("top");
    // 780 - 8 - 200 = 572
    expect(pos.y).toBe(572);
    expect(pos.y + defaultPopoverSize.height).toBeLessThanOrEqual(
      defaultContainerSize.height - padding,
    );
  });

  it("should handle viewports narrower than popover width without crashing or negative bounds", () => {
    const smallContainer = { width: 250, height: 500 };
    const anchor = { x: 125, y: 250 };
    const pos = calculatePopoverPosition(anchor, defaultPopoverSize, smallContainer, {
      topOffset: 8,
      padding,
    });

    expect(pos.x).toBe(padding);
    expect(pos.y).toBeGreaterThanOrEqual(padding);
  });

  it("should handle unmeasured container dimensions gracefully with fallback", () => {
    const zeroContainer = { width: 0, height: 0 };
    const anchor = { x: 100, y: 150 };
    const pos = calculatePopoverPosition(anchor, defaultPopoverSize, zeroContainer, {
      topOffset: 8,
      padding,
    });

    expect(pos.x).toBe(anchor.x - defaultPopoverSize.width / 2);
    expect(pos.y).toBe(anchor.y - 8 - defaultPopoverSize.height);
    expect(pos.placement).toBe("top");
  });
});
