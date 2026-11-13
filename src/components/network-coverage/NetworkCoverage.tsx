/**
 * Full-screen network coverage overlay: one continuous map with wheel zoom,
 * drag pan, pinch, and double-click zoom, matching the main map.
 */
import { createMemo, createSignal, For, onSettled, Show, untrack } from "solid-js";
import type { BrowserAgency } from "~/agencies/types";
import { countryName } from "~/i18n/jurisdictions";
import { useI18n } from "~/i18n/I18nContext";
import type { CoverageGeography } from "./generated/geography";
import { CoverageMap } from "./CoverageMap";
import {
  agencyById,
  agencySpanKilometers,
  buildCoverageAgencies,
  buildCoverageView,
  coverageCountsForCountry,
  focusedCoverageCountry,
  COVERAGE_BOUNDARIES,
  COVERAGE_GEOGRAPHY,
  COVERAGE_SOURCES,
  type CoverageAgency,
} from "./coverageModel";
import { CoverageCloseButton, modeLabel } from "./coverageChrome";

export interface NetworkCoverageProps {
  readonly countries: Readonly<Record<string, CoverageGeography>>;
  readonly providers: readonly BrowserAgency[];
  readonly currentAgencyId: string | undefined;
  readonly onClose: () => void;
  readonly prefersReducedMotion?: () => boolean;
}

const STATUS_FILTERS = [
  { status: "active", dot: "bg-[#4ade80]" },
  { status: "experimental", dot: "bg-slate-500" },
] as const satisfies readonly {
  readonly status: CoverageAgency["status"];
  readonly dot: string;
}[];

