import { getRequestEvent } from "@solidjs/web";
import {
  COARSE_ACCURACY_METERS,
  type CoarseLocation,
  type CoarseUnavailable,
} from "~/lib/location-source";
import { logger } from "~/infrastructure/logging/logger";
import { clientIpFrom } from "~/infrastructure/http/clientIp";
import { loadMmdbReader } from "./CoarseLocationServer";

/**
 * Coarse-location resolution for the coarse-ip tier.
 *
 * Both hosting targets are supported:
 * - Cloudflare Workers: `request.cf` carries city-level geo fields.
 * - Self-hosted (Bun/Docker): no `request.cf`; fall back to a GeoLite2-City
 *   mmdb lookup of the client IP taken from proxy headers. The database path
 *   comes from GEOIP_DB_PATH; when unset (or unreadable) the tier is simply
 *   unavailable and callers stay on gps/default.
 *
 * The resolver is a pure function of the request plus an injectable reader so
 * unit tests cover the decision logic without network or disk; only the
 * default reader touches the filesystem.
 */

/** The subset of Cloudflare's request.cf this resolver reads (city-level geo). */
export interface CfCityGeo {
  city?: string;
  latitude?: string;
  longitude?: string;
}

interface CityBlock {
  location?: { latitude?: number; longitude?: number };
  city?: { names?: { en?: string } };
}

/** Reads a city block for an IP, or null when unknown. Mirrors mmdb-lib's Reader.get. */
export type IpBlockReader = (ip: string) => CityBlock | null;

function coarseFromCf(cf: CfCityGeo): CoarseLocation | null {
  const lat = Number(cf.latitude);
  const lon = Number(cf.longitude);
  // Workers delivers numeric fields as strings; anything missing or NaN means
  // this edge has no usable geo data.
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    latitude: lat,
    longitude: lon,
    accuracyMeters: COARSE_ACCURACY_METERS,
    city: cf.city,
    source: "cloudflare",
  };
}

function coarseFromBlock(block: CityBlock): CoarseLocation | null {
  const lat = block.location?.latitude;
  const lon = block.location?.longitude;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  return {
    latitude: lat,
    longitude: lon,
    accuracyMeters: COARSE_ACCURACY_METERS,
    city: block.city?.names?.en,
    source: "mmdb",
  };
}

/**
 * True for addresses that carry no geolocatable geography: loopback, private
 * ranges, link-local, and unspecified. Dev proxies commonly stamp
 * X-Forwarded-For with a loopback address; looking those up yields garbage
 * fixes at best, so the tier reports unavailable instead.
 */
export function isLocalAddress(ip: string): boolean {
  const normalized = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (normalized === "::1" || normalized === "0.0.0.0") return true;
  if (normalized.startsWith("127.") || normalized.startsWith("10.")) return true;
  if (normalized.startsWith("192.168.")) return true;
  if (normalized.startsWith("169.254.") || normalized.startsWith("fe80:")) return true;
  // CGNAT 100.64.0.0/10, carrier-grade NAT, no public geography
  if (normalized.startsWith("100.")) {
    const second = Number(normalized.split(".")[1]);
    if (Number.isInteger(second) && second >= 64 && second <= 127) return true;
  }
  // IPv6 unique-local fc00::/7, not globally routable
  const lower = normalized.toLowerCase();
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // 172.16.0.0, 172.31.255.255
  const second = Number(normalized.split(".")[1]);
  if (normalized.startsWith("172.") && Number.isInteger(second) && second >= 16 && second <= 31) {
    return true;
  }
  return false;
}

export async function resolveCoarseLocation(
  request: Request,
  readBlock?: IpBlockReader | null,
): Promise<CoarseLocation | CoarseUnavailable | null> {
  // An omitted reader means no GeoIP source (the server wrapper passes the
  // lazily-opened database explicitly); callers needing the database path go
  // through getCoarseLocation below.
  const reader = readBlock ?? null;
  const ip = clientIpFrom(request);

  // A local address carries no geography on ANY path, including the
  // Workers path, where dev workerd shims supply synthetic request.cf geo
  // for loopback traffic that would otherwise surface as "127.0.0.1".
  // Report WHY so the dev panel can explain itself instead of lying.
  if (ip && isLocalAddress(ip)) return { unavailable: "local-address", ip };

  // Cloudflare Workers path: cf geo rides on every incoming request. A cf
  // object without usable coordinates (some workerd/dev setups) falls through
  // to the IP path instead of disabling the tier.
  const cf = (request as Request & { cf?: CfCityGeo }).cf;
  if (cf) {
    const fromCf = coarseFromCf(cf);
    if (fromCf) return ip ? { ...fromCf, ip } : fromCf;
  }

  // Self-hosted path: resolve the client IP through GeoLite2.
  if (!ip || !reader) return null;
  try {
    const block = reader(ip);
    const fromMmdb = block ? coarseFromBlock(block) : null;
    return fromMmdb ? { ...fromMmdb, ip } : null;
  } catch (err) {
    logger.warn("CoarseLocationService: GeoLite2 lookup failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Coarse-location server function for the coarse-ip tier. Reads the
 * request (client headers and edge geo) from the Solid request event
 * and resolves through the lazily-opened GeoLite2 database.
 */
export async function getCoarseLocation(): Promise<CoarseLocation | CoarseUnavailable | null> {
  "use server";
  const event = getRequestEvent();
  if (!event) return null;
  return resolveCoarseLocation(event.request, await loadMmdbReader());
}
