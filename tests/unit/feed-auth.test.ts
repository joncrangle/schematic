import { describe, expect, it, vi } from "vitest";

import type { FeedAuth } from "~/agencies/types";
import {
  applyDevFeedProxy,
  applyFeedAuth,
  applyFeedFormat,
  redactFeedUrl,
} from "~/infrastructure/realtime/feedAuth";
import { getDevRequestOrigin } from "~/services/devRequestOrigin";

interface TestCase {
  name: string;
  url: string;
  auth: FeedAuth | undefined;
  getSecret: (name: string) => string | undefined;
  init?: RequestInit;
  expectedUrl: string;
  expectedHeaders?: Record<string, string>;
}

describe("applyFeedAuth", () => {
  it.each<TestCase>([
    {
      name: "returns url and init untouched when auth is undefined",
      url: "https://api.example.com/feed",
      auth: undefined,
      getSecret: () => "secret-value",
      init: { headers: { Accept: "application/x-protobuf" } },
      expectedUrl: "https://api.example.com/feed",
      expectedHeaders: { Accept: "application/x-protobuf" },
    },
    {
      name: "returns url and init untouched when auth type is none",
      url: "https://api.example.com/feed",
      auth: { type: "none" },
      getSecret: () => "secret-value",
      init: undefined,
      expectedUrl: "https://api.example.com/feed",
      expectedHeaders: undefined,
    },
    {
      name: "attaches header when header auth secret is resolved",
      url: "https://api.example.com/feed",
      auth: { type: "header", headerName: "X-API-Key", secretName: "FEED_METROLINX_API_KEY" },
      getSecret: (name: string) => (name === "FEED_METROLINX_API_KEY" ? "secret-123" : undefined),
      init: { headers: { "User-Agent": "Schematic/1.0" } },
      expectedUrl: "https://api.example.com/feed",
      expectedHeaders: { "User-Agent": "Schematic/1.0", "X-API-Key": "secret-123" },
    },
    {
      name: "omits header when header auth secret is not found",
      url: "https://api.example.com/feed",
      auth: { type: "header", headerName: "X-API-Key", secretName: "FEED_METROLINX_API_KEY" },
      getSecret: () => undefined,
      init: { headers: { "User-Agent": "Schematic/1.0" } },
      expectedUrl: "https://api.example.com/feed",
      expectedHeaders: { "User-Agent": "Schematic/1.0" },
    },
    {
      name: "appends query parameter when query_param auth secret is resolved",
      url: "https://api.example.com/feed?format=json",
      auth: { type: "query_param", parameterName: "api_key", secretName: "FEED_KEY" },
      getSecret: (name: string) => (name === "FEED_KEY" ? "abc-xyz" : undefined),
      init: undefined,
      expectedUrl: "https://api.example.com/feed?format=json&api_key=abc-xyz",
      expectedHeaders: undefined,
    },
    {
      name: "leaves url untouched when query_param auth secret is not found",
      url: "https://api.example.com/feed?format=json",
      auth: { type: "query_param", parameterName: "api_key", secretName: "FEED_KEY" },
      getSecret: () => undefined,
      init: undefined,
      expectedUrl: "https://api.example.com/feed?format=json",
      expectedHeaders: undefined,
    },
  ])("$name", ({ url, auth, getSecret, init, expectedUrl, expectedHeaders }) => {
    const result = applyFeedAuth(url, auth as FeedAuth, { getSecret, init });
    expect(result.url).toBe(expectedUrl);
    const headers = Object.fromEntries(
      [...new Headers(result.init.headers).entries()].map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    );
    const normalizedExpectedHeaders = Object.fromEntries(
      Object.entries(expectedHeaders ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
    );
    expect(headers).toEqual(normalizedExpectedHeaders);
  });

  it("does not resolve a secret whose name is outside the feed namespace", () => {
    const getSecret = vi.fn(() => "vapid-private-value");
    const result = applyFeedAuth(
      "https://api.example.com/feed",
      {
        type: "header",
        headerName: "X-API-Key",
        secretName: "VAPID_PRIVATE_KEY",
      },
      { getSecret },
    );

    expect(getSecret).not.toHaveBeenCalled();
    expect(new Headers(result.init.headers).has("X-API-Key")).toBe(false);
  });
});

describe("applyFeedFormat", () => {
  it.each([
    ["protobuf", "application/x-protobuf"],
    ["json", "application/json"],
  ] as const)("requests the %s media type", (format, expected) => {
    const init = applyFeedFormat(format, { headers: { "X-Test": "preserved" } });
    const headers = new Headers(init.headers);

    expect(headers.get("Accept")).toBe(expected);
    expect(headers.get("X-Test")).toBe("preserved");
  });

  it("overrides the protobuf default with application/octet-stream", () => {
    const init = applyFeedFormat("protobuf", {
      init: { headers: { "X-Test": "preserved" } },
      accept: "application/octet-stream",
    });
    const headers = new Headers(init.headers);

    expect(headers.get("Accept")).toBe("application/octet-stream");
    expect(headers.get("X-Test")).toBe("preserved");
  });

  it("requests text/plain for a protobuf feed compatibility override", () => {
    const init = applyFeedFormat("protobuf", { accept: "text/plain" });
    const headers = new Headers(init.headers);

    expect(headers.get("Accept")).toBe("text/plain");
  });

  it("requests application/protocol-buffer for a protobuf feed compatibility override", () => {
    const init = applyFeedFormat("protobuf", { accept: "application/protocol-buffer" });
    const headers = new Headers(init.headers);

    expect(headers.get("Accept")).toBe("application/protocol-buffer");
  });

  it("sends an explicit wildcard Accept override for protobuf feeds", () => {
    const init = applyFeedFormat("protobuf", { accept: "*/*" });
    expect(new Headers(init.headers).get("Accept")).toBe("*/*");
  });
});

describe("applyDevFeedProxy", () => {
  it("preserves the authenticated upstream path and query behind the local proxy", () => {
    expect(
      applyDevFeedProxy(
        "https://api.example.com/OpenDataAPI/feed?key=secret",
        "/__dev/upstream/example",
        "http://localhost:3000",
      ),
    ).toBe("http://localhost:3000/__dev/upstream/example/OpenDataAPI/feed?key=secret");
  });

  it("leaves the upstream URL unchanged without a complete proxy context", () => {
    const url = "https://api.example.com/feed";
    expect(applyDevFeedProxy(url, "/__dev/upstream/example", undefined)).toBe(url);
    expect(applyDevFeedProxy(url, undefined, "http://localhost:3000")).toBe(url);
  });
});

describe("redactFeedUrl", () => {
  it("removes URL credentials and a manifest-defined query secret", () => {
    expect(
      redactFeedUrl("https://user:password@api.example.test/feed?credential=secret&page=2", {
        type: "query_param",
        parameterName: "credential",
        secretName: "FEED_SECRET",
      }),
    ).toBe("https://api.example.test/feed?credential=%5Bredacted%5D&page=2");
  });

  it("removes credential values from diagnostic URLs", () => {
    expect(redactFeedUrl("https://api.example.test/feed?key=secret&format=proto")).toBe(
      "https://api.example.test/feed?key=%5Bredacted%5D&format=proto",
    );
  });
});

describe("dev request origin", () => {
  it("remains importable from the client module graph without server-only dependencies", () => {
    expect(getDevRequestOrigin()).toBeUndefined();
  });
});

it("signs a UTC minute with private feed secrets and redacts both query credentials", async () => {
  const { applyFeedAuthRequest } = await import("~/infrastructure/realtime/feedAuth");
  const auth: FeedAuth = {
    type: "custom",
    scheme: "sha256-minute",
    keySecretName: "FEED_PUBLIC_KEY",
    secretName: "FEED_SIGNING_SECRET",
    keyParameter: "key",
    signatureParameter: "hash",
  };
  const request = await applyFeedAuthRequest("https://example.test/feed?file=trip", auth, {
    now: () => Date.parse("2026-11-10T14:01:59Z"),
    getSecret: (n) => (n === "FEED_PUBLIC_KEY" ? "fictional-key" : "fictional-secret"),
  });
  const params = new URL(request.url).searchParams;
  expect(params.get("key")).toBe("fictional-key");
  expect(params.get("hash")).toBe(
    "E031B201A7A877788CE062FD7333074A54B5CC61448ABB7825DD5671ADDBF2D5",
  );
  expect(redactFeedUrl(request.url, auth)).not.toContain(params.get("hash")!);
  await expect(
    applyFeedAuthRequest("https://example.test/feed", auth, { getSecret: () => undefined }),
  ).rejects.toThrow("Missing signed feed credentials");
});
