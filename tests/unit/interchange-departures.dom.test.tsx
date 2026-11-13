vi.mock("~/agencies/agencyCatalog", async () => {
  const { testAgencyCatalog } = await import("../helpers/agency-fixtures");
  return { agencyCatalog: testAgencyCatalog };
});
// @vitest-environment happy-dom
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { makeTestProvider, makeStationSchematic } from "../helpers/agency-fixtures";
const interchanges = [
  {
    id: "campus",
    endpoints: [
      { agencyId: "local", stationId: "campus", stationName: "Campus" },
      { agencyId: "regional", stationName: "Campus", feedStopIds: ["boarding"] },
    ],
  },
];
import { buildMapModel } from "~/core/map";
import { StationPopover } from "~/components/map/StationPopover";
import { UserPreferencesProvider } from "~/context/UserPreferencesContext";
import { createMemoryPreferencesStorage } from "~/infrastructure/storage/PreferencesStorage";
import { resolveStationEndpoints } from "~/hooks/useStationDepartures";
import { queryClient } from "~/lib/queryClient";
import { buildDataStoreService } from "~/infrastructure/storage/memorySurfaceDataStore";
import { fetchFeedStationDepartures } from "~/services/FeedStationDepartures";
import {
  createStationDeparturesGetter,
  handleDeparturesGet,
} from "~/services/StationDeparturesEndpoint";
import { encodeFeed, encodeSubwayTripUpdateEntity } from "../helpers/gtfs-rt-binary";

const now = 1_700_000_000_000;
const routes = ["22", "56"].map((id) => ({
  id,
  shortName: id,
  longName: `Regional bus ${id}`,
  routeType: "bus" as const,
  color: "00853F",
  textColor: "FFFFFF",
}));
const store = buildDataStoreService({
  stops: [
    {
      id: "boarding",
      name: "Campus",
      lat: 43.4696,
      lon: -79.6974,
      wheelchair: 1,
      routes: ["22", "56"],
    },
  ],
  routes,
  shapes: [],
  routeStops: [],
  tripTerminals: new Map([
    ["22", new Map([["terminating", { stopId: "boarding", stopSequence: 5 }]])],
  ]),
});
const provider = makeTestProvider({
  id: "regional",
  modes: ["bus"],
  stationService: { routeType: "bus" },
  staticTopology: { source: "seed", routeIdField: "short_name" },
  alertInterpretation: { routeIdNormalization: { extractPattern: "^[^-]+-(.+)$" } },
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
});

it("renders Regional bus departures alongside Local routes in Campus's card", async () => {
  const feed = encodeFeed(now / 1000, [
    ...routes.map((route) =>
      encodeSubwayTripUpdateEntity({
        entityId: `subway-bus-${route.id}|Eastbound`,
        routeId: `feed-${route.id}`,
        stopId: "boarding",
        arrivalTimeSec: now / 1000 + Number(route.id) * 60,
      }),
    ),
    encodeSubwayTripUpdateEntity({
      entityId: "subway-terminating|Eastbound",
      tripId: "terminating",
      routeId: "feed-22",
      stopId: "boarding",
      arrivalTimeSec: now / 1000 + 30,
    }),
    encodeSubwayTripUpdateEntity({
      entityId: "unrelated",
      routeId: "feed-47",
      stopId: "boarding",
      arrivalTimeSec: now / 1000 + 90,
    }),
  ]);
  const getFeedStations = vi.fn((input: Parameters<typeof fetchFeedStationDepartures>[0]) =>
    Effect.runPromise(
      fetchFeedStationDepartures(input, {
        provider,
        store,
        identities: {
          hasTripIdentities: false,
          getRoutesForTrips: () => Effect.succeed(new Map()),
        },
        now: () => now,
        getSecret: () => "fixture-key",
        fetch: vi.fn(async () => new Response(new Uint8Array(feed))),
      }),
    ),
  );
  const getter = createStationDeparturesGetter(
    interchanges,
    async () =>
      [1, 6].map((route) => ({
        id: `905:${route}`,
        stationName: "Campus",
        lineIds: [String(route)],
        agencyId: "local",
        distanceMeters: 0,
        walkingMinutes: 0,
        arrivals: [
          {
            directionId: 0 as const,
            label: "Eastbound",
            lineId: String(route),
            times: [now + 60_000],
          },
        ],
      })),
    getFeedStations,
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "https://example.test");
      const [, , , agencyId, stationId] = url.pathname.split("/");
      return handleDeparturesGet(
        agencyId,
        decodeURIComponent(stationId!),
        getter,
        url.searchParams.get("locale") ?? undefined,
      );
    }),
  );
  const map = buildMapModel(makeStationSchematic(["Campus", "Terminus"]));
  const sections = resolveStationEndpoints("local", "campus", interchanges, () => true).map(
    (endpoint) => ({
      ...endpoint,
      header: `Campus · ${endpoint.agencyId === "regional" ? "Regional" : "Local"}`,
    }),
  );
  render(() => (
    <UserPreferencesProvider storage={createMemoryPreferencesStorage()}>
      <StationPopover
        agencyId="local"
        station={map.stationsById.get("campus")!}
        coords={{ x: 300, y: 300 }}
        onClose={() => {}}
        setRef={() => {}}
        linesById={map.linesById}
        departureSections={sections}
      />
    </UserPreferencesProvider>
  ));

  expect(await screen.findByText("Campus · Regional")).toBeDefined();
  expect(await screen.findByText("Regional bus 22")).toBeDefined();
  expect(await screen.findByText("Regional bus 56")).toBeDefined();
  expect(screen.getByText("Campus · Local")).toBeDefined();
  expect(getFeedStations).toHaveBeenCalledWith(
    expect.objectContaining({ agencyId: "regional", stopIds: ["boarding"] }),
  );
  const groups = await getter({ agencyId: "regional", stationId: sections[1]!.stationId });
  expect(groups.map((group) => group.lineIds)).toEqual([["22"], ["56"]]);
  expect(groups.flatMap((group) => group.arrivals.flatMap((row) => row.times))).toEqual([
    now + 22 * 60_000,
    now + 56 * 60_000,
  ]);
});

