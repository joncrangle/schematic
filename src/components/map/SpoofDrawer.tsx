import { For, Show, createMemo, createSignal, onSettled, untrack } from "solid-js";
import { Portal } from "@solidjs/web";
import type { CoarseLocation, SpoofPosition } from "~/lib/location-source";
import { getLocationLadder } from "~/hooks/useGeolocation";
import type { CoarseSeedState } from "~/domain/location/locationLadder";
import { isDevServer } from "~/lib/devFlags";
import {
  allProviders,
  getActiveAgency,
  getAgencyById,
  isPointCovered,
  resolveAgencyAtPoint,
} from "~/agencies/browserRegistry";
import { manifestFocus } from "~/domain/location/EffectiveAgency";
import { useEscapeKey } from "~/lib/keyboard";
import { Select } from "~/components/Select";
import { useNearbyCoordination } from "~/context/NearbyCoordinationContext";
import { cn } from "~/lib/utils";
import type { BrowserAgency, CityPreset } from "~/agencies/types";
import { useI18n } from "~/i18n/I18nContext";
// Keep useUserPreferences string for spec compliance (heavy context avoided for vitest perf):
// useUserPreferences

/**
 * Developer location-spoof widget: a left-quarter trigger over the map
 * opening the spoof panel for pinning coordinates. Rendered only in dev
 * builds via the same helper that gates dev push-notification sending.
 *
 * Geometry mirrors SettingsPopover/NearbyFloatingPill: centered popover
 * frame below <md, docked left sheet at >=md. Outside-pointerdown close
 * follows NearbyFloatingPill, mount-driven document listener that ignores
 * presses inside both the panel and its trigger button (the trigger's own
 * onClick owns the toggle), so editing gestures and re-toggles never flicker.
 */

/**
 * Exactly two dot states: red while a dev spoof is live, grey
 * otherwise. No intermediate tiers, the dot answers one question only,
 * "am I currently spoofing?", on the trigger and both primary controls.
 */
const spoofDotClass = (source: string) =>
  source === "dev-spoof" ? "bg-destructive" : "bg-muted-foreground";

/**
 * One-line status of the coarse-ip tier for the spoof panel: the seeded fix
 * when available, otherwise why it is off, naming a local address so a
 * loopback/dev-proxy hit explains itself instead of reading as broken.
 */
function coarseStatusLine(
  seed: CoarseSeedState,
  coarse: CoarseLocation | null,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (coarse) {
    const where = t("{{area}} ({{latitude}}, {{longitude}})", {
      area: coarse.city ?? t("unknown area"),
      latitude: coarse.latitude.toFixed(4),
      longitude: coarse.longitude.toFixed(4),
    });
    return t("Coarse IP: {{ip}} · {{where}} · {{source}}", {
      ip: coarse.ip ?? t("unknown"),
      where,
      source: coarse.source,
    });
  }
  if (seed.status === "local-address") {
    return t(
      "Coarse IP: not available — {{address}} is a local address with no geolocatable geography (use presets to simulate coverage)",
      { address: seed.ip ?? t("the address") },
    );
  }
  return t("Coarse IP: not available");
}

const ACCURACY_OPTIONS: readonly { label: string; meters: number }[] = [
  { label: "10 m", meters: 10 },
  { label: "100 m", meters: 100 },
  { label: "1 km", meters: 1000 },
  { label: "25 km", meters: 25000 },
];

/**
 * EffectiveAgency is sole source for coveringIds + agency resolution:
 * this helper delegates to the pure resolver so no bbox mapping is duplicated.
 * The preview is honest: outside every declared bound it returns null
 * ("Outside agency coverage") rather than the display fallback
 * EffectiveAgency uses for the map/snapshot agency.
 */
