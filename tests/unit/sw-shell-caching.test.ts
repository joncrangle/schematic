import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSetLocaleMessage } from "~/domain/localeWorkerMessage";
import { enWorkerMessages } from "~/domain/workerMessages/en";
import { frWorkerMessages } from "~/domain/workerMessages/fr";

/**
 * PWA service worker shell caching (src/sw.ts).
 *
 * The worker registers its event listeners against `self` at import time,
 * so every test stubs `self`/`caches`/`fetch` BEFORE dynamically importing
 * the module once, then dispatches synthetic worker events at the captured
 * listeners.
 */

type Listener = (event: unknown) => void;

const listeners = new Map<string, Listener>();
let localePutInterceptor: (() => Promise<void>) | undefined;

const skipWaiting = vi.fn(async () => {});
const clientsClaim = vi.fn(async () => {});
const openWindow = vi.fn();
const matchAll = vi.fn<
  (options?: { type?: string; includeUncontrolled?: boolean }) => Promise<readonly unknown[]>
>(async () => []);
const showNotification = vi.fn<(title: string, options?: Record<string, unknown>) => Promise<void>>(
  async () => {},
);

const fakeSelf = {
  addEventListener: vi.fn((type: string, listener: Listener) => {
    listeners.set(type, listener);
  }),
  clients: { claim: clientsClaim, matchAll, openWindow },
  registration: { showNotification },
  skipWaiting,
  location: {
    origin: "https://status.ttc.example",
    href: "https://status.ttc.example/sw.js",
  },
};

function makeCacheStore() {
  const stores = new Map<string, Map<string, Response>>();

  const toKey = (req: RequestInfo | URL): string =>
    typeof req === "string" ? req : req instanceof URL ? req.href : req.url;

  return {
    stores,
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (req: RequestInfo | URL): Promise<Response | undefined> => {
      const key = toKey(req);
      for (const store of stores.values()) {
        const hit = store.get(key);
        if (hit) return hit.clone();
      }
      return undefined;
    },
    open: async (name: string) => {
      let store = stores.get(name);
      if (!store) {
        store = new Map<string, Response>();
        stores.set(name, store);
      }
      return {
        addAll: async (urls: readonly string[]) => {
          for (const url of urls) store!.set(url, new Response(`cached ${url}`));
        },
        match: async (req: RequestInfo | URL) => store!.get(toKey(req))?.clone(),
        put: async (req: RequestInfo | URL, response: Response) => {
          if (toKey(req).endsWith("/__schematic-worker-locale__")) {
            await localePutInterceptor?.();
          }
          store!.set(toKey(req), response.clone());
        },
      };
    },
  };
}

let cachesStore: ReturnType<typeof makeCacheStore>;
const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>();
const SHELL_CACHE = "app-shell-v2";
const LOCALE_CACHE = "schematic-worker-preferences-v1";

vi.stubGlobal("self", fakeSelf);

beforeAll(async () => {
  // Register the worker's event listeners; side-effect import only.
  await import("../../src/sw");
});

beforeEach(() => {
  skipWaiting.mockClear();
  clientsClaim.mockClear();
  showNotification.mockClear();
  matchAll.mockReset();
  matchAll.mockResolvedValue([{ id: "controlled-page", url: fakeSelf.location.origin }]);
  fetchMock.mockReset();
  localePutInterceptor = undefined;

  cachesStore = makeCacheStore();
  vi.stubGlobal("caches", cachesStore);
  vi.stubGlobal("fetch", fetchMock);
});

function dispatchInstall(): Promise<unknown> {
  let captured!: Promise<unknown>;
  listeners.get("install")!({
    waitUntil: (p: Promise<unknown>) => {
      captured = p;
    },
  });
  return captured;
}

function dispatchActivate(): Promise<unknown> {
  let captured!: Promise<unknown>;
  listeners.get("activate")!({
    waitUntil: (p: Promise<unknown>) => {
      captured = p;
    },
  });
  return captured;
}

