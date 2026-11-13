import { isDevServer } from "~/lib/devFlags";

export type HostingTarget = "cloudflare" | "self-hosted";

let hostingTargetProbe: HostingTarget | null = null;
let miniflareProbe: boolean | null = null;

/**
 * Distinguishes local Miniflare (@cloudflare/vite-plugin) from deployed environments.
 * Miniflare runs workerd locally during development (navigator.userAgent includes
 * "Cloudflare-Workers" and isDevServer() is true).
 */
export function isMiniflare(): boolean {
  if (miniflareProbe !== null) return miniflareProbe;
  const isTest = typeof process !== "undefined" && Boolean(process.env.VITEST);
  if (isTest) return false;
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return ua.includes("Cloudflare-Workers") && isDevServer();
}

export function setMiniflareProbeForTesting(value: boolean | null): void {
  miniflareProbe = value;
}

/**
 * Distinguishes deployed Cloudflare Workers from self-hosted Node/Bun/Docker or local dev.
 *
 * In local development under `@cloudflare/vite-plugin` (Miniflare/workerd), requests exit
 * the developer's laptop rather than Cloudflare's ASN 13335 edge network. It is therefore
 * treated as "self-hosted" for alert scraping and scheduler purposes.
 */
export function detectHostingTarget(): HostingTarget {
  if (hostingTargetProbe !== null) return hostingTargetProbe;
  if (isMiniflare()) {
    hostingTargetProbe = "self-hosted";
    return hostingTargetProbe;
  }
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  hostingTargetProbe = ua.includes("Cloudflare-Workers") ? "cloudflare" : "self-hosted";
  return hostingTargetProbe;
}

export function resetHostingTargetProbeForTesting(): void {
  hostingTargetProbe = null;
  miniflareProbe = null;
}
