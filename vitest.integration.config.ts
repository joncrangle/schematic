import { defineConfig } from "vitest/config";
import solidPlugin from "@solidjs/vite-plugin";
import { jsoncPlugin } from "./scripts/lib/jsonc-vite-plugin.ts";
import { agencySchematicsPlugin } from "./scripts/lib/agency-schematics-vite-plugin.ts";

// Opt-in integration tier: exercises temporary/in-memory SQLite and stubbed
// network boundaries. Run explicitly via `bun run test:integration`; excluded from
// the default unit run by vitest.config.ts.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      // Same `server-only` stub as the unit config (see vitest.config.ts).
      "server-only": new URL("./tests/helpers/server-only-stub.ts", import.meta.url).pathname,
    },
  },
  plugins: [jsoncPlugin(), agencySchematicsPlugin({ trimClientManifests: false }), solidPlugin({ refresh: false })],
  test: {
    environment: "node",
    globals: true,
    server: {
      deps: {
        inline: [/@tanstack/],
      },
    },
    include: ["tests/integration/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
  },
});
