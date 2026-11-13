import { Effect } from "effect";
import { expect, it } from "vitest";
import { decodeGtfsRealtimeJsonAlertFeed } from "~/infrastructure/realtime/gtfsRealtimeJsonDecoder";

it("preserves scalar JSON extension fields for declarative alert classification", async () => {
  const feed = {
    header: { gtfs_realtime_version: "2.0", timestamp: 1_700_000_000 },
    entity: [
      {
        id: "notice-a",
        alert: {
          header_text: { translation: [{ text: "Work on the network" }] },
          "example.alert": {
            category: "Suspension",
            priority: 3,
            published: true,
            detail: { ignored: true },
          },
        },
      },
    ],
  };
  const decoded = await Effect.runPromise(
    decodeGtfsRealtimeJsonAlertFeed(new TextEncoder().encode(JSON.stringify(feed))),
  );
  expect(decoded.alerts[0]?.sourceFields).toEqual({
    "example.alert.category": "Suspension",
    "example.alert.priority": 3,
    "example.alert.published": true,
  });
});

it.each([
  [{ route_id: "r", trip: { trip_id: "t" } }, ["r"], [{ routeId: "r", stopId: undefined }]],
  [{ trip: { trip_id: "t" } }, undefined, undefined],
  [{ trip: { trip_id: "t", route_id: "r" } }, ["r"], [{ routeId: "r", stopId: undefined }]],
])(
  "retains a trip selector without widening it to the whole route",
  async (selector, routeIds, targets) => {
    const feed = {
      header: { gtfs_realtime_version: "2.0" },
      entity: [{ id: "trip-notice", alert: { informed_entity: [selector], effect: "NO_SERVICE" } }],
    };
    const decoded = await Effect.runPromise(
      decodeGtfsRealtimeJsonAlertFeed(new TextEncoder().encode(JSON.stringify(feed))),
    );
    expect(decoded.alerts[0]).toMatchObject({
      tripIds: ["t"],
      tripScoped: true,
      routeIds,
      targets,
    });
  },
);

it("keeps a mixed trip and route notice broader than its trip selector", async () => {
  const feed = {
    header: { gtfs_realtime_version: "2.0" },
    entity: [
      {
        id: "mixed-notice",
        alert: {
          informed_entity: [{ trip: { trip_id: "t", route_id: "r" } }, { route_id: "other" }],
        },
      },
    ],
  };
  const decoded = await Effect.runPromise(
    decodeGtfsRealtimeJsonAlertFeed(new TextEncoder().encode(JSON.stringify(feed))),
  );
  expect(decoded.alerts[0]?.tripIds).toEqual(["t"]);
  expect(decoded.alerts[0]?.tripScoped).toBeUndefined();
  expect(decoded.alerts[0]?.routeIds).toEqual(["r", "other"]);
});
