// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { WalkingInterchangeMarker } from "~/components/map/WalkingInterchangeMarker";
import { buildMapModel, type PositionedWalkingInterchangeMarker } from "~/core/map";
import { makeStationSchematic } from "../helpers/agency-fixtures";

afterEach(cleanup);

const marker: PositionedWalkingInterchangeMarker = {
  hubId: "local-regional-central",
  activeStationId: "market",
  activeStationName: "Market",
  targetAgencyId: "regional",
  targetAgencyName: "Regional Rail",
  targetStationId: "central",
  targetStationName: "Central",
  agencyLabel: "RR",
  color: "#ffe000",
  offset: { dx: 0, dy: -24 },
  sourceX: 400,
  sourceY: 300,
  x: 280,
  y: 380,
  label: "Regional Central",
};

it.each(["pointer", "Enter", " "])("opens the station card with %s input", (input) => {
  const onSelect = vi.fn();
  const { getByRole, container } = render(() => (
    <svg>
      <WalkingInterchangeMarker
        marker={marker}
        station={buildMapModel(makeStationSchematic(["Central"], "R")).stationList[0]!}
        isSelected={() => false}
        registerElement={vi.fn()}
        onSelect={onSelect}
      />
    </svg>
  ));
  const node = getByRole("button", {
    name: "Regional Central, Central station, line R, accessibility information unavailable",
  });
  expect(container.textContent).toContain("Regional Central");
  expect(container.textContent).toContain("walk");
  expect(container.querySelector("path")?.getAttribute("stroke-dasharray")).toBeTruthy();
  if (input === "pointer") fireEvent.click(node);
  else fireEvent.keyDown(node, { key: input });
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(marker);
});
