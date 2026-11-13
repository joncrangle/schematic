/* eslint-disable no-restricted-globals */

import { DEFAULT_UI_LOCALE } from "~/domain/locale";
import { ENGLISH_UNREADABLE_PUSH_FALLBACK, enWorkerMessages } from "~/domain/workerMessages/en";
import {
  readSetLocaleMessage,
  SET_LOCALE_MESSAGE_TYPE,
  type SetLocaleMessage,
} from "~/domain/localeWorkerMessage";

// Schematic, Hand-Rolled PWA Service Worker Shell Cache & Push Handler

interface WorkerWindowClient {
  readonly id: string;
  readonly url: string;
  readonly focus: () => Promise<WorkerWindowClient>;
  readonly navigate: (url: string) => Promise<WorkerWindowClient | null>;
  readonly postMessage: (message: unknown) => void;
}

interface WorkerClients {
  readonly claim: () => Promise<void>;
  readonly matchAll: (options?: {
    type?: "window" | "worker" | "sharedworker" | "all";
    includeUncontrolled?: boolean;
  }) => Promise<readonly WorkerWindowClient[]>;
  readonly openWindow?: (url: string) => Promise<WorkerWindowClient | null>;
}

interface WorkerInstallEvent {
  readonly waitUntil: (p: Promise<unknown>) => void;
}

interface WorkerActivateEvent {
  readonly waitUntil: (p: Promise<unknown>) => void;
}

interface WorkerFetchEvent {
  readonly request: Request;
  readonly mode?: string;
  readonly respondWith: (r: Response | Promise<Response>) => void;
}

interface WorkerPushEvent {
  readonly data?: { readonly json: () => unknown; readonly text: () => string };
  readonly waitUntil: (p: Promise<unknown>) => void;
}

interface WorkerMessageEvent {
  readonly data?: unknown;
  readonly source?: { readonly id?: string; readonly url?: string };
  readonly waitUntil: (p: Promise<unknown>) => void;
}

interface WorkerNotificationClickEvent {
  readonly notification: { readonly close: () => void; readonly data?: unknown };
  readonly waitUntil: (p: Promise<unknown>) => void;
}

interface WorkerGlobal {
  readonly addEventListener: {
    (type: "install", listener: (event: WorkerInstallEvent) => void): void;
    (type: "activate", listener: (event: WorkerActivateEvent) => void): void;
    (type: "fetch", listener: (event: WorkerFetchEvent) => void): void;
    (type: "push", listener: (event: WorkerPushEvent) => void): void;
    (type: "message", listener: (event: WorkerMessageEvent) => void): void;
    (type: "notificationclick", listener: (event: WorkerNotificationClickEvent) => void): void;
  };
  readonly clients: WorkerClients;
  readonly registration: {
    readonly showNotification: (title: string, options?: Record<string, unknown>) => Promise<void>;
  };
  readonly skipWaiting: () => Promise<void>;
  readonly location: { readonly origin: string; readonly href: string };
}

const sw = self as unknown as WorkerGlobal;
const isDevelopmentWorker = new URL(sw.location.href).searchParams.get("mode") === "dev";
declare const __SCHEMATIC_SW_BUILD_GENERATION__: string | undefined;
const buildGeneration =
  typeof __SCHEMATIC_SW_BUILD_GENERATION__ === "string" ? __SCHEMATIC_SW_BUILD_GENERATION__ : "v2";

// Every app build gets a new generation, including builds where only app
// assets changed. Activation removes the previous generation's shell cache.
const CACHE_NAME = `app-shell-${buildGeneration}`;
const LOCALE_CACHE_NAME = "schematic-worker-preferences-v1";
const LOCALE_CACHE_KEY = "/__schematic-worker-locale__";
let localeWriteQueue: Promise<void> = Promise.resolve();
const defaultWorkerCatalog: SetLocaleMessage = {
  type: SET_LOCALE_MESSAGE_TYPE,
  locale: DEFAULT_UI_LOCALE,
  direction: "ltr",
  revision: 0,
  catalogGeneration: 0,
  messages: enWorkerMessages,
};

