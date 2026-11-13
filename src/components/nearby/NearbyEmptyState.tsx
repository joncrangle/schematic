import { MAX_PROXIMITY_RADIUS_METERS } from "~/domain/proximity";
import { formatDistanceValue } from "./nearbyHelpers";
import { BusIcon } from "~/components/icons/TransitIcons";
import { getActiveAgency, getAgencyById } from "~/agencies/browserRegistry";
import { useI18n } from "~/i18n/I18nContext";

export interface NearbyEmptyStateProps {
  /** Shell-resolved agency id; drives in-coverage empty copy. Ignored when outside all coverage. */
  agencyId?: string;
  onRefresh?: () => void;
  isOutsideServiceArea?: boolean;
  /**
   * Honest outside-everywhere flag: a real fix with zero fan-out ids, so no
   * proving fetch was issued. Renders agency-generic copy. The
   * display-fallback agency must never be named.
   */
  isOutsideCoverage?: boolean;
  /** Additive honest flag, when true the empty DB and truly-outside cases share the same honest copy. */
  isDataUnavailable?: boolean;
}

/**
 * Empty state for Nearby when no surface routes are available.
 * Resolves display name via `getAgencyById(agencyId).manifest.name`
 * with fallback to `getActiveAgency().manifest.name` (previously hardcoded TTC).
 * When `isOutsideServiceArea` is true renders honest "No stops within 1.5km"
 * copy (covers both empty-DB seed failure and truly-outside) instead of
 * the previous lie "more than 1.5km from nearest stop".
 * When `isOutsideCoverage` is true the rider is outside every declared bound:
 * copy names no agency and claims no search radius, since none was searched.
 */
export function NearbyEmptyState(props: NearbyEmptyStateProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const agencyName = () => {
    const id = props.agencyId?.trim();
    if (id) {
      const agency = getAgencyById(id);
      if (agency) return agency.manifest.name;
    }
    return getActiveAgency().manifest.name;
  };
  // Honest copy: empty DB (seed failure) and truly-outside both yield
  // `isSuccess + []`. We must not claim "more than 1.5km from nearest stop"
  // when we have not proven a nearest stop exists, phrasing covers both.
  const isHonestOutside = () => Boolean(props.isOutsideServiceArea || props.isDataUnavailable);
  // Outside every declared bound no search ran at all, so neither an agency
  // name nor a radius may appear in the copy.
  const isOutsideEverywhere = () => props.isOutsideCoverage === true;
  // One decision site for the three copy variants, so title and body can
  // never disagree about which state the rider is in.
  const copy = (): { title: string; body: string } => {
    if (isOutsideEverywhere()) {
      return {
        title: t("No nearby stops"),
        body: t(
          "You appear to be outside the service area. Save favourite routes in Settings to view them here.",
        ),
      };
    }
    const name = agencyName();
    if (isHonestOutside()) {
      return {
        title: t("No nearby {{agency}} stops", { agency: name }),
        body: t(
          "No stops found within {{distance}} — transit data may be unavailable or you are outside the {{agency}} service area. Save favourite routes in Settings to view them here.",
          { agency: name, distance: formatDistanceValue(MAX_PROXIMITY_RADIUS_METERS, i18n) },
        ),
      };
    }
    return {
      title: t("No nearby surface routes"),
      body: t("Move closer to a {{agency}} stop", { agency: name }),
    };
  };
  return (
    <div class="flex flex-col items-center justify-center py-7 px-2 text-center text-muted-foreground">
      <div class="mb-2 text-2xl">
        <BusIcon size={28} />
      </div>
      <div class="text-[13px] font-semibold text-foreground">{copy().title}</div>
      <div class="text-[11px] text-muted-foreground mt-0.5 max-w-70">{copy().body}</div>
      {props.onRefresh && (
        <button
          type="button"
          onClick={props.onRefresh}
          class="mt-3.5 inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-muted px-3.5 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-accent active:bg-accent"
        >
          <span>🔄</span>
          <span>{t("Refresh Location")}</span>
        </button>
      )}
    </div>
  );
}
