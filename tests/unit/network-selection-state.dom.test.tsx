// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { NetworkSelectionState } from "~/components/NetworkSelectionState";
import { makeTestProvider } from "../helpers/agency-fixtures";

afterEach(cleanup);

it("lets a rider search and select a network without sharing location", async () => {
  const select = vi.fn();
  render(() => (
    <NetworkSelectionState
      providers={[
        makeTestProvider({ id: "alpha", name: "Alpha Transit" }),
        makeTestProvider({ id: "beta", name: "Beta Rail" }),
      ]}
      hasLocation={false}
      status="denied"
      onSelectAgency={select}
      onRequestLocation={vi.fn()}
    />
  ));
  expect(screen.getByText("Choose your transit network")).toBeTruthy();
  expect(
    screen.getByText("We couldn't determine your location. Choose a network to explore its map."),
  ).toBeTruthy();
  fireEvent.input(screen.getByRole("textbox", { name: "Search transit networks" }), {
    target: { value: "beta" },
  });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Alpha Transit" })).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Beta Rail" }));
  expect(select).toHaveBeenCalledWith("beta");
});

it("explains an unsupported location and offers an explicit location request", () => {
  const request = vi.fn();
  render(() => (
    <NetworkSelectionState
      providers={[]}
      hasLocation={true}
      status="idle"
      onSelectAgency={vi.fn()}
      onRequestLocation={request}
    />
  ));
  expect(
    screen.getByText(
      "No supported network found near your estimated location. You can still choose a network to explore.",
    ),
  ).toBeTruthy();
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Use my location" }));
  expect(request).toHaveBeenCalledOnce();
});
