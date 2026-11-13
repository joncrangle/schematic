// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRenderEffect, createRoot, createSignal, flush } from "solid-js";
import { queryClient } from "~/lib/queryClient";
import {
  ROUTE_TRACKING_KEY,
  ROUTE_TRACKING_RENEWAL_MS,
  acquireRouteTracking,
  useTargetedRouteTracking,
  type RouteEnlargeRequest,
} from "~/lib/routeTrackingLifecycle";
import { fetchRouteTracking } from "~/services/surface/SurfaceClient";
import type { RouteTrackingData } from "~/domain/surface/types";
import type { UiLocale } from "~/domain/locale";

let readLocale: () => UiLocale = () => "en-CA";
vi.mock("~/i18n/I18nContext", () => ({ useI18n: () => ({ locale: () => readLocale() }) }));

vi.mock("~/services/surface/SurfaceClient", () => ({
  fetchRouteTracking: vi.fn(),
}));

const fetchRouteTrackingMock = vi.mocked(fetchRouteTracking);

const makeTrackingData = (vehicleId: string): RouteTrackingData => ({
  route: {
    id: "504",
    shortName: "504",
    longName: "King",
    routeType: "streetcar",
    color: "#da251d",
    textColor: "#ffffff",
  },
  shape: {
    id: `504_0_${vehicleId}`,
    routeId: "504",
    directionId: 0,
    headsign: "Eastbound to Broadview Station",
    polyline: "[]",
    minLat: 43.6,
    maxLat: 43.7,
    minLon: -79.5,
    maxLon: -79.3,
    pointCount: 2,
  },
  stops: [],
  vehicles: [
    {
      vehicleId,
      routeId: "504",
      directionId: 0,
      latitude: 43.64,
      longitude: -79.4,
      timestamp: Date.now(),
    },
  ],
  alerts: [],
});

const makeTransitionData = (name: string, directionId = 0): RouteTrackingData => ({
  route: {
    id: "R1",
    shortName: "R1",
    longName: name,
    routeType: "bus",
    color: "#123456",
    textColor: "#ffffff",
  },
  shape: {
    id: `shape-${name}`,
    routeId: "R1",
    directionId,
    headsign: "East",
    polyline: "[]",
    minLat: 43,
    maxLat: 44,
    minLon: -80,
    maxLon: -79,
    pointCount: 2,
  },
  stops: [],
  vehicles: [],
  alerts: [],
});

/** Drain pending promise chains (server-function dispatch -> cache -> signal). */
const flushMicrotasks = async () => {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
};

/** Network invocations issued for one routeId (the shared mock sees all keys). */
const networkCallsFor = (routeId: string): number =>
  fetchRouteTrackingMock.mock.calls.filter((call) => {
    const input = call[0] as { routeId: string };
    return input.routeId === routeId;
  }).length;

beforeEach(() => {
  readLocale = () => "en-CA";
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  queryClient.clear();
  fetchRouteTrackingMock.mockReset();
});

afterEach(() => {
  queryClient.clear();
  vi.useRealTimers();
});

