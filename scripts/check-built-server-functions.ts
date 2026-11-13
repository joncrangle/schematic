#!/usr/bin/env bun
/**
 * Smoke-check the built Worker against the client server-function manifest,
 * which the Solid plugin moves from the client build into the Worker output.
 *
 * Usage:
 *   bun run check:worker-functions
 *
 * Sends malformed JSON to a client-advertised function ID. The handler must
 * recognize the ID and reject its body, without invoking the function. A
 * random ID is the control and must receive the unknown-function response.
 */
import { readFile } from "node:fs/promises";
import process from "node:process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { UNKNOWN_HEADER } from "@solidjs/web/server-functions/server";

interface WorkerFetch {
  readonly fetch: (request: Request) => Response | Promise<Response>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasFetch(value: unknown): value is WorkerFetch {
  return isRecord(value) && typeof value.fetch === "function";
}

function getFunctionIds(manifest: unknown): string[] {
  if (!isRecord(manifest) || !Array.isArray(manifest.functions)) return [];
  return manifest.functions.flatMap((entry) =>
    isRecord(entry) && typeof entry.id === "string" ? [entry.id] : [],
  );
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "dist/worker/.vite/solid-server-functions.json");
const workerPath = join(root, "dist/worker/index.js");

try {
  const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  const [functionId] = getFunctionIds(manifest);
  if (!functionId) {
    throw new Error(`No server-function IDs found in ${manifestPath}; run bun run build first.`);
  }

  const workerModule = await import(pathToFileURL(workerPath).href);
  if (!hasFetch(workerModule.default)) {
    throw new Error(`Built Worker ${workerPath} has no default fetch handler.`);
  }

  const origin = "http://worker-smoke.invalid";
  const makeRequest = (id: string) =>
    new Request(`${origin}/_server/${id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-server-function-format": "8",
        origin,
        referer: `${origin}/`,
      },
      // Invalid JSON proves route registration before function code runs.
      body: "{",
    });

  const known = await workerModule.default.fetch(makeRequest(functionId));
  if (known.status !== 400 || known.headers.get(UNKNOWN_HEADER) === "true") {
    throw new Error(
      `Client-advertised server function was not recognized by the Worker ` +
        `(status ${known.status}, unknown=${known.headers.get(UNKNOWN_HEADER)}).`,
    );
  }

  const unknown = await workerModule.default.fetch(
    makeRequest(`worker-smoke-unknown-${crypto.randomUUID()}`),
  );
  if (unknown.status !== 404 || unknown.headers.get(UNKNOWN_HEADER) !== "true") {
    throw new Error(
      `Unknown server-function control was not rejected ` +
        `(status ${unknown.status}, unknown=${unknown.headers.get(UNKNOWN_HEADER)}).`,
    );
  }

  console.log(
    "check:worker-functions: built Worker recognizes client IDs and rejects an unknown control.",
  );
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown error";
  console.error(`check:worker-functions: ${message}`);
  process.exitCode = 1;
}
