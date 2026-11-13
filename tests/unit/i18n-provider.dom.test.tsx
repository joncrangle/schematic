// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, type UserPreferences } from "~/domain/preferences/UserPreferences";
import { UserPreferencesProvider, useUserPreferences } from "~/context/UserPreferencesContext";
import { I18nProvider, useI18n } from "~/i18n/I18nContext";
import { en, type TranslationDictionary } from "~/i18n/en";
import { fr } from "~/i18n/fr";
import type { PreferencesStorage } from "~/infrastructure/storage/PreferencesStorage";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function memoryStorage(preferences: UserPreferences): PreferencesStorage {
  return { load: async () => preferences, save: async () => {} };
}

function Probe(props: { readonly onMount?: () => void }) {
  const preferences = useUserPreferences();
  const i18n = useI18n();
  const [count, setCount] = createSignal(1);
  props.onMount?.();
  return (
    <section>
      <p>{i18n.t("Language")}</p>
      <output data-testid="plural-result">{i18n.plural("Push recipient count", 5)}</output>
      <output data-testid="display-locale">{i18n.displayLocale()}</output>
      <output data-testid="count">{count()}</output>
      <button aria-label="increment" onClick={() => setCount((value) => value + 1)}>
        Increment
      </button>
      <button
        aria-label="select French"
        onClick={() => preferences.setPreference("locale", "fr-CA")}
      >
        French
      </button>
      <button
        aria-label="select English"
        onClick={() => preferences.setPreference("locale", "en-CA")}
      >
        English
      </button>
    </section>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.documentElement.lang = "en-CA";
});

