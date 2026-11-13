import {
  COARSE_ACCURACY_METERS,
  SPOOF_STORAGE_KEY,
  type CoarseLocation,
  type CoarseUnavailable,
  type LocationSource,
  type SpoofPosition,
} from "~/lib/location-source";

/**
 * Tiered location precedence engine: dev-spoof > gps > coarse-ip >
 * default, with the underground grace/stale-hold state transitions owned here
 * instead of scattered through a Solid hook. Plain TypeScript, no reactive
 * imports.
 */

/** A position fix the ladder can serve. */
export interface Coordinates {
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracy?: number;
  readonly timestamp: number;
  readonly agencyId?: string;
}

export const UNDERGROUND_TOLERANCE_MS = 180_000;
export const EXPIRY_CHECK_INTERVAL_MS = 5_000;

export const STORAGE_KEY_COORDS = "nearby_cached_coords";
export const STORAGE_KEY_GRANTED = "nearby_permission_granted";

const LEGACY_STORAGE_KEY_COORDS = "ttc_nearby_cached_coords";
const LEGACY_STORAGE_KEY_GRANTED = "ttc_nearby_permission_granted";
const LEGACY_SPOOF_STORAGE_KEY = "ttc_nearby_dev_spoof";

export type GeolocationStatus =
  | "idle"
  | "priming"
  | "prompting"
  | "granted"
  | "stale"
  | "denied"
  | "unavailable"
  | "expired";

/** The fix the ladder currently serves, with the tier that produced it. */
export interface EffectiveFix {
  readonly fix: Coordinates | null;
  readonly source: LocationSource;
}

export interface CoarseSeedState {
  readonly status: "idle" | "available" | "unavailable" | "local-address";
  readonly ip?: string;
}

interface StoredLocation {
  latitude: number;
  longitude: number;
  accuracy?: number;
  timestamp: number;
}

interface AppliedSpoof extends SpoofPosition {
  appliedAt: number;
}

interface GeolocationErrorLike {
  readonly code: number;
  readonly message?: string;
}

const PERMISSION_DENIED = 1;
const POSITION_UNAVAILABLE = 2;
const TIMEOUT = 3;

/** Shared copy for the stale-hold and unavailable branches of a failed fix. */
function describePositionError(error: GeolocationErrorLike): string {
  if (error.code === POSITION_UNAVAILABLE) {
    return "Location is currently unavailable.";
  }
  if (error.code === TIMEOUT) {
    return "Location request timed out.";
  }
  return error.message ?? "Unable to determine your current location.";
}

interface PositionSuccess {
  coords: {
    latitude: number;
    longitude: number;
    accuracy?: number;
  };
  timestamp?: number;
}

type RequestPosition = (
  onSuccess: (position: PositionSuccess) => void,
  onError: (error: GeolocationErrorLike) => void,
) => void;

interface Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Starts expiry checks and returns the cleanup operation for the scheduler. */
export type ExpiryScheduler = (checkExpiry: () => void) => () => void;

export function isUndergroundCacheValid(
  timestamp: number,
  now: number,
  toleranceMs: number = UNDERGROUND_TOLERANCE_MS,
): boolean {
  return now - timestamp <= toleranceMs;
}

/** Seconds of underground grace left before a cached fix goes stale. */
export function graceRemainingSeconds(
  fix: Coordinates | null,
  now: number,
  toleranceMs: number = UNDERGROUND_TOLERANCE_MS,
): number {
  if (!fix) {
    return Math.ceil(toleranceMs / 1000);
  }

  const elapsed = now - fix.timestamp;
  return Math.max(0, Math.ceil((toleranceMs - elapsed) / 1000));
}

function removeStorageKeys(storage: Storage | undefined, keys: readonly string[]): void {
  if (!storage) return;
  for (const key of keys) {
    try {
      storage.removeItem(key);
    } catch {
      // Storage failures must never break positioning.
    }
  }
}

