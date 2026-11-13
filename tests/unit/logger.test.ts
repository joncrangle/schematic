import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Pins the logger's level resolution: runtime LOG_LEVEL ensures
 * wrangler vars.LOG_LEVEL goes live under nodejs_compat, and an
 * unrecognized value falls back to "info" instead of suppressing every level.
 * The logger is a module singleton, so each case re-imports through
 * vi.resetModules to get a fresh instance.
 */

const originalLogLevel = process.env.LOG_LEVEL;

function restoreEnv(name: string, saved: string | undefined) {
  if (saved === undefined) delete process.env[name];
  else process.env[name] = saved;
}

afterEach(() => {
  restoreEnv("LOG_LEVEL", originalLogLevel);
  vi.resetModules();
});

async function freshLoggerLevel(): Promise<string> {
  vi.resetModules();
  const { logger } = await import("~/infrastructure/logging/logger");
  return logger.getLevel();
}

describe("logger level resolution", () => {
  it("honors runtime LOG_LEVEL=debug so the wrangler var goes live", async () => {
    process.env.LOG_LEVEL = "debug";

    expect(await freshLoggerLevel()).toBe("debug");
  });

  it('falls back to info for an unrecognized level like "verbose"', async () => {
    process.env.LOG_LEVEL = "verbose";

    expect(await freshLoggerLevel()).toBe("info");
  });

  it("falls back to info when no level is configured anywhere", async () => {
    delete process.env.LOG_LEVEL;

    expect(await freshLoggerLevel()).toBe("info");
  });
});
