vi.mock("~/agencies/agencyCatalog", async () => {
  const { testAgencyCatalog } = await import("../helpers/agency-fixtures");
  return { agencyCatalog: testAgencyCatalog };
});
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createComponent } from "solid-js";
import { cleanup, render } from "@solidjs/testing-library";
import {
  STORAGE_KEY_COORDS,
  STORAGE_KEY_GRANTED,
  UNDERGROUND_TOLERANCE_MS,
  type Coordinates,
} from "../../src/domain/location/locationLadder";
import { installMemoryLocalStorage } from "../helpers/local-storage";
import { loadHook, withMount } from "../helpers/geolocation-harness";
import { createAgencySession } from "../../src/services/session/AgencySession";
import { allProviders } from "../../src/agencies/registry";

// Spoof operations (persisted restore included) are gated behind
// isDevServer(); pin the dev build so the root-route wiring tests below
// exercise an armed gate regardless of the ambient import.meta.env.
const mocks = vi.hoisted(() => ({ isDevBuild: true }));
vi.mock("~/lib/devFlags", () => ({ isDevServer: () => mocks.isDevBuild }));

import { SPOOF_STORAGE_KEY } from "~/lib/location-source";

const KEY_COORDS = STORAGE_KEY_COORDS;
const KEY_GRANTED = STORAGE_KEY_GRANTED;
const TOLERANCE_MS = UNDERGROUND_TOLERANCE_MS;

/**
 * Resolves the location ladder from the CURRENT module registry. Suites that
 * vi.resetModules() produce a fresh singleton, so reads must never bind to a
 * stale first import.
 */
async function ladderNow() {
  return (await import("../../src/hooks/useGeolocation")).getLocationLadder();
}

function seedCoords(timestampMs: number): void {
  const coords: Coordinates = {
    latitude: 43.6709,
    longitude: -79.3857,
    accuracy: 15,
    timestamp: timestampMs,
  };
  localStorage.setItem(KEY_COORDS, JSON.stringify(coords));
}

beforeEach(() => {
  mocks.isDevBuild = true;
  installMemoryLocalStorage();
});

afterEach(async () => {
  cleanup();
  (await ladderNow()).clearSpoof();
  vi.useRealTimers();
});

describe("useGeolocation permission & underground state machine", () => {
  it("restores a fresh underground cache as granted on init", async () => {
    seedCoords(Date.now() - 60_000);
    const mod = await loadHook();
    const { api, dispose } = withMount(mod.useGeolocation);

    expect(api.status()).toBe("granted");
    expect(api.coords()?.latitude).toBe(43.6709);
    expect(api.effectiveFix()).toEqual({
      fix: {
        latitude: 43.6709,
        longitude: -79.3857,
        accuracy: 15,
        timestamp: expect.any(Number),
      },
      source: "gps",
    });
    dispose();
  });

  it("reports stale on init when the persisted fix exceeds underground tolerance", async () => {
    seedCoords(Date.now() - TOLERANCE_MS - 5_000);
    const mod = await loadHook();
    const { api, dispose } = withMount(mod.useGeolocation);

    expect(api.status()).toBe("stale");
    expect(api.coords()).not.toBeNull();
    dispose();
  });

  it("treats a persisted permission grant as granted even without coordinates", async () => {
    localStorage.setItem(KEY_GRANTED, "true");
    const mod = await loadHook();
    const { api, dispose } = withMount(mod.useGeolocation);

    expect(api.status()).toBe("granted");
    expect(api.coords()).toBeNull();
    dispose();
  });

  it("expires a stale underground fix after the background check fires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T12:00:00Z"));
    seedCoords(Date.now() - TOLERANCE_MS - 1_000);

    const mod = await loadHook();
    const { api, dispose } = withMount(mod.useGeolocation);
    const session = createAgencySession({
      providers: allProviders,
      selection: () => "auto",
      locationLadder: mod.getLocationLadder(),
    });
    expect(api.status()).toBe("stale");

    await vi.advanceTimersByTimeAsync(5_500);

    expect(api.status()).toBe("expired");
    session.dispose();
    dispose();
  });
});

describe("coarse-ip tier precedence", () => {
  it("never persists the coarse fix to localStorage", async () => {
    const mod = await loadHook();
    const { dispose } = withMount(mod.useGeolocation);

    await mod.getLocationLadder().seedCoarse(async () => ({
      latitude: 43.6532,
      longitude: -79.3832,
      city: "Toronto",
      source: "cloudflare" as const,
    }));

    expect(localStorage.getItem(STORAGE_KEY_COORDS)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY_GRANTED)).toBeNull();
    dispose();
  });
});

describe("Root route dev-spoof restore wiring", () => {
  const templateInnerHtmlDescriptor = Object.getOwnPropertyDescriptor(
    HTMLTemplateElement.prototype,
    "innerHTML",
  );
  if (templateInnerHtmlDescriptor?.set && templateInnerHtmlDescriptor.get) {
    const { get: getTemplateInnerHtml, set: setTemplateInnerHtml } = {
      get: templateInnerHtmlDescriptor.get,
      set: templateInnerHtmlDescriptor.set,
    };
    Object.defineProperty(HTMLTemplateElement.prototype, "innerHTML", {
      configurable: true,
      get: getTemplateInnerHtml,
      set(value: string) {
        const shell = value.trimStart().startsWith("<html");
        if (!shell) {
          setTemplateInnerHtml.call(this, value);
          return;
        }
        setTemplateInnerHtml.call(
          this,
          value
            .replace(/<html\b[^>]*>/gi, '<div data-ttc-test-shell="html">')
            .replace(/<\/html>/gi, "</div>")
            .replace(/<head\b[^>]*>/gi, '<div data-ttc-test-shell="head">')
            .replace(/<\/head>/gi, "</div>")
            .replace(/<body\b[^>]*>/gi, '<div data-ttc-test-shell="body">')
            .replace(/<\/body>/gi, "</div>"),
        );
      },
    });
  }

  async function mountRealRoot() {
    vi.resetModules();
    const [hookMod, appMod] = await Promise.all([
      import("~/hooks/useGeolocation"),
      import("~/AppRoot"),
    ]);
    render(() => createComponent(appMod.default, {}));
    return hookMod;
  }

  it("a page load over a persisted spoof lands on dev-spoof via RootComponent's own mount", async () => {
    localStorage.setItem(
      SPOOF_STORAGE_KEY,
      JSON.stringify({
        latitude: 43.6455,
        longitude: -79.3806,
        accuracyMeters: 10,
        appliedAt: Date.now(),
      }),
    );
    const hook = await mountRealRoot();
    expect(hook.getLocationLadder().effectiveFix().source).toBe("dev-spoof");
  });

  it("the same mount without a persisted spoof never claims dev-spoof", async () => {
    const hook = await mountRealRoot();
    expect(hook.getLocationLadder().effectiveFix().source).not.toBe("dev-spoof");
  });
});
