import { DEFAULT_UI_LOCALE } from "~/domain/locale";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { cn } from "~/lib/utils";
import { useUserPreferences } from "~/context/UserPreferencesContext";
import { useI18n } from "~/i18n/I18nContext";
import { resolveServiceArea } from "~/i18n/agencyServiceArea";
import { countryName, regionName } from "~/i18n/jurisdictions";
import type { Translator } from "~/i18n/translate";
import { allProviders } from "~/agencies/browserRegistry";
import type { BrowserAgency } from "~/agencies/types";
import { calculateHaversineMeters } from "~/domain/map/MapGeometry";
import type { EffectiveAgencySnapshot } from "~/domain/location/EffectiveAgency";
import { SearchInput } from "~/components/common/SearchInput";
import { CheckIcon } from "~/components/icons/CheckIcon";
import { StarIcon } from "~/components/icons/StarIcon";
import { compareSearchRank } from "~/lib/searchRanking";
import { useEscapeKey } from "~/lib/keyboard";

/**
 * Manual agency picker: a dropdown panel anchored beneath the center
 * header pill in the ServiceSheetModal dismissal anatomy (no backdrop;
 * document-level pointerdown outside the panel and the trigger closes it).
 *
 * The body is one linear scroll of labelled sections: Automatic, the
 * declared-bound "In your area" agencies (nearest indexed station first),
 * favourites outside the area, then the remaining agencies bucketed by their
 * declared geography under collapsible "Browse by region" disclosures. Search
 * replaces the sections with a ranked match list. Selecting applies
 * immediately and closes the panel, and reopening brings the current selection
 * into view rather than making the rider hunt for it.
 */
export interface AgencyPickerViewState {
  readonly persistedSelection: string;
  readonly automaticAgencyId: string | undefined;
  readonly displayedAgencyId: string | undefined;
  readonly temporaryAgencyId?: string;
  readonly isTemporary: boolean;
}

export interface AgencyPickerSheetProps {
  isOpen: boolean;
  onClose: () => void;
  /** Canonical EffectiveAgency state, including declared-bound coverage. */
  effectiveAgency: () => EffectiveAgencySnapshot;
  /** Shell view state keeps persisted selection distinct from temporary viewing. */
  viewState: () => AgencyPickerViewState;
  /** Shell-owned selection transition. */
  onSelectAgency: (selection: "auto" | string) => void;
  /**
   * Header pill trigger element. Pointerdowns inside it belong to the pill's
   * own click-toggle and must never also count as an outside press (that
   * would flicker close-then-reopen).
   */
  triggerEl?: () => HTMLElement | undefined;
}

/** A position fix, or null when the ladder serves none (denied, expired, absent). */
type PickerFix = EffectiveAgencySnapshot["fix"];

/** Group heading chrome shared by every section label in the panel. */
const SECTION_HEADER =
  "px-2 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground";

/** Counts share the favourite button's column, including its outer row padding. */
const COUNT_COLUMN = "w-7 shrink-0 text-center text-[11px] tabular-nums text-muted-foreground";

/** Synthetic buckets carry chrome keys; regional buckets carry declared geography. */
type AgencyGroupKind = "country" | "regional" | "other" | "national" | "international";

/** One geographic bucket of the "Browse by region" disclosures. */
interface AgencyGroup {
  readonly key: string;
  readonly kind: AgencyGroupKind;
  /** Declared jurisdiction of a regional bucket; place names come from data. */
  readonly country?: string;
  readonly region?: string;
  readonly agencies: readonly BrowserAgency[];
  readonly children?: readonly AgencyGroup[];
}

/** Geography label for a regional bucket: its region name, else its country. */
function jurisdictionHeading(group: AgencyGroup, locale: string, t: Translator): string {
  return group.region
    ? regionName(group.country ?? "", group.region, t)
    : countryName(group.country ?? "", locale);
}

