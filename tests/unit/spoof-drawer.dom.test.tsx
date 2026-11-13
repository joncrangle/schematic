// Cold-boot cases reset app modules to recreate the location singleton. Keep
// the real Solid runtime and DOM event delegation shared with the statically
// imported testing library; reloading them leaves later portal clicks unhandled.
vi.mock("solid-js", async (importOriginal) => importOriginal());
vi.mock("@solidjs/web", async (importOriginal) => importOriginal());
vi.mock("~/agencies/agencyCatalog", async () => {
  const { testAgencyCatalog } = await import("../helpers/agency-fixtures");
  return { agencyCatalog: testAgencyCatalog };
});
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent as baseFireEvent } from "@solidjs/testing-library";
import { flush } from "solid-js";

const fireEvent = new Proxy(baseFireEvent, {
  get(target, prop, receiver) {
    const orig = Reflect.get(target, prop, receiver);
    if (typeof orig === "function") {
      return (...args: unknown[]) => {
        const result = (orig as Function).apply(target, args);
        flush();
        return result;
      };
    }
    return orig;
  },
});

/**
 * SpoofDrawer: left-quarter map trigger plus spoof panel for developer
 * location pinning. Visible only in dev builds via the shared isDevServer()
 * helper. Panel geometry is responsive (popover <md, left sheet >=md) with
 * NearbyFloatingPill-style outside-pointerdown close; these tests assert
 * behavior at public seams, not breakpoint styling.
 */

const mocks = vi.hoisted(() => ({ isDevBuild: true }));
vi.mock("~/lib/devFlags", () => ({ isDevServer: () => mocks.isDevBuild }));

import { allProviders } from "~/agencies/registry";
import { SPOOF_STORAGE_KEY } from "~/lib/location-source";
import { installMemoryLocalStorage } from "../helpers/local-storage";

/**
 * Resolves the location ladder from the CURRENT module registry. Suites that
 * vi.resetModules() produce a fresh singleton, so reads must never bind to a
 * stale first import.
 */
async function ladderNow() {
  return (await import("~/hooks/useGeolocation")).getLocationLadder();
}

beforeEach(() => {
  mocks.isDevBuild = true;
  installMemoryLocalStorage();
});

afterEach(async () => {
  cleanup();
  (await ladderNow()).clearSpoof();
  vi.unstubAllGlobals();
});

type CoordinationModule = typeof import("~/context/NearbyCoordinationContext");
type ShellSessionModule = typeof import("~/lib/shellSession");
type NearbyFocusModule = typeof import("~/components/nearby/nearbyFocus");

/**
 * Resolves the drawer and its coordination context from the SAME module
 * registry. Some suites vi.resetModules() first (persisted-spoof restore,
 * local-address coarse-ip); context identity is per-module-instance, so a
 * stale provider can never wrap a freshly-imported drawer.
 */
async function loadSpoofDrawer(): Promise<{
  mod: typeof import("~/components/map/SpoofDrawer");
  ctx: CoordinationModule;
  shell: ShellSessionModule;
  focus: NearbyFocusModule;
}> {
  const [mod, ctx, shell, focus] = await Promise.all([
    import("~/components/map/SpoofDrawer"),
    import("~/context/NearbyCoordinationContext"),
    import("~/lib/shellSession"),
    import("~/components/nearby/nearbyFocus"),
  ]);
  return { mod, ctx, shell, focus };
}

/**
 * Mounts the drawer under a mandatory NearbyCoordinationProvider built from
 * the same registry's factory. Pass an open signal pair to drive the
 * coordinated nearby state from the test.
 */
async function mountDrawer() {
  const { mod, ctx, shell, focus } = await loadSpoofDrawer();
  const session = shell.createShellSession();
  const coordination = ctx.createNearbyCoordination(session, focus.createNearbyFocusAdapter());
  const ui = render(() => (
    <ctx.NearbyCoordinationProvider value={coordination}>
      <mod.SpoofDrawer />
    </ctx.NearbyCoordinationProvider>
  ));
  return { mod, setNearbyOpen: session.setNearbyOpen, ...ui };
}

function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: "Location spoof settings" }));
  return screen.getByRole("dialog", { name: "Location spoof settings" });
}

