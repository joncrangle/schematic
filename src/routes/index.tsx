import { FormattingCountryProvider } from "~/i18n/I18nContext";
import { createMemo, createSignal, lazy, onCleanup, onSettled, Show, Loading } from "solid-js";
import { Title } from "@solidjs/meta";
import { cn } from "~/lib/utils";
import { HelpMode } from "~/components/HelpMode";
import { BottomPillNav } from "~/components/BottomPillNav";
import { toServiceAlerts, toUpcomingClosures } from "~/domain/serviceAlerts";
import {
  areServiceAlertsEqual,
  areUpcomingClosuresEqual,
  isAgencyAlertContentEqual,
} from "~/lib/routeMemoComparators";
import { stableList } from "~/lib/stableList";
import { allProviders } from "~/agencies/browserRegistry";
import type { AgencyAlert, BrowserAgency, SchematicStationId } from "~/agencies/types";
import { useUserPreferences } from "~/context/UserPreferencesContext";
import { useI18n } from "~/i18n/I18nContext";
import { createShellSession } from "~/lib/shellSession";
import { AgencySessionProvider, useAgencySession } from "~/context/AgencySessionContext";
import { createAgencySession } from "~/services/session/AgencySession";
import type { AgencyPickerViewState } from "~/components/AgencyPickerSheet";
import { useSnapshotGating } from "~/lib/snapshotGating";
const AgencyPickerSheet = lazy(() =>
  import("~/components/AgencyPickerSheet").then(({ AgencyPickerSheet }) => ({
    default: AgencyPickerSheet,
  })),
);
import { NetworkSelectionState } from "~/components/NetworkSelectionState";
import { NetworkMap } from "~/components/map/NetworkMap";
import { loadCoverageCountries } from "~/components/network-coverage/coverageCountries";
import type { NetworkCoverageProps } from "~/components/network-coverage/NetworkCoverage";
const NetworkCoverage = lazy(async () => {
  const [{ NetworkCoverage }, countries] = await Promise.all([
    import("~/components/network-coverage/NetworkCoverage"),
    loadCoverageCountries(),
  ]);
  return {
    default: (props: Omit<NetworkCoverageProps, "countries">) => (
      <NetworkCoverage {...props} countries={countries} />
    ),
  };
});
import { areMapProjectionsEqual, deriveMapProjection } from "~/core/map";
import { useAgencySchematic } from "~/hooks/useAgencySchematic";
import { createTopologyCache, MAX_WARMED_SCHEMATICS } from "~/services/schematic/TopologyCache";
import { useAgencySnapshot } from "~/hooks/useAgencySnapshot";
import { useMobileViewport } from "~/hooks/useMobileViewport";
import { getLocationLadder, useGeolocation } from "~/hooks/useGeolocation";
import type { InterchangeFocus } from "~/components/map/interchange-navigation";
import { resolveInterchangeBadgeVisibility } from "~/domain/map/InterchangeBadgeVisibility";
import { useTargetedRouteTracking } from "~/lib/routeTrackingLifecycle";
const SettingsPopover = lazy(() =>
  import("~/components/settings/SettingsPopover").then(({ SettingsPopover }) => ({
    default: SettingsPopover,
  })),
);
import { CogIcon } from "~/components/icons/CogIcon";
import { ReturnIcon } from "~/components/icons/ReturnIcon";
import {
  NearbyCoordinationProvider,
  createNearbyCoordination,
} from "~/context/NearbyCoordinationContext";
import { createNearbyFocusAdapter } from "~/components/nearby/nearbyFocus";

export interface HomeProps {
  readonly providers?: () => readonly BrowserAgency[];
  readonly locationLadder?: ReturnType<typeof getLocationLadder>;
}

export default function Home(props: HomeProps = {}) {
  const getProviders = props.providers ?? allProviders;
  const ladder = props.locationLadder ?? getLocationLadder();
  const prefs = useUserPreferences();
  const agencySession = createAgencySession({
    providers: getProviders,
    selection: () => prefs.preferences.agency,
    setSelection: (selection) => prefs.setPreference("agency", selection),
    locationLadder: ladder,
  });
  onCleanup(() => agencySession.dispose());
  // Automatic resolves from the rider's location independently of the viewed network.
  const formattingCountry = createMemo(() => {
    const locationAgencyId = agencySession.snapshot().automaticAgencyId;
    return (
      getProviders().find((provider) => provider.manifest.id === locationAgencyId)?.manifest
        .jurisdiction?.country ?? agencySession.displayedAgency()?.manifest.jurisdiction?.country
    );
  });
  return (
    <AgencySessionProvider session={agencySession}>
      <FormattingCountryProvider country={formattingCountry()}>
        <HomeContent providers={getProviders} locationLadder={ladder} />
      </FormattingCountryProvider>
    </AgencySessionProvider>
  );
}