describe("routeTrackingLifecycle", () => {
  it("does not hold old-language alert data while the new locale is fetching", async () => {
    const english = makeTransitionData("English route");
    queryClient.setQueryData(ROUTE_TRACKING_KEY("sample", "R1", 0, "en-CA"), english);
    let resolveFrench!: (data: RouteTrackingData) => void;
    fetchRouteTrackingMock.mockReturnValue(
      new Promise((resolve) => {
        resolveFrench = resolve;
      }),
    );
    const { tracking, setLocale, dispose } = createRoot((dispose) => {
      const [locale, setLocale] = createSignal<UiLocale>("en-CA");
      readLocale = locale;
      const tracking = useTargetedRouteTracking(() => ({
        agencyId: "sample",
        routeId: "R1",
        directionId: 0,
      }));
      return { tracking, setLocale, dispose };
    });
    try {
      expect(tracking.data()).toBe(english);
      setLocale("fr-CA");
      flush();
      expect(tracking.data()).toBeNull();
      expect(fetchRouteTrackingMock).toHaveBeenCalledWith({
        agencyId: "sample",
        routeId: "R1",
        directionId: 0,
        locale: "fr-CA",
      });
      const french = makeTransitionData("French route");
      resolveFrench(french);
      await vi.advanceTimersByTimeAsync(0);
      expect(tracking.data()).toBe(french);
    } finally {
      dispose();
    }
  });

  it.each(["shared", "reacquired"])(
    "a repeated release does not stop a %s subscriber's polling",
    async (mode) => {
      fetchRouteTrackingMock.mockResolvedValue(makeTransitionData("Alpha route"));
      const target = { agencyId: "alpha", routeId: "R1", directionId: 0 };
      const first = acquireRouteTracking(target);
      if (mode === "reacquired") first.release();
      const second = acquireRouteTracking(target);
      await vi.advanceTimersByTimeAsync(0);
      first.release();
      first.release();
      const calls = fetchRouteTrackingMock.mock.calls.length;
      try {
        await vi.advanceTimersByTimeAsync(ROUTE_TRACKING_RENEWAL_MS);
        expect(fetchRouteTrackingMock).toHaveBeenCalledTimes(calls + 1);
      } finally {
        second.release();
      }
    },
  );

  it("does not deliver a pending arrival after its subscriber is released", async () => {
    let resolve!: (data: RouteTrackingData) => void;
    fetchRouteTrackingMock.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const arrival = vi.fn();
    const handle = acquireRouteTracking(
      { agencyId: "alpha", routeId: "R1", directionId: 0 },
      arrival,
    );
    handle.release();
    resolve(makeTransitionData("Late route"));
    await vi.advanceTimersByTimeAsync(0);
    expect(arrival).not.toHaveBeenCalled();
  });

  it("never holds another agency's identically numbered route while retargeting", async () => {
    const alpha = makeTransitionData("Alpha route");
    queryClient.setQueryData(ROUTE_TRACKING_KEY("alpha", "R1", 0), alpha);
    fetchRouteTrackingMock.mockReturnValue(new Promise(() => {}));
    const { tracking, setTarget, dispose } = createRoot((dispose) => {
      const [target, setTarget] = createSignal<RouteEnlargeRequest | null>({
        agencyId: "alpha",
        routeId: "R1",
        directionId: 0,
      });
      return { tracking: useTargetedRouteTracking(target), setTarget, dispose };
    });
    try {
      expect(tracking.data()).toBe(alpha);
      const arrival = vi.fn();
      const unsubscribe = tracking.onDataArrival(arrival);
      setTarget({ agencyId: "beta", routeId: "R1", directionId: 0 });
      flush();
      expect(tracking.data()).toBeNull();
      expect(tracking.selectedDirectionId?.()).toBe(0);
      expect(tracking.selectedRouteId?.()).toBe("R1");
      const beta = makeTransitionData("Beta route");
      queryClient.setQueryData(ROUTE_TRACKING_KEY("beta", "R1", 0), beta);
      flush();
      expect(tracking.data()).toBe(beta);
      expect(arrival).toHaveBeenLastCalledWith(beta);
      unsubscribe();
    } finally {
      dispose();
    }
  });

  it("holds same-agency geometry during a direction switch without delivering abandoned arrivals", async () => {
    const outbound = makeTransitionData("Outbound", 0);
    const inbound = makeTransitionData("Inbound", 1);
    queryClient.setQueryData(ROUTE_TRACKING_KEY("alpha", "R1", 0), outbound);
    let resolveInbound!: (data: RouteTrackingData) => void;
    fetchRouteTrackingMock.mockReturnValue(
      new Promise((resolve) => {
        resolveInbound = resolve;
      }),
    );
    const { tracking, setTarget, dispose } = createRoot((dispose) => {
      const [target, setTarget] = createSignal<RouteEnlargeRequest | null>({
        agencyId: "alpha",
        routeId: "R1",
        directionId: 0,
      });
      return { tracking: useTargetedRouteTracking(target), setTarget, dispose };
    });
    try {
      const arrival = vi.fn();
      tracking.onDataArrival(arrival);
      setTarget({ agencyId: "alpha", routeId: "R1", directionId: 1 });
      flush();
      expect(tracking.data()).toBe(outbound);
      expect(tracking.isStaleForDirection()).toBe(true);
      setTarget({ agencyId: "alpha", routeId: "R1", directionId: 0 });
      flush();
      resolveInbound(inbound);
      await vi.advanceTimersByTimeAsync(0);
      flush();
      expect(tracking.data()).toBe(outbound);
      expect(tracking.isStaleForDirection()).toBe(false);
      expect(arrival.mock.calls.flat()).not.toContain(inbound);
      setTarget({ agencyId: "alpha", routeId: "R1", directionId: 1 });
      flush();
      await vi.advanceTimersByTimeAsync(0);
      expect(tracking.data()).toBe(inbound);
      expect(tracking.isStaleForDirection()).toBe(false);
      expect(arrival).toHaveBeenLastCalledWith(inbound);
    } finally {
      dispose();
    }
  });

  it("exposes the canonical agency-scoped query key tuple with disjoint agency entries", () => {
    // Agency segment leads the route pair so TTC/GO route ids can never
    // collide in the shared TanStack cache.
    expect(ROUTE_TRACKING_KEY("ttc", "504", 0)).toEqual([
      "route-tracking",
      "ttc",
      "504",
      0,
      "en-CA",
    ]);
    // Identical route ids across agencies therefore land in disjoint entries.
    expect(ROUTE_TRACKING_KEY("ttc", "1", 0)).not.toEqual(ROUTE_TRACKING_KEY("go", "1", 0));
  });

  it("shares one renewal timer across two acquirers of the same key", async () => {
    const snapshot = makeTrackingData("v1");
    fetchRouteTrackingMock.mockResolvedValue(snapshot);

    const first = acquireRouteTracking({ agencyId: "ttc", routeId: "504", directionId: 0 });
    const second = acquireRouteTracking({ agencyId: "ttc", routeId: "504", directionId: 0 });

    // Single mount-time prime for both subscribers (cache was empty)...
    expect(fetchRouteTrackingMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    // ...whose result reaches BOTH accessors through the cache subscription.
    expect(first.data()).toBe(snapshot);
    expect(second.data()).toBe(snapshot);

    // One tick = exactly one network call despite two live subscribers.
    await vi.advanceTimersByTimeAsync(ROUTE_TRACKING_RENEWAL_MS);
    await flushMicrotasks();
    expect(fetchRouteTrackingMock).toHaveBeenCalledTimes(2);

    // Renewal continues while any subscriber remains.
    first.release();
    await vi.advanceTimersByTimeAsync(ROUTE_TRACKING_RENEWAL_MS);
    await flushMicrotasks();
    expect(fetchRouteTrackingMock).toHaveBeenCalledTimes(3);

    // ...and stops once the last one releases.
    second.release();
    await vi.advanceTimersByTimeAsync(ROUTE_TRACKING_RENEWAL_MS * 5);
    await flushMicrotasks();
    expect(fetchRouteTrackingMock).toHaveBeenCalledTimes(3);
  });

  it("stops renewal at zero subscribers and restarts on re-acquire", async () => {
    fetchRouteTrackingMock.mockResolvedValue(makeTrackingData("v1"));

    const handle = acquireRouteTracking({ agencyId: "ttc", routeId: "1", directionId: 0 });
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(fetchRouteTrackingMock).toHaveBeenCalledTimes(1);

    handle.release();
    await vi.advanceTimersByTimeAsync(ROUTE_TRACKING_RENEWAL_MS * 3);
    await flushMicrotasks();
    expect(fetchRouteTrackingMock).toHaveBeenCalledTimes(1);

    // Re-acquiring starts a fresh lifecycle; the aged-out snapshot is stale,
    // so the mount-time prime goes back to the network.
    const reacquired = acquireRouteTracking({ agencyId: "ttc", routeId: "1", directionId: 0 });
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(fetchRouteTrackingMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(ROUTE_TRACKING_RENEWAL_MS);
    await flushMicrotasks();
    expect(fetchRouteTrackingMock).toHaveBeenCalledTimes(3);

    reacquired.release();
  });

  it("keeps the last good snapshot when renewals fail", async () => {
    const good = makeTrackingData("good");
    queryClient.setQueryData(ROUTE_TRACKING_KEY("ttc", "504", 0), good);
    fetchRouteTrackingMock.mockRejectedValue(new Error("RPC down"));

    const handle = acquireRouteTracking({ agencyId: "ttc", routeId: "504", directionId: 0 });
    // Fresh seed skips the prime; accessor sees the cached snapshot instantly.
    expect(handle.data()).toBe(good);
    expect(fetchRouteTrackingMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(ROUTE_TRACKING_RENEWAL_MS * 3);
    await flushMicrotasks();
    expect(handle.data()).toBe(good);

    handle.release();
  });

  it("propagates external cache writes to subscribed accessors reactively", () => {
    const primed = makeTrackingData("primed");
    const external = makeTrackingData("external");
    fetchRouteTrackingMock.mockResolvedValue(primed);

    createRoot((dispose) => {
      const seen: Array<RouteTrackingData | null> = [];
      const handle = acquireRouteTracking({ agencyId: "ttc", routeId: "504", directionId: 0 });
      createRenderEffect(
        () => handle.data(),
        (data) => {
          seen.push(data);
        },
      );
      expect(seen.at(-1)).toBeNull(); // empty cache at acquire time

      // Another surface (e.g. the targeted map) fetching/writing the same key.
      queryClient.setQueryData(ROUTE_TRACKING_KEY("ttc", "504", 0), external);
      flush();

      expect(seen.at(-1)).toBe(external);

      handle.release();
      dispose();
    });
  });

  it("renews on the canonical 10-second cadence", async () => {
    fetchRouteTrackingMock.mockResolvedValue(makeTrackingData("v1"));

    const handle = acquireRouteTracking({ agencyId: "ttc", routeId: "504", directionId: 0 });
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(fetchRouteTrackingMock).toHaveBeenCalledTimes(1);

    // No tick before the full renewal window elapses...
    await vi.advanceTimersByTimeAsync(ROUTE_TRACKING_RENEWAL_MS - 1);
    expect(fetchRouteTrackingMock).toHaveBeenCalledTimes(1);

    // ...then exactly one tick lands on the 10s boundary.
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(fetchRouteTrackingMock).toHaveBeenCalledTimes(2);

    handle.release();
  });

  it("pauses renewal while the page is hidden and refreshes once on return", async () => {
    fetchRouteTrackingMock.mockResolvedValue(makeTrackingData("v1"));
    const handle = acquireRouteTracking({ agencyId: "ttc", routeId: "504", directionId: 0 });
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(fetchRouteTrackingMock).toHaveBeenCalledTimes(1);

    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(ROUTE_TRACKING_RENEWAL_MS * 6);
    await flushMicrotasks();
    expect(fetchRouteTrackingMock).toHaveBeenCalledTimes(1);

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await flushMicrotasks();
    expect(fetchRouteTrackingMock).toHaveBeenCalledTimes(2);

    visibility.mockRestore();
    handle.release();
  });

  it("isolates renewal lifecycles across different keys", async () => {
    fetchRouteTrackingMock.mockResolvedValue(makeTrackingData("v1"));

    const king = acquireRouteTracking({ agencyId: "ttc", routeId: "504", directionId: 0 });
    const queen = acquireRouteTracking({ agencyId: "ttc", routeId: "1", directionId: 0 });

    // Independent mount-time primes: exactly one network call per key.
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    await vi.waitFor(() => expect(fetchRouteTrackingMock).toHaveBeenCalledTimes(2));
    expect(networkCallsFor("504")).toBe(1);
    expect(networkCallsFor("1")).toBe(1);

    // Each key ticks on its own interval — one renewal call each per window.
    await vi.advanceTimersByTimeAsync(ROUTE_TRACKING_RENEWAL_MS);
    await flushMicrotasks();
    expect(networkCallsFor("504")).toBe(2);
    expect(networkCallsFor("1")).toBe(2);

    // Releasing one key's last subscriber stops only that key's timer.
    king.release();
    await vi.advanceTimersByTimeAsync(ROUTE_TRACKING_RENEWAL_MS);
    await flushMicrotasks();
    expect(networkCallsFor("504")).toBe(2);
    expect(networkCallsFor("1")).toBe(3);

    queen.release();
  });

  it("treats repeated release as idempotent", async () => {
    fetchRouteTrackingMock.mockResolvedValue(makeTrackingData("v1"));

    const handle = acquireRouteTracking({ agencyId: "ttc", routeId: "504", directionId: 0 });
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    await vi.waitFor(() => expect(fetchRouteTrackingMock).toHaveBeenCalledTimes(1));
    expect(fetchRouteTrackingMock).toHaveBeenCalledTimes(1);

    handle.release();
    handle.release();

    // Age the snapshot past staleTime so a later prime must hit the network;
    // the silent second release must have left no zombie timer behind.
    await vi.advanceTimersByTimeAsync(ROUTE_TRACKING_RENEWAL_MS * 3);
    await flushMicrotasks();
    expect(fetchRouteTrackingMock).toHaveBeenCalledTimes(1);

    // A subsequent acquire starts a clean lifecycle: fresh prime, then ticks.
    const reacquired = acquireRouteTracking({ agencyId: "ttc", routeId: "504", directionId: 0 });
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(fetchRouteTrackingMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(ROUTE_TRACKING_RENEWAL_MS);
    await flushMicrotasks();
    expect(fetchRouteTrackingMock).toHaveBeenCalledTimes(3);

    reacquired.release();
  });
});
