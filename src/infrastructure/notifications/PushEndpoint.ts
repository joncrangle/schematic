import { getAdditionalPushEndpointHosts } from "~/infrastructure/env/ServerEnv";

const EXACT_PUSH_HOSTS = new Set([
  "fcm.googleapis.com",
  "push.services.mozilla.com",
  "updates.push.services.mozilla.com",
]);

function isIpLiteral(hostname: string): boolean {
  return hostname.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

function isDnsHostname(hostname: string): boolean {
  if (
    hostname.length > 253 ||
    !hostname.includes(".") ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  )
    return false;
  return hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

/**
 * Accept only browser push-service HTTPS endpoints. Custom hosts are an
 * operator-controlled extension for self-hosted push services, never user
 * input.
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  if (endpoint.length > 2048) return false;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port)
      return false;

    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (isIpLiteral(hostname) || !isDnsHostname(hostname)) return false;

    if (
      EXACT_PUSH_HOSTS.has(hostname) ||
      hostname === "notify.windows.com" ||
      hostname.endsWith(".notify.windows.com") ||
      hostname === "push.apple.com" ||
      hostname.endsWith(".push.apple.com")
    )
      return true;

    return getAdditionalPushEndpointHosts().some(
      (host) => host === hostname && isDnsHostname(host),
    );
  } catch {
    return false;
  }
}
