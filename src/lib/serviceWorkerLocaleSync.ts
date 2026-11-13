import { SUPPORTED_UI_LOCALES, type UiLocale } from "~/domain/locale";
import { createSetLocaleMessage, type SetLocaleMessage } from "~/domain/localeWorkerMessage";
import { loadWorkerMessages } from "~/i18n/workerCatalog";

declare const __SCHEMATIC_APP_BUILD_GENERATION__: unknown;

export const SERVICE_WORKER_LOCALE_SELECTION_KEY = "schematic:worker-locale-selection:v1";
const LOCALE_SELECTION_LOCK = "schematic:worker-locale-selection";
const MAX_LOCALE_REVISION = Number.MAX_SAFE_INTEGER;
const APP_BUILD_GENERATION =
  typeof __SCHEMATIC_APP_BUILD_GENERATION__ === "number" &&
  Number.isSafeInteger(__SCHEMATIC_APP_BUILD_GENERATION__) &&
  __SCHEMATIC_APP_BUILD_GENERATION__ >= 0
    ? __SCHEMATIC_APP_BUILD_GENERATION__
    : 0;

interface LocaleSelection {
  readonly locale: UiLocale;
  readonly revision: number;
}

type LocaleSelectionStorage = Pick<Storage, "getItem" | "setItem">;

function browserSelectionStorage(): LocaleSelectionStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function readLocaleSelection(
  storage: LocaleSelectionStorage,
):
  | { readonly kind: "empty" }
  | { readonly kind: "invalid" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "stored"; readonly selection: LocaleSelection } {
  let raw: string | null;
  try {
    raw = storage.getItem(SERVICE_WORKER_LOCALE_SELECTION_KEY);
  } catch {
    return { kind: "unavailable" };
  }
  if (raw === null) return { kind: "empty" };

  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object") return { kind: "invalid" };
    const record = value as Partial<LocaleSelection>;
    if (
      typeof record.locale !== "string" ||
      !SUPPORTED_UI_LOCALES.some((entry) => entry.tag === record.locale) ||
      !Number.isSafeInteger(record.revision) ||
      (record.revision ?? 0) < 1 ||
      (record.revision ?? MAX_LOCALE_REVISION + 1) > MAX_LOCALE_REVISION
    ) {
      return { kind: "invalid" };
    }
    return {
      kind: "stored",
      selection: { locale: record.locale as UiLocale, revision: record.revision! },
    };
  } catch {
    return { kind: "invalid" };
  }
}

function writeLocaleSelection(
  storage: LocaleSelectionStorage,
  selection: LocaleSelection,
): boolean {
  try {
    storage.setItem(SERVICE_WORKER_LOCALE_SELECTION_KEY, JSON.stringify(selection));
    return true;
  } catch {
    return false;
  }
}

function withLocaleSelectionLock<T>(operation: () => T): Promise<T> {
  const fallback = () => {
    try {
      return Promise.resolve(operation());
    } catch (error) {
      return Promise.reject(error);
    }
  };
  if (typeof navigator !== "undefined" && navigator.locks) {
    try {
      return navigator.locks
        .request(LOCALE_SELECTION_LOCK, { mode: "exclusive" }, operation)
        .catch(fallback);
    } catch {
      // A denied or unavailable Web Lock must not prevent worker locale sync.
      return fallback();
    }
  }
  return fallback();
}

