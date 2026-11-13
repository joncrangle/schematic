// @vitest-environment happy-dom
/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, encodeUserPreferences } from "~/domain/preferences/UserPreferences";
import {
  createLocalStoragePreferencesStorage,
  createMemoryPreferencesStorage,
  PREFERENCES_STORAGE_KEY,
} from "~/infrastructure/storage/PreferencesStorage";
import { MemoryLocalStorage } from "../helpers/fixtures";

let localStorage: MemoryLocalStorage;

beforeEach(() => {
  localStorage = new MemoryLocalStorage();
  Object.defineProperty(navigator, "languages", {
    configurable: true,
    value: ["en-US"],
  });
  Object.defineProperty(window, "localStorage", { configurable: true, value: localStorage });
  vi.stubGlobal("localStorage", localStorage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createLocalStoragePreferencesStorage", () => {
  it("loads defaults when storage has no preferences", async () => {
    await expect(createLocalStoragePreferencesStorage().load()).resolves.toEqual(
      DEFAULT_PREFERENCES,
    );
  });

  it("uses the browser language when there is no saved preference", async () => {
    Object.defineProperty(navigator, "languages", {
      configurable: true,
      value: ["fr-FR", "en-CA"],
    });

    await expect(createLocalStoragePreferencesStorage().load()).resolves.toMatchObject({
      locale: "fr-CA",
    });
  });

  it("round-trips valid preferences through the domain codec", async () => {
    const preferences = {
      ...DEFAULT_PREFERENCES,
      reducedMotion: "reduce" as const,
      dateOrder: "dmy" as const,
      timeFormat: "24h" as const,
      unitSystem: "imperial" as const,
    };
    const storage = createLocalStoragePreferencesStorage();

    await storage.save(preferences);

    expect(localStorage.getItem(PREFERENCES_STORAGE_KEY)).toBe(encodeUserPreferences(preferences));
    await expect(storage.load()).resolves.toEqual(preferences);
  });

  it.each([
    ["malformed JSON", "{ not valid json"],
    ["schema-invalid data", JSON.stringify({ ...DEFAULT_PREFERENCES, agency: 42 })],
    ["missing agency data", JSON.stringify({ ...DEFAULT_PREFERENCES, agency: undefined })],
  ])("follows codec fallback behavior for %s", async (_label, raw) => {
    localStorage.setItem(PREFERENCES_STORAGE_KEY, raw);

    await expect(createLocalStoragePreferencesStorage().load()).resolves.toMatchObject({
      agency: "auto",
    });
  });

  it("returns defaults when reading storage throws", async () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("read failed");
    });

    await expect(createLocalStoragePreferencesStorage().load()).resolves.toEqual(
      DEFAULT_PREFERENCES,
    );
  });

  it("resolves without throwing when writing storage throws", async () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("write failed");
    });

    await expect(
      createLocalStoragePreferencesStorage().save(DEFAULT_PREFERENCES),
    ).resolves.toBeUndefined();
  });

  it("uses safe defaults when browser storage is unavailable", async () => {
    vi.stubGlobal("window", undefined);
    const storage = createLocalStoragePreferencesStorage();

    await expect(storage.load()).resolves.toEqual(DEFAULT_PREFERENCES);
    await expect(storage.save(DEFAULT_PREFERENCES)).resolves.toBeUndefined();
  });
});

describe("createMemoryPreferencesStorage", () => {
  it("honors its initial value and isolates instances", async () => {
    const initial = {
      ...DEFAULT_PREFERENCES,
      favouriteLines: [{ agencyId: "ttc", lineId: "1" }],
    };
    const first = createMemoryPreferencesStorage(initial);
    const second = createMemoryPreferencesStorage();

    await expect(first.load()).resolves.toEqual(initial);
    await expect(second.load()).resolves.toEqual(DEFAULT_PREFERENCES);

    await first.save({ ...initial, favouriteLines: [{ agencyId: "ttc", lineId: "2" }] });

    await expect(first.load()).resolves.toMatchObject({
      favouriteLines: [{ agencyId: "ttc", lineId: "2" }],
    });
    await expect(second.load()).resolves.toEqual(DEFAULT_PREFERENCES);
  });
});
