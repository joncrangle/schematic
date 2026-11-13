import "server-only";

import { logger } from "~/infrastructure/logging/logger";
import { getGeoipDbPath } from "~/infrastructure/env/ServerEnv";
import type { IpBlockReader } from "./CoarseLocationService";

// ---------------------------------------------------------------------------
// Server-only GeoIP reader.
//
// Lazily opens the GeoLite2 database once per isolate. Returns null when
// GEOIP_DB_PATH is unset or the file cannot be opened. Self-host operators
// without the database keep the coarse-ip tier disabled.
// ---------------------------------------------------------------------------

let mmdbReaderPromise: Promise<IpBlockReader | null> | null = null;

export function loadMmdbReader(): Promise<IpBlockReader | null> {
  if (!mmdbReaderPromise) {
    mmdbReaderPromise = (async () => {
      const dbPath = getGeoipDbPath();
      if (!dbPath) return null;
      try {
        const [{ Reader }, fs] = await Promise.all([import("mmdb-lib"), import("node:fs")]);
        const reader = new Reader(fs.readFileSync(dbPath));
        return (ip: string) => (reader.get(ip) ?? null) as ReturnType<IpBlockReader>;
      } catch (err) {
        logger.warn("CoarseLocationService: GeoLite2 database unavailable", {
          dbPath,
          err: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    })();
  }
  return mmdbReaderPromise;
}
