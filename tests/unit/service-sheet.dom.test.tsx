vi.mock("~/agencies/agencyCatalog", async () => {
  const { testAgencyCatalog } = await import("../helpers/agency-fixtures");
  return {
    agencyCatalog: testAgencyCatalog.map((entry) => {
      if (entry.manifest.id === "regional") {
        return {
          ...entry,
          manifest: {
            ...entry.manifest,
            attribution: {
              name: "Regional Open Data",
              url: "https://regional.example.test/data",
              license: "Example Regional Licence",
            },
          },
        };
      }
      if (entry.manifest.id === "sample") {
        return {
          ...entry,
          manifest: {
            ...entry.manifest,
            attribution: {
              ...entry.manifest.attribution,
              translations: {
                fr: {
                  name: "Données Exemple",
                  url: "https://example.test/fr-data",
                  license: "Licence Exemple FR",
                },
              },
            },
          },
        };
      }
      return entry;
    }),
  };
});
// @vitest-environment happy-dom
import { describe, expect, it, afterEach, vi } from "vitest";
import { createSignal, flush } from "solid-js";
import { render, screen, cleanup, fireEvent, within } from "@solidjs/testing-library";
import { BottomPillNav } from "~/components/BottomPillNav";
import { OpenDataAttribution } from "~/components/legal/OpenDataAttribution";
import { UserPreferencesProvider } from "~/context/UserPreferencesContext";
import { I18nProvider } from "~/i18n/I18nContext";
import { createMemoryPreferencesStorage } from "~/infrastructure/storage/PreferencesStorage";
import { DEFAULT_PREFERENCES } from "~/domain/preferences/UserPreferences";
import type { SheetTab } from "~/lib/shellSession";
import {
  firePointerDown,
  observeBodyRemovals,
  removedNodeOrDescendant,
} from "../helpers/dom-lifecycle-harness";

afterEach(cleanup);

