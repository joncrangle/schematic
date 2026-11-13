import { describe, it, expect, vi } from "vitest";

import {
  createLocationLadder,
  graceRemainingSeconds,
  isUndergroundCacheValid,
  UNDERGROUND_TOLERANCE_MS,
  STORAGE_KEY_COORDS,
  STORAGE_KEY_GRANTED,
  type LocationLadder,
} from "../../src/domain/location/locationLadder";
import { COARSE_ACCURACY_METERS, SPOOF_STORAGE_KEY } from "../../src/lib/location-source";

/**
 * Ladder core table tests: the tiered precedence engine
 * (dev-spoof > gps > coarse-ip > default) with injected clock, position
 * requester and storage — no Solid, no browser.
 */

const NOW = 1_800_000_000_000;

const GPS_FIX = {
  latitude: 43.6532,
  longitude: -79.3832,
  accuracy: 15,
  timestamp: NOW - 30_000,
};

const SPOOF = { latitude: 44.1, longitude: -80.2, accuracyMeters: 5 };

const COARSE = {
  latitude: 43.7,
  longitude: -79.4,
  accuracyMeters: 1_500,
  city: "Toronto",
  source: "cloudflare",
} as const;

function memoryStorage(throwOnWrite = false) {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (throwOnWrite) throw new Error("quota");
      map.set(key, value);
    },
    removeItem: (key: string) => {
      if (throwOnWrite) throw new Error("quota");
      map.delete(key);
    },
    peek: (key: string) => map.get(key) ?? null,
  };
}

type Harness = {
  ladder: LocationLadder;
  storage: ReturnType<typeof memoryStorage>;
  requestPosition: ReturnType<typeof vi.fn> | null;
  succeedGps: (overrides?: Partial<typeof GPS_FIX>) => void;
  failGps: (code: 1 | 2 | 3, message?: string) => void;
};

function makeLadder(overrides?: {
  now?: () => number;
  spoofGateActive?: boolean;
  storage?: ReturnType<typeof memoryStorage> | null;
  requestPosition?: ReturnType<typeof vi.fn> | null;
  isTrustedOrigin?: () => boolean;
  permissions?: {
    query: (desc: {
      name: PermissionName | string;
    }) => Promise<{ state: PermissionState | string }>;
  } | null;
}): Harness {
  const storage = overrides?.storage ?? memoryStorage();
  let clock = overrides?.now ?? (() => NOW);
  const requestPosition: ReturnType<typeof vi.fn> | null =
    overrides?.requestPosition === null ? null : (overrides?.requestPosition ?? vi.fn());

  const ladder = createLocationLadder({
    now: () => clock(),
    requestPosition: requestPosition as Parameters<
      typeof createLocationLadder
    >[0]["requestPosition"],
    storage,
    spoofGateActive: overrides?.spoofGateActive ?? true,
    isTrustedOrigin: overrides?.isTrustedOrigin ?? (() => true),
    permissions: overrides?.permissions ?? null,
  });

  const succeedGps = (fixOverrides?: Partial<typeof GPS_FIX>) => {
    const call = requestPosition?.mock.calls.at(-1);
    const onSuccess = call?.[0] as (position: unknown) => void;
    onSuccess({
      coords: {
        latitude: fixOverrides?.latitude ?? GPS_FIX.latitude,
        longitude: fixOverrides?.longitude ?? GPS_FIX.longitude,
        accuracy: fixOverrides?.accuracy ?? GPS_FIX.accuracy,
      },
      timestamp: fixOverrides?.timestamp ?? GPS_FIX.timestamp,
    });
  };

  const failGps = (code: 1 | 2 | 3, message?: string) => {
    const call = requestPosition?.mock.calls.at(-1);
    const onError = call?.[1] as (error: unknown) => void;
    onError({
      code,
      PERMISSION_DENIED: 1,
      POSITION_UNAVAILABLE: 2,
      TIMEOUT: 3,
      message: message ?? "",
    });
  };

  return { ladder, storage, requestPosition, succeedGps, failGps };
}

/** Lands a fresh GPS fix directly through the ladder's request pipeline. */
async function grantGps(harness: Harness): Promise<void> {
  harness.ladder.request();
  await Promise.resolve();
  harness.succeedGps();
}

