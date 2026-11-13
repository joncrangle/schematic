import { DEFAULT_UI_LOCALE } from "~/domain/locale";
import { For, onSettled, Show, createSignal, createMemo, createStore, untrack } from "solid-js";
import { useQuery } from "@tanstack/solid-query";
import { useUserPreferences } from "~/context/UserPreferencesContext";
import { useAgencySession } from "~/context/AgencySessionContext";
import { useI18n } from "~/i18n/I18nContext";
import {
  fetchRoutesMetadata,
  fetchAllRoutesCatalogViaHttp,
  type RouteMeta,
} from "~/services/surface/SurfaceClient";
import { getSurfaceModeMeta } from "~/components/route/routeTrackingHelpers";
import {
  inferRouteType,
  MAX_ROUTES_METADATA_IDS,
  type SurfaceRouteType,
} from "~/domain/surface/types";
import { getAgencyById } from "~/agencies/browserRegistry";
import { contrastTextColorForLine } from "~/domain/lineColors";
import { SearchInput } from "~/components/common/SearchInput";
import { compareSearchRank } from "~/lib/searchRanking";
import {
  favouriteStationNamesForAgency,
  isFavouriteLine,
} from "~/domain/preferences/UserPreferences";

/**
 * Line chips derive straight from the typed line-identity module: the
 * palette is network.json's own and label colors come from luminance, so a
 * recolor in network.json lands here automatically. The chip list walks
 * network.json's own line entries rather than a separately named id
 * enumeration, keeping line vocabulary inside the active provider schematic.
 * Popular onboarding routes are provider data too. They come from
 * `manifest.popularSurfaceRoutes`, so no agency network ids live in this file.
 */

// Module-level cache so route metadata is fetched at most once per agency
// across tab mounts. Scoped by agency id: an unscoped bucket let a previous
// agency's entries leak into search fallback when the catalog was empty.
const [routeMetaCache, setRouteMetaCache] = createStore<Record<string, Record<string, RouteMeta>>>(
  {},
);

function RouteBadge(props: { readonly shortName: string; readonly routeType: SurfaceRouteType }) {
  const modeMeta = () => getSurfaceModeMeta(props.routeType);
  return (
    <span
      class={`flex h-4.5 min-w-4.5 px-1 items-center justify-center rounded-sm text-[10px] font-black shrink-0 ${modeMeta().badgeBg} ${modeMeta().badgeText}`}
    >
      {props.shortName}
    </span>
  );
}

export function FavouritesTab() {
  const { t } = useI18n();
  const session = useAgencySession();
  return (
    <Show
      when={session.displayedAgencyId()}
      fallback={
        <p class="p-3 text-sm text-muted-foreground">
          {t("Choose a transit network to manage its favourite routes and stations.")}
        </p>
      }
    >
      <NetworkFavourites />
    </Show>
  );
}

