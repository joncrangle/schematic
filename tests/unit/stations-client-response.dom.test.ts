// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { fetchStationDeparturesViaHttp } from "~/services/StationsClient";

vi.mock("~/services/StationsServer", () => ({
  handleFetchNearbyStations: vi.fn(),
  handleFetchSavedStations: vi.fn(),
}));

const responseFor = (generatedLabel?: unknown) => [
  {
    lineIds: ["R"],
    arrivals: [
      {
        directionId: 0,
        label: "Operator destination",
        times: [1_800_000_000_000],
        ...(generatedLabel === undefined ? {} : { generatedLabel }),
      },
    ],
  },
];

const readDepartures = (payload: unknown) =>
  fetchStationDeparturesViaHttp({ agencyId: "fictional", stationId: "central" }, async () =>
    Response.json(payload),
  );

describe("station departures response direction provenance", () => {
  it.each(["bogus", "toString", {}, null])(
    "rejects invalid generated direction marker %s",
    async (marker) => {
      await expect(readDepartures(responseFor(marker))).rejects.toThrow("not a departures array");
    },
  );
  it.each([undefined, "northbound", "southbound", "eastbound", "westbound", "outbound", "inbound"])(
    "accepts legacy directions and the semantic marker %s",
    async (marker) => {
      const payload = responseFor(marker);
      await expect(readDepartures(payload)).resolves.toEqual(payload);
    },
  );
});