describe("locationLadder — tier precedence", () => {
  it("serves an active dev spoof above every real feed", async () => {
    const harness = makeLadder();
    await grantGps(harness);
    harness.ladder.applySpoof(SPOOF);

    const { fix, source } = harness.ladder.effectiveFix();
    expect(source).toBe("dev-spoof");
    expect(fix).toEqual({
      latitude: SPOOF.latitude,
      longitude: SPOOF.longitude,
      accuracy: SPOOF.accuracyMeters,
      timestamp: NOW,
    });
  });

  it("ranks fresh gps above a seeded coarse feed", async () => {
    const harness = makeLadder();
    await grantGps(harness);
    await harness.ladder.seedCoarse(async () => ({ ...COARSE }));

    const { fix, source } = harness.ladder.effectiveFix();
    expect(source).toBe("gps");
    expect(fix?.latitude).toBe(GPS_FIX.latitude);
  });

  it("falls back to the coarse-ip tier when the gps fix has expired", async () => {
    let clock = NOW;
    const harness = makeLadder({ now: () => clock });
    await grantGps(harness);
    await harness.ladder.seedCoarse(async () => ({ ...COARSE }));
    clock += UNDERGROUND_TOLERANCE_MS + 60_000;

    const { fix, source } = harness.ladder.effectiveFix();
    expect(source).toBe("coarse-ip");
    expect(fix?.latitude).toBe(COARSE.latitude);
    expect(fix?.accuracy).toBe(COARSE.accuracyMeters);
  });

  it("defaults the coarse fix accuracy when the feed omits it", async () => {
    const harness = makeLadder();
    const { latitude, longitude, city, source } = COARSE;
    await harness.ladder.seedCoarse(async () => ({ latitude, longitude, city, source }));

    const { fix } = harness.ladder.effectiveFix();
    expect(fix?.accuracy).toBe(COARSE_ACCURACY_METERS);
  });

  it("holds an expired gps fix without a coarse feed, still labelled gps", async () => {
    let clock = NOW;
    const harness = makeLadder({ now: () => clock });
    await grantGps(harness);
    clock += UNDERGROUND_TOLERANCE_MS + 1_000;

    const { fix, source } = harness.ladder.effectiveFix();
    expect(source).toBe("gps");
    expect(fix?.timestamp).toBe(NOW - 30_000);
  });

  it("returns the default tier with no fix when nothing is available", () => {
    const { ladder } = makeLadder();

    const { fix, source } = ladder.effectiveFix();
    expect(source).toBe("default");
    expect(fix).toBeNull();
  });

  it("an ungated build keeps applying a live spoof's coordinates while the source derives from real feeds alone", async () => {
    const harness = makeLadder({ spoofGateActive: false });
    await harness.ladder.seedCoarse(async () => ({ ...COARSE }));
    harness.ladder.applySpoof(SPOOF);

    const { fix, source } = harness.ladder.effectiveFix();
    expect(fix?.latitude).toBe(SPOOF.latitude);
    expect(source).toBe("coarse-ip");
  });

  it("without any real feed the ungated spoof reads source default", () => {
    const harness = makeLadder({ spoofGateActive: false });
    harness.ladder.applySpoof(SPOOF);

    expect(harness.ladder.effectiveFix().source).toBe("default");
  });
});

describe("locationLadder — stale-hold tolerance", () => {
  it("counts a gps fix inside the underground tolerance as fresh", () => {
    expect(isUndergroundCacheValid(NOW - 60_000, NOW)).toBe(true);
    expect(isUndergroundCacheValid(NOW - UNDERGROUND_TOLERANCE_MS, NOW)).toBe(true);
    expect(isUndergroundCacheValid(NOW - UNDERGROUND_TOLERANCE_MS - 1_000, NOW)).toBe(false);
  });

  it("marks a stale fix expired once the tolerance lapses", async () => {
    let clock = NOW;
    const harness = makeLadder({ now: () => clock });
    harness.ladder.request();
    await Promise.resolve();
    harness.failGps(2);
    await grantGps(harness);

    clock += UNDERGROUND_TOLERANCE_MS + 6_000;
    harness.ladder.checkExpiry();
    expect(harness.ladder.status()).toBe("expired");
  });
});