describe("SpoofDrawer visibility gating", () => {
  it("renders nothing outside dev builds", async () => {
    mocks.isDevBuild = false;
    await mountDrawer();

    expect(screen.queryByRole("button", { name: "Location spoof settings" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Location spoof settings" })).toBeNull();
  });

  it("shows the trigger in dev builds", async () => {
    await mountDrawer();

    expect(screen.getByRole("button", { name: "Location spoof settings" })).toBeDefined();
  });
});

describe("SpoofDrawer open/close", () => {
  it("opens the dialog from the trigger", async () => {
    await mountDrawer();

    expect(openDialog()).toBeDefined();
  });

  it("toggles closed when the trigger is pressed again", async () => {
    await mountDrawer();
    const trigger = screen.getByRole("button", { name: "Location spoof settings" });
    fireEvent.click(trigger);
    fireEvent.click(trigger);

    expect(screen.queryByRole("dialog", { name: "Location spoof settings" })).toBeNull();
  });

  it("closes on a pointerdown outside panel and trigger", async () => {
    await mountDrawer();
    openDialog();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole("dialog", { name: "Location spoof settings" })).toBeNull();
  });

  it("stays open on a pointerdown inside the panel", async () => {
    await mountDrawer();
    const dialog = openDialog();

    fireEvent.pointerDown(dialog);

    expect(screen.getByRole("dialog", { name: "Location spoof settings" })).toBeDefined();
  });

  it("does not close on a pointerdown on the trigger (trigger owns toggle)", async () => {
    await mountDrawer();
    const trigger = screen.getByRole("button", { name: "Location spoof settings" });
    fireEvent.click(trigger);

    // pointerdown precedes click; the outside-close handler must ignore it so
    // the trigger's onClick can complete its toggle without flicker.
    fireEvent.pointerDown(trigger);
    expect(screen.queryByRole("dialog", { name: "Location spoof settings" })).not.toBeNull();

    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog", { name: "Location spoof settings" })).toBeNull();
  });

  it("closes via Escape", async () => {
    await mountDrawer();
    openDialog();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Location spoof settings" })).toBeNull();
  });

  it("closes via the header close button", async () => {
    await mountDrawer();
    openDialog();

    fireEvent.click(screen.getByRole("button", { name: "Close drawer" }));

    expect(screen.queryByRole("dialog", { name: "Location spoof settings" })).toBeNull();
  });
});

describe("SpoofDrawer nearby-panel hand-off", () => {
  it("yields while the nearby panel is open and restores after it closes", async () => {
    const { setNearbyOpen } = await mountDrawer();
    openDialog();

    setNearbyOpen(true);
    // Commit the open before asserting the hand-off (staged writes).
    flush();
    expect(screen.queryByRole("dialog", { name: "Location spoof settings" })).toBeNull();

    setNearbyOpen(false);
    flush();
    expect(screen.getByRole("dialog", { name: "Location spoof settings" })).toBeDefined();
  });
});

describe("SpoofDrawer spoof application", () => {
  async function mountAndOpen() {
    await mountDrawer();
    openDialog();
  }

  function latitudeInput(): HTMLInputElement {
    return screen.getByLabelText("Latitude") as HTMLInputElement;
  }

  function longitudeInput(): HTMLInputElement {
    return screen.getByLabelText("Longitude") as HTMLInputElement;
  }

  it("starts idle: editing controls never engages spoofing until Start", async () => {
    await mountAndOpen();
    fireEvent.click(screen.getByRole("button", { name: /Hub Plaza/ }));
    fireEvent.click(screen.getByRole("button", { name: "Increase Longitude" }));
    fireEvent.change(latitudeInput(), { target: { value: "43.6532" } });
    fireEvent.change(screen.getByLabelText("Accuracy"), { target: { value: "1000" } });

    expect((await ladderNow()).effectiveFix().source).not.toBe("dev-spoof");
    expect(screen.getByRole("button", { name: "Start spoofing" })).toBeDefined();
  });

  it("a preset click seeds the draft inputs without applying", async () => {
    await mountAndOpen();
    fireEvent.click(screen.getByRole("button", { name: /Hub Plaza/ }));

    expect(latitudeInput().value).toBe("43.5");
    expect(longitudeInput().value).toBe("-79.5");
    expect((await ladderNow()).effectiveFix().source).not.toBe("dev-spoof");
  });

  it("stepper taps update the draft only", async () => {
    const { mod } = await loadSpoofDrawer();
    await mountAndOpen();
    fireEvent.click(screen.getByRole("button", { name: "Increase Longitude" }));

    expect(Number.parseFloat(longitudeInput().value)).toBeCloseTo(
      mod.draftDefaults().longitude + 0.01,
      10,
    );
    expect((await ladderNow()).effectiveFix().fix).toBeNull();
  });

  it("a typed coordinate lands in the draft, not the store", async () => {
    await mountAndOpen();
    fireEvent.change(latitudeInput(), { target: { value: "43.6532" } });

    expect(latitudeInput().value).toBe("43.6532");
    expect((await ladderNow()).effectiveFix().fix).toBeNull();
  });

  it("the selected accuracy stays a draft until applied", async () => {
    await mountAndOpen();
    fireEvent.change(screen.getByLabelText("Accuracy"), { target: { value: "1000" } });

    expect((await ladderNow()).effectiveFix().fix).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Start spoofing" }));

    expect((await ladderNow()).effectiveFix().fix?.accuracy).toBe(1000);
  });

  it("Start spoofing applies the draft and flips the control to its stop state", async () => {
    await mountAndOpen();
    fireEvent.click(screen.getByRole("button", { name: /Hub Plaza/ }));
    const start = screen.getByRole("button", { name: "Start spoofing" });
    expect(start.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(start);

    const applied = (await ladderNow()).effectiveFix();
    expect(applied.source).toBe("dev-spoof");
    expect(applied.fix?.latitude).toBe(43.5);
    expect(applied.fix?.longitude).toBe(-79.5);
    const stop = screen.getByRole("button", { name: "Stop spoofing" });
    expect(stop.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: "Start spoofing" })).toBeNull();
  });

  it("offers Apply changes while active drafts diverge, and applies them", async () => {
    await mountAndOpen();
    fireEvent.click(screen.getByRole("button", { name: /Hub Plaza/ }));
    fireEvent.click(screen.getByRole("button", { name: "Start spoofing" }));
    expect(screen.queryByRole("button", { name: "Apply changes" })).toBeNull();

    fireEvent.change(latitudeInput(), { target: { value: "43.7051" } });
    const apply = screen.getByRole("button", { name: "Apply changes" });
    expect((await ladderNow()).effectiveFix().fix?.latitude).toBe(43.5);

    fireEvent.click(apply);

    expect((await ladderNow()).effectiveFix().fix?.latitude).toBe(43.7051);
    expect(screen.queryByRole("button", { name: "Apply changes" })).toBeNull();
  });

  it("returns to the start state via Stop spoofing", async () => {
    await mountAndOpen();
    fireEvent.click(screen.getByRole("button", { name: /Hub Plaza/ }));
    fireEvent.click(screen.getByRole("button", { name: "Start spoofing" }));
    expect((await ladderNow()).effectiveFix().source).toBe("dev-spoof");

    // GPS-revert semantics are pinned canonically in location-ladder.test.ts;
    // here we assert only that the drawer's Stop control disengages the spoof
    // and restores the start affordance.
    fireEvent.click(screen.getByRole("button", { name: "Stop spoofing" }));

    expect((await ladderNow()).effectiveFix().source).not.toBe("dev-spoof");
    expect(screen.getByRole("button", { name: "Start spoofing" })).toBeDefined();
  });
});

describe("SpoofDrawer coverage preview", () => {
  it("reports Sample Transit resolution for an in-bbox draft", async () => {
    await mountDrawer();
    openDialog();

    expect(screen.getByText("Resolves to: Sample Transit")).toBeDefined();
  });

  it("reports outside-coverage for a draft beyond the agency bbox", async () => {
    await mountDrawer();
    openDialog();
    // Deliberately NOT one of location-source.test.ts's fixtures: this file
    // owns the panel's rendered status line, not bbox containment itself.
    fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "60.5" } });

    expect(screen.getByText("Outside agency coverage")).toBeDefined();
  });
});

