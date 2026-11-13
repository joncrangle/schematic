import { describe, expect, it } from "vitest";
import { decodeStationTripUpdates } from "~/infrastructure/realtime/stationTripDecoder";
import { encodeFeed, encodeSubwayTripUpdateEntity } from "../helpers/gtfs-rt-binary";

describe("station trip decoder", () => {
  it("filters decoded stop updates to the declared station platform ids", () => {
    const bytes = encodeFeed(1_700_000_000, [
      encodeSubwayTripUpdateEntity({
        entityId: "subway-target|East",
        routeId: "2",
        stopId: "TARGET",
        arrivalTimeSec: 1_700_000_300,
      }),
      encodeSubwayTripUpdateEntity({
        entityId: "subway-irrelevant|East",
        routeId: "2",
        stopId: "IRRELEVANT",
        arrivalTimeSec: 1_700_000_360,
      }),
    ]);

    const arrivals = decodeStationTripUpdates(bytes, new Set(["TARGET"]));

    expect(arrivals.map((arrival) => arrival.stopId)).toEqual(["TARGET"]);
  });

  it("carries the stop headsign destination and omits it when the feed has none", () => {
    const bytes = encodeFeed(1_700_000_000, [
      encodeSubwayTripUpdateEntity({
        entityId: "subway-target|East",
        routeId: "2",
        stopId: "TARGET",
        arrivalTimeSec: 1_700_000_300,
        stopHeadsign: "Kennedy",
      }),
      encodeSubwayTripUpdateEntity({
        entityId: "subway-quiet|East",
        routeId: "2",
        stopId: "QUIET",
        arrivalTimeSec: 1_700_000_360,
      }),
    ]);

    const arrivals = decodeStationTripUpdates(bytes);

    expect(arrivals.map((arrival) => arrival.headsign)).toEqual(["Kennedy", undefined]);
  });

  it("tolerates demand-response junk entities without failing the feed", () => {
    // GRT intermittently publishes route 999 / stops 94000-94004 entities
    // that exist in no static file. They decode as ordinary predictions;
    // station panels ignore them via platform-id filtering downstream.
    const bytes = encodeFeed(1_700_000_000, [
      encodeSubwayTripUpdateEntity({
        entityId: "junk-trip",
        tripId: "junk-trip",
        routeId: "999",
        stopId: "94000",
        arrivalTimeSec: 1_700_000_300,
      }),
      encodeSubwayTripUpdateEntity({
        entityId: "real-trip",
        tripId: "real-trip",
        routeId: "301",
        stopId: "6001",
        arrivalTimeSec: 1_700_000_360,
      }),
    ]);

    const arrivals = decodeStationTripUpdates(bytes);

    expect(arrivals.map((arrival) => arrival.routeId)).toEqual(["999", "301"]);
    expect(
      decodeStationTripUpdates(bytes, new Set(["6001"])).map((arrival) => arrival.stopId),
    ).toEqual(["6001"]);
  });
});

describe("duplicate trip cancellations", () => {
  it.each([false, true])(
    "a cancellation removes repeated predictions in either entity order: %s",
    async (reverse) => {
      const { concatBuffers, encodeMessage, encodeString, encodeVarintField } =
        await import("../helpers/gtfs-rt-binary");
      const { decodeGtfsRealtimeSync } =
        await import("~/infrastructure/realtime/gtfsRealtimeDecoder");
      const scheduled = encodeSubwayTripUpdateEntity({
        entityId: "scheduled",
        tripId: "trip-a",
        routeId: "A",
        stopId: "stop-a",
        arrivalTimeSec: 1700000300,
      });
      const cancellation = encodeMessage(
        2,
        concatBuffers(
          encodeString(1, "cancelled"),
          encodeMessage(
            3,
            encodeMessage(
              1,
              concatBuffers(
                encodeString(1, "trip-a"),
                encodeString(5, "A"),
                encodeVarintField(4, 3),
              ),
            ),
          ),
        ),
      );
      const other = encodeSubwayTripUpdateEntity({
        entityId: "other",
        tripId: "trip-b",
        routeId: "A",
        stopId: "stop-a",
        arrivalTimeSec: 1700000400,
      });
      const entities = reverse
        ? [cancellation, scheduled, other]
        : [scheduled, cancellation, other];
      const bytes = encodeFeed(1700000000, entities);
      expect(decodeStationTripUpdates(bytes).map((a) => a.tripId)).toEqual(["trip-b"]);
      expect(decodeGtfsRealtimeSync(bytes).tripUpdates.map((a) => a.tripId)).toEqual(["trip-b"]);
    },
  );
});