function localeCacheRequest(): Request {
  return new Request(new URL(LOCALE_CACHE_KEY, sw.location.origin));
}

async function readCachedCatalog(): Promise<SetLocaleMessage> {
  try {
    const cache = await caches.open(LOCALE_CACHE_NAME);
    const response = await cache.match(localeCacheRequest());
    return (
      readSetLocaleMessage(response ? await response.json() : undefined) ?? defaultWorkerCatalog
    );
  } catch {
    return defaultWorkerCatalog;
  }
}

async function readPersistedCatalog(): Promise<SetLocaleMessage> {
  await localeWriteQueue.catch(() => undefined);
  return readCachedCatalog();
}

async function persistCatalog(message: SetLocaleMessage): Promise<void> {
  const cache = await caches.open(LOCALE_CACHE_NAME);
  await cache.put(localeCacheRequest(), Response.json(message));
}

function queueLocalePersistence(message: SetLocaleMessage, sourceId: string): Promise<void> {
  const write = localeWriteQueue
    .catch(() => undefined)
    .then(async () => {
      const clients = await sw.clients.matchAll({ type: "window" });
      if (!clients.some((client) => client.id === sourceId)) return;
      const persisted = await readCachedCatalog();
      if (
        message.revision < persisted.revision ||
        (message.revision === persisted.revision &&
          (message.locale !== persisted.locale ||
            message.catalogGeneration < persisted.catalogGeneration))
      ) {
        return;
      }
      // The same selection can refresh within a build or when a newer build
      // supplies changed catalog data; older builds cannot roll it back.
      await persistCatalog(message);
    });
  localeWriteQueue = write;
  return write;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

function offlinePage(catalog: SetLocaleMessage): string {
  const copy = Object.fromEntries(
    Object.entries(catalog.messages).map(([key, value]) => [key, escapeHtml(value)]),
  );
  return `<!DOCTYPE html>
            <html lang="${escapeHtml(catalog.locale)}" dir="${catalog.direction}">
              <head>
                <meta charset="utf-8"/>
                <meta name="viewport" content="width=device-width, initial-scale=1"/>
                <title>Schematic — ${copy.offlineDocumentTitle}</title>
                <style>
                  body { background: #0f1014; color: #e8eaed; font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; padding: 20px; text-align: center; }
                  .card { background: #16181d; border: 1px solid #2a2e36; border-radius: 12px; padding: 24px; max-width: 380px; }
                  h1 { font-size: 1.25rem; margin-bottom: 0.5rem; color: #f87171; }
                  p { font-size: 0.875rem; color: #9aa0a6; line-height: 1.5; }
                </style>
              </head>
              <body>
                <div class="card">
                  <h1>${copy.offlineHeading}</h1>
                  <p>${copy.offlineMessage}</p>
                </div>
              </body>
            </html>`;
}

// Critical app shell assets to precache on install
const PRECACHE_ASSETS: readonly string[] = [
  "/",
  "/favicon.ico",
  "/favicon.svg",
  "/badge-96.png",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/site.webmanifest",
];

// Install Event, Pre-cache the application shell
sw.addEventListener("install", (event: { waitUntil: (p: Promise<unknown>) => void }) => {
  if (isDevelopmentWorker) {
    event.waitUntil(sw.skipWaiting());
    return;
  }
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(async (cache) => {
        try {
          await cache.addAll(PRECACHE_ASSETS);
        } catch {
          // Precache failure in dev or SSR should not abort service worker installation
        }
      })
      .then(() => sw.skipWaiting()),
  );
});

// Activate Event, Clean up outdated caches and take control immediately
sw.addEventListener("activate", (event: { waitUntil: (p: Promise<unknown>) => void }) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter(
              (name) =>
                name !== LOCALE_CACHE_NAME &&
                (isDevelopmentWorker ? name.startsWith("app-shell-") : name !== CACHE_NAME),
            )
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => sw.clients.claim()),
  );
});

