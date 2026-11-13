import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_VAPID_SUBJECT,
  getFeedSecret,
  getGeoipDbPath,
  getNodeEnv,
  getVapidConfig,
} from "~/infrastructure/env/ServerEnv";
import { captureServerEnvChannels, setGlobalEnvChannel } from "../helpers/env-channels";

/**
 * Suite for the single server-env read seam: one module owns the
 * precedence chain exactly once — process.env first with empty-string skip,
 * then the globalThis.env bindings object as a documented test-simulation
 * channel. Relocated from tests/unit/test-push-service.test.ts when
 * devFlags.readServerEnv died.
 */

const touchedProcessVars = [
  "NODE_ENV",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",
  "GEOIP_DB_PATH",
  "FEED_METROLINX_API_KEY",
  "FEED_OC_TRANSPO_API_KEY",
  "FEED_ALERT_PROXY_BASE_URL",
  "FEED_ALERT_PROXY_TOKEN",
] as const;

const restoreEnvChannels = captureServerEnvChannels(touchedProcessVars);

/** Applies overrides and deletes every other touched var not listed. */
function setProcessEnv(overrides: Partial<Record<(typeof touchedProcessVars)[number], string>>) {
  for (const name of touchedProcessVars) {
    const value = overrides[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

afterEach(() => {
  restoreEnvChannels();
});

describe("getVapidConfig precedence (single owned chain)", () => {
  it("reads keys from process.env (Bun/Node/.env runtimes)", () => {
    setProcessEnv({ VAPID_PUBLIC_KEY: "pk-process", VAPID_PRIVATE_KEY: "sk-process" });
    setGlobalEnvChannel({ VAPID_PUBLIC_KEY: "pk-bindings", VAPID_PRIVATE_KEY: "sk-bindings" });

    expect(getVapidConfig()).toEqual({
      publicKey: "pk-process",
      privateKey: "sk-process",
      subject: DEFAULT_VAPID_SUBJECT,
    });
  });

  it("falls back to globalThis.env (Cloudflare bindings) when process.env lacks the key", () => {
    setProcessEnv({});
    setGlobalEnvChannel({ VAPID_PUBLIC_KEY: "pk-bindings", VAPID_PRIVATE_KEY: "sk-bindings" });

    expect(getVapidConfig()?.publicKey).toBe("pk-bindings");
  });

  it("skips empty-string process values and falls through to globalThis.env", () => {
    setProcessEnv({ VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "sk-bindings" });
    setGlobalEnvChannel({ VAPID_PUBLIC_KEY: "pk-bindings", VAPID_PRIVATE_KEY: "sk-bindings" });

    expect(getVapidConfig()?.publicKey).toBe("pk-bindings");
  });
});

describe("getVapidConfig configuration contract", () => {
  it.each([
    ["both keys are unset everywhere", {}],
    ["only the public key is set", { VAPID_PUBLIC_KEY: "pk" }],
    ["only the private key is set", { VAPID_PRIVATE_KEY: "sk" }],
    ["the public key is an empty string", { VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "sk" }],
    ["the private key is whitespace-only", { VAPID_PUBLIC_KEY: "pk", VAPID_PRIVATE_KEY: "   " }],
  ])("returns null when %s", (_name, procOverrides) => {
    setProcessEnv(procOverrides);
    setGlobalEnvChannel(undefined);

    expect(getVapidConfig()).toBeNull();
  });

  it("returns null instead of fabricating a default-subject config when keys are missing", () => {
    // Subject defaulting happens ONLY inside a configured result.
    setProcessEnv({});
    setGlobalEnvChannel(undefined);

    expect(getVapidConfig()).not.toEqual(
      expect.objectContaining({ subject: DEFAULT_VAPID_SUBJECT }),
    );
  });

  it("defaults the subject inside a configured result when VAPID_SUBJECT is unset", () => {
    setProcessEnv({ VAPID_PUBLIC_KEY: "pk", VAPID_PRIVATE_KEY: "sk" });
    setGlobalEnvChannel(undefined);

    expect(getVapidConfig()).toEqual({
      publicKey: "pk",
      privateKey: "sk",
      subject: DEFAULT_VAPID_SUBJECT,
    });
  });

  it("preserves an explicitly configured subject", () => {
    setProcessEnv({
      VAPID_PUBLIC_KEY: "pk",
      VAPID_PRIVATE_KEY: "sk",
      VAPID_SUBJECT: "mailto:ops@example.com",
    });
    setGlobalEnvChannel(undefined);

    expect(getVapidConfig()?.subject).toBe("mailto:ops@example.com");
  });

  it("trims surrounding whitespace from configured keys", () => {
    setProcessEnv({
      VAPID_PUBLIC_KEY: "  pk-trimmed  ",
      VAPID_PRIVATE_KEY: "\tsk-trimmed\n",
    });
    setGlobalEnvChannel(undefined);

    expect(getVapidConfig()).toMatchObject({
      publicKey: "pk-trimmed",
      privateKey: "sk-trimmed",
    });
  });
});

describe("getNodeEnv", () => {
  it("reads NODE_ENV from process.env", () => {
    setProcessEnv({ NODE_ENV: "production" });
    setGlobalEnvChannel(undefined);

    expect(getNodeEnv()).toBe("production");
  });

  it("falls back to the bindings channel for dev-status evaluation", () => {
    setProcessEnv({});
    setGlobalEnvChannel({ NODE_ENV: "production" });

    expect(getNodeEnv()).toBe("production");
  });

  it("returns undefined when neither runtime exposes NODE_ENV", () => {
    setProcessEnv({});
    setGlobalEnvChannel({});

    expect(getNodeEnv()).toBeUndefined();
  });
});

describe("getGeoipDbPath (silent-degrade preserved)", () => {
  it("returns null when GEOIP_DB_PATH is unset", () => {
    setProcessEnv({});
    setGlobalEnvChannel(undefined);

    expect(getGeoipDbPath()).toBeNull();
  });

  it("returns the trimmed path when configured", () => {
    setProcessEnv({ GEOIP_DB_PATH: "  /var/lib/GeoLite2-City.mmdb  " });
    setGlobalEnvChannel(undefined);

    expect(getGeoipDbPath()).toBe("/var/lib/GeoLite2-City.mmdb");
  });

  it("treats a whitespace-only path as unset", () => {
    setProcessEnv({ GEOIP_DB_PATH: "   " });
    setGlobalEnvChannel(undefined);

    expect(getGeoipDbPath()).toBeNull();
  });

  it("consults the bindings channel when process.env lacks the path", () => {
    setProcessEnv({});
    setGlobalEnvChannel({ GEOIP_DB_PATH: "/data/GeoLite2-City.mmdb" });

    expect(getGeoipDbPath()).toBe("/data/GeoLite2-City.mmdb");
  });
});

describe("getFeedSecret namespace", () => {
  it("reads feed secrets and refuses unrelated application secrets", () => {
    setProcessEnv({ VAPID_PRIVATE_KEY: "private-vapid", FEED_METROLINX_API_KEY: "feed-key" });
    setGlobalEnvChannel({
      FEED_ALERT_PROXY_TOKEN: "proxy-token",
      FEED_ALERT_PROXY_BASE_URL: "https://proxy.example.test",
    });

    expect(getFeedSecret("FEED_METROLINX_API_KEY")).toBe("feed-key");
    expect(getFeedSecret("FEED_ALERT_PROXY_TOKEN")).toBe("proxy-token");
    expect(getFeedSecret("FEED_ALERT_PROXY_BASE_URL")).toBe("https://proxy.example.test");
    expect(getFeedSecret("VAPID_PRIVATE_KEY")).toBeUndefined();
  });
});

describe("getFeedSecret", () => {
  it("reads secret from process.env", () => {
    setProcessEnv({ FEED_METROLINX_API_KEY: "secret-key-123" });
    setGlobalEnvChannel(undefined);

    expect(getFeedSecret("FEED_METROLINX_API_KEY")).toBe("secret-key-123");
  });

  it("trims surrounding whitespace from secret", () => {
    setProcessEnv({ FEED_METROLINX_API_KEY: "  trimmed-key  " });
    setGlobalEnvChannel(undefined);

    expect(getFeedSecret("FEED_METROLINX_API_KEY")).toBe("trimmed-key");
  });

  it("falls back to globalThis.env when unset in process.env", () => {
    setProcessEnv({});
    setGlobalEnvChannel({ FEED_METROLINX_API_KEY: "worker-secret" });

    expect(getFeedSecret("FEED_METROLINX_API_KEY")).toBe("worker-secret");
  });

  it("returns undefined when unset or whitespace-only", () => {
    setProcessEnv({ FEED_METROLINX_API_KEY: "   " });
    setGlobalEnvChannel(undefined);

    expect(getFeedSecret("FEED_METROLINX_API_KEY")).toBeUndefined();
    expect(getFeedSecret("NON_EXISTENT_KEY")).toBeUndefined();
  });
});