describe("SpoofDrawer persisted-spoof restore", () => {
  function latitudeInput(): HTMLInputElement {
    return screen.getByLabelText("Latitude") as HTMLInputElement;
  }

  function longitudeInput(): HTMLInputElement {
    return screen.getByLabelText("Longitude") as HTMLInputElement;
  }

  /** Page-refresh shape: storage holds an applied spoof, but the hook
   *  singleton re-imports with a null signal (the SSR pass has no storage),
   *  so nothing claims dev-spoof until the root's post-mount restore runs.
   *  Module reset gives this test its own pristine hook+drawer pair sharing
   *  one fresh registry, mirroring a cold page load. */
  async function mountWithPersistedSpoof() {
    localStorage.setItem(
      SPOOF_STORAGE_KEY,
      JSON.stringify({
        latitude: 43.5,
        longitude: -79.5,
        accuracyMeters: 10,
        appliedAt: Date.now(),
      }),
    );
    vi.resetModules();
    const hook = await import("~/hooks/useGeolocation");
    await mountDrawer();
    expect(hook.getLocationLadder().effectiveFix().source).not.toBe("dev-spoof");
    hook.getLocationLadder().restorePersistedSpoof();
    expect(hook.getLocationLadder().effectiveFix().source).toBe("dev-spoof");
  }

  it("seeds draft inputs from the restored spoof when opened after restore", async () => {
    await mountWithPersistedSpoof();

    fireEvent.click(screen.getByRole("button", { name: "Location spoof settings" }));

    // Drafts reflect the CURRENT applied position at open time, not the
    // creation-time defaults — otherwise isSpoofing() plus stale defaults
    // immediately offer a spurious "Apply changes".
    expect(latitudeInput().value).toBe("43.5");
    expect(longitudeInput().value).toBe("-79.5");
    expect(screen.getByRole("button", { name: "Stop spoofing" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Apply changes" })).toBeNull();
  });

  it("reseeds drafts from the applied spoof on reopen instead of keeping stale edits", async () => {
    await mountWithPersistedSpoof();
    const trigger = screen.getByRole("button", { name: "Location spoof settings" });
    fireEvent.click(trigger);

    // A diverged edit legitimately offers Apply changes…
    fireEvent.change(latitudeInput(), { target: { value: "43.7051" } });
    expect(screen.getByRole("button", { name: "Apply changes" })).toBeDefined();

    // …but closing and reopening starts a fresh intent seeded from the
    // applied spoof, discarding the un-applied edits.
    fireEvent.click(trigger);
    fireEvent.click(trigger);

    expect(latitudeInput().value).toBe("43.5");
    expect(longitudeInput().value).toBe("-79.5");
    expect(screen.queryByRole("button", { name: "Apply changes" })).toBeNull();
  });
});

describe("SpoofDrawer coarse-ip status", () => {
  it("reports not-available before a coarse fix is seeded", async () => {
    await mountDrawer();
    openDialog();

    expect(screen.getByText("Coarse IP: not available")).toBeDefined();
  });

  it("reports city, coordinates, source, and IP once the tier is seeded", async () => {
    const hook = await import("~/hooks/useGeolocation");
    const seedCoarse = hook.getLocationLadder().seedCoarse.bind(hook.getLocationLadder());
    await mountDrawer();
    openDialog();

    await seedCoarse(async () => ({
      latitude: 43.6532,
      longitude: -79.3832,
      accuracyMeters: 30000,
      city: "Toronto",
      ip: "1.2.3.4",
      source: "cloudflare" as const,
    }));

    expect(screen.getByText(/Coarse IP: 1\.2\.3\.4 · Toronto/)).toBeDefined();
    expect(screen.getByText(/· cloudflare$/)).toBeDefined();
  });

  it("explains a local-address hit instead of reading as broken", async () => {
    vi.resetModules();
    const hook = await import("~/hooks/useGeolocation");
    await mountDrawer();
    fireEvent.click(screen.getByRole("button", { name: "Location spoof settings" }));

    await hook.getLocationLadder().seedCoarse(async () => ({
      unavailable: "local-address",
      ip: "127.0.0.1",
    }));

    expect(
      screen.getByText(/Coarse IP: not available — 127\.0\.0\.1 is a local address/),
    ).toBeDefined();
    expect(screen.getByText(/no geolocatable geography/)).toBeDefined();
    expect(screen.getByText(/use presets to simulate coverage/)).toBeDefined();
  });
});

describe("SpoofDrawer agency selection & persistence", () => {
  function agencySelect(): HTMLSelectElement {
    return screen.getByLabelText("Agency") as HTMLSelectElement;
  }

  function latitudeInput(): HTMLInputElement {
    return screen.getByLabelText("Latitude") as HTMLInputElement;
  }

  function longitudeInput(): HTMLInputElement {
    return screen.getByLabelText("Longitude") as HTMLInputElement;
  }

  it("renders agency options alphabetically by name after Auto", async () => {
    await mountDrawer();
    openDialog();

    const expected = [
      "Auto (from coordinates)",
      ...allProviders()
        .map((provider) => provider.manifest.name)
        .sort((first, second) => first.localeCompare(second)),
    ];

    expect(Array.from(agencySelect().options, (option) => option.textContent)).toEqual(expected);
  });

  it("selecting an agency updates draft coordinates to that agency's focus and displays presets", async () => {
    const { mod } = await loadSpoofDrawer();
    await mountDrawer();
    openDialog();

    expect(agencySelect().value).toBe("sample");

    fireEvent.change(agencySelect(), { target: { value: "metro" } });

    expect(agencySelect().value).toBe("metro");
    const metroDefaults = mod.getDraftDefaults("metro");
    expect(Number.parseFloat(latitudeInput().value)).toBeCloseTo(metroDefaults.latitude, 4);
    expect(Number.parseFloat(longitudeInput().value)).toBeCloseTo(metroDefaults.longitude, 4);
    expect(screen.getByRole("button", { name: /North Exchange/ })).toBeDefined();
  });

  it("retains the selected agency across close and reopen while spoofing", async () => {
    await mountDrawer();
    const trigger = screen.getByRole("button", { name: "Location spoof settings" });
    fireEvent.click(trigger);

    fireEvent.change(agencySelect(), { target: { value: "metro" } });
    fireEvent.click(screen.getByRole("button", { name: "Start spoofing" }));

    const applied = (await ladderNow()).effectiveFix();
    expect(applied.source).toBe("dev-spoof");
    expect(applied.fix?.agencyId).toBe("metro");

    // Close the drawer
    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog", { name: "Location spoof settings" })).toBeNull();

    // Reopen the drawer
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Location spoof settings" })).toBeDefined();

    // Must remain on YRT, NOT reset to Sample Transit!
    expect(agencySelect().value).toBe("metro");
    expect(screen.getByRole("button", { name: /North Exchange/ })).toBeDefined();
    expect(screen.getByRole("button", { name: "Stop spoofing" })).toBeDefined();
  });

  it("restores the selected agency from a persisted spoof on cold boot", async () => {
    localStorage.setItem(
      SPOOF_STORAGE_KEY,
      JSON.stringify({
        latitude: 44.05,
        longitude: -79.4,
        accuracyMeters: 10,
        agencyId: "metro",
        appliedAt: Date.now(),
      }),
    );
    vi.resetModules();
    const hook = await import("~/hooks/useGeolocation");
    await mountDrawer();
    hook.getLocationLadder().restorePersistedSpoof();

    fireEvent.click(screen.getByRole("button", { name: "Location spoof settings" }));

    expect(agencySelect().value).toBe("metro");
    expect(screen.getByRole("button", { name: "Stop spoofing" })).toBeDefined();
  });
});

describe("SpoofDrawer Auto (agency-less) spoofing", () => {
  function agencySelect(): HTMLSelectElement {
    return screen.getByLabelText("Agency") as HTMLSelectElement;
  }

  it("applies an agency-less spoof so far-away coordinates resolve honestly outside", async () => {
    await mountDrawer();
    openDialog();

    fireEvent.change(agencySelect(), { target: { value: "" } });
    // Mid-ocean, never inside a present or future agency bound.
    fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Longitude"), { target: { value: "-30" } });
    fireEvent.click(screen.getByRole("button", { name: "Start spoofing" }));

    const applied = (await ladderNow()).effectiveFix();
    expect(applied.source).toBe("dev-spoof");
    expect(applied.fix?.latitude).toBe(0);
    expect(applied.fix?.agencyId).toBeUndefined();
    expect(screen.getByText("Outside agency coverage")).toBeDefined();
  });

  it("switching to Auto keeps custom coordinates instead of snapping to an agency focus", async () => {
    await mountDrawer();
    openDialog();

    fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "0" } });
    fireEvent.change(agencySelect(), { target: { value: "" } });

    expect(agencySelect().value).toBe("");
    expect((screen.getByLabelText("Latitude") as HTMLInputElement).value).toBe("0");
  });

  it("reseeds Auto from an agency-less persisted spoof on cold boot", async () => {
    localStorage.setItem(
      SPOOF_STORAGE_KEY,
      JSON.stringify({
        latitude: 0,
        longitude: -30,
        accuracyMeters: 10,
        appliedAt: Date.now(),
      }),
    );
    vi.resetModules();
    const hook = await import("~/hooks/useGeolocation");
    await mountDrawer();
    hook.getLocationLadder().restorePersistedSpoof();

    fireEvent.click(screen.getByRole("button", { name: "Location spoof settings" }));

    expect(agencySelect().value).toBe("");
    expect(screen.getByRole("button", { name: "Stop spoofing" })).toBeDefined();
  });

  it("seeds the resolved agency with presets when opened on a live fix with no spoof", async () => {
    const hook = await import("~/hooks/useGeolocation");
    await hook.getLocationLadder().seedCoarse(async () => ({
      latitude: 43.6532,
      longitude: -79.3832,
      accuracyMeters: 30000,
      city: "Toronto",
      ip: "1.2.3.4",
      source: "cloudflare" as const,
    }));
    await mountDrawer();
    openDialog();

    expect(agencySelect().value).toBe("sample");
    expect(screen.getByRole("button", { name: /Hub Plaza/ })).toBeDefined();
  });
});
