// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { type CoarseLocation, type CoarseUnavailable } from "../../src/lib/location-source";
import { type CfCityGeo } from "../../src/services/CoarseLocationService";

/**
 * Coarse-location resolution for the coarse-ip tier.
 *
 * The resolver is a pure function of the incoming Request plus an injectable
 * mmdb reader, so both hosting targets are covered without network or disk:
 * - Cloudflare Workers: request.cf carries geo fields (city-level).
 * - Self-hosted (Bun/Docker): request.cf is absent; fall back to a GeoLite2
 *   lookup of the client IP taken from proxy headers.
 * Both paths may be unavailable (no cf, no IP, unknown IP, no database), in
 * which case the resolver yields null and callers stay on their current tier.
 */

interface CityBlock {
  location?: { latitude?: number; longitude?: number };
  city?: { names?: { en?: string } };
}

function requestWithCf(cf: CfCityGeo, ip?: string): Request {
  const req = new Request("https://ttc.test/");
  Object.assign(req, { cf });
  if (ip !== undefined) req.headers.set("cf-connecting-ip", ip);
  return req as Request;
}

function requestWithHeaders(headers: Record<string, string>): Request {
  return new Request("https://ttc.test/", { headers });
}

const TORONTO_BLOCK: CityBlock = {
  location: { latitude: 43.6532, longitude: -79.3832 },
  city: { names: { en: "Toronto" } },
};

/** Narrows the resolver's union to its fix shape for property assertions. */
function asCoarse(result: CoarseLocation | CoarseUnavailable | null): CoarseLocation {
  if (!result || "unavailable" in result) {
    throw new Error(`expected a coarse fix, got ${JSON.stringify(result)}`);
  }
  return result;
}

describe("resolveCoarseLocation (Cloudflare Workers path)", () => {
  it("maps request.cf geo fields to a CoarseLocation, carrying the client IP", async () => {
    const { resolveCoarseLocation } = await import("../../src/services/CoarseLocationService");
    const coarse = asCoarse(
      await resolveCoarseLocation(
        requestWithCf({ city: "Toronto", latitude: "43.65", longitude: "-79.38" }, "1.2.3.4"),
      ),
    );
    expect(coarse.latitude).toBeCloseTo(43.65, 5);
    expect(coarse.longitude).toBeCloseTo(-79.38, 5);
    expect(coarse.city).toBe("Toronto");
    expect(coarse.source).toBe("cloudflare");
    expect(coarse.ip).toBe("1.2.3.4");
  });

  it("returns null when request.cf lacks coordinates and no client IP is present", async () => {
    const { resolveCoarseLocation } = await import("../../src/services/CoarseLocationService");
    const result = await resolveCoarseLocation(requestWithCf({ city: "Toronto" }));
    expect(result).toBeNull();
  });

  it("falls back to the mmdb path when request.cf lacks coordinates but an IP exists", async () => {
    const { resolveCoarseLocation } = await import("../../src/services/CoarseLocationService");
    const result = await resolveCoarseLocation(
      requestWithCf({ city: "Toronto" }, "1.2.3.4"),
      () => TORONTO_BLOCK,
    );
    const coarse = asCoarse(result);
    expect(coarse.source).toBe("mmdb");
    expect(coarse.latitude).toBeCloseTo(43.6532, 5);
  });

  it("prefers request.cf over the mmdb fallback", async () => {
    const { resolveCoarseLocation } = await import("../../src/services/CoarseLocationService");
    let readerCalls = 0;
    const result = await resolveCoarseLocation(
      requestWithCf({ city: "Toronto", latitude: "43.65", longitude: "-79.38" }, "1.2.3.4"),
      () => {
        readerCalls += 1;
        return TORONTO_BLOCK;
      },
    );
    expect(asCoarse(result).source).toBe("cloudflare");
    expect(readerCalls).toBe(0);
  });

  it("reports local-address instead of a fix even when request.cf carries geo (dev workerd shim)", async () => {
    const { resolveCoarseLocation } = await import("../../src/services/CoarseLocationService");
    const result = await resolveCoarseLocation(
      // Miniflare/workerd dev supplies synthetic cf geo for loopback traffic —
      // without this guard the panel surfaced "127.0.0.1 · Toronto".
      requestWithCf({ city: "Toronto", latitude: "43.65", longitude: "-79.38" }, "127.0.0.1"),
      () => TORONTO_BLOCK,
    );
    expect(result).toEqual({ unavailable: "local-address", ip: "127.0.0.1" });
  });
});