function readPersistedString(
  storage: Storage | undefined,
  key: string,
  legacyKey?: string,
): string | null {
  if (!storage) return null;
  let current: string | null;
  try {
    current = storage.getItem(key);
  } catch {
    return null;
  }
  if (current !== null) {
    if (legacyKey) removeStorageKeys(storage, [legacyKey]);
    return current;
  }
  if (!legacyKey) return null;

  let legacy: string | null;
  try {
    legacy = storage.getItem(legacyKey);
  } catch {
    return null;
  }
  if (legacy === null) return null;

  try {
    storage.setItem(key, legacy);
    removeStorageKeys(storage, [legacyKey]);
  } catch {
    // Use the old value for this session when the migration cannot be saved.
  }
  return legacy;
}

function persistStorageString(
  storage: Storage | undefined,
  key: string,
  value: string,
  legacyKey?: string,
): void {
  if (!storage) return;
  try {
    storage.setItem(key, value);
    if (legacyKey) removeStorageKeys(storage, [legacyKey]);
  } catch {
    // Storage failures must never break positioning.
  }
}

function readPersistedJson<T>(
  storage: Storage | undefined,
  key: string,
  validate: (value: unknown) => T | null,
  legacyKey?: string,
): T | null {
  try {
    const raw = readPersistedString(storage, key, legacyKey);
    if (!raw) return null;
    return validate(JSON.parse(raw));
  } catch {
    return null;
  }
}

export interface LocationLadderDeps {
  /** Clock, injected so precedence and expiry are table-testable. */
  readonly now: () => number;
  /** Browser position source; null where geolocation is unsupported. */
  readonly requestPosition: RequestPosition | null;
  readonly storage?: Storage;
  /**
   * Dev builds gate spoofing behind isDevServer(). A predicate keeps the
   * gate live, a singleton created before the environment settles must not
   * freeze yesterday's answer.
   */
  readonly spoofGateActive: boolean | (() => boolean);
  /** Denial copy distinguishes insecure origins (HTTP). */
  readonly isTrustedOrigin?: () => boolean;
  /**
   * Browser Permissions source. When provided (or available globally in
   * browser), queries geolocation permission silently on init.
   */
  readonly permissions?: {
    query(desc: { name: PermissionName | string }): Promise<{ state: PermissionState | string }>;
  } | null;
  /**
   * Underground grace window in ms. Defaults to 180_000ms.
   * Injected so EffectiveAgency can seam it (global default).
   */
  readonly undergroundToleranceMs?: number;
  /** Optional browser scheduler; omitted for SSR and deterministic unit tests. */
  readonly scheduleExpiry?: ExpiryScheduler;
}

export interface LocationLadder {
  effectiveFix(): EffectiveFix;
  status(): GeolocationStatus;
  errorMessage(): string | null;
  request(silent?: boolean): void;
  startPriming(): void;
  cancelPriming(): void;
  applySpoof(position: SpoofPosition): void;
  clearSpoof(): void;
  restorePersistedSpoof(): void;
  seedCoarse(fetchCoarse: () => Promise<CoarseLocation | CoarseUnavailable | null>): Promise<void>;
  coarseSeedState(): CoarseSeedState;
  /** The raw seeded coarse-ip feed, for diagnostics panels. */
  seededCoarse(): CoarseLocation | null;
  clearLocation(): void;
  checkExpiry(toleranceMs?: number): void;
  /** Marks permission denied outright (browser Permissions API refresh). */
  markPermissionDenied(): void;
  /** Notified after every state mutation; returns an unsubscribe fn. */
  subscribe(listener: () => void): () => void;
  /** Disposes the ladder and clears its listeners. */
  dispose(): void;
}

