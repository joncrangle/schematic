import { AlertDescription } from "~/components/AlertDescription";
import { cn } from "~/lib/utils";
import type { Point, StatusOverlaySegment, StatusSegmentKind } from "~/core/map";
import { BaseMapPopover } from "./popovers/BaseMapPopover";
import { lineChipStyle } from "~/components/nearby/LineBadgeCircle";
import { useI18n } from "~/i18n/I18nContext";
import type { TranslationKey } from "~/i18n/en";

interface SegmentPopoverProps {
  segment: StatusOverlaySegment;
  coords: Point | undefined;
  containerSize?: { width: number; height: number };
  onClose: () => void;
  setRef: (element: HTMLDivElement) => void;
}

const KIND_INFO = {
  severe: {
    label: "Severe Disruption",
    badgeBg: "bg-destructive/20 text-destructive border-destructive/30",
  },
  rsz: {
    label: "Reduced Speed Zone",
    badgeBg: "bg-warning/20 text-warning-400 border-warning/30",
  },
  delay: {
    label: "Delay / Warning",
    badgeBg: "bg-warning/20 text-warning-400 border-warning/30",
  },
  upcoming: {
    label: "Upcoming Planned Change",
    badgeBg: "bg-muted text-muted-foreground border-border",
  },
} as const satisfies Record<StatusSegmentKind, { label: TranslationKey; badgeBg: string }>;

export function SegmentPopover(props: SegmentPopoverProps) {
  const { t } = useI18n();
  const kindInfo = () => KIND_INFO[props.segment.kind];

  return (
    <BaseMapPopover
      coords={props.coords}
      containerSize={props.containerSize}
      topOffset={20}
      bottomOffset={20}
      hasArrow={true}
      onClose={props.onClose}
      setRef={props.setRef}
      ariaLabel={t("Disruption detail: {{details}}", { details: props.segment.note })}
      class="w-[min(280px,calc(100vw-24px))] p-3.5 text-xs border-border"
      header={
        <span
          class="inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold"
          style={lineChipStyle(props.segment.lineColor)}
        >
          {props.segment.lineName}
        </span>
      }
    >
      <div class="mb-2">
        <span
          class={cn(
            "inline-block rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
            kindInfo().badgeBg,
          )}
        >
          {t(kindInfo().label)}
        </span>
      </div>

      <div class="mb-1.5 text-xs font-semibold text-white">
        {props.segment.fromStation === props.segment.toStation
          ? props.segment.fromStation === props.segment.lineName
            ? t("Route advisory")
            : props.segment.fromStation
          : `${props.segment.fromStation} ↔ ${props.segment.toStation}`}
      </div>

      <p class="whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
        <AlertDescription text={props.segment.note} />
      </p>
    </BaseMapPopover>
  );
}
