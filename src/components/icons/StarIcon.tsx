import type { JSX } from "@solidjs/web";
import { cn } from "~/lib/utils";

export interface StarIconProps extends JSX.SvgSVGAttributes<SVGSVGElement> {
  size?: number | string;
  filled?: boolean;
}

export function StarIcon(props: StarIconProps) {
  const size = () => props.size || 16;
  const isFilled = () => props.filled ?? false;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size()}
      height={size()}
      viewBox="0 0 24 24"
      fill={isFilled() ? "currentColor" : "none"}
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      {...props}
      class={cn("shrink-0", props.class as string)}
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}