function dispatchMessage(data: unknown): Promise<unknown> {
  let captured!: Promise<unknown>;
  listeners.get("message")!({
    data,
    source: { id: "controlled-page", url: fakeSelf.location.origin + "/" },
    waitUntil: (p: Promise<unknown>) => {
      captured = p;
    },
  });
  return captured ?? Promise.resolve();
}

function dispatchFetch(request: {
  url: string;
  method?: string;
  mode?: string;
}): Response | Promise<Response> | undefined {
  let responded: Response | Promise<Response> | undefined;
  listeners.get("fetch")!({
    request: request as unknown as Request,
    mode: request.mode,
    respondWith: (r: Response | Promise<Response>) => {
      responded = r;
    },
  });
  return responded;
}

describe("service worker shell caching", () => {
  it("uses an added locale catalog after worker restart without a locale-specific worker", async () => {
    await dispatchMessage({
      type: "SET_LOCALE",
      locale: "ar-EG",
      direction: "rtl",
      revision: 20,
      messages: { ...frWorkerMessages, offlineHeading: "حالة النقل <script>unsafe</script>" },
    });
    await dispatchActivate();
    vi.resetModules();
    await import("../../src/sw");
    await dispatchMessage({
      ...createSetLocaleMessage("fr-CA", frWorkerMessages, "ltr", 19),
    });
    fetchMock.mockRejectedValue(new TypeError("network down"));
    const response = await dispatchFetch({
      url: fakeSelf.location.origin + "/",
      method: "GET",
      mode: "navigate",
    })!;
    const page = await response.text();
    expect(page).toContain('<html lang="ar-EG" dir="rtl">');
    expect(page).toContain("حالة النقل &lt;script&gt;unsafe&lt;/script&gt;");
    expect(page).not.toContain("<script>");
  });

  it("retains its catalog when a message is invalid, oversized, or from an uncontrolled client", async () => {
    await dispatchMessage(createSetLocaleMessage("fr-CA", frWorkerMessages, "ltr", 1));
    await dispatchMessage({
      type: "SET_LOCALE",
      locale: "en-CA",
      direction: "ltr",
      messages: { ...enWorkerMessages, offlineHeading: "x".repeat(4097) },
    });
    await dispatchMessage({ type: "SET_LOCALE", locale: "en-CA", direction: "ltr", messages: {} });
    await dispatchMessage({
      ...createSetLocaleMessage("en-CA", enWorkerMessages, "ltr", Number.MAX_SAFE_INTEGER + 1),
    });
    await dispatchMessage({ ...createSetLocaleMessage("en-CA", enWorkerMessages, "ltr", 1.5) });
    await dispatchMessage({
      ...createSetLocaleMessage("en-CA", enWorkerMessages, "ltr", 2, Number.MAX_SAFE_INTEGER + 1),
    });
    await dispatchMessage({ ...createSetLocaleMessage("en-CA", enWorkerMessages, "ltr", 2, 1.5) });
    matchAll.mockResolvedValue([]);
    await dispatchMessage(createSetLocaleMessage("en-CA", enWorkerMessages, "ltr", 2));
    fetchMock.mockRejectedValue(new TypeError("network down"));
    const response = await dispatchFetch({
      url: fakeSelf.location.origin + "/api/alerts",
      method: "GET",
    })!;
    expect(response.headers.get("Content-Language")).toBe("fr-CA");
    await expect(response.json()).resolves.toMatchObject({ error: "Hors ligne" });
  });

  it("precaches the app shell into the versioned cache on install", async () => {
    await dispatchInstall();

    expect(skipWaiting).toHaveBeenCalledOnce();
    const shell = cachesStore.stores.get(SHELL_CACHE)!;
    const shellKeys = [...shell.keys()];
    // Pin the load-bearing shell entries without freezing the asset list —
    // icons and manifests legitimately change with design edits.
    expect(shellKeys).toContain("/");
    expect(shellKeys).toContain("/site.webmanifest");
  });

  it("purges outdated caches on activate and claims open clients", async () => {
    await dispatchInstall();
    cachesStore.stores.set("legacy-shell-v0", new Map([["/", new Response("old shell")]]));
    cachesStore.stores.set(
      LOCALE_CACHE,
      new Map([["catalog", Response.json({ locale: "fr-CA" })]]),
    );

    await dispatchActivate();

    await expect(cachesStore.keys()).resolves.toEqual([SHELL_CACHE, LOCALE_CACHE]);
    expect(clientsClaim).toHaveBeenCalledOnce();
  });

  it("swallows a precache failure and still activates", async () => {
    const cache = await cachesStore.open(SHELL_CACHE);
    cache.addAll = async () => {
      throw new Error("partial precache unavailable");
    };

    await expect(dispatchInstall()).resolves.toBeUndefined();
    expect(skipWaiting).toHaveBeenCalledOnce();
  });

  it("serves navigations network-first and refreshes the cached shell", async () => {
    await dispatchInstall();
    const networkResponse = new Response("<html>fresh</html>", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
    fetchMock.mockResolvedValue(networkResponse);

    const responded = dispatchFetch({
      url: "https://status.ttc.example/",
      method: "GET",
      mode: "navigate",
    }) as Promise<Response>;

    await expect(responded).resolves.toBe(networkResponse);
    const cachedShell = await cachesStore.match("/");
    expect(await cachedShell?.text()).toBe("<html>fresh</html>");
  });

  it.each([
    ["an API document", "https://status.ttc.example/api/snapshot/sample", "application/json"],
    [
      "the web manifest",
      "https://status.ttc.example/site.webmanifest",
      "application/manifest+json",
    ],
    ["a non-HTML root response", "https://status.ttc.example/", "application/json"],
    ["an HTML page other than the root", "https://status.ttc.example/other", "text/html"],
    ["another origin's root", "https://elsewhere.example/", "text/html"],
  ])("keeps the cached shell when a navigation loads %s", async (_label, url, contentType) => {
    const cache = await cachesStore.open(SHELL_CACHE);
    await cache.put("/", new Response("cached shell"));
    const networkResponse = new Response("not the shell", {
      status: 200,
      headers: { "Content-Type": contentType },
    });
    fetchMock.mockResolvedValue(networkResponse);

    const responded = dispatchFetch({ url, method: "GET", mode: "navigate" }) as Promise<Response>;

    await expect(responded).resolves.toBe(networkResponse);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const cachedShell = await cachesStore.match("/");
    expect(await cachedShell?.text()).toBe("cached shell");
  });

  it("does not cache a non-OK navigation response", async () => {
    fetchMock.mockResolvedValue(new Response("not found", { status: 404 }));

    await dispatchFetch({
      url: "https://status.ttc.example/missing",
      method: "GET",
      mode: "navigate",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await cachesStore.match("/")).toBeUndefined();
  });

  it("falls back to the cached shell when a navigation goes offline", async () => {
    await dispatchInstall();
    const cache = await cachesStore.open(SHELL_CACHE);
    await cache.put("/", new Response("cached shell"));
    fetchMock.mockRejectedValue(new TypeError("network down"));

    const responded = dispatchFetch({
      url: "https://status.ttc.example/some-route",
      method: "GET",
      mode: "navigate",
    }) as Promise<Response>;

    await expect((await responded).text()).resolves.toBe("cached shell");
  });

  it("renders the inline offline page when no shell is cached", async () => {
    fetchMock.mockRejectedValue(new TypeError("network down"));

    const responded = dispatchFetch({
      url: "https://status.ttc.example/",
      method: "GET",
      mode: "navigate",
    }) as Promise<Response>;

    await expect((await responded).text()).resolves.toContain(
      "Unable to retrieve live transit status",
    );
  });

  it("persists a validated French locale across worker events and localizes the offline page", async () => {
    await dispatchMessage(createSetLocaleMessage("fr-CA", frWorkerMessages, "ltr", 1));
    await dispatchMessage({ type: "SET_LOCALE", locale: "de-DE" });
    fetchMock.mockRejectedValue(new TypeError("network down"));

    const responded = dispatchFetch({
      url: "https://status.ttc.example/some-route",
      method: "GET",
      mode: "navigate",
    }) as Promise<Response>;
    const page = await (await responded).text();

    expect(page).toContain('<html lang="fr-CA" dir="ltr">');
    expect(page).toContain("Impossible de récupérer l’état du transport en direct");
    const saved = await cachesStore.match("https://status.ttc.example/__schematic-worker-locale__");
    await expect(saved?.json()).resolves.toMatchObject({
      locale: "fr-CA",
      messages: frWorkerMessages,
    });
    expect(cachesStore.stores.has(LOCALE_CACHE)).toBe(true);
  });

  it("serializes rapid locale writes so the latest preference wins", async () => {
    let releaseFirstWrite!: () => void;
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let writeCount = 0;
    localePutInterceptor = async () => {
      writeCount += 1;
      if (writeCount === 1) await firstWriteBlocked;
    };

    const frenchWrite = dispatchMessage(
      createSetLocaleMessage("fr-CA", frWorkerMessages, "ltr", 1),
    );
    await vi.waitFor(() => expect(writeCount).toBe(1));
    const englishWrite = dispatchMessage(
      createSetLocaleMessage("en-CA", enWorkerMessages, "ltr", 2),
    );
    await Promise.resolve();
    expect(writeCount).toBe(1);

    releaseFirstWrite();
    await Promise.all([frenchWrite, englishWrite]);

    const saved = await cachesStore.match("https://status.ttc.example/__schematic-worker-locale__");
    await expect(saved?.json()).resolves.toMatchObject({
      locale: "en-CA",
      messages: enWorkerMessages,
    });
    expect(writeCount).toBe(2);
  });

  it("refreshes the same locale at an equal revision and rejects an equal-revision locale change", async () => {
    const originalFrench = createSetLocaleMessage("fr-CA", frWorkerMessages, "ltr", 7);
    const refreshedFrench = createSetLocaleMessage(
      "fr-CA",
      { ...frWorkerMessages, offlineHeading: "Catalog refreshed" },
      "ltr",
      7,
    );
    await dispatchMessage(originalFrench);
    await dispatchMessage(createSetLocaleMessage("en-CA", enWorkerMessages, "ltr", 7));
    await dispatchMessage(refreshedFrench);
    fetchMock.mockRejectedValue(new TypeError("network down"));

    const response = await dispatchFetch({
      url: "https://status.ttc.example/",
      method: "GET",
      mode: "navigate",
    })!;
    expect(await response.text()).toContain("Catalog refreshed");
  });

  it("keeps a newer build's catalog when an old page replays the same selection after restart", async () => {
    const oldBuildMessages = { ...frWorkerMessages, offlineHeading: "French from build A" };
    const currentBuildMessages = { ...frWorkerMessages, offlineHeading: "French from build B" };
    const oldCatalog = createSetLocaleMessage("fr-CA", oldBuildMessages, "ltr", 17, 100);
    const currentCatalog = createSetLocaleMessage("fr-CA", currentBuildMessages, "ltr", 17, 101);

    await dispatchMessage(oldCatalog);
    await dispatchMessage(currentCatalog);
    await dispatchActivate();
    vi.resetModules();
    await import("../../src/sw");
    await dispatchMessage(oldCatalog);
    fetchMock.mockRejectedValue(new TypeError("network down"));

    const response = await dispatchFetch({
      url: "https://status.ttc.example/",
      method: "GET",
      mode: "navigate",
    })!;
    expect(await response.text()).toContain("French from build B");
  });

  it("reads a legacy durable catalog without a revision as generation zero", async () => {
    const cache = await cachesStore.open(LOCALE_CACHE);
    await cache.put(
      "https://status.ttc.example/__schematic-worker-locale__",
      Response.json({
        type: "SET_LOCALE",
        locale: "ar-EG",
        direction: "rtl",
        messages: { ...frWorkerMessages, offlineHeading: "لغة محفوظة" },
      }),
    );
    vi.resetModules();
    await import("../../src/sw");
    await dispatchMessage(createSetLocaleMessage("fr-CA", frWorkerMessages, "ltr", 0));
    fetchMock.mockRejectedValue(new TypeError("network down"));

    const response = await dispatchFetch({
      url: "https://status.ttc.example/",
      method: "GET",
      mode: "navigate",
    })!;
    const page = await response.text();
    expect(page).toContain('<html lang="ar-EG" dir="rtl">');
    expect(page).toContain("لغة محفوظة");
  });

  it("localizes offline API responses from the persisted worker locale", async () => {
    await dispatchMessage(createSetLocaleMessage("fr-CA", frWorkerMessages, "ltr", 1));
    fetchMock.mockRejectedValue(new TypeError("network down"));

    const responded = dispatchFetch({
      url: "https://status.ttc.example/api/alerts",
      method: "GET",
    }) as Promise<Response>;
    const response = await responded;

    expect(response.headers.get("Content-Language")).toBe("fr-CA");
    await expect(response.json()).resolves.toMatchObject({
      error: "Hors ligne",
      message: expect.stringContaining("Impossible de récupérer"),
    });
  });

  it("serves same-origin static assets cache-first while revalidating in the background", async () => {
    await dispatchInstall();
    const cache = await cachesStore.open(SHELL_CACHE);
    // Entries are keyed by the request URL as received
    await cache.put("https://status.ttc.example/assets/app.js", new Response("bundled js"));
    fetchMock.mockResolvedValue(new Response("network js", { status: 200 }));

    const responded = dispatchFetch({
      url: "https://status.ttc.example/assets/app.js",
      method: "GET",
    }) as Promise<Response>;

    // The cached copy answers immediately; the network refresh races behind it
    await expect((await responded).text()).resolves.toBe("bundled js");
    expect(fetchMock).toHaveBeenCalledOnce();

    await new Promise((resolve) => setTimeout(resolve, 0));
    const revalidated = await cachesStore.match("https://status.ttc.example/assets/app.js");
    await expect(revalidated?.text()).resolves.toBe("network js");
  });

  it("revalidates static assets over the network on a cache miss", async () => {
    await dispatchInstall();
    fetchMock.mockResolvedValue(new Response("network js", { status: 200 }));

    const responded = dispatchFetch({
      url: "https://status.ttc.example/assets/chunk-abc.js",
      method: "GET",
    }) as Promise<Response>;

    await expect((await responded).text()).resolves.toBe("network js");
    expect(fetchMock).toHaveBeenCalledOnce();

    // The cache write is fire-and-forget behind the returned response; keys
    // are the absolute request URLs.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const revalidated = await cachesStore.match("https://status.ttc.example/assets/chunk-abc.js");
    await expect(revalidated?.text()).resolves.toBe("network js");
  });

  it("rejects a static asset when neither cache nor network can provide it", async () => {
    fetchMock.mockRejectedValue(new TypeError("network down"));

    const response = dispatchFetch({
      url: "https://status.ttc.example/assets/missing.js",
      method: "GET",
    }) as Promise<Response>;
    await expect(response).resolves.toBeUndefined();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("ignores locale messages without a same-origin source and source id", async () => {
    const message = createSetLocaleMessage("fr-CA", frWorkerMessages, "ltr", 5);
    const send = (source?: { id?: string; url?: string }) => {
      let captured: Promise<unknown> | undefined;
      listeners.get("message")!({
        data: message,
        source,
        waitUntil: (promise: Promise<unknown>) => {
          captured = promise;
        },
      });
      return captured ?? Promise.resolve();
    };

    await send({ id: "foreign", url: "https://other.example/" });
    await send({ url: fakeSelf.location.origin + "/" });

    expect(cachesStore.stores.has(LOCALE_CACHE)).toBe(false);
    expect(matchAll).not.toHaveBeenCalled();
  });

  it("bypasses interception for non-GET requests and local development traffic", () => {
    expect(
      dispatchFetch({ url: "https://status.ttc.example/api/status", method: "POST" }),
    ).toBeUndefined();

    expect(
      dispatchFetch({ url: "http://localhost:3000/assets/app.js", method: "GET" }),
    ).toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function dispatchPush(data?: { json: () => unknown; text: () => string }): Promise<unknown> {
  let captured!: Promise<unknown>;
  listeners.get("push")!({
    data,
    waitUntil: (p: Promise<unknown>) => {
      captured = p;
    },
  });
  return captured;
}

interface TestWindowClient {
  readonly url: string;
  readonly focus: ReturnType<typeof vi.fn<() => Promise<TestWindowClient>>>;
  readonly navigate: ReturnType<typeof vi.fn<() => Promise<TestWindowClient | null>>>;
  readonly postMessage: (message: unknown) => void;
}

function makeWindowClient(postMessage: (message: unknown) => void): TestWindowClient {
  return {
    url: "https://status.ttc.example/",
    focus: vi.fn<() => Promise<TestWindowClient>>(async () => makeWindowClient(postMessage)),
    navigate: vi.fn<() => Promise<TestWindowClient | null>>(async () => null),
    postMessage,
  };
}

function dispatchNotificationClick(data?: unknown): Promise<unknown> {
  let captured!: Promise<unknown>;
  listeners.get("notificationclick")!({
    notification: { close: vi.fn(), data },
    waitUntil: (promise: Promise<unknown>) => {
      captured = promise;
    },
  });
  return captured;
}

describe("service worker push-unreadable heal signal", () => {
  it("shows the fallback notification AND signals every matched window client when a push arrives without data", async () => {
    const postMessageA = vi.fn();
    const postMessageB = vi.fn();
    const clientA = makeWindowClient(postMessageA);
    const clientB = makeWindowClient(postMessageB);
    matchAll.mockResolvedValue([clientA, clientB]);

    const handled = dispatchPush(undefined);
    await handled;

    expect(showNotification).toHaveBeenCalledOnce();
    expect(showNotification).toHaveBeenCalledWith(
      "🚨 Transit Status",
      expect.objectContaining({
        body: "A transit alert was received.",
        tag: "transit-push-no-data",
      }),
    );

    expect(matchAll).toHaveBeenCalledTimes(1);
    expect(matchAll).toHaveBeenCalledWith({ type: "window", includeUncontrolled: true });
    expect(clientA.postMessage).toHaveBeenCalledTimes(1);
    expect(clientA.postMessage).toHaveBeenCalledWith({ type: "push-unreadable" });
    expect(clientB.postMessage).toHaveBeenCalledTimes(1);
    expect(clientB.postMessage).toHaveBeenCalledWith({ type: "push-unreadable" });
  });

  it("does not broadcast the heal signal when push data parses normally", async () => {
    const postMessage = vi.fn();
    const clientA = makeWindowClient(postMessage);
    matchAll.mockResolvedValue([clientA]);

    const handled = dispatchPush({
      json: () => ({ title: "Disruption", body: "Line 1 down", tag: "transit-alert" }),
      text: () => '{"title":"Disruption"}',
    });
    await handled;

    expect(showNotification).toHaveBeenCalledOnce();
    expect(matchAll).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("uses the persisted locale for readable generic push defaults", async () => {
    await dispatchMessage(createSetLocaleMessage("fr-CA", frWorkerMessages, "ltr", 1));
    await dispatchPush({ json: () => ({}), text: () => "{}" });

    expect(showNotification).toHaveBeenCalledWith(
      "🚨 Perturbation du service de transport",
      expect.objectContaining({ body: "Une perturbation majeure affecte votre trajet." }),
    );
  });

  it("preserves the English malformed-payload fallback even with a saved French locale", async () => {
    await dispatchMessage(createSetLocaleMessage("fr-CA", frWorkerMessages, "ltr", 1));
    await dispatchPush({
      json: () => {
        throw new Error("undecryptable");
      },
      text: () => "not-json",
    });

    expect(showNotification).toHaveBeenCalledWith(
      "Transit Alert",
      expect.objectContaining({ body: "not-json" }),
    );
  });

  it("uses the English unreadable-payload fallback when the raw body cannot be read", async () => {
    await dispatchMessage(createSetLocaleMessage("fr-CA", frWorkerMessages, "ltr", 1));
    await dispatchPush({
      json: () => {
        throw new Error("undecryptable");
      },
      text: () => {
        throw new Error("body unavailable");
      },
    });

    expect(showNotification).toHaveBeenCalledWith(
      "🚨 Transit Status",
      expect.objectContaining({ body: "A transit alert was received." }),
    );
  });

  it("still shows the fallback notification when the client broadcast fails", async () => {
    matchAll.mockRejectedValue(new Error("clients unavailable"));

    const handled = dispatchPush(undefined);
    await handled;

    expect(showNotification).toHaveBeenCalledOnce();
    expect(showNotification).toHaveBeenCalledWith(
      "🚨 Transit Status",
      expect.objectContaining({ tag: "transit-push-no-data" }),
    );
  });
});

describe("service worker notification clicks", () => {
  it("awaits navigation and focuses the navigated client", async () => {
    let releaseNavigation!: (client: TestWindowClient) => void;
    const navigated = makeWindowClient(vi.fn());
    const navigation = new Promise<TestWindowClient | null>((resolve) => {
      releaseNavigation = resolve;
    });
    const client = makeWindowClient(vi.fn());
    client.navigate.mockImplementation(() => navigation);
    matchAll.mockResolvedValue([client]);

    const handled = dispatchNotificationClick({ url: "/alerts" });
    expect(client.focus).not.toHaveBeenCalled();
    releaseNavigation(navigated);
    await handled;

    expect(client.navigate).toHaveBeenCalledWith("/alerts");
    expect(navigated.focus).toHaveBeenCalledOnce();
    expect(client.focus).not.toHaveBeenCalled();
  });

  it.each(["reject", "null"])(
    "opens the notification URL when navigation returns %s",
    async (failure) => {
      const client = makeWindowClient(vi.fn());
      if (failure === "reject") client.navigate.mockRejectedValue(new Error("navigation failed"));
      else client.navigate.mockResolvedValue(null);
      matchAll.mockResolvedValue([client]);
      openWindow.mockResolvedValue(null);

      await dispatchNotificationClick({ url: "/alerts" });

      expect(openWindow).toHaveBeenCalledWith("/alerts");
      expect(client.focus).not.toHaveBeenCalled();
    },
  );

  it("opens a new window when no existing same-origin client is available", async () => {
    matchAll.mockResolvedValue([]);
    openWindow.mockResolvedValue(null);

    await dispatchNotificationClick({ url: "/" });

    expect(openWindow).toHaveBeenCalledWith("/");
  });
});

it("removes a previous build's hashed assets when a new generation activates", async () => {
  try {
    vi.stubGlobal("__SCHEMATIC_SW_BUILD_GENERATION__", "build-a");
    vi.resetModules();
    await import("../../src/sw");
    await dispatchInstall();
    const oldCache = await cachesStore.open("app-shell-build-a");
    await oldCache.put("/assets/old-hash.js", new Response("old asset"));
    cachesStore.stores.set(LOCALE_CACHE, new Map([["locale", new Response("fr-CA")]]));

    vi.stubGlobal("__SCHEMATIC_SW_BUILD_GENERATION__", "build-b");
    vi.resetModules();
    await import("../../src/sw");
    await dispatchInstall();
    await dispatchActivate();

    expect(await cachesStore.keys()).toEqual([LOCALE_CACHE, "app-shell-build-b"]);
    expect(await cachesStore.match("/assets/old-hash.js")).toBeUndefined();
    expect(await (await cachesStore.match("locale"))?.text()).toBe("fr-CA");
  } finally {
    vi.stubGlobal("__SCHEMATIC_SW_BUILD_GENERATION__", undefined);
    vi.resetModules();
    await import("../../src/sw");
  }
});