// Cache Storage survives worker shutdown and restart; a global alone would
// disappear before the next offline navigation or generic push.
sw.addEventListener("message", (event: WorkerMessageEvent) => {
  const message = readSetLocaleMessage(event.data);
  const source = event.source;
  if (!message || !source?.id || !source.url) return;
  try {
    if (new URL(source.url).origin !== sw.location.origin) return;
  } catch {
    return;
  }
  event.waitUntil(queueLocalePersistence(message, source.id));
});

// Fetch Event, Handle network requests with tailored caching strategies
sw.addEventListener(
  "fetch",
  (event: {
    request: Request;
    mode?: string;
    respondWith: (r: Response | Promise<Response>) => void;
  }) => {
    // Keep the worker alive in development for push, notification clicks,
    // messaging and installability, but let Vite own every network request.
    // Caching its unbounded module graph is both unrepresentative of the
    // production PWA and can grow site data past 100 MB on LAN-served devices.
    if (isDevelopmentWorker) {
      return;
    }

    const request = event.request;
    const url = new URL(request.url);

    // Ignore non-GET requests (e.g. POST RPCs)
    if (request.method !== "GET") {
      return;
    }

    // Bypass fetch interception in local development so Vite HMR and SSR are untouched
    if (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.pathname.includes("@vite") ||
      url.pathname.includes("/src/")
    ) {
      return;
    }

    // 1. Navigation requests (HTML document), Network-first, fall back to cached shell
    if (request.mode === "navigate") {
      event.respondWith(
        fetch(request)
          .then((response) => {
            // Only the app document may become the offline shell; any other
            // navigated URL (an API response, the manifest) would replace it.
            if (
              response.ok &&
              url.origin === sw.location.origin &&
              url.pathname === "/" &&
              (response.headers.get("Content-Type") ?? "").toLowerCase().includes("text/html")
            ) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put("/", clone));
            }
            return response;
          })
          .catch(async () => {
            const catalog = await readPersistedCatalog();
            const cachedResponse = await caches.match("/");
            if (cachedResponse) {
              return cachedResponse;
            }
            return new Response(offlinePage(catalog), {
              headers: { "Content-Type": "text/html", "Content-Language": catalog.locale },
            });
          }),
      );
      return;
    }

    // 2. Static Assets (CSS, JS bundles, fonts, icons, manifest), Cache-first with network background revalidate
    if (
      url.origin === sw.location.origin &&
      (url.pathname.startsWith("/assets/") ||
        url.pathname.endsWith(".css") ||
        url.pathname.endsWith(".js") ||
        url.pathname.endsWith(".png") ||
        url.pathname.endsWith(".svg") ||
        url.pathname.endsWith(".ico") ||
        url.pathname.endsWith(".webmanifest"))
    ) {
      event.respondWith(
        caches.match(request).then((cachedResponse) => {
          const fetchPromise = fetch(request)
            .then((networkResponse) => {
              if (networkResponse && networkResponse.ok) {
                const clone = networkResponse.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
              }
              return networkResponse;
            })
            .catch(() => cachedResponse);

          return (cachedResponse || fetchPromise) as Promise<Response>;
        }),
      );
      return;
    }

    // 3. API & RPC Server Functions, Network-first with short timeout
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/_server/")) {
      event.respondWith(
        fetch(request).catch(async () => {
          const catalog = await readPersistedCatalog();
          const copy = catalog.messages;
          return new Response(
            JSON.stringify({
              error: copy.offlineApiError,
              message: copy.offlineApiMessage,
            }),
            {
              status: 503,
              statusText: "Service Unavailable",
              headers: { "Content-Type": "application/json", "Content-Language": catalog.locale },
            },
          );
        }),
      );
    }
  },
);

interface PushPayloadShape {
  readonly title?: string;
  readonly body?: string;
  readonly tag?: string;
  readonly data?: {
    readonly url?: string;
    readonly [key: string]: unknown;
  };
}

