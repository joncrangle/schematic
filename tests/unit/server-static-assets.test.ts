import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStaticAssetAllowlist,
  findStaticRoot,
  getStaticAssetIndex,
  resolveStaticAsset,
} from "../../src/server-static-assets";

/**
 * Self-hosted static-file serving seam (src/server-static-assets.ts).
 *
 * src/server.ts keeps scheduler startup explicit and must never be imported by
 * these asset-focused unit tests, so these pins target its extracted seam: the pure
 * allowlist builder (`buildStaticAssetAllowlist`), the request resolver
 * (`resolveStaticAsset`), the memoized index loader (`getStaticAssetIndex`),
 * the bundler-layout-independent static-root discovery walk (`findStaticRoot`)
 * against REAL fixture files on disk. Everything runs unconditionally on
 * vitest/node — no Bun required.
 */

const JS_BYTES = "export const subwayLines = 4;\n";
const CSS_BYTES = "body { color: red; }\n";
const SHELL_BYTES = "<!DOCTYPE html><html></html>\n";

let fixtureRoot: string;
let allowlist: ReadonlyMap<string, string>;

function get(pathname: string): Request {
  return new Request(`https://ttc.example${pathname}`, { method: "GET" });
}

async function serveBytes(resolution: { absoluteFilePath: string }): Promise<string> {
  return readFile(resolution.absoluteFilePath, "utf8");
}

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "ttc-static-seam-"));
  await mkdir(join(fixtureRoot, "assets"), { recursive: true });
  await mkdir(join(fixtureRoot, "nested", "dir"), { recursive: true });
  await writeFile(join(fixtureRoot, "assets", "chunk-B1oNz7.js"), JS_BYTES);
  await writeFile(join(fixtureRoot, "assets", "styles-H4sh.css"), CSS_BYTES);
  await writeFile(join(fixtureRoot, "sw.js"), "// service worker\n");
  await writeFile(join(fixtureRoot, "index.html"), SHELL_BYTES);
  await writeFile(join(fixtureRoot, "site.webmanifest"), "{}\n");
  await writeFile(join(fixtureRoot, "nested", "dir", "icon.svg"), "<svg/>\n");
  allowlist = buildStaticAssetAllowlist(fixtureRoot, [
    "assets/chunk-B1oNz7.js",
    "assets/styles-H4sh.css",
    "sw.js",
    "index.html",
    "site.webmanifest",
    "nested/dir/icon.svg",
  ]);
});

afterAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe("static asset seam resolution", () => {
  it("resolves an existing asset to its exact fixture bytes, GET- and HEAD-equivalently", async () => {
    const jsHit = resolveStaticAsset(get("/assets/chunk-B1oNz7.js"), allowlist);
    expect(jsHit).toBeDefined();
    await expect(serveBytes(jsHit!)).resolves.toBe(JS_BYTES);

    const cssHit = resolveStaticAsset(get("/assets/styles-H4sh.css"), allowlist);
    expect(cssHit).toBeDefined();
    await expect(serveBytes(cssHit!)).resolves.toBe(CSS_BYTES);

    const headHit = resolveStaticAsset(
      new Request("https://ttc.example/assets/chunk-B1oNz7.js", { method: "HEAD" }),
      allowlist,
    );
    expect(headHit?.absoluteFilePath).toBe(jsHit!.absoluteFilePath);
  });

  it("never serves anything for encoded traversal attempts — outside-root bytes stay unreachable", () => {
    const traversal = resolveStaticAsset(get("/assets/%2e%2e/%2e%2e/etc/passwd"), allowlist);
    expect(traversal).toBeUndefined();

    // The allowlist is built from a real scan of the root, so every servable
    // value provably lives inside it — there is no request-time path math.
    for (const filePath of allowlist.values()) {
      expect(filePath.startsWith(fixtureRoot)).toBe(true);
    }
  });

  it("declines non-GET/HEAD methods even when the path exists", () => {
    const url = "https://ttc.example/assets/chunk-B1oNz7.js";

    expect(resolveStaticAsset(new Request(url, { method: "POST" }), allowlist)).toBeUndefined();
    expect(resolveStaticAsset(new Request(url, { method: "PUT" }), allowlist)).toBeUndefined();
    // Contrast within the same fact: the same path IS servable via GET.
    expect(resolveStaticAsset(new Request(url, { method: "GET" }), allowlist)).toBeDefined();
  });

  it("falls through instead of throwing on malformed percent-encoding", () => {
    // decodeURIComponent('/%E0%A4%A') throws URIError; the seam must not.
    expect(resolveStaticAsset(get("/%E0%A4%A"), allowlist)).toBeUndefined();
  });

  it("matches NFC request pathnames against NFD filenames as stored by APFS/HFS+", async () => {
    // macOS writes composed-looking names as NFD ('e' + U+0301); browsers
    // request the precomposed NFC form percent-encoded.
    await writeFile(join(fixtureRoot, "cafe\u0301.svg"), "<svg/>\n");
    const nfdAllowlist = buildStaticAssetAllowlist(fixtureRoot, ["caf\u00E9.svg"]);

    const hit = resolveStaticAsset(get("/caf%C3%A9.svg"), nfdAllowlist); // NFC 'é'
    expect(hit?.pathname).toBe("/caf\u00E9.svg");
  });

  it("marks /sw.js no-cache so the service worker always revalidates", () => {
    const hit = resolveStaticAsset(get("/sw.js"), allowlist);
    expect(hit?.cacheControl).toBe("no-cache");
  });

  it("marks hashed /assets/*.js responses immutable with year-long max-age", () => {
    const hit = resolveStaticAsset(get("/assets/chunk-B1oNz7.js"), allowlist);
    expect(hit?.cacheControl).toBe("public, max-age=31536000, immutable");
  });

  it("ignores query strings when looking up assets", () => {
    const bare = resolveStaticAsset(get("/assets/chunk-B1oNz7.js"), allowlist);
    const withQuery = resolveStaticAsset(get("/assets/chunk-B1oNz7.js?v=42"), allowlist);
    expect(withQuery?.absoluteFilePath).toBe(bare!.absoluteFilePath);
  });

  it("falls through to SSR for application routes like /lines", () => {
    expect(resolveStaticAsset(get("/lines"), allowlist)).toBeUndefined();
  });

  it("serves the prerendered shell for / and revalidates it", async () => {
    const hit = resolveStaticAsset(get("/"), allowlist);
    expect(hit?.pathname).toBe("/index.html");
    await expect(serveBytes(hit!)).resolves.toBe(SHELL_BYTES);
    expect(hit?.cacheControl).toBe("no-cache");
  });
});

describe("static asset index memo", () => {
  it("retries a failed scan on the next request instead of caching the failure", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let attempts = 0;
    const failingThenWorking = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("static root not mounted yet");
      return new Map([["/sw.js", join(fixtureRoot, "sw.js")]]);
    };

    await expect(getStaticAssetIndex(failingThenWorking)).resolves.toEqual(new Map());
    await expect(getStaticAssetIndex(failingThenWorking)).resolves.toEqual(
      new Map([["/sw.js", join(fixtureRoot, "sw.js")]]),
    );
    expect(attempts).toBe(2);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });
});

describe("static root discovery", () => {
  const nodeHasFiles = async (directory: string) =>
    (await readdir(directory).catch(() => [] as string[])).length > 0;

  it("walks up past bundler chunk locations to the nearest non-empty client bundle", async () => {
    // Emission layout belongs to the bundler: this module may land beside
    // index.js or hashed inside assets/. Discovery must survive both.
    await mkdir(join(fixtureRoot, "client"), { recursive: true });
    await writeFile(join(fixtureRoot, "client", "index.html"), "<html></html>\n");
    const moduleUrl = `file://${join(fixtureRoot, "dist/server/assets/chunk-B1oNz7.js")}`;

    await expect(findStaticRoot(moduleUrl, nodeHasFiles)).resolves.toBe(`${fixtureRoot}/client/`);
  });

  it("skips empty client directories on the way to the real bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "ttc-static-empty-"));
    try {
      await mkdir(join(root, "decoy", "client"), { recursive: true });
      await mkdir(join(root, "real", "client"), { recursive: true });
      await writeFile(join(root, "real", "client", "sw.js"), "// sw\n");
      const moduleUrl = `file://${join(root, "real/dist/server/assets/chunk.js")}`;

      await expect(findStaticRoot(moduleUrl, nodeHasFiles)).resolves.toBe(`${root}/real/client/`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("throws once no non-empty client bundle exists above the module", async () => {
    const emptyRoot = await mkdtemp(join(tmpdir(), "ttc-static-miss-"));
    try {
      const moduleUrl = `file://${join(emptyRoot, "a/b/module.js")}`;
      await expect(findStaticRoot(moduleUrl, nodeHasFiles)).rejects.toThrow("could not locate");
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });
});
