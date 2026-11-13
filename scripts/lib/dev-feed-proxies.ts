import { readdirSync, readFileSync, statSync } from "node:fs";
import { Agent as HttpsAgent } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProxyOptions } from "vite";

/**
 * Client cipher offer for the `vite dev` upstream feed proxies.
 *
 * GRT's realtime host (Microsoft-IIS, TLS 1.2-only) prefers a sub-1024-bit DHE
 * key that Node's OpenSSL 3 rejects ("dh key too small"), which darkens every
 * proxied GRT feed in `vite dev`. Offering only ECDHE key exchange avoids DHE
 * negotiation entirely; the allow-list holds nothing but strong forward-secret
 * ciphers the other agency hosts already negotiate.
 */
export const DEV_FEED_PROXY_CIPHERS = [
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
].join(":");

const devFeedProxyHttpsAgent = new HttpsAgent({ ciphers: DEV_FEED_PROXY_CIPHERS });

function findAgencyManifests(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findAgencyManifests(path);
    return entry.name === "manifest.json" && statSync(path).isFile() ? [path] : [];
  });
}

/**
 * Builds the `server.proxy` table for `vite dev` feed traffic from agency manifests.
 *
 * Dev-only by construction: `server.proxy` never reaches production builds, and
 * outside dev the request-origin helper returns undefined so clients call the
 * upstreams directly (Workers and Bun both run BoringSSL, which tolerates the
 * GRT host). Certificate validation stays on (`secure: true`); the cipher
 * restriction only changes which key exchange the client offers.
 */
export function createDevFeedProxies(
  agenciesDirectory: string = join(dirname(fileURLToPath(import.meta.url)), "../../src/agencies"),
): Record<string, ProxyOptions> {
  const proxies: Record<string, ProxyOptions> = {};

  for (const manifestPath of findAgencyManifests(agenciesDirectory)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      realtime?: { feeds?: { url?: string; devProxyPrefix?: string }[] };
      alerts?: { url?: string; devProxyPrefix?: string; allowLegacyResponseHeaders?: boolean }[];
    };
    const sources = [...(manifest.realtime?.feeds ?? []), ...(manifest.alerts ?? [])];
    for (const source of sources) {
      if (!source.url || !source.devProxyPrefix) continue;
      const target = new URL(source.url).origin;
      const existing = proxies[source.devProxyPrefix];
      if (existing && existing.target !== target) {
        throw new Error(`Conflicting dev feed proxy targets for ${source.devProxyPrefix}`);
      }
      proxies[source.devProxyPrefix] = {
        target,
        changeOrigin: true,
        secure: true,
        // A node:https Agent on a plain-http entry throws ERR_INVALID_PROTOCOL
        // at request time, so the ECDHE agent attaches to https targets only.
        // Plain-http targets keep http-proxy's default agent handling.
        ...(new URL(source.url).protocol === "https:" ? { agent: devFeedProxyHttpsAgent } : {}),
        ...("allowLegacyResponseHeaders" in source && source.allowLegacyResponseHeaders
          ? { ssl: { insecureHTTPParser: true } }
          : {}),
        rewrite: (path: string) => path.replace(source.devProxyPrefix!, ""),
      };
    }
  }

  return proxies;
}
