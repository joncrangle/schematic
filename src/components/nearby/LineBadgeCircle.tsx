import { For } from "solid-js";
import { contrastTextColorForLine, lineColorFor } from "~/domain/lineColors";
import { getAgencyById } from "~/agencies/browserRegistry";
import { cn } from "~/lib/utils";
import { useI18n } from "~/i18n/I18nContext";
import { DEFAULT_SURFACE_ROUTE_COLOR } from "~/domain/surface/types";

/**
 * Numeric line identifiers use circles; named identifiers use compact square
 * designators. Colors come from registered schematic line data via lineColorFor.
 */

/**
 * Shared chip style for colored line labels: the network color as background
 * with the label color derived from its luminance. Undefined input yields
 * undefined properties so callers' fallback styling still applies.
 */
export function lineChipStyle(lineColor?: string): {
  "background-color": string | undefined;
  color: string | undefined;
} {
  return {
    "background-color": lineColor,
    color: lineColor ? contrastTextColorForLine(lineColor) : undefined,
  };
}

/**
 * Returns true for 1- or 2-digit numeric line identifiers and false for
 * named line identifiers.
 */
export function isNumericLineId(lineId: string): boolean {
  const trimmed = lineId.trim();
  if (trimmed.length === 0 || trimmed.length > 2) return false;
  const num = Number(trimmed);
  return Number.isInteger(num) && num >= 0 && String(num) === trimmed;
}

export interface LineBadgeCircleProps {
  readonly lineIds: readonly string[];
  readonly agencyId?: string;
  readonly hoveredLineId?: () => string | null;
  readonly onHoverLine?: (lineId: string | null) => void;
  readonly onToggleLine?: (lineId: string) => void;
}

interface SingleBadgeProps {
  readonly lineId: string;
  readonly agencyId?: string;
  readonly isHovered?: boolean;
  readonly onHoverLine?: (lineId: string | null) => void;
  readonly onToggleLine?: (lineId: string) => void;
}

function SingleBadge(props: SingleBadgeProps) {
  const { t } = useI18n();
  const agency = () => getAgencyById(props.agencyId ?? "");
  const shortName = () => agency()?.manifest.routeShortNames?.[props.lineId] ?? props.lineId;
  const line = () => agency()?.light?.lines?.find((l) => l.id === props.lineId);
  const lineColor = () =>
    lineColorFor(props.lineId, getAgencyById(props.agencyId ?? "")?.light?.lines);
  const isNumeric = () => isNumericLineId(shortName());
  const FALLBACK_COLOR = DEFAULT_SURFACE_ROUTE_COLOR;
  const label = () => line()?.name ?? t("Line {{name}}", { name: shortName() });
  const isInteractive = Boolean(props.onToggleLine || props.onHoverLine);

  if (isInteractive) {
    return (
      <button
        type="button"
        title={label()}
        aria-label={label()}
        class={cn(
          "inline-flex min-h-4 shrink-0 items-center justify-center text-[10px] font-bold leading-none shadow-xs cursor-pointer select-none transition-transform duration-150",
          isNumeric() ? "h-4 w-4 rounded-full" : "min-w-4 rounded-md px-1",
          props.isHovered && "scale-125 ring-1 ring-white",
        )}
        style={{
          "background-color": lineColor() ?? FALLBACK_COLOR,
          color: contrastTextColorForLine(lineColor() ?? FALLBACK_COLOR),
        }}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") {
            props.onHoverLine?.(props.lineId);
          }
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse") {
            props.onHoverLine?.(null);
          }
        }}
        onClick={(event) => {
          event.stopPropagation();
          props.onToggleLine?.(props.lineId);
        }}
      >
        <span aria-hidden="true">{shortName()}</span>
      </button>
    );
  }

  return (
    <span
      role="img"
      aria-label={t("Line {{name}}", { name: shortName() })}
      class={cn(
        "inline-flex min-h-4 shrink-0 items-center justify-center text-[10px] font-bold leading-none shadow-xs",
        isNumeric() ? "h-4 w-4 rounded-full" : "min-w-4 rounded-md px-1",
      )}
      style={{
        "background-color": lineColor() ?? FALLBACK_COLOR,
        color: contrastTextColorForLine(lineColor() ?? FALLBACK_COLOR),
      }}
    >
      <span aria-hidden="true">{shortName()}</span>
    </span>
  );
}

/** One or more side-by-side line badges (interchange stations show all). */
export function LineBadgeCircle(props: LineBadgeCircleProps) {
  return (
    <span
      class="inline-flex max-w-full flex-wrap items-center gap-1"
      data-testid="station-line-badges"
    >
      <For each={props.lineIds}>
        {(lineId) => (
          <SingleBadge
            lineId={lineId}
            agencyId={props.agencyId}
            isHovered={props.hoveredLineId?.() === lineId}
            onHoverLine={props.onHoverLine}
            onToggleLine={props.onToggleLine}
          />
        )}
      </For>
    </span>
  );
}
