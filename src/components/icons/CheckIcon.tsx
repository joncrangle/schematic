import type { JSX } from "@solidjs/web";
import { cn } from "~/lib/utils";

export interface IconProps extends JSX.SvgSVGAttributes<SVGSVGElement> {
  size?: number | string;
}

export function CheckIcon(props: IconProps) {
  const size = () => props.size || 14;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size()}
      height={size()}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      {...props}
      class={cn("shrink-0", props.class as string)}
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