export function createLocationLadder(deps: LocationLadderDeps): LocationLadder {
  const now = deps.now;
  const storage = deps.storage;
  const isTrustedOrigin = deps.isTrustedOrigin ?? (() => true);
  const undergroundToleranceMs = deps.undergroundToleranceMs ?? UNDERGROUND_TOLERANCE_MS;
  const isCacheValid = (timestamp: number, nowMs: number): boolean =>
    isUndergroundCacheValid(timestamp, nowMs, undergroundToleranceMs);

  const listeners = new Set<() => void>();
  let disposed = false;
  // New requests and resets supersede callbacks still pending in the browser.
  let positionRevision = 0;
  const gateActive = (): boolean =>
    typeof deps.spoofGateActive === "function" ? deps.spoofGateActive() : deps.spoofGateActive;
  const notify = (): void => {
    if (disposed) return;
    for (const listener of listeners) {
      listener();
    }
  };

  // --- persisted/session state -------------------------------------------

  let sessionCachedLocation: Coordinates | null = loadPersistedLocation();
  let status: GeolocationStatus = initialStatus();
  let lastErrorMessage: string | null = null;
  let appliedSpoof: AppliedSpoof | null = null;
  let coarseSeed: CoarseSeedState = { status: "idle" };
  let coarseCoords: Coordinates | null = null;
  let seededCoarseRaw: CoarseLocation | null = null;
  let coarseTimestampMs = 0;
  let coarseSeedPromise: Promise<void> | null = null;

  function loadPersistedLocation(): Coordinates | null {
    const stored = readPersistedJson<StoredLocation>(
      storage,
      STORAGE_KEY_COORDS,
      (value) =>
        typeof value === "object" &&
        value !== null &&
        typeof (value as StoredLocation).latitude === "number" &&
        typeof (value as StoredLocation).longitude === "number"
          ? (value as StoredLocation)
          : null,
      LEGACY_STORAGE_KEY_COORDS,
    );
    if (!stored) {
      return null;
    }
    return {
      latitude: stored.latitude,
      longitude: stored.longitude,
      accuracy: stored.accuracy,
      timestamp: stored.timestamp,
    };
  }

  function initialStatus(): GeolocationStatus {
    if (sessionCachedLocation && isCacheValid(sessionCachedLocation.timestamp, now())) {
      return "granted";
    }
    if (sessionCachedLocation) {
      return "stale";
    }
    // The grant flag is written as a bare "true" (not JSON), so read it raw.
    let grantedFlag: string | null = null;
    try {
      grantedFlag = readPersistedString(storage, STORAGE_KEY_GRANTED, LEGACY_STORAGE_KEY_GRANTED);
    } catch {
      return "idle";
    }
    return grantedFlag === "true" ? "granted" : "idle";
  }

  function persistGranted(coords: Coordinates): void {
    if (!storage) {
      return;
    }
    try {
      persistStorageString(storage, STORAGE_KEY_GRANTED, "true", LEGACY_STORAGE_KEY_GRANTED);
      persistStorageString(
        storage,
        STORAGE_KEY_COORDS,
        JSON.stringify({
          latitude: coords.latitude,
          longitude: coords.longitude,
          accuracy: coords.accuracy,
          timestamp: coords.timestamp,
        }),
        LEGACY_STORAGE_KEY_COORDS,
      );
    } catch {
      // Storage failures must never break positioning.
    }
  }

  // --- spoof --------------------------------------------------------------

  function restorePersistedSpoof(): void {
    if (disposed) return;
    // A persisted dev pin must never resurrect outside dev builds, the gate
    // lives here so every caller inherits the invariant.
    if (!gateActive()) {
      return;
    }
    if (appliedSpoof) {
      return;
    }
    const persisted = readPersistedJson<PersistedSpoofShape>(
      storage,
      SPOOF_STORAGE_KEY,
      (value) =>
        value !== null &&
        typeof (value as PersistedSpoofShape).latitude === "number" &&
        typeof (value as PersistedSpoofShape).longitude === "number" &&
        typeof (value as PersistedSpoofShape).appliedAt === "number"
          ? (value as PersistedSpoofShape)
          : null,
      LEGACY_SPOOF_STORAGE_KEY,
    );
    if (!persisted) {
      return;
    }
    appliedSpoof = persisted;
    notify();
  }

  interface PersistedSpoofShape {
    latitude: number;
    longitude: number;
    accuracyMeters: number;
    agencyId?: string;
    appliedAt: number;
  }

  function persistSpoof(spoof: AppliedSpoof): void {
    if (!storage || !gateActive()) {
      return;
    }
    try {
      persistStorageString(
        storage,
        SPOOF_STORAGE_KEY,
        JSON.stringify(spoof),
        LEGACY_SPOOF_STORAGE_KEY,
      );
    } catch {
      // Storage failures must never break spoofing.
    }
  }

  // --- selection ----------------------------------------------------------

  function selectPosition(): EffectiveFix {
    const spoofFix = (): Coordinates => ({
      latitude: appliedSpoof!.latitude,
      longitude: appliedSpoof!.longitude,
      accuracy: appliedSpoof!.accuracyMeters,
      timestamp: appliedSpoof!.appliedAt,
      agencyId: appliedSpoof!.agencyId,
    });

    if (appliedSpoof && gateActive()) {
      return { fix: spoofFix(), source: "dev-spoof" };
    }

    const gpsFresh =
      sessionCachedLocation !== null && isCacheValid(sessionCachedLocation.timestamp, now());

    // Ungated spoof: the live spoof's coordinates always apply; only
    // the label derives from the real feeds.
    if (appliedSpoof && !gateActive()) {
      return {
        fix: spoofFix(),
        source: coarseSeed.status === "available" ? "coarse-ip" : gpsFresh ? "gps" : "default",
      };
    }

    if (gpsFresh) {
      return { fix: sessionCachedLocation!, source: "gps" };
    }

    if (coarseSeed.status === "available" && coarseCoords) {
      return { fix: coarseCoords, source: "coarse-ip" };
    }

    if (sessionCachedLocation) {
      return { fix: sessionCachedLocation, source: "gps" };
    }

    return { fix: null, source: "default" };
  }

  function request(silent = false) {
    if (disposed) return;
    const requestRevision = ++positionRevision;
    lastErrorMessage = null;

    if (!deps.requestPosition) {
      status = "unavailable";
      lastErrorMessage = "Geolocation is not supported by your browser.";
      notify();
      return;
    }

    const shouldPrompt =
      !silent && !sessionCachedLocation && status !== "granted" && status !== "priming";

    if (shouldPrompt) {
      status = "prompting";
      notify();
    }

    deps.requestPosition(
      (position) => {
        if (disposed || requestRevision !== positionRevision) return;
        const fix: Coordinates = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          timestamp: position.timestamp ?? now(),
        };
        sessionCachedLocation = fix;
        status = "granted";
        lastErrorMessage = null;
        persistGranted(fix);
        notify();
      },
      (error) => {
        if (disposed || requestRevision !== positionRevision) return;
        if (error.code === PERMISSION_DENIED) {
          if (storage) {
            try {
              removeStorageKeys(storage, [
                STORAGE_KEY_GRANTED,
                STORAGE_KEY_COORDS,
                LEGACY_STORAGE_KEY_GRANTED,
                LEGACY_STORAGE_KEY_COORDS,
              ]);
            } catch {
              // Ignore storage failures on denial cleanup.
            }
          }
          sessionCachedLocation = null;
          status = "denied";
          lastErrorMessage = !isTrustedOrigin()
            ? "Location is blocked over HTTP. Serve the app over HTTPS to enable nearby results."
            : (error.message ?? "Location permission was denied.");
          notify();
          return;
        }

        if (sessionCachedLocation) {
          // Stale-hold: keep serving the cached fix rather than dropping.
          status = "stale";
          lastErrorMessage = describePositionError(error);
          notify();
          return;
        }

        status = "unavailable";
        lastErrorMessage = describePositionError(error);
        notify();
      },
    );
  }

  function checkExpiry(toleranceMs = undergroundToleranceMs) {
    if (disposed) return;
    if (
      (status === "granted" || status === "stale") &&
      sessionCachedLocation &&
      !isUndergroundCacheValid(sessionCachedLocation.timestamp, now(), toleranceMs)
    ) {
      status = "expired";
      notify();
    }
  }

  let stopExpiryScheduler: (() => void) | null = null;

  function startExpiryScheduler(): void {
    if (stopExpiryScheduler || !deps.scheduleExpiry) return;
    stopExpiryScheduler = deps.scheduleExpiry(checkExpiry);
  }

  function stopExpiryChecks(): void {
    stopExpiryScheduler?.();
    stopExpiryScheduler = null;
  }

  function markPermissionDenied() {
    if (disposed) return;
    positionRevision += 1;
    if (storage) {
      try {
        removeStorageKeys(storage, [
          STORAGE_KEY_GRANTED,
          STORAGE_KEY_COORDS,
          LEGACY_STORAGE_KEY_GRANTED,
          LEGACY_STORAGE_KEY_COORDS,
        ]);
      } catch {
        // Ignore storage failures on denial cleanup.
      }
    }
    sessionCachedLocation = null;
    status = "denied";
    notify();
  }

  // --- Browser permission wiring ------------------------------------------

  const permissionsSource =
    deps.permissions !== undefined
      ? deps.permissions
      : typeof navigator !== "undefined" && "permissions" in navigator
        ? navigator.permissions
        : null;

  if (permissionsSource) {
    const permissionRevision = positionRevision;
    try {
      permissionsSource
        .query({ name: "geolocation" as PermissionName })
        .then((res) => {
          if (disposed || permissionRevision !== positionRevision) return;
          if (res.state === "granted") {
            request(true);
          } else if (res.state === "denied") {
            markPermissionDenied();
          }
        })
        .catch(() => {
          // Ignore permission query failure
        });
    } catch {
      // Ignore
    }
  }

  // --- API ----------------------------------------------------------------

  return {
    effectiveFix: selectPosition,

    status: () => status,

    errorMessage: () => lastErrorMessage,

    startPriming() {
      if (disposed) return;
      if (status === "idle") {
        status = "priming";
        notify();
      }
    },

    cancelPriming() {
      if (disposed) return;
      if (status === "priming") {
        status = "idle";
        notify();
      }
    },

    request,

    applySpoof(position: SpoofPosition) {
      if (disposed) return;
      appliedSpoof = { ...position, appliedAt: now() };
      persistSpoof(appliedSpoof);
      notify();
    },

    clearSpoof() {
      if (disposed) return;
      appliedSpoof = null;
      if (storage) {
        try {
          removeStorageKeys(storage, [SPOOF_STORAGE_KEY, LEGACY_SPOOF_STORAGE_KEY]);
        } catch {
          // Ignore storage failures.
        }
      }
      notify();
    },

    restorePersistedSpoof,

    seedCoarse(fetchCoarse) {
      if (disposed) return Promise.resolve();
      if (coarseSeedPromise) {
        return coarseSeedPromise;
      }
      coarseSeedPromise = fetchCoarse()
        .then((result) => {
          if (disposed) return;
          coarseTimestampMs = now();
          if (!result) {
            coarseSeed = { status: "unavailable" };
          } else if ("unavailable" in result) {
            coarseSeed = {
              status: "local-address",
              ...(result.ip ? { ip: result.ip } : {}),
            };
          } else {
            seededCoarseRaw = result;
            coarseCoords = {
              latitude: result.latitude,
              longitude: result.longitude,
              accuracy: result.accuracyMeters ?? COARSE_ACCURACY_METERS,
              timestamp: coarseTimestampMs,
            };
            coarseSeed = { status: "available", ...(result.ip ? { ip: result.ip } : {}) };
          }
          notify();
        })
        .catch(() => {
          if (disposed) return;
          coarseTimestampMs = now();
          coarseSeed = { status: "unavailable" };
          notify();
        });
      return coarseSeedPromise;
    },

    coarseSeedState: () => coarseSeed,

    seededCoarse: () => seededCoarseRaw,

    clearLocation() {
      if (disposed) return;
      positionRevision += 1;
      sessionCachedLocation = null;
      if (storage) {
        try {
          removeStorageKeys(storage, [
            STORAGE_KEY_GRANTED,
            STORAGE_KEY_COORDS,
            LEGACY_STORAGE_KEY_GRANTED,
            LEGACY_STORAGE_KEY_COORDS,
          ]);
        } catch {
          // Ignore storage failures.
        }
      }
      status = "idle";
      lastErrorMessage = null;
      notify();
    },

    checkExpiry,

    markPermissionDenied,

    subscribe(listener: () => void): () => void {
      if (disposed) return () => {};
      listeners.add(listener);
      startExpiryScheduler();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stopExpiryChecks();
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      stopExpiryChecks();
      listeners.clear();
    },
  };
}
