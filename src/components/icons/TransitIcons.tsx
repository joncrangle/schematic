import type { JSX } from "@solidjs/web";
import { cn } from "~/lib/utils";

export interface IconProps extends JSX.SvgSVGAttributes<SVGSVGElement> {
  size?: number | string;
}

export function BusIcon(props: IconProps) {
  const size = () => props.size || 16;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size()}
      height={size()}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      {...props}
      class={cn("shrink-0", props.class as string)}
    >
      <path d="M8 6v6" />
      <path d="M16 6v6" />
      <path d="M4 6h16a1 1 0 0 1 1 1v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a1 1 0 0 1 1-1Z" />
      <path d="m6 19-1 2" />
      <path d="m18 19 1 2" />
      <circle cx="7.5" cy="15.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="16.5" cy="15.5" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function StreetcarIcon(props: IconProps) {
  const size = () => props.size || 16;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size()}
      height={size()}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      {...props}
      class={cn("shrink-0", props.class as string)}
    >
      <path d="M6 3h12l-2 3H8L6 3Z" />
      <path d="M12 3v3" />
      <path d="M4 6h16a1 1 0 0 1 1 1v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a1 1 0 0 1 1-1Z" />
      <path d="M4 11h16" />
      <path d="M9 11v4" />
      <path d="M15 11v4" />
      <circle cx="7.5" cy="16.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="16.5" cy="16.5" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ExpressIcon(props: IconProps) {
  const size = () => props.size || 16;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size()}
      height={size()}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      {...props}
      class={cn("shrink-0", props.class as string)}
    >
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function RailIcon(props: IconProps) {
  const size = () => props.size || 16;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size()}
      height={size()}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      {...props}
      class={cn("shrink-0", props.class as string)}
    >
      <rect x="4" y="3" width="16" height="16" rx="2" />
      <path d="M8 8h8" />
      <path d="M8 12h8" />
      <path d="M8 16h8" />
      <circle cx="7.5" cy="19.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="16.5" cy="19.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}
