import { createSignal, onSettled } from "solid-js";

import { isDevServer } from "~/lib/devFlags";
import type { LocationSource } from "~/lib/location-source";
import {
  createLocationLadder,
  EXPIRY_CHECK_INTERVAL_MS,
  type Coordinates,
  type EffectiveFix,
  type GeolocationStatus,
  type LocationLadder,
} from "~/domain/location/locationLadder";

/**
 * Solid binding over locationLadder: tier precedence, expiry
 * transitions, and persistence are owned by the location modules.
 * EffectiveAgency adapter lives in routes/index.tsx (consumes effectiveFix()
 * and owns only the effectivePoint filter).
 */
export type {
  CoarseSeedState,
  Coordinates,
  EffectiveFix,
  GeolocationStatus,
} from "~/domain/location/locationLadder";

let ladderSingleton: LocationLadder | null = null;

/**
 * The one client location ladder: tiered precedence, persistence,
 * coarse seeding, spoof pin, and browser wiring live behind it. Expiry polling
 * is scheduled by this ladder and starts only while it has subscribers. The
 * scheduler is omitted during SSR; per-test module resets get a fresh instance.
 */
export function getLocationLadder(): LocationLadder {
  if (ladderSingleton) {
    return ladderSingleton;
  }

  ladderSingleton = createLocationLadder({
    now: () => Date.now(),
    requestPosition: (onSuccess, onError) => {
      if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
        onError({ code: 0, message: "Geolocation is not supported by your browser." });
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (position) => {
          onSuccess({
            coords: {
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              accuracy: position.coords.accuracy,
            },
            timestamp: position.timestamp,
          });
        },
        (error) => onError({ code: error.code, message: error.message }),
        // Use 60s maximumAge so browser can immediately return cached GPS fix without cold-start lag
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
      );
    },
    storage: {
      getItem: (key) => {
        if (typeof window === "undefined" || !window.localStorage) return null;
        try {
          return window.localStorage.getItem(key);
        } catch {
          return null;
        }
      },
      setItem: (key, value) => {
        if (typeof window === "undefined" || !window.localStorage) return;
        try {
          window.localStorage.setItem(key, value);
        } catch {
          // Ignore localStorage errors
        }
      },
      removeItem: (key) => {
        if (typeof window === "undefined" || !window.localStorage) return;
        try {
          window.localStorage.removeItem(key);
        } catch {
          // Ignore
        }
      },
    },
    // User override of the runtime toggle: the spoof tier exists only
    // in dev builds. A live predicate, the singleton may be created before
    // the environment settles, so the gate must not freeze at creation.
    spoofGateActive: () => isDevServer(),
    isTrustedOrigin: () =>
      typeof window === "undefined" ||
      window.isSecureContext ||
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1",
    scheduleExpiry:
      typeof window === "undefined"
        ? undefined
        : (checkExpiry) => {
            const timerId = setInterval(checkExpiry, EXPIRY_CHECK_INTERVAL_MS);
            return () => clearInterval(timerId);
          },
  });

  return ladderSingleton;
}

/**
 * Thin Solid binding over the locationLadder:
 * mirrors ladder state into reactive accessors. All location behavior, tier
 * precedence, expiry transitions, persistence, coarse seeding, and browser
 * integration, is owned by the location modules; this hook is a reactive
 * adapter.
 * EffectiveAgency consumes effectiveFix() from here and owns only the
 * effectivePoint filter (source===default || !fix).
 */
export function useGeolocation() {
  const ladder = getLocationLadder();
  const [version, setVersion] = createSignal(0);

  onSettled(() => {
    const unsubscribe = ladder.subscribe(() => setVersion((v) => v + 1));
    return unsubscribe;
  });

  const track = () => {
    version();
  };

  return {
    effectiveFix: (): EffectiveFix => {
      track();
      return ladder.effectiveFix();
    },
    status: (): GeolocationStatus => {
      track();
      return ladder.status();
    },
    coords: (): Coordinates | null => {
      track();
      return ladder.effectiveFix().fix;
    },
    errorMessage: (): string | null => {
      track();
      return ladder.errorMessage();
    },
    locationSource: (): LocationSource => {
      track();
      return ladder.effectiveFix().source;
    },
    startPriming: () => ladder.startPriming(),
    cancelPriming: () => ladder.cancelPriming(),
    requestLocation: (silent = false) => ladder.request(silent),
    clearLocation: () => ladder.clearLocation(),
  };
}
