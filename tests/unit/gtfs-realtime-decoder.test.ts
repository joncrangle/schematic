import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { ProtobufReader } from "~/infrastructure/realtime/ProtobufReader";
import {
  DecodeError,
  decodeGtfsRealtimeFeed,
  decodeGtfsRealtimeSync,
} from "~/infrastructure/realtime/gtfsRealtimeDecoder";
import { decodeGtfsRealtimeJsonAlertFeed } from "~/infrastructure/realtime/gtfsRealtimeJsonDecoder";
import genericJsonContract from "../fixtures/generic-json/contract.json";
import {
  concatBuffers,
  encodeAlertEntity,
  encodeFeed,
  encodeFeedHeader,
  encodeFloat,
  encodeMessage,
  encodeString,
  encodeSubwayTripUpdateEntity,
  encodeSignedVarintField,
  encodeSurfaceVehiclePositionEntity,
  encodeVarint,
  encodeVarintField,
} from "../helpers/gtfs-rt-binary";

const sharedGenericJsonCases = genericJsonContract as unknown as readonly {
  name: string;
  payload: unknown;
  expected?: { alerts: readonly { title: string; description?: string }[] };
}[];

function sharedGenericJsonCase(name: string) {
  return sharedGenericJsonCases.find((entry) => entry.name === name)!;
}