describe("ServiceSheetModal Open Lifecycle (no-backdrop regression guards)", () => {
  it("keeps cached accessibility alerts reachable after a live-to-stale transition", async () => {
    const [freshness, setFreshness] = createSignal<"live" | "stale">("live");
    render(() => (
      <UserPreferencesProvider>
        <button onClick={() => setFreshness("stale")}>Lose live source</button>
        <BottomPillNav
          agencyId="sample"
          activeSheet="alerts"
          freshness={freshness()}
          onToggleSheet={() => {}}
          alerts={[
            {
              id: "lift",
              scope: "station",
              lineName: "Line A",
              title: "Central elevator outage",
              description: "Use the other entrance.",
              kind: "accessibility",
              severity: "normal",
              updatedAt: 1,
              updatedAtLabel: "Now",
            },
          ]}
        />
      </UserPreferencesProvider>
    ));
    await fireEvent.click(screen.getByRole("button", { name: "Lose live source" }));
    await fireEvent.click(screen.getByRole("button", { name: /Accessibility/ }));
    expect(screen.getByText("Central elevator outage")).toBeDefined();
  });
  it.each([
    ["alerts", "stale"],
    ["alerts", "unavailable"],
    ["upcoming", "stale"],
    ["upcoming", "unavailable"],
  ] as const)("warns instead of declaring an empty %s panel clear when %s", (tab, freshness) => {
    render(() => (
      <UserPreferencesProvider>
        <BottomPillNav
          agencyId="sample"
          activeSheet={tab}
          freshness={freshness}
          onToggleSheet={() => {}}
        />
      </UserPreferencesProvider>
    ));
    expect(
      screen.getByText(
        freshness === "stale" ? "Service alerts may be out of date" : "Live alerts unavailable",
      ),
    ).toBeDefined();
    expect(screen.queryByText("No alerts in selected filters")).toBeNull();
    expect(screen.queryByText("No upcoming closures")).toBeNull();
  });
  const dialog = () => screen.queryByRole("dialog", { name: "Service information" });

  /**
   * Mirrors the app structure from src/routes/index.tsx: BottomPillNav owns
   * BOTH the sheet panel and the <nav> trigger container, so the harness
   * renders the nav component itself and records every onToggleSheet call.
   */
  function renderNavHarness() {
    const toggleCalls: (SheetTab | null)[] = [];

    const Harness = () => {
      const [activeSheet, setActiveSheet] = createSignal<SheetTab | null>(null);
      return (
        <>
          <header data-testid="app-header">
            <span>Schematic</span>
          </header>
          <main data-testid="app-main">
            <BottomPillNav
              agencyId="sample"
              activeSheet={activeSheet()}
              onToggleSheet={(tab) => {
                toggleCalls.push(tab);
                setActiveSheet(tab);
              }}
            />
          </main>
        </>
      );
    };

    // Mirrors the root layout: the provider wraps the outlet in
    // src/routes/__root.tsx, and AlertsPanel (inside the sheet) requires it.
    const { container } = render(() => (
      <UserPreferencesProvider>
        <Harness />
      </UserPreferencesProvider>
    ));
    return { container, toggleCalls };
  }

  async function openAlertsSheet() {
    await fireEvent.click(screen.getByRole("button", { name: "Alerts" }));
    // Solid 2 stages writes until the microtask queue drains: commit the open
    // (and the dialog's onSettled listener attach) before interacting.
    flush();
  }

  it("preserves focused service buttons while live counts update", () => {
    const [count, setCount] = createSignal(1);
    render(() => (
      <UserPreferencesProvider>
        <BottomPillNav
          agencyId="sample"
          activeSheet="alerts"
          onToggleSheet={() => {}}
          alertCount={count()}
        />
      </UserPreferencesProvider>
    ));

    const trigger = screen.getByRole("button", { name: "Alerts 1" });
    const tab = screen.getByRole("tab", { name: "Alerts 1" });
    trigger.focus();
    setCount(2);
    flush();

    expect(screen.getByRole("button", { name: "Alerts 2" })).toBe(trigger);
    expect(screen.getByRole("tab", { name: "Alerts 2" })).toBe(tab);
    expect(document.activeElement).toBe(trigger);
  });

  it("mounts no viewport-covering backdrop when opened", async () => {
    renderNavHarness();

    await openAlertsSheet();
    expect(dialog()).toBeDefined();

    // THE red-flag selector for the reported flash: any element whose classes
    // include both `fixed` and `inset-0` spans the whole viewport and forces a
    // full-page composite. Opening must mount no such element.
    const insetCandidates = Array.from(
      document.body.querySelectorAll<HTMLElement>('[class*="inset-0"]'),
    );
    const viewportCovering = insetCandidates.filter((el) => el.classList.contains("fixed"));
    expect(viewportCovering.map((el) => el.className)).toEqual([]);
  });

  it("preserves dialog DOM node and updates fine-grained when switching between tabs", async () => {
    const { createShellSession } = await import("~/lib/shellSession");
    const shellSession = createShellSession();

    const Harness = () => (
      <BottomPillNav
        agencyId="sample"
        activeSheet={shellSession.activeSheet()}
        onToggleSheet={(tab) => {
          if (tab === null) {
            shellSession.closeSheet();
          } else {
            shellSession.openSheet(tab);
          }
        }}
      />
    );

    render(() => (
      <UserPreferencesProvider>
        <Harness />
      </UserPreferencesProvider>
    ));

    shellSession.openSheet("alerts");
    // Commit before asserting DOM (staged writes).
    flush();
    const dialogInitial = dialog();
    expect(dialogInitial).not.toBeNull();
    expect(screen.getByText("No alerts in selected filters")).toBeDefined();

    // Switch to Upcoming tab via the dialog header tablist
    const tabButtons = screen.getAllByRole("tab");
    const upcomingTab = tabButtons.find((b) => b.textContent?.includes("Upcoming"));
    expect(upcomingTab).toBeDefined();
    await fireEvent.click(upcomingTab!);

    // The dialog container must remain the exact same DOM node (no remount)
    const dialogAfterSwitch = dialog();
    expect(dialogAfterSwitch).toBe(dialogInitial);
    expect(screen.getByText("No upcoming closures")).toBeDefined();

    // Switch back to Alerts tab
    const alertsTab = screen.getAllByRole("tab").find((b) => b.textContent?.includes("Alerts"));
    expect(alertsTab).toBeDefined();
    await fireEvent.click(alertsTab!);

    // Dialog remains the exact same DOM node
    expect(dialog()).toBe(dialogInitial);
    expect(screen.getByText("No alerts in selected filters")).toBeDefined();
  });

  it("renders the selected panel body in the initial open commit", async () => {
    renderNavHarness();

    await fireEvent.click(screen.getByRole("button", { name: "Upcoming" }));

    expect(screen.getByText("No upcoming closures")).toBeDefined();
  });

  it("renders the alerts body in the initial open commit", async () => {
    renderNavHarness();

    await fireEvent.click(screen.getByRole("button", { name: "Alerts" }));

    expect(screen.getByText("No alerts in selected filters")).toBeDefined();
  });

  it("closes synchronously on outside pointerdown via onToggleSheet(null)", async () => {
    const { container, toggleCalls } = renderNavHarness();

    await openAlertsSheet();
    expect(dialog()).not.toBeNull();
    expect(toggleCalls).toEqual(["alerts"]);

    // Outside: an element that is neither the dialog panel nor a nav trigger.
    const outsideArea = document.createElement("div");
    outsideArea.setAttribute("data-testid", "outside-area");
    container.appendChild(outsideArea);
    firePointerDown(outsideArea);
    // The close write is staged: drain before asserting the dialog unmounted.
    flush();
    expect(dialog()).toBeNull();
    expect(toggleCalls).toEqual(["alerts", null]);
  });

  it("keeps the sheet open when pointerdown lands inside the panel", async () => {
    const { toggleCalls } = renderNavHarness();

    await openAlertsSheet();
    expect(dialog()).not.toBeNull();

    firePointerDown(screen.getByRole("dialog", { name: "Service information" }));
    expect(dialog()).not.toBeNull();
    expect(toggleCalls).toEqual(["alerts"]);
  });

  it("ignores pointerdown on each nav trigger so its click toggles exactly once", async () => {
    const { toggleCalls } = renderNavHarness();

    await openAlertsSheet();
    expect(dialog()).not.toBeNull();

    // The document-level listener must ignore both trigger buttons so their
    // own onClick performs exactly one toggle (no close-then-reopen flicker).
    firePointerDown(screen.getByRole("button", { name: "Alerts" }));
    expect(dialog()).not.toBeNull();
    firePointerDown(screen.getByRole("button", { name: "Upcoming" }));
    expect(dialog()).not.toBeNull();
    expect(toggleCalls).toEqual(["alerts"]);

    // The subsequent click still closes with exactly one toggle call.
    await fireEvent.click(screen.getByRole("button", { name: "Alerts" }));
    expect(dialog()).toBeNull();
    expect(toggleCalls).toEqual(["alerts", null]);
  });

  it("only adds the sheet subtree on open and never removes pre-existing UI", async () => {
    renderNavHarness();
    const header = screen.getByTestId("app-header");
    const main = screen.getByTestId("app-main");

    const removals = observeBodyRemovals();

    try {
      await openAlertsSheet();

      const removedList = removals.takeRemoved();

      // Opening must only ADD the sheet subtree — never remove or redraw
      // any UI that existed before the click.
      expect(removedNodeOrDescendant(removedList, header)).toBe(false);
      expect(removedNodeOrDescendant(removedList, main)).toBe(false);

      // Sanity: the open actually mounted the dialog subtree.
      expect(dialog()).toBeDefined();
    } finally {
      removals.disconnect();
    }
  });

  it("closes on Escape key press when open", async () => {
    const { toggleCalls } = renderNavHarness();

    await openAlertsSheet();
    expect(dialog()).not.toBeNull();
    expect(toggleCalls).toEqual(["alerts"]);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    // The close write is staged: drain before asserting the dialog unmounted.
    flush();
    expect(dialog()).toBeNull();
    expect(toggleCalls).toEqual(["alerts", null]);
  });
});

