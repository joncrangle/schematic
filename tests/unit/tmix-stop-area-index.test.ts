import { describe, expect, it } from "vitest";
import { mapTmixStopAreas } from "~/infrastructure/gtfs/tmixStopAreaIndex";

describe("AnyRide GTFS stop-area matching", () => {
  it("uses route order to distinguish identical names and wraps closed trips", () => {
    const stops = { A: "Terminal", B: "Main Street", C: "Main Street", D: "Terminal" };
    expect(mapTmixStopAreas(stops, [
      { stops: ["A", "B", "C", "D"], areas: [
        { externalId: "10", text: "Terminal (10)" },
        { externalId: "11", text: "Main Street (11)" },
        { externalId: "12", text: "Main Street (12)" },
        { externalId: "13", text: "Terminal (13)" },
      ] },
      { stops: ["A", "B", "A"], areas: [
        { externalId: "10", text: "Terminal (10)" },
        { externalId: "11", text: "Main Street (11)" },
      ] },
    ])).toEqual({ A: "10", B: "11", C: "12", D: "13" });
  });

  it("matches unique branch stops even when the vendor appends them after the main loop", () => {
    expect(mapTmixStopAreas({ A: "Terminal", B: "Branch", C: "Return" }, [
      { stops: ["A", "B", "C", "A"], areas: [
        { externalId: "1", text: "Terminal (1)" },
        { externalId: "3", text: "Return (3)" },
        { externalId: "2", text: "Branch (2)" },
      ] },
    ])).toEqual({ A: "1", B: "2", C: "3" });
  });

  it("rejects a unique match contradicted by another route's ambiguous candidates", () => {
    expect(() => mapTmixStopAreas({ A: "Main" }, [
      { stops: ["A"], areas: [{ externalId: "1", text: "Main (1)" }] },
      { stops: ["A"], areas: [{ externalId: "2", text: "Main (2)" }, { externalId: "3", text: "Main (3)" }] },
    ])).toThrow(/Conflicting/);
  });

  it("rejects missing, ambiguous and conflicting matches instead of guessing", () => {
    expect(() => mapTmixStopAreas({ A: "Unknown" }, [
      { stops: ["A"], areas: [{ externalId: "1", text: "Elsewhere (1)" }] },
    ])).toThrow(/Unmapped/);
    expect(() => mapTmixStopAreas({ A: "Main" }, [
      { stops: ["A"], areas: [{ externalId: "1", text: "Main (1)" }, { externalId: "2", text: "Main (2)" }] },
    ])).toThrow(/Unmapped/);
    expect(() => mapTmixStopAreas({ A: "Main" }, [
      { stops: ["A"], areas: [{ externalId: "1", text: "Main (1)" }] },
      { stops: ["A"], areas: [{ externalId: "2", text: "Main (2)" }] },
    ])).toThrow(/Conflicting/);
  });
});

it("builds the index from GTFS and profile-scoped vendor endpoints", async () => {
  const { buildTmixStopAreaIndex } = await import("~/infrastructure/gtfs/tmixStopAreaIndex");
  const { gtfsZip } = await import("../helpers/gtfsArchive");
  const archive = gtfsZip({
    "routes.txt": "route_id,route_short_name,route_long_name\n5,,Harbour\n",
    "stops.txt": "stop_id,stop_name\nOPAQUE,Terminal\nMID,Water Street\n",
    "trips.txt": "trip_id,route_id\nt,5\n",
    "stop_times.txt": "trip_id,stop_id,stop_sequence\nt,OPAQUE,1\nt,MID,2\nt,OPAQUE,3\n",
  });
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json(String(url).endsWith("GetLines")
      ? [{ id: 770001, text: "Harbour - Harbour" }]
      : [{ externalId: "90", text: "Terminal (90)" }, { externalId: "91", text: "Water Street (91)" }]);
  };
  expect(await buildTmixStopAreaIndex([archive], {
    kind: "tmix_anyride", format: "json", url: "https://vendor.example.test/api",
    operatorPrefix: "77", profile: { data: "fictional", display: "public" },
  }, fetchImpl)).toEqual({ MID: "91", OPAQUE: "90" });
  expect(new Headers(requests[0]?.init?.headers).get("anyride-profile-data")).toBe("fictional");
  expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({ lineId: 770001 });
});