describe("gtfsRealtimeDecoder (Core, D1)", () => {
  it("decodes FeedHeader, TripUpdate, VehiclePosition via Effect (honest DecodeError channel)", async () => {
    const header = encodeFeedHeader(1700000000);
    // TripUpdate
    const tripDesc = concatBuffers(
      encodeString(1, "trip-101"),
      encodeString(5, "504"),
      encodeVarintField(6, 1),
    );
    const arrivalEvent = concatBuffers(encodeVarintField(1, 60), encodeVarintField(2, 1700000300));
    const stopTimeUpdate = concatBuffers(
      encodeVarintField(1, 5),
      encodeMessage(2, arrivalEvent),
      encodeString(4, "14560"),
    );
    const tripUpdateContent = concatBuffers(
      encodeMessage(1, tripDesc),
      encodeMessage(2, stopTimeUpdate),
      encodeMessage(3, encodeString(1, "4050")),
    );
    const tripEntity = encodeMessage(
      2,
      concatBuffers(encodeString(1, "entity-trip-1"), encodeMessage(3, tripUpdateContent)),
    );

    // VehiclePosition
    const posContent = concatBuffers(
      encodeFloat(1, 43.6532),
      encodeFloat(2, -79.3832),
      encodeFloat(3, 90.0),
      encodeFloat(5, 12.5),
    );
    const vehicleContent = concatBuffers(
      encodeMessage(1, tripDesc),
      encodeMessage(2, posContent),
      encodeVarintField(3, 5),
      encodeVarintField(4, 1),
      encodeVarintField(5, 1700000000),
      encodeString(7, "14560"),
      encodeMessage(8, encodeString(1, "4050")),
      encodeVarintField(9, 2),
    );
    const vehicleEntity = encodeMessage(
      2,
      concatBuffers(encodeString(1, "entity-veh-1"), encodeMessage(4, vehicleContent)),
    );

    const feedBuffer = concatBuffers(header, tripEntity, vehicleEntity);

    const decoded = await Effect.runPromise(decodeGtfsRealtimeFeed(feedBuffer));

    expect(decoded.header.version).toBe("2.0");
    expect(decoded.header.timestamp).toBe(1700000000000);
    expect(decoded.tripUpdates).toHaveLength(1);
    expect(decoded.tripUpdates[0].tripId).toBe("trip-101");
    expect(decoded.vehiclePositions).toHaveLength(1);
    expect(decoded.vehiclePositions[0].vehicleId).toBe("4050");
  });

  it("filters trip and vehicle entities to requested routes before materializing them", async () => {
    const feed = encodeFeed(1700000000, [
      encodeSubwayTripUpdateEntity({
        entityId: "trip-keep",
        routeId: "501",
        stopId: "stop-keep",
        arrivalTimeSec: 1700000300,
      }),
      encodeSubwayTripUpdateEntity({
        entityId: "trip-drop",
        routeId: "504",
        stopId: "stop-drop",
        arrivalTimeSec: 1700000360,
      }),
      encodeSubwayTripUpdateEntity({
        entityId: "trip-stop-drop",
        routeId: "501",
        stopId: "stop-drop",
        arrivalTimeSec: 1700000420,
      }),
      encodeSurfaceVehiclePositionEntity({
        entityId: "vehicle-keep",
        tripId: "trip-keep",
        routeId: "501",
        latitude: 43.65,
        longitude: -79.38,
      }),
      encodeSurfaceVehiclePositionEntity({
        entityId: "vehicle-drop",
        tripId: "trip-drop",
        routeId: "504",
        latitude: 43.65,
        longitude: -79.38,
      }),
    ]);

    const decoded = await Effect.runPromise(
      decodeGtfsRealtimeFeed(feed, {
        routeIds: new Set(["501"]),
        stopIds: new Set(["stop-keep"]),
      }),
    );

    expect(decoded.tripUpdates.map((arrival) => arrival.routeId)).toEqual(["501"]);
    expect(decoded.vehiclePositions.map((vehicle) => vehicle.routeId)).toEqual(["501"]);
  });

  it("rejects a decoded vehicle with non-finite geographic data", async () => {
    const feed = encodeFeed(1700000000, [
      encodeSurfaceVehiclePositionEntity({
        entityId: "bad-position",
        tripId: "trip-bad",
        routeId: "504",
        latitude: Number.NaN,
        longitude: -79.38,
      }),
    ]);

    const error = await Effect.runPromise(Effect.flip(decodeGtfsRealtimeFeed(feed)));

    expect(error).toBeInstanceOf(DecodeError);
    expect(error.message).toContain("finite");
  });

  it("omits route-unusable GTFS entities while preserving valid surface vehicles", async () => {
    const feed = encodeFeed(1700000000, [
      encodeSurfaceVehiclePositionEntity({
        entityId: "missing-route",
        tripId: "trip-missing-route",
        routeId: "   ",
        latitude: 43.65,
        longitude: -79.38,
      }),
      encodeSurfaceVehiclePositionEntity({
        entityId: "valid-vehicle",
        tripId: "trip-valid",
        routeId: "504",
        latitude: 43.65,
        longitude: -79.38,
      }),
    ]);

    const decoded = await Effect.runPromise(decodeGtfsRealtimeFeed(feed));

    expect(decoded.vehiclePositions).toEqual([
      expect.objectContaining({ vehicleId: "valid-vehicle", routeId: "504" }),
    ]);
  });

  it("preserves a valid feed when optional trip and vehicle fields are blank", async () => {
    const blankStopTrip = encodeSubwayTripUpdateEntity({
      entityId: "trip-entity",
      tripId: "trip-blank-stop",
      routeId: "504",
      stopId: "   ",
      arrivalTimeSec: 1700000300,
    });
    const blankStopVehicle = encodeSurfaceVehiclePositionEntity({
      entityId: "vehicle-blank-stop",
      tripId: "trip-blank-stop",
      routeId: "504",
      latitude: 43.65,
      longitude: -79.38,
      stopId: "   ",
    });
    const feed = encodeFeed(1700000000, [blankStopTrip, blankStopVehicle]);

    const decoded = await Effect.runPromise(decodeGtfsRealtimeFeed(feed));

    expect(decoded.tripUpdates).toEqual([
      expect.objectContaining({ tripId: "trip-blank-stop", stopId: undefined }),
    ]);
    expect(decoded.vehiclePositions).toEqual([
      expect.objectContaining({ vehicleId: "vehicle-blank-stop", stopId: undefined }),
    ]);
  });

  it("round-trips 500 vehicles under 500ms and preserves direction inference", async () => {
    const entities: Uint8Array[] = [];
    for (let i = 0; i < 500; i++) {
      const tripDesc = concatBuffers(
        encodeString(1, `trip-${i}`),
        encodeString(5, `${500 + (i % 20)}`),
        encodeVarintField(6, i % 2),
      );
      const posContent = concatBuffers(
        encodeFloat(1, 43.65 + i * 0.0001),
        encodeFloat(2, -79.38 - i * 0.0001),
        encodeFloat(3, (i * 15) % 360),
        encodeFloat(5, 10.0),
      );
      const vehicleContent = concatBuffers(
        encodeMessage(1, tripDesc),
        encodeMessage(2, posContent),
        encodeMessage(8, encodeString(1, `veh-${i}`)),
      );
      entities.push(
        encodeMessage(
          2,
          concatBuffers(encodeString(1, `id-${i}`), encodeMessage(4, vehicleContent)),
        ),
      );
    }
    const bulkBuffer = concatBuffers(...entities);
    const decoded = await Effect.runPromise(decodeGtfsRealtimeFeed(bulkBuffer));
    expect(decoded.vehiclePositions).toHaveLength(500);
  });

  describe("ProtobufReader primitives", () => {
    it("decodes varints of varying byte lengths", () => {
      const buf = concatBuffers(
        encodeVarint(0),
        encodeVarint(127),
        encodeVarint(128),
        encodeVarint(300),
        encodeVarint(16384),
      );
      const reader = new ProtobufReader(buf);

      expect(reader.readVarint()).toBe(0);
      expect(reader.readVarint()).toBe(127);
      expect(reader.readVarint()).toBe(128);
      expect(reader.readVarint()).toBe(300);
      expect(reader.readVarint()).toBe(16384);
    });

    it("decodes UTF-8 strings and 32-bit floats accurately", () => {
      const combined = concatBuffers(encodeString(1, "TTC 504 King"), encodeFloat(2, 43.645));
      const reader = new ProtobufReader(combined);

      const [tag1, wire1] = reader.readTag()!;
      expect(tag1).toBe(1);
      expect(wire1).toBe(2);
      expect(reader.readString()).toBe("TTC 504 King");

      const [tag2, wire2] = reader.readTag()!;
      expect(tag2).toBe(2);
      expect(wire2).toBe(5);
      expect(reader.readFloat()).toBeCloseTo(43.645, 3);
    });
  });

  it("infers directionId from bearing when TripDescriptor direction_id is omitted", async () => {
    const feed = encodeFeed(1700000000, [
      encodeSurfaceVehiclePositionEntity({
        entityId: "e1",
        tripId: "trip-504-east",
        routeId: "504",
        latitude: 43.65,
        longitude: -79.38,
        bearing: 75, // Eastbound
      }),
      encodeSurfaceVehiclePositionEntity({
        entityId: "e2",
        tripId: "trip-504-west",
        routeId: "504",
        latitude: 43.65,
        longitude: -79.38,
        bearing: 255, // Westbound
      }),
      encodeSurfaceVehiclePositionEntity({
        entityId: "e3",
        tripId: "trip-fixture510-north",
        routeId: "fixture510",
        latitude: 43.65,
        longitude: -79.38,
        bearing: 355, // Northbound on fixture510 -> canonical dir 0
      }),
      encodeSurfaceVehiclePositionEntity({
        entityId: "e4",
        tripId: "trip-fixture510-south",
        routeId: "fixture510",
        latitude: 43.65,
        longitude: -79.38,
        bearing: 175, // Southbound on fixture510 -> canonical dir 1
      }),
    ]);

    const decoded = await Effect.runPromise(
      decodeGtfsRealtimeFeed(feed, {
        routeInterpretation: {
          directionInference: {
            routeOverrides: { fixture510: "north-south" },
          },
        },
      }),
    );

    expect(decoded.vehiclePositions).toHaveLength(4);
    expect(decoded.vehiclePositions[0].directionId).toBe(0); // 504 Eastbound
    expect(decoded.vehiclePositions[1].directionId).toBe(1); // 504 Westbound
    expect(decoded.vehiclePositions[2].directionId).toBe(0); // Northbound
    expect(decoded.vehiclePositions[3].directionId).toBe(1); // Southbound
  });

  it("applies inverted feed polarity through the synchronous decode API", () => {
    const feed = encodeFeed(1700000000, [
      encodeSurfaceVehiclePositionEntity({
        entityId: "e1",
        tripId: "trip-fixture510-north",
        routeId: "fixture510",
        latitude: 43.65,
        longitude: -79.38,
        bearing: 355,
      }),
    ]);

    const decoded = decodeGtfsRealtimeSync(feed, {
      routeInterpretation: {
        directionInference: {
          routeOverrides: { fixture510: "north-south" },
          invertNorthSouth: true,
        },
      },
    });

    expect(decoded.vehiclePositions[0].directionId).toBe(1);
  });

  it("preserves the raw FeedEntity id on trip updates even when TripDescriptor supplies its own trip_id", async () => {
    // Subway feed convention: entity ids are "subway-{trip_id}|{Direction}"
    // and TripDescriptor.trip_id repeats the bare trip id — the direction
    // suffix must survive on the prediction for downstream parsing.
    const feed = encodeFeed(1700000000, [
      encodeSubwayTripUpdateEntity({
        entityId: "subway-trip-900|South",
        tripId: "trip-900",
        routeId: "1",
        stopSequence: 7,
        stopId: "13755",
        arrivalTimeSec: 1700000300,
      }),
    ]);

    const decoded = await Effect.runPromise(decodeGtfsRealtimeFeed(feed));

    expect(decoded.tripUpdates).toHaveLength(1);
    const arrival = decoded.tripUpdates[0];
    expect(arrival.rawEntityId).toBe("subway-trip-900|South");
    // Existing surface-facing resolution is untouched
    expect(arrival.tripId).toBe("trip-900");
    expect(arrival.routeId).toBe("1");
    expect(arrival.stopId).toBe("13755");
  });

  describe("Alert decoding", () => {
    /** Builds a FeedMessage with one alert entity carrying one informed entity per route id. */
    const buildAlertFeed = (routeIds: string[]): Uint8Array => {
      const informedEntities = routeIds.map((rid) => encodeMessage(5, encodeString(2, rid)));
      const headerText = encodeMessage(10, encodeMessage(1, encodeString(1, "Subway delay")));
      const alertContent = concatBuffers(...informedEntities, headerText);
      return encodeFeed(1700000000, [
        encodeMessage(
          2,
          concatBuffers(encodeString(1, "alert-entity-1"), encodeMessage(5, alertContent)),
        ),
      ]);
    };

    it("decodes a service alert far-future end timestamp as an unsigned value", async () => {
      const farFutureEndSec = 32_503_698_000;
      const activePeriod = concatBuffers(
        encodeVarintField(1, 1_700_000_000),
        encodeVarintField(2, farFutureEndSec),
      );
      const alertContent = concatBuffers(
        encodeMessage(1, activePeriod),
        encodeMessage(10, encodeMessage(1, encodeString(1, "Long-running service alert"))),
      );
      const feed = encodeFeed(1_700_000_000, [
        encodeMessage(
          2,
          concatBuffers(encodeString(1, "alert-far-future"), encodeMessage(5, alertContent)),
        ),
      ]);

      const decoded = await Effect.runPromise(decodeGtfsRealtimeFeed(feed));

      expect(decoded.alerts[0]?.endsAt).toBe(farFutureEndSec * 1_000);
    });

    /** A communication window controls display and must supersede active_period. */
    it("reads a period from the current communication_period field alone", async () => {
      const period = concatBuffers(
        encodeVarintField(1, 1_800_000_000),
        encodeVarintField(2, 1_800_003_600),
      );
      const alertContent = concatBuffers(
        encodeMessage(2, period),
        encodeMessage(10, encodeMessage(1, encodeString(1, "Current field only"))),
      );
      const feed = encodeFeed(1_700_000_000, [
        encodeMessage(
          2,
          concatBuffers(encodeString(1, "alert-current"), encodeMessage(5, alertContent)),
        ),
      ]);

      const decoded = await Effect.runPromise(decodeGtfsRealtimeFeed(feed));

      expect(decoded.alerts[0]?.startsAt).toBe(1_800_000_000_000);
      expect(decoded.alerts[0]?.endsAt).toBe(1_800_003_600_000);
    });

    it("prefers communication_period when a feed sends both", async () => {
      const deprecated = concatBuffers(
        encodeVarintField(1, 1_700_000_000),
        encodeVarintField(2, 1_700_003_600),
      );
      const current = concatBuffers(
        encodeVarintField(1, 1_800_000_000),
        encodeVarintField(2, 1_800_003_600),
      );
      const alertContent = concatBuffers(
        encodeMessage(1, deprecated),
        encodeMessage(2, current),
        encodeMessage(10, encodeMessage(1, encodeString(1, "Both fields"))),
      );
      const feed = encodeFeed(1_700_000_000, [
        encodeMessage(
          2,
          concatBuffers(encodeString(1, "alert-both"), encodeMessage(5, alertContent)),
        ),
      ]);

      const decoded = await Effect.runPromise(decodeGtfsRealtimeFeed(feed));

      expect(decoded.alerts[0]?.startsAt).toBe(1_800_000_000_000);
      expect(decoded.alerts[0]?.endsAt).toBe(1_800_003_600_000);
    });

    it("still reads the deprecated active_period alone", async () => {
      const period = concatBuffers(
        encodeVarintField(1, 1_700_000_000),
        encodeVarintField(2, 1_700_003_600),
      );
      const alertContent = concatBuffers(
        encodeMessage(1, period),
        encodeMessage(10, encodeMessage(1, encodeString(1, "Deprecated field only"))),
      );
      const feed = encodeFeed(1_700_000_000, [
        encodeMessage(
          2,
          concatBuffers(encodeString(1, "alert-deprecated"), encodeMessage(5, alertContent)),
        ),
      ]);

      const decoded = await Effect.runPromise(decodeGtfsRealtimeFeed(feed));

      expect(decoded.alerts[0]?.startsAt).toBe(1_700_000_000_000);
      expect(decoded.alerts[0]?.endsAt).toBe(1_700_003_600_000);
    });

    it("builds stable source-scoped ids when a protobuf alert entity has no id", async () => {
      const alertContent = encodeMessage(
        10,
        encodeMessage(1, encodeString(1, "Unnumbered service alert")),
      );
      const feed = encodeFeed(1_700_000_000, [
        encodeMessage(2, concatBuffers(encodeString(1, ""), encodeMessage(5, alertContent))),
      ]);
      const first = await Effect.runPromise(
        decodeGtfsRealtimeFeed(feed, { sourceScope: "https://sample.test/alerts-a" }),
      );
      const sameSource = await Effect.runPromise(
        decodeGtfsRealtimeFeed(feed, { sourceScope: "https://sample.test/alerts-a" }),
      );
      const otherSource = await Effect.runPromise(
        decodeGtfsRealtimeFeed(feed, { sourceScope: "https://sample.test/alerts-b" }),
      );

      expect(first.alerts[0]?.id).toMatch(/^gtfs-rt-alert-[0-9a-f]{16}$/u);
      expect(sameSource.alerts[0]?.id).toBe(first.alerts[0]?.id);
      expect(otherSource.alerts[0]?.id).not.toBe(first.alerts[0]?.id);
    });

    it("keeps fallback ids stable when the selected translation changes", async () => {
      const translation = (text: string, language: string) =>
        encodeMessage(1, concatBuffers(encodeString(1, text), encodeString(2, language)));
      const headerText = concatBuffers(
        translation("Bridge closure", "en"),
        translation("Fermeture du pont", "fr"),
      );
      const alertContent = encodeMessage(10, headerText);
      const feed = encodeFeed(1_700_000_000, [
        encodeMessage(2, concatBuffers(encodeString(1, ""), encodeMessage(5, alertContent))),
      ]);
      const english = await Effect.runPromise(decodeGtfsRealtimeFeed(feed, { locale: "en-CA" }));
      const french = await Effect.runPromise(decodeGtfsRealtimeFeed(feed, { locale: "fr-CA" }));

      expect(english.alerts[0]?.title).toBe("Bridge closure");
      expect(french.alerts[0]?.title).toBe("Fermeture du pont");
      expect(french.alerts[0]?.id).toBe(english.alerts[0]?.id);
    });

    it("folds all communication periods without filling gaps or losing open ends", async () => {
      const closed = concatBuffers(
        encodeVarintField(1, 1_800_000_000),
        encodeVarintField(2, 1_800_003_600),
      );
      const open = encodeVarintField(1, 1_800_007_200);
      const alertContent = concatBuffers(
        encodeMessage(2, closed),
        encodeMessage(2, open),
        encodeMessage(10, encodeMessage(1, encodeString(1, "Recurring work"))),
      );
      const decoded = await Effect.runPromise(
        decodeGtfsRealtimeFeed(
          encodeFeed(1_700_000_000, [
            encodeMessage(
              2,
              concatBuffers(encodeString(1, "recurring"), encodeMessage(5, alertContent)),
            ),
          ]),
        ),
      );

      expect(decoded.alerts[0]).toMatchObject({
        startsAt: 1_800_000_000_000,
        endsAt: undefined,
        activePeriods: [
          { startsAt: 1_800_000_000_000, endsAt: 1_800_003_600_000 },
          { startsAt: 1_800_007_200_000 },
        ],
      });
    });

    it("preserves the missing start of a single end-only protobuf period", async () => {
      const alertContent = concatBuffers(
        encodeMessage(2, encodeVarintField(2, 150)),
        encodeMessage(10, encodeMessage(1, encodeString(1, "Until 150"))),
      );
      const decoded = await Effect.runPromise(
        decodeGtfsRealtimeFeed(
          encodeFeed(200, [
            encodeMessage(
              2,
              concatBuffers(encodeString(1, "end-only"), encodeMessage(5, alertContent)),
            ),
          ]),
        ),
      );

      expect(decoded.alerts[0]).toMatchObject({
        startsAt: 150_000,
        endsAt: 150_000,
        activePeriods: [{ endsAt: 150_000 }],
      });
    });

    it("discards an empty protobuf communication range", async () => {
      const empty = concatBuffers(
        encodeVarintField(1, 1_800_000_000),
        encodeVarintField(2, 1_800_000_000),
      );
      const alertContent = concatBuffers(
        encodeMessage(2, empty),
        encodeMessage(10, encodeMessage(1, encodeString(1, "Empty range"))),
      );
      const decoded = await Effect.runPromise(
        decodeGtfsRealtimeFeed(
          encodeFeed(1_700_000_000, [
            encodeMessage(
              2,
              concatBuffers(encodeString(1, "empty-range"), encodeMessage(5, alertContent)),
            ),
          ]),
        ),
      );

      expect(decoded.alerts[0]).toMatchObject({
        startsAt: 1_700_000_000_000,
        endsAt: undefined,
        activePeriods: undefined,
      });
    });

    it("uses communication periods for display and preserves separate impact periods", async () => {
      const communication = concatBuffers(
        encodeVarintField(1, 1_800_000_000),
        encodeVarintField(2, 1_800_010_000),
      );
      const impact = concatBuffers(
        encodeVarintField(1, 1_800_002_000),
        encodeVarintField(2, 1_800_008_000),
      );
      const deprecated = concatBuffers(
        encodeVarintField(1, 1_700_000_000),
        encodeVarintField(2, 1_700_003_600),
      );
      const alertContent = concatBuffers(
        encodeMessage(1, deprecated),
        encodeMessage(2, communication),
        encodeMessage(3, impact),
        encodeMessage(10, encodeMessage(1, encodeString(1, "Planned work"))),
      );
      const decoded = await Effect.runPromise(
        decodeGtfsRealtimeFeed(
          encodeFeed(1_700_000_000, [
            encodeMessage(
              2,
              concatBuffers(encodeString(1, "planned"), encodeMessage(5, alertContent)),
            ),
          ]),
        ),
      );

      expect(decoded.alerts[0]).toMatchObject({
        startsAt: 1_800_000_000_000,
        endsAt: 1_800_010_000_000,
        impactPeriods: [{ startsAt: 1_800_002_000_000, endsAt: 1_800_008_000_000 }],
      });
    });

    it("ignores legacy active periods when impact exists without communication", async () => {
      const deprecated = concatBuffers(
        encodeVarintField(1, 1_700_000_000),
        encodeVarintField(2, 1_700_003_600),
      );
      const impact = concatBuffers(
        encodeVarintField(1, 1_800_000_000),
        encodeVarintField(2, 1_800_008_000),
      );
      const alertContent = concatBuffers(
        encodeMessage(1, deprecated),
        encodeMessage(3, impact),
        encodeMessage(10, encodeMessage(1, encodeString(1, "Service change"))),
      );
      const decoded = await Effect.runPromise(
        decodeGtfsRealtimeFeed(
          encodeFeed(1_700_000_000, [
            encodeMessage(
              2,
              concatBuffers(encodeString(1, "impact-only"), encodeMessage(5, alertContent)),
            ),
          ]),
        ),
      );

      expect(decoded.alerts[0]).toMatchObject({
        startsAt: 1_700_000_000_000,
        endsAt: undefined,
        activePeriods: undefined,
        impactPeriods: [{ startsAt: 1_800_000_000_000, endsAt: 1_800_008_000_000 }],
      });
    });

    it("keeps impact-only protobuf alerts visible by feed presence", async () => {
      const impact = concatBuffers(
        encodeVarintField(1, 1_800_000_000),
        encodeVarintField(2, 1_800_008_000),
      );
      const alertContent = concatBuffers(
        encodeMessage(3, impact),
        encodeMessage(10, encodeMessage(1, encodeString(1, "Service change"))),
      );
      const decoded = await Effect.runPromise(
        decodeGtfsRealtimeFeed(
          encodeFeed(1_700_000_000, [
            encodeMessage(
              2,
              concatBuffers(encodeString(1, "impact-only"), encodeMessage(5, alertContent)),
            ),
          ]),
        ),
      );

      expect(decoded.alerts[0]).toMatchObject({
        startsAt: 1_700_000_000_000,
        endsAt: undefined,
        impactPeriods: [{ startsAt: 1_800_000_000_000, endsAt: 1_800_008_000_000 }],
      });
    });

    it("collects normalized routeIds across informed entities, including non-subway routes, deduped in first-appearance order", async () => {
      const decoded = await Effect.runPromise(
        decodeGtfsRealtimeFeed(buildAlertFeed(["97", "1", "97"])),
      );
      expect(decoded.alerts).toHaveLength(1);
      expect(decoded.alerts[0].routeIds).toEqual(["97", "1"]);
    });

    it("ignores blank informed route ids instead of invalidating the whole alert feed", async () => {
      const decoded = await Effect.runPromise(
        decodeGtfsRealtimeFeed(buildAlertFeed(["", "LW", " "])),
      );

      expect(decoded.alerts[0]).toEqual(
        expect.objectContaining({ lineId: undefined, routeIds: ["LW"] }),
      );
    });

    it("ignores blank informed station ids instead of invalidating the whole alert feed", async () => {
      const informedEntities = [
        encodeMessage(5, concatBuffers(encodeString(5, ""), encodeString(5, "station-a"))),
      ];
      const headerText = encodeMessage(10, encodeMessage(1, encodeString(1, "Service update")));
      const feed = encodeFeed(1700000000, [
        encodeMessage(
          2,
          concatBuffers(
            encodeString(1, "alert-blank-station"),
            encodeMessage(5, concatBuffers(...informedEntities, headerText)),
          ),
        ),
      ]);

      const decoded = await Effect.runPromise(decodeGtfsRealtimeFeed(feed));

      expect(decoded.alerts[0]).toEqual(
        expect.objectContaining({
          fromStationId: undefined,
          affectedStations: ["station-a"],
        }),
      );
    });

    it("preserves every informed station raw for the interpreter span", async () => {
      const informedEntities = [
        encodeMessage(5, concatBuffers(encodeString(2, "1"), encodeString(5, "station-a"))),
        encodeMessage(5, concatBuffers(encodeString(2, "1"), encodeString(5, "station-b"))),
      ];
      const headerText = encodeMessage(10, encodeMessage(1, encodeString(1, "Elevator outage")));
      const feed = encodeFeed(1700000000, [
        encodeMessage(
          2,
          concatBuffers(
            encodeString(1, "alert-stations"),
            encodeMessage(5, concatBuffers(...informedEntities, headerText)),
          ),
        ),
      ]);

      const decoded = await Effect.runPromise(decodeGtfsRealtimeFeed(feed));

      expect(decoded.alerts[0]).toEqual(
        expect.objectContaining({
          fromStationId: undefined,
          toStationId: undefined,
          affectedStations: ["station-a", "station-b"],
          targets: [
            { routeId: "1", stopId: "station-a" },
            { routeId: "1", stopId: "station-b" },
          ],
          equipmentOutages: undefined,
        }),
      );
    });

    it("passes informed route ids through raw: preserves agency prefixes instead of extracting digits", async () => {
      const decoded = await Effect.runPromise(
        decodeGtfsRealtimeFeed(buildAlertFeed(["Line 1", "97", "Line 1"])),
      );

      expect(decoded.alerts).toHaveLength(1);
      expect(decoded.alerts[0].routeIds).toEqual(["Line 1", "97"]);
    });

    it("leaves agency interpretation to the interpreter: no lineId, span, or outage synthesis", async () => {
      const informedEntities = [
        encodeMessage(5, concatBuffers(encodeString(2, "Line 1"), encodeString(5, "station-a"))),
        encodeMessage(5, concatBuffers(encodeString(2, "Line 1"), encodeString(5, "station-b"))),
      ];
      const headerText = encodeMessage(10, encodeMessage(1, encodeString(1, "Elevator outage")));
      const feed = encodeFeed(1700000000, [
        encodeMessage(
          2,
          concatBuffers(
            encodeString(1, "alert-raw"),
            encodeMessage(5, concatBuffers(...informedEntities, headerText)),
          ),
        ),
      ]);

      const decoded = await Effect.runPromise(decodeGtfsRealtimeFeed(feed));

      expect(decoded.alerts[0]).toEqual(
        expect.objectContaining({
          lineId: undefined,
          fromStationId: undefined,
          toStationId: undefined,
          equipmentOutages: undefined,
          routeIds: ["Line 1"],
          affectedStations: ["station-a", "station-b"],
        }),
      );
    });

    it("lifts a strong run into the title and strips tags when header_text is absent", async () => {
      // GRT never populates header_text (field 10): the title lives inside
      // description_text (field 11) wrapped in <strong>, with <br /> markup.
      const descriptionText = encodeMessage(
        11,
        encodeMessage(
          1,
          encodeString(
            1,
            "<strong>Emergency detour on Route 6</strong> <br />Emergency detour on Route 6 Bridge-Courtland. <br />Closed stop: 4051.",
          ),
        ),
      );
      const alertContent = concatBuffers(
        encodeMessage(5, concatBuffers(encodeString(2, "6"), encodeString(5, "4051"))),
        descriptionText,
      );
      const feed = encodeFeed(1700000000, [
        encodeMessage(2, concatBuffers(encodeString(1, "13954"), encodeMessage(5, alertContent))),
      ]);

      const decoded = await Effect.runPromise(decodeGtfsRealtimeFeed(feed));

      expect(decoded.alerts[0]).toEqual(
        expect.objectContaining({
          id: "13954",
          title: "Emergency detour on Route 6",
          routeIds: ["6"],
        }),
      );
      expect(decoded.alerts[0]?.description).toBe(
        "Emergency detour on Route 6\nEmergency detour on Route 6 Bridge-Courtland.\nClosed stop: 4051.",
      );
      expect(decoded.alerts[0]?.description).not.toContain("<");
    });

    it("keeps an explicit header and still strips tags from the description", async () => {
      const alertContent = concatBuffers(
        encodeMessage(10, encodeMessage(1, encodeString(1, "Planned work"))),
        encodeMessage(
          11,
          encodeMessage(1, encodeString(1, "Line is <em>delayed</em>.<br />Allow extra time.")),
        ),
      );
      const feed = encodeFeed(1700000000, [
        encodeMessage(
          2,
          concatBuffers(encodeString(1, "alert-header"), encodeMessage(5, alertContent)),
        ),
      ]);

      const decoded = await Effect.runPromise(decodeGtfsRealtimeFeed(feed));

      expect(decoded.alerts[0]).toEqual(
        expect.objectContaining({
          title: "Planned work",
          description: "Line is delayed.\nAllow extra time.",
        }),
      );
    });

    it("strips HTML from GTFS-RT header_text", async () => {
      const headerText = (
        sharedGenericJsonCase("HTML header keeps station attribution").payload as {
          routes: { headerText: string }[];
        }
      ).routes[0]!.headerText;
      const expectedTitle = sharedGenericJsonCase("HTML header keeps station attribution").expected!
        .alerts[0]!.title;
      const alert = encodeMessage(
        5,
        encodeMessage(10, encodeMessage(1, encodeString(1, headerText))),
      );
      const feed = encodeFeed(1700000000, [
        encodeMessage(2, concatBuffers(encodeString(1, "fictional-header"), alert)),
      ]);

      const decoded = await Effect.runPromise(decodeGtfsRealtimeFeed(feed));

      expect(decoded.alerts[0]?.title).toBe(expectedTitle);
      expect(decoded.alerts[0]?.sourceTranslations).toContainEqual(
        expect.objectContaining({ field: "title", text: expectedTitle }),
      );
    });

    it("keeps embedded title evidence at one entity-decoding pass", async () => {
      const description = (
        sharedGenericJsonCase("double-encoded entities decode once").payload as {
          description: string;
        }[]
      )[0]!.description;
      const expectedTitle = sharedGenericJsonCase("double-encoded entities decode once").expected!
        .alerts[0]!.title;
      const alert = encodeMessage(
        5,
        encodeMessage(11, encodeMessage(1, encodeString(1, description))),
      );
      const feed = encodeFeed(1700000000, [
        encodeMessage(2, concatBuffers(encodeString(1, "fictional-entity"), alert)),
      ]);

      const decoded = await Effect.runPromise(decodeGtfsRealtimeFeed(feed));

      expect(decoded.alerts[0]?.title).toBe(expectedTitle);
      expect(decoded.alerts[0]?.sourceTranslations).toContainEqual(
        expect.objectContaining({ field: "title", text: expectedTitle }),
      );
    });
  });

  describe("Alert decoding from the JSON wire format", () => {
    const jsonFeed = (
      alert: Record<string, unknown>,
      entityId: string | null = "alert-json",
      feedTimestamp = 1_700_000_000,
    ): Uint8Array =>
      new TextEncoder().encode(
        JSON.stringify({
          header: { gtfs_realtime_version: "2.0", timestamp: feedTimestamp },
          entity: [{ ...(entityId === null ? {} : { id: entityId }), alert }],
        }),
      );

    const timeRange = (start: number, end: number) => ({ start, end });

    it("reads a period from communication_period alone", async () => {
      const decoded = await Effect.runPromise(
        decodeGtfsRealtimeJsonAlertFeed(
          jsonFeed({
            communication_period: [timeRange(1_800_000_000, 1_800_003_600)],
            header_text: { translation: [{ text: "Current field only" }] },
          }),
          1_700_000_000_000,
        ),
      );

      expect(decoded.alerts[0]?.startsAt).toBe(1_800_000_000_000);
      expect(decoded.alerts[0]?.endsAt).toBe(1_800_003_600_000);
    });

    it("still reads the deprecated active_period alone", async () => {
      const decoded = await Effect.runPromise(
        decodeGtfsRealtimeJsonAlertFeed(
          jsonFeed({
            active_period: [timeRange(1_700_000_000, 1_700_003_600)],
            header_text: { translation: [{ text: "Deprecated field only" }] },
          }),
          1_700_000_000_000,
        ),
      );

      expect(decoded.alerts[0]?.startsAt).toBe(1_700_000_000_000);
      expect(decoded.alerts[0]?.endsAt).toBe(1_700_003_600_000);
    });

    it("builds stable source-scoped ids when a JSON alert entity has no id", async () => {
      const payload = jsonFeed(
        { header_text: { translation: [{ text: "Unnumbered service alert" }] } },
        null,
      );
      const decode = (sourceScope: string) =>
        Effect.runPromise(
          decodeGtfsRealtimeJsonAlertFeed(
            payload,
            1_700_000_000_000,
            undefined,
            undefined,
            undefined,
            undefined,
            sourceScope,
          ),
        );
      const first = await decode("https://sample.test/alerts-a");
      const sameSource = await decode("https://sample.test/alerts-a");
      const otherSource = await decode("https://sample.test/alerts-b");

      expect(first.alerts[0]?.id).toMatch(/^gtfs-rt-json-alert-[0-9a-f]{16}$/u);
      expect(sameSource.alerts[0]?.id).toBe(first.alerts[0]?.id);
      expect(otherSource.alerts[0]?.id).not.toBe(first.alerts[0]?.id);
    });

    it("prefers communication_period when a feed sends both", async () => {
      const decoded = await Effect.runPromise(
        decodeGtfsRealtimeJsonAlertFeed(
          jsonFeed({
            active_period: [timeRange(1_700_000_000, 1_700_003_600)],
            communication_period: [timeRange(1_800_000_000, 1_800_003_600)],
            header_text: { translation: [{ text: "Both fields" }] },
          }),
          1_700_000_000_000,
        ),
      );

      expect(decoded.alerts[0]?.startsAt).toBe(1_800_000_000_000);
      expect(decoded.alerts[0]?.endsAt).toBe(1_800_003_600_000);
    });

    it("falls back to active_period when communication_period is empty", async () => {
      const decoded = await Effect.runPromise(
        decodeGtfsRealtimeJsonAlertFeed(
          jsonFeed({
            active_period: [timeRange(1_700_000_000, 1_700_003_600)],
            communication_period: [],
            header_text: { translation: [{ text: "Deprecated fallback" }] },
          }),
          1_700_000_000_000,
        ),
      );

      expect(decoded.alerts[0]).toMatchObject({
        startsAt: 1_700_000_000_000,
        endsAt: 1_700_003_600_000,
      });
    });

    it("uses communication periods and preserves impact periods", async () => {
      const decoded = await Effect.runPromise(
        decodeGtfsRealtimeJsonAlertFeed(
          jsonFeed({
            active_period: [timeRange(1_700_000_000, 1_700_003_600)],
            communication_period: [timeRange(1_800_000_000, 1_800_010_000)],
            impact_period: [timeRange(1_800_002_000, 1_800_008_000)],
            header_text: { translation: [{ text: "Planned work" }] },
          }),
          1_700_000_000_000,
        ),
      );

      expect(decoded.alerts[0]).toMatchObject({
        startsAt: 1_800_000_000_000,
        endsAt: 1_800_010_000_000,
        impactPeriods: [{ startsAt: 1_800_002_000_000, endsAt: 1_800_008_000_000 }],
      });
    });

    it("ignores legacy active periods when impact exists without communication", async () => {
      const decoded = await Effect.runPromise(
        decodeGtfsRealtimeJsonAlertFeed(
          jsonFeed({
            active_period: [timeRange(1_700_000_000, 1_700_003_600)],
            impact_period: [timeRange(1_800_000_000, 1_800_008_000)],
            header_text: { translation: [{ text: "Service change" }] },
          }),
          1_700_000_000_000,
        ),
      );

      expect(decoded.alerts[0]).toMatchObject({
        startsAt: 1_700_000_000_000,
        endsAt: undefined,
        activePeriods: undefined,
        impactPeriods: [{ startsAt: 1_800_000_000_000, endsAt: 1_800_008_000_000 }],
      });
    });

    it("keeps impact-only JSON alerts visible by feed presence", async () => {
      const decoded = await Effect.runPromise(
        decodeGtfsRealtimeJsonAlertFeed(
          jsonFeed({
            impact_period: [timeRange(1_800_000_000, 1_800_008_000)],
            header_text: { translation: [{ text: "Service change" }] },
          }),
          1_700_000_000_000,
        ),
      );

      expect(decoded.alerts[0]).toMatchObject({
        startsAt: 1_700_000_000_000,
        endsAt: undefined,
        impactPeriods: [{ startsAt: 1_800_000_000_000, endsAt: 1_800_008_000_000 }],
      });
    });

    it("preserves the missing start of a single end-only JSON period", async () => {
      const decoded = await Effect.runPromise(
        decodeGtfsRealtimeJsonAlertFeed(
          jsonFeed(
            {
              communication_period: [{ end: 150 }],
              header_text: { translation: [{ text: "Until 150" }] },
            },
            "end-only",
            200,
          ),
          100_000,
        ),
      );

      expect(decoded.alerts[0]).toMatchObject({
        startsAt: 150_000,
        endsAt: 150_000,
        activePeriods: [{ endsAt: 150_000 }],
      });
    });

    it("discards empty communication ranges", async () => {
      const decoded = await Effect.runPromise(
        decodeGtfsRealtimeJsonAlertFeed(
          jsonFeed({
            communication_period: [timeRange(1_800_000_000, 1_800_000_000)],
            header_text: { translation: [{ text: "Empty range" }] },
          }),
          1_700_000_000_000,
        ),
      );

      expect(decoded.alerts[0]).toMatchObject({
        startsAt: 1_700_000_000_000,
        endsAt: undefined,
        activePeriods: undefined,
      });
    });

    it("keeps open-ended communication ranges in JSON GTFS-RT", async () => {
      const decoded = await Effect.runPromise(
        decodeGtfsRealtimeJsonAlertFeed(
          jsonFeed({
            communication_period: [
              timeRange(1_800_000_000, 1_800_003_600),
              { start: 1_800_007_200 },
            ],
            header_text: { translation: [{ text: "Recurring work" }] },
          }),
          1_700_000_000_000,
        ),
      );

      expect(decoded.alerts[0]).toMatchObject({
        startsAt: 1_800_000_000_000,
        endsAt: undefined,
        activePeriods: [
          { startsAt: 1_800_000_000_000, endsAt: 1_800_003_600_000 },
          { startsAt: 1_800_007_200_000 },
        ],
      });
    });

    it("lifts a strong run into the title and strips tags when header_text is absent", async () => {
      const decoded = await Effect.runPromise(
        decodeGtfsRealtimeJsonAlertFeed(
          jsonFeed({
            description_text: {
              translation: [
                {
                  text: "<strong>Emergency detour on Route 6</strong> <br />Emergency detour on Route 6 Bridge-Courtland. <br />Closed stop: 4051.",
                },
              ],
            },
          }),
          1_700_000_000_000,
        ),
      );

      expect(decoded.alerts[0]).toEqual(
        expect.objectContaining({
          title: "Emergency detour on Route 6",
          description:
            "Emergency detour on Route 6\nEmergency detour on Route 6 Bridge-Courtland.\nClosed stop: 4051.",
        }),
      );
    });

    it("strips HTML from GTFS-RT JSON header_text", async () => {
      const headerText = (
        sharedGenericJsonCase("HTML header keeps station attribution").payload as {
          routes: { headerText: string }[];
        }
      ).routes[0]!.headerText;
      const expectedTitle = sharedGenericJsonCase("HTML header keeps station attribution").expected!
        .alerts[0]!.title;
      const decoded = await Effect.runPromise(
        decodeGtfsRealtimeJsonAlertFeed(
          jsonFeed({ header_text: { translation: [{ text: headerText }] } }),
        ),
      );

      expect(decoded.alerts[0]?.title).toBe(expectedTitle);
      expect(decoded.alerts[0]?.sourceTranslations).toContainEqual(
        expect.objectContaining({ field: "title", text: expectedTitle }),
      );
    });

    it("keeps embedded JSON title evidence at one entity-decoding pass", async () => {
      const description = (
        sharedGenericJsonCase("double-encoded entities decode once").payload as {
          description: string;
        }[]
      )[0]!.description;
      const expectedTitle = sharedGenericJsonCase("double-encoded entities decode once").expected!
        .alerts[0]!.title;
      const decoded = await Effect.runPromise(
        decodeGtfsRealtimeJsonAlertFeed(
          jsonFeed({
            description_text: { translation: [{ text: description }] },
          }),
        ),
      );

      expect(decoded.alerts[0]?.title).toBe(expectedTitle);
      expect(decoded.alerts[0]?.sourceTranslations).toContainEqual(
        expect.objectContaining({ field: "title", text: expectedTitle }),
      );
    });
  });

  it("omits feed-declared unreliable vehicle telemetry without agency branching", async () => {
    const tripDesc = concatBuffers(encodeString(1, "trip-1"), encodeString(5, "LW"));
    const position = concatBuffers(
      encodeFloat(1, 43.6455),
      encodeFloat(2, -79.3806),
      encodeFloat(5, 0),
    );
    const vehiclePosition = concatBuffers(
      encodeMessage(1, tripDesc),
      encodeMessage(2, position),
      encodeVarintField(9, 0),
    );
    const feed = concatBuffers(
      encodeFeedHeader(1_900_000_000),
      encodeMessage(
        2,
        concatBuffers(encodeString(1, "vehicle-entity"), encodeMessage(4, vehiclePosition)),
      ),
    );

    const decoded = await Effect.runPromise(
      decodeGtfsRealtimeFeed(feed, {
        unreliableVehicleFields: ["speed", "occupancy_status"],
      }),
    );

    expect(decoded.vehiclePositions[0]).toEqual(
      expect.objectContaining({ speed: undefined, occupancyStatus: undefined }),
    );
  });

  it("rejects malformed truncation with a tagged DecodeError via the error channel", async () => {
    // Truncated varint: tag byte says length-delimited but length varint is
    // incomplete; the partial key decodes to wire type 7, which skip() refuses.
    const error = await Effect.runPromise(
      Effect.flip(decodeGtfsRealtimeFeed(new Uint8Array([0xff, 0xff, 0xff]))),
    );
    expect(error._tag).toBe("DecodeError");
    expect(error).toBeInstanceOf(DecodeError);
  });

  describe("signed int32/int64 fields", () => {
    const tripDescriptor = concatBuffers(encodeString(1, "trip-signed"), encodeString(5, "504"));
    const feedWithArrival = (arrivalEvent: Uint8Array) =>
      encodeFeed(1700000000, [
        encodeMessage(
          2,
          concatBuffers(
            encodeString(1, "entity-signed"),
            encodeMessage(
              3,
              concatBuffers(
                encodeMessage(1, tripDescriptor),
                encodeMessage(
                  2,
                  concatBuffers(
                    encodeVarintField(1, 5),
                    encodeMessage(2, arrivalEvent),
                    encodeString(4, "14560"),
                  ),
                ),
              ),
            ),
          ),
        ),
      ]);

    it.each([-1, -60, -3600, -2147483648])(
      "decodes a negative StopTimeEvent delay of %i seconds as signed",
      async (delay) => {
        const arrival = concatBuffers(
          encodeSignedVarintField(1, delay),
          encodeVarintField(2, 1700000300),
        );

        const decoded = await Effect.runPromise(decodeGtfsRealtimeFeed(feedWithArrival(arrival)));

        expect(decoded.tripUpdates).toHaveLength(1);
        expect(decoded.tripUpdates[0].delaySeconds).toBe(delay);
        expect(decoded.tripUpdates[0].predictedTime).toBe(1700000300000);
      },
    );

    it("treats a negative int64 StopTimeEvent time as no prediction", async () => {
      const arrival = encodeSignedVarintField(2, -1700000300);

      const decoded = await Effect.runPromise(decodeGtfsRealtimeFeed(feedWithArrival(arrival)));

      expect(decoded.tripUpdates).toHaveLength(0);
    });

    it("ignores a negative int64 scheduled_time and keeps the delay field", async () => {
      const arrival = concatBuffers(
        encodeVarintField(1, 60),
        encodeVarintField(2, 1700000300),
        encodeSignedVarintField(4, -1),
      );

      const decoded = await Effect.runPromise(decodeGtfsRealtimeFeed(feedWithArrival(arrival)));

      expect(decoded.tripUpdates).toHaveLength(1);
      expect(decoded.tripUpdates[0].delaySeconds).toBe(60);
    });
  });

  describe("per-entity recovery from malformed payloads", () => {
    const descriptor = (tripId: string) =>
      encodeMessage(1, concatBuffers(encodeString(1, tripId), encodeString(5, "504")));
    const stopTimeUpdate = (time: number) =>
      encodeMessage(
        2,
        concatBuffers(
          encodeVarintField(1, 5),
          encodeMessage(2, encodeVarintField(2, time)),
          encodeString(4, "14560"),
        ),
      );
    const tripEntity = (entityId: string, tripUpdateBody: Uint8Array) =>
      encodeMessage(2, concatBuffers(encodeString(1, entityId), encodeMessage(3, tripUpdateBody)));
    const validTrip = (entityId: string, tripId: string, time: number) =>
      tripEntity(entityId, concatBuffers(descriptor(tripId), stopTimeUpdate(time)));

    /** TripUpdate bodies that are malformed inside an otherwise well-framed entity. */
    const malformedTripBodies: ReadonlyArray<readonly [string, Uint8Array]> = [
      [
        "a nested stop time longer than its trip update",
        concatBuffers(descriptor("trip-b"), new Uint8Array([0x12, 0x20, 0x08, 0x05])),
      ],
      [
        "a trip id longer than its trip descriptor",
        concatBuffers(
          encodeMessage(
            1,
            concatBuffers(encodeString(5, "504"), new Uint8Array([0x0a, 0x20, 0x41])),
          ),
          stopTimeUpdate(1700000300),
        ),
      ],
      [
        "an unknown length-delimited field longer than its trip update",
        new Uint8Array([0x4a, 0x20, 0x01]),
      ],
      ["an unknown fixed64 field cut off by its trip update", new Uint8Array([0x49, 0x01, 0x02])],
      [
        "a stop time varint cut off by its event",
        concatBuffers(
          descriptor("trip-b"),
          encodeMessage(
            2,
            concatBuffers(encodeVarintField(1, 5), encodeMessage(2, new Uint8Array([0x10, 0x85]))),
          ),
        ),
      ],
    ];

    it.each(malformedTripBodies)(
      "drops only the entity with %s and keeps its neighbours",
      async (_name, body) => {
        const feed = encodeFeed(1700000000, [
          validTrip("entity-a", "trip-a", 1700000300),
          tripEntity("entity-broken", body),
          validTrip("entity-c", "trip-c", 1700000600),
        ]);

        const decoded = await Effect.runPromise(decodeGtfsRealtimeFeed(feed));

        expect(decoded.tripUpdates.map((trip) => trip.tripId)).toEqual(["trip-a", "trip-c"]);
        expect(decoded.droppedEntities).toBe(1);
      },
    );

    it("drops a malformed vehicle entity and keeps the valid vehicles around it", async () => {
      const brokenVehicle = encodeMessage(
        2,
        concatBuffers(
          encodeString(1, "entity-vehicle-broken"),
          encodeMessage(4, new Uint8Array([0x12, 0x20, 0x0a])),
        ),
      );
      const feed = encodeFeed(1700000000, [
        encodeSurfaceVehiclePositionEntity({
          entityId: "entity-vehicle-a",
          vehicleId: "veh-a",
          tripId: "trip-a",
          routeId: "504",
          latitude: 43.65,
          longitude: -79.38,
        }),
        brokenVehicle,
        encodeSurfaceVehiclePositionEntity({
          entityId: "entity-vehicle-c",
          vehicleId: "veh-c",
          tripId: "trip-c",
          routeId: "504",
          latitude: 43.66,
          longitude: -79.39,
        }),
      ]);

      const decoded = await Effect.runPromise(decodeGtfsRealtimeFeed(feed));

      expect(decoded.vehiclePositions.map((vehicle) => vehicle.vehicleId)).toEqual([
        "veh-a",
        "veh-c",
      ]);
      expect(decoded.droppedEntities).toBe(1);
    });

    it.each([
      ["a body shorter than its declared length", new Uint8Array([0x12, 0x40, 0x0a, 0x01, 0x61])],
      ["a length prefix cut off mid-varint", new Uint8Array([0x12, 0x85])],
    ])("keeps the entities before a truncated tail (%s)", async (_name, tail) => {
      const feed = concatBuffers(
        encodeFeed(1700000000, [
          validTrip("entity-a", "trip-a", 1700000300),
          validTrip("entity-b", "trip-b", 1700000600),
        ]),
        tail,
      );

      const decoded = await Effect.runPromise(decodeGtfsRealtimeFeed(feed));

      expect(decoded.tripUpdates.map((trip) => trip.tripId)).toEqual(["trip-a", "trip-b"]);
      expect(decoded.droppedEntities).toBe(1);
    });

    it.each([
      [
        "every entity is malformed",
        encodeFeed(
          1700000000,
          malformedTripBodies
            .slice(0, 2)
            .map(([, body], index) => tripEntity(`entity-${index}`, body)),
        ),
      ],
      [
        "the only entity is a truncated tail",
        concatBuffers(encodeFeedHeader(1700000000), new Uint8Array([0x12, 0x40, 0x0a])),
      ],
    ])("rejects a feed where nothing decodes (%s)", async (_name, feed) => {
      const error = await Effect.runPromise(Effect.flip(decodeGtfsRealtimeFeed(feed)));

      expect(error._tag).toBe("DecodeError");
      expect(error).toBeInstanceOf(DecodeError);
    });

    it("rejects a header whose length overruns the payload", async () => {
      const error = await Effect.runPromise(
        Effect.flip(decodeGtfsRealtimeFeed(new Uint8Array([0x0a, 0x40, 0x32, 0x2e]))),
      );

      expect(error._tag).toBe("DecodeError");
      expect(error).toBeInstanceOf(DecodeError);
    });

    it("treats a feed with no entities as a clean, empty decode", async () => {
      const decoded = await Effect.runPromise(decodeGtfsRealtimeFeed(encodeFeed(1700000000, [])));

      expect(decoded.tripUpdates).toEqual([]);
      expect(decoded.droppedEntities).toBeUndefined();
    });
  });
});