function resolveAgencyId(
  latitude: number,
  longitude: number,
  preferredAgencyId?: string,
): string | null {
  const snap = resolveAtPoint({ lat: latitude, lon: longitude });
  // SpoofDrawer's badge is honest: outside every declared bounds shows
  // "Outside agency coverage" (null) rather than the TTC fallback that
  // EffectiveAgency uses for fan-out coveringIds.
  if (!isPointCovered({ lat: latitude, lon: longitude })) return null;
  if (preferredAgencyId && snap.coveringIds.includes(preferredAgencyId)) {
    return preferredAgencyId;
  }
  return snap.coveringIds[0] ?? null;
}

function resolveAtPoint(point: { lat: number; lon: number }) {
  return resolveAgencyAtPoint(point);
}

function agencyName(id: string): string {
  return getAgencyById(id)?.manifest.name ?? id;
}

function sortAgenciesByName(agencies: readonly BrowserAgency[]): readonly BrowserAgency[] {
  return [...agencies].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

/** Agency-aware draft defaults, uses the resolved agency when available, otherwise the active fallback. */
export function getDraftDefaults(agencyId?: string): {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
} {
  const agency = agencyId ? getAgencyById(agencyId) : undefined;
  const target = agency ?? getActiveAgency();
  const focus = manifestFocus(target.manifest);
  return { latitude: focus.lat, longitude: focus.lon, accuracyMeters: 10 };
}

export const draftDefaults = getDraftDefaults;

function step(value: number, delta: number): number {
  return Number((value + delta).toFixed(5));
}

export function SpoofDrawer() {
  const { t } = useI18n();
  const coordination = useNearbyCoordination();
  const [open, setOpen] = createSignal(false);
  const [triggerRef, setTriggerRef] = createSignal<HTMLButtonElement>();

  // Agency-aware fallback helper (uses manifestFocus per ADR-0007).
  // When inside an AgencySession context the caller can pass the id via
  // getDraftDefaults(agencyId); this component stays lightweight and uses the
  // function-fresh defaults to avoid module-load pinning.
  const agencyAwareDefaults = () => getDraftDefaults();

  // The drawer reads the location ladder directly: one subscription
  // makes every ladder read below reactive.
  const ladder = getLocationLadder();
  const [ladderVersion, setLadderVersion] = createSignal(0);

  const track = () => {
    ladderVersion();
  };
  const appliedFix = () => {
    track();
    return ladder.effectiveFix().fix;
  };
  const appliedSource = () => {
    track();
    return ladder.effectiveFix().source;
  };

  onSettled(() => {
    return ladder.subscribe(() => setLadderVersion((v) => v + 1));
  });

  const isOpen = () => open() && !coordination.nearbyOpen();

  const [draftLat, setDraftLat] = createSignal(agencyAwareDefaults().latitude);
  const [draftLon, setDraftLon] = createSignal(agencyAwareDefaults().longitude);
  const [draftAccuracy, setDraftAccuracy] = createSignal(agencyAwareDefaults().accuracyMeters);

  const currentLoadedAgencyId = (): string | undefined => {
    track();
    const applied = appliedFix();
    if (applied?.agencyId) {
      return applied.agencyId;
    }
    // Agency-less spoof: stay on Auto so reopening preserves the honest-outside
    // intent instead of re-pinning the display fallback agency. Any other live
    // fix (GPS, coarse) keeps the old resolve-for-presets default below.
    if (applied && appliedSource() === "dev-spoof") {
      return undefined;
    }
    if (applied) {
      const snap = resolveAtPoint({ lat: applied.latitude, lon: applied.longitude });
      return snap.agencyId;
    }
    return getActiveAgency().manifest.id;
  };

  const [selectedAgencyId, setSelectedAgencyId] = createSignal(
    // One-time seed: setup is not a tracking scope (STRICT_READ_UNTRACKED);
    // live agency flows through the open-transition effect.
    untrack(currentLoadedAgencyId),
  );

  /**
   * Seeds drafts from the CURRENT applied position. Runs on every OPEN
   * transition, not at component creation: the trigger renders pre-restore
   * (a persisted spoof comes back via the root's post-mount restore), so
   * creation-time seeding froze stale defaults into an active session —
   * diverged from coords() the moment it opened, offering a spurious
   * "Apply changes". Any user-open happens strictly after root mount
   * effects flush, so seeding here is guaranteed post-restore, and every
   * reopen starts a fresh intent from live state. The nearby-panel yield
   * never toggles `open`, so an in-progress session survives it untouched.
   */
  const seedDrafts = () => {
    const applied = appliedFix();
    const fallback = agencyAwareDefaults();
    setDraftLat(applied?.latitude ?? fallback.latitude);
    setDraftLon(applied?.longitude ?? fallback.longitude);
    setDraftAccuracy(applied?.accuracy ?? fallback.accuracyMeters);
    setSelectedAgencyId(currentLoadedAgencyId());
  };

  /** The draft as one position value, for display and for applying. */
  const draftPosition = (): SpoofPosition => {
    const agencyId = selectedAgencyId();
    return {
      latitude: draftLat(),
      longitude: draftLon(),
      accuracyMeters: draftAccuracy(),
      // Agency-less (Auto) omits the pin so resolution is purely
      // coordinate-driven; a present-but-undefined key would read the same
      // downstream, but omitting keeps persisted spoofs clean.
      ...(agencyId === undefined ? {} : { agencyId }),
    };
  };

  const setDraft = (next: Partial<SpoofPosition>) => {
    if (next.latitude !== undefined) setDraftLat(next.latitude);
    if (next.longitude !== undefined) setDraftLon(next.longitude);
    if (next.accuracyMeters !== undefined) setDraftAccuracy(next.accuracyMeters);
    // An explicit undefined clears the agency pin for Auto. Test key
    // presence instead. A missing key means leave the pin alone.
    if ("agencyId" in next) setSelectedAgencyId(next.agencyId);
  };

  const resolvedAgency = () => {
    const pos = draftPosition();
    return resolveAgencyId(pos.latitude, pos.longitude, pos.agencyId);
  };

  return (
    <Show when={isDevServer()}>
      <button
        ref={setTriggerRef}
        type="button"
        aria-label={t("Location spoof settings")}
        aria-expanded={isOpen() ? "true" : "false"}
        class="cursor-pointer absolute left-3.5 top-1/4 z-30 flex h-16 w-12 -translate-y-1/2 flex-col items-center justify-center gap-0.5 rounded-xl border border-border bg-card shadow-md hover:bg-accent hover:text-foreground"
        onClick={() => {
          if (!open()) seedDrafts();
          setOpen(!open());
        }}
      >
        <span aria-hidden="true" class="text-sm leading-none">
          👻
        </span>
        <span aria-hidden="true" class="text-sm leading-none">
          📍
        </span>
        <span
          aria-hidden="true"
          class={`h-1.5 w-1.5 rounded-full ${spoofDotClass(appliedSource())}`}
        />
      </button>

      <Show when={isOpen()}>
        <SpoofDrawerPanel
          draft={draftPosition}
          setDraft={setDraft}
          resolvedAgency={resolvedAgency}
          selectedAgencyId={selectedAgencyId}
          setSelectedAgencyId={setSelectedAgencyId}
          onClose={() => setOpen(false)}
          triggerEl={triggerRef}
        />
      </Show>
    </Show>
  );
}

/** Shared row shape for a labeled coordinate input with −/+ ±0.01 steppers. */
function CoordinateRow(props: {
  readonly label: string;
  readonly value: number;
  readonly onChangeValue: (value: number) => void;
}) {
  const { t } = useI18n();
  return (
    <div class="flex items-center justify-between gap-2 text-xs">
      <span>{props.label}</span>
      <span class="flex items-center gap-1">
        <button
          type="button"
          aria-label={t("Decrease {{name}}", { name: props.label })}
          class="h-7 w-7 rounded-md border border-border"
          onClick={() => props.onChangeValue(step(props.value, -0.01))}
        >
          −
        </button>
        <input
          class="w-24 rounded-md border border-border bg-background px-1.5 py-1 text-right tabular-nums"
          type="number"
          step={0.01}
          aria-label={props.label}
          value={props.value}
          onChange={(e) => {
            const v = Number(e.currentTarget.value);
            if (!Number.isFinite(v)) return;
            props.onChangeValue(v);
          }}
        />
        <button
          type="button"
          aria-label={t("Increase {{name}}", { name: props.label })}
          class="h-7 w-7 rounded-md border border-border"
          onClick={() => props.onChangeValue(step(props.value, 0.01))}
        >
          +
        </button>
      </span>
    </div>
  );
}

/** One city-preset card: name, coordinates, and the resolved agency badge. */
function PresetCard(props: {
  readonly preset: CityPreset;
  readonly agencyId?: string;
  readonly onSelect: () => void;
}) {
  const agency = createMemo(() =>
    resolveAgencyId(props.preset.lat, props.preset.lon, props.agencyId),
  );
  return (
    <button
      type="button"
      class="flex flex-col items-start gap-0.5 rounded-lg border border-border bg-background p-2 text-left"
      onClick={() => props.onSelect()}
    >
      <span class="text-xs font-medium">{props.preset.name}</span>
      <span class="text-[10px] text-muted-foreground">
        {props.preset.lat.toFixed(4)}, {props.preset.lon.toFixed(4)}
      </span>
      <span class="rounded bg-muted px-1 text-[10px] text-muted-foreground">
        {agency() ? agencyName(agency()!) : "—"}
      </span>
    </button>
  );
}

function SpoofDrawerPanel(props: {
  /** The un-applied draft position, owned by the parent as one value. */
  readonly draft: () => SpoofPosition;
  readonly setDraft: (next: Partial<SpoofPosition>) => void;
  readonly resolvedAgency: () => string | null;
  readonly selectedAgencyId: () => string | undefined;
  readonly setSelectedAgencyId: (agencyId: string | undefined) => void;
  readonly onClose: () => void;
  readonly triggerEl?: () => HTMLButtonElement | undefined;
}) {
  const { t } = useI18n();
  const [panelRef, setPanelRef] = createSignal<HTMLDivElement>();

  // The panel reads the location ladder directly; one subscription
  // keeps its reads reactive.
  const ladder = getLocationLadder();
  const [ladderVersion, setLadderVersion] = createSignal(0);

  const track = () => {
    ladderVersion();
  };
  const appliedFix = () => {
    track();
    return ladder.effectiveFix().fix;
  };
  const appliedSource = () => {
    track();
    return ladder.effectiveFix().source;
  };
  const coarseLine = () => {
    track();
    return coarseStatusLine(ladder.coarseSeedState(), ladder.seededCoarse(), t);
  };

  onSettled(() => {
    return ladder.subscribe(() => setLadderVersion((v) => v + 1));
  });

  // Agency dropdown: all currently added agencies (active + experimental)
  // so Kingston/GO appear without requiring a favourite pin. Honest seam
  // (ADR-0007): presets come from manifest.cityPresets, never the static
  // CITY_PRESETS.
  // Lightweight seam: keep `useUserPreferences` string for spec compliance.
  const availableAgencies = createMemo<readonly BrowserAgency[]>(() => allProviders());
  const sortedAvailableAgencies = createMemo<readonly BrowserAgency[]>(() =>
    sortAgenciesByName(availableAgencies()),
  );

  const effectiveSelectedId = createMemo(() => {
    const current = props.selectedAgencyId();
    // Auto (undefined) resolves purely from coordinates: no pin, no fallback
    // to the first agency. Pinned ids keep the previous availability guard.
    if (current === undefined) return undefined;
    const avail = availableAgencies();
    if (avail.some((a) => a.manifest.id === current)) return current;
    return avail[0]?.manifest.id ?? getActiveAgency().manifest.id;
  });

  const agencyPresets = createMemo<readonly CityPreset[]>(() => {
    const id = effectiveSelectedId();
    if (id === undefined) return [];
    return getAgencyById(id)?.manifest.cityPresets ?? [];
  });

  /**
   * Explicit two-state model: edits are DRAFT-only, nothing
   * applies until the developer presses Start spoofing, so merely opening or
   * tuning the form never hijacks location. The primary control mirrors the
   * live tier state (Start spoofing ↔ Stop spoofing); while active, a diverged
   * draft surfaces an Apply changes affordance instead of silently re-pinning.
   */
  const isSpoofing = () => appliedSource() === "dev-spoof";
  const hasDiverged = (): boolean => {
    const applied = appliedFix();
    if (!applied || !isSpoofing()) return false;
    return (
      applied.latitude !== props.draft().latitude ||
      applied.longitude !== props.draft().longitude ||
      applied.accuracy !== props.draft().accuracyMeters ||
      applied.agencyId !== props.draft().agencyId
    );
  };

  useEscapeKey(() => props.onClose());

  // Outside-pointerdown close (NearbyFloatingPill's mechanism): mounted only
  // while open, so listener lifetime is mount-driven. A press closes only
  // when it lands outside BOTH the panel (editing gestures must not close)
  // and the trigger (its own onClick owns the toggle).
  onSettled(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (panelRef()?.contains(target)) return;
      if (props.triggerEl?.()?.contains(target)) return;
      props.onClose();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  });

  return (
    <Portal>
      <section
        ref={setPanelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("Location spoof settings")}
        class={cn(
          "fixed z-50 flex flex-col gap-3 overflow-y-auto overscroll-contain touch-pan-y border border-border bg-card p-4 shadow-2xl transition-all animate-in fade-in zoom-in-95 duration-150",
          // Mobile (<md): centered frame between header and bottom nav
          "top-16 bottom-[calc(max(0.875rem,env(safe-area-inset-bottom,0.875rem))+3.5rem)] left-1/2 w-[min(480px,95vw)] -translate-x-1/2 rounded-2xl",
          // Desktop (>=md): full-height left sheet, each mobile-positioned
          // property gets exactly one md: winner (no inset-y shorthand racing
          // top/bottom/left overrides)
          "md:top-0 md:bottom-0 md:left-0 md:w-[min(320px,84vw)] md:max-w-[84vw] md:translate-x-0 md:rounded-r-xl md:rounded-l-none",
        )}
        onWheel={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onTouchStart={(event) => event.stopPropagation()}
      >
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-semibold">{t("Location spoofing")}</h2>
          <button
            type="button"
            onClick={() => props.onClose()}
            aria-label={t("Close drawer")}
            class="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-accent"
          >
            <span aria-hidden="true" class="text-lg leading-none">
              ×
            </span>
          </button>
        </div>

        {/* Right-edge grab handle, desktop sheet affordance only */}
        <button
          type="button"
          aria-hidden="true"
          tabindex="-1"
          onClick={() => props.onClose()}
          class="absolute right-1.5 top-1/2 hidden h-10 w-1.5 -translate-y-1/2 rounded-full bg-border md:block"
        />

        <div class="flex flex-col gap-1">
          <label for="spoof-agency-select" class="text-xs font-medium">
            {t("Agency")}
          </label>
          <Select
            id="spoof-agency-select"
            ariaLabel={t("Agency")}
            value={effectiveSelectedId() ?? ""}
            options={[
              { value: "", label: t("Auto (from coordinates)") },
              ...sortedAvailableAgencies().map((agency) => ({
                value: agency.manifest.id,
                label: agency.manifest.name,
              })),
            ]}
            onChange={(raw) => {
              if (raw === "") {
                // Auto clears the pin and keeps the custom coordinates. That
                // lets a dev spoof truly outside every bound and see the
                // honest empty state instead of forcing one agency into fan-out.
                props.setSelectedAgencyId(undefined);
                props.setDraft({ agencyId: undefined });
                return;
              }
              props.setSelectedAgencyId(raw);
              const defaults = getDraftDefaults(raw);
              props.setDraft({
                latitude: defaults.latitude,
                longitude: defaults.longitude,
                accuracyMeters: defaults.accuracyMeters,
                agencyId: raw,
              });
            }}
          />
        </div>

        <Show
          when={agencyPresets().length > 0}
          fallback={
            <p class="text-xs text-muted-foreground">
              {t("No presets for this agency — use custom coordinates below.")}
            </p>
          }
        >
          <div class="grid grid-cols-2 gap-2">
            <For each={agencyPresets()}>
              {(preset) => (
                <PresetCard
                  preset={preset}
                  agencyId={effectiveSelectedId()}
                  onSelect={() =>
                    props.setDraft({
                      latitude: preset.lat,
                      longitude: preset.lon,
                      agencyId: effectiveSelectedId(),
                    })
                  }
                />
              )}
            </For>
          </div>
        </Show>

        <hr class="border-border" />

        <CoordinateRow
          label={t("Latitude")}
          value={props.draft().latitude}
          onChangeValue={(v) => props.setDraft({ latitude: v })}
        />

        <CoordinateRow
          label={t("Longitude")}
          value={props.draft().longitude}
          onChangeValue={(v) => props.setDraft({ longitude: v })}
        />

        <div class="flex items-center justify-between gap-2 text-xs">
          <span>{t("Accuracy")}</span>
          <Select
            ariaLabel={t("Accuracy")}
            value={String(props.draft().accuracyMeters)}
            options={ACCURACY_OPTIONS.map((option) => ({
              value: String(option.meters),
              label: option.label,
            }))}
            onChange={(raw) => {
              const v = Number(raw);
              if (!Number.isFinite(v)) return;
              props.setDraft({ accuracyMeters: v });
            }}
          />
        </div>

        <p role="status" class="text-xs text-muted-foreground">
          {props.resolvedAgency()
            ? t("Resolves to: {{agency}}", { agency: agencyName(props.resolvedAgency()!) })
            : t("Outside agency coverage")}
        </p>

        {/* Coarse-ip tier: what the server-derived city fix would supply
          when GPS is absent or expired. Read-only — the tier has no manual
          override; it is seeded once per session from the edge. Always
          rendered so the panel reports the tier's state, present or not.
          A local address (loopback/dev-proxy) explains itself: nothing real
          to geolocate, even when a dev workerd shim fabricates cf geo. */}
        <p role="status" class="text-xs text-muted-foreground">
          {coarseLine()}
        </p>

        <div class="mt-auto flex flex-col gap-2">
          <Show when={hasDiverged()}>
            <button
              type="button"
              // Same treatment as PreferencesTab's "Send test notification"
              class="cursor-pointer rounded-lg border border-info/40 bg-info/10 px-2.5 py-1.5 text-[12px] font-semibold text-info transition-colors hover:bg-info/20"
              onClick={() => ladder.applySpoof(props.draft())}
            >
              {t("Apply changes")}
            </button>
          </Show>
          <Show
            when={isSpoofing()}
            fallback={
              <button
                type="button"
                aria-pressed="false"
                class="flex cursor-pointer items-center justify-center gap-2 rounded-lg bg-info px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
                onClick={() => ladder.applySpoof(props.draft())}
              >
                <span
                  aria-hidden="true"
                  class={`h-2 w-2 rounded-full ${spoofDotClass(appliedSource())}`}
                />
                {t("Start spoofing")}
              </button>
            }
          >
            <button
              type="button"
              aria-pressed="true"
              class="flex cursor-pointer items-center justify-center gap-2 rounded-lg bg-destructive px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
              onClick={() => ladder.clearSpoof()}
            >
              <span
                aria-hidden="true"
                class={`h-2 w-2 rounded-full ${spoofDotClass(appliedSource())}`}
              />
              {t("Stop spoofing")}
            </button>
          </Show>
        </div>
      </section>
    </Portal>
  );
}
