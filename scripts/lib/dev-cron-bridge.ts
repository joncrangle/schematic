import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Plugin, ViteDevServer } from "vite";
import { ALERT_EVALUATION_CRON } from "../../src/domain/notifications/cron.ts";

export const DEV_ALERT_CRON_INTERVAL_MS = 60_000;

const SCHEDULED_HANDLER_PATH = "/cdn-cgi/handler/scheduled";

interface DevCronLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface DevCronBridgeOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly intervalMs?: number;
}

function resolveOrigin(server: ViteDevServer): string | null {
  const localUrl = server.resolvedUrls?.local[0];
  if (localUrl) return new URL(localUrl).origin;

  const address = server.httpServer?.address();
  if (address && typeof address !== "string") {
    const protocol = server.config.server.https ? "https" : "http";
    return `${protocol}://127.0.0.1:${address.port}`;
  }

  const port = server.config.server.port;
  if (!port) return null;

  const configuredHost = server.config.server.host;
  const host =
    typeof configuredHost === "string" && configuredHost !== "0.0.0.0" && configuredHost !== "::"
      ? configuredHost
      : "127.0.0.1";
  const protocol = server.config.server.https ? "https" : "http";
  return `${protocol}://${host}:${port}`;
}

function scheduledUrl(origin: string): string {
  const url = new URL(SCHEDULED_HANDLER_PATH, origin);
  url.searchParams.set("cron", ALERT_EVALUATION_CRON);
  return url.href;
}

/** Vite's basicSsl certificate is intentionally trusted only by the browser. */
function requestLocalDevServer(url: string, https: boolean): Promise<Response> {
  return new Promise((resolve, reject) => {
    const handleResponse = (response: IncomingMessage): void => {
      response.resume();
      resolve(new Response(null, { status: response.statusCode ?? 500 }));
    };
    const request: ClientRequest = https
      ? httpsRequest(url, { method: "GET", rejectUnauthorized: false }, handleResponse)
      : httpRequest(url, { method: "GET" }, handleResponse);
    request.once("error", reject);
    request.end();
  });
}

/**
 * Starts the local cron driver that Workerd does not provide during `vite dev`.
 *
 * The request goes through the dev server instead of running the evaluator in
 * the Vite host process. That keeps the evaluation inside the same Workerd
 * isolate and local D1 bindings as the browser's subscription writes.
 */
export function createDevCronBridge(options: DevCronBridgeOptions = {}): Plugin {
  const intervalMs = options.intervalMs ?? DEV_ALERT_CRON_INTERVAL_MS;

  return {
    name: "schematic-dev-cron-bridge",
    apply: "serve",
    configureServer(server) {
      const logger = server.config.logger as DevCronLogger;
      const httpServer = server.httpServer;
      if (!httpServer) {
        logger.warn("[dev-cron] unavailable because Vite has no HTTP server");
        return;
      }

      const fetchImpl =
        options.fetch ??
        ((url: string) => requestLocalDevServer(url, Boolean(server.config.server.https)));
      let timer: ReturnType<typeof setInterval> | null = null;
      let inFlight: Promise<void> | null = null;

      const trigger = (): void => {
        if (inFlight) return;

        const origin = resolveOrigin(server);
        if (!origin) {
          logger.warn("[dev-cron] unable to resolve the Vite dev-server URL");
          return;
        }

        const url = scheduledUrl(origin);
        inFlight = fetchImpl(url)
          .then((response) => {
            if (!response.ok) {
              logger.warn(`[dev-cron] scheduled handler returned HTTP ${response.status}`);
            }
          })
          .catch((cause) => {
            logger.warn(`[dev-cron] scheduled handler request failed: ${String(cause)}`);
          })
          .finally(() => {
            inFlight = null;
          });
      };

      const start = (): void => {
        if (timer !== null) return;

        logger.info(
          `[dev-cron] alert evaluation bridge active (${Math.round(intervalMs / 1000)}s interval)`,
        );
        trigger();
        timer = setInterval(trigger, intervalMs);
      };

      const stop = (): void => {
        if (timer === null) return;
        clearInterval(timer);
        timer = null;
        logger.info("[dev-cron] alert evaluation bridge stopped");
      };

      httpServer.once("close", stop);
      if (httpServer.listening) {
        start();
      } else {
        httpServer.once("listening", start);
      }
    },
  };
}
