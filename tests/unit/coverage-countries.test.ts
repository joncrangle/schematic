import { afterEach, expect, it, vi } from "vitest";

const countries = { test: { id: "test", polygons: [] } };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("shares the country download across concurrent loads and reopening", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json(countries));
  vi.stubGlobal("fetch", fetch);
  const { loadCoverageCountries } = await import("~/components/network-coverage/coverageCountries");
  const [first, second] = await Promise.all([loadCoverageCountries(), loadCoverageCountries()]);
  expect(first).toEqual(countries);
  expect(second).toBe(first);
  expect(await loadCoverageCountries()).toBe(first);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("rejects a failed download and allows a later retry", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response("Unavailable", { status: 503 }))
    .mockResolvedValueOnce(Response.json(countries));
  vi.stubGlobal("fetch", fetch);
  const { loadCoverageCountries } = await import("~/components/network-coverage/coverageCountries");
  await expect(loadCoverageCountries()).rejects.toThrow("503");
  expect(await loadCoverageCountries()).toEqual(countries);
  expect(fetch).toHaveBeenCalledTimes(2);
});
