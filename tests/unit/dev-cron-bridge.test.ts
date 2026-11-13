import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createDevCronBridge, DEV_ALERT_CRON_INTERVAL_MS } from "../../scripts/lib/dev-cron-bridge";

function makeServer(options: { listening?: boolean } = {}) {
  const httpServer = new EventEmitter() as EventEmitter & {
    address: () => { port: number };
    listening: boolean;
  };
  httpServer.listening = options.listening ?? false;
  httpServer.address = () => ({ port: 4310 });

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  };
  const server = {
    httpServer,
    resolvedUrls: { local: ["http://127.0.0.1:4310/"], network: [] },
    config: {
      logger,
      server: { host: true, https: false, port: 4310 },
    },
  };

  return { httpServer, logger, server };
}

function successfulResponse(): Response {
  return new Response(null, { status: 204 });
}

function configure(plugin: ReturnType<typeof createDevCronBridge>, server: unknown): void {
  const hook = plugin.configureServer;
  if (typeof hook !== "function") throw new Error("dev cron bridge has no server hook");
  (hook as unknown as (server: unknown) => void)(server);
}

describe("Vite dev cron bridge", () => {
  it("fires the local scheduled handler immediately and at the configured interval", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(successfulResponse());
    const { httpServer, server } = makeServer();
    const plugin = createDevCronBridge({ fetch, intervalMs: 1_000 });

    configure(plugin, server);
    httpServer.listening = true;
    httpServer.emit("listening");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    const requestUrl = new URL(fetch.mock.calls[0]![0] as string);
    expect(requestUrl.pathname).toBe("/cdn-cgi/handler/scheduled");
    expect(requestUrl.searchParams.get("cron")).toBe("* * * * *");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch).toHaveBeenCalledTimes(2);

    httpServer.emit("close");
    vi.useRealTimers();
  });

  it("does not overlap requests and stops ticking when the dev server closes", async () => {
    vi.useFakeTimers();
    let resolveRequest!: (response: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );
    const { httpServer, server } = makeServer();
    const plugin = createDevCronBridge({ fetch, intervalMs: 1_000 });

    configure(plugin, server);
    httpServer.listening = true;
    httpServer.emit("listening");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetch).toHaveBeenCalledTimes(1);

    resolveRequest(successfulResponse());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    httpServer.emit("close");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetch).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("starts immediately when Vite has already begun listening", () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(successfulResponse());
    const { logger, server } = makeServer({ listening: true });
    const plugin = createDevCronBridge({ fetch });

    configure(plugin, server);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      `[dev-cron] alert evaluation bridge active (${Math.round(DEV_ALERT_CRON_INTERVAL_MS / 1000)}s interval)`,
    );
    server.httpServer?.emit("close");
  });
});
