/**
 * Save/restore fixture for the two server-env channels: process.env and the
 * globalThis.env bindings object (the documented test-simulation channel on
 * src/infrastructure/env/ServerEnv.ts). Suites that install fake
 * configurations capture once at module scope and restore in afterEach so
 * tests never leak configuration into each other.
 */

const globalWithEnv = globalThis as { env?: Record<string, string | undefined> };

/** Deletes the named vars from process.env and unsets the bindings channel. */
export function clearServerEnvChannels(varNames: readonly string[]): void {
  for (const name of varNames) delete process.env[name];
  globalWithEnv.env = undefined;
}

/** Installs (or unsets) a whole bindings-channel object. */
export function setGlobalEnvChannel(env: Record<string, string | undefined> | undefined): void {
  globalWithEnv.env = env;
}

/**
 * Captures current process values for `varNames` plus the bindings channel.
 * Returns a restore callback to register in afterEach.
 */
export function captureServerEnvChannels(varNames: readonly string[]): () => void {
  const savedProcessVars = new Map<string, string | undefined>(
    varNames.map((name) => [name, process.env[name]]),
  );
  const originalGlobalEnv = globalWithEnv.env;

  return () => {
    for (const [name, saved] of savedProcessVars) {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
    globalWithEnv.env = originalGlobalEnv;
  };
}
