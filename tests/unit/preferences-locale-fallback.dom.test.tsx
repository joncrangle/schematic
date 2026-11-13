// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UserPreferencesProvider, useUserPreferences } from "~/context/UserPreferencesContext";
import { DEFAULT_PREFERENCES, encodeUserPreferences } from "~/domain/preferences/UserPreferences";
import {
  createLocalStoragePreferencesStorage,
  PREFERENCES_STORAGE_KEY,
} from "~/infrastructure/storage/PreferencesStorage";

function Probe() {
  const context = useUserPreferences();
  return (
    <>
      <output>{context.isLoaded() ? context.preferences.locale : "loading"}</output>
      <button onClick={() => context.resetPreferences()}>Reset</button>
    </>
  );
}

beforeEach(() => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["fr-FR"]);
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

it.each(["rejection", "synchronous throw"])(
  "honors browser language after a storage %s",
  async (failure) => {
    const storage = {
      ...createLocalStoragePreferencesStorage(),
      load: () => {
        if (failure === "synchronous throw") throw new Error("storage unavailable");
        return Promise.reject(new Error("storage unavailable"));
      },
    };
    render(() => (
      <UserPreferencesProvider storage={storage}>
        <Probe />
      </UserPreferencesProvider>
    ));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("fr-CA"));
  },
);

it("resets a saved locale to browser-language defaults", async () => {
  window.localStorage.setItem(PREFERENCES_STORAGE_KEY, encodeUserPreferences(DEFAULT_PREFERENCES));
  render(() => (
    <UserPreferencesProvider>
      <Probe />
    </UserPreferencesProvider>
  ));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("en-CA"));
  fireEvent.click(screen.getByRole("button", { name: "Reset" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("fr-CA"));
  expect(JSON.parse(window.localStorage.getItem(PREFERENCES_STORAGE_KEY)!).locale).toBe("fr-CA");
});