function NetworkFavourites() {
  const { t, locale, formatNumber } = useI18n();
  const { preferences, toggleFavouriteLine, toggleFavouriteStation, toggleFavouriteSurfaceRoute } =
    useUserPreferences();
  // Catalog + metadata fetches are agency-scoped RPCs: the
  // shell-resolved id keys both the query and the payload.
  const session = useAgencySession();
  const agencyId = () => session.displayedAgencyId() ?? "";

  const subwayLines = createMemo(() =>
    (getAgencyById(agencyId())?.light?.lines ?? []).map((line) => ({
      id: line.id,
      name: line.name,
      color: line.color,
      textColor: contrastTextColorForLine(line.color),
    })),
  );

  const [searchQuery, setSearchQuery] = createSignal("");

  const favouriteRouteIds = createMemo(() =>
    preferences.favouriteSurfaceRoutes
      .filter((ref) => ref.agencyId === agencyId())
      .map((ref) => ref.routeId),
  );

  const favouriteStationNames = createMemo(() =>
    favouriteStationNamesForAgency(preferences, agencyId()),
  );

  const routesCatalogQuery = useQuery(() => ({
    queryKey: ["routes-catalog", agencyId()],
    enabled: Boolean(agencyId()),
    queryFn: () => fetchAllRoutesCatalogViaHttp(agencyId()),
    staleTime: 1000 * 60 * 60, // 1 hour
  }));

  const routesMap = createMemo(() => {
    const map = new Map<string, RouteMeta>();
    if (routesCatalogQuery.isError || routesCatalogQuery.isPending) return map;
    for (const r of routesCatalogQuery.data || []) {
      map.set(r.id, r);
    }
    return map;
  });

  const filteredRoutes = createMemo(() => {
    const query = searchQuery().trim().toLowerCase();
    if (!query || routesCatalogQuery.isError) return [];

    const catalog = routesCatalogQuery.isPending ? [] : routesCatalogQuery.data || [];
    // Fall back to this agency's cached entries only. Another agency's
    // entries must never leak into these search results.
    const sourceList: readonly RouteMeta[] =
      catalog.length > 0 ? catalog : Object.values(routeMetaCache[agencyId()] ?? {});

    const matches = sourceList.filter((r: RouteMeta) => {
      const shortLower = r.shortName.toLowerCase();
      const longLower = r.longName.toLowerCase();
      const idLower = r.id.toLowerCase();
      return idLower === query || shortLower.includes(query) || longLower.includes(query);
    });

    matches.sort((a: RouteMeta, b: RouteMeta) => {
      const rank = compareSearchRank(
        query,
        { exact: [a.shortName], prefix: [a.shortName] },
        { exact: [b.shortName], prefix: [b.shortName] },
      );
      if (rank !== 0) return rank;

      const aNum = parseInt(a.shortName, 10);
      const bNum = parseInt(b.shortName, 10);
      if (!isNaN(aNum) && !isNaN(bNum)) return aNum - bNum;
      return locale() !== DEFAULT_UI_LOCALE
        ? a.shortName.localeCompare(b.shortName, locale())
        : a.shortName.localeCompare(b.shortName);
    });

    return matches;
  });

  // Popular onboarding routes come from the active provider's manifest.
  // Agencies without suggestions omit the field and the section hides.
  const popularSurfaceRouteIds = createMemo(
    () => getAgencyById(agencyId())?.manifest.popularSurfaceRoutes ?? [],
  );

  // Track session-stable onboarding: if opened with 0 favourites, retain popular routes throughout this session
  const hadEmptyOnMount = untrack(() => favouriteRouteIds().length === 0);
  const showPopularRoutes = () => hadEmptyOnMount && popularSurfaceRouteIds().length > 0;

  const loadMissingMetadata = (routeIds: readonly string[]) => {
    const agency = agencyId();
    if (!agency) return;
    const bucket = routeMetaCache[agency] ?? {};
    const missing = [...new Set(routeIds)].filter((id) => !bucket[id]);

    // Favourites are uncapped on the device, while the server bounds each request.
    for (let start = 0; start < missing.length; start += MAX_ROUTES_METADATA_IDS) {
      fetchRoutesMetadata({
        agencyId: agency,
        routeIds: missing.slice(start, start + MAX_ROUTES_METADATA_IDS),
      })
        .then((routes) => {
          setRouteMetaCache((draft) => {
            const target = (draft[agency] ??= {});
            for (const r of routes) {
              target[r.id] = r;
            }
          });
        })
        .catch(() => {
          // Graceful fallback for offline or unit test execution
        });
    }
  };

  onSettled(() => {
    loadMissingMetadata([...favouriteRouteIds(), ...popularSurfaceRouteIds()]);
  });

  const handleToggleRoute = (routeId: string) => {
    toggleFavouriteSurfaceRoute(agencyId(), routeId);
    if (!routeMetaCache[agencyId()]?.[routeId]) {
      loadMissingMetadata([routeId]);
    }
  };

  const getRouteMeta = (routeId: string): RouteMeta | undefined =>
    routesMap().get(routeId) || routeMetaCache[agencyId()]?.[routeId];

  const getRouteLabel = (routeId: string) => {
    const meta = getRouteMeta(routeId);
    if (meta?.longName) {
      return t("{{route}} {{name}}", { route: meta.shortName, name: meta.longName });
    }
    return t("Route {{id}}", { id: routeId });
  };

  const getRouteType = (routeId: string): SurfaceRouteType => {
    const meta = getRouteMeta(routeId);
    if (meta?.routeType) {
      return meta.routeType;
    }
    return inferRouteType(routeId, getAgencyById(agencyId())?.manifest.routeInterpretation);
  };

  return (
    <div class="flex flex-col gap-3">
      {/* Grouped Subway Section: Lines & Stations */}
      <div class="flex flex-col gap-3 rounded-xl border border-border bg-card p-3">
        <div>
          <span class="text-[13px] font-semibold text-white">{t("Lines & Stations")}</span>
          <p class="text-[11px] text-muted-foreground">
            {t("Follow entire lines or individual stations for alerts")}
          </p>
        </div>

        {/* Lines subsection */}
        <div class="flex flex-col gap-1.5">
          <span class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("Lines")}
          </span>
          <div class="flex flex-wrap gap-2">
            <For each={subwayLines()}>
              {(line) => {
                const isSelected = () => isFavouriteLine(preferences, agencyId(), line.id);

                return (
                  <button
                    type="button"
                    onClick={() => toggleFavouriteLine(agencyId(), line.id)}
                    aria-pressed={isSelected() ? "true" : "false"}
                    class={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-all ${
                      isSelected()
                        ? "border-info bg-accent text-white shadow-xs"
                        : "border-border bg-muted text-muted-foreground hover:bg-accent"
                    }`}
                  >
                    <span
                      class="flex h-4.5 w-4.5 items-center justify-center rounded-sm text-[10px] font-black"
                      style={{ "background-color": line.color, color: line.textColor }}
                    >
                      {line.id}
                    </span>
                    <span>{line.name}</span>
                    {isSelected() && (
                      <span class="ml-0.5 flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:text-white">
                        ✕
                      </span>
                    )}
                  </button>
                );
              }}
            </For>
          </div>
        </div>

        {/* Stations subsection */}
        <div class="flex flex-col gap-1.5 pt-2 border-t border-border/60">
          <span class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("Stations")}
          </span>

          <Show
            when={favouriteStationNames().length > 0}
            fallback={
              <p class="text-xs text-muted-foreground py-1">
                {t("No favourite stations yet — star one from its station popover on the map.")}
              </p>
            }
          >
            <div class="flex flex-col gap-1.5">
              <For each={favouriteStationNames()}>
                {(stationName) => (
                  <div class="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-xs text-white">
                    <div class="flex items-center gap-2 min-w-0">
                      <span class="text-warning-400 text-sm">★</span>
                      <span class="font-medium truncate">{stationName}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleFavouriteStation(agencyId(), stationName)}
                      aria-label={t("Remove {{name}} from favourites", { name: stationName })}
                      class="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                    >
                      ✕
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>

      {/* Favourite Surface Routes */}
      <div class="flex flex-col gap-3 rounded-xl border border-border bg-card p-3">
        <div>
          <span class="text-[13px] font-semibold text-white">{t("Surface Routes")}</span>
          <p class="text-[11px] text-muted-foreground">
            {t("Search any route or choose popular corridors to track")}
          </p>
        </div>

        {/* Route Search Input */}
        <SearchInput
          value={searchQuery()}
          onInput={setSearchQuery}
          onEnter={() => {
            const topMatch = filteredRoutes()[0];
            if (topMatch) handleToggleRoute(topMatch.id);
          }}
          placeholder={t("Search routes by number or name...")}
          ariaLabel={t("Search routes by number or name")}
          clearAriaLabel={t("Clear route search")}
          inputClass="text-white"
        />

        {/* Search Results View */}
        <Show
          when={searchQuery().trim().length > 0}
          fallback={
            <>
              {/* 1. Popular Routes subsection (rendered BEFORE active list, session-stable during onboarding) */}
              <Show when={showPopularRoutes()}>
                <div class="flex flex-col gap-1.5">
                  <span class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    {t("Popular Routes")}
                  </span>
                  <div class="flex flex-wrap gap-2">
                    <For each={popularSurfaceRouteIds()}>
                      {(routeId) => {
                        const isSelected = () => favouriteRouteIds().includes(routeId);
                        const type = () => getRouteType(routeId);

                        return (
                          <button
                            type="button"
                            onClick={() => handleToggleRoute(routeId)}
                            aria-pressed={isSelected() ? "true" : "false"}
                            class={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-all ${
                              isSelected()
                                ? "border-info bg-accent text-white shadow-xs"
                                : "border-border bg-muted text-muted-foreground hover:bg-accent"
                            }`}
                          >
                            <RouteBadge shortName={routeId} routeType={type()} />
                            <Show when={getRouteMeta(routeId)?.longName}>
                              {(name) => <span>{name()}</span>}
                            </Show>
                            {isSelected() && (
                              <span class="ml-0.5 flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:text-white">
                                ✕
                              </span>
                            )}
                          </button>
                        );
                      }}
                    </For>
                  </div>
                </div>
              </Show>

              {/* 2. Active / Saved Favourites List */}
              <div
                class={`flex flex-col gap-1.5 ${
                  showPopularRoutes() ? "pt-2 border-t border-border/60" : ""
                }`}
              >
                <Show when={showPopularRoutes() && favouriteRouteIds().length > 0}>
                  <span class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    {t("Favourites List")}
                  </span>
                </Show>

                <Show
                  when={favouriteRouteIds().length > 0}
                  fallback={
                    <p class="text-xs text-muted-foreground py-1">
                      {t("No favourite routes yet — search above or choose a popular route.")}
                    </p>
                  }
                >
                  <div class="flex flex-wrap gap-2">
                    <For each={favouriteRouteIds()}>
                      {(routeId) => {
                        const type = () => getRouteType(routeId);

                        return (
                          <div class="inline-flex items-center gap-1.5 rounded-lg border border-info bg-accent px-2.5 py-1.5 text-xs font-semibold text-white shadow-xs">
                            <RouteBadge shortName={routeId} routeType={type()} />
                            <span>{getRouteLabel(routeId)}</span>
                            <button
                              type="button"
                              onClick={() => handleToggleRoute(routeId)}
                              aria-label={t("Remove {{name}} from favourites", {
                                name: getRouteLabel(routeId),
                              })}
                              class="ml-0.5 flex h-4 w-4 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-info/20 hover:text-white transition-colors"
                            >
                              ✕
                            </button>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </Show>
              </div>
            </>
          }
        >
          {/* Active Search Results list */}
          <div class="flex flex-col gap-1.5">
            <span class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {t("Matching Routes ({{count}})", { count: formatNumber(filteredRoutes().length) })}
            </span>

            <Show
              when={filteredRoutes().length > 0}
              fallback={
                routesCatalogQuery.isError ? (
                  // A catalog rejection gets a real error state with a
                  // retry affordance, never the misleading no-results copy.
                  <div class="flex flex-col items-start gap-1.5 py-2">
                    <p class="text-xs text-destructive" role="alert">
                      {t("Couldn't load the route catalog. Check your connection and try again.")}
                    </p>
                    <button
                      type="button"
                      onClick={() => routesCatalogQuery.refetch()}
                      class="cursor-pointer rounded-lg border border-border bg-muted px-2.5 py-1 text-xs font-semibold text-foreground transition-colors hover:bg-accent active:bg-accent"
                    >
                      {t("Retry")}
                    </button>
                  </div>
                ) : (
                  <p class="py-2 text-xs text-muted-foreground">
                    {routesCatalogQuery.isLoading
                      ? t("Loading route catalog...")
                      : t('No routes found matching "{{query}}"', { query: searchQuery() })}
                  </p>
                )
              }
            >
              <div class="flex flex-col gap-1.5 max-h-56 overflow-y-auto pr-1">
                <For each={filteredRoutes()}>
                  {(route) => {
                    const isSelected = () => favouriteRouteIds().includes(route.id);
                    const type = () => route.routeType || getRouteType(route.id);

                    return (
                      <div
                        class={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs transition-colors ${
                          isSelected()
                            ? "border-info/60 bg-accent text-white"
                            : "border-border bg-muted text-muted-foreground hover:bg-accent"
                        }`}
                      >
                        <div class="flex items-center gap-2 min-w-0">
                          <RouteBadge shortName={route.shortName} routeType={type()} />
                          <span class="font-medium truncate">
                            {route.shortName} {route.longName}
                          </span>
                        </div>

                        <button
                          type="button"
                          onClick={() => handleToggleRoute(route.id)}
                          aria-label={
                            isSelected()
                              ? t("Remove {{name}} from favourites", {
                                  name: `${route.shortName} ${route.longName}`,
                                })
                              : t("Add {{name}} to favourites", {
                                  name: `${route.shortName} ${route.longName}`,
                                })
                          }
                          class={`flex h-6 px-2 cursor-pointer items-center justify-center gap-1 rounded text-xs font-semibold transition-colors shrink-0 ${
                            isSelected()
                              ? "bg-info text-black hover:bg-info/80"
                              : "bg-accent text-muted-foreground hover:bg-info/20 hover:text-info"
                          }`}
                        >
                          <span>{isSelected() ? `★ ${t("Saved")}` : `☆ ${t("Add")}`}</span>
                        </button>
                      </div>
                    );
                  }}
                </For>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}