describe("locationLadder — request lifecycle", () => {
  it("transitions to prompting before a non-silent request without a cached fix, then granted on success", async () => {
    const harness = makeLadder();
    harness.ladder.request();

    expect(harness.ladder.status()).toBe("prompting");

    await Promise.resolve();
    harness.succeedGps();
    expect(harness.ladder.status()).toBe("granted");
    expect(harness.ladder.effectiveFix().fix?.latitude).toBe(GPS_FIX.latitude);
  });

  it("persists the granted flag and coordinates on success", async () => {
    const harness = makeLadder();
    await grantGps(harness);

    expect(JSON.parse(harness.storage.peek(STORAGE_KEY_GRANTED) as string)).toBe(true);
    const stored = JSON.parse(harness.storage.peek(STORAGE_KEY_COORDS) as string);
    expect(stored.latitude).toBe(GPS_FIX.latitude);
    expect(stored.timestamp).toBe(NOW - 30_000);
  });

  it("stays off the prompting transition for silent requests", () => {
    const harness = makeLadder();
    harness.ladder.request(true);

    expect(harness.ladder.status()).toBe("idle");
  });

  it("keeps serving a cached fix as stale when a later request fails without denying permission", async () => {
    let clock = NOW;
    const harness = makeLadder({ now: () => clock });
    await grantGps(harness);

    harness.ladder.request();
    clock += 10_000;
    harness.failGps(3, "timed out");

    expect(harness.ladder.status()).toBe("stale");
    expect(harness.ladder.effectiveFix().fix?.latitude).toBe(GPS_FIX.latitude);
  });

  it.each([
    [1 as const, "denied"],
    [2 as const, "unavailable"],
    [3 as const, "unavailable"],
  ])("maps geolocation error %i to status %s when nothing is cached", async (code, expected) => {
    const harness = makeLadder();
    harness.ladder.request();
    await Promise.resolve();
    harness.failGps(code, "boom");

    expect(harness.ladder.status()).toBe(expected);
    expect(harness.ladder.errorMessage()).not.toBeNull();
  });

  it("clears persisted location state on permission denial", async () => {
    const harness = makeLadder();
    await grantGps(harness);

    harness.ladder.request();
    await Promise.resolve();
    harness.failGps(1);

    expect(harness.storage.peek(STORAGE_KEY_GRANTED)).toBeNull();
    expect(harness.storage.peek(STORAGE_KEY_COORDS)).toBeNull();
  });

  it("explains an insecure-origin denial with the HTTP-specific copy", async () => {
    const harness = makeLadder({ isTrustedOrigin: () => false });
    harness.ladder.request();
    await Promise.resolve();
    harness.failGps(1);

    expect(harness.ladder.errorMessage()).toContain("HTTP");
  });

  it("reports unavailable when no geolocation requester exists", () => {
    const harness = makeLadder({ requestPosition: null });
    harness.ladder.request();

    expect(harness.ladder.status()).toBe("unavailable");
    expect(harness.ladder.errorMessage()).toContain("not supported");
  });

  it("ignores storage write failures instead of losing the fix", () => {
    const harness = makeLadder({ storage: memoryStorage(true) });
    harness.ladder.request();
    harness.succeedGps();

    expect(harness.ladder.status()).toBe("granted");
    expect(harness.ladder.effectiveFix().fix).not.toBeNull();
  });

  it("clearLocation resets the session without touching an active spoof", async () => {
    const harness = makeLadder();
    await grantGps(harness);
    harness.ladder.applySpoof(SPOOF);

    harness.ladder.clearLocation();
    expect(harness.ladder.status()).toBe("idle");
    expect(harness.ladder.effectiveFix().source).toBe("dev-spoof");
  });
});

describe("locationLadder — priming lifecycle", () => {
  it("moves idle to priming and back, and refuses transitions elsewhere", () => {
    const harness = makeLadder();
    harness.ladder.cancelPriming();
    expect(harness.ladder.status()).toBe("idle");

    harness.ladder.startPriming();
    expect(harness.ladder.status()).toBe("priming");

    harness.ladder.startPriming();
    expect(harness.ladder.status()).toBe("priming");

    harness.ladder.cancelPriming();
    expect(harness.ladder.status()).toBe("idle");
  });

  it("does not leave priming just because a request starts", async () => {
    const harness = makeLadder();
    harness.ladder.startPriming();
    expect(harness.ladder.status()).toBe("priming");

    harness.ladder.request();
    await Promise.resolve();
    expect(harness.ladder.status()).toBe("priming");
  });
});