describe("OpenDataAttribution", () => {
  it.each(["alerts", "upcoming"] as const)(
    "keeps the %s footer licence and link in sync with the selected agency",
    async (tab) => {
      const Harness = () => {
        const [agencyId, setAgencyId] = createSignal("regional");
        return (
          <>
            <button onClick={() => setAgencyId(agencyId() === "regional" ? "sample" : "regional")}>
              Switch agency
            </button>
            <BottomPillNav agencyId={agencyId()} activeSheet={tab} onToggleSheet={() => {}} />
          </>
        );
      };

      render(() => (
        <UserPreferencesProvider>
          <Harness />
        </UserPreferencesProvider>
      ));

      const panel = screen.getByRole("dialog", { name: "Service information" });
      const assertRegionalLicence = () => {
        const link = within(panel).getByRole("link", { name: "Example Regional Licence" });
        expect(link.getAttribute("href")).toBe("https://regional.example.test/data");
        expect(within(panel).queryByRole("link", { name: "CC0" })).toBeNull();
      };
      assertRegionalLicence();

      await fireEvent.click(screen.getByRole("button", { name: "Switch agency" }));
      flush();
      expect(within(panel).getByRole("link", { name: "CC0" }).getAttribute("href")).toBe(
        "https://example.test/data",
      );
      expect(within(panel).queryByRole("link", { name: "Example Regional Licence" })).toBeNull();

      await fireEvent.click(screen.getByRole("button", { name: "Switch agency" }));
      flush();
      assertRegionalLicence();
    },
  );

  it("renders licence text and link from the active provider manifest", () => {
    const { container } = render(() => <OpenDataAttribution />);

    const links = Array.from(container.querySelectorAll("a"));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.href).toBe("https://example.test/data");
    }
    expect(container.textContent).toContain("CC0");
  });

  it("credits the manifest attribution source by name on the card variant", () => {
    const { container } = render(() => <OpenDataAttribution variant="card" />);

    expect(container.textContent).toContain("Sample Open Data");
  });

  it.each(["card", "footer"] as const)(
    "picks the French attribution URL and licence in %s when locale is fr-CA and a variant exists",
    async (variant) => {
      const storage = createMemoryPreferencesStorage({ ...DEFAULT_PREFERENCES, locale: "fr-CA" });
      render(() => (
        <UserPreferencesProvider storage={storage}>
          <I18nProvider>
            <OpenDataAttribution agencyId="sample" variant={variant} />
          </I18nProvider>
        </UserPreferencesProvider>
      ));

      const link = await screen.findByRole("link", { name: "Licence Exemple FR" });
      expect(link.getAttribute("href")).toBe("https://example.test/fr-data");
      expect(screen.queryByRole("link", { name: "CC0" })).toBeNull();
    },
  );

  it("falls back to the default attribution when no French variant exists", async () => {
    const storage = createMemoryPreferencesStorage({ ...DEFAULT_PREFERENCES, locale: "fr-CA" });
    render(() => (
      <UserPreferencesProvider storage={storage}>
        <I18nProvider>
          <OpenDataAttribution agencyId="regional" variant="footer" />
        </I18nProvider>
      </UserPreferencesProvider>
    ));

    const link = await screen.findByRole("link", { name: "Example Regional Licence" });
    expect(link.getAttribute("href")).toBe("https://regional.example.test/data");
    expect(screen.queryByRole("link", { name: "Licence Exemple FR" })).toBeNull();
  });
});