/** Id comparison, the last resort that keeps a picker order total. */
function compareAgencyIds(a: BrowserAgency, b: BrowserAgency): number {
  if (a.manifest.id < b.manifest.id) return -1;
  if (a.manifest.id > b.manifest.id) return 1;
  return 0;
}

function normalizeAgencySearch(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function agencySearchKeys(provider: BrowserAgency): string[] {
  return [
    provider.manifest.name,
    provider.manifest.id,
    provider.manifest.serviceArea ?? "",
    ...Object.values(provider.manifest.serviceAreaTranslations ?? {}),
  ].map(normalizeAgencySearch);
}

/** Alphabetical by display name, then id — never by catalog registration order. */
function compareAgencyNames(a: BrowserAgency, b: BrowserAgency, locale: string): number {
  if (locale !== DEFAULT_UI_LOCALE) {
    return a.manifest.name.localeCompare(b.manifest.name, locale) || compareAgencyIds(a, b);
  }
  const aName = a.manifest.name.toLowerCase();
  const bName = b.manifest.name.toLowerCase();
  if (aName < bName) return -1;
  if (aName > bName) return 1;
  return compareAgencyIds(a, b);
}

/** Countries contain regions and nationwide networks; unlocated networks trail them. */
function groupByGeography(
  agencies: readonly BrowserAgency[],
  locale: string,
  t: Translator,
): readonly AgencyGroup[] {
  const byName = (a: BrowserAgency, b: BrowserAgency) => compareAgencyNames(a, b, locale);
  const buckets = new Map<string, AgencyGroup>();
  for (const provider of agencies) {
    const { scope, jurisdiction } = provider.manifest;
    // A non-local operator confined to one region is listed under that region.
    const kind =
      scope === "international"
        ? "international"
        : scope === "national" && !jurisdiction?.region
          ? "national"
          : jurisdiction
            ? "regional"
            : "other";
    const country = kind === "international" ? undefined : jurisdiction?.country;
    const region = kind === "regional" ? jurisdiction?.region : undefined;
    const key = `${kind}:${country ?? ""}|${region ?? ""}`;
    const existing = buckets.get(key);
    buckets.set(key, {
      key,
      kind,
      country,
      region,
      agencies: [...(existing?.agencies ?? []), provider].sort(byName),
    });
  }

  const countries = new Map<string, AgencyGroup[]>();
  const trailing: AgencyGroup[] = [];
  for (const group of buckets.values()) {
    if (!group.country) {
      trailing.push(group);
      continue;
    }
    const groups = countries.get(group.country) ?? [];
    groups.push(group);
    countries.set(group.country, groups);
  }
  const countryGroups: AgencyGroup[] = [...countries].map(([country, groups]) => ({
    key: `country:${country}`,
    kind: "country",
    country,
    // Agencies declaring only a country belong directly beneath its heading.
    agencies: groups
      .filter((group) => group.kind === "regional" && !group.region)
      .flatMap((group) => group.agencies)
      .sort(byName),
    children: groups
      .filter((group) => group.kind !== "regional" || group.region)
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "national" ? 1 : -1;
        return jurisdictionHeading(a, locale, t).localeCompare(
          jurisdictionHeading(b, locale, t),
          locale,
        );
      }),
  }));
  countryGroups.sort((a, b) =>
    countryName(a.country ?? "", locale).localeCompare(
      countryName(b.country ?? "", locale),
      locale,
    ),
  );
  const order = { other: 0, national: 1, international: 2, regional: 3, country: 4 };
  trailing.sort((a, b) => order[a.kind] - order[b.kind]);
  return [...countryGroups, ...trailing];
}

function groupAgencyCount(group: AgencyGroup): number {
  return (
    group.agencies.length +
    (group.children ?? []).reduce((sum, child) => sum + groupAgencyCount(child), 0)
  );
}

/**
 * Meters from the fix to the agency's nearest indexed station, or undefined
 * when there is nothing to measure against: no fix, or an agency whose
 * schematic declares no station index. Undefined means "no distance", never a
 * made-up score, and callers order those agencies by another rule.
 */
