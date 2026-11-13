import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Agent as HttpsAgent } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createDevFeedProxies, DEV_FEED_PROXY_CIPHERS } from "../../scripts/lib/dev-feed-proxies";

describe("dev feed proxy cipher offer", () => {
  it("offers only ECDHE key exchange, including the cipher other hosts already negotiate", () => {
    expect(DEV_FEED_PROXY_CIPHERS).toContain("ECDHE-RSA-AES256-GCM-SHA384");
    for (const cipher of DEV_FEED_PROXY_CIPHERS.split(":")) {
      expect(cipher.startsWith("ECDHE")).toBe(true);
    }
  });
});

describe("createDevFeedProxies", () => {
  it("builds declared proxies with TLS validation and default plain-http handling", () => {
    const directory = mkdtempSync(join(tmpdir(), "dev-feed-proxies-"));
    try {
      mkdirSync(join(directory, "demo"), { recursive: true });
      writeFileSync(
        join(directory, "demo", "manifest.json"),
        JSON.stringify({
          realtime: {
            feeds: [
              { url: "https://feeds.example.com/gtfs", devProxyPrefix: "/__dev/upstream/secure" },
              { url: "http://feeds.example.com/gtfs", devProxyPrefix: "/__dev/upstream/plain" },
            ],
          },
        }),
      );

      const proxies = createDevFeedProxies(directory);

      expect(Object.keys(proxies).sort()).toEqual([
        "/__dev/upstream/plain",
        "/__dev/upstream/secure",
      ]);
      const secure = proxies["/__dev/upstream/secure"];
      expect(secure?.target).toBe("https://feeds.example.com");
      expect(secure?.changeOrigin).toBe(true);
      expect(secure?.secure).toBe(true);
      expect(secure?.agent).toBeInstanceOf(HttpsAgent);
      expect((secure?.agent as HttpsAgent).options.ciphers).toBe(DEV_FEED_PROXY_CIPHERS);
      expect(secure?.rewrite?.("/__dev/upstream/secure/gtfs")).toBe("/gtfs");
      expect(proxies["/__dev/upstream/plain"]?.agent).toBeUndefined();
      expect(proxies["/__dev/upstream/plain"]?.secure).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
