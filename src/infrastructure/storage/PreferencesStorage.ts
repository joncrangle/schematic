import { DEFAULT_UI_LOCALE, resolveLocale } from "~/domain/locale";
import {
  decodeUserPreferences,
  DEFAULT_PREFERENCES,
  encodeUserPreferences,
  type UserPreferences,
} from "~/domain/preferences/UserPreferences";
import { logger } from "~/infrastructure/logging/logger";

export const PREFERENCES_STORAGE_KEY = "schematic:preferences:v1";

export interface PreferencesStorage {
  load(): Promise<UserPreferences>;
  save(preferences: UserPreferences): Promise<void>;
}

function clonePreferences(preferences: UserPreferences): UserPreferences {
  return structuredClone(preferences);
}

export function createMemoryPreferencesStorage(
  initialPreferences: UserPreferences = DEFAULT_PREFERENCES,
): PreferencesStorage {
  let preferences = clonePreferences(initialPreferences);

  return {
    async load() {
      return clonePreferences(preferences);
    },
    async save(updatedPreferences) {
      preferences = clonePreferences(updatedPreferences);
    },
  };
}

function getLocalStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;

  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function browserLocale() {
  if (typeof navigator === "undefined") return DEFAULT_UI_LOCALE;
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  return resolveLocale(languages);
}

/** Browser-aware defaults shared by loading failures and explicit resets. */
export function browserDefaultPreferences(): UserPreferences {
  return { ...clonePreferences(DEFAULT_PREFERENCES), locale: browserLocale() };
}

export function createLocalStoragePreferencesStorage(): PreferencesStorage {
  return {
    async load() {
      const storage = getLocalStorage();
      const fallbackLocale = browserLocale();
      if (!storage) return browserDefaultPreferences();

      try {
        return decodeUserPreferences(storage.getItem(PREFERENCES_STORAGE_KEY), fallbackLocale);
      } catch (error) {
        logger.warn("PreferencesStorage: failed to read localStorage", {
          key: PREFERENCES_STORAGE_KEY,
          error,
        });
        return browserDefaultPreferences();
      }
    },
    async save(preferences) {
      const storage = getLocalStorage();
      if (!storage) return;

      try {
        storage.setItem(PREFERENCES_STORAGE_KEY, encodeUserPreferences(preferences));
      } catch (error) {
        logger.warn("PreferencesStorage: failed to write localStorage", {
          key: PREFERENCES_STORAGE_KEY,
          error,
        });
      }
    },
  };
}
