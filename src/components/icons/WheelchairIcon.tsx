import type { JSX } from "@solidjs/web";
import { cn } from "~/lib/utils";

export interface WheelchairIconProps extends JSX.SvgSVGAttributes<SVGSVGElement> {
  size?: number | string;
  fill?: string;
}

export function WheelchairIcon(props: WheelchairIconProps) {
  const fill = () => props.fill || "#ffffff";
  const size = () => props.size || "100%";

  return (
    <svg
      viewBox="0 0 25 25"
      width={size()}
      height={size()}
      fill="none"
      aria-hidden="true"
      {...props}
      class={cn(props.class as string)}
    >
      <path
        fill-rule="evenodd"
        clip-rule="evenodd"
        d="M20.6181 18.2684L20.1947 17.1041C19.5385 17.337 18.8611 17.591 18.2049 17.8239L16.3632 12.8281H10.6901L10.5631 11.3887H14.4369V10.0762H10.4572L10.2244 7.47248C11.1346 7.40897 11.8755 6.66808 11.8755 5.73666C11.8755 4.76291 11.0923 3.97968 10.1185 3.97968C9.16594 3.97968 8.3827 4.76291 8.3827 5.73666C8.3827 6.13886 8.53088 6.5199 8.76374 6.81625L9.39879 14.1406H15.3683L17.3158 19.475L20.6181 18.2684ZM15.453 16.1727C15.0719 18.2261 13.2091 19.7714 10.9441 19.7714C8.42504 19.7714 6.39286 17.8239 6.39286 15.4107C6.39286 13.823 7.26077 12.4471 8.57322 11.6638L8.44621 10.3302C6.49871 11.2405 5.14392 13.1668 5.14392 15.4107C5.14392 18.5013 7.74765 21.0203 10.9441 21.0203C13.188 21.0203 15.1355 19.7925 16.1092 17.9721L15.453 16.1727Z"
        fill={fill()}
      />
    </svg>
  );
}