function HomeContent(props: HomeProps) {
  const agencySession = useAgencySession();
  const getProviders = props.providers ?? allProviders;
  const ladder = props.locationLadder ?? getLocationLadder();
  const geo = useGeolocation();
  const prefs = useUserPreferences();
  const i18n = useI18n();
  const { t } = i18n;
  const nearbyFocus = createNearbyFocusAdapter();
  const { preferences, isLoaded } = prefs;
  const isMobileViewport = useMobileViewport();
  const [isHydrated, setIsHydrated] = createSignal(false);
  const [isCoverageOpen, setIsCoverageOpen] = createSignal(false);
  const interchangeBadgeVisibility = createMemo(() => {
    if (!isHydrated()) return "full";
    isLoaded();
    return resolveInterchangeBadgeVisibility(
      preferences.interchangeBadgeVisibility,
      isMobileViewport(),
    );
  });
  const snapshotEnabled = useSnapshotGating();

  onSettled(() => {
    setIsHydrated(true);
  });

  const resolvedAgency = () => agencySession.displayedAgency();
  const shellSession = createShellSession({
    getNearestAnchorCoords: () => geo.coords(),
    focus: nearbyFocus,
    networkId: agencySession.displayedAgencyId,
  });
  const targetedRoute = shellSession.targetedRoute;

  const agencyShortName = (agency: BrowserAgency | undefined) =>
    agency?.manifest.shortName ?? agency?.manifest.id.slice(0, 3).toUpperCase() ?? t("Auto");

  const displayedAgencyShortName = () => agencyShortName(resolvedAgency());

  const savedPickerAgencyShortName = () => {
    if (preferences.agency === "auto") return t("Auto");
    return agencyShortName(getProviders().find((p) => p.manifest.id === preferences.agency));
  };

  const { snapshot, freshness } = useAgencySnapshot(
    () => resolvedAgency()?.manifest.id,
    15_000,
    () => isLoaded() && snapshotEnabled(),
    () => preferences.locale,
  );

  // Every poll restamps `generatedAt`, so the snapshot object takes a new
  // identity even when the feed content has not changed. The derivations below
  // read only the alert list: depending on it directly lets TanStack's
  // structural sharing hand back the same array reference for a quiet poll, so
  // they skip a recompute instead of re-deriving an identical projection.
  const snapshotAlerts = createMemo(() => snapshot()?.alerts);

  const topologyCache = createTopologyCache({
    allProviders: getProviders,
    maxEntries: MAX_WARMED_SCHEMATICS,
  });
  // Starts the active agency's lazy schematic import as soon as it is known.
  const activeSchematic = useAgencySchematic(() => resolvedAgency()?.manifest.id);
  const activeTopology = createMemo(() => {
    const provider = resolvedAgency();
    return provider?.light && activeSchematic() ? topologyCache.topologyFor(provider) : undefined;
  });

  const mapProjection = createMemo(
    () => {
      const topology = activeTopology();
      const alerts = snapshotAlerts();
      return topology && alerts
        ? deriveMapProjection({ alerts }, topology)
        : {
            statusOverlaySegments: [],
            stationSeverities: new Map<SchematicStationId, "normal" | "degraded" | "severe">(),
            stationAccessibilityOutages: new Set<SchematicStationId>(),
          };
    },
    {
      equals: areMapProjectionsEqual,
    },
  );
  let agencyPillTriggerEl: HTMLButtonElement | undefined;

  let settingsTriggerEl: HTMLElement | undefined;

  const nearbyCoordination = createNearbyCoordination(shellSession, nearbyFocus);

  const servicePresentation = () => ({
    formatDate: i18n.formatDate,
    formatTime: i18n.formatTime,
    line: (lineId: string) => t("Line {{name}}", { name: lineId }),
    accessibility: t("Accessibility"),
    systemwide: t("Systemwide"),
    affectedStops: t("Affected stops"),
    stopClosure: t("Stop closure"),
    serviceAlert: t("Service alert"),
    plannedWork: t("Planned Work"),
    plannedServiceAdjustment: t("Planned Service Adjustment"),
    network: t("Transit Network"),
    segment: (from: string, to: string) => t("{{from}} to {{to}}", { from, to }),
    starts: (time: string) => t("Starts {{time}}", { time }),
  });

  const formattedServiceAlerts = createMemo(
    () => toServiceAlerts(snapshotAlerts() || [], resolvedAgency()?.light, servicePresentation()),
    { equals: areServiceAlertsEqual },
  );

  const formattedUpcomingClosures = createMemo(
    () =>
      toUpcomingClosures(snapshotAlerts() || [], resolvedAgency()?.light, servicePresentation()),
    { equals: areUpcomingClosuresEqual },
  );

  const stableAlerts = (() => {
    // Same tolerated mutate-in-memo pattern as useStableQuery: the map is
    // written as a side effect of deriving items. Per-alert stabilization
    // keeps prior object identity for content-equal advisories (decoders
    // stamp updatedAt from the fetch clock when the wire carries no
    // timestamp), and the reference-equality `equals` keeps the array
    // identity when nothing changed. Together with stable-id keyed `<For>`
    // rows downstream, an unchanged advisory never remounts its accordion
    // while a changed one patches fine-grained.
    let previousAlertsByKey: ReadonlyMap<string, AgencyAlert> = new Map();
    return createMemo(
      () => {
        const current = snapshotAlerts() ?? [];
        const stabilized = stableList(current, previousAlertsByKey, {
          getKey: (alert) => alert.id,
          isEqual: isAgencyAlertContentEqual,
        });
        previousAlertsByKey = stabilized.byKey;
        return stabilized.items;
      },
      {
        equals: (prev, next) =>
          prev.length === next.length && prev.every((alert, index) => alert === next[index]),
      },
    );
  })();

  const pickerViewState = (): AgencyPickerViewState => ({
    persistedSelection: preferences.agency as string,
    automaticAgencyId: agencySession.snapshot().automaticAgencyId,
    displayedAgencyId: agencySession.displayedAgencyId(),
    temporaryAgencyId: agencySession.isTemporary() ? agencySession.displayedAgencyId() : undefined,
    isTemporary: agencySession.isTemporary(),
  });

  return (
    <>
      <Title>
        {resolvedAgency()
          ? t("{{agency}} · Schematic", { agency: resolvedAgency()!.manifest.name })
          : t("Choose your transit network · Schematic")}
      </Title>
      <main class="relative h-dvh w-full overflow-hidden bg-background bg-drafting-grid font-sans select-none">
        <Show
          when={resolvedAgency()}
          fallback={
            <NetworkSelectionState
              providers={getProviders()}
              favouriteAgencyIds={preferences.favouriteAgencies}
              hasLocation={
                Boolean(agencySession.snapshot().fix) &&
                agencySession.snapshot().source !== "default"
              }
              status={agencySession.snapshot().status}
              onSelectAgency={(id) => agencySession.selectAgency(id)}
              onRequestLocation={() => ladder.request()}
            />
          }
        >
          {(provider) => {
            const tracking = useTargetedRouteTracking(targetedRoute, {
              getNearestAnchorCoords: () =>
                geo.coords() ?? targetedRoute()?.nearestAnchorCoords ?? null,
              onSelectDirection: (directionId) => {
                const current = targetedRoute();
                if (current) {
                  shellSession.enterTargetedRoute({
                    agencyId: current.agencyId,
                    routeId: current.routeId,
                    directionId,
                    stopId: current.stopId,
                  });
                }
              },
            });
            return (
              <NearbyCoordinationProvider value={nearbyCoordination}>
                <NetworkMap
                  provider={provider()}
                  topology={activeTopology()}
                  topologyCache={topologyCache}
                  projection={mapProjection()}
                  interchangeBadgeVisibility={interchangeBadgeVisibility}
                  alerts={stableAlerts()}
                  tracking={tracking}
                  onClearTargetedRoute={() => {
                    shellSession.exitTargetedRoute();
                  }}
                  onEnlargeRoute={({ routeId, directionId, stopId, agencyId }) => {
                    shellSession.enterTargetedRoute({
                      agencyId: agencyId ?? provider().manifest.id,
                      routeId,
                      directionId,
                      stopId,
                    });
                  }}
                  onTemporaryAgencyView={(focus: InterchangeFocus) =>
                    agencySession.navigateToInterchange(focus)
                  }
                />
              </NearbyCoordinationProvider>
            );
          }}
        </Show>

        <Show when={!targetedRoute()}>
          <header
            aria-label={
              agencySession.isTemporary()
                ? t("{{agency}} transit status, temporary view", {
                    agency: resolvedAgency()?.manifest.name ?? "Schematic",
                  })
                : t("{{agency}} transit status", {
                    agency: resolvedAgency()?.manifest.name ?? "Schematic",
                  })
            }
            class="pointer-events-none fixed inset-x-0 top-4 z-30 flex items-center justify-between px-4"
          >
            <div class="h-8.5 w-8.5 shrink-0" aria-hidden="true" />

            <div class="pointer-events-auto flex h-8.5 items-center gap-2.5 rounded-full border border-border bg-card/90 px-3.5 text-[11px] shadow-lg backdrop-blur-md">
              <button
                type="button"
                onClick={() => setIsCoverageOpen(true)}
                aria-label={t("Schematic - open coverage map")}
                title={t("Coverage Map")}
                class="cursor-pointer font-mono text-[11px] font-bold tracking-[0.18em] text-info uppercase transition-[color,filter] duration-150 hover:text-[#7dd3fc] hover:drop-shadow-[0_0_8px_rgba(56,189,248,0.5)] active:text-[#0ea5e9]"
              >
                [Schematic]
              </button>

              <button
                ref={(el) => {
                  agencyPillTriggerEl = el;
                }}
                type="button"
                onClick={() => {
                  if (agencySession.isTemporary()) {
                    agencySession.clearTemporaryView();
                  } else {
                    if (shellSession.isAgencyPickerOpen()) {
                      shellSession.closeAgencyPicker();
                    } else {
                      shellSession.openAgencyPicker();
                    }
                  }
                }}
                aria-label={
                  agencySession.isTemporary()
                    ? t("Viewing {{agency}} temporarily. Restore saved agency setting: {{saved}}", {
                        agency: resolvedAgency()?.manifest.name ?? t("Choose network"),
                        saved: savedPickerAgencyShortName(),
                      })
                    : !resolvedAgency()
                      ? t("Choose transit network. Open agency picker")
                      : preferences.agency === "auto"
                        ? t("Transit agency: automatic, {{agency}}. Open agency picker", {
                            agency: resolvedAgency()?.manifest.name ?? t("Choose network"),
                          })
                        : t("Transit agency: pinned, {{agency}}. Open agency picker", {
                            agency: resolvedAgency()?.manifest.name ?? t("Choose network"),
                          })
                }
                aria-haspopup={agencySession.isTemporary() ? undefined : "dialog"}
                title={
                  agencySession.isTemporary()
                    ? t("Return to saved agency setting: {{saved}}", {
                        saved: savedPickerAgencyShortName(),
                      })
                    : undefined
                }
                class={cn(
                  "flex w-26 cursor-pointer items-center justify-center gap-1.5 overflow-hidden rounded-lg border bg-foreground/6 px-2 py-0.5 transition-colors hover:bg-foreground/12 active:bg-foreground/12",
                  agencySession.isTemporary()
                    ? "border-dashed border-warning-300/70"
                    : "border-border",
                )}
              >
                <Show
                  when={agencySession.isTemporary()}
                  fallback={
                    <Show
                      when={resolvedAgency()}
                      fallback={
                        <span class="text-[11px] font-semibold text-foreground">{t("Choose")}</span>
                      }
                    >
                      <Show
                        when={preferences.agency === "auto"}
                        fallback={
                          <span class="truncate text-[11px] font-semibold leading-none text-foreground">
                            {resolvedAgency() ? displayedAgencyShortName() : t("Choose")}
                          </span>
                        }
                      >
                        <span class="shrink-0 self-center pt-px text-[9px] font-semibold leading-none tracking-wider text-muted-foreground uppercase">
                          {t("Auto")}
                        </span>
                        <span aria-hidden="true" class="text-[9px] text-muted-foreground/60">
                          ·
                        </span>
                        <span class="min-w-0 truncate text-[11px] font-semibold leading-none text-foreground">
                          {resolvedAgency() ? displayedAgencyShortName() : t("Choose")}
                        </span>
                      </Show>
                    </Show>
                  }
                >
                  <span class="truncate text-[11px] font-semibold leading-none text-foreground">
                    {resolvedAgency() ? displayedAgencyShortName() : t("Choose")}
                  </span>
                  <ReturnIcon size={12} class="text-warning-300" />
                </Show>
                <Show when={!agencySession.isTemporary()}>
                  <span
                    aria-hidden="true"
                    class={cn(
                      "text-[11px] leading-none text-muted-foreground transition-transform duration-200",
                      shellSession.isAgencyPickerOpen() && "rotate-180",
                    )}
                  >
                    ▼
                  </span>
                </Show>
              </button>

              <Show when={resolvedAgency()}>
                <div
                  class="flex items-center gap-1.5 text-muted-foreground/70"
                  role="img"
                  aria-label={t("Live status: {{state}}, {{time}}", {
                    state: t(freshness().state),
                    time: freshness().shortText,
                  })}
                  title={freshness().shortText}
                >
                  <span aria-hidden="true" class="relative flex h-2 w-2 shrink-0">
                    <Show when={freshness().state !== "unavailable"}>
                      <span
                        class={cn(
                          "absolute inline-flex h-full w-full animate-ping rounded-full",
                          freshness().state === "live" || freshness().state === "recent"
                            ? "bg-live/50"
                            : freshness().state === "stale"
                              ? "bg-warning-400/50"
                              : "bg-destructive/50",
                        )}
                      />
                    </Show>
                    <span
                      class={cn(
                        "relative inline-flex h-2 w-2 rounded-full",
                        freshness().state === "live" || freshness().state === "recent"
                          ? "bg-live"
                          : freshness().state === "stale"
                            ? "bg-warning-400"
                            : freshness().state === "unavailable"
                              ? "bg-muted-foreground"
                              : "bg-destructive",
                      )}
                    />
                  </span>
                  <span aria-hidden="true" class="min-w-14 max-w-32 text-center tabular-nums">
                    {freshness().shortText}
                  </span>
                </div>
              </Show>
            </div>

            <button
              ref={(el) => {
                settingsTriggerEl = el;
              }}
              type="button"
              onClick={() => {
                if (shellSession.isSettingsOpen()) {
                  shellSession.closeSettings();
                } else {
                  shellSession.openSettings();
                }
              }}
              aria-label={t("Open Settings")}
              class="pointer-events-auto flex h-8.5 w-8.5 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border bg-card/90 text-foreground shadow-lg backdrop-blur-md transition-colors hover:bg-accent active:bg-accent"
            >
              <CogIcon size={16} class="text-foreground" />
            </button>
            <HelpMode
              ready={isHydrated() && isLoaded()}
              onOpen={() => {
                shellSession.closeSettings();
                shellSession.closeAgencyPicker();
                shellSession.closeSheet();
                shellSession.setNearbyOpen(false);
              }}
            />
          </header>
        </Show>

        <Show when={shellSession.isSettingsOpen()}>
          <Loading>
            <SettingsPopover
              isOpen={true}
              onClose={shellSession.closeSettings}
              triggerEl={() => settingsTriggerEl}
              agencyId={resolvedAgency()?.manifest.id}
            />
          </Loading>
        </Show>

        <Show when={shellSession.isAgencyPickerOpen()}>
          <Loading>
            <AgencyPickerSheet
              isOpen={true}
              onClose={shellSession.closeAgencyPicker}
              effectiveAgency={() => agencySession.snapshot()}
              viewState={pickerViewState}
              onSelectAgency={(selection) => agencySession.selectAgency(selection as never)}
              triggerEl={() => agencyPillTriggerEl}
            />
          </Loading>
        </Show>

        <Show when={isCoverageOpen()}>
          <Loading>
            <NetworkCoverage
              providers={getProviders()}
              currentAgencyId={resolvedAgency()?.manifest.id}
              prefersReducedMotion={prefs.isEffectiveReducedMotion}
              onClose={() => setIsCoverageOpen(false)}
            />
          </Loading>
        </Show>

        <Show when={!targetedRoute() && resolvedAgency()}>
          {(provider) => (
            <BottomPillNav
              agencyId={provider().manifest.id}
              activeSheet={shellSession.activeSheet()}
              onToggleSheet={(tab) => {
                if (tab === null) {
                  shellSession.closeSheet();
                } else {
                  shellSession.openSheet(tab);
                }
              }}
              alerts={formattedServiceAlerts()}
              upcomingClosures={formattedUpcomingClosures()}
              freshness={freshness().state}
              agencyName={provider().manifest.name}
            />
          )}
        </Show>
      </main>
    </>
  );
}