it.each([
  "interchange:unknown",
  'interchanges:["campus","unknown"]',
  "interchanges:[]",
  "interchanges:invalid",
])(
  "rejects unregistered interchange target %s without looking up arbitrary feed stops",
  async (stationId) => {
    const getFeedStations = vi.fn(async () => []);
    const getter = createStationDeparturesGetter(interchanges, async () => [], getFeedStations);
    const response = await handleDeparturesGet("regional", stationId, getter);
    expect(response.status).toBe(404);
    expect(getFeedStations).not.toHaveBeenCalled();
  },
);

it("surfaces missing seeded boarding stops as an error rather than empty departures", async () => {
  await expect(
    Effect.runPromise(
      fetchFeedStationDepartures(
        {
          agencyId: "regional",
          stationId: "interchange:missing",
          stationName: "Missing",
          stopIds: ["missing"],
        },
        {
          provider,
          store,
          identities: {
            hasTripIdentities: false,
            getRoutesForTrips: () => Effect.succeed(new Map()),
          },
          fetch: vi.fn(),
        },
      ),
    ),
  ).rejects.toThrow("Interchange boarding stops are missing");
});

it("uses all boarding bays while preserving a drawable peer identity", async () => {
  const dataset = [
    {
      id: "campus",
      endpoints: [
        { agencyId: "local", stationId: "campus", stationName: "Campus" },
        {
          agencyId: "regional",
          stationId: "regional-campus",
          stationName: "Campus",
          feedStopIds: ["east", "west"],
        },
      ],
    },
  ];
  const getStations = vi.fn(async () => []);
  const getFeedStations = vi.fn(async () => []);
  const sections = resolveStationEndpoints("local", "campus", dataset, () => true);
  expect(sections[1]?.stationId).toBe("interchange:campus");
  const getter = createStationDeparturesGetter(dataset, getStations, getFeedStations);
  await getter(sections[1]!);
  expect(getFeedStations).toHaveBeenCalledWith({
    agencyId: "regional",
    stationId: "interchange:campus",
    stationName: "Campus",
    stopIds: ["east", "west"],
  });
  expect(getStations).not.toHaveBeenCalled();
});

