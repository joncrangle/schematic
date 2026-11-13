import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { TrainMapDecryption, TrainMapGtfsIndex } from "~/agencies/types";
import { buildTrainMapGtfsIndex } from "~/infrastructure/gtfs/trainMapIndex";
import {
  decodeTrainMapDocument,
  decryptTrainMapDocument,
} from "~/infrastructure/realtime/trainMap/trainMapDecoder";
import { createTrainMapStationsSource } from "~/infrastructure/realtime/trainMap/trainMapSource";
import { gtfsZip } from "../helpers/gtfsArchive";

// Fictional key material: the scheme, not any operator's secret, is under test.
const decryption: TrainMapDecryption = {
  publicKey: "fixture-public-key",
  salt: "0a1b2c3d",
  iv: "00112233445566778899aabbccddeeff",
  iterations: 10,
  passwordLength: 44,
};
const index: TrainMapGtfsIndex = {
  stops: {
    CEN: { stopId: "central-id", name: "Central", timeZone: "America/Chicago" },
    NTH: {
      stopId: "north-id",
      name: "North Town Station",
      headsign: "North Town",
      timeZone: "America/New_York",
    },
  },
  trains: {
    "7": { routeId: "fixture-route", directionId: 1 },
    "8": { routeId: "undrawn-route", directionId: 1 },
  },
};
// 2026-07-01 15:00 UTC: 10:00 in Chicago, 11:00 in New York, both on daylight time.
const now = Date.parse("2026-07-01T15:00:00Z");

const call = (code: string, fields: Record<string, string>) =>
  JSON.stringify({ code, tz: "C", bus: false, schcmnt: "", ...fields });

function train(number: string, properties: Record<string, unknown> = {}) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [-88, 42] },
    properties: {
      TrainNum: number,
      TrainState: "Active",
      DestCode: "NTH",
      OrigSchDep: "7/1/2026 8:00:00 AM",
      updated_at: "7/1/2026 10:58:00 AM",
      Heading: "NE",
      Velocity: "50",
      Station0: call("CEN", {
        schdep: "07/01/2026 10:20:00",
        estdep: "07/01/2026 10:25:00",
      }),
      Station1: call("NTH", {
        schdep: "07/01/2026 12:00:00",
        estdep: "07/01/2026 12:05:00",
      }),
      ...properties,
    },
  };
}

async function seal(plain: string, password: string): Promise<string> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const hex = (value: string) => new Uint8Array(value.match(/../g)!.map((b) => parseInt(b, 16)));
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: hex(decryption.salt),
      iterations: decryption.iterations,
      hash: "SHA-1",
    },
    material,
    { name: "AES-CBC", length: 128 },
    false,
    ["encrypt"],
  );
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: hex(decryption.iv) },
    key,
    new TextEncoder().encode(plain),
  );
  return btoa(String.fromCharCode(...new Uint8Array(sealed)));
}

async function wire(features: readonly unknown[]): Promise<Uint8Array<ArrayBuffer>> {
  const password = "fixture-request-password";
  const blob = await seal(`${password}|nonce`, decryption.publicKey);
  expect(blob).toHaveLength(decryption.passwordLength);
  const body = await seal(JSON.stringify({ type: "FeatureCollection", features }), password);
  return new TextEncoder().encode(body + blob);
}

const decode = async (features: readonly unknown[]) =>
  decodeTrainMapDocument(
    await decryptTrainMapDocument(await wire(features), decryption),
    index,
    "America/New_York",
    now,
  );

