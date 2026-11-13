// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { NearbyLocationGate } from "../../src/components/nearby/NearbyLocationGate";

type GateProps = Parameters<typeof NearbyLocationGate>[0];

function baseProps(overrides: Partial<GateProps> = {}): GateProps {
  return {
    status: "idle",
    spoofActive: false,
    onRequestPermission: vi.fn(),
    onDeferPriming: vi.fn(),
    ...overrides,
  } as GateProps;
}

afterEach(() => cleanup());

describe("NearbyLocationGate", () => {
  it.each(["idle", "priming"] as const)("renders the %s priming card and actions", (status) => {
    const { getByText, getByRole } = render(() => (
      <NearbyLocationGate {...baseProps({ status })} />
    ));

    expect(getByText("Find Nearby Transit")).toBeTruthy();
    expect(getByRole("button", { name: "Not Now" })).toBeTruthy();
    expect(getByRole("button", { name: "Allow Location" })).toBeTruthy();
  });

  it.each([
    { hasData: false, showsWaiting: true },
    { hasData: true, showsWaiting: false },
  ])("renders the prompting state with hasData=$hasData", ({ hasData, showsWaiting }) => {
    const { queryByText } = render(() => (
      <NearbyLocationGate {...baseProps({ status: "prompting", hasData })} />
    ));

    expect(queryByText("Waiting for Permission") !== null).toBe(showsWaiting);
  });

  it.each([
    { status: "denied" as const, heading: "Location Permission Denied" },
    { status: "expired" as const, heading: "Location Expired" },
    { status: "unavailable" as const, heading: "Location Unavailable" },
  ])("renders the $status failure card with retry", ({ status, heading }) => {
    const { getByText, getByRole } = render(() => (
      <NearbyLocationGate {...baseProps({ status })} />
    ));

    expect(getByText(heading)).toBeTruthy();
    expect(getByRole("button", { name: "Try Again" })).toBeTruthy();
  });

  it("shows a provider error when supplied and uses generic copy otherwise", () => {
    const fallback = render(() => <NearbyLocationGate {...baseProps({ status: "unavailable" })} />);
    expect(fallback.getByText("Unable to determine your current location.")).toBeTruthy();
    fallback.unmount();

    const custom = render(() => (
      <NearbyLocationGate {...baseProps({ status: "unavailable", errorMessage: "GPS chip sad" })} />
    ));
    expect(custom.getByText("GPS chip sad")).toBeTruthy();
    expect(custom.queryByText("Unable to determine your current location.")).toBeNull();
  });

  it("renders the stale grace banner with the formatted time", () => {
    const { getByText } = render(() => (
      <NearbyLocationGate {...baseProps({ status: "stale", graceText: "2m ago" })} />
    ));

    expect(getByText("Last known location")).toBeTruthy();
    expect(getByText("2m ago")).toBeTruthy();
  });

  it.each([
    { status: "granted" as const, spoofActive: false },
    { status: "idle" as const, spoofActive: true },
    { status: "prompting" as const, spoofActive: true },
    { status: "denied" as const, spoofActive: true },
  ])("renders nothing for $status when spoofActive=$spoofActive", ({ status, spoofActive }) => {
    const { container } = render(() => (
      <NearbyLocationGate {...baseProps({ status, spoofActive })} />
    ));

    expect(container.textContent).toBe("");
  });

  it.each([
    { action: "Not Now", callback: "onDeferPriming" as const },
    { action: "Allow Location", callback: "onRequestPermission" as const },
  ])("$action invokes $callback from the idle card", async ({ action, callback }) => {
    const onRequestPermission = vi.fn();
    const onDeferPriming = vi.fn();
    const { getByRole } = render(() => (
      <NearbyLocationGate {...baseProps({ status: "idle", onRequestPermission, onDeferPriming })} />
    ));

    (getByRole("button", { name: action }) as HTMLButtonElement).click();

    const invoked = callback === "onRequestPermission" ? onRequestPermission : onDeferPriming;
    await vi.waitFor(() => expect(invoked).toHaveBeenCalledOnce());
  });

  it.each(["denied", "expired", "unavailable"] as const)(
    "Try Again requests permission from the %s card",
    async (status) => {
      const onRequestPermission = vi.fn();
      const { getByRole } = render(() => (
        <NearbyLocationGate {...baseProps({ status, onRequestPermission })} />
      ));

      (getByRole("button", { name: "Try Again" }) as HTMLButtonElement).click();

      await vi.waitFor(() => expect(onRequestPermission).toHaveBeenCalledOnce());
    },
  );
});
