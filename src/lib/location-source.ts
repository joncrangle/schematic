/**
 * Location source selection for Nearby.
 *
 * Which feed supplies the user's position, in priority order:
 * - "dev-spoof": developer-pinned coordinates (localStorage-backed)
 * - "gps": device geolocation API
 * - "coarse-ip": server-side IP-derived approximation
 * - "default": fallback anchor when nothing else is available
 */

export type LocationSource = "dev-spoof" | "gps" | "coarse-ip" | "default";

/** A developer-pinned position used to spoof the device location. */
export interface SpoofPosition {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  agencyId?: string;
}

/**
 * City-level position approximation served by the coarse-ip tier.
 * Derived server-side (Cloudflare `request.cf` geo, or a GeoLite2 lookup on
 * self-host); serializable so it crosses the RPC boundary, and deliberately
 * never persisted client-side.
 */
export interface CoarseLocation {
  latitude: number;
  longitude: number;
  /** Honest radius for an IP-derived fix, roughly city-scale. */
  accuracyMeters?: number;
  city?: string;
  /** Client IP the approximation was derived from (dev-panel visibility). */
  ip?: string;
  source: "cloudflare" | "mmdb";
}

export const COARSE_ACCURACY_METERS = 30_000;

/**
 * Why no coarse fix resolved, when the reason is actionable. Surfaced
 * verbatim in the dev spoof panel so a loopback/dev-proxy address explains
 * itself instead of reading as a broken tier. `ip` echoes the address
 * that was seen, so a dev can tell which header fed the decision.
 */
export interface CoarseUnavailable {
  unavailable: "local-address";
  ip?: string;
}

export const SPOOF_STORAGE_KEY = "nearby_dev_spoof";

// Agency identity is data, not a union (ADR-0007): Core uses plain string
// for agencyId. The registry is the source of truth at runtime.
export type AgencyId = string;
