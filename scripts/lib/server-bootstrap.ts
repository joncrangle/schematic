export type ServerFetch = (request: Request, ...args: unknown[]) => Response | Promise<Response>;

export interface CompiledServer {
  readonly fetch: ServerFetch;
  readonly initSchedulers: () => void;
}

export interface BunRuntime {
  serve(options: { fetch: ServerFetch; port: number; hostname: string }): unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Validate the default export emitted by the worker build. */
export function requireCompiledServer(
  module: unknown,
  entryPath = "dist/worker/index.js",
): CompiledServer {
  const app = isRecord(module) ? module.default : undefined;
  if (!isRecord(app)) {
    throw new Error(`Compiled server entry "${entryPath}" has no default server export.`);
  }
  if (typeof app.fetch !== "function") {
    throw new Error(`Compiled server entry "${entryPath}" is missing its fetch handler.`);
  }
  if (typeof app.initSchedulers !== "function") {
    throw new Error(
      `Compiled server entry "${entryPath}" is missing initSchedulers(); rebuild with ` +
        "`bun run build` before starting the self-hosted server.",
    );
  }

  return {
    fetch: app.fetch as ServerFetch,
    initSchedulers: app.initSchedulers as () => void,
  };
}

/** Load and validate the generated worker entry without hiding startup errors. */
export async function loadCompiledServer(
  loadModule: () => Promise<unknown>,
  entryPath = "dist/worker/index.js",
): Promise<CompiledServer> {
  let module: unknown;
  try {
    module = await loadModule();
  } catch (cause) {
    throw new Error(
      `Unable to load compiled server entry "${entryPath}"; run ` +
        "`bun run build` before `bun run start`.",
      { cause },
    );
  }
  return requireCompiledServer(module, entryPath);
}

/** Initialize schedulers before handing the compiled fetch handler to Bun. */
export function startBunServer(
  app: CompiledServer,
  bun: BunRuntime,
  env: Readonly<Record<string, string | undefined>>,
): unknown {
  app.initSchedulers();
  return bun.serve({
    fetch: app.fetch,
    port: Number(env.PORT ?? 3000),
    hostname: env.HOST ?? "0.0.0.0",
  });
}
