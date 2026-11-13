/**
 * Self-hosted static-file serving seam ("Option A").
 *
 * The start-mode server handler serves zero static files: under
 * self-hosted Bun/Docker every request would reach the app handler, which
 * rejects non-HTML Accepts with 500. This module gives `src/server.ts` a
 * traversal-proof, build-once allowlist over the Vite client output
 * (`dist/client`, sibling of the compiled `dist/server` bundle).
 *
 * The runtime gate (`"Bun" in globalThis`) lives in `src/server.ts`; under
 * workerd that gate can never fire, so although the bundler may inline this
 * module into the deployed worker bundle, none of its code ever runs there —
 * Workers Assets keeps serving statics at the edge with identical behavior.
 * Because the allowlist is built by scanning the real filesystem, request
 * handling does no path math at all, a pathname is servable iff it exactly
 * matches a scanned key, so directory listings and `..` traversal are
 * impossible by construction.
 *
 * Directory enumeration deliberately goes through `Bun.Glob`, never
 * `node:fs`: the workerd-targeted build rewrites `node:fs*` into unenv stubs
 * that throw at runtime, while Bun-native globals survive bundling untouched
 * (the same reason storage elects `bun:sqlite`). No `node:*` module is needed
 * at all, path joining is plain string concatenation over the "/"-separated
 * relative paths Bun's globber yields.
 */

/** Minimal structural view of the Bun globals this seam touches. */
interface BunLike {
  /** BunFile extends Blob (usable as a Response body) with existence checks. */
  file(path: string): Blob & { exists(): Promise<boolean> };
  Glob: new (pattern: string) => {
    scan(options: { cwd: string; onlyFiles?: boolean }): AsyncIterable<string>;
  };
}

/** One allowlist hit: the servable absolute path plus its cache policy. */
export interface StaticAssetResolution {
  /** Request pathname (NFC-normalized), exactly as matched against the allowlist. */
  readonly pathname: string;
  /** Absolute filesystem path inside the scanned static root. */
  readonly absoluteFilePath: string;
  /**
   * Cache-Control value the seam stamps on the response, when it owns one:
   * hashed `/assets/*` chunks are immutable; `/sw.js` must always revalidate
   * (ADR-0003 §4). Other static files intentionally carry no explicit header —
   * a documented acceptable gap for self-hosting.
   */
  readonly cacheControl?: string;
}

const INTERCEPTED_METHODS = new Set(["GET", "HEAD"]);

/**
 * Cache policy for a decoded pathname. `/assets/*` is content-hashed by Vite
 * (safe to cache forever); `/sw.js` must always revalidate per ADR-0003 §4;
 * `/index.html` (including `/`, which resolves to it) must revalidate so
 * deploys with new hashed chunk names take effect. Everything else gets no
 * explicit header from the seam.
 */
export function cacheControlFor(pathname: string): string | undefined {
  if (pathname.startsWith("/assets/")) {
    return "public, max-age=31536000, immutable";
  }
  if (pathname === "/sw.js" || pathname === "/index.html") {
    return "no-cache";
  }
  return undefined;
}

/**
 * Resolves a Request against an allowlist map (pathname -> absolute file
 * path). Returns undefined, meaning "fall through to the app handler", for
 * non-GET/HEAD methods, malformed percent-encoding, and allowlist misses. The
 * app handler therefore keeps ownership of 404s; the seam never emits one.
 *
 * The single-route shell is static by architecture (build-time prerender, no
 * per-request SSR): `/` answers with the prerendered `/index.html` bytes,
 * mirroring Workers Assets at the edge. Every other application route still
 * falls through to the handler.
 *
 * Allowlist keys are NFC-normalized pathnames (see buildStaticAssetAllowlist);
 * the decoded request pathname is normalized identically, so an NFD filename
 * as stored by APFS/HFS+ still matches the NFC form browsers send.
 *
 * Query strings never participate: URL.pathname excludes them.
 */
export function resolveStaticAsset(
  request: Request,
  assetPaths: ReadonlyMap<string, string>,
): StaticAssetResolution | undefined {
  if (!INTERCEPTED_METHODS.has(request.method)) return undefined;

  const { pathname } = new URL(request.url);
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(pathname).normalize("NFC");
  } catch {
    // Malformed percent-encoding is not ours to answer; let SSR handle it
    // instead of throwing out of the fetch pipeline.
    return undefined;
  }
  if (decodedPathname === "/") decodedPathname = "/index.html";

  const absoluteFilePath = assetPaths.get(decodedPathname);
  if (!absoluteFilePath) return undefined;

  return {
    pathname: decodedPathname,
    absoluteFilePath,
    cacheControl: cacheControlFor(decodedPathname),
  };
}

/**
 * Purely maps enumerated relative file paths ("/"-separated, as yielded by
 * Bun's globber) onto the servable allowlist shape: keys are "/"
 * -prefixed NFC-normalized pathnames with dotfile segments dropped (.vite
 * staging, .DS_Store); values are absolute paths joined onto `rootDir`.
 * Symlinks resolving to files are indexed like regular files, parity with a
 * dirent `isFile()` scan, and safe because container builds own the tree.
 */
