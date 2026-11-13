import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

import {
  activeCancelledTripIds,
  cancelledTripsSources,
  dropCancelledTrips,
  fetchCancelledTripIds,
} from "~/infrastructure/realtime/cancelledTrips";
import { logger } from "~/infrastructure/logging/logger";
import { decodeGtfsRealtimeSync } from "~/infrastructure/realtime/gtfsRealtimeDecoder";
import {
  AlertTripRoutesError,
  resolveAlertTripRoutes,
} from "~/infrastructure/realtime/gtfsTripDescriptor";
import { concatBuffers, encodeAlertEntity, encodeFeed } from "../helpers/gtfs-rt-binary";

const NOW = 1_800_000_000_000;
const NOW_SEC = NOW / 1000;

const cancellation = (id: string, tripId: string, window: { startSec?: number; endSec?: number }) =>
  encodeAlertEntity({ id, selectors: [{ tripId }], effect: 1, ...window });

describe("cancelled trips from an alerts feed", () => {
  it("collects trips only from NO_SERVICE alerts in force now", () => {
    const feed = decodeGtfsRealtimeSync(
      encodeFeed(NOW_SEC, [
        cancellation("active", "t1", { startSec: NOW_SEC - 600, endSec: NOW_SEC + 600 }),
        cancellation("open-ended", "t2", { startSec: NOW_SEC - 600 }),
        cancellation("expired", "t3", { startSec: NOW_SEC - 7200, endSec: NOW_SEC - 600 }),
        encodeAlertEntity({
          id: "other-effect",
          selectors: [{ tripId: "t4" }],
          effect: 7,
          startSec: NOW_SEC - 600,
        }),
      ]),
    );
    expect([...activeCancelledTripIds(feed, NOW)]).toEqual(["t1", "t2"]);
  });

  it("does not let an alert for a later period remove today's predictions", () => {
    // Trip ids repeat across days, so a cancellation published for tomorrow
    // must stay silent until it is in force.
    const feed = decodeGtfsRealtimeSync(
      encodeFeed(NOW_SEC, [
        cancellation("tomorrow", "t1", {
          startSec: NOW_SEC + 24 * 3600,
          endSec: NOW_SEC + 30 * 3600,
        }),
      ]),
    );
    expect(activeCancelledTripIds(feed, NOW).size).toBe(0);
    expect(activeCancelledTripIds(feed, NOW + 25 * 3600 * 1000).has("t1")).toBe(true);
  });

  it("removes cancelled trips from predictions and leaves the rest", () => {
    const predictions = [{ tripId: "t1" }, { tripId: "t2" }];
    expect(dropCancelledTrips(predictions, new Set(["t1"]))).toEqual([{ tripId: "t2" }]);
    expect(dropCancelledTrips(predictions, new Set())).toBe(predictions);
  });

  it("reads the sources feeds declare and skips feeds that declare none", () => {
    expect(
      cancelledTripsSources([
        { cancelledTripsFrom: "https://example.test/alerts.pb", accept: "*/*" },
        {},
      ]),
    ).toEqual([{ url: "https://example.test/alerts.pb", auth: undefined, accept: "*/*" }]);
  });

  it("fails open when the alerts feed cannot be read, so predictions stay unfiltered", async () => {
    const fetchStub = vi.fn(async () => new Response("unavailable", { status: 503 }));
    const cancelled = await Effect.runPromise(
      fetchCancelledTripIds(
        [{ url: "https://example.test/alerts.pb" }],
        { fetch: fetchStub as unknown as typeof fetch, attempts: 1 },
        () => NOW,
      ),
    );
    expect(cancelled.size).toBe(0);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("keeps the cancellations that decode when a malformed entity is skipped, and logs the skip once", async () => {
    const truncatedTail = new Uint8Array([0x12, 0x40, 0x0a]);
    const feed = concatBuffers(
      encodeFeed(NOW_SEC, [
        cancellation("active", "t1", { startSec: NOW_SEC - 600, endSec: NOW_SEC + 600 }),
      ]),
      truncatedTail,
    );
    const fetchStub = vi.fn(async () => new Response(new Uint8Array(feed)));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const cancelled = await Effect.runPromise(
      fetchCancelledTripIds(
        [{ url: "https://example.test/alerts.pb" }],
        { fetch: fetchStub as unknown as typeof fetch, attempts: 1 },
        () => NOW,
      ),
    );

    expect([...cancelled]).toEqual(["t1"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "cancelled-trip feed skipped malformed entities",
      expect.objectContaining({ droppedEntities: 1 }),
    );
    warn.mockRestore();
  });
});

describe("alert trip route lookup", () => {
  const bytes = encodeFeed(NOW_SEC, [
    encodeAlertEntity({ id: "a", selectors: [{ tripId: "t1" }, { tripId: "t2" }], effect: 1 }),
  ]);

  it("asks only for the trips alerts name without a route of their own", async () => {
    const asked: string[][] = [];
    await Effect.runPromise(
      resolveAlertTripRoutes(bytes, (ids) => {
        asked.push([...ids]);
        return Effect.succeed(new Map());
      }),
    );
    expect(asked).toEqual([["t1", "t2"]]);
  });

  it("fails with a tagged error when the lookup fails", async () => {
    const error = await Effect.runPromise(
      Effect.flip(resolveAlertTripRoutes(bytes, () => Effect.fail(new Error("no database")))),
    );
    expect(error).toBeInstanceOf(AlertTripRoutesError);
    expect(error.message).toBe("no database");
  });
});