export function NetworkCoverage(props: NetworkCoverageProps) {
  const i18n = useI18n();
  const { t, plural, unitSystem, formatNumber } = i18n;
  const [hoveredId, setHoveredId] = createSignal<string>();
  const [selectedId, setSelectedId] = createSignal<string>();
  const [showCoverage, setShowCoverage] = createSignal(true);
  const [hoveredStatus, setHoveredStatus] = createSignal<CoverageAgency["status"]>();
  const [pinnedStatus, setPinnedStatus] = createSignal<CoverageAgency["status"]>();
  const statusFilter = () => hoveredStatus() ?? pinnedStatus();
  const agencies = createMemo(() =>
    buildCoverageAgencies(props.providers, props.currentAgencyId, props.countries),
  );
  const regional = createMemo(() => agencies().filter((agency) => agency.scope === "regional"));
  const visibleAgencies = createMemo(() => {
    const filter = statusFilter();
    return filter ? regional().filter((agency) => agency.status === filter) : regional();
  });
  const view = createMemo(() => buildCoverageView(agencies()));
  const network = createMemo(() => agencies().filter((agency) => agency.scope !== "regional"));
  const visibleNetwork = createMemo(() => {
    const filter = statusFilter();
    return filter ? network().filter((agency) => agency.status === filter) : network();
  });
  const focused = createMemo(() => {
    const filter = statusFilter();
    const agency =
      agencyById(agencies(), hoveredId() ?? selectedId()) ??
      agencyById(agencies(), props.currentAgencyId);
    return agency && (!filter || agency.status === filter) ? agency : undefined;
  });
  const togglePinnedStatus = (status: CoverageAgency["status"]) =>
    setPinnedStatus((current) => (current === status ? undefined : status));

  const spanLabel = (agency: CoverageAgency) => {
    const kilometers = agencySpanKilometers(agency);
    if (unitSystem() === "imperial") {
      return t("~{{span}} mi span", {
        span: formatNumber(Math.round(kilometers * 0.621371)),
      });
    }
    return t("~{{span}} km span", { span: formatNumber(kilometers) });
  };

  let dialog!: HTMLDialogElement;
  let animation: Animation | undefined;
  let closing = false;
  let disposed = false;
  const prefersReducedMotion = () =>
    props.prefersReducedMotion?.() ??
    (document.documentElement.dataset.reducedMotion === "true" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const requestClose = () => {
    if (closing) return;
    closing = true;
    animation?.cancel();
    if (prefersReducedMotion() || typeof dialog.animate !== "function") {
      props.onClose();
      return;
    }
    animation = dialog.animate(
      [
        { opacity: 1, transform: "translateY(0) scale(1)" },
        { opacity: 0, transform: "translateY(10px) scale(0.985)" },
      ],
      { duration: 160, easing: "ease-in", fill: "forwards" },
    );
    void animation.finished
      .then(() => {
        if (!disposed) props.onClose();
      })
      .catch(() => {
        if (!disposed) props.onClose();
      });
  };
  onSettled(() => {
    const trigger = document.activeElement;
    dialog.showModal();
    if (!untrack(prefersReducedMotion) && typeof dialog.animate === "function") {
      animation = dialog.animate(
        [
          { opacity: 0, transform: "translateY(12px) scale(0.985)" },
          { opacity: 1, transform: "translateY(0) scale(1)" },
        ],
        { duration: 220, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
      );
      void animation.finished.catch(() => {});
    }
    dialog.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      disposed = true;
      animation?.cancel();
      dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  });

  return (
    <dialog
      ref={(element) => {
        dialog = element;
      }}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={t("Coverage Map")}
      class="fixed inset-0 m-0 h-full max-h-none w-full max-w-none border-0 p-0 z-[100] flex flex-col overflow-hidden bg-drafting-grid text-white selection:bg-[#f4c542]/30"
    >
      <CoverageMap
        id="coverage-map"
        view={view()}
        agencies={visibleAgencies()}
        networkAgencies={visibleNetwork()}
        geography={COVERAGE_GEOGRAPHY}
        boundaries={COVERAGE_BOUNDARIES}
        width={1600}
        height={1000}
        padding={18}
        focusBounds={view().focusBounds}
        ariaLabel={t("Service area map")}
        hint={t("Scroll to zoom · drag to pan")}
        interactive
        showLabels
        showCoverage={showCoverage()}
        selectedId={selectedId()}
        hoveredId={hoveredId()}
        onHover={setHoveredId}
        onSelect={setSelectedId}
      >
        {(map, center) => {
          const country = createMemo(() => focusedCoverageCountry(center(), props.countries));
          const counts = createMemo(() => coverageCountsForCountry(agencies(), country()));
          const countryLabel = () => {
            const code = country();
            return code ? countryName(code, i18n.locale()) : "-";
          };
          return (
            <>
              <header class="relative flex shrink-0 flex-col gap-3 border-b border-white/10 bg-[#03050a]/95 px-4 py-3 lg:flex-row lg:items-center lg:gap-0 lg:px-6">
                <div class="relative flex h-8 w-full items-center justify-between lg:contents">
                  <div class="font-mono text-[10px] font-bold tracking-[0.16em] text-info uppercase lg:text-[13px] lg:tracking-[0.2em]">
                    [Schematic]
                  </div>
                  <h1 class="absolute top-1/2 left-1/2 max-w-[calc(100vw-14rem)] -translate-x-1/2 -translate-y-1/2 truncate text-center font-mono text-[11px] font-bold tracking-[0.14em] text-white uppercase lg:max-w-none lg:text-[12px]">
                    {t("Coverage Map")}
                  </h1>
                  <div class="lg:order-last lg:ml-4">
                    <CoverageCloseButton onClose={requestClose} label={t("Close coverage map")} />
                  </div>
                </div>
                <div class="flex min-h-10 w-full items-center gap-2 min-[375px]:gap-4 lg:ml-auto lg:w-auto lg:gap-4">
                  <div class="min-w-24 shrink-0 text-center lg:min-w-0">
                    <div class="whitespace-nowrap font-mono text-sm font-bold text-white min-[375px]:text-lg">
                      {countryLabel()}
                    </div>
                    <div class="font-mono text-[8px] tracking-[0.12em] text-slate-500 uppercase lg:tracking-[0.14em]">
                      {t("Country")}
                    </div>
                  </div>
                  <Show when={counts().total > 0}>
                    <div class="hidden h-8 w-px shrink-0 bg-white/10 lg:block" />
                  </Show>
                  <div class="flex min-h-10 min-w-0 flex-1 items-center justify-around gap-0 min-[375px]:gap-2 lg:flex-none lg:gap-4">
                    <Show when={counts().regional > 0}>
                      <div class="text-center lg:text-right">
                        <div class="font-mono text-lg font-bold tabular-nums text-white">
                          {counts().regional}
                        </div>
                        <div class="font-mono text-[8px] tracking-[0.12em] text-slate-500 uppercase lg:text-[8px] lg:tracking-[0.14em]">
                          {t("Regional")}
                        </div>
                      </div>
                    </Show>
                    <Show when={counts().national > 0}>
                      <div class="text-center lg:text-right">
                        <div class="font-mono text-lg font-bold tabular-nums text-white">
                          {counts().national}
                        </div>
                        <div class="font-mono text-[8px] tracking-[0.12em] text-slate-500 uppercase lg:text-[8px] lg:tracking-[0.14em]">
                          {t("National")}
                        </div>
                      </div>
                    </Show>
                    <Show when={counts().international > 0}>
                      <div class="text-center lg:text-right">
                        <div class="font-mono text-lg font-bold tabular-nums text-white">
                          {counts().international}
                        </div>
                        <div class="font-mono text-[8px] tracking-[0.12em] text-slate-500 uppercase lg:text-[8px] lg:tracking-[0.14em]">
                          {t("International")}
                        </div>
                      </div>
                    </Show>
                  </div>
                </div>
              </header>

              <main class="relative min-h-0 flex-1">
                {map}
                <div class="absolute right-4 bottom-0.5 z-10 flex max-w-[min(100%,32rem)] flex-wrap justify-end gap-x-1.5 text-[8px] text-slate-500">
                  <For each={COVERAGE_SOURCES}>
                    {(source, index) => (
                      <>
                        {index() > 0 && <span aria-hidden="true">·</span>}
                        <a
                          href={source.url}
                          target="_blank"
                          rel="noreferrer"
                          class="hover:text-white"
                        >
                          {source.label}
                        </a>
                      </>
                    )}
                  </For>
                </div>

                <Show when={focused()}>
                  {(agency) => (
                    <div class="pointer-events-none absolute bottom-16 left-4 z-10 w-[min(23rem,calc(100%-2rem))] rounded-xl border border-white/10 bg-[#0c1017]/92 p-3 shadow-2xl backdrop-blur-md md:left-6">
                      <div class="flex items-start gap-3">
                        <span
                          class="mt-1 h-3 w-3 shrink-0 rounded-full ring-4 ring-white/5"
                          style={{ "background-color": agency().glow }}
                        />
                        <div class="min-w-0">
                          <div class="flex flex-wrap items-center gap-2">
                            <span class="text-sm font-semibold text-white">{agency().name}</span>
                            <span
                              class={`rounded-full px-1.5 py-0.5 font-mono text-[8px] font-bold tracking-[0.12em] uppercase ${
                                agency().status === "active"
                                  ? "bg-[#4ade80]/15 text-[#86efac]"
                                  : "bg-white/5 text-slate-400"
                              }`}
                            >
                              {t(agency().status)}
                            </span>
                            <Show when={agency().isCurrent}>
                              <span class="rounded-full bg-[#38bdf8]/15 px-1.5 py-0.5 font-mono text-[8px] font-bold tracking-[0.12em] text-[#7dd3fc] uppercase">
                                {t("Current")}
                              </span>
                            </Show>
                          </div>
                          <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-slate-400">
                            <span>{modeLabel(agency().modes, t)}</span>
                            <span>{plural("Service zone count", agency().bounds.length)}</span>
                            <span>{spanLabel(agency())}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </Show>

                <div class="absolute top-3 left-4 z-10 flex flex-wrap items-center gap-2 md:left-6">
                  <div class="pointer-events-auto flex items-center gap-3 rounded-full border border-white/8 bg-[#0a0e14]/70 px-3 py-1.5 text-[9px] tracking-[0.1em] text-slate-500 uppercase backdrop-blur-sm">
                    <For each={STATUS_FILTERS}>
                      {(filter) => (
                        <button
                          type="button"
                          aria-pressed={pinnedStatus() === filter.status ? "true" : "false"}
                          onPointerEnter={() => setHoveredStatus(filter.status)}
                          onPointerLeave={() => setHoveredStatus(undefined)}
                          onFocus={() => setHoveredStatus(filter.status)}
                          onBlur={() => setHoveredStatus(undefined)}
                          onClick={() => togglePinnedStatus(filter.status)}
                          class="flex cursor-pointer items-center gap-1.5 text-slate-400 font-medium uppercase transition-colors hover:text-white"
                        >
                          <span class={`h-1.5 w-1.5 rounded-full ${filter.dot}`} />{" "}
                          {t(filter.status)}
                        </button>
                      )}
                    </For>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={showCoverage() ? "true" : "false"}
                    aria-label={t("Service areas")}
                    onClick={() => setShowCoverage((value) => !value)}
                    class="pointer-events-auto flex cursor-pointer items-center gap-2 rounded-full border border-white/8 bg-[#0a0e14]/70 px-3 py-1.5 text-[9px] font-medium tracking-[0.1em] text-slate-400 uppercase backdrop-blur-sm transition-colors hover:border-white/15 hover:text-white active:bg-white/5"
                  >
                    {t("Service areas")}
                    <span
                      aria-hidden="true"
                      class={`relative flex h-3.5 w-6 items-center rounded-full transition-colors ${
                        showCoverage() ? "bg-[#38bdf8]/35" : "bg-white/10"
                      }`}
                    >
                      <span
                        class={`h-2.5 w-2.5 rounded-full transition-transform ${
                          showCoverage()
                            ? "translate-x-3 bg-[#7dd3fc]"
                            : "translate-x-0.5 bg-slate-500"
                        }`}
                      />
                    </span>
                  </button>
                </div>
              </main>
            </>
          );
        }}
      </CoverageMap>
    </dialog>
  );
}