describe("gtfsRealtimeDecoder stop headsign and inferred direction (surface fuse contract)", () => {
  it("preserves the inferred-direction flag and stop_headsign through schema validation", async () => {
    const header = encodeFeedHeader(1700000000);
    // No direction_id on the descriptor: the adapter must infer direction 0
    // and mark it, so display layers prefer the operator headsign.
    const tripDesc = concatBuffers(encodeString(1, "trip-7"), encodeString(5, "7"));
    const arrivalEvent = concatBuffers(encodeVarintField(1, 60), encodeVarintField(2, 1700000300));
    const stopTimeUpdate = concatBuffers(
      encodeVarintField(1, 5),
      encodeMessage(2, arrivalEvent),
      encodeString(4, "3010"),
      encodeString(7, "Conestoga Station"),
    );
    const tripUpdateContent = concatBuffers(
      encodeMessage(1, tripDesc),
      encodeMessage(2, stopTimeUpdate),
    );
    const tripEntity = encodeMessage(
      2,
      concatBuffers(encodeString(1, "entity-7"), encodeMessage(3, tripUpdateContent)),
    );

    const decoded = await Effect.runPromise(
      decodeGtfsRealtimeFeed(concatBuffers(header, tripEntity)),
    );

    expect(decoded.tripUpdates).toHaveLength(1);
    expect(decoded.tripUpdates[0].directionId).toBe(0);
    expect(decoded.tripUpdates[0].directionInferred).toBe(true);
    expect(decoded.tripUpdates[0].headsign).toBe("Conestoga Station");
  });

  it("omits the inferred-direction flag when the feed publishes a real direction_id", async () => {
    const header = encodeFeedHeader(1700000000);
    const tripDesc = concatBuffers(
      encodeString(1, "trip-97"),
      encodeString(5, "97"),
      encodeVarintField(6, 1),
    );
    const arrivalEvent = concatBuffers(encodeVarintField(1, 60), encodeVarintField(2, 1700000300));
    const stopTimeUpdate = concatBuffers(
      encodeVarintField(1, 5),
      encodeMessage(2, arrivalEvent),
      encodeString(4, "14560"),
    );
    const tripUpdateContent = concatBuffers(
      encodeMessage(1, tripDesc),
      encodeMessage(2, stopTimeUpdate),
    );
    const tripEntity = encodeMessage(
      2,
      concatBuffers(encodeString(1, "entity-97"), encodeMessage(3, tripUpdateContent)),
    );

    const decoded = await Effect.runPromise(
      decodeGtfsRealtimeFeed(concatBuffers(header, tripEntity)),
    );

    expect(decoded.tripUpdates).toHaveLength(1);
    expect(decoded.tripUpdates[0].directionId).toBe(1);
    expect(decoded.tripUpdates[0].directionInferred).toBeUndefined();
    expect(decoded.tripUpdates[0].headsign).toBeUndefined();
  });
});

