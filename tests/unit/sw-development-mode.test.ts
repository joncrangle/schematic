import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const devFlagsMock = vi.hoisted(() => ({ development: false }));
vi.mock("~/lib/devFlags", () => ({
  isDevServer: () => devFlagsMock.development,
}));

import { getServiceWorkerScriptUrl } from "~/lib/serviceWorkerRegistration";

type Listener = (event: unknown) => void;

const listeners = new Map<string, Listener>();
const skipWaiting = vi.fn(async () => {});
const clientsClaim = vi.fn(async () => {});

const fakeSelf = {
  addEventListener: vi.fn((type: string, listener: Listener) => listeners.set(type, listener)),
  clients: {
    claim: clientsClaim,
    matchAll: vi.fn(async () => []),
    openWindow: vi.fn(),
  },
  registration: { showNotification: vi.fn(async () => {}) },
  skipWaiting,
  location: {
    origin: "https://status.ttc.example",
    href: "https://status.ttc.example/sw.js?mode=dev",
  },
};

const cacheNames = new Set(["app-shell-v1", "app-shell-v0"]);
const cachesMock = {
  open: vi.fn(async () => ({ addAll: vi.fn(async () => {}) })),
  keys: vi.fn(async () => [...cacheNames]),
  delete: vi.fn(async (name: string) => cacheNames.delete(name)),
  match: vi.fn(async () => undefined),
};
const fetchMock = vi.fn(async () => new Response("vite dependency"));

vi.stubGlobal("self", fakeSelf);
vi.stubGlobal("caches", cachesMock);
vi.stubGlobal("fetch", fetchMock);

beforeAll(async () => {
  // A query keeps this worker instance isolated from the production-mode
  // side-effect import in sw-shell-caching.test.ts.
  // @ts-expect-error -- sw.ts has no exports; importing for listener registration
  await import("../../src/sw?development-worker");
});

beforeEach(() => {
  skipWaiting.mockClear();
  clientsClaim.mockClear();
  cachesMock.open.mockClear();
  cachesMock.keys.mockClear();
  cachesMock.delete.mockClear();
  fetchMock.mockClear();
  cacheNames.clear();
  cacheNames.add("app-shell-v1");
  cacheNames.add("app-shell-v0");
});

function dispatchInstall(): Promise<unknown> {
  let captured!: Promise<unknown>;
  listeners.get("install")!({
    waitUntil: (promise: Promise<unknown>) => {
      captured = promise;
    },
  });
  return captured;
}

function dispatchActivate(): Promise<unknown> {
  let captured!: Promise<unknown>;
  listeners.get("activate")!({
    waitUntil: (promise: Promise<unknown>) => {
      captured = promise;
    },
  });
  return captured;
}

describe("development service worker mode", () => {
  it("keeps the worker active without precaching the Vite app", async () => {
    await dispatchInstall();

    expect(skipWaiting).toHaveBeenCalledOnce();
    expect(cachesMock.open).not.toHaveBeenCalled();
    expect(listeners.has("push")).toBe(true);
    expect(listeners.has("notificationclick")).toBe(true);
  });

  it("deletes existing app-shell caches on activation", async () => {
    await dispatchActivate();

    expect(cachesMock.delete).toHaveBeenCalledWith("app-shell-v1");
    expect(cachesMock.delete).toHaveBeenCalledWith("app-shell-v0");
    expect(clientsClaim).toHaveBeenCalledOnce();
  });

  it("does not intercept Vite dependency requests", () => {
    let response: Response | Promise<Response> | undefined;
    listeners.get("fetch")!({
      request: {
        url: "https://status.ttc.example/node_modules/.vite/deps/solid-js.js",
        method: "GET",
      },
      respondWith: (value: Response | Promise<Response>) => {
        response = value;
      },
    });

    expect(response).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getServiceWorkerScriptUrl", () => {
  it.each([
    { development: true, expected: "/sw.js?mode=dev" },
    { development: false, expected: "/sw.js" },
  ])("returns $expected when development=$development", ({ development, expected }) => {
    devFlagsMock.development = development;
    expect(getServiceWorkerScriptUrl()).toBe(expected);
  });
});
