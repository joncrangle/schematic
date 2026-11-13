import {
  createContext,
  createMemo,
  createSignal,
  createStore,
  flush,
  onCleanup,
  onSettled,
  reconcile,
  snapshot,
  untrack,
  useContext,
  type ParentProps,
} from "solid-js";
import {
  DEFAULT_PREFERENCES,
  PUSH_RELEVANT_PREFERENCE_KEYS,
  type CommuteSchedule,
  type InterchangeBadgeVisibility,
  type MutablePreferenceKey,
  type ReduceMotion,
  type UserPreferences,
} from "~/domain/preferences/UserPreferences";
import {
  browserDefaultPreferences,
  createLocalStoragePreferencesStorage,
  type PreferencesStorage,
} from "~/infrastructure/storage/PreferencesStorage";
import {
  mirrorPushSubscription,
  withPushDeadline,
} from "~/services/notifications/PushSubscriptionSync";
import {
  checkAndHealPushSubscription,
  healPushSubscription,
  isPushSupported,
  registerPushHealListener,
} from "~/services/notifications/PushNotificationService";
import { buildSyncPushSubscriptionPayload } from "~/services/notifications/PushSyncPayload";
import { logger } from "~/infrastructure/logging/logger";
import { createServiceWorkerLocaleSync } from "~/lib/serviceWorkerLocaleSync";

const PUSH_SYNC_DEBOUNCE_MS = 1000;

export type SetPreferenceValue<K extends MutablePreferenceKey> =
  | UserPreferences[K]
  | ((prev: UserPreferences[K]) => UserPreferences[K]);

export interface UserPreferencesContextValue {
  readonly preferences: UserPreferences;
  readonly isLoaded: () => boolean;
  readonly isEffectiveReducedMotion: () => boolean;
  readonly onLocaleChange: (listener: (locale: UserPreferences["locale"]) => void) => () => void;
  /**
   * Normalized mutation entry point. Owns the full pipeline for every
   * preference change: optimistic store update → localStorage persist →
   * push mirror (gated: only keys in PUSH_RELEVANT_PREFERENCE_KEYS reach the
   * network). The named mutators below are sugar over this.
   */
  readonly setPreference: <K extends MutablePreferenceKey>(
    key: K,
    value: SetPreferenceValue<K>,
  ) => void;
  readonly setReducedMotion: (mode: ReduceMotion) => void;
  readonly setShowReducedSpeedZones: (show: boolean) => void;
  readonly setInterchangeBadgeVisibility: (visibility: InterchangeBadgeVisibility) => void;
  readonly toggleFavouriteLine: (agencyId: string, lineId: string) => void;
  readonly toggleFavouriteStation: (agencyId: string, stationName: string) => void;
  readonly toggleFavouriteSurfaceRoute: (agencyId: string, routeId: string) => void;
  readonly toggleFavouriteAgency: (agencyId: string) => void;
  readonly addCommuteSchedule: (schedule: CommuteSchedule) => void;
  readonly updateCommuteSchedule: (id: string, updates: Partial<CommuteSchedule>) => void;
  readonly removeCommuteSchedule: (id: string) => void;
  readonly resetPreferences: () => void;
}

const UserPreferencesContext = createContext<UserPreferencesContextValue | null>(null);