function nearestStationMeters(provider: BrowserAgency, fix: PickerFix): number | undefined {
  const stations = provider.light?.stationPoints;
  if (!fix || !stations || stations.length === 0) return undefined;
  let nearest = Number.POSITIVE_INFINITY;
  for (const [lat, lon] of stations) {
    const distance = calculateHaversineMeters(fix.latitude, fix.longitude, lat, lon);
    if (distance < nearest) nearest = distance;
  }
  return nearest;
}

/**
 * Nearest indexed station first. Two agencies that are equally near, or that
 * are both unmappable, tie at 0 and fall through to the caller's next rule.
 */
function compareNearestStationMeters(a: BrowserAgency, b: BrowserAgency, fix: PickerFix): number {
  const aDistance = nearestStationMeters(a, fix);
  const bDistance = nearestStationMeters(b, fix);
  if (aDistance === undefined) return bDistance === undefined ? 0 : 1;
  if (bDistance === undefined) return -1;
  return aDistance - bDistance;
}

export function AgencyPickerSheet(props: AgencyPickerSheetProps): JSX.Element {
  const prefs = useUserPreferences();
  const i18n = useI18n();
  const { t, locale } = i18n;
  const [searchQuery, setSearchQuery] = createSignal("");
  const [collapsedGroups, setCollapsedGroups] = createSignal<ReadonlySet<string>>(new Set());

  let panelRef: HTMLDivElement | undefined;
  let listRef: HTMLDivElement | undefined;

  useEscapeKey(
    () => props.onClose(),
    () => props.isOpen,
  );

  onSettled(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (panelRef?.contains(target)) return;
      if (props.triggerEl?.()?.contains(target)) return;
      props.onClose();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  });

  // The shell renders the picker only while its popover is open, so this
  // component mounts per open and its settle is the open. The list always
  // starts at the top, so a selection further down would otherwise be hidden:
  // bring the checked row into view. "nearest" moves the list no further than
  // the row needs and never touches the page scroller behind the fixed panel.
  onSettled(() => {
    listRef
      ?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')
      ?.scrollIntoView({ block: "nearest" });
  });

  /** Declared-bound matches only; fallback ids are intentionally not status matches. */
  const coveringAgencyIds = () => props.effectiveAgency().declaredCoveringIds;

  const select = (selection: "auto" | string) => {
    props.onSelectAgency(selection);
    props.onClose();
  };

  const automaticAgencyId = () => props.viewState().automaticAgencyId;

  const automaticAgencyName = () => {
    const id = automaticAgencyId();
    return allProviders().find((provider) => provider.manifest.id === id)?.manifest.name;
  };

  const viewedAgencyName = () => {
    const id = props.viewState?.().displayedAgencyId;
    return allProviders().find((provider) => provider.manifest.id === id)?.manifest.name ?? id;
  };

  const filteredAgencies = createMemo(() => {
    const query = normalizeAgencySearch(searchQuery().trim());
    if (!query) return [];

    const providers = allProviders();
    const matches = providers.filter((provider) =>
      agencySearchKeys(provider).some((key) => key.includes(query)),
    );

    matches.sort((a, b) => {
      const rank = compareSearchRank(
        query,
        {
          exact: agencySearchKeys(a),
          prefix: agencySearchKeys(a),
        },
        {
          exact: agencySearchKeys(b),
          prefix: agencySearchKeys(b),
        },
      );
      // Substring matches all tie at 0, so without this they would render in
      // the catalog's chronological registration order.
      return rank !== 0 ? rank : compareAgencyNames(a, b, locale());
    });

    return matches;
  });

  const favouriteProviders = createMemo(() =>
    allProviders()
      .filter((p) => prefs.preferences.favouriteAgencies.includes(p.manifest.id))
      .sort((a, b) => compareAgencyNames(a, b, locale())),
  );

  /**
   * Declared-bound matches, nearest indexed station first. Distance is the only
   * ordering signal added here. Agencies at an equal distance, and agencies
   * with no station index to measure, keep the snapshot's own bounds order,
   * with an id comparison to keep the order total. That order is the automatic
   * resolver's, so no coverage policy is re-derived or imported here.
   */
  const coveringProviders = createMemo(() => {
    const providersById = new Map(
      allProviders().map((provider) => [provider.manifest.id, provider]),
    );
    const coveringIds = coveringAgencyIds();
    const boundsRank = new Map(coveringIds.map((id, index) => [id, index]));
    const fix = props.effectiveAgency().fix;
    return coveringIds
      .map((id) => providersById.get(id))
      .filter((provider): provider is BrowserAgency => provider !== undefined)
      .sort((a, b) => {
        const byDistance = compareNearestStationMeters(a, b, fix);
        if (byDistance !== 0) return byDistance;
        // Both ids are covering ids, so the rank is always present; the
        // fallback orders an unknown one last, as with nothing to measure.
        const aRank = boundsRank.get(a.manifest.id) ?? Number.MAX_SAFE_INTEGER;
        const bRank = boundsRank.get(b.manifest.id) ?? Number.MAX_SAFE_INTEGER;
        if (aRank !== bRank) return aRank - bRank;
        return compareAgencyIds(a, b);
      });
  });

  const nonCoveringFavouriteProviders = createMemo(() =>
    favouriteProviders().filter((provider) => !coveringAgencyIds().includes(provider.manifest.id)),
  );

  /**
   * Everything outside the area that is not a favourite, alphabetically, then
   * bucketed by declared geography for the "Browse by region" disclosures.
   */
  const browseGroups = createMemo(() => {
    const covering = new Set(coveringAgencyIds());
    const favourites = new Set(prefs.preferences.favouriteAgencies);
    const rest = allProviders()
      .filter(
        (provider) => !covering.has(provider.manifest.id) && !favourites.has(provider.manifest.id),
      )
      .sort((a, b) => compareAgencyNames(a, b, locale()));
    return groupByGeography(rest, locale(), t);
  });

  const isCollapsed = (key: string) => collapsedGroups().has(key);

  const toggleGroup = (key: string) =>
    setCollapsedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /** Chrome keys for the synthetic buckets; declared geography names the rest. */
  const groupHeading = (group: AgencyGroup): string => {
    if (group.kind === "other") return t("Other networks");
    if (group.kind === "national") return t("Nationwide");
    if (group.kind === "international") return t("International");
    return jurisdictionHeading(group, locale(), t);
  };

  /** The one selection marker: a green check badge in the app's live colour. */
  const checkBadge = () => (
    <span
      aria-hidden="true"
      class="flex h-4 w-4 shrink-0 items-center justify-center rounded-md bg-live text-white"
    >
      <CheckIcon size={11} />
    </span>
  );

  const renderAgencyRow = (provider: BrowserAgency) => {
    const isActive = () => prefs.preferences.agency === provider.manifest.id;
    const isFavourited = () => prefs.preferences.favouriteAgencies.includes(provider.manifest.id);

    return (
      <div
        role="menuitemradio"
        tabindex={0}
        aria-checked={isActive() ? "true" : "false"}
        onClick={() => select(provider.manifest.id)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            select(provider.manifest.id);
          }
        }}
        class={cn(
          "flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition-colors outline-none",
          isActive() ? "bg-accent" : "hover:bg-accent/60",
        )}
      >
        <div class="flex min-w-0 flex-1 items-center gap-3">
          {/* Reserved leading column: the selection badge never reflows the name. */}
          <span class="flex h-4 w-4 shrink-0 items-center justify-center">
            <Show when={isActive()}>{checkBadge()}</Show>
          </span>
          <span class="min-w-0 flex-1">
            <span
              class={cn(
                "block text-sm leading-snug break-words text-foreground",
                isActive() ? "font-semibold" : "font-medium",
              )}
            >
              {provider.manifest.name}
            </span>
            <Show when={resolveServiceArea(provider.manifest, locale())}>
              <span class="mt-0.5 block text-xs leading-snug break-words text-info">
                {resolveServiceArea(provider.manifest, locale())}
              </span>
            </Show>
            <span class="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
              {provider.manifest.modes.map((mode) => t(mode)).join(" · ")}
              <Show when={provider.manifest.status !== "active"}>
                {" · "}
                {t("experimental")}
              </Show>
            </span>
          </span>
        </div>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            prefs.toggleFavouriteAgency(provider.manifest.id);
          }}
          aria-pressed={isFavourited() ? "true" : "false"}
          aria-label={
            isFavourited()
              ? t("Remove {{name}} from favourites", { name: provider.manifest.name })
              : t("Add {{name}} to favourites", { name: provider.manifest.name })
          }
          class="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors hover:bg-accent hover:text-foreground active:bg-accent"
        >
          <StarIcon
            size={16}
            filled={isFavourited()}
            class={cn(
              "transition-colors",
              isFavourited()
                ? "text-warning-400 fill-current"
                : "text-muted-foreground/40 hover:text-warning-400",
            )}
          />
        </button>
      </div>
    );
  };

  const renderGroup = (group: AgencyGroup): JSX.Element => (
    <div role="group" aria-label={groupHeading(group)} class="mb-0.5">
      <button
        type="button"
        onClick={() => toggleGroup(group.key)}
        aria-expanded={isCollapsed(group.key) ? "false" : "true"}
        class="flex w-full cursor-pointer items-center gap-2 rounded-lg py-1.5 pr-3 pl-2 text-left transition-colors hover:bg-accent/40"
      >
        <span aria-hidden="true" class="text-[10px] text-muted-foreground">
          {isCollapsed(group.key) ? "▸" : "▾"}
        </span>
        <span class="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          {groupHeading(group)}
        </span>
        <span class={COUNT_COLUMN}>{i18n.formatNumber(groupAgencyCount(group))}</span>
      </button>
      <Show when={!isCollapsed(group.key)}>
        <For each={group.agencies}>{(provider) => renderAgencyRow(provider)}</For>
        <div class="pl-3">
          <For each={group.children}>{(child) => renderGroup(child)}</For>
        </div>
      </Show>
    </div>
  );

  const automaticRow = () => {
    const isActive = () => prefs.preferences.agency === "auto";
    return (
      <button
        type="button"
        role="menuitemradio"
        aria-checked={isActive() ? "true" : "false"}
        onClick={() => select("auto")}
        class={cn(
          "flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
          isActive() ? "bg-accent" : "hover:bg-accent/60",
        )}
      >
        <span class="flex h-4 w-4 shrink-0 items-center justify-center">
          <Show when={isActive()}>{checkBadge()}</Show>
        </span>
        <span class="min-w-0 flex-1">
          <span
            class={cn(
              "block truncate text-sm text-foreground",
              isActive() ? "font-semibold" : "font-medium",
            )}
          >
            {t("Automatic")}
          </span>
          <span class="block truncate text-[11px] text-muted-foreground">
            <Show when={automaticAgencyName()} fallback={<>{t("No network resolved")}</>}>
              {t("Automatic selects {{agency}}", { agency: automaticAgencyName() ?? "" })}
            </Show>
          </span>
          <Show when={props.viewState?.().isTemporary}>
            <span role="status" class="block truncate text-[11px] text-warning-300">
              {t("Viewing {{agency}} temporarily", { agency: viewedAgencyName() ?? "" })}
            </span>
          </Show>
        </span>
      </button>
    );
  };

  return (
    <Show when={props.isOpen}>
      <div
        ref={(el) => {
          panelRef = el;
        }}
        role="dialog"
        aria-modal="false"
        aria-label={t("Choose transit agency")}
        class={cn(
          "fixed z-40 flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl animate-in fade-in slide-in-from-top-2 duration-200 pointer-events-auto",
          // Mobile (< md): Sized by insets alone — the same frame
          // SettingsPopover uses between the header and the bottom nav — so the
          // height is content-independent and the agency list scrolls inside.
          "top-16 bottom-[calc(max(0.875rem,env(safe-area-inset-bottom,0.875rem))+3.5rem)] left-1/2 -translate-x-1/2 w-[min(480px,95vw)]",
          // Non-mobile (>= md): Fixed height under the header pill, bounded on a
          // short window. Centring and width carry over; only height is
          // desktop-specific, so the panel never docks away from its trigger.
          "md:bottom-auto md:h-[min(60vh,480px)]",
        )}
        onWheel={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onTouchStart={(event) => event.stopPropagation()}
      >
        <div class="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <span class="text-xs font-semibold text-foreground">{t("Transit agency")}</span>
          <button
            type="button"
            onClick={() => props.onClose()}
            aria-label={t("Close agency picker")}
            class="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-accent"
          >
            <span aria-hidden="true" class="text-lg leading-none">
              ×
            </span>
          </button>
        </div>

        <div class="shrink-0 px-3 pt-2 pb-1">
          <SearchInput
            value={searchQuery()}
            onInput={setSearchQuery}
            onEscape={() => {
              if (searchQuery()) {
                setSearchQuery("");
              } else {
                props.onClose();
              }
            }}
            onEnter={() => {
              const topMatch = filteredAgencies()[0];
              if (topMatch) select(topMatch.manifest.id);
            }}
            placeholder={t("Search agencies by name or city...")}
            ariaLabel={t("Search agencies by name or city")}
            clearAriaLabel={t("Clear agency search")}
          />
        </div>

        {/* Agency list. Group headings stay inside so they scroll with the
            rows, matching the settings panel. min-h-0 flex-1 lets this body
            shrink and clip inside the fixed-height sheet. overscroll-contain
            stops scroll chaining so a swipe past the list edge never reaches
            the page scroller and triggers native pull-to-refresh. The stable
            scrollbar gutter keeps the rows from shifting when a disclosure
            changes the list height. */}
        <div
          ref={(el) => {
            listRef = el;
          }}
          role="menu"
          aria-label={t("Agency options")}
          class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 [scrollbar-gutter:stable]"
        >
          <Show
            when={searchQuery().trim().length > 0}
            fallback={
              <>
                {automaticRow()}

                <Show when={coveringProviders().length > 0}>
                  <div role="group" aria-label={t("In your area")} class="mt-1">
                    <span class={cn(SECTION_HEADER, "flex items-center justify-between pr-3")}>
                      <span>{t("In your area")}</span>
                      <span aria-hidden="true" class={COUNT_COLUMN}>
                        {i18n.formatNumber(coveringProviders().length)}
                      </span>
                    </span>
                    <For each={coveringProviders()}>{(provider) => renderAgencyRow(provider)}</For>
                  </div>
                </Show>

                <Show when={nonCoveringFavouriteProviders().length > 0}>
                  <div role="group" aria-label={t("Favourites")} class="mt-1">
                    <span class={SECTION_HEADER}>{t("Favourites")}</span>
                    <For each={nonCoveringFavouriteProviders()}>
                      {(provider) => renderAgencyRow(provider)}
                    </For>
                  </div>
                </Show>

                <Show when={browseGroups().length > 0}>
                  <div class="mt-1">
                    <span class={SECTION_HEADER}>{t("Browse by region")}</span>
                    <For each={browseGroups()}>{(group) => renderGroup(group)}</For>
                  </div>
                </Show>
              </>
            }
          >
            <div class="flex flex-col gap-1">
              <span class={SECTION_HEADER}>
                {t("Matching Agencies ({{count}})", {
                  count: i18n.formatNumber(filteredAgencies().length),
                })}
              </span>
              <Show
                when={filteredAgencies().length > 0}
                fallback={
                  <p class="py-4 text-center text-xs text-muted-foreground">
                    {t('No agencies found matching "{{query}}"', { query: searchQuery() })}
                  </p>
                }
              >
                <For each={filteredAgencies()}>{(provider) => renderAgencyRow(provider)}</For>
              </Show>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}
