import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

interface BunBuildOutput {
  readonly kind: string;
  text(): Promise<string>;
}

interface BunBuildResult {
  readonly success: boolean;
  readonly outputs: readonly BunBuildOutput[];
  readonly logs: readonly unknown[];
}

declare const Bun: {
  build(options: {
    entrypoints: string[];
    outdir: string;
    naming: string;
  }): Promise<BunBuildResult>;
  write(path: string, data: string): Promise<number>;
};

const outputPath = "public/sw.js";
await mkdir(dirname(outputPath), { recursive: true });

const result = await Bun.build({
  entrypoints: ["src/sw.ts"],
  outdir: dirname(outputPath),
  naming: "[name].js",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exitCode = 1;
} else {
  const serviceWorker = result.outputs.find((output) => output.kind === "entry-point");
  if (!serviceWorker) throw new Error("Service worker build produced no entry point");
  const source = await serviceWorker.text();
  const buildGeneration = JSON.stringify(randomUUID());
  const generated = `const __SCHEMATIC_SW_BUILD_GENERATION__ = ${buildGeneration};\n${source}`;
  await Bun.write(outputPath, generated);
}
