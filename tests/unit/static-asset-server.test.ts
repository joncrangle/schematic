import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStaticAsset } from "~/services/StaticAssetServer";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("reads the same generated assets in Node development without a database or Worker binding", async () => {
  const root = mkdtempSync(join(tmpdir(), "static-asset-server-"));
  try {
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.stubGlobal("env", undefined);
    const path = "/generated/gtfs-schedules/sample/" + "a".repeat(64) + ".json";
    mkdirSync(join(root, "public/generated/gtfs-schedules/sample"), { recursive: true });
    writeFileSync(join(root, "public" + path), '{"version":1}');
    const response = await readStaticAsset(path, new AbortController().signal);
    expect(await response.json()).toEqual({ version: 1 });
    await expect(
      readStaticAsset("/generated/../.env", new AbortController().signal),
    ).rejects.toThrow("Invalid static asset path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("prefers the Worker asset binding and cancels already-aborted reads before fetching", async () => {
  const fetch = vi.fn(async () => new Response("asset"));
  vi.stubGlobal("env", { ASSETS: { fetch } });
  const path = "/generated/gtfs-schedules/sample/" + "a".repeat(64) + ".json";
  expect(await (await readStaticAsset(path, new AbortController().signal)).text()).toBe("asset");
  const controller = new AbortController();
  controller.abort();
  await expect(readStaticAsset(path, controller.signal)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});