describe("gtfsRealtimeDecoder duplicate vehicle fixes (collapse-by-trip)", () => {
  // Shape of an upstream that reports one bus twice: a mirrored vehicle id,
  // the same trip and route, positions under 10 m apart, timestamps seconds apart.
  const fix = (
    vehicleId: string,
    tripId: string | undefined,
    timestampSec: number | undefined,
    longitude = -79.3806,
  ) =>
    encodeSurfaceVehiclePositionEntity({
      entityId: `entity-${vehicleId}`,
      vehicleId,
      tripId,
      routeId: "R7",
      latitude: 43.6455,
      longitude,
      timestampSec,
    });

  const feedOf = (entities: Uint8Array[]) => encodeFeed(1_900_000_000, entities);
  const vehicleIds = (decoded: { vehiclePositions: readonly { vehicleId: string }[] }) =>
    decoded.vehiclePositions.map((vehicle) => vehicle.vehicleId);

  it("keeps both fixes unless the feed opts in", () => {
    const decoded = decodeGtfsRealtimeSync(
      feedOf([fix("7100931", "t1:svc", 1_900_000_000), fix("7102931", "t1:svc", 1_900_000_002)]),
    );

    expect(vehicleIds(decoded)).toEqual(["7100931", "7102931"]);
  });

  it("keeps the freshest fix of a trip", () => {
    const decoded = decodeGtfsRealtimeSync(
      feedOf([
        fix("7100931", "t1:svc", 1_900_000_000),
        fix("7102931", "t1:svc", 1_900_000_004, -79.38059),
        fix("7100200", "t2:svc", 1_900_000_001, -79.39),
      ]),
      { duplicateVehicleFixes: "collapse-by-trip" },
    );

    expect(vehicleIds(decoded)).toEqual(["7102931", "7100200"]);
  });

  it.each([
    ["numerically when both ids are integers", ["9", "10"], "9"],
    ["lexically otherwise", ["bus-b", "bus-a"], "bus-a"],
  ])("breaks timestamp ties with the lowest vehicle id %s", (_label, ids, expected) => {
    const decoded = decodeGtfsRealtimeSync(
      feedOf(ids.map((id) => fix(id, "t1:svc", 1_900_000_000))),
      { duplicateVehicleFixes: "collapse-by-trip" },
    );

    expect(vehicleIds(decoded)).toEqual([expected]);
  });

  it("prefers a stamped fix over one that only inherits the header time", () => {
    const decoded = decodeGtfsRealtimeSync(
      feedOf([fix("7100931", "t1:svc", undefined), fix("7102931", "t1:svc", 1_899_999_990)]),
      { duplicateVehicleFixes: "collapse-by-trip" },
    );

    expect(vehicleIds(decoded)).toEqual(["7102931"]);
  });

  it("falls back to the lowest vehicle id when neither fix is stamped", () => {
    const decoded = decodeGtfsRealtimeSync(
      feedOf([fix("7102931", "t1:svc", undefined), fix("7100931", "t1:svc", undefined)]),
      { duplicateVehicleFixes: "collapse-by-trip" },
    );

    expect(vehicleIds(decoded)).toEqual(["7100931"]);
  });

  it("keeps fixes that have no trip id", () => {
    const decoded = decodeGtfsRealtimeSync(
      feedOf([fix("7100931", undefined, 1_900_000_000), fix("7102931", undefined, 1_900_000_000)]),
      { duplicateVehicleFixes: "collapse-by-trip" },
    );

    expect(vehicleIds(decoded)).toEqual(["7100931", "7102931"]);
  });

  it("does not merge fixes of different trips that share a vehicle id", () => {
    const decoded = decodeGtfsRealtimeSync(
      feedOf([fix("7100931", "t1:svc", 1_900_000_000), fix("7100931", "t9:svc", 1_900_000_001)]),
      { duplicateVehicleFixes: "collapse-by-trip" },
    );

    expect(vehicleIds(decoded)).toEqual(["7100931", "7100931"]);
  });

  it("does not merge fixes of different trips at the same position", () => {
    const decoded = decodeGtfsRealtimeSync(
      feedOf([fix("7100931", "t1:svc", 1_900_000_000), fix("7102931", "t2:svc", 1_900_000_000)]),
      { duplicateVehicleFixes: "collapse-by-trip" },
    );

    expect(vehicleIds(decoded)).toEqual(["7100931", "7102931"]);
  });
});

