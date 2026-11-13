import "server-only";
import { MAX_STATIC_ASSET_BYTES } from "~/infrastructure/staticAssets/versionedAssetReference";
import { createVersionedAssetCache } from "~/infrastructure/staticAssets/versionedAssetCache";
export async function readStaticAsset(path: string, signal: AbortSignal): Promise<Response> {
  if (!/^\/generated\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+\.json$/.test(path))
    throw new Error("Invalid static asset path");
  signal.throwIfAborted();
  let assets = (globalThis as { env?: { ASSETS?: { fetch(request: Request): Promise<Response> } } })
    .env?.ASSETS;
  if (!assets) {
    try {
      const specifier = "cloudflare" + ":workers";
      const { env } = await import(/* @vite-ignore */ specifier);
      assets = env?.ASSETS;
    } catch {
      /* Bun reads the same files from its static asset index. */
    }
  }
  if (assets) return assets.fetch(new Request(`https://assets.internal${path}`, { signal }));
  const bun = (
    globalThis as { Bun?: { file(path: string): Blob & { exists(): Promise<boolean> } } }
  ).Bun;
  if (bun) {
    try {
      const { getStaticAssetIndex, resolveStaticAsset, respondWithStaticAsset } =
        await import("~/server-static-assets");
      const hit = resolveStaticAsset(
        new Request(`https://assets.internal${path}`),
        await getStaticAssetIndex(),
      );
      if (hit) return respondWithStaticAsset(hit);
    } catch {
      /* Unbuilt local tools read the same generated public assets. */
    }
    const file = bun.file(`public${path}`);
    if (await file.exists()) return new Response(file);
  }
  if (typeof process !== "undefined" && process.release?.name === "node") {
    const specifier = "node:" + "fs/promises";
    const fs = await import(/* @vite-ignore */ specifier);
    for (const root of import.meta.env.DEV ? ["public"] : ["dist/client", "public"]) {
      const file = `${process.cwd()}/${root}${path}`;
      try {
        const stat = await fs.stat(file);
        if (stat.size > MAX_STATIC_ASSET_BYTES) throw new Error("Oversized static data asset");
        signal.throwIfAborted();
        return new Response(await fs.readFile(file, { signal }));
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") throw error;
      }
    }
  }
  throw new Error("Static data assets unavailable");
}
export const staticAssetCache = createVersionedAssetCache({ readAsset: readStaticAsset });
