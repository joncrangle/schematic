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
  cancelledTripIds,
  resolveAlertTripRoutes,
} from "~/infrastructure/realtime/gtfsTripDescriptor";
import {
  concatBuffers,
  encodeAlertEntity,
  encodeFeed,
  encodeMessage,
  encodeString,
  encodeVarintField,
} from "../helpers/gtfs-rt-binary";

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

describe("feed-wide trip descriptor scans", () => {
  const descriptor = (tripId: string, ...fields: Uint8Array[]) =>
    concatBuffers(encodeString(1, tripId), ...fields);
  const tripUpdate = (entityId: string, trip: Uint8Array) =>
    encodeMessage(
      2,
      concatBuffers(encodeString(1, entityId), encodeMessage(3, encodeMessage(1, trip))),
    );

  it.each([
    ["the only relationship is canceled", [3], true],
    ["a later relationship replaces canceled", [3, 0], false],
    ["a later relationship is canceled", [0, 3], true],
  ])("reads cancellation when %s", (_name, relationships, cancelled) => {
    const feed = encodeFeed(NOW_SEC, [
      tripUpdate("e1", descriptor("t1", ...relationships.map((v) => encodeVarintField(4, v)))),
    ]);

    expect(cancelledTripIds(feed).has("t1")).toBe(cancelled);
  });

  it("drops a cancellation from an entity whose modified trip cannot be parsed", () => {
    const brokenSelector = encodeMessage(7, new Uint8Array([0x12, 0x40]));
    const entity = encodeMessage(
      2,
      concatBuffers(
        encodeMessage(3, encodeMessage(1, descriptor("t1", encodeVarintField(4, 3)))),
        encodeMessage(3, encodeMessage(1, descriptor("t2", brokenSelector))),
      ),
    );
    const feed = encodeFeed(NOW_SEC, [
      entity,
      tripUpdate("e2", descriptor("t3", encodeVarintField(4, 3))),
    ]);

    expect([...cancelledTripIds(feed)]).toEqual(["t3"]);
  });
});