describe("locationLadder — coarse seeding", () => {
  it("seeds once per session regardless of how often callers ask", async () => {
    const harness = makeLadder();
    const fetchCoarse = vi.fn(async () => ({ ...COARSE }));

    await harness.ladder.seedCoarse(fetchCoarse);
    await harness.ladder.seedCoarse(fetchCoarse);

    expect(fetchCoarse).toHaveBeenCalledTimes(1);
    expect(harness.ladder.coarseSeedState()).toEqual({ status: "available" });
    expect(harness.ladder.effectiveFix().source).toBe("coarse-ip");
  });

  it("records a local-address result with the offending ip", async () => {
    const harness = makeLadder();
    await harness.ladder.seedCoarse(async () => ({ unavailable: "local-address", ip: "::1" }));

    expect(harness.ladder.coarseSeedState()).toEqual({ status: "local-address", ip: "::1" });
    expect(harness.ladder.effectiveFix().fix).toBeNull();
  });

  it("lands unavailable when the fetcher rejects or returns nothing", async () => {
    const failing = makeLadder();
    await failing.ladder.seedCoarse(async () => null);
    expect(failing.ladder.coarseSeedState()).toEqual({ status: "unavailable" });

    const rejecting = makeLadder();
    await rejecting.ladder.seedCoarse(async () => {
      throw new Error("down");
    });
    expect(rejecting.ladder.coarseSeedState()).toEqual({ status: "unavailable" });
  });
});

describe("locationLadder — spoof persistence", () => {
  it("restores a persisted spoof with its original appliedAt", () => {
    const harness = makeLadder();
    harness.storage.setItem(
      SPOOF_STORAGE_KEY,
      JSON.stringify({ ...SPOOF, appliedAt: NOW - 5_000 }),
    );

    harness.ladder.restorePersistedSpoof();

    expect(harness.ladder.effectiveFix().fix?.timestamp).toBe(NOW - 5_000);
  });

  it("ignores a persisted pin lacking appliedAt", () => {
    const harness = makeLadder();
    harness.storage.setItem(SPOOF_STORAGE_KEY, JSON.stringify(SPOOF));

    harness.ladder.restorePersistedSpoof();

    expect(harness.ladder.effectiveFix().fix).toBeNull();
  });

  it("never clobbers a spoof that was applied before restoration ran", () => {
    const harness = makeLadder();
    harness.ladder.applySpoof({ ...SPOOF, latitude: 45 });
    harness.storage.setItem(
      SPOOF_STORAGE_KEY,
      JSON.stringify({ ...SPOOF, appliedAt: NOW - 5_000 }),
    );

    harness.ladder.restorePersistedSpoof();

    expect(harness.ladder.effectiveFix().fix?.latitude).toBe(45);
  });

  it("persists the pin with its appliedAt and removes it on clear", () => {
    const harness = makeLadder();
    harness.ladder.applySpoof(SPOOF);
    expect(JSON.parse(harness.storage.peek(SPOOF_STORAGE_KEY) as string)).toMatchObject({
      latitude: SPOOF.latitude,
      appliedAt: NOW,
    });

    harness.ladder.clearSpoof();
    expect(harness.storage.peek(SPOOF_STORAGE_KEY)).toBeNull();
    expect(harness.ladder.effectiveFix().source).toBe("default");
  });

  it("does not persist spoofs in gated-off builds but keeps the live pin", () => {
    const harness = makeLadder({ spoofGateActive: false });
    harness.ladder.applySpoof(SPOOF);

    expect(harness.storage.peek(SPOOF_STORAGE_KEY)).toBeNull();
    expect(harness.ladder.effectiveFix().fix?.latitude).toBe(SPOOF.latitude);

    harness.ladder.clearSpoof();
    expect(harness.ladder.effectiveFix().fix).toBeNull();
  });

  it("never resurrects a persisted spoof in gated-off builds", () => {
    const harness = makeLadder({ spoofGateActive: false });
    harness.storage.setItem(SPOOF_STORAGE_KEY, JSON.stringify({ ...SPOOF, appliedAt: NOW }));

    harness.ladder.restorePersistedSpoof();

    expect(harness.ladder.effectiveFix().source).not.toBe("dev-spoof");
    expect(harness.ladder.effectiveFix().fix).toBeNull();
  });
});

