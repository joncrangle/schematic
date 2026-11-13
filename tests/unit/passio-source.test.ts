import { describe, expect, it, vi } from "vitest";
import {
  decodePassioEtas,
  fetchPassioArrivals,
} from "../../src/infrastructure/realtime/passio/passioSource";
const now = Date.parse("2026-11-12T15:00:00Z");
const row = {
  busId: 8,
  tripId: "t",
  routeId: "pattern",
  etaUtc: now / 1000 + 120,
  created: "2026-11-12 09:00:00",
  outdated: 0,
  OOS: 0,
  error: null,
  theStop: { stopId: "s" },
};
describe("Passio estimates", () => {
  it("joins a live trip pattern to its public route using the response stop identity", () => {
    expect(
      decodePassioEtas({ ETAs: { s: [row] } }, { pattern: "1" }, "America/Chicago", now),
    ).toMatchObject([
      { tripId: "t", routeId: "1", stopId: "s", predictedTime: now + 120000, isRealtime: true },
    ]);
  });
  it.each([
    { error: ["No valid GPS"] },
    { outdated: 1 },
    { created: "2026-11-12 08:00:00" },
    { OOS: 1 },
  ])("excludes unusable GPS estimates %j", (patch) => {
    expect(
      decodePassioEtas(
        { ETAs: { s: [{ ...row, ...patch }] } },
        { pattern: "1" },
        "America/Chicago",
        now,
      ),
    ).toEqual([]);
  });
  it("fails an incomplete board", () => {
    expect(() => decodePassioEtas({ solidETAfailed: true }, {}, "America/Chicago", now)).toThrow();
  });
});

describe("Passio stop reads", () => {
  const feed = {
    kind: "passio" as const,
    format: "json" as const,
    url: "https://passio.example.test/board",
    userId: "1",
    timeZone: "America/Chicago",
    routeMap: { pattern: "1", board: "1" },
    stopRoutes: { s: ["pattern", "board"] },
  };
  it("requests the current stop board across trip patterns and deduplicates responses", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const query = new URL(String(url));
      return new Response(
        JSON.stringify(
          query.searchParams.has("routeId")
            ? { ETAs: { s: [{ solidEta: {} }] } }
            : { ETAs: { s: [row, row] } },
        ),
      );
    });
    const result = await fetchPassioArrivals(feed, {
      fetch,
      now: () => now,
      stopIds: new Set(["s"]),
    });
    expect(result).toMatchObject({ partial: false, arrivals: [{ routeId: "1", stopId: "s" }] });
    expect(result.arrivals).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("fails a stale nonempty board instead of clearing previous predictions", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ETAs: { s: [{ ...row, created: "2026-11-12 08:00:00" }] } })),
    );
    await expect(
      fetchPassioArrivals(
        { ...feed, url: "https://passio.example.test/stale" },
        { fetch, now: () => now },
      ),
    ).rejects.toThrow();
  });
});