/**
 * Best-effort broadcast telling every open window that a push arrived which
 * the worker could not read (undecryptable payload, e.g. the browser's
 * subscription was created against a since-rewritten server VAPID key). The
 * gateway accepted that push with 201, the server never learns it failed —
 * so the page is the only place that can re-provision the subscription.
 */
function notifyWindowsOfUnreadablePush(): Promise<void> {
  return sw.clients
    .matchAll({ type: "window", includeUncontrolled: true })
    .then((windowClients) => {
      for (const client of windowClients) {
        try {
          client.postMessage({ type: "push-unreadable" });
        } catch {
          // One broken client must not starve the others of the signal.
        }
      }
    })
    .catch(() => {
      // Heal signal only: notification display must never be jeopardised.
    });
}

// Push Event, Display incoming Web Push notifications
sw.addEventListener(
  "push",
  (event: {
    data?: { json: () => unknown; text: () => string };
    waitUntil: (p: Promise<unknown>) => void;
  }) => {
    const showEnglishFallback = () => {
      return Promise.all([
        sw.registration.showNotification(ENGLISH_UNREADABLE_PUSH_FALLBACK.title, {
          body: ENGLISH_UNREADABLE_PUSH_FALLBACK.body,
          icon: "/icon-192.png",
          badge: "/badge-96.png",
          tag: "transit-push-no-data",
          renotify: true,
          data: { url: "/" },
        }),
        notifyWindowsOfUnreadablePush(),
      ]);
    };

    // Never leave a push event without a notification: the UA would show its
    // own generic "(site) was updated in the background" indicator.
    if (!event.data) {
      event.waitUntil(showEnglishFallback());
      return;
    }

    let payload: PushPayloadShape = {};

    try {
      const parsed: unknown = event.data.json();
      if (parsed && typeof parsed === "object") {
        payload = parsed as PushPayloadShape;
      } else {
        payload = {};
      }
    } catch {
      let unreadableBody: string;
      try {
        unreadableBody = event.data.text();
      } catch {
        event.waitUntil(showEnglishFallback());
        return;
      }
      payload = {
        title: "Transit Alert",
        body: unreadableBody,
      };
      const options = {
        body: payload.body || enWorkerMessages.genericPushBody,
        icon: "/icon-192.png",
        badge: "/badge-96.png",
        tag: payload.tag || "transit-alert",
        renotify: true,
        data: payload.data || { url: "/" },
      };
      event.waitUntil(sw.registration.showNotification("Transit Alert", options));
      return;
    }

    event.waitUntil(
      readPersistedCatalog().then((catalog) => {
        const copy = catalog.messages;
        const title = payload.title || copy.genericPushTitle;
        const options = {
          body: payload.body || copy.genericPushBody,
          icon: "/icon-192.png",
          badge: "/badge-96.png",
          tag: payload.tag || "transit-alert",
          renotify: true,
          data: payload.data || { url: "/" },
        };

        return sw.registration.showNotification(title, options);
      }),
    );
  },
);

// Notification Click Event, Open target URL or focus existing client
sw.addEventListener(
  "notificationclick",
  (event: {
    notification: { close: () => void; data?: unknown };
    waitUntil: (p: Promise<unknown>) => void;
  }) => {
    event.notification.close();
    const notifData = event.notification.data as { url?: string } | undefined;
    const urlToOpen = notifData?.url || "/";

    event.waitUntil(
      sw.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
        for (const client of windowClients) {
          if (client.url.includes(sw.location.origin) && typeof client.focus === "function") {
            return client.navigate(urlToOpen).then(
              (navigatedClient) => {
                if (!navigatedClient) return sw.clients.openWindow?.(urlToOpen);
                return navigatedClient.focus().catch(() => sw.clients.openWindow?.(urlToOpen));
              },
              () => sw.clients.openWindow?.(urlToOpen),
            );
          }
        }
        if (typeof sw.clients.openWindow === "function") {
          return sw.clients.openWindow(urlToOpen);
        }
      }),
    );
  },
);
