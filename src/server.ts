import handler from "virtual:solid-ssr-handler";
import {
  handleScheduledEvent,
  initSchedulers as initAlertSchedulers,
} from "~/services/notifications/ProductionScheduler";
import { startSelfHostedSurfaceSync } from "~/services/surface/SurfaceTopologyScheduler";

// Scheduler startup is explicit through the exported initSchedulers hook, so
// importing this fetch/cron entrypoint has no timer side effects.

/**
 * Publishes the worker environment (vars, secrets, bindings) to the
 * `globalThis.env` channel that ServerEnv and RuntimeBindings resolve
 * through. Cloudflare delivers vars/secrets exclusively via the handler's
 * `env` argument, `.env` is loaded automatically in dev, dashboard
 * secrets/vars in production, and neither ever appears in `process.env`,
 * so without this bridge every secret resolves empty under workerd while
 * Bun/Node work (native `.env`). Skipped under Bun, where `process.env`
 * already carries everything and the extra arg is Bun's server object.
 * Values are isolate-static (no per-request variation), so the shared slot
 * cannot leak one request's state into another.
 */
function publishWorkerEnv(hostArgs: readonly unknown[]): void {
  if ("Bun" in globalThis) return;
  const [env] = hostArgs;
  if (env !== null && typeof env === "object") {
    (globalThis as { env?: unknown }).env = env;
  }
}

// Self-hosted static-file seam ("Option A"): under Bun, GET/HEAD requests are
// answered from a build-once allowlist of the dist/client tree before falling
// through to `handler.fetch`, which keeps ownership of every miss and 404.
// Under workerd `"Bun" in globalThis` can never fire (Cloudflare Workers
// Assets serves statics at the edge), so production behavior is byte-for-byte
// unchanged: the bundler may inline the helper module into the worker bundle,
// but none of its code ever executes there.
async function fetchWithStaticAssets(request: Request, ...hostArgs: unknown[]): Promise<Response> {
  publishWorkerEnv(hostArgs);
  if ("Bun" in globalThis && (request.method === "GET" || request.method === "HEAD")) {
    const { getStaticAssetIndex, resolveStaticAsset, respondWithStaticAsset } =
      await import("~/server-static-assets");
    const resolution = resolveStaticAsset(request, await getStaticAssetIndex());
    if (resolution) return respondWithStaticAsset(resolution);
  }
  // Host runtimes pass extra positional args past `handler.fetch`'s declared
  // `(request, opts?)` signature (Workers `env`/`ctx`, Bun's server object);
  // forwarding them unchanged keeps this drop-in identical to the previous
  // bare `fetch: handler.fetch` export.
  return (
    handler.fetch as (
      forwardedRequest: Request,
      ...forwardedHostArgs: unknown[]
    ) => Promise<Response>
  )(request, ...hostArgs);
}

// Custom Workers entrypoint for Solid 2 start mode: the framework's fetch
// handler (virtual:solid-ssr-handler) serves the middleware chain (including
// /api/*) and the /_server endpoint; cron triggers attach alongside it.
// Wrangler's `main` must point at this file.
export default {
  fetch: fetchWithStaticAssets,
  scheduled: (
    ...args: Parameters<typeof handleScheduledEvent>
  ): ReturnType<typeof handleScheduledEvent> => {
    publishWorkerEnv(args.slice(1));
    return handleScheduledEvent(...args);
  },
  // The Bun entrypoint calls this explicitly. It is deliberately a property
  // rather than a module-level call so Workers imports remain inert.
  initSchedulers: () => {
    initAlertSchedulers();
    startSelfHostedSurfaceSync();
  },
};
