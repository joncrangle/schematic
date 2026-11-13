import { describe, expect, it } from "vitest";
import {
  parseTmixStopResponse,
  parseTmixVehiclePosition,
  tmixPositionsToVehicles,
} from "~/infrastructure/realtime/tmix/tmixCallsDecoder";
import { buildTmixMessageFeed } from "~/infrastructure/realtime/tmix/tmixMessageAlerts";
import { tmixFixture } from "../fixtures/realtime/tmix-wire-fixtures";

const encode = (text: string) => new TextEncoder().encode(text);

/**
 * Captures from a second AnyRide tenant (2026-10-15, weekday service hours),
 * kept as wire evidence for the message adapter, the profile header and the
 * duplicate-fix collapse. See tests/fixtures/realtime/tmix/README.md.
 */
describe("AnyRide tenant capture: service messages", () => {
  const response = parseTmixStopResponse(encode(tmixFixture("calls.linx.profile.json")));

  it("decodes the message verbatim with its wire flags", () => {
    expect(response.messages).toEqual([
      {
        id: "TX1027190",
        text: "Route 4 detour for CCI Eastbound trip due to construction.",
        priority: 100,
        isDisturbance: false,
        isInfo: true,
        affectedCalls: ["0"],
      },
    ]);
  });

  it("attributes the route from the call the message names and scopes it to the queried stop", () => {
    const feed = buildTmixMessageFeed([{ stopId: "STOP-A", routeIds: ["4", "9"] }], [response], {
      operatorPrefix: "9000",
      now: 1_000,
    });

    expect(feed?.alerts[0]).toMatchObject({
      id: "TX1027190",
      routeIds: ["4"],
      targets: [{ routeId: "4", stopId: "STOP-A" }],
    });
  });

  it("reads a message from a stop that has no calls at all", () => {
    const empty = parseTmixStopResponse(
      encode(
        JSON.stringify({
          isStopCancelled: false,
          calls: [],
          messages: [
            {
              id: "TX1",
              text: "Notice.",
              priority: 100,
              isDisturbance: false,
              isInfo: true,
              affectedCalls: [],
            },
          ],
        }),
      ),
    );
    const feed = buildTmixMessageFeed([{ stopId: "STOP-B", routeIds: ["4"] }], [empty], {
      operatorPrefix: "9000",
      now: 1_000,
    });

    expect(feed?.alerts[0]?.targets).toEqual([{ routeId: "4", stopId: "STOP-B" }]);
  });

  it("records that the profile header changes how many calls a stop returns", () => {
    const without = parseTmixStopResponse(encode(tmixFixture("calls.linx.no-profile.json")));

    expect(without.calls).toHaveLength(1);
    expect(
      parseTmixStopResponse(encode(tmixFixture("calls.linx.profile.json"))).calls.length,
    ).toBeGreaterThan(without.calls.length);
  });
});

describe("AnyRide tenant capture: one bus named by calls of several routes", () => {
  const calls = parseTmixStopResponse(encode(tmixFixture("calls.linx.interlined.json"))).calls;
  const resolved = (
    JSON.parse(tmixFixture("vehicle-positions.linx.interlined.json")) as unknown[]
  ).flatMap((body) => {
    const position = parseTmixVehiclePosition(encode(JSON.stringify(body)));
    const call = calls.find((candidate) => candidate.id === position?.callId);
    return position && call ? [{ call, position }] : [];
  });
  const project = () => 0 as const;

  it("shows one bus per physical fix, on the call that is already running", () => {
    const vehicles = tmixPositionsToVehicles(resolved, {
      project,
      duplicateVehicleFixes: "collapse-by-fix",
    });

    expect(vehicles.map((vehicle) => [vehicle.vehicleId, vehicle.routeId]).sort()).toEqual([
      ["1240911079", "4"],
      ["1240916201", "6"],
    ]);
  });

  it("keeps all four calls when the feed does not opt in", () => {
    expect(tmixPositionsToVehicles(resolved, { project })).toHaveLength(4);
  });
});
