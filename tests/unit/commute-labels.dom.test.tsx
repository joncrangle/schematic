// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { CommuteScheduleTab } from "~/components/settings/CommuteScheduleTab";
import { UserPreferencesProvider, useUserPreferences } from "~/context/UserPreferencesContext";
import {
  DEFAULT_PREFERENCES,
  decodeUserPreferences,
  encodeUserPreferences,
} from "~/domain/preferences/UserPreferences";
import { I18nProvider } from "~/i18n/I18nContext";
import { en } from "~/i18n/en";
import { fr } from "~/i18n/fr";
import type { PreferencesStorage } from "~/infrastructure/storage/PreferencesStorage";

vi.mock("~/hooks/usePushAvailability", () => ({
  usePushAvailability: () => ({ isAvailable: () => true }),
}));
afterEach(cleanup);

it("localizes generated custom labels across reloads and preserves an edited label across languages", async () => {
  let saved = encodeUserPreferences({ ...DEFAULT_PREFERENCES, locale: "fr-CA" });
  const storage: PreferencesStorage = {
    load: async () => decodeUserPreferences(saved),
    save: async (preferences) => {
      saved = encodeUserPreferences(preferences);
    },
  };
  function Controls() {
    const { setPreference } = useUserPreferences();
    return (
      <>
        <button onClick={() => setPreference("locale", "en-CA")}>Select English</button>
        <button onClick={() => setPreference("locale", "fr-CA")}>Select French</button>
      </>
    );
  }
  const mount = () =>
    render(() => (
      <UserPreferencesProvider storage={storage}>
        <I18nProvider loadDictionary={async (locale) => (locale === "fr-CA" ? fr : en)}>
          <Controls />
          <CommuteScheduleTab />
        </I18nProvider>
      </UserPreferencesProvider>
    ));
  const view = mount();
  await fireEvent.click(await screen.findByRole("button", { name: /Ajouter une plage/ }));
  expect(await screen.findByText("Trajet personnalisé")).toBeDefined();
  view.unmount();
  mount();
  expect(await screen.findByText("Trajet personnalisé")).toBeDefined();
  await fireEvent.click(screen.getByRole("button", { name: "Select English" }));
  expect(await screen.findByText("Custom Commute")).toBeDefined();
  await fireEvent.click(screen.getByRole("button", { name: "Select French" }));
  const edit = await screen.findByRole("button", {
    name: "Modifier le nom de Trajet personnalisé",
  });
  await fireEvent.click(edit);
  const input = screen.getByRole("textbox");
  expect((input as HTMLInputElement).value).toBe("Trajet personnalisé");
  await fireEvent.input(input, { target: { value: "Custom Commute" } });
  await fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByText("Custom Commute")).toBeDefined();
  await fireEvent.click(screen.getByRole("button", { name: "Select English" }));
  expect(await screen.findByText("Morning Commute")).toBeDefined();
  expect(screen.getByText("Custom Commute")).toBeDefined();
  cleanup();
  mount();
  expect(await screen.findByText("Custom Commute")).toBeDefined();
  await fireEvent.click(screen.getByRole("button", { name: "Select French" }));
  expect(await screen.findByText("Trajet du matin")).toBeDefined();
  expect(screen.getByText("Custom Commute")).toBeDefined();
});
