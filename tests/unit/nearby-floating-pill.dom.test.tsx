// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { createMemo, flush, Loading } from "solid-js";

const nearbyPanelSuspension = vi.hoisted(() => ({
  active: false,
}));

vi.mock("~/components/nearby/NearbyPanel", () => {
  return {
    NearbyPanel: () => {
      const data = createMemo(async () => {
        if (nearbyPanelSuspension.active) {
          return new Promise<true>(() => {});
        }
        return true;
      });
      return <>{data() && <div data-testid="nearby-panel" />}</>;
    },
  };
});

import { NearbyFloatingPill } from "~/components/nearby/NearbyFloatingPill";
import {
  createNearbyCoordination,
  NearbyCoordinationProvider,
} from "~/context/NearbyCoordinationContext";
import { createNearbyFocusAdapter } from "~/components/nearby/nearbyFocus";
import { createShellSession } from "~/lib/shellSession";

function mountPill() {
  const session = createShellSession();
  const coordination = createNearbyCoordination(session, createNearbyFocusAdapter());

  const rendered = render(() => (
    <NearbyCoordinationProvider value={coordination}>
      <NearbyFloatingPill />
    </NearbyCoordinationProvider>
  ));

  return { ...rendered, setIsOpen: session.setNearbyOpen };
}

afterEach(() => {
  cleanup();
});

describe("NearbyFloatingPill loading boundary", () => {
  it("keeps the nearby panel available before the first open", async () => {
    mountPill();

    await waitFor(() =>
      expect(document.querySelector('[data-testid="nearby-panel"]')).toBeTruthy(),
    );
  });

  it("contains a pending nearby fetch without suspending the map shell", async () => {
    nearbyPanelSuspension.active = true;
    const session = createShellSession();
    const coordination = createNearbyCoordination(session, createNearbyFocusAdapter());

    try {
      render(() => (
        <Loading fallback={<div data-testid="map-shell-loading" />}>
          <div data-testid="map-shell">Network map and header</div>
          <NearbyCoordinationProvider value={coordination}>
            <NearbyFloatingPill />
          </NearbyCoordinationProvider>
        </Loading>
      ));
      await waitFor(() => expect(document.querySelector("[role=dialog]")).toBeTruthy());
      session.setNearbyOpen(true);
      // Commit the open so the fallback is visible to accessible queries.
      flush();

      expect(screen.queryByTestId("map-shell-loading")).toBeNull();
      expect(screen.getByTestId("map-shell")).toBeDefined();
      expect(screen.getByRole("status", { name: "Loading nearby transit" })).toBeDefined();
    } finally {
      nearbyPanelSuspension.active = false;
    }
  });
});
