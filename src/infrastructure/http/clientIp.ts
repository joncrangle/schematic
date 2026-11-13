/**
 * Client IP for a request: `cf-connecting-ip` on Workers, otherwise the last
 * `x-forwarded-for` hop. Leftmost hops are client-forgeable; only the entry the
 * nearest reverse proxy appended is trusted. Null when neither header is set.
 */
export function clientIpFrom(request: Request): string | null {
  const cf = request.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  return lastForwardedHop(request);
}

function lastForwardedHop(request: Request): string | null {
  const hops = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return hops[hops.length - 1] ?? null;
}

/**
 * Client IP for rate limiting. Only Cloudflare sets `cf-connecting-ip`
 * authoritatively, and only on Workers (where `request.cf` exists); elsewhere a
 * caller could send it themselves, so self-hosted instances use the last
 * `x-forwarded-for` hop their reverse proxy appended.
 */
export function rateLimitClientIp(request: Request): string | null {
  if ("cf" in request && request.cf) return request.headers.get("cf-connecting-ip")?.trim() || null;
  return lastForwardedHop(request);
}

function parseIpv4(value: string): number[] | null {
  const octets = value.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) return null;
  const numbers = octets.map(Number);
  return numbers.every((octet) => octet <= 255) ? numbers : null;
}

function parseIpv6(value: string): number[] | null {
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string | undefined): number[] | null => {
    if (!part) return [];
    const result: number[] = [];
    const pieces = part.split(":");
    for (const [index, piece] of pieces.entries()) {
      if (index === pieces.length - 1 && piece.includes(".")) {
        const v4 = parseIpv4(piece);
        if (!v4) return null;
        result.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else if (/^[0-9a-f]{1,4}$/.test(piece)) {
        result.push(Number.parseInt(piece, 16));
      } else {
        return null;
      }
    }
    return result;
  };
  const head = groups(halves[0]);
  const tail = groups(halves[1]);
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  return missing >= 1 ? [...head, ...Array.from({ length: missing }, () => 0), ...tail] : null;
}

/**
 * Network a rate limit should key on: the IPv4 address, or the IPv6 /64 since
 * one subscriber usually controls a whole /64. Ports, brackets, and zone IDs
 * are ignored and IPv4-mapped IPv6 is treated as IPv4. Null when unparseable.
 */
export function clientNetworkKey(ip: string): string | null {
  let address = ip.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(address);
  if (bracketed) address = bracketed[1]!;
  else if (/^[\d.]+:\d+$/.test(address)) address = address.slice(0, address.lastIndexOf(":"));
  address = address.replace(/%.*$/, "");

  const v4 = parseIpv4(address);
  if (v4) return v4.join(".");
  const v6 = parseIpv6(address);
  if (!v6) return null;
  if (v6.slice(0, 5).every((group) => group === 0) && v6[5] === 0xffff)
    return [v6[6]! >> 8, v6[6]! & 0xff, v6[7]! >> 8, v6[7]! & 0xff].join(".");
  return `${v6
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}
