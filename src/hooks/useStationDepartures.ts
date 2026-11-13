import { useQuery, type UseQueryResult } from "@tanstack/solid-query";
import { useSettledQueryData } from "~/hooks/useSettledQueryData";
import { interchangeDepartureId, type InterchangeDataset } from "~/domain/map/Interchange";
import { queryClient } from "~/lib/queryClient";
import { DEFAULT_UI_LOCALE, type UiLocale } from "~/domain/locale";
import type { StationDepartureGroup } from "~/services/StationsClient";

/**
 * Shared per-station departures source for the map popover and the nearby
 * panel card. Station ids are agency-local, so the key always carries both
 * halves of the identity. The gate stays out of the key: `enabled` only
 * decides whether this render subscribes, never which cache entry it reads.
 */
export const STATION_DEPARTURES_KEY = (
  agencyId: string,
  stationId: string,
  locale: UiLocale = DEFAULT_UI_LOCALE,
) => ["departures", agencyId, stationId, locale] as const;

export interface StationEndpoint {
  readonly agencyId: string;
  readonly stationId: string;
  /** Display name from the hub record, when the hub names it. */
  readonly stationName?: string;
}

/**
 * Pure hub resolution: which (agencyId, stationId) pairs supply departures
 * for the selected station. The selected pair comes first, then hub siblings
 * with their own pairs. Siblings are only discoverable through the hub
 * dataset: linked ids and names can differ entirely across agencies
 * (Danforth on one side, Main Street on the other), so nothing is derived.
 * Boards with seeded boarding stops use a hub identity. Overlapping boards
 * share one request, while distinct nearby stations keep their own sections.
 * Endpoints without either identity are skipped because departures are id-keyed,
 * and so is every agency the predicate reports as sourceless: subscribing
 * for one can only fail (503), which would paint an honest empty as a feed
 * outage. A station in no hub resolves to itself alone.
 */
export function resolveStationEndpoints(
  agencyId: string,
  stationId: string,
  hubs: InterchangeDataset,
  hasDeparturesSource: (agencyId: string) => boolean,
): readonly StationEndpoint[] {
  const selected = stationId.trim();
  if (!selected) return [];
  type Board = {
    agencyId: string;
    stationName?: string;
    stationIds: Set<string>;
    stopIds: Set<string>;
    hubIds: Set<string>;
  };
  const boards: Board[] = [];
  const matches = hubs.filter((hub) =>
    hub.endpoints.some(
      (endpoint) => endpoint.agencyId === agencyId && endpoint.stationId === selected,
    ),
  );
  const candidates = matches.flatMap((hub) =>
    hub.endpoints.map((endpoint) => ({ endpoint, hubId: hub.id })),
  );
  // Resolve the selected station first, even when its augmented board appears in a later hub.
  candidates.sort(
    (a, b) =>
      Number(b.endpoint.agencyId === agencyId && b.endpoint.stationId === selected) -
      Number(a.endpoint.agencyId === agencyId && a.endpoint.stationId === selected),
  );
  for (const { endpoint, hubId } of candidates) {
    if (
      !hasDeparturesSource(endpoint.agencyId) ||
      (!endpoint.stationId && !endpoint.feedStopIds?.length)
    )
      continue;
    const overlapping = boards.filter(
      (board) =>
        board.agencyId === endpoint.agencyId &&
        ((endpoint.stationId !== undefined && board.stationIds.has(endpoint.stationId)) ||
          endpoint.feedStopIds?.some((id) => board.stopIds.has(id))),
    );
    const board = overlapping[0] ?? {
      agencyId: endpoint.agencyId,
      stationName: endpoint.stationName,
      stationIds: new Set<string>(),
      stopIds: new Set<string>(),
      hubIds: new Set<string>(),
    };
    if (overlapping.length === 0) boards.push(board);
    for (const other of overlapping.slice(1)) {
      for (const id of other.stationIds) board.stationIds.add(id);
      for (const id of other.stopIds) board.stopIds.add(id);
      for (const id of other.hubIds) board.hubIds.add(id);
      boards.splice(boards.indexOf(other), 1);
    }
    if (endpoint.stationId) board.stationIds.add(endpoint.stationId);
    for (const id of endpoint.feedStopIds ?? []) board.stopIds.add(id);
    if (endpoint.feedStopIds?.length) board.hubIds.add(hubId);
  }
  if (matches.length === 0 && hasDeparturesSource(agencyId))
    return [{ agencyId, stationId: selected }];
  return boards.map((board) => ({
    agencyId: board.agencyId,
    stationId:
      board.hubIds.size > 0 ? interchangeDepartureId([...board.hubIds]) : [...board.stationIds][0]!,
    ...(board.stationName ? { stationName: board.stationName } : {}),
  }));
}