describe("I18nProvider loading and switching", () => {
  it("reuses default number and relative-time formatters across ticks while honoring locale changes", async () => {
    const number = vi.spyOn(Intl, "NumberFormat");
    const relative = vi.spyOn(Intl, "RelativeTimeFormat");
    function ClockProbe() {
      const i18n = useI18n();
      const preferences = useUserPreferences();
      const [count, setCount] = createSignal(1);
      return (
        <>
          <output>
            {i18n.formatNumber(count())} | {i18n.formatRelativeTime(-count(), "second")}
          </output>
          <button onClick={() => setCount(count() + 1)}>Tick</button>
          <button onClick={() => preferences.setPreference("locale", "fr-CA")}>French</button>
        </>
      );
    }
    render(() => (
      <UserPreferencesProvider storage={memoryStorage(DEFAULT_PREFERENCES)}>
        <I18nProvider>
          <ClockProbe />
        </I18nProvider>
      </UserPreferencesProvider>
    ));
    await screen.findByText("1 | 1 second ago");
    const numberCalls = number.mock.calls.length;
    const relativeCalls = relative.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Tick" }));
    await screen.findByText("2 | 2 seconds ago");
    expect(number).toHaveBeenCalledTimes(numberCalls);
    expect(relative).toHaveBeenCalledTimes(relativeCalls);
    fireEvent.click(screen.getByRole("button", { name: "French" }));
    expect(await screen.findByText("2 | il y a 2 secondes")).toBeTruthy();
  });
  it("waits for preferences and the first dictionary before rendering chrome", async () => {
    const preferenceLoad = deferred<UserPreferences>();
    const frenchLoad = deferred<TranslationDictionary>();
    const storage: PreferencesStorage = {
      load: () => preferenceLoad.promise,
      save: async () => {},
    };
    const loadDictionary = vi.fn((locale: "en-CA" | "fr-CA") =>
      locale === "fr-CA" ? frenchLoad.promise : Promise.resolve(en),
    );
    render(() => (
      <UserPreferencesProvider storage={storage}>
        <I18nProvider loadDictionary={loadDictionary}>
          <Probe />
        </I18nProvider>
      </UserPreferencesProvider>
    ));

    expect(document.querySelector('[data-i18n-loading="true"]')).not.toBeNull();
    expect(screen.queryByText("Langue")).toBeNull();
    preferenceLoad.resolve({ ...DEFAULT_PREFERENCES, locale: "fr-CA" });
    await waitFor(() => expect(loadDictionary).toHaveBeenCalledWith("fr-CA"));
    expect(document.querySelector('[data-i18n-loading="true"]')).not.toBeNull();
    expect(screen.queryByText("Language")).toBeNull();

    frenchLoad.resolve(fr);
    expect(await screen.findByText("Langue")).toBeTruthy();
    await waitFor(() => expect(document.documentElement.lang).toBe("fr-CA"));
  });

  it("keeps a mounted settings child and its local state while a new locale loads", async () => {
    const frenchLoad = deferred<TranslationDictionary>();
    let mounts = 0;
    const loadDictionary = vi.fn((locale: "en-CA" | "fr-CA") =>
      locale === "fr-CA" ? frenchLoad.promise : Promise.resolve(en),
    );
    render(() => (
      <UserPreferencesProvider storage={memoryStorage(DEFAULT_PREFERENCES)}>
        <I18nProvider loadDictionary={loadDictionary}>
          <Probe onMount={() => mounts++} />
        </I18nProvider>
      </UserPreferencesProvider>
    ));

    await screen.findByText("Language");
    fireEvent.click(screen.getByRole("button", { name: "increment" }));
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("2"));
    fireEvent.click(screen.getByRole("button", { name: "select French" }));
    await waitFor(() => expect(loadDictionary).toHaveBeenCalledWith("fr-CA"));
    expect(mounts).toBe(1);
    frenchLoad.resolve(fr);

    expect(await screen.findByText("Langue")).toBeTruthy();
    expect(screen.getByTestId("count").textContent).toBe("2");
    expect(mounts).toBe(1);
  });

  it("ignores an older locale load after the rider switches back", async () => {
    const frenchLoad = deferred<TranslationDictionary>();
    const loadDictionary = vi.fn((locale: "en-CA" | "fr-CA") =>
      locale === "fr-CA" ? frenchLoad.promise : Promise.resolve(en),
    );
    render(() => (
      <UserPreferencesProvider storage={memoryStorage(DEFAULT_PREFERENCES)}>
        <I18nProvider loadDictionary={loadDictionary}>
          <Probe />
        </I18nProvider>
      </UserPreferencesProvider>
    ));

    await screen.findByText("Language");
    fireEvent.click(screen.getByRole("button", { name: "select French" }));
    await waitFor(() => expect(loadDictionary).toHaveBeenCalledWith("fr-CA"));
    fireEvent.click(screen.getByRole("button", { name: "select English" }));
    expect(await screen.findByText("Language")).toBeTruthy();
    frenchLoad.resolve(fr);
    await waitFor(() => expect(document.documentElement.lang).toBe("en-CA"));
    expect(screen.queryByText("Langue")).toBeNull();
  });

  it("ignores a dictionary load that settles after the provider is disposed", async () => {
    const frenchLoad = deferred<TranslationDictionary>();
    const loadDictionary = vi.fn((locale: "en-CA" | "fr-CA") =>
      locale === "fr-CA" ? frenchLoad.promise : Promise.resolve(en),
    );
    const view = render(() => (
      <UserPreferencesProvider storage={memoryStorage(DEFAULT_PREFERENCES)}>
        <I18nProvider loadDictionary={loadDictionary}>
          <Probe />
        </I18nProvider>
      </UserPreferencesProvider>
    ));

    await screen.findByText("Language");
    fireEvent.click(screen.getByRole("button", { name: "select French" }));
    await waitFor(() => expect(loadDictionary).toHaveBeenCalledWith("fr-CA"));
    view.unmount();
    frenchLoad.resolve(fr);
    await Promise.resolve();

    expect(document.documentElement.lang).toBe("en-CA");
  });

  it("uses English chrome and lang metadata when the selected bundle fails", async () => {
    const failure = vi.fn(async (_locale: "en-CA" | "fr-CA") => {
      throw new Error("chunk missing");
    });
    render(() => (
      <UserPreferencesProvider storage={memoryStorage({ ...DEFAULT_PREFERENCES, locale: "fr-CA" })}>
        <I18nProvider loadDictionary={failure}>
          <Probe />
        </I18nProvider>
      </UserPreferencesProvider>
    ));
    expect(await screen.findByText("Language")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("display-locale").textContent).toBe("en-CA"));
    expect(document.documentElement.lang).toBe("en-CA");
    expect(failure).toHaveBeenCalledWith("fr-CA");
  });

  it("selects dictionary-authored plural categories beyond English and French defaults", async () => {
    const customFrench: TranslationDictionary = {
      ...fr,
      "Push recipient count": {
        one: "{{count}} appareil",
        few: "{{count}} appareils désignés",
        other: "{{count}} appareils",
      },
    };
    const pluralCategory = vi.spyOn(Intl.PluralRules.prototype, "select").mockReturnValue("few");

    render(() => (
      <UserPreferencesProvider
        storage={{
          load: async () => ({ ...DEFAULT_PREFERENCES, locale: "fr-CA" }),
          save: async () => {},
        }}
      >
        <I18nProvider loadDictionary={async (locale) => (locale === "fr-CA" ? customFrench : en)}>
          <Probe />
        </I18nProvider>
      </UserPreferencesProvider>
    ));

    expect(await screen.findByText("Langue")).toBeTruthy();
    expect(screen.getByTestId("plural-result").textContent).toBe("5 appareils désignés");
    expect(pluralCategory).toHaveBeenCalledWith(5);
  });
});
