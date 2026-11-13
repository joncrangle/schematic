import { isDevServer } from "~/lib/devFlags";

/**
 * Development keeps a real service worker for push/PWA lifecycle testing, but
 * marks its script URL so the worker can avoid caching Vite's module graph.
 */
export function getServiceWorkerScriptUrl(): string {
  return isDevServer() ? "/sw.js?mode=dev" : "/sw.js";
}
