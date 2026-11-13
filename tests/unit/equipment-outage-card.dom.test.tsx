// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { EquipmentOutageCard } from "~/components/map/EquipmentOutageCard";
import { UserPreferencesProvider } from "~/context/UserPreferencesContext";
import { DEFAULT_PREFERENCES } from "~/domain/preferences/UserPreferences";
import { I18nProvider } from "~/i18n/I18nContext";
import { en } from "~/i18n/en";
import { fr } from "~/i18n/fr";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("EquipmentOutageCard", () => {
  it("formats the grouped outage count using the browser region with the selected UI language", async () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-FR"]);
    const items = Array.from({ length: 1000 }, (_, index) => ({
      id: `elevator-${index}`,
      type: "elevator" as const,
      equipment: `Elevator ${index + 1}`,
      location: "",
      rawText: `Elevator ${index + 1} is out of service`,
    }));

    render(() => (
      <UserPreferencesProvider
        storage={{
          load: async () => ({ ...DEFAULT_PREFERENCES, locale: "fr-CA" }),
          save: async () => {},
        }}
      >
        <I18nProvider loadDictionary={async (locale) => (locale === "fr-CA" ? fr : en)}>
          <EquipmentOutageCard title="Ascenseurs hors service" items={items} />
        </I18nProvider>
      </UserPreferencesProvider>
    ));

    const formattedCount = new Intl.NumberFormat("fr-FR").format(items.length);
    const heading = await screen.findByText(/Ascenseurs hors service/);
    expect(heading.textContent).toBe(`Ascenseurs hors service (${formattedCount})`);
  });
});