describe("train map", () => {
  it("decrypts the document and reads each departure in its station's own zone", async () => {
    const snapshot = await decode([train("7")]);

    expect(snapshot.arrivals).toEqual([
      expect.objectContaining({
        tripId: "7:2026-07-01",
        routeId: "fixture-route",
        directionId: 1,
        stopId: "central-id",
        stopSequence: 1,
        predictedTime: Date.parse("2026-07-01T15:25:00Z"),
        delaySeconds: 300,
        headsign: "North Town",
      }),
      expect.objectContaining({
        stopId: "north-id",
        predictedTime: Date.parse("2026-07-01T16:05:00Z"),
      }),
    ]);
    expect(snapshot.vehicles).toEqual([
      expect.objectContaining({
        tripId: "7:2026-07-01",
        latitude: 42,
        longitude: -88,
        bearing: 45,
        timestamp: Date.parse("2026-07-01T14:58:00Z"),
      }),
    ]);
    expect(snapshot.vehicles[0]!.speed).toBeCloseTo(22.352);
  });

  it("keeps only future estimated departures the train has not already made", async () => {
    const snapshot = await decode([
      train("7", {
        Station0: call("CEN", {
          schdep: "07/01/2026 09:00:00",
          estdep: "07/01/2026 09:02:00",
          postdep: "07/01/2026 09:02:00",
        }),
        Station1: call("NTH", {
          schdep: "07/01/2026 12:00:00",
          schcmnt: "Canceled",
        }),
        Station2: call("NTH", { schdep: "07/01/2026 12:30:00" }),
      }),
    ]);

    expect(snapshot.arrivals).toEqual([]);
  });

  it.each([
    ["a train the static archive does not know", train("999")],
    ["a frozen record", train("7", { updated_at: "7/1/2026 10:30:00 AM" })],
    ["a train that has not left its origin", train("7", { TrainState: "Predeparture" })],
  ])("skips %s", async (_case, skipped) => {
    expect(await decode([skipped])).toEqual({ vehicles: [], arrivals: [] });
  });

  it("drops a malformed train without blanking the rest", async () => {
    const snapshot = await decode([train("7", { Station0: "{not json" }), train("7")]);

    expect(snapshot.vehicles).toHaveLength(1);
    expect(snapshot.arrivals).toHaveLength(2);
  });

  it("fails the read when no train decodes", async () => {
    await expect(decode([train("7", { OrigSchDep: "unknown" })])).rejects.toThrow(
      "Invalid train origin departure",
    );
  });

  it("serves tracked departures on station cards with live predictions only", async () => {
    const bytes = await wire([train("7"), train("8")]);
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(bytes),
    );
    const source = createTrainMapStationsSource({
      agencyId: "fixture-rail",
      feed: {
        kind: "train_map",
        url: "https://example.test/trains",
        format: "json",
        decryption,
        recordTimeZone: "America/New_York",
        gtfsIndex: index,
      },
      fetch,
      now: () => now,
      routeLineMap: { "fixture-route": "F" },
      stations: [
        {
          id: "central-id",
          name: "Central",
          lat: 42,
          lon: -88,
          lines: ["F"],
          platformIds: ["central-id"],
        },
      ],
    });

    const [card] = await Effect.runPromise(source.fetchByIds({ stationIds: ["central-id"] }));

    expect(card).toMatchObject({
      livePredictionsOnly: true,
      trackingRouteId: "fixture-route",
      arrivals: [
        {
          label: "Train 7 → North Town",
          lineId: "F",
          times: [Date.parse("2026-07-01T15:25:00Z")],
        },
        // An undrawn route gets no line badge.
        { label: "Train 8 → North Town", lineId: undefined },
      ],
    });
    // An encrypted wire body is not JSON, and its server refuses a JSON Accept.
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).has("Accept")).toBe(false);
  });
});

describe("train map GTFS index", () => {
  const archive = gtfsZip({
    "agency.txt": "agency_id,agency_timezone\nown,America/New_York\npartner,America/New_York\n",
    "routes.txt": "route_id,agency_id,route_type\nrail,own,2\nbus,own,3\nshared,partner,2\n",
    "stops.txt":
      "stop_id,stop_code,stop_name,stop_timezone\ncentral-id,CEN,Central,America/Chicago\nnorth-id,NTH,North Town,\n",
    "stop_times.txt":
      "trip_id,stop_id,stop_sequence\nlong,central-id,1\nlong,north-id,2\nshort,north-id,1\nshort,central-id,2\nshort-late,central-id,1\n",
    "trips.txt":
      "route_id,trip_id,trip_short_name,trip_headsign,direction_id\nrail,long,7,North Town,1\nrail,short,7,Midway,1\nrail,short-late,7,Midway Yard,1\nbus,bus,8,West,0\nshared,shared,7,Elsewhere,0\n",
  });

  it("joins the selected operator's rail trains and each station's own zone", async () => {
    expect(await buildTrainMapGtfsIndex([archive], ["own"])).toEqual({
      stops: {
        // Trips ending here disagree on a headsign, so none is chosen.
        CEN: {
          stopId: "central-id",
          name: "Central",
          timeZone: "America/Chicago",
        },
        NTH: {
          stopId: "north-id",
          name: "North Town",
          headsign: "North Town",
          timeZone: "America/New_York",
        },
      },
      trains: { "7": { routeId: "rail", directionId: 1 } },
    });
  });

  it("rejects one train number on two routes rather than choosing one", async () => {
    await expect(buildTrainMapGtfsIndex([archive])).rejects.toThrow(
      "Ambiguous GTFS train number: 7",
    );
  });
});
