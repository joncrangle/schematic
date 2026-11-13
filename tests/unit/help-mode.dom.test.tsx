// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { UserPreferencesProvider } from "~/context/UserPreferencesContext";
import { FormattingCountryProvider, I18nProvider } from "~/i18n/I18nContext";
import { DEFAULT_PREFERENCES } from "~/domain/preferences/UserPreferences";
import { HelpMode } from "~/components/HelpMode";

vi.mock("~/agencies/agencyCatalog", async () => ({
  agencyCatalog: (await import("../helpers/agency-fixtures")).testAgencyCatalog,
}));

describe("help mode", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("opens on first load, remembers dismissal, and reopens from Help", async () => {
    const view = render(() => <HelpMode ready={true} />);
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "How to use Schematic" })).toBeTruthy(),
    );
    expect(document.querySelector('[data-demo-control="zoom-in"]')?.textContent).toBe("+");
    expect(document.querySelector('[data-demo-control="zoom-out"]')?.textContent).toBe("−");
    expect(document.querySelector('[data-demo-control="recentre"]')?.textContent).toBe("⊙");
    const star = screen.getByRole("button", { name: "Practice saving this example station" });
    fireEvent.click(star);
    await waitFor(() => expect(star.getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    view.unmount();
    render(() => <HelpMode ready={true} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "How to use Schematic" })).toBeTruthy(),
    );
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it.each(["button", "escape", "outside"] as const)(
    "clears inert before restoring focus after %s dismissal",
    async (dismissal) => {
      render(() => (
        <main>
          <HelpMode ready={true} />
        </main>
      ));
      const done = await screen.findByRole("button", { name: "Got it" });
      const main = document.querySelector("main")!;
      const help = screen.getByRole("button", { name: "Help" });
      expect(main.inert).toBe(true);
      expect(document.activeElement).toBe(done);
      const focusStates: boolean[] = [];
      const focus = help.focus.bind(help);
      vi.spyOn(help, "focus").mockImplementation(() => {
        focusStates.push(main.inert);
        focus();
      });
      if (dismissal === "button") fireEvent.click(done);
      else if (dismissal === "escape") fireEvent.keyDown(done, { key: "Escape" });
      else fireEvent.click(document.querySelector("[data-help-backdrop]")!);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(focusStates).toEqual([false]);
      expect(document.activeElement).toBe(help);
      const tab = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
      document.dispatchEvent(tab);
      expect(tab.defaultPrevented).toBe(false);
    },
  );

  it.each([
    {
      country: "CA",
      unitSystem: "imperial" as const,
      distance: "0.9 mi",
      spelling: "favourites",
    },
    {
      country: "US",
      unitSystem: "metric" as const,
      distance: "1.5 km",
      spelling: "favorites",
    },
  ])(
    "uses local spelling and the selected units for $country",
    async ({ country, unitSystem, distance, spelling }) => {
      const preferences = { ...DEFAULT_PREFERENCES, unitSystem };
      render(() => (
        <UserPreferencesProvider storage={{ load: async () => preferences, save: async () => {} }}>
          <I18nProvider>
            <FormattingCountryProvider country={country}>
              <HelpMode ready={true} />
            </FormattingCountryProvider>
          </I18nProvider>
        </UserPreferencesProvider>
      ));
      const description = await screen.findByText(new RegExp(distance.replace(".", "\\.")));
      expect(description.textContent).toContain(spelling);
    },
  );

  it.each([
    { viewport: 393, width: 178, targetCenter: 240, settingsLeft: 205 },
    { viewport: 800, width: 232, targetCenter: 444, settingsLeft: 556 },
  ])(
    "points the network arrow at the dropdown at $viewport px",
    async ({ viewport, width, targetCenter, settingsLeft }) => {
      const originalWidth = window.innerWidth;
      Object.defineProperty(window, "innerWidth", { configurable: true, value: viewport });
      vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
        this: HTMLElement,
      ) {
        return this.dataset.helpCard === "network" ? width : 0;
      });
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        if (this.dataset.demoTarget === "network")
          return new DOMRect(targetCenter - 40, 16, 80, 34);
        if (this.dataset.helpCard === "settings") return new DOMRect(settingsLeft, 76, width, 100);
        if (this.dataset.helpCard === "network")
          return new DOMRect(parseFloat(this.style.left) || 12, 76, width, 100);
        return new DOMRect();
      });
      try {
        render(() => <HelpMode ready={true} />);
        await waitFor(() => {
          const card = document.querySelector<HTMLElement>('[data-help-card="network"]')!;
          const path = card.querySelector("svg path")!;
          const tip = Number(path.getAttribute("d")?.match(/L ([\d.]+) 0/)?.[1]);
          const arrowTip = 12 + tip;
          expect(arrowTip).toBeGreaterThan(targetCenter - 40);
          expect(arrowTip).toBeLessThan(targetCenter + 40);
          expect(card.style.left).toBe("");
        });
      } finally {
        Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
      }
    },
  );
  it("uses the selected language and units", async () => {
    const preferences = {
      ...DEFAULT_PREFERENCES,
      locale: "fr-CA" as const,
      unitSystem: "imperial" as const,
    };
    render(() => (
      <UserPreferencesProvider storage={{ load: async () => preferences, save: async () => {} }}>
        <I18nProvider>
          <HelpMode ready={true} />
        </I18nProvider>
      </UserPreferencesProvider>
    ));
    expect(await screen.findByText(/0,9 mi/)).toBeTruthy();
    const star = screen.getByRole("button", {
      name: "Essayez d’enregistrer cette station fictive",
    });
    fireEvent.click(star);
    await waitFor(() => expect(star.getAttribute("aria-pressed")).toBe("true"));
  });

  it("remembers dismissal for the session when storage is unavailable", async () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("Storage is blocked", "SecurityError");
    });
    const first = render(() => <HelpMode ready={true} />);
    fireEvent.click(await screen.findByRole("button", { name: "Got it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    first.unmount();
    render(() => <HelpMode ready={true} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