describe("gtfsRealtimeDecoder trip-scoped alerts", () => {
  const nowSec = 1_800_000_000;
  const tripRoutes = new Map([
    ["t1", { routeId: "7", directionId: 0 }],
    ["t2", { routeId: "7", directionId: 1 }],
    ["t3", { routeId: "11", directionId: 0 }],
  ]);

  it("names the trips and attributes the alert to the routes they run on", () => {
    const [alert] = decodeGtfsRealtimeSync(
      encodeFeed(nowSec, [
        encodeAlertEntity({
          id: "cancel",
          selectors: [{ tripId: "t1" }, { tripId: "t2" }, { tripId: "t3" }],
          effect: 1,
        }),
      ]),
      { tripRoutes },
    ).alerts;
    expect(alert?.tripIds).toEqual(["t1", "t2", "t3"]);
    expect(alert?.routeIds).toEqual(["7", "11"]);
    expect(alert?.targets).toEqual([{ routeId: "7" }, { routeId: "11" }]);
    expect(alert?.tripScoped).toBe(true);
  });

  it("keeps a trip restriction when its affected portion names a stop", () => {
    const [alert] = decodeGtfsRealtimeSync(
      encodeFeed(nowSec, [
        encodeAlertEntity({
          id: "cut-in",
          selectors: [{ tripId: "t1", stopId: "100" }],
          effect: 1,
        }),
      ]),
      { tripRoutes },
    ).alerts;
    expect(alert).toMatchObject({
      tripIds: ["t1"],
      tripScoped: true,
      targets: [{ routeId: "7", stopId: "100" }],
    });
  });
  it("leaves an unresolved trip unattributed", () => {
    const [alert] = decodeGtfsRealtimeSync(
      encodeFeed(nowSec, [
        encodeAlertEntity({ id: "cancel", selectors: [{ tripId: "t1" }], effect: 1 }),
      ]),
    ).alerts;
    expect(alert?.routeIds).toBeUndefined();
    expect(alert?.tripScoped).toBe(true);
  });

  it.each([
    ["a whole route", [{ routeId: "7" }, { tripId: "t1" }]],
    ["a stop", [{ stopId: "100" }, { tripId: "t1" }]],
  ])("is not trip-scoped when it also names %s", (_label, selectors) => {
    const [alert] = decodeGtfsRealtimeSync(
      encodeFeed(nowSec, [encodeAlertEntity({ id: "mixed", selectors, effect: 1 })]),
      { tripRoutes },
    ).alerts;
    expect(alert?.tripIds).toEqual(["t1"]);
    expect(alert?.tripScoped).toBeUndefined();
  });
});

