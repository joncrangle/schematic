// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createServiceWorkerLocaleSync,
  SERVICE_WORKER_LOCALE_SELECTION_KEY,
} from "~/lib/serviceWorkerLocaleSync";
import { frWorkerMessages } from "~/domain/workerMessages/fr";
import { enWorkerMessages } from "~/domain/workerMessages/en";
import type { WorkerMessages } from "~/domain/localeWorkerMessage";
import { createSetLocaleMessage } from "~/domain/localeWorkerMessage";

afterEach(() => {
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
});

function memorySelectionStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("service worker locale synchronization", () => {
  it("replays to an active registration when it becomes ready before the catalog", async () => {
    const postMessage = vi.fn();
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        controller: null,
        ready: Promise.resolve({ active: { postMessage } }),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    let resolveCatalog!: (messages: WorkerMessages) => void;
    const localeSync = createServiceWorkerLocaleSync(
      () =>
        new Promise((resolve) => {
          resolveCatalog = resolve;
        }),
    );
    localeSync.sync("fr-CA");
    await Promise.resolve();
    expect(postMessage).not.toHaveBeenCalled();
    resolveCatalog(frWorkerMessages);
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          ...createSetLocaleMessage("fr-CA", frWorkerMessages, "ltr", 1),
          revision: expect.any(Number),
        }),
      ),
    );
    localeSync.dispose();
  });

  it("does not send a delayed catalog after a newer locale is selected", async () => {
    const postMessage = vi.fn();
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        controller: { postMessage },
        ready: new Promise(() => {}),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    let resolveFrench!: (messages: WorkerMessages) => void;
    const localeSync = createServiceWorkerLocaleSync((locale) =>
      locale === "fr-CA"
        ? new Promise((resolve) => {
            resolveFrench = resolve;
          })
        : Promise.resolve(enWorkerMessages),
    );
    localeSync.sync("fr-CA");
    await vi.waitFor(() => expect(resolveFrench).toBeTypeOf("function"));
    localeSync.sync("en-CA");
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
    resolveFrench(frWorkerMessages);
    await Promise.resolve();
    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        ...createSetLocaleMessage("en-CA", enWorkerMessages, "ltr", 1),
        revision: expect.any(Number),
      }),
    );
    localeSync.dispose();
  });

  it("orders selections across tabs and ignores stale hydration and catalogs", async () => {
    const postMessage = vi.fn();
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        controller: { postMessage },
        ready: new Promise(() => {}),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    const sharedStorage = memorySelectionStorage();
    let resolveFirstFrench!: (messages: WorkerMessages) => void;
    let frenchLoads = 0;
    const loadMessages = (locale: string) => {
      if (locale === "fr-CA") {
        frenchLoads += 1;
        if (frenchLoads === 1) {
          return new Promise<WorkerMessages>((resolve) => {
            resolveFirstFrench = resolve;
          });
        }
        return Promise.resolve(frWorkerMessages);
      }
      return Promise.resolve(enWorkerMessages);
    };
    const firstTab = createServiceWorkerLocaleSync(loadMessages, sharedStorage);
    const secondTab = createServiceWorkerLocaleSync(loadMessages, sharedStorage);
    const staleHydration = createServiceWorkerLocaleSync(loadMessages, sharedStorage);

    firstTab.sync("fr-CA");
    await vi.waitFor(() => expect(frenchLoads).toBe(1));
    secondTab.sync("fr-CA");
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
    secondTab.sync("en-CA");
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
    const englishMessage = postMessage.mock.calls[1]![0];
    expect(englishMessage).toMatchObject({ locale: "en-CA", revision: expect.any(Number) });

    staleHydration.hydrate("fr-CA");
    resolveFirstFrench(frWorkerMessages);
    await Promise.resolve();
    await Promise.resolve();

    expect(frenchLoads).toBe(2);
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenLastCalledWith(englishMessage);
    const selection = JSON.parse(sharedStorage.getItem(SERVICE_WORKER_LOCALE_SELECTION_KEY)!) as {
      locale: string;
      revision: number;
    };
    expect(selection).toEqual({ locale: "en-CA", revision: englishMessage.revision });

    firstTab.dispose();
    secondTab.dispose();
    staleHydration.dispose();
  });

  it("tags same-selection catalogs with the page build that loaded them", async () => {
    const postMessage = vi.fn();
    const controllerListeners: EventListener[] = [];
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        controller: { postMessage },
        ready: new Promise(() => {}),
        addEventListener: vi.fn((_type: string, listener: EventListener) => {
          controllerListeners.push(listener);
        }),
        removeEventListener: vi.fn(),
      },
    });
    const sharedStorage = memorySelectionStorage();
    const oldBuildMessages = { ...frWorkerMessages, offlineHeading: "French from build A" };
    const currentBuildMessages = { ...frWorkerMessages, offlineHeading: "French from build B" };
    const oldPage = createServiceWorkerLocaleSync(async () => oldBuildMessages, sharedStorage, 100);
    const currentPage = createServiceWorkerLocaleSync(
      async () => currentBuildMessages,
      sharedStorage,
      101,
    );

    oldPage.sync("fr-CA");
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
    const oldCatalog = postMessage.mock.calls[0]![0] as {
      revision: number;
      catalogGeneration: number;
    };
    currentPage.hydrate("fr-CA");
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
    const currentCatalog = postMessage.mock.calls[1]![0] as {
      revision: number;
      catalogGeneration: number;
    };

    controllerListeners[0]!(new Event("controllerchange"));

    expect(currentCatalog.revision).toBe(oldCatalog.revision);
    expect(currentCatalog.catalogGeneration).toBe(101);
    expect(oldCatalog.catalogGeneration).toBe(100);
    expect(postMessage.mock.calls[2]![0]).toEqual(oldCatalog);

    oldPage.dispose();
    currentPage.dispose();
  });

  it("increments same-millisecond selections through the shared revision", async () => {
    const postMessage = vi.fn();
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        controller: { postMessage },
        ready: new Promise(() => {}),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    const sharedStorage = memorySelectionStorage();
    const localeSync = createServiceWorkerLocaleSync(
      async (locale) => (locale === "fr-CA" ? frWorkerMessages : enWorkerMessages),
      sharedStorage,
    );
    const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);

    localeSync.sync("fr-CA");
    localeSync.sync("en-CA");
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());

    const message = postMessage.mock.calls[0]![0] as { revision: number };
    expect(message.revision).toBe(1_800_000_000_001);
    now.mockRestore();
    localeSync.dispose();
  });

  it("keeps syncing when shared selection storage is unavailable", async () => {
    const postMessage = vi.fn();
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        controller: { postMessage },
        ready: new Promise(() => {}),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    const unavailableStorage = {
      getItem: () => {
        throw new Error("storage unavailable");
      },
      setItem: () => {
        throw new Error("storage unavailable");
      },
    };
    const localeSync = createServiceWorkerLocaleSync(
      async () => frWorkerMessages,
      unavailableStorage,
    );

    localeSync.sync("fr-CA");
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
    expect(postMessage.mock.calls[0]![0]).toMatchObject({
      locale: "fr-CA",
      revision: expect.any(Number),
    });
    localeSync.dispose();
  });

  it("falls back to local revision storage when the Web Lock request is rejected", async () => {
    const postMessage = vi.fn();
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        controller: { postMessage },
        ready: new Promise(() => {}),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request: () => Promise.reject(new Error("lock unavailable")) },
    });
    const sharedStorage = memorySelectionStorage();
    const localeSync = createServiceWorkerLocaleSync(async () => frWorkerMessages, sharedStorage);

    try {
      localeSync.sync("fr-CA");
      await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
      expect(JSON.parse(sharedStorage.getItem(SERVICE_WORKER_LOCALE_SELECTION_KEY)!)).toMatchObject(
        {
          locale: "fr-CA",
          revision: expect.any(Number),
        },
      );
    } finally {
      localeSync.dispose();
      if (originalLocks) Object.defineProperty(navigator, "locks", originalLocks);
      else delete (navigator as unknown as Record<string, unknown>).locks;
    }
  });

  it("waits for the hydrated preference and replays it to a replacement controller", async () => {
    const listeners = new Map<string, EventListener>();
    const firstController = { postMessage: vi.fn() };
    const replacementController = { postMessage: vi.fn() };
    let controller: typeof firstController | typeof replacementController = firstController;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        get controller() {
          return controller;
        },
        ready: new Promise(() => {}),
        addEventListener: vi.fn((type: string, listener: EventListener) => {
          listeners.set(type, listener);
        }),
        removeEventListener: vi.fn((type: string) => listeners.delete(type)),
      },
    });

    const localeSync = createServiceWorkerLocaleSync();
    expect(firstController.postMessage).not.toHaveBeenCalled();
    localeSync.sync("fr-CA");
    await vi.waitFor(() =>
      expect(firstController.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          ...createSetLocaleMessage("fr-CA", frWorkerMessages, "ltr", 1),
          revision: expect.any(Number),
        }),
      ),
    );
    const firstMessage = firstController.postMessage.mock.calls[0]![0];

    controller = replacementController;
    listeners.get("controllerchange")?.(new Event("controllerchange"));
    expect(replacementController.postMessage).toHaveBeenCalledWith(firstMessage);

    localeSync.dispose();
    listeners.get("controllerchange")?.(new Event("controllerchange"));
    expect(replacementController.postMessage).toHaveBeenCalledOnce();
  });
});
