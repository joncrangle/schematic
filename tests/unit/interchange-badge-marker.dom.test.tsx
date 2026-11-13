// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InterchangeBadgeMarker } from "~/components/map/InterchangeBadgeMarker";
import { createInterchangeNavigation } from "~/components/map/interchange-navigation";
import type { InterchangeBadgeInfo, PositionedInterchangeBadge } from "~/core/map";

const badgeInfo: readonly InterchangeBadgeInfo[] = [
  {
    hubId: "union",
    activeStationId: "union",
    activeStationName: "Union",
    targetAgencyId: "go",
    targetAgencyName: "GO Transit",
    targetStationId: "union",
    targetStationName: "Union",
    agencyLabel: "GO",
    mode: "rail",
    color: "#00853F",
    x: 100,
    y: 200,
  },
  {
    hubId: "union",
    activeStationId: "union",
    activeStationName: "Union",
    targetAgencyId: "yrt",
    targetAgencyName: "York Region Transit",
    targetStationId: "union",
    targetStationName: "Union",
    agencyLabel: "YRT",
    color: "#004B87",
    x: 100,
    y: 200,
  },
];

const badges: readonly PositionedInterchangeBadge[] = badgeInfo.map((badge, index) => ({
  ...badge,
  width: 42,
  height: 18,
  rectY: -9,
  cornerRadius: 9,
  transformOrigin: "21px 0px",
  xOffsetFromCenter: index === 0 ? -44 : 2,
  yOffsetFromCenter: 0,
  rowTotalWidth: 88,
  textX: 19,
  hasIcon: true,
  isCompact: false,
}));

const compactBadges: readonly PositionedInterchangeBadge[] = badgeInfo.map((badge, index) => ({
  ...badge,
  width: 30,
  height: 14,
  rectY: -7,
  cornerRadius: 7,
  transformOrigin: "15px 0px",
  xOffsetFromCenter: index === 0 ? -32 : 2,
  yOffsetFromCenter: 0,
  rowTotalWidth: 64,
  textX: 15,
  hasIcon: false,
  isCompact: true,
}));

afterEach(cleanup);

describe("InterchangeBadgeMarker", () => {
  it("renders peer agencies as an inline accessible row and switches on pointer or keyboard action", () => {
    const onSelect = vi.fn();
    const { container } = render(() => (
      <svg>
        <InterchangeBadgeMarker badges={badges} onSelect={onSelect} />
      </svg>
    ));

    const controls = container.querySelectorAll('[role="button"]');
    expect(controls).toHaveLength(2);
    expect(controls[0]?.getAttribute("aria-label")).toBe("Switch to GO Transit at Union");
    expect(container.textContent).toContain("GO");
    expect(container.textContent).toContain("⇄ YRT");

    fireEvent.click(controls[0]!);
    fireEvent.keyDown(controls[1]!, { key: "Enter" });

    expect(onSelect).toHaveBeenNthCalledWith(1, badges[0]);
    expect(onSelect).toHaveBeenNthCalledWith(2, badges[1]);
  });

  it("renders bus and rail glyphs with the interchange prefix", () => {
    const { container } = render(() => (
      <svg>
        <InterchangeBadgeMarker
          badges={badges.map((badge, index) => ({ ...badge, mode: index === 0 ? "bus" : "rail" }))}
          onSelect={vi.fn()}
        />
      </svg>
    ));

    expect(container.querySelectorAll('[role="button"] > svg')).toHaveLength(2);
    expect(container.textContent).toContain("⇄ GO");
    expect(container.textContent).toContain("⇄ YRT");
  });

  it("uses a smaller compact badge without changing its one-tap action", () => {
    const onSelect = vi.fn();
    const { container } = render(() => (
      <svg>
        <InterchangeBadgeMarker badges={compactBadges} onSelect={onSelect} />
      </svg>
    ));

    const controls = container.querySelectorAll('[role="button"]');
    const compactBadge = container.querySelector("rect");

    expect(controls).toHaveLength(2);
    expect(container.textContent).toContain("GO");
    expect(container.textContent).toContain("YRT");
    expect(container.textContent).not.toContain("⇄");
    expect(compactBadge?.getAttribute("height")).toBe("14");
    expect(Number(compactBadge?.getAttribute("width"))).toBeLessThan(42);

    fireEvent.click(controls[0]!);

    expect(onSelect).toHaveBeenCalledWith(compactBadges[0]);
  });

  it("consumes the precomputed rectangle geometry", () => {
    const badge = { ...badges[0]!, rectY: 3, cornerRadius: 2, transformOrigin: "7px 4px" };
    const { container } = render(() => (
      <svg>
        <InterchangeBadgeMarker badges={[badge]} onSelect={vi.fn()} />
      </svg>
    ));

    const rect = container.querySelector("rect");
    expect(rect).not.toBeNull();
    expect(rect?.getAttribute("y")).toBe("3");
    expect(rect?.getAttribute("rx")).toBe("2");
    expect(rect?.getAttribute("style")).toContain("transform-origin: 7px 4px");
  });

  it("renders no interactive controls in hidden mode", () => {
    const { container } = render(() => (
      <svg>
        <InterchangeBadgeMarker badges={[]} onSelect={vi.fn()} />
      </svg>
    ));

    expect(container.querySelectorAll('[role="button"]')).toHaveLength(0);
    expect(container.querySelector(".interchange-badge-row")).toBeNull();
  });
});

describe("createInterchangeNavigation", () => {
  it("sets focus before the temporary agency transition regardless of saved selection", () => {
    const setFocus = vi.fn();
    const setTemporaryAgency = vi.fn();
    const navigate = createInterchangeNavigation({
      setFocus,
      setTemporaryAgency,
    });

    navigate({
      agencyId: "go",
      stationId: "bloor",
      stationName: "Bloor",
      origin: { agencyId: "ttc", stationId: "bloor-yonge" },
      screenScale: 2.25,
      screenPosition: { x: 320, y: 180 },
    });

    expect(setFocus).toHaveBeenCalledWith({
      agencyId: "go",
      stationId: "bloor",
      stationName: "Bloor",
      origin: { agencyId: "ttc", stationId: "bloor-yonge" },
      screenScale: 2.25,
      screenPosition: { x: 320, y: 180 },
    });
    expect(setTemporaryAgency).toHaveBeenCalledWith({
      agencyId: "go",
      stationId: "bloor",
      stationName: "Bloor",
      origin: { agencyId: "ttc", stationId: "bloor-yonge" },
      screenScale: 2.25,
      screenPosition: { x: 320, y: 180 },
    });
    expect(setFocus.mock.invocationCallOrder[0]).toBeLessThan(
      setTemporaryAgency.mock.invocationCallOrder[0],
    );
  });
});
