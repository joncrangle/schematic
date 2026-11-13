import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";

import { getActiveAgency, getAgencyById } from "~/agencies/browserRegistry";
import type { GeolocationStatus } from "~/hooks/useGeolocation";

import { NearbyLoadingSkeleton } from "./NearbyLoadingSkeleton";
import { useI18n } from "~/i18n/I18nContext";

const KNOWN_LOCATION_ERROR_KEYS = {
  "Geolocation is not supported by your browser.": "Geolocation is not supported by your browser.",
  "Location is currently unavailable.": "Location is currently unavailable.",
  "Location request timed out.": "Location request timed out.",
  "Location permission was denied.": "Location permission was denied.",
  "Location is blocked over HTTP. Serve the app over HTTPS to enable nearby results.":
    "Location is blocked over HTTP. Serve the app over HTTPS to enable nearby results.",
} as const;

interface NearbyLocationGateProps {
  status: GeolocationStatus;
  spoofActive: boolean;
  /** True when EffectiveAgency has a usable non-default fix, including coarse IP. */
  locationReady?: boolean;
  /** True once any departure data has landed; suppresses the prompting card. */
  hasData?: boolean;
  graceText?: string;
  errorMessage?: string;
  /** Shell-resolved agency id; drives the nearby stops copy. */
  agencyId?: string;
  onRequestPermission: () => void;
  onDeferPriming: () => void;
}

/**
 * Presentational gate for every pre-data geolocation state: priming
 * nudge, browser-permission wait, hard-failure cards, and the stale-grace
 * banner. Renders nothing once permission is granted or a dev spoof owns the
 * position, the panel owns modal open-state and data presentation.
 *
 * Agency-aware: `agencyId` threads `useAgencySession().displayedAgencyId()` from
 * `AgencySessionContext` into copy via `getAgencyById(id).manifest.name`
 * with `getActiveAgency()` fallback (was hardcoded TTC).
 */
export function NearbyLocationGate(props: NearbyLocationGateProps): JSX.Element {
  const { t } = useI18n();
  const status = () => props.status;
  const suppressed = () => props.spoofActive;
  const locationReady = () => props.locationReady ?? suppressed();
  const agencyName = () => {
    const id = props.agencyId?.trim();
    if (id) {
      const agency = getAgencyById(id);
      if (agency) return agency.manifest.name;
    }
    return getActiveAgency().manifest.name;
  };

  return (
    <>
      <Show when={(status() === "idle" || status() === "priming") && !locationReady()}>
        <div class="flex flex-col items-center rounded-2xl border border-border bg-muted p-5 text-center shadow-lg">
          <div class="mb-3 flex h-12 w-12 items-center justify-center rounded-full border border-info/30 bg-info/12 text-xl text-info">
            ◎
          </div>
          <div class="text-[15px] font-semibold text-white">{t("Find Nearby Transit")}</div>
          <div class="mt-1 max-w-[320px] text-[13px] text-muted-foreground leading-relaxed">
            {t(
              "Allow location access to see the closest {{agency}} stops and live departure times.",
              { agency: agencyName() },
            )}
          </div>
          <div class="mt-3 inline-flex items-center gap-1.5 rounded-full border border-live/30 bg-live/12 px-2.5 py-1 text-[10.5px] font-medium text-live-400">
            <span>🔒</span>
            <span>{t("Used only to find stops near you")}</span>
          </div>
          <div class="mt-4 flex w-full gap-2.5">
            <button
              type="button"
              onClick={props.onDeferPriming}
              class="flex-1 cursor-pointer rounded-xl border border-border bg-transparent py-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-accent"
            >
              {t("Not Now")}
            </button>
            <button
              type="button"
              onClick={props.onRequestPermission}
              class="flex-1 cursor-pointer rounded-xl bg-foreground py-2.5 text-[13px] font-semibold text-black transition-opacity hover:opacity-90 active:scale-98"
            >
              {t("Allow Location")}
            </button>
          </div>
        </div>
      </Show>

      <Show when={status() === "prompting" && !props.hasData && !locationReady()}>
        <div class="flex flex-col items-center rounded-2xl border border-border bg-muted p-5 text-center">
          <div class="mb-3 flex h-12 w-12 items-center justify-center rounded-full border border-info/30 bg-info/12 text-xl text-info animate-pulse">
            ◎
          </div>
          <div class="text-[15px] font-semibold text-white">{t("Waiting for Permission")}</div>
          <div class="mt-1 text-[13px] text-muted-foreground">
            {t("Please choose Allow in your browser prompt...")}
          </div>
          <div class="mt-4 w-full">
            <NearbyLoadingSkeleton />
          </div>
        </div>
      </Show>

      <Show
        when={
          (status() === "denied" || status() === "expired" || status() === "unavailable") &&
          !locationReady()
        }
      >
        <div class="flex flex-col items-center rounded-2xl border border-border bg-muted p-5 text-center">
          <div class="mb-3 flex h-12 w-12 items-center justify-center rounded-full border border-warning/30 bg-warning/15 text-xl text-warning-400">
            ⚠️
          </div>
          <div class="text-[15px] font-semibold text-white">
            {status() === "denied"
              ? t("Location Permission Denied")
              : status() === "expired"
                ? t("Location Expired")
                : t("Location Unavailable")}
          </div>
          <div class="mt-1 text-[13px] text-muted-foreground max-w-70">
            {status() === "denied"
              ? t("Enable location in your settings to view nearby transit.")
              : status() === "expired"
                ? t("GPS connection timed out. Tap Try Again to refresh.")
                : props.errorMessage
                  ? props.errorMessage in KNOWN_LOCATION_ERROR_KEYS
                    ? t(
                        KNOWN_LOCATION_ERROR_KEYS[
                          props.errorMessage as keyof typeof KNOWN_LOCATION_ERROR_KEYS
                        ],
                      )
                    : props.errorMessage
                  : t("Unable to determine your current location.")}
          </div>
          <button
            type="button"
            onClick={props.onRequestPermission}
            class="mt-3.5 w-full cursor-pointer rounded-xl bg-foreground py-2.5 text-[13px] font-semibold text-black transition-opacity hover:opacity-90 active:scale-98"
          >
            {t("Try Again")}
          </button>
        </div>
      </Show>

      <Show when={status() === "stale" && !suppressed()}>
        <div class="mb-1 flex items-center gap-2.5 rounded-xl border border-warning/35 bg-warning/12 p-2.5">
          <span class="text-base text-warning-400">⚠️</span>
          <div class="min-w-0 flex-1">
            <div class="text-xs font-semibold text-warning-400">{t("Last known location")}</div>
            <div class="text-[11px] text-muted-foreground">
              {t("Holding last known surface stops")}
            </div>
          </div>
          <span class="rounded-md bg-warning/25 px-1.5 py-0.5 font-mono text-[11px] font-bold text-warning-300">
            {props.graceText}
          </span>
        </div>
      </Show>
    </>
  );
}
