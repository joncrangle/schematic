import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Recorded Tmix AnyRide wire fixtures, loaded from disk.
 *
 * No convention existed for this, so this is the one: `readFileSync` relative
 * to `import.meta.dirname`, wrapped once here so the test file reads as
 * behavior rather than as filesystem plumbing. The `unit-node` Vitest project
 * runs in a node environment, so this is available to `tests/unit/*.test.ts`
 * and must NOT be imported from a `*.dom.test.ts` file.
 */

const FIXTURE_DIR = join(import.meta.dirname, "tmix");

export function tmixFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}
