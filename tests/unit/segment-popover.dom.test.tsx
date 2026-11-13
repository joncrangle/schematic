// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { DEFAULT_PREFERENCES } from "~/domain/preferences/UserPreferences";
import { UserPreferencesProvider } from "~/context/UserPreferencesContext";
import { I18nProvider } from "~/i18n/I18nContext";
import { SegmentPopover } from "~/components/map/SegmentPopover";

afterEach(cleanup);

describe("SegmentPopover localization", () => {
  it("translates map chrome while preserving operator-provided notes", async () => {
    const preferences = { ...DEFAULT_PREFERENCES, locale: "fr-CA" as const };
    render(() => (
      <UserPreferencesProvider storage={{ load: async () => preferences, save: async () => {} }}>
        <I18nProvider>
          <SegmentPopover
            segment={{
              id: "line-1-work",
              kind: "severe",
              lineId: "1",
              lineName: "Line 1",
              lineColor: "#ffcb05",
              fromStation: "Bloor–Yonge",
              toStation: "Queen",
              note: "Track work overnight",
              pathD: "M0 0 L1 1",
              midpoint: { x: 100, y: 100 },
            }}
            coords={{ x: 100, y: 100 }}
            containerSize={{ width: 800, height: 600 }}
            onClose={vi.fn()}
            setRef={vi.fn()}
          />
        </I18nProvider>
      </UserPreferencesProvider>
    ));

    const dialog = await screen.findByRole("dialog", {
      name: "Détails de la perturbation : Track work overnight",
    });
    expect(dialog.textContent).toContain("Perturbation majeure");
    expect(dialog.textContent).toContain("Track work overnight");
    expect(dialog.textContent).toContain("Bloor–Yonge ↔ Queen");
  });
});
