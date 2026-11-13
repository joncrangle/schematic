import { defineConfig, loadEnv, type Plugin } from "vite";
import solid from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { cloudflare } from "@cloudflare/vite-plugin";
import { createDevCronBridge } from "./scripts/lib/dev-cron-bridge.ts";
import { createDevFeedProxies } from "./scripts/lib/dev-feed-proxies.ts";
import { jsoncPlugin } from "./scripts/lib/jsonc-vite-plugin.ts";
import { agencySchematicsPlugin } from "./scripts/lib/agency-schematics-vite-plugin.ts";

function cliPort(): number | undefined {
  const args = process.argv.slice(2);
  const flagIndex = args.findIndex((arg) => arg === "--port");
  const value =
    flagIndex >= 0 ? args[flagIndex + 1] : args.find((arg) => arg.startsWith("--port="))?.slice(7);
  if (!value) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

const buildClientManifestBeforeWorker: Plugin = {
  name: "schematic:client-manifest-before-worker",
  buildApp: {
    order: "pre",
    async handler(builder) {
      const client = builder.environments.client;
      if (client && !client.isBuilt) await builder.build(client);
    },
  },
};

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // All chunks from this app build share one ordered catalog generation. Old
  // open pages retain their compiled value when they replay to a new worker.
  const appBuildGeneration = Date.now();
  if (command === "serve") {
    // Server code (middleware, /api, server functions, dev cron) runs in
    // this process, which never sees .env otherwise. Fill the gaps so
    // server reads resolve; real environment values always win. Nothing
    // here reaches the client, only VITE_ keys enter import.meta.env.
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
  // Default to standard HTTP for local development and LAN testing.
  // CLI environment variables take precedence over .env file.
  const httpsSetting = process.env.VITE_HTTPS ?? env.VITE_HTTPS;
  const isHttps = httpsSetting === "true";
  const portSetting = cliPort() ?? (Number(process.env.PORT ?? env.PORT) || 3000);

  return {
    define: {
      __SCHEMATIC_APP_BUILD_GENERATION__: JSON.stringify(appBuildGeneration),
      __SCHEMATIC_DEV_PROXY_ORIGIN__: JSON.stringify(
        `${isHttps ? "https" : "http"}://127.0.0.1:${portSetting}`,
      ),
    },
    resolve: { tsconfigPaths: true },
    server: {
      host: true,
      port: portSetting,
      // The Worker proxy origin is compiled from this same port. Do not let
      // Vite silently select another port and leave the Worker pointing at a
      // dead proxy endpoint.
      strictPort: true,
      // Transform the route shell before the first browser request. Without
      // this, Vite discovers the Solid module graph in a request
      // waterfall after the prerendered shell has already painted, which leaves the
      // page visibly loaded but non-interactive on slower devices/LAN links.
      warmup: {
        clientFiles: [
          "src/AppRoot.tsx",
          "src/Document.tsx",
          "src/routes/index.tsx",
          "src/components/nearby/NearbyPanel.tsx",
          "src/services/surface/SurfaceClient.ts",
          "src/services/StationsClient.ts",
        ],
        ssrFiles: ["src/AppRoot.tsx", "src/Document.tsx", "src/routes/index.tsx"],
      },
      proxy: {
        ...createDevFeedProxies(),
      },
    },
    // Keep Effect's split entrypoints in the initial dependency scan. Without
    // this, Vite discovers the transitive Effect modules while hydrating the
    // page and triggers a program reload on the first visit.
    optimizeDeps: {
      include: [
        "effect/Cause",
        "effect/Context",
        "effect/Data",
        "effect/Deferred",
        "effect/Effect",
        "effect/Exit",
        "effect/Fiber",
        "effect/Layer",
        "effect/Option",
        "effect/Ref",
        "effect/Schema",
      ],
    },
    environments: {
      client: {
        build: {
          rolldownOptions: {
            output: {
              // Solid's runtime, Effect, and tailwind-merge change far less often than
              // app code. Separate chunks keep their immutable /assets/* URLs
              // cached across deploys instead of re-downloading with every
              // agency or UI change.
              codeSplitting: {
                groups: [
                  // Keep the large, generated geography cached when only the
                  // overlay UI changes. It remains behind the overlay's lazy import.
                  {
                    name: "coverage-geography",
                    test: /components[\\/]network-coverage[\\/]generated[\\/]geography\.ts$/,
                  },
                  // Agency waves change only the registered agency data, and
                  // app releases rarely do; each keeps the other's chunk cached.
                  {
                    name: "agency-data",
                    test: /agency-browser-manifest:|virtual:agency-schematics|[\\/]agencies[\\/].*interchanges\.jsonc$/,
                  },
                  { name: "solid", test: /node_modules[\\/](?:solid-js|@solidjs)[\\/]/ },
                  { name: "effect", test: /node_modules[\\/]effect[\\/]/ },
                  { name: "tailwind-merge", test: /node_modules[\\/]tailwind-merge[\\/]/ },
                ],
              },
            },
          },
        },
      },
      worker: {
        build: {
          // The 500 kB default targets browser downloads. The Worker bundle is
          // bounded by Cloudflare's script size limit (3 MB gzipped on Free);
          // checking that budget against minified size leaves ample headroom.
          chunkSizeWarningLimit: 3000,
        },
      },
    },
    plugins: [
      buildClientManifestBeforeWorker,
      jsoncPlugin(),
      agencySchematicsPlugin(),
      ...(isHttps ? [basicSsl()] : []),
      tailwindcss(),
      solid({
        start: {
          app: "./src/AppRoot.tsx",
          middleware: "./src/middleware.ts",
        },
        ssr: false,
        serverFunctions: true,
      }),
      cloudflare({ viteEnvironment: { name: "worker" } }),
      ...(command === "serve" ? [createDevCronBridge()] : []),
    ],
  };
});