export function UserPreferencesProvider(
  props: ParentProps<{ readonly storage?: PreferencesStorage }>,
) {
  const storage = props.storage ?? createLocalStoragePreferencesStorage();
  const workerLocaleSync = createServiceWorkerLocaleSync();

  // Deterministic SSR initial state
  const [preferences, setPreferences] = createStore<UserPreferences>(
    structuredClone(DEFAULT_PREFERENCES),
  );
  const [isLoaded, setIsLoaded] = createSignal(false);
  const [systemReducedMotion, setSystemReducedMotion] = createSignal(false);
  const pendingPreferenceMutations: Array<(current: UserPreferences) => UserPreferences> = [];
  const localeListeners = new Set<(locale: UserPreferences["locale"]) => void>();
  const notifyLocaleChange = (locale: UserPreferences["locale"]) => {
    for (const listener of localeListeners) listener(locale);
  };
  const onLocaleChange = (listener: (locale: UserPreferences["locale"]) => void) => {
    localeListeners.add(listener);
    if (untrack(isLoaded)) queueMicrotask(() => listener(preferences.locale));
    return () => localeListeners.delete(listener);
  };

  // Background persistence pipeline. Storage failures never block optimistic UI updates.
  const persistPreferences = (updated: UserPreferences) => {
    try {
      void storage.save(updated).catch((error) => {
        logger.error("UserPreferencesContext: failed to persist preferences", { error });
      });
    } catch (error) {
      logger.error("UserPreferencesContext: failed to persist preferences", { error });
    }
  };

  // Serialize mirrors so a slow older request cannot overwrite newer policy.
  // Hydration and reconnect also repair a browser subscription missing on the server.
  let pushSyncTimeout: ReturnType<typeof setTimeout> | null = null;
  let pushSyncInFlight = false;
  let pushSyncPending = false;
  let pushSyncFailures = 0;
  let disposed = false;
  let pushHealthCheckPending = false;
  let pushHealPending = false;
  onCleanup(() => {
    disposed = true;
    workerLocaleSync.dispose();
    if (pushSyncTimeout !== null) clearTimeout(pushSyncTimeout);
  });

  const schedulePushSync = (delay = PUSH_SYNC_DEBOUNCE_MS) => {
    if (disposed) return;
    if (pushSyncTimeout !== null) clearTimeout(pushSyncTimeout);
    pushSyncTimeout = setTimeout(() => {
      pushSyncTimeout = null;
      void runPushSync();
    }, delay);
  };

  const runPushSync = async () => {
    if (disposed || pushSyncInFlight || !pushSyncPending) return;
    pushSyncInFlight = true;
    pushSyncPending = false;
    try {
      if (pushHealthCheckPending || pushHealPending) {
        const reactive = pushHealPending;
        pushHealthCheckPending = false;
        pushHealPending = false;
        const source = () => snapshot(preferences);
        if (reactive) await healPushSubscription(source);
        else await checkAndHealPushSubscription(source);
      }
      if (disposed) return;
      const reg = await withPushDeadline(navigator.serviceWorker.ready, 6000);
      if (disposed) return;
      const sub = await withPushDeadline(reg.pushManager.getSubscription());
      if (disposed || !sub) return;
      const subJson = sub.toJSON();
      if (subJson.endpoint && subJson.keys?.p256dh && subJson.keys?.auth) {
        await mirrorPushSubscription(
          buildSyncPushSubscriptionPayload(
            { endpoint: subJson.endpoint, p256dh: subJson.keys.p256dh, auth: subJson.keys.auth },
            snapshot(preferences),
          ),
        );
        pushSyncFailures = 0;
      }
    } catch {
      // Keep retry diagnostics free of RPC request bodies and credentials.
      logger.debug("UserPreferencesContext: push sync failed; retry pending");
      pushSyncFailures++;
      if (!pushSyncPending && pushSyncFailures <= 3) {
        pushSyncPending = true;
        schedulePushSync(5000);
      }
    } finally {
      pushSyncInFlight = false;
      if (pushSyncPending && pushSyncTimeout === null) schedulePushSync();
    }
  };

  const syncPushSubscriptionIfActive = () => {
    if (disposed || !isLoaded() || !isPushSupported()) return;
    pushSyncPending = true;
    pushSyncFailures = 0;
    schedulePushSync();
  };

  // 1. Post-hydration load
  onSettled(() => {
    let removeMediaListener: (() => void) | undefined;
    let disposeHealListener: (() => void) | undefined;
    const startPushSync = () => {
      if (disposed || !isPushSupported()) return;
      disposeHealListener = registerPushHealListener(
        () => snapshot(preferences),
        () => {
          pushHealPending = true;
          syncPushSubscriptionIfActive();
        },
      );
      pushHealthCheckPending = true;
      syncPushSubscriptionIfActive();
    };
    const onOnline = () => {
      pushHealthCheckPending = true;
      syncPushSubscriptionIfActive();
    };
    if (typeof window !== "undefined") window.addEventListener("online", onOnline);
    // Media query listener for prefers-reduced-motion
    if (typeof window !== "undefined" && window.matchMedia) {
      const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
      setSystemReducedMotion(mediaQuery.matches);
      syncReducedMotionAttribute();

      const listener = (e: MediaQueryListEvent) => {
        flush(() => {
          setSystemReducedMotion(e.matches);
        });
        syncReducedMotionAttribute();
      };

      mediaQuery.addEventListener("change", listener);
      removeMediaListener = () => mediaQuery.removeEventListener("change", listener);
    }

    const applyLoadedPreferences = (loaded: UserPreferences) => {
      if (disposed) return;
      const hadPendingMutations = pendingPreferenceMutations.length > 0;
      const hydrated = pendingPreferenceMutations.reduce(
        (current, mutation) => mutation(current),
        loaded,
      );
      pendingPreferenceMutations.length = 0;
      flush(() => {
        setPreferences((draft) => {
          reconcile(hydrated)(draft);
        });
        setIsLoaded(true);
      });
      syncReducedMotionAttribute();
      workerLocaleSync.hydrate(hydrated.locale);
      notifyLocaleChange(hydrated.locale);
      if (hadPendingMutations) persistPreferences(snapshot(preferences));
      startPushSync();
    };

    // A promise boundary handles synchronous adapter throws outside settlement,
    // where Solid permits the hydration flush.
    const loadPreferences = async () => storage.load();
    void loadPreferences()
      .then(applyLoadedPreferences)
      .catch((error) => {
        if (disposed) return;
        logger.warn("UserPreferencesContext: error loading preferences, using defaults", { error });
        applyLoadedPreferences(browserDefaultPreferences());
      });

    return () => {
      removeMediaListener?.();
      disposeHealListener?.();
      if (typeof window !== "undefined") window.removeEventListener("online", onOnline);
    };
  });

  // 2. Compute effective reduced motion
  const isEffectiveReducedMotion = createMemo(() => {
    const mode = preferences.reducedMotion;
    if (mode === "reduce") return true;
    if (mode === "no-preference") return false;
    return systemReducedMotion();
  });

  // The DOM attribute is an external projection of preference state. Keep its
  // writes explicit at lifecycle and mutation boundaries instead of using a
  // reactive effect.
  const syncReducedMotionAttribute = () => {
    if (typeof document === "undefined") return;
    document.documentElement.setAttribute(
      "data-reduced-motion",
      isEffectiveReducedMotion() ? "true" : "false",
    );
  };

  // 3. Normalized mutation pipeline
  const setPreference = <K extends MutablePreferenceKey>(key: K, value: SetPreferenceValue<K>) => {
    if (!isLoaded()) {
      pendingPreferenceMutations.push((current) => ({
        ...current,
        [key]:
          typeof value === "function"
            ? (value as (previous: UserPreferences[K]) => UserPreferences[K])(current[key])
            : value,
      }));
    }

    flush(() => {
      setPreferences((draft) => {
        draft[key] =
          typeof value === "function"
            ? (value as (previous: UserPreferences[K]) => UserPreferences[K])(draft[key])
            : value;
      });
    });
    if (key === "reducedMotion") syncReducedMotionAttribute();
    const current = snapshot(preferences);
    persistPreferences(current);
    if (key === "locale") {
      workerLocaleSync.sync(current.locale);
      notifyLocaleChange(current.locale);
    }
    if (PUSH_RELEVANT_PREFERENCE_KEYS.includes(key)) {
      syncPushSubscriptionIfActive();
    }
  };

  // 4. Sugar mutators, every one delegates to setPreference so the pipeline
  // (optimistic update → persist once → gated mirror) stays in a single place.
  const setReducedMotion = (mode: ReduceMotion) => {
    setPreference("reducedMotion", mode);
  };

  const setShowReducedSpeedZones = (show: boolean) => {
    setPreference("showReducedSpeedZones", show);
  };

  const setInterchangeBadgeVisibility = (visibility: InterchangeBadgeVisibility) => {
    setPreference("interchangeBadgeVisibility", visibility);
  };

  const toggleFavouriteLine = (agencyId: string, lineId: string) => {
    setPreference("favouriteLines", (lines) =>
      lines.some((ref) => ref.agencyId === agencyId && ref.lineId === lineId)
        ? lines.filter((ref) => ref.agencyId !== agencyId || ref.lineId !== lineId)
        : [...lines, { agencyId, lineId }],
    );
  };

  const toggleFavouriteStation = (agencyId: string, stationName: string) => {
    setPreference("favouriteStations", (stations) =>
      stations.some((ref) => ref.agencyId === agencyId && ref.stationName === stationName)
        ? stations.filter((ref) => ref.agencyId !== agencyId || ref.stationName !== stationName)
        : [...stations, { agencyId, stationName }],
    );
  };

  const toggleFavouriteSurfaceRoute = (agencyId: string, routeId: string) => {
    setPreference("favouriteSurfaceRoutes", (routes) =>
      routes.some((ref) => ref.agencyId === agencyId && ref.routeId === routeId)
        ? routes.filter((ref) => ref.agencyId !== agencyId || ref.routeId !== routeId)
        : [...routes, { agencyId, routeId }],
    );
  };

  const toggleFavouriteAgency = (agencyId: string) => {
    setPreference("favouriteAgencies", (agencies) =>
      agencies.includes(agencyId)
        ? agencies.filter((a) => a !== agencyId)
        : [...agencies, agencyId],
    );
  };

  const addCommuteSchedule = (schedule: CommuteSchedule) => {
    setPreference("commuteSchedules", (prev) => [...prev, schedule]);
  };

  const updateCommuteSchedule = (id: string, updates: Partial<CommuteSchedule>) => {
    setPreference("commuteSchedules", (schedules) =>
      schedules.map((schedule) => (schedule.id === id ? { ...schedule, ...updates } : schedule)),
    );
  };

  const removeCommuteSchedule = (id: string) => {
    setPreference("commuteSchedules", (schedules) => schedules.filter((s) => s.id !== id));
  };

  // resetPreferences replaces the whole document, so it cannot route through
  // the single-key setPreference. It runs the same pipeline tail explicitly:
  // persist once, and mirror once (a reset subsumes every push-relevant slice).
  const resetPreferences = () => {
    const defaults = browserDefaultPreferences();
    if (!isLoaded()) {
      pendingPreferenceMutations.push(() => structuredClone(defaults));
    }

    flush(() => {
      setPreferences((draft) => {
        reconcile(defaults)(draft);
      });
    });
    persistPreferences(defaults);
    syncPushSubscriptionIfActive();
    syncReducedMotionAttribute();
    workerLocaleSync.sync(defaults.locale);
    notifyLocaleChange(defaults.locale);
  };

  const value: UserPreferencesContextValue = {
    preferences,
    isLoaded,
    isEffectiveReducedMotion,
    onLocaleChange,
    setPreference,
    setReducedMotion,
    setShowReducedSpeedZones,
    setInterchangeBadgeVisibility,
    toggleFavouriteLine,
    toggleFavouriteStation,
    toggleFavouriteSurfaceRoute,
    toggleFavouriteAgency,
    addCommuteSchedule,
    updateCommuteSchedule,
    removeCommuteSchedule,
    resetPreferences,
  };

  return <UserPreferencesContext value={value}>{props.children}</UserPreferencesContext>;
}

export function useUserPreferences(): UserPreferencesContextValue {
  const context = useContext(UserPreferencesContext);
  if (!context) {
    throw new Error("useUserPreferences must be used within a UserPreferencesProvider");
  }
  return context;
}
