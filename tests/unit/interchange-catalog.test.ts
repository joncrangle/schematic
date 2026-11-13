import { expect, it, vi } from "vitest";

vi.mock("~/agencies/interchangeCatalog", () => ({
  interchangeCatalog: [
    {
      regionPath: "ca/first",
      hubs: [
        {
          id: "first-hub",
          endpoints: [
            { agencyId: "alpha", stationName: "Central" },
            { agencyId: "national", stationName: "Central" },
          ],
        },
      ],
    },
    {
      regionPath: "us/second",
      hubs: [
        {
          id: "second-hub",
          endpoints: [
            { agencyId: "beta", stationName: "Central" },
            { agencyId: "international", stationName: "Central" },
          ],
        },
      ],
    },
  ],
}));

import { interchanges } from "~/agencies/interchanges";

it("loads all explicitly registered regional artifacts", () => {
  expect(interchanges.map((hub) => hub.id)).toEqual(["first-hub", "second-hub"]);
});
