import { createRoot } from "solid-js";
import { vi } from "vitest";
import { STORAGE_KEY_COORDS, STORAGE_KEY_GRANTED } from "../../src/domain/location/locationLadder";

/**
 * Shared harness for the useGeolocation singleton suites.
 *
 * The hook owns module-level signals, so every test reseeds localStorage and
 * re-imports the module (loadHook) to get a pristine state machine — the
 * exact shape shared by geolocation-spoof.test.ts and
 * geolocation-coarse-tier.test.ts.
 */

export function seedGpsFix(timestamp = Date.now()): void {
  const coords = {
    latitude: 43.7051,
    longitude: -79.3979,
    accuracy: 25,
    timestamp,
  };
  localStorage.setItem(STORAGE_KEY_COORDS, JSON.stringify(coords));
  localStorage.setItem(STORAGE_KEY_GRANTED, "true");
}

export async function loadHook() {
  vi.resetModules();
  return await import("../../src/hooks/useGeolocation");
}

export function withMount<T>(use: () => T): { api: T; dispose: () => void } {
  let api!: T;
  let disposeFn!: () => void;
  createRoot((dispose) => {
    disposeFn = dispose;
    api = use();
  });
  return { api, dispose: disposeFn };
}
