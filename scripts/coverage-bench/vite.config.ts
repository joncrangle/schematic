import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { jsoncPlugin } from "../lib/jsonc-vite-plugin.ts";
import { agencySchematicsPlugin } from "../lib/agency-schematics-vite-plugin.ts";

const root = resolve(import.meta.dirname, "../..");

/** Client-only build of the coverage overlay; server modules are stubbed out. */
export default defineConfig({
  root: import.meta.dirname,
  logLevel: "warn",
  resolve: { alias: { "~": resolve(root, "src") } },
  define: { __SCHEMATIC_APP_BUILD_GENERATION__: "1", __SCHEMATIC_DEV_PROXY_ORIGIN__: '""' },
  build: { outDir: resolve(import.meta.dirname, "dist"), emptyOutDir: true, target: "esnext" },
  plugins: [
    {
      name: "coverage-bench:stub-server-only",
      enforce: "pre",
      resolveId: (id) => (id === "server-only" ? "\0server-only" : null),
      load: (id) => (id === "\0server-only" ? "export {};" : null),
    },
    jsoncPlugin(),
    agencySchematicsPlugin(),
    tailwindcss(),
    solid({ ssr: false, serverFunctions: true }),
  ],
});
