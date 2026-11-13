// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal, Loading } from "solid-js";
import type { UiLocale } from "~/domain/locale";
import { queryClient } from "~/lib/queryClient";
import {
  prefetchStationDepartures,
  resolveStationEndpoints,
  STATION_DEPARTURES_KEY,
  useStationDepartures,
} from "~/hooks/useStationDepartures";
import type { InterchangeDataset } from "~/domain/map/Interchange";
import {
  discoverInterchanges,
  stationsFromSeededTables,
} from "../../scripts/lib/interchange-detection";

const hubs = [
  {
    id: "go-ttc-kennedy",
    endpoints: [
      { agencyId: "go", stationName: "Kennedy", stationId: "kennedy" },
      { agencyId: "ttc", stationName: "Kennedy", stationId: "kennedy" },
    ],
  },
  {
    id: "go-ttc-mainstreet",
    endpoints: [
      { agencyId: "go", stationName: "Danforth", stationId: "danforth" },
      { agencyId: "ttc", stationName: "Main Street", stationId: "main-street" },
    ],
  },
] as unknown as InterchangeDataset;

const groupPayload = [
  {
    lineIds: ["LW"],
    arrivals: [{ directionId: 0, label: "Eastbound", times: [1_700_000_300_000] }],
  },
];

function stubFetch(payload: unknown = groupPayload) {
  return vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => payload }) as Response),
  );
}

beforeEach(() => {
  queryClient.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  queryClient.clear();
});

describe("resolveStationEndpoints", () => {
  it("includes feed-only GO buses when opening Sheridan College from Oakville", () => {
    const stations = stationsFromSeededTables(
      "go",
      [
        {
          table: "routes",
          rows: [
            { id: "22", route_type: 3 },
            { id: "56", route_type: 3 },
          ],
        },
        {
          table: "stops",
          rows: [
            {
              id: "00939",
              name: "Sheridan College",
              lat: 43.4696,
              lon: -79.6974,
              routes_json: '["22","56"]',
            },
          ],
        },
      ],
      [{ id: "union", name: "Union" }],
      [{ id: "sheridan-college", name: "Sheridan College" }],
    );
    const dataset = discoverInterchanges([
      ...stations,
      {
        agencyId: "oakville",
        id: "905",
        schematicId: "sheridan-college",
        name: "Sheridan College",
        lat: 43.4696,
        lon: -79.6974,
      },
    ]);
    expect(resolveStationEndpoints("oakville", "sheridan-college", dataset, () => true)).toEqual([
      { agencyId: "oakville", stationId: "sheridan-college", stationName: "Sheridan College" },
      {
        agencyId: "go",
        stationId: "interchange:go-oakville-sheridancollege",
        stationName: "Sheridan College",
      },
    ]);
  });

  it("returns the selected pair first, then hub siblings with their own pairs", () => {
    expect(resolveStationEndpoints("ttc", "kennedy", hubs, () => true)).toEqual([
      { agencyId: "ttc", stationId: "kennedy", stationName: "Kennedy" },
      { agencyId: "go", stationId: "kennedy", stationName: "Kennedy" },
    ]);
  });

  it("resolves asymmetric hubs where names and ids differ per agency", () => {
    expect(resolveStationEndpoints("ttc", "main-street", hubs, () => true)).toEqual([
      { agencyId: "ttc", stationId: "main-street", stationName: "Main Street" },
      { agencyId: "go", stationId: "danforth", stationName: "Danforth" },
    ]);
  });

  it("returns just the selected pair when no hub contains it", () => {
    expect(resolveStationEndpoints("ttc", "union", hubs, () => true)).toEqual([
      { agencyId: "ttc", stationId: "union" },
    ]);
  });

  it("skips hub endpoints without a station id", () => {
    const dataset = [
      {
        id: "partial",
        endpoints: [
          { agencyId: "ttc", stationName: "Kennedy", stationId: "kennedy" },
          { agencyId: "go", stationName: "Kennedy" },
        ],
      },
    ] as unknown as InterchangeDataset;

    expect(resolveStationEndpoints("ttc", "kennedy", dataset, () => true)).toEqual([
      { agencyId: "ttc", stationId: "kennedy", stationName: "Kennedy" },
    ]);
  });

  it("skips hub siblings whose agency has no departures source", () => {
    // Finch links a bus-only agency with no stations source. Subscribing for
    // it can only fail, and the failure would paint an honest empty as a
    // feed outage, so the sibling is dropped silently.
    const dataset = [
      {
        id: "go-ttc-yrt-finch",
        endpoints: [
          { agencyId: "go", stationName: "Finch" },
          { agencyId: "ttc", stationName: "Finch", stationId: "finch" },
          { agencyId: "yrt", stationName: "Finch", stationId: "finch" },
        ],
      },
    ] as unknown as InterchangeDataset;
    const hasSource = (agencyId: string) => agencyId !== "yrt";

    expect(resolveStationEndpoints("ttc", "finch", dataset, hasSource)).toEqual([
      { agencyId: "ttc", stationId: "finch", stationName: "Finch" },
    ]);
  });

  it("resolves to empty when the selected agency itself has no source", () => {
    expect(resolveStationEndpoints("yrt", "finch", hubs, () => false)).toEqual([]);
  });

  it.each(["", "   "])("returns empty for blank station id %p", (stationId) => {
    expect(resolveStationEndpoints("ttc", stationId, hubs, () => true)).toEqual([]);
  });
});