/** Keeps one worker aligned with the page's lazily loaded, selected language catalog. */
export function createServiceWorkerLocaleSync(
  loadMessages = loadWorkerMessages,
  selectionStorage = browserSelectionStorage(),
  catalogGeneration = APP_BUILD_GENERATION,
) {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return {
      sync: (_locale: UiLocale) => {},
      hydrate: (_locale: UiLocale) => {},
      dispose: () => {},
    };
  }

  const serviceWorker = navigator.serviceWorker;
  let loadedMessage: SetLocaleMessage | undefined;
  let readyWorker: ServiceWorker | null | undefined;
  let disposed = false;
  let latestLoad = 0;
  let latestLocale: UiLocale | undefined;
  let latestWasExplicitSelection = false;
  let fallbackRevision = 0;
  let storageAvailable = selectionStorage !== undefined;

  const nextFallbackRevision = () => {
    fallbackRevision = Math.max(Date.now(), fallbackRevision + 1);
    return fallbackRevision <= MAX_LOCALE_REVISION ? fallbackRevision : undefined;
  };

  const currentSelectionMatches = (message: SetLocaleMessage) => {
    if (!selectionStorage || !storageAvailable) return true;
    const current = readLocaleSelection(selectionStorage);
    if (current.kind === "unavailable") {
      storageAvailable = false;
      return true;
    }
    if (current.kind === "empty") return true;
    return (
      current.kind === "stored" &&
      current.selection.locale === message.locale &&
      current.selection.revision === message.revision
    );
  };

  const allocateRevision = (locale: UiLocale, hydration: boolean): Promise<number | undefined> => {
    if (!selectionStorage || !storageAvailable) return Promise.resolve(nextFallbackRevision());
    return withLocaleSelectionLock(() => {
      if (!selectionStorage || !storageAvailable) return nextFallbackRevision();
      const current = readLocaleSelection(selectionStorage);
      if (current.kind === "unavailable") {
        storageAvailable = false;
        return nextFallbackRevision();
      }
      if (hydration && current.kind === "stored") {
        return current.selection.locale === locale ? current.selection.revision : undefined;
      }

      const previousRevision = Math.max(
        current.kind === "stored" ? current.selection.revision : 0,
        fallbackRevision,
      );
      const revision = Math.max(Date.now(), previousRevision + 1);
      if (!Number.isSafeInteger(revision) || revision < 1 || revision > MAX_LOCALE_REVISION) {
        return undefined;
      }
      if (!writeLocaleSelection(selectionStorage, { locale, revision })) {
        storageAvailable = false;
        return nextFallbackRevision();
      }
      fallbackRevision = Math.max(fallbackRevision, revision);
      return revision;
    });
  };

  const postLocale = (worker = serviceWorker.controller ?? readyWorker) => {
    if (!disposed && loadedMessage && currentSelectionMatches(loadedMessage)) {
      worker?.postMessage(loadedMessage);
    }
  };
  const onControllerChange = () => postLocale();

  serviceWorker.addEventListener("controllerchange", onControllerChange);
  void serviceWorker.ready
    .then((registration) => {
      readyWorker = registration.active;
      postLocale();
    })
    .catch(() => undefined);

  const startLoad = (
    locale: UiLocale,
    revisionPromise: Promise<number | undefined>,
    explicitSelection: boolean,
  ) => {
    latestLocale = locale;
    latestWasExplicitSelection = explicitSelection;
    loadedMessage = undefined;
    const requestId = ++latestLoad;
    void revisionPromise
      .then(async (revision) => {
        if (
          revision === undefined ||
          disposed ||
          requestId !== latestLoad ||
          latestLocale !== locale
        ) {
          return;
        }
        const messages = await loadMessages(locale);
        if (
          disposed ||
          requestId !== latestLoad ||
          !currentSelectionMatches({
            type: "SET_LOCALE",
            locale,
            direction: "ltr",
            revision,
            catalogGeneration,
            messages,
          })
        ) {
          return;
        }
        const direction = SUPPORTED_UI_LOCALES.find((entry) => entry.tag === locale)!.direction;
        loadedMessage = createSetLocaleMessage(
          locale,
          messages,
          direction,
          revision,
          catalogGeneration,
        );
        postLocale();
      })
      .catch(() => {
        // Retain the worker's last durable catalog if this language chunk is unavailable.
      });
  };

  return {
    /** Allocates a new cross-tab revision before starting this selection's lazy catalog load. */
    sync(locale: UiLocale) {
      startLoad(locale, allocateRevision(locale, false), true);
    },
    /** Reuses the durable selection revision; stale hydration never creates a newer selection. */
    hydrate(locale: UiLocale) {
      if (latestWasExplicitSelection) return;
      if (loadedMessage?.locale === locale && currentSelectionMatches(loadedMessage)) {
        postLocale();
        return;
      }
      const currentLoad = latestLoad;
      void allocateRevision(locale, true)
        .then((revision) => {
          if (revision === undefined || disposed || latestLoad !== currentLoad) return;
          startLoad(locale, Promise.resolve(revision), false);
        })
        .catch(() => undefined);
    },
    dispose() {
      disposed = true;
      serviceWorker.removeEventListener("controllerchange", onControllerChange);
    },
  };
}