it("includes every reviewed hub membership for a shared station", () => {
  const dataset = [
    {
      id: "local-regional",
      endpoints: [
        { agencyId: "local", stationId: "campus", stationName: "Campus" },
        { agencyId: "regional", stationId: "central", stationName: "Central" },
      ],
    },
    {
      id: "local-intercity",
      endpoints: [
        { agencyId: "local", stationId: "campus", stationName: "Campus" },
        { agencyId: "regional", stationName: "Forecourt", feedStopIds: ["bay"] },
        { agencyId: "intercity", stationId: "campus", stationName: "Campus" },
      ],
    },
  ];
  expect(resolveStationEndpoints("local", "campus", dataset, () => true)).toEqual([
    { agencyId: "local", stationId: "campus", stationName: "Campus" },
    { agencyId: "regional", stationId: "central", stationName: "Central" },
    { agencyId: "regional", stationId: "interchange:local-intercity", stationName: "Forecourt" },
    { agencyId: "intercity", stationId: "campus", stationName: "Campus" },
  ]);
});

it("combines overlapping boarding stops once and replaces the same station's canonical board", async () => {
  const dataset = [
    {
      id: "rail",
      endpoints: [
        { agencyId: "local", stationId: "campus", stationName: "Campus" },
        { agencyId: "regional", stationId: "central", stationName: "Central" },
      ],
    },
    {
      id: "east",
      endpoints: [
        {
          agencyId: "local",
          stationId: "campus",
          stationName: "Campus",
          feedStopIds: ["rail", "bus"],
        },
        { agencyId: "regional", stationName: "Forecourt", feedStopIds: ["east", "shared"] },
      ],
    },
    {
      id: "west",
      endpoints: [
        {
          agencyId: "local",
          stationId: "campus",
          stationName: "Campus",
          feedStopIds: ["rail", "bus"],
        },
        { agencyId: "regional", stationName: "Forecourt", feedStopIds: ["shared", "west"] },
      ],
    },
  ];
  const sections = resolveStationEndpoints("local", "campus", dataset, () => true);
  expect(sections.map(({ agencyId, stationName }) => [agencyId, stationName])).toEqual([
    ["local", "Campus"],
    ["regional", "Central"],
    ["regional", "Forecourt"],
  ]);
  const getStations = vi.fn(async () => []);
  const getFeedStations = vi.fn(
    async (_input: Parameters<typeof fetchFeedStationDepartures>[0]) => [],
  );
  const getter = createStationDeparturesGetter(dataset, getStations, getFeedStations, () => true);
  for (const section of sections) await getter(section);
  expect(getStations).toHaveBeenCalledExactlyOnceWith({
    agencyId: "regional",
    stationIds: ["central"],
  });
  expect(getFeedStations).toHaveBeenCalledTimes(2);
  expect(getFeedStations.mock.calls.map(([input]) => [input.agencyId, input.stopIds])).toEqual([
    ["local", ["rail", "bus"]],
    ["regional", ["east", "shared", "west"]],
  ]);
});

it("resolves interchange trips through the shared lookups: index first, memoized D1 terminals", async () => {
  const feed = encodeFeed(now / 1000, [
    encodeSubwayTripUpdateEntity({
      entityId: "subway-indexed|Eastbound",
      tripId: "indexed",
      stopId: "boarding",
      arrivalTimeSec: now / 1000 + 60,
    }),
    encodeSubwayTripUpdateEntity({
      entityId: "subway-terminating|Eastbound",
      tripId: "terminating",
      routeId: "feed-22",
      stopId: "boarding",
      arrivalTimeSec: now / 1000 + 30,
    }),
  ]);
  const spied = {
    ...store,
    getRoutesForTrips: vi.fn(store.getRoutesForTrips ?? (() => Effect.succeed(new Map()))),
    getTripTerminals: vi.fn(store.getTripTerminals),
  };
  const indexed = vi.fn((ids: readonly string[]) =>
    Effect.succeed(new Map(ids.map((id) => [id, { routeId: "feed-22", directionId: 0 }] as const))),
  );
  const read = () =>
    Effect.runPromise(
      fetchFeedStationDepartures(
        {
          agencyId: "regional-lookups",
          stationId: "interchange:campus",
          stationName: "Campus",
          stopIds: ["boarding"],
        },
        {
          provider,
          store: spied,
          identities: { hasTripIdentities: true, getRoutesForTrips: indexed },
          now: () => now,
          getSecret: () => "fixture-key",
          fetch: vi.fn(async () => new Response(new Uint8Array(feed))),
        },
      ),
    );
  await read();
  expect(indexed).toHaveBeenCalled();
  expect(spied.getRoutesForTrips).not.toHaveBeenCalled();
  const terminalReads = spied.getTripTerminals.mock.calls.length;
  expect(terminalReads).toBeGreaterThan(0);
  await read();
  expect(spied.getTripTerminals).toHaveBeenCalledTimes(terminalReads);
});