export function buildStaticAssetAllowlist(
  rootDir: string,
  relativePaths: readonly string[],
): Map<string, string> {
  const base = rootDir.endsWith("/") ? rootDir : `${rootDir}/`;
  const assetPaths = new Map<string, string>();
  for (const relativePath of relativePaths) {
    if (relativePath.split("/").some((segment) => segment.startsWith("."))) continue;
    assetPaths.set(`/${relativePath.normalize("NFC")}`, `${base}${relativePath}`);
  }
  return assetPaths;
}

/**
 * Enumerates every file under `rootDir` via Bun's globber. `onlyFiles` skips
 * directories; Bun's glob already ignores leading-dot entries, and
 * buildStaticAssetAllowlist filters them again defensively. Bun-only: call
 * behind the `"Bun" in globalThis` gate in src/server.ts.
 */
export async function collectStaticAssetPaths(rootDir: string): Promise<string[]> {
  const { Glob } = (globalThis as { Bun?: BunLike }).Bun!;
  const relativePaths: string[] = [];
  for await (const relativePath of new Glob("**/*").scan({ cwd: rootDir, onlyFiles: true })) {
    relativePaths.push(relativePath.replaceAll("\\", "/"));
  }
  return relativePaths;
}

let staticAssetIndex: Promise<ReadonlyMap<string, string>> | null = null;

/**
 * Lazily scans the static root once per process and caches the resulting
 * allowlist promise (concurrent callers share the same scan; successful scans
 * are cached for the process lifetime). A failed scan answers the current
 * request with an empty allowlist, the app handler owns every route, but
 * clears the memo so the next gated request retries instead of being stuck
 * with the failure forever.
 */
export function getStaticAssetIndex(
  loadIndex: () => Promise<ReadonlyMap<string, string>> = loadStaticAssetIndex,
): Promise<ReadonlyMap<string, string>> {
  staticAssetIndex ??= loadIndex().catch((error) => {
    console.warn(
      "[static-assets] scan failed; serving via app handler until the next request retries",
      error,
    );
    staticAssetIndex = null;
    return new Map<string, string>();
  });
  return staticAssetIndex;
}

/** How many ancestor directories the static-root search walks before giving up. */
const MAX_ROOT_ANCESTORS = 8;

/**
 * Extracts the directory (trailing slash included) containing the module at
 * `moduleUrl`, wherever the bundler decided to emit it.
 */
function moduleDirectory(moduleUrl: string): string {
  const filePath = decodeURIComponent(new URL(moduleUrl).pathname);
  return filePath.slice(0, filePath.lastIndexOf("/") + 1);
}

/**
 * Parent directory of a trailing-slash directory path, or null once the
 * filesystem root is passed. Plain string math, no node:path needed.
 */
function parentDirectory(directory: string): string | null {
  const trimmed = directory.slice(0, -1);
  const cut = trimmed.lastIndexOf("/") + 1;
  if (cut === 0) return null;
  return trimmed.slice(0, cut);
}

/**
 * Locates the static root by walking up from wherever the bundler emitted
 * this module (inlined into `index.js` or hashed away in an assets chunk)
 * until a `client/` directory that enumerates non-empty shows up. A fixed
 * relative hop cannot work, emission layout belongs to the bundler, and no
 * filename marker can be assumed either: the Vite client output here ships
 * without an `index.html` shell. Nearest non-empty `client/` wins.
 *
 * Defaults to Bun's globber for the emptiness probe (everything here lives
 * behind the `"Bun" in globalThis` gate in src/server.ts); inject `hasFiles`
 * to exercise the walk on any runtime. Throws when nothing qualifies; the
 * caller's catch path warns and retries on the next request.
 */
export async function findStaticRoot(
  moduleUrl: string,
  hasFiles: (directory: string) => Promise<boolean> = async (directory) => {
    const { Glob } = (globalThis as { Bun?: BunLike }).Bun!;
    const scan = new Glob("*").scan({ cwd: directory, onlyFiles: true });
    try {
      const first = await scan[Symbol.asyncIterator]().next();
      return first.done !== true;
    } catch {
      // A missing or unscannable directory simply holds no servable files;
      // the walk continues upward instead of aborting the search.
      return false;
    }
  },
): Promise<string> {
  let directory: string | null = moduleDirectory(moduleUrl);
  for (let depth = 0; depth < MAX_ROOT_ANCESTORS && directory !== null; depth++) {
    const candidate = `${directory}client/`;
    if (await hasFiles(candidate)) return candidate;
    directory = parentDirectory(directory);
  }
  throw new Error(
    "[static-assets] could not locate the client bundle (no non-empty client/ above the compiled module)",
  );
}

async function loadStaticAssetIndex(): Promise<ReadonlyMap<string, string>> {
  const clientDir = await findStaticRoot(import.meta.url);
  return buildStaticAssetAllowlist(clientDir, await collectStaticAssetPaths(clientDir));
}

/**
 * Builds the Response for an allowlist hit via Bun.file, whose inference owns
 * Content-Type (.css/.js/.webmanifest/...). Only callable behind the
 * `"Bun" in globalThis` gate in src/server.ts.
 */
export function respondWithStaticAsset(resolution: StaticAssetResolution): Response {
  const { file } = (globalThis as { Bun?: BunLike }).Bun!;
  const headers = new Headers();
  if (resolution.cacheControl) {
    headers.set("cache-control", resolution.cacheControl);
  }
  // BunFile extends Blob, so Response picks up its inferred Content-Type.
  return new Response(file(resolution.absoluteFilePath), { headers });
}
