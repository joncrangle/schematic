// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { flush } from "solid-js";
import { createNearbyFocusAdapter } from "~/components/nearby/nearbyFocus";
import { createShellSession } from "~/lib/shellSession";

const flushFocusHandoff = () => new Promise<void>((resolve) => queueMicrotask(resolve));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("createNearbyFocusAdapter", () => {
  it("returns focus to a visible targeted invoker", async () => {
    const invoker = document.createElement("button");
    document.body.append(invoker);
    const adapter = createNearbyFocusAdapter();

    adapter.captureTargetedInvoker(invoker);
    adapter.restoreFocusAfterTargetedExit("ttc:504");
    await flushFocusHandoff();

    expect(document.activeElement).toBe(invoker);
  });

  it("attempts restoration after the session reopens nearby", async () => {
    const invoker = document.createElement("button");
    document.body.append(invoker);
    const adapter = createNearbyFocusAdapter();
    const session = createShellSession({ focus: adapter });

    adapter.captureTargetedInvoker(invoker);
    session.setNearbyOpen(true);
    // Commit so entry captures the open panel for return-on-exit.
    flush();
    session.enterTargetedRoute({ agencyId: "ttc", routeId: "504", directionId: 0 });
    // Commit so exit observes the targeted route instead of early-returning.
    flush();
    session.exitTargetedRoute();

    expect(session.nearbyOpen()).toBe(true);
    expect(document.activeElement).not.toBe(invoker);
    await flushFocusHandoff();
    expect(document.activeElement).toBe(invoker);
  });

  it("falls back to the current expanded route rather than the first rendered route", async () => {
    const invoker = document.createElement("button");
    const otherRouteAction = document.createElement("button");
    const firstActionable = document.createElement("button");
    const closeControl = document.createElement("button");
    const trigger = document.createElement("button");
    document.body.append(otherRouteAction, firstActionable, closeControl, trigger);
    const adapter = createNearbyFocusAdapter();

    adapter.captureTargetedInvoker(invoker);
    adapter.registerFirstActionable("ttc:501", otherRouteAction);
    adapter.registerFirstActionable("ttc:504", firstActionable);
    adapter.registerCloseControl(closeControl);
    adapter.registerTriggerElement(trigger);
    adapter.restoreFocusAfterTargetedExit("ttc:504");
    await flushFocusHandoff();

    expect(document.activeElement).toBe(firstActionable);
  });

  it("skips hidden and detached fallback controls before using the pill trigger", async () => {
    const firstActionable = document.createElement("button");
    firstActionable.hidden = true;
    const closeControl = document.createElement("button");
    closeControl.setAttribute("aria-hidden", "true");
    const trigger = document.createElement("button");
    document.body.append(firstActionable, closeControl, trigger);
    const adapter = createNearbyFocusAdapter();

    adapter.registerFirstActionable("ttc:504", firstActionable);
    adapter.registerCloseControl(closeControl);
    adapter.registerTriggerElement(trigger);
    adapter.restoreFocusAfterTargetedExit("ttc:504");
    await flushFocusHandoff();

    expect(document.activeElement).toBe(trigger);
  });

  it("uses the close control before the pill trigger", async () => {
    const firstActionable = document.createElement("button");
    firstActionable.setAttribute("aria-hidden", "true");
    const closeControl = document.createElement("button");
    const trigger = document.createElement("button");
    document.body.append(firstActionable, closeControl, trigger);
    const adapter = createNearbyFocusAdapter();

    adapter.registerFirstActionable("ttc:504", firstActionable);
    adapter.registerCloseControl(closeControl);
    adapter.registerTriggerElement(trigger);
    adapter.restoreFocusAfterTargetedExit("ttc:504");
    await flushFocusHandoff();

    expect(document.activeElement).toBe(closeControl);
  });

  it("only uses the first actionable control for the current expanded route", async () => {
    const otherRouteAction = document.createElement("button");
    const closeControl = document.createElement("button");
    document.body.append(otherRouteAction, closeControl);
    const adapter = createNearbyFocusAdapter();

    adapter.registerFirstActionable("ttc:1", otherRouteAction);
    adapter.registerCloseControl(closeControl);
    adapter.restoreFocusAfterTargetedExit("ttc:504");
    await flushFocusHandoff();

    expect(document.activeElement).toBe(closeControl);
  });

  it("waits for the visibility state to update before choosing a focus target", async () => {
    const panel = document.createElement("div");
    const invoker = document.createElement("button");
    panel.setAttribute("aria-hidden", "true");
    panel.append(invoker);
    document.body.append(panel);
    const adapter = createNearbyFocusAdapter();

    adapter.captureTargetedInvoker(invoker);
    adapter.restoreFocusAfterTargetedExit();
    panel.setAttribute("aria-hidden", "false");
    await flushFocusHandoff();

    expect(document.activeElement).toBe(invoker);
  });

  it("does not focus an unavailable target", async () => {
    const detached = document.createElement("button");
    const adapter = createNearbyFocusAdapter();

    adapter.captureTargetedInvoker(detached);
    adapter.restoreFocusAfterTargetedExit();
    await flushFocusHandoff();

    expect(document.activeElement).not.toBe(detached);
  });
});