describe("useStationDepartures gating", () => {
  it("does not display the previous locale's board while its replacement is pending", async () => {
    let resolveFrench!: (response: Response) => void;
    const pendingFrench = new Promise<Response>((resolve) => {
      resolveFrench = resolve;
    });
    const fetch = vi.fn((input: RequestInfo | URL) =>
      String(input).includes("locale=fr-CA")
        ? pendingFrench
        : Promise.resolve(Response.json(groupPayload)),
    );
    vi.stubGlobal("fetch", fetch);
    await prefetchStationDepartures("sample", "central", "en-CA");
    render(() => {
      const [locale, setLocale] = createSignal<UiLocale>("en-CA");
      const query = useStationDepartures(
        () => ({ agencyId: "sample", stationId: "central" }),
        () => true,
        locale,
      );
      return (
        <>
          <button onClick={() => setLocale("fr-CA")}>Switch language</button>
          <Loading fallback={<span>Loading board</span>}>
            <span>{query.data?.[0]?.arrivals[0]?.label}</span>
          </Loading>
        </>
      );
    });
    expect(await screen.findByText("Eastbound")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Switch language" }));
    await waitFor(() =>
      expect(fetch.mock.calls.some(([input]) => String(input).includes("locale=fr-CA"))).toBe(true),
    );
    expect(screen.queryByText("Eastbound")).toBeNull();
    resolveFrench(
      Response.json([
        { ...groupPayload[0], arrivals: [{ ...groupPayload[0].arrivals[0], label: "Vers l’est" }] },
      ]),
    );
    expect(await screen.findByText("Vers l’est")).toBeTruthy();
  });

  it("prefetches without a subscription: cache warms, no observer attached", async () => {
    stubFetch();

    await prefetchStationDepartures("ttc", "kennedy");

    expect(queryClient.getQueryData([...STATION_DEPARTURES_KEY("ttc", "kennedy")])).toEqual(
      groupPayload,
    );
  });

  it("fetches nothing while disabled", async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => groupPayload }) as Response);
    vi.stubGlobal("fetch", fetch);

    render(() => {
      useStationDepartures(
        () => ({ agencyId: "ttc", stationId: "kennedy" }),
        () => false,
      );
      return <div />;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetch).not.toHaveBeenCalled();
  });

  it("subscribes while open and serves the prefetched snapshot first", async () => {
    stubFetch();
    await prefetchStationDepartures("ttc", "kennedy");

    let data: unknown;
    const { unmount } = render(() => {
      const query = useStationDepartures(
        () => ({ agencyId: "ttc", stationId: "kennedy" }),
        () => true,
      );
      data = query.data;
      return <div />;
    });

    expect(data).toEqual(groupPayload);
    unmount();
  });
});
