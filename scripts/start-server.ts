/**
 * Self-hosted production bootstrap. The Worker entrypoint must remain inert on
 * import, so Bun calls the scheduler hook explicitly before serving requests.
 */
import { loadCompiledServer, startBunServer, type BunRuntime } from "./lib/server-bootstrap";

const app = await loadCompiledServer(
  // The worker bundle is generated during the build and intentionally has
  // no checked-in declaration file.
  // @ts-expect-error generated worker bundle
  () => import("../dist/worker/index.js"),
);

const bun = (globalThis as typeof globalThis & { Bun: BunRuntime }).Bun;
startBunServer(app, bun, process.env);