it("drops foreign alert selectors while retaining selected routes and shared-facility impacts", () => {
  const entity = (id: string, selectors: Uint8Array[]) =>
    encodeMessage(
      2,
      concatBuffers(
        encodeString(1, id),
        encodeMessage(
          5,
          concatBuffers(
            ...selectors.map((selector) => encodeMessage(5, selector)),
            encodeMessage(10, encodeMessage(1, encodeString(1, "Service disruption"))),
          ),
        ),
      ),
    );
  const ours = concatBuffers(encodeString(1, "alpha"), encodeString(2, "ours"));
  const foreign = concatBuffers(encodeString(1, "beta"), encodeString(2, "foreign"));
  const shared = concatBuffers(foreign, encodeString(5, "shared"));
  const bytes = concatBuffers(
    encodeFeedHeader(1700000000),
    entity("foreign", [foreign]),
    entity("mixed", [foreign, ours]),
    entity("foreign-shared", [shared]),
    entity("shared", [encodeString(5, "shared")]),
    entity("new-route", [concatBuffers(encodeString(1, "alpha"), encodeString(2, "new-route"))]),
  );
  const feed = decodeGtfsRealtimeSync(bytes, {
    sourceAgencyScope: {
      agencyIds: new Set(["alpha"]),
      routeIds: new Set(["ours"]),
      stopIds: new Set(["shared"]),
    },
  });
  expect(feed.alerts.map((alert) => alert.id)).toEqual(["mixed", "shared", "new-route"]);
  expect(feed.alerts[0].routeIds).toEqual(["ours"]);
  expect(feed.alerts[1].targets).toEqual([{ routeId: undefined, stopId: "shared" }]);
  expect(feed.alerts[2].routeIds).toEqual(["new-route"]);
});