const departuresQueryFn = (agencyId: string, stationId: string, locale: UiLocale) => () =>
  import("~/services/StationsClient").then(({ fetchStationDeparturesViaHttp }) =>
    fetchStationDeparturesViaHttp({ agencyId, stationId, locale }),
  );

/**
 * Hover path: warms the exact entry the open subscription will read, without
 * attaching an observer. Shares key and queryFn identity with the hook below
 * so opening after a hover renders from cache instead of refetching.
 */
export function prefetchStationDepartures(
  agencyId: string,
  stationId: string,
  locale: UiLocale = DEFAULT_UI_LOCALE,
): Promise<void> {
  const key = STATION_DEPARTURES_KEY(agencyId, stationId, locale);
  return queryClient
    .prefetchQuery({ queryKey: [...key], queryFn: departuresQueryFn(agencyId, stationId, locale) })
    .then(() => undefined);
}

/**
 * Open path: subscribes to one station's departures while mounted.
 * `enabled` gates the network only; a disabled render reads nothing and
 * fetches nothing. Polls every 15s while open (the nearby cadence);
 * staleness and eviction ride the shared client defaults (30s / 60s) and
 * Settled groups survive background refreshes. Placeholder groups must belong
 * to the same station and locale as the current request.
 */
export function useStationDepartures(
  target: () => StationEndpoint | null,
  enabled: () => boolean = () => true,
  locale: () => UiLocale = () => DEFAULT_UI_LOCALE,
): UseQueryResult<readonly StationDepartureGroup[], Error> {
  const query = useQuery<readonly StationDepartureGroup[], Error>(
    () => {
      const endpoint = target();
      if (!endpoint) {
        return {
          queryKey: ["departures", "none"],
          queryFn: () => Promise.resolve([] as readonly StationDepartureGroup[]),
          enabled: false,
        };
      }
      const currentLocale = locale();
      return {
        queryKey: [...STATION_DEPARTURES_KEY(endpoint.agencyId, endpoint.stationId, currentLocale)],
        queryFn: departuresQueryFn(endpoint.agencyId, endpoint.stationId, currentLocale),
        enabled: enabled(),
        refetchInterval: 15_000,
        placeholderData: (previous, previousQuery) =>
          previousQuery?.queryKey[1] === endpoint.agencyId &&
          previousQuery.queryKey[2] === endpoint.stationId &&
          previousQuery.queryKey[3] === currentLocale
            ? previous
            : undefined,
      };
    },
    () => queryClient,
  );

  // Solid's asynchronous data projection can retain the previous render
  // during a key change. Read settled data for the requested identity, as the
  // Nearby stable-query seam does, so a pending locale never exposes old text.
  const settledData = useSettledQueryData<readonly StationDepartureGroup[]>(() => {
    const endpoint = target();
    if (!endpoint || !enabled()) return undefined;
    return STATION_DEPARTURES_KEY(endpoint.agencyId, endpoint.stationId, locale());
  });
  return new Proxy(query, {
    get(target, property, receiver) {
      return property === "data" ? settledData() : Reflect.get(target, property, receiver);
    },
  });
}