describe("graceRemainingSeconds", () => {
  it("counts down the remaining underground grace and clamps at zero", () => {
    expect(graceRemainingSeconds(null, NOW)).toBe(Math.ceil(UNDERGROUND_TOLERANCE_MS / 1000));

    const fix = { ...GPS_FIX, timestamp: NOW - 60_000 };
    expect(graceRemainingSeconds(fix, NOW)).toBe(120);
    expect(graceRemainingSeconds(fix, NOW + UNDERGROUND_TOLERANCE_MS)).toBe(0);
  });
});

describe("locationLadder — browser permissions integration & race conditions", () => {
  it.each(["clear", "new fix"])(
    "ignores the initial permission snapshot after a %s transition",
    async (transition) => {
      let resolvePermission!: (value: { state: PermissionState }) => void;
      const harness = makeLadder({
        permissions: {
          query: () =>
            new Promise((resolve) => {
              resolvePermission = resolve;
            }),
        },
      });
      if (transition === "clear") harness.ladder.clearLocation();
      else await grantGps(harness);
      const requests = harness.requestPosition?.mock.calls.length ?? 0;
      resolvePermission({ state: transition === "clear" ? "granted" : "denied" });
      await Promise.resolve();
      expect(harness.requestPosition).toHaveBeenCalledTimes(requests);
      expect(harness.ladder.status()).toBe(transition === "clear" ? "idle" : "granted");
    },
  );

  it.each(["clear", "denied"])(
    "ignores a pending GPS result after location is %s",
    (transition) => {
      const harness = makeLadder();
      harness.ladder.request();
      if (transition === "clear") harness.ladder.clearLocation();
      else harness.ladder.markPermissionDenied();
      harness.succeedGps();
      expect(harness.ladder.status()).toBe(transition === "clear" ? "idle" : "denied");
      expect(harness.ladder.effectiveFix()).toEqual({ fix: null, source: "default" });
      expect(harness.storage.peek(STORAGE_KEY_COORDS)).toBeNull();
    },
  );

  it.each(["success", "timeout"])(
    "ignores an older GPS request's %s after a newer fix has arrived",
    (result) => {
      const requestPosition: Parameters<typeof createLocationLadder>[0]["requestPosition"] =
        vi.fn();
      const harness = makeLadder({ requestPosition: vi.mocked(requestPosition) });
      harness.ladder.request();
      const [oldSuccess, oldError] = vi.mocked(requestPosition).mock.calls[0];
      harness.ladder.request();
      harness.succeedGps({ latitude: 45, timestamp: NOW });
      if (result === "success")
        oldSuccess({ coords: { latitude: 43, longitude: -79 }, timestamp: NOW - 30_000 });
      else oldError({ code: 3 });
      expect(harness.ladder.status()).toBe("granted");
      expect(harness.ladder.effectiveFix().fix?.latitude).toBe(45);
      expect(JSON.parse(harness.storage.peek(STORAGE_KEY_COORDS)!).latitude).toBe(45);
    },
  );

  it("triggers silent GPS request when permissions.query returns granted on init", async () => {
    const permissions = {
      query: vi.fn(async () => ({ state: "granted" as PermissionState })),
    };
    const harness = makeLadder({ permissions });

    await Promise.resolve();

    expect(permissions.query).toHaveBeenCalledWith({ name: "geolocation" });
    expect(harness.requestPosition).toHaveBeenCalled();

    harness.succeedGps();
    expect(harness.ladder.status()).toBe("granted");
    expect(harness.ladder.effectiveFix().source).toBe("gps");
  });

  it("marks permission denied when permissions.query returns denied on init", async () => {
    const permissions = {
      query: vi.fn(async () => ({ state: "denied" as PermissionState })),
    };
    const harness = makeLadder({ permissions });

    await Promise.resolve();

    expect(permissions.query).toHaveBeenCalledWith({ name: "geolocation" });
    expect(harness.ladder.status()).toBe("denied");
    expect(harness.ladder.effectiveFix().source).toBe("default");
    expect(harness.requestPosition).not.toHaveBeenCalled();
  });

  it("race: dev-spoof applied before granted permissions.query resolves keeps dev-spoof precedence", async () => {
    let resolvePerm!: (val: { state: PermissionState }) => void;
    const permissions = {
      query: vi.fn(
        () =>
          new Promise<{ state: PermissionState }>((res) => {
            resolvePerm = res;
          }),
      ),
    };
    const harness = makeLadder({ permissions });
    harness.ladder.applySpoof(SPOOF);

    expect(harness.ladder.effectiveFix().source).toBe("dev-spoof");

    resolvePerm({ state: "granted" });
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.requestPosition).toHaveBeenCalled();
    harness.succeedGps();

    const { fix, source } = harness.ladder.effectiveFix();
    expect(source).toBe("dev-spoof");
    expect(fix?.latitude).toBe(SPOOF.latitude);
  });

  it("race: denied permissions.query leaves active dev-spoof in effect", async () => {
    const permissions = {
      query: vi.fn(async () => ({ state: "denied" as PermissionState })),
    };
    const harness = makeLadder({ permissions });
    harness.ladder.applySpoof(SPOOF);

    await Promise.resolve();

    expect(harness.ladder.status()).toBe("denied");
    const { fix, source } = harness.ladder.effectiveFix();
    expect(source).toBe("dev-spoof");
    expect(fix?.latitude).toBe(SPOOF.latitude);
  });

  it("race: coarse-ip is served while granted permissions.query GPS request is in flight", async () => {
    let resolvePerm!: (val: { state: PermissionState }) => void;
    const permissions = {
      query: vi.fn(
        () =>
          new Promise<{ state: PermissionState }>((res) => {
            resolvePerm = res;
          }),
      ),
    };
    const harness = makeLadder({ permissions });
    await harness.ladder.seedCoarse(async () => ({ ...COARSE }));

    expect(harness.ladder.effectiveFix().source).toBe("coarse-ip");

    resolvePerm({ state: "granted" });
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.ladder.effectiveFix().source).toBe("coarse-ip");

    harness.succeedGps();
    expect(harness.ladder.effectiveFix().source).toBe("gps");
  });

  it("handles permissions query rejection gracefully without throwing", async () => {
    const permissions = {
      query: vi.fn(async () => {
        throw new Error("security error");
      }),
    };
    const harness = makeLadder({ permissions });
    await Promise.resolve();

    expect(harness.ladder.status()).toBe("idle");
    expect(harness.ladder.effectiveFix().source).toBe("default");
  });
});