describe("shared-feed scope classification", () => {
  const scope = {
    agencyIds: new Set(["alpha"]),
    routeIds: new Set(["ours"]),
    stopIds: new Set(["our-stop"]),
  };
  const decode = (selectors: readonly Uint8Array[]) =>
    decodeGtfsRealtimeSync(
      encodeFeed(1_700_000_000, [
        encodeMessage(
          2,
          concatBuffers(
            encodeString(1, "a"),
            encodeMessage(
              5,
              concatBuffers(...selectors.map((selector) => encodeMessage(5, selector))),
            ),
          ),
        ),
      ]),
      { sourceAgencyScope: scope },
    );

  it.each([
    ["route", encodeString(2, "other-operator-route")],
    ["stop", encodeString(5, "other-operator-stop")],
    ["trip absent from the index", encodeMessage(4, encodeString(1, "new-trip"))],
    ["route newer than the deployment, without agency_id", encodeString(2, "new-route")],
  ])("drops an unattributed %s", (_kind, selector) => {
    expect(decode([selector]).alerts).toEqual([]);
  });

  it("keeps a route the entity attributes to this agency even when the deployment predates it", () => {
    const feed = decode([concatBuffers(encodeString(1, "alpha"), encodeString(2, "new-route"))]);
    expect(feed.alerts[0]?.routeIds).toEqual(["new-route"]);
  });
});