describe("resolveCoarseLocation (self-hosted mmdb path)", () => {
  it("resolves the client IP through the reader into a CoarseLocation", async () => {
    const { resolveCoarseLocation } = await import("../../src/services/CoarseLocationService");
    const result = await resolveCoarseLocation(
      requestWithHeaders({ "cf-connecting-ip": "1.2.3.4" }),
      () => TORONTO_BLOCK,
    );
    expect(result).not.toBeNull();
    const coarse = asCoarse(result);
    expect(coarse.latitude).toBeCloseTo(43.6532, 5);
    expect(coarse.city).toBe("Toronto");
    expect(coarse.source).toBe("mmdb");
    expect(coarse.ip).toBe("1.2.3.4");
  });

  it("takes the last hop from a multi-entry X-Forwarded-For header (nearest-trust)", async () => {
    const { resolveCoarseLocation } = await import("../../src/services/CoarseLocationService");
    const seen: string[] = [];
    await resolveCoarseLocation(
      requestWithHeaders({ "x-forwarded-for": "9.9.9.9, 1.2.3.4" }),
      (ip) => {
        seen.push(ip);
        return TORONTO_BLOCK;
      },
    );
    expect(seen).toEqual(["1.2.3.4"]);
  });

  it("prefers cf-connecting-ip over x-forwarded-for", async () => {
    const { resolveCoarseLocation } = await import("../../src/services/CoarseLocationService");
    const seen: string[] = [];
    await resolveCoarseLocation(
      requestWithHeaders({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" }),
      (ip) => {
        seen.push(ip);
        return TORONTO_BLOCK;
      },
    );
    expect(seen).toEqual(["1.2.3.4"]);
  });

  it("returns null when no client IP headers are present", async () => {
    const { resolveCoarseLocation } = await import("../../src/services/CoarseLocationService");
    const result = await resolveCoarseLocation(requestWithHeaders({}), () => TORONTO_BLOCK);
    expect(result).toBeNull();
  });

  it("returns null when the reader has no block for the IP", async () => {
    const { resolveCoarseLocation } = await import("../../src/services/CoarseLocationService");
    const result = await resolveCoarseLocation(
      requestWithHeaders({ "cf-connecting-ip": "1.2.3.4" }),
      () => null,
    );
    expect(result).toBeNull();
  });

  it("returns null when the reader has no coordinates for the IP", async () => {
    const { resolveCoarseLocation } = await import("../../src/services/CoarseLocationService");
    const result = await resolveCoarseLocation(
      requestWithHeaders({ "cf-connecting-ip": "1.2.3.4" }),
      () => ({ city: { names: { en: "Nowhere" } } }),
    );
    expect(result).toBeNull();
  });

  it("returns null instead of throwing when the reader fails", async () => {
    const { resolveCoarseLocation } = await import("../../src/services/CoarseLocationService");
    const result = await resolveCoarseLocation(
      requestWithHeaders({ "cf-connecting-ip": "1.2.3.4" }),
      () => {
        throw new Error("corrupt database");
      },
    );
    expect(result).toBeNull();
  });

  it.each([
    "127.0.0.1",
    "10.0.0.5",
    "172.16.4.9",
    "192.168.1.20",
    "169.254.7.7",
    "100.64.0.1", // CGNAT
    "fd00::5", // IPv6 unique-local
    "::1",
    "::ffff:127.0.0.1",
  ])("treats %s as a local address and reports why instead of a fix", async (localIp) => {
    const { resolveCoarseLocation } = await import("../../src/services/CoarseLocationService");
    let readerCalls = 0;
    const result = await resolveCoarseLocation(
      requestWithHeaders({ "x-forwarded-for": localIp }),
      () => {
        readerCalls += 1;
        return TORONTO_BLOCK;
      },
    );
    expect(result).toEqual({ unavailable: "local-address", ip: localIp });
    expect(readerCalls).toBe(0);
  });
});
