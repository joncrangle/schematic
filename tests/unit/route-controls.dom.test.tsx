// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { RouteControls } from "~/components/map/RouteControls";

afterEach(cleanup);

describe("enlarged route direction indicator", () => {
  it("identifies position-only tracking without inventing a direction or stop predictions", () => {
    const { getByText, queryByRole } = render(() => (
      <RouteControls
        routeId="R"
        routeShortName="R"
        routeLongName="Rural vehicles"
        vehiclePositionsOnly
        onClearRoute={() => {}}
        availableDirectionIds={[0, 1]}
        tracking={{
          data: () => null,
          isStaleForDirection: () => false,
          nearestStopId: () => undefined,
          onDataArrival: () => () => {},
          selectDirection: () => {},
          selectedDirectionId: () => 0,
        }}
      />
    ));
    expect(getByText("Live vehicle positions").getAttribute("title")).toBe(
      "Live vehicle positions",
    );
    expect(getByText(/Stop predictions unavailable/)).toBeDefined();
    expect(queryByRole("tablist")).toBeNull();
    expect(queryByRole("button", { name: /Switch route direction/ })).toBeNull();
  });

  it.each([
    ["stale", "Last known vehicle positions"],
    ["unavailable", "Live vehicle positions unavailable"],
  ] as const)("does not present a %s fleet as live or active", (freshness, label) => {
    const { getAllByText, queryByText } = render(() => (
      <RouteControls
        routeId="R"
        routeShortName="R"
        routeLongName="Rural vehicles"
        vehiclePositionsOnly
        vehiclePositionsFreshness={freshness}
        onClearRoute={() => {}}
        availableDirectionIds={[0]}
        tracking={{
          data: () => null,
          isStaleForDirection: () => false,
          nearestStopId: () => undefined,
          onDataArrival: () => () => {},
          selectDirection: () => {},
          selectedDirectionId: () => 0,
        }}
      />
    ));
    expect(getAllByText(label).length).toBeGreaterThan(0);
    expect(queryByText(/active vehicle/)).toBeNull();
  });

  it("shows a single declared direction as a static headsign without switch controls", () => {
    const selectDirection = vi.fn();
    const { queryByRole, getByText } = render(() => (
      <RouteControls
        routeId="L"
        routeShortName="L"
        routeLongName="Loop"
        onClearRoute={() => {}}
        availableDirectionIds={[0]}
        directionLabels={{
          0: { label: "", destination: "Central Terminal" },
          1: { label: "", destination: "" },
        }}
        tracking={{
          data: () => null,
          isStaleForDirection: () => false,
          nearestStopId: () => undefined,
          onDataArrival: () => () => {},
          selectDirection,
          selectedDirectionId: () => 0,
        }}
      />
    ));
    expect(getByText("Central Terminal")).toBeDefined();
    expect(queryByRole("tablist")).toBeNull();
    expect(queryByRole("button", { name: /Switch route direction/ })).toBeNull();
    expect(selectDirection).not.toHaveBeenCalled();
  });

  it("gives a declared unnamed direction a readable label", () => {
    const { getByRole } = render(() => (
      <RouteControls
        routeId="L"
        routeShortName="L"
        routeLongName="Loop"
        onClearRoute={() => {}}
        availableDirectionIds={[0, 2]}
        directionLabels={{
          0: { label: "", destination: "Central Terminal" },
          2: { label: "", destination: "" },
        }}
        tracking={{
          data: () => null,
          isStaleForDirection: () => false,
          nearestStopId: () => undefined,
          onDataArrival: () => () => {},
          selectDirection: () => {},
          selectedDirectionId: () => 2,
        }}
      />
    ));
    expect(getByRole("tab", { name: "Direction 2" })).toBeDefined();
    expect(
      getByRole("button", { name: "Switch route direction (currently Direction 2)" }).textContent,
    ).toContain("Direction 2");
  });

  it("shows the operator destination for a loop and updates when switching direction", async () => {
    const { getByRole } = render(() => {
      const [direction, setDirection] = createSignal(0);
      return (
        <RouteControls
          routeId="L"
          routeShortName="L"
          routeLongName="Loop"
          onClearRoute={() => {}}
          tracking={{
            data: () => null,
            isStaleForDirection: () => false,
            nearestStopId: () => undefined,
            onDataArrival: () => () => {},
            selectDirection: setDirection,
            selectedDirectionId: direction,
          }}
          directionLabels={{
            0: { label: "", destination: "Central Terminal" },
            1: { label: "", destination: "Clockwise Loop" },
          }}
        />
      );
    });
    const indicator = getByRole("button", {
      name: "Switch route direction (currently Central Terminal)",
    });
    expect(indicator.textContent).toContain("Central Terminal");
    expect(indicator.textContent).not.toContain("DIR");
    expect(indicator.querySelector("svg")).toBeNull();
    await fireEvent.click(indicator);
    expect(
      getByRole("button", { name: "Switch route direction (currently Clockwise Loop)" })
        .textContent,
    ).toContain("Clockwise Loop");
  });
});