describe("locationLadder — dispose", () => {
  it("dispose() clears subscribers and ignores subsequent notifications", () => {
    const harness = makeLadder();
    const listener = vi.fn();
    harness.ladder.subscribe(listener);

    harness.ladder.dispose();
    harness.ladder.applySpoof(SPOOF);

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("locationLadder — expiry scheduler ownership", () => {
  it("runs the injected expiry scheduler and disposes it after one transition", () => {
    let clock = NOW;
    let expiryTick: (() => void) | undefined;
    const stopScheduler = vi.fn();
    const ladder = createLocationLadder({
      now: () => clock,
      requestPosition: ((onSuccess) =>
        onSuccess({
          coords: { latitude: 43.65, longitude: -79.38, accuracy: 10 },
          timestamp: NOW,
        })) as Parameters<typeof createLocationLadder>[0]["requestPosition"],
      storage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      },
      spoofGateActive: true,
      scheduleExpiry: (check) => {
        expiryTick = check;
        return stopScheduler;
      },
    });
    const listener = vi.fn();
    ladder.subscribe(listener);
    ladder.request();
    listener.mockClear();

    clock += UNDERGROUND_TOLERANCE_MS + 1;
    expiryTick?.();
    expiryTick?.();

    expect(ladder.status()).toBe("expired");
    expect(listener).toHaveBeenCalledOnce();
    ladder.dispose();
    expect(stopScheduler).toHaveBeenCalledOnce();
  });
});
