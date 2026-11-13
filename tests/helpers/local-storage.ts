import { vi } from "vitest";

/**
 * Map-backed localStorage stand-in for happy-dom unit tests.
 *
 * happy-dom delegates localStorage to an unavailable Node implementation in
 * this environment, so store-backed seams (geolocation spoof persistence,
 * preferences) stub window.localStorage with this class. Shared by every
 * suite that mounts code touching storage; install per-test in beforeEach
 * and unstub in afterEach.
 */
export class MemoryLocalStorageStub {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

/** Installs a fresh stub on both window.localStorage and the global. */
export function installMemoryLocalStorage(): MemoryLocalStorageStub {
  const storage = new MemoryLocalStorageStub();
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  vi.stubGlobal("localStorage", storage);
  return storage;
}
