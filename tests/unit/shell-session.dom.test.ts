// @vitest-environment happy-dom
// Session transitions need Solid's client runtime; SSR does not execute flush callbacks.
import { describe, expect, it, vi } from "vitest";
import { flush } from "solid-js";
import { createShellSession } from "~/lib/shellSession";

describe("createShellSession", () => {
  it("keeps shell overlays mutually exclusive", () => {
    const session = createShellSession();

    session.openSheet("alerts");
    flush();
    expect(session.activeSheet()).toBe("alerts");
    expect(session.isSettingsOpen()).toBe(false);

    session.openSettings();
    flush();
    expect(session.activeSheet()).toBeNull();
    expect(session.isSettingsOpen()).toBe(true);
    session.closeSettings();
    flush();
    expect(session.isSettingsOpen()).toBe(false);

    session.openSettings();
    session.setNearbyOpen(true);
    flush();
    expect(session.isSettingsOpen()).toBe(false);
    expect(session.nearbyOpen()).toBe(true);

    session.openAgencyPicker();
    flush();
    expect(session.nearbyOpen()).toBe(false);
    expect(session.isAgencyPickerOpen()).toBe(true);
    session.closeAgencyPicker();
    flush();
    expect(session.isAgencyPickerOpen()).toBe(false);

    session.openSheet("upcoming");
    session.closeSheet();
    flush();
    expect(session.activeSheet()).toBeNull();
  });

  it("transitions directly between sheet tabs without an intermediate null state", async () => {
    const { createRoot, createRenderEffect } = await import("solid-js");
    const session = createShellSession();
    const history: (string | null)[] = [];

    session.openSheet("alerts");
    flush();
    createRoot((dispose) => {
      createRenderEffect(
        () => session.activeSheet(),
        (sheet) => {
          history.push(sheet);
        },
      );
      session.openSheet("upcoming");
      flush();
      dispose();
    });

    expect(history).toEqual(["alerts", "upcoming"]);
  });

  it("preserves nearby expansion when nearby closes and blocks nearby while targeted", () => {
    const session = createShellSession();

    session.toggleExpandRoute("ttc:504");
    session.setNearbyOpen(true);
    session.setNearbyOpen(false);
    flush();
    expect(session.expandedRouteId()).toBe("ttc:504");

    session.enterTargetedRoute({ agencyId: "ttc", routeId: "504", directionId: 0 });
    // Commit so the guards below observe targeted state, not staged writes.
    flush();
    session.toggleNearby();
    session.setNearbyOpen(true);
    flush();
    expect(session.nearbyOpen()).toBe(false);
  });

  it("coordinates nearby expansion and targeted route entry", () => {
    let session: ReturnType<typeof createShellSession>;
    const restoreFocus = vi.fn(() => {
      expect(session.nearbyOpen()).toBe(true);
    });
    session = createShellSession({
      getNearestAnchorCoords: () => ({
        latitude: 43.65,
        longitude: -79.38,
        timestamp: 1,
      }),
      focus: {
        captureTargetedInvoker: vi.fn(),
        restoreFocusAfterTargetedExit: restoreFocus,
      },
    });

    session.setNearbyOpen(true);
    session.toggleExpandRoute("ttc:504");
    flush();
    expect(session.expandedRouteId()).toBe("ttc:504");

    session.enterTargetedRoute({
      agencyId: "ttc",
      routeId: "504",
      directionId: 1,
      stopId: "king",
    });
    flush();

    expect(session.targetedRoute()).toMatchObject({
      agencyId: "ttc",
      routeId: "504",
      directionId: 1,
      stopId: "king",
      nearestAnchorCoords: { latitude: 43.65, longitude: -79.38 },
    });
    expect(session.nearbyOpen()).toBe(false);
    expect(session.expandedRouteId()).toBe("ttc:504");
    expect(session.routeDirections().get("ttc:504")?.at(-1)?.directionId).toBe(1);

    session.toggleExpandRoute("ttc:other");
    flush();
    expect(session.expandedRouteId()).toBe("ttc:504");
    session.openSheet("alerts");
    flush();
    expect(session.activeSheet()).toBe("alerts");
    session.exitTargetedRoute();
    session.exitTargetedRoute();
    flush();

    expect(session.targetedRoute()).toBeNull();
    expect(session.nearbyOpen()).toBe(true);
    expect(session.activeSheet()).toBeNull();
    expect(session.expandedRouteId()).toBe("ttc:504");
    expect(restoreFocus).toHaveBeenCalledTimes(1);
  });

  it("does not reopen nearby when targeted mode was entered elsewhere", () => {
    const session = createShellSession();

    session.enterTargetedRoute({ agencyId: "ttc", routeId: "1", directionId: 0 });
    session.exitTargetedRoute();
    flush();

    expect(session.nearbyOpen()).toBe(false);
  });

  it("replaces a targeted route without restoring the intermediate route", () => {
    const restoreFocus = vi.fn();
    let anchorTimestamp = 1;
    const session = createShellSession({
      getNearestAnchorCoords: () => ({
        latitude: 43.65,
        longitude: -79.38,
        timestamp: anchorTimestamp,
      }),
      focus: {
        captureTargetedInvoker: vi.fn(),
        restoreFocusAfterTargetedExit: restoreFocus,
      },
    });

    session.setNearbyOpen(true);
    // Commit before entry so the return-nearby capture observes it.
    flush();
    session.enterTargetedRoute({ agencyId: "ttc", routeId: "504", directionId: 0 });
    flush();
    anchorTimestamp = 2;
    session.enterTargetedRoute({ agencyId: "ttc", routeId: "1", directionId: 1 });
    flush();

    expect(session.targetedRoute()?.routeId).toBe("1");
    expect(session.targetedRoute()?.nearestAnchorCoords?.timestamp).toBe(2);
    expect(session.expandedRouteId()).toBe("ttc:1");
    session.exitTargetedRoute();
    flush();
    expect(session.nearbyOpen()).toBe(true);
    expect(restoreFocus).toHaveBeenCalledTimes(1);
  });

  it("refreshes the nearest anchor only when the targeted route changes", () => {
    let anchor = { latitude: 1, longitude: 2, timestamp: 1 };
    const readAnchor = vi.fn(() => anchor);
    const session = createShellSession({ getNearestAnchorCoords: readAnchor });

    session.enterTargetedRoute({ agencyId: "ttc", routeId: "504", directionId: 0 });
    flush();
    anchor = { latitude: 3, longitude: 4, timestamp: 2 };
    session.enterTargetedRoute({ agencyId: "ttc", routeId: "1", directionId: 0 });
    flush();

    expect(session.targetedRoute()?.nearestAnchorCoords).toEqual(anchor);
    expect(readAnchor).toHaveBeenCalledTimes(2);
  });

  it("ignores repeated entry for the same target", () => {
    const readAnchor = vi.fn(() => ({ latitude: 1, longitude: 2, timestamp: 1 }));
    const session = createShellSession({ getNearestAnchorCoords: readAnchor });

    session.enterTargetedRoute({ agencyId: "ttc", routeId: "504", directionId: 0 });
    flush();
    session.enterTargetedRoute({ agencyId: "ttc", routeId: "504", directionId: 0 });
    flush();

    expect(readAnchor).toHaveBeenCalledTimes(1);
    expect(session.targetedRoute()?.directionId).toBe(0);
  });
});
