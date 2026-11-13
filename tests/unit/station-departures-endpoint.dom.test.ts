vi.mock("~/agencies/agencyCatalog", async () => {
  const { testAgencyCatalog } = await import("../helpers/agency-fixtures");
  return { agencyCatalog: testAgencyCatalog };
});
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StationDepartureGroup } from "~/services/StationsClient";
import {
  DEPARTURES_BROWSER_CACHE,
  DEPARTURES_EDGE_CACHE,
  DEPARTURES_PARTIAL_EDGE_CACHE,
  DEPARTURES_UNKNOWN_STATION_EDGE_CACHE,
  createStationDeparturesGetter,
  handleDeparturesGet,
  handleDeparturesHead,
} from "~/services/StationDeparturesEndpoint";

const groups = (lineIds: readonly string[]): readonly StationDepartureGroup[] =>
  lineIds.map((line) => ({
    lineIds: [line],
    arrivals: [{ directionId: 0 as const, label: "Eastbound", times: [1_700_000_300_000] }],
  }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/departures/:agencyId/:stationId", () => {
  it("passes a validated locale through to the stations getter", async () => {
    const getter = vi.fn(async () => groups(["LW"]));
    const response = await handleDeparturesGet("sample", "union-schematic", getter, "fr-FR");

    expect(response.status).toBe(200);
    expect(getter).toHaveBeenCalledWith({
      agencyId: "sample",
      stationId: "union-schematic",
      locale: "fr-CA",
    });
  });

  it("rejects unsupported locales without caching or calling the getter", async () => {
    const getter = vi.fn(async () => groups(["LW"]));
    const response = await handleDeparturesGet("sample", "union-schematic", getter, "de-DE");

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(getter).not.toHaveBeenCalled();
  });

  it("returns arrivals-only groups for a known station", async () => {
    const response = await handleDeparturesGet("sample", "union-schematic", async () =>
      groups(["LW"]),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as readonly StationDepartureGroup[];
    expect(body).toEqual(groups(["LW"]));
    expect(body[0]).not.toHaveProperty("distanceMeters");
  });

  it("emits a fresh-only edge policy with no stale windows on success", async () => {
    const response = await handleDeparturesGet("sample", "union-schematic", async () =>
      groups(["LW"]),
    );

    expect(response.headers.get("Cache-Control")).toBe(DEPARTURES_BROWSER_CACHE);
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe(DEPARTURES_EDGE_CACHE);
    expect(response.headers.get("cloudflare-cdn-cache-control")).not.toMatch(
      /stale-while-revalidate/,
    );
  });

  it("emits no-store when any departure group is stale", async () => {
    const staleGroups: readonly StationDepartureGroup[] = [
      {
        lineIds: ["LW"],
        arrivals: [],
        arrivalsStale: true,
      },
    ];
    const response = await handleDeparturesGet(
      "sample",
      "union-schematic",
      async () => staleGroups,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBeNull();
  });

  it.each([
    {
      description: "an empty route group",
      responseGroups: [{ lineIds: ["1"], arrivals: [] }],
    },
    {
      description: "a direction with no predictions",
      responseGroups: [
        { lineIds: ["1"], arrivals: [{ directionId: 0, label: "Northbound", times: [] }] },
      ],
    },
    {
      description: "an empty route beside a live route",
      responseGroups: [...groups(["1"]), { lineIds: ["6"], arrivals: [] }],
    },
  ] satisfies readonly {
    description: string;
    responseGroups: readonly StationDepartureGroup[];
  }[])("edge-caches $description briefly", async ({ responseGroups }) => {
    const response = await handleDeparturesGet("sample", "union", async () => responseGroups);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(DEPARTURES_BROWSER_CACHE);
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe(
      DEPARTURES_PARTIAL_EDGE_CACHE,
    );
  });

  it.each([
    ["", "union-schematic"],
    ["   ", "union-schematic"],
    ["sample", ""],
    ["sample", "   "],
    [undefined, "union-schematic"],
    ["sample", undefined],
    [42, "union-schematic"],
  ])("malformed ids %p / %p return 400 no-store", async (agencyId, stationId) => {
    const getDepartures = vi.fn(async () => groups(["LW"]));
    const response = await handleDeparturesGet(agencyId, stationId, getDepartures);

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(getDepartures).not.toHaveBeenCalled();
  });

  it("unknown agency IDs return 404 and never fall back to the active provider", async () => {
    const getDepartures = vi.fn(async () => groups(["LW"]));
    const response = await handleDeparturesGet("no-such-agency", "union-schematic", getDepartures);

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(getDepartures).not.toHaveBeenCalled();
  });

  it("unknown station IDs return a 404 the edge holds briefly", async () => {
    const response = await handleDeparturesGet("sample", "no-such-station", async () => []);

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe(DEPARTURES_BROWSER_CACHE);
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe(
      DEPARTURES_UNKNOWN_STATION_EDGE_CACHE,
    );
  });

  it("answers unknown station IDs without reading departures", async () => {
    const getStations = vi.fn(async () => []);
    const getter = createStationDeparturesGetter([], getStations, vi.fn(), () => false);

    const response = await handleDeparturesGet("sample", "no-such-station", getter);

    expect(response.status).toBe(404);
    expect(getStations).not.toHaveBeenCalled();
  });

  it("store failures return 503 no-store so errors are never cached", async () => {
    const response = await handleDeparturesGet("sample", "union-schematic", async () => {
      throw new Error("feed down");
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/feed down/);
  });

  it("HEAD mirrors GET status and headers with no body", async () => {
    const response = await handleDeparturesHead("sample", "union-schematic", async () =>
      groups(["LW"]),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(DEPARTURES_BROWSER_CACHE);
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe(DEPARTURES_EDGE_CACHE);
    expect(await response.text()).toBe("");
  });

  it("HEAD mirrors the 404 for unknown stations", async () => {
    const response = await handleDeparturesHead("sample", "no-such-station", async () => []);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });
});
