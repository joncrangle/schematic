import { defineConfig } from "vitest/config";
import solidPlugin from "@solidjs/vite-plugin";
import { jsoncPlugin } from "./scripts/lib/jsonc-vite-plugin.ts";
import { agencySchematicsPlugin } from "./scripts/lib/agency-schematics-vite-plugin.ts";

const domTestFiles = ["tests/unit/**/*.dom.test.{ts,tsx}"];

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      // The `server-only` boundary marker is compile-time only (production
      // builds fail when client code reaches it); resolve it to a
      // side-effect-free stub so server-only modules load for real under test.
      "server-only": new URL("./tests/helpers/server-only-stub.ts", import.meta.url).pathname,
    },
  },
  plugins: [jsoncPlugin(), agencySchematicsPlugin({ trimClientManifests: false }), solidPlugin({ refresh: false })],
  test: {
    environment: "happy-dom",
    fsModuleCache: true,
    globals: true,
    server: {
      deps: {
        inline: [/@tanstack/, /@solid-primitives/],
      },
    },
    projects: [
      {
        test: {
          name: "unit-node",
          include: ["tests/unit/**/*.test.{ts,tsx}"],
          exclude: domTestFiles,
          environment: "node",
        },
      },
      {
        test: {
          name: "unit-dom",
          include: domTestFiles,
          environment: "happy-dom",
        },
      },
    ],
  },
});
