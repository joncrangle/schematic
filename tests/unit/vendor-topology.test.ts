import { expect, it, vi } from "vitest";
import { buildCitywayIndex } from "~/infrastructure/gtfs/citywayIndex";
import { decodePassioTopology } from "~/infrastructure/gtfs/passioArchive";
import { writeStoredArchive } from "~/infrastructure/gtfs/archiveWriter";

it("joins nearby duplicate GTFS public codes to the same Cityway boarding identity", async () => {
  const archive = writeStoredArchive({
    "stops.txt":
      "stop_id,stop_code,stop_name,stop_lat,stop_lon\ns-a,10,Central,45,-74\ns-b,10,Central,45.0001,-74\n",
    "routes.txt": "route_id\nA\n",
    "trips.txt": "route_id,trip_id\nA,t\n",
    "stop_times.txt": "trip_id,stop_id,stop_sequence\nt,s-a,1\n",
  });
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const body = url.includes("rider")
      ? '<iframe src="https://app.test/?apikey=public"></iframe>'
      : url.includes("byNetwork")
        ? { Count: 1, Lines: [{ Id: 2, Number: "A", LineDirections: [{ Direction: 1 }] }] }
        : [{ Id: 3, Name: "10 | Central", LogicalStopPointId: 4, Latitude: 45, Longitude: -74 }];
    return new Response(typeof body === "string" ? body : JSON.stringify(body));
  });
  const index = await buildCitywayIndex(
    {
      kind: "cityway",
      format: "json",
      url: "https://api.example.test",
      riderPageUrl: "https://rider.example.test/",
      networkId: "1",
      timeZone: "America/Toronto",
      stopMap: {},
    },
    [archive],
    fetch,
  );
  expect(index).toEqual({
    "s-a": [{ logicalStopId: "4", physicalStopId: "3", lineId: "2", routeId: "A", direction: 1 }],
    "s-b": [{ logicalStopId: "4", physicalStopId: "3", lineId: "2", routeId: "A", direction: 1 }],
  });
});

it("preserves native Passio patterns while folding them onto the public route", () => {
  const data = decodePassioTopology({
    stops: { s: { id: "s", name: "Central", latitude: 45, longitude: -74 } },
    routes: {
      a: ["7 Central", "#008800", 0, [1, "s", 0]],
      b: ["7 Central", "#008800", 1, [1, "s", 0]],
    },
    routeShortNames: { a: "7", b: "7" },
    routePoints: { a: [[{ lat: "45", lng: "-74" }]], b: [[{ lat: "45", lng: "-74" }]] },
  });
  expect({ routeMap: data.routeMap, stopRoutes: data.stopRoutes, trips: data.trips }).toEqual({
    routeMap: { a: "7", b: "7" },
    stopRoutes: { s: ["a", "b"] },
    trips: [
      ["a", "TOPOLOGY", "a", "", 0, "a"],
      ["b", "TOPOLOGY", "b", "", 0, "b"],
    ],
  });
});
