import { expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { createGenericGtfsRealtimeSource } from "~/infrastructure/realtime/genericGtfsRealtimeSource";
const now = Date.parse("2027-01-11T12:00:00Z");
it("joins public codes, shares the anonymous handshake, and excludes timetable rows", async () => {
  let handshakes = 0;
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url === "https://sample.test/") {
      handshakes++;
      return new Response(
        '<script>new Home.HomeViewModel("/", "maps", { culture: "en" }, "ZmljdGlvbmFs", document.body);</script>',
        { headers: { "Set-Cookie": ".MyRide.RequestVerificationToken=session; Path=/; HttpOnly" } },
      );
    }
    expect(new Headers(init?.headers).get("RequestVerificationToken")).toBe("fictional");
    expect(new Headers(init?.headers).get("Cookie")).toBe(
      ".MyRide.RequestVerificationToken=session",
    );
    if (url.includes("GetBaseData"))
      return Response.json({ routes: [{ key: "route-key", shortName: "7", directionList: [] }] });
    if (url.includes("GetVehicles"))
      return Response.json([
        {
          routeKey: "route-key",
          vehiclesByDirections: [
            {
              vehicles: [
                {
                  key: "bus",
                  location: {
                    latitude: 52,
                    longitude: -113,
                    lastGpsDate: "2027-01-11T12:00:00",
                    heading: 180,
                  },
                },
              ],
            },
          ],
        },
      ]);
    expect(JSON.parse(String(init?.body))).toMatchObject({ stopCode: "0042", date: "2027-01-11" });
    return Response.json({
      routeStopSchedules: [
        {
          routeNumber: "7",
          directionName: "Downtown",
          stopTimes: [
            {
              tripPointId: "point",
              estimatedDepartTimeUtc: "2027-01-11T12:03:00Z",
              isRealtime: true,
              isCancelled: false,
              isOffRoute: false,
            },
            {
              tripPointId: "scheduled",
              estimatedDepartTimeUtc: "2027-01-11T12:05:00Z",
              isRealtime: false,
            },
          ],
        },
      ],
    });
  };
  const source = createGenericGtfsRealtimeSource({
    agencyId: "sample",
    feeds: [
      {
        kind: "tripspark",
        format: "json",
        url: "https://sample.test",
        dateTimezone: "UTC",
        vehicleTimeZone: "UTC",
        sessionTokenArgument: 3,
        pollIntervalSeconds: 60,
      },
    ],
    fetch,
    now: () => now,
    getSourceAgencyScope: () =>
      Effect.succeed({
        routeIds: new Set(["R7"]),
        stopIds: new Set(["P"]),
        routesByShortName: new Map([["7", ["R7"]]]),
        stopsByCode: new Map([["0042", ["P"]]]),
      }),
  });
  const result = await Effect.runPromise(
    source.fetchRealtime(
      { agencyId: "sample", generatedAt: now, routes: [] },
      { routeIds: new Set(["R7"]), stopIds: new Set(["P"]) },
    ),
  );
  expect(result).toMatchObject({
    partial: false,
    vehicles: [{ vehicleId: "bus", routeId: "R7", timestamp: now }],
    arrivals: [
      {
        tripId: "tripspark:point",
        stopId: "P",
        routeId: "R7",
        predictedTime: now + 180000,
        isRealtime: true,
      },
    ],
  });
  expect(result.arrivals).toHaveLength(1);
  expect(handshakes).toBe(1);
});
