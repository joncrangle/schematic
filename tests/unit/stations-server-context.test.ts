import { describe, expect, it, vi } from "vitest";

vi.mock("~/agencies/agencyCatalog", async () => {
  const { testAgencyCatalog } = await import("../helpers/agency-fixtures");
  return { agencyCatalog: testAgencyCatalog };
});

const { getStationsSourceContext } = await import("~/services/StationsServer");

describe("stations source contexts", () => {
  it("shares the fallback provider context across unknown agency ids", async () => {
    const first = await getStationsSourceContext("unknown-agency-one", "en-CA");
    const second = await getStationsSourceContext("unknown-agency-two", "en-CA");
    expect(second).toBe(first);
  });
});
