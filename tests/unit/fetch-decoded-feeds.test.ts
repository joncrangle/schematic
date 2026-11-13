import {
  createCloudflareInvocationIo,
  InvocationBudgetExceeded,
} from "~/infrastructure/http/InvocationIo";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  conditionalCacheKey,
  DEFAULT_MAX_FEED_RESPONSE_BYTES,
  DEFAULT_USER_AGENT,
  fetchDecodedFeeds,
  isRetryableFeedStatus,
  MAX_FETCH_ATTEMPTS,
  retryDelayForAttempt,
  TransportFailure,
  type DecodedFeedRequest,
} from "~/infrastructure/realtime/fetchDecodedFeeds";
import { createFakeConditionalCache } from "../helpers/fake-conditional-cache";

type TestError = { readonly source: string; readonly message: string };

function request(
  url: string,
  overrides?: Partial<DecodedFeedRequest<string, TestError>>,
): DecodedFeedRequest<string, TestError> {
  return {
    url,
    format: "protobuf",
    decode: (body) => Effect.succeed(`decoded:${new TextDecoder().decode(body)}`),
    mapError: (cause) => ({
      source: url,
      message: cause instanceof Error ? cause.message : String(cause),
    }),
    ...overrides,
  };
}

function stubFetch(responses: Response[]): {
  fetch: typeof fetch;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const queue = [...responses];
  let lastResponse: Response | undefined;
  const fetch: typeof globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (next) {
      lastResponse = next;
      return next;
    }
    if (!lastResponse) throw new Error("No stub response configured");
    return new Response(null, {
      status: lastResponse.status,
      statusText: lastResponse.statusText,
      headers: lastResponse.headers,
    });
  }) as typeof fetch;
  return { fetch, calls };
}

const ok = (text: string): Response => new Response(text, { status: 200 });
const status = (code: number): Response => new Response("upstream", { status: code });

describe("fetchDecodedFeeds (shared ingestion kernel)", () => {
  it("collects usable feeds in input order and reports the first failure", async () => {
    const { fetch } = stubFetch([ok("a"), status(500), ok("c")]);
    const result = await Effect.runPromise(
      fetchDecodedFeeds(
        [
          request("https://feeds.example.test/a"),
          request("https://feeds.example.test/b"),
          request("https://feeds.example.test/c"),
        ],
        { fetch },
      ),
    );

    expect(result.usable).toEqual(["decoded:a", "decoded:c"]);
    expect(result.firstError?.source).toBe("https://feeds.example.test/b");
  });

  it("reports empty usable with the first error when every feed fails", async () => {
    const { fetch } = stubFetch([status(500)]);
    const result = await Effect.runPromise(
      fetchDecodedFeeds(
        [request("https://feeds.example.test/a"), request("https://feeds.example.test/b")],
        { fetch },
      ),
    );

    expect(result.usable).toEqual([]);
    expect(result.firstError?.source).toBe("https://feeds.example.test/a");
  });

  it("retries a retryable status and succeeds on the next attempt", async () => {
    const { fetch, calls } = stubFetch([status(500), ok("recovered")]);
    const result = await Effect.runPromise(
      fetchDecodedFeeds([request("https://feeds.example.test/a")], {
        fetch,
        attempts: 2,
        retryDelayMs: 0,
      }),
    );

    expect(result.usable).toEqual(["decoded:recovered"]);
    expect(result.firstError).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("never retries a 429 rate-limit, even with attempts remaining", async () => {
    const { fetch, calls } = stubFetch([status(429)]);
    const result = await Effect.runPromise(
      fetchDecodedFeeds([request("https://feeds.example.test/a")], {
        fetch,
        attempts: 3,
        retryDelayMs: 0,
      }),
    );

    expect(result.usable).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("caps attempts and jitters retry delays within the configured ceiling", async () => {
    const { fetch, calls } = stubFetch([status(500)]);
    await Effect.runPromise(
      fetchDecodedFeeds([request("https://feeds.example.test/a")], {
        fetch,
        attempts: 99,
        retryDelayMs: 0,
      }),
    );

    expect(calls).toHaveLength(MAX_FETCH_ATTEMPTS);
    expect(retryDelayForAttempt(0, 100, 1_000, () => 0)).toBe(50);
    expect(retryDelayForAttempt(0, 100, 1_000, () => 0.99)).toBe(99);
    expect(retryDelayForAttempt(9, 5_000, 1_000, () => 1)).toBe(1_000);
  });

  it("follows public feed redirects within the invocation request budget", async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/download")
        ? new Response(null, { status: 302, headers: { Location: "/current.pb" } })
        : new Response("current"),
    );
    const io = createCloudflareInvocationIo({ fetch: upstream as typeof fetch, limit: 2 });
    const result = await Effect.runPromise(
      fetchDecodedFeeds([request("https://feeds.example.test/download")], { fetch: io.fetch }),
    );
    expect(result.usable).toEqual(["decoded:current"]);
    expect(upstream).toHaveBeenCalledTimes(2);
    await expect(io.fetch("https://feeds.example.test/extra")).rejects.toBeInstanceOf(InvocationBudgetExceeded);
  });

  it("does not follow redirects for authenticated feed requests", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, {
        status: 302,
        headers: { Location: "https://redirect.example.test/collect" },
      });
    }) as typeof globalThis.fetch;

    const result = await Effect.runPromise(
      fetchDecodedFeeds(
        [
          request("https://feeds.example.test/authorized", {
            auth: { type: "header", headerName: "X-Feed-Key", secretName: "FEED_TEST_KEY" },
          }),
        ],
        { fetch, getSecret: () => "private-test-value", attempts: 3, retryDelayMs: 0 },
      ),
    );

    expect(result.usable).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.redirect).toBe("manual");
    expect(new Headers(calls[0]?.init?.headers).get("X-Feed-Key")).toBe("private-test-value");
    expect(calls.map((call) => call.url)).not.toContain("https://redirect.example.test/collect");
  });

  it("cancels a non-ok response body before returning the failure", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("private upstream body"));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 401 },
    );
    const fetch = vi.fn(async () => response) as typeof globalThis.fetch;

    const result = await Effect.runPromise(
      fetchDecodedFeeds([request("https://feeds.example.test/unauthorized")], { fetch }),
    );

    expect(result.usable).toEqual([]);
    expect(result.firstError?.message).toContain("HTTP 401");
    expect(cancelled).toBe(true);
  });

  it("cancels and rejects a response body larger than the bounded feed cap", async () => {
    let cancelled = false;
    const decode = vi.fn((bytes: Uint8Array) => Effect.succeed(String(bytes.byteLength)));
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(DEFAULT_MAX_FEED_RESPONSE_BYTES));
              controller.enqueue(new Uint8Array([1]));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    ) as typeof globalThis.fetch;

    const result = await Effect.runPromise(
      fetchDecodedFeeds([request("https://feeds.example.test/large", { decode })], { fetch }),
    );

    expect(result.usable).toEqual([]);
    expect(result.firstError?.message).toContain("exceeded");
    expect(decode).not.toHaveBeenCalled();
    expect(cancelled).toBe(true);
  });

  it("attempts once by default", async () => {
    const { fetch, calls } = stubFetch([status(500)]);
    await Effect.runPromise(
      fetchDecodedFeeds([request("https://feeds.example.test/a")], { fetch }),
    );

    expect(calls).toHaveLength(1);
  });

  it("aborts a hung upstream fetch and reports a timeout", async () => {
    let aborted = false;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      await new Promise<never>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error("test fetch did not receive an abort signal");
        const onAbort = () => {
          aborted = true;
          reject(new Error("aborted"));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
      throw new Error("unreachable");
    }) as unknown as typeof fetch;

    const result = await Effect.runPromise(
      fetchDecodedFeeds([request("https://feeds.example.test/hung")], {
        fetch: fetchImpl,
        timeoutMs: 10,
      }),
    );

    expect(aborted).toBe(true);
    expect(result.usable).toEqual([]);
    expect(result.firstError?.message).toContain("Timed out after 10ms");
  });

  it("routes decode failures through mapError without retrying", async () => {
    const { fetch, calls } = stubFetch([ok("bad-payload")]);
    const result = await Effect.runPromise(
      fetchDecodedFeeds(
        [
          request("https://feeds.example.test/a", {
            decode: () => Effect.fail(new Error("decode exploded")),
            mapError: () => ({ source: "decode", message: "mapped decode failure" }),
          }),
        ],
        { fetch, attempts: 3, retryDelayMs: 0 },
      ),
    );

    expect(result.usable).toEqual([]);
    expect(result.firstError).toEqual({ source: "decode", message: "mapped decode failure" });
    expect(calls).toHaveLength(1);
  });

  it("applies auth, format, and dev proxy before fetching", async () => {
    const { fetch, calls } = stubFetch([ok("a")]);
    await Effect.runPromise(
      fetchDecodedFeeds(
        [
          request("https://upstream.example.test/gtfs?key=secret-value", {
            auth: { type: "query_param", parameterName: "key", secretName: "FEED_KEY" },
            devProxyPrefix: "/feed-proxy",
          }),
        ],
        {
          fetch,
          getSecret: (name) => (name === "FEED_KEY" ? "secret-value" : undefined),
          devProxyOrigin: "https://proxy.example.test",
        },
      ),
    );

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe("https://proxy.example.test/feed-proxy/gtfs?key=secret-value");
    const headers = new Headers(call.init?.headers);
    expect(headers.get("Accept")).toBe("application/x-protobuf");
  });

  it("redacts secret query values from transport failure messages", async () => {
    const { fetch } = stubFetch([status(500)]);
    const result = await Effect.runPromise(
      fetchDecodedFeeds(
        [
          request("https://upstream.example.test/gtfs?key=secret-value", {
            auth: { type: "query_param", parameterName: "key", secretName: "FEED_KEY" },
          }),
        ],
        { fetch, getSecret: () => "secret-value" },
      ),
    );

    expect(result.firstError?.message).not.toContain("secret-value");
    expect(result.firstError?.message).toContain("key=");
  });

  it("uses an explicit compatible media type while preserving the default protobuf negotiation", async () => {
    const calls: { accept: string | null }[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const accept = new Headers(init?.headers).get("Accept");
      calls.push({ accept });
      return accept === "application/x-protobuf"
        ? new Response("unsupported", { status: 406 })
        : new Response("protobuf", { status: 200 });
    }) as typeof fetch;
    const compatibleRequest = {
      ...request("https://feeds.example.test/hamilton-compatible"),
      accept: "application/octet-stream" as const,
    };

    const result = await Effect.runPromise(
      fetchDecodedFeeds(
        [compatibleRequest, request("https://feeds.example.test/default-protobuf")],
        { fetch: fetchImpl },
      ),
    );

    expect(result.usable).toEqual(["decoded:protobuf"]);
    expect(result.firstError?.message).toContain("HTTP 406");
    expect(calls).toEqual(
      expect.arrayContaining([
        { accept: "application/octet-stream" },
        { accept: "application/x-protobuf" },
      ]),
    );
  });

  it("sends no Accept header when no format is declared", async () => {
    const { fetch, calls } = stubFetch([ok("a")]);
    await Effect.runPromise(
      fetchDecodedFeeds(
        [
          {
            url: "https://feeds.example.test/a",
            decode: (body) => Effect.succeed(new TextDecoder().decode(body)),
            mapError: (cause) => String(cause),
          },
        ],
        { fetch },
      ),
    );

    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.has("Accept")).toBe(false);
  });
  it("exposes the HTTP status to mapError for adapter diagnostics", async () => {
    const seen: unknown[] = [];
    const { fetch } = stubFetch([status(401)]);
    await Effect.runPromise(
      fetchDecodedFeeds(
        [
          request("https://feeds.example.test/a", {
            mapError: (cause) => {
              seen.push(cause);
              return { source: "x", message: "mapped" };
            },
          }),
        ],
        { fetch },
      ),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ status: 401 });
  });

  it.each([
    [408, true],
    [500, true],
    [503, true],
    [429, false],
    [404, false],
    [401, false],
  ])("retries status %s only when retryable (%s)", (statusCode, retryable) => {
    expect(isRetryableFeedStatus(statusCode)).toBe(retryable);
  });
});

describe("fetchDecodedFeeds (request method and body)", () => {
  it("sends a declared POST method to the injected fetch", async () => {
    const { fetch, calls } = stubFetch([ok("a")]);
    await Effect.runPromise(
      fetchDecodedFeeds([request("https://api.example.test/GetCalls", { method: "POST" })], {
        fetch,
      }),
    );

    expect(calls[0]?.init?.method).toBe("POST");
  });

  it("passes a declared body through to the fetch unchanged", async () => {
    const body = '{"query":{"fromStopAreaQuery":"MI2203"},"configuration":{"grouping":[]}}';
    const { fetch, calls } = stubFetch([ok("a")]);
    await Effect.runPromise(
      fetchDecodedFeeds([request("https://api.example.test/GetCalls", { method: "POST", body })], {
        fetch,
      }),
    );

    expect(calls[0]?.init?.body).toBe(body);
  });

  it("leaves method and body unset when a feed declares neither", async () => {
    const { fetch, calls } = stubFetch([ok("a")]);
    await Effect.runPromise(
      fetchDecodedFeeds([request("https://feeds.example.test/gtfs-rt")], { fetch }),
    );

    const init = calls[0]?.init ?? {};
    expect("method" in init).toBe(false);
    expect("body" in init).toBe(false);
  });

  it("tags a non-ok POST response with the same TransportFailure and status", async () => {
    const seen: unknown[] = [];
    const { fetch } = stubFetch([status(400)]);
    const result = await Effect.runPromise(
      fetchDecodedFeeds(
        [
          request("https://api.example.test/GetCalls", {
            method: "POST",
            body: "{}",
            mapError: (cause) => {
              seen.push(cause);
              return { source: "tmix", message: String(cause) };
            },
          }),
        ],
        { fetch },
      ),
    );

    expect(result.usable).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(TransportFailure);
    expect(seen[0]).toMatchObject({ status: 400 });
  });
});

describe("fetchDecodedFeeds (conditional fetch)", () => {
  const URL = "https://feeds.example.test/conditional";

  /** A programmed upstream: one response per poll, recording what it saw. */
  function scriptedUpstream(script: Response[]): {
    fetch: typeof fetch;
    sentValidators: (string | null)[];
  } {
    const queue = [...script];
    const sentValidators: (string | null)[] = [];
    const fetch: typeof globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      sentValidators.push(new Headers(init?.headers).get("If-None-Match"));
      const next = queue.shift();
      if (!next) throw new Error("upstream script exhausted");
      return next;
    }) as typeof fetch;
    return { fetch, sentValidators };
  }

  function decodedValue(text: string): { readonly text: string; readonly at: number } {
    return { text, at: -1 };
  }

  function conditionalTestRequest(
    decode: (bytes: Uint8Array) => Effect.Effect<{ text: string; at: number }, unknown>,
  ): DecodedFeedRequest<{ text: string; at: number }, TestError> {
    return {
      url: URL,
      cacheIdentity: "test-decoder-v1",
      decode,
      mapError: (cause) => ({
        source: URL,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
      onNotModified: (cached, reusedAt) => ({ ...cached, at: reusedAt }),
    };
  }

  it("reuses the cached value with zero decode work on 304 and refreshes the timestamp", async () => {
    const fake = createFakeConditionalCache();
    const nowRef = { now: 1_000 };
    const decode = vi.fn((bytes: Uint8Array) =>
      Effect.succeed(decodedValue(new TextDecoder().decode(bytes))),
    );
    const { fetch, sentValidators } = scriptedUpstream([
      new Response("v1", { status: 200, headers: { ETag: '"e1"' } }),
      new Response(null, { status: 304 }),
    ]);
    const poll = () =>
      Effect.runPromise(
        fetchDecodedFeeds([conditionalTestRequest(decode)], {
          fetch,
          conditionalStore: { cache: fake.cache, now: () => nowRef.now },
        }),
      );

    const first = await poll();
    expect(first.usable).toEqual([{ text: "v1", at: -1 }]);
    expect(decode).toHaveBeenCalledTimes(1);

    nowRef.now = 2_000;
    const second = await poll();

    expect(sentValidators).toEqual([null, '"e1"']);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(second.usable).toEqual([{ text: "v1", at: 2_000 }]);
  });

  it("revalidates with Last-Modified when the upstream sends no ETag", async () => {
    const fake = createFakeConditionalCache();
    const nowRef = { now: 1_000 };
    const seenSince: (string | null)[] = [];
    const decode = vi.fn((bytes: Uint8Array) =>
      Effect.succeed(decodedValue(new TextDecoder().decode(bytes))),
    );
    const fetch: typeof globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seenSince.push(new Headers(init?.headers).get("If-Modified-Since"));
      return seenSince.length === 1
        ? new Response("v1", {
            status: 200,
            headers: { "Last-Modified": "Sat, 29 Aug 2026 10:00:00 GMT" },
          })
        : new Response(null, { status: 304 });
    }) as typeof fetch;

    const poll = () =>
      Effect.runPromise(
        fetchDecodedFeeds([conditionalTestRequest(decode)], {
          fetch,
          conditionalStore: { cache: fake.cache, now: () => nowRef.now },
        }),
      );

    await poll();
    nowRef.now = 2_000;
    const second = await poll();

    expect(seenSince).toEqual([null, "Sat, 29 Aug 2026 10:00:00 GMT"]);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(second.usable).toEqual([{ text: "v1", at: 2_000 }]);
  });

  it("falls back to full fetch+decode when the upstream omits validators", async () => {
    const fake = createFakeConditionalCache();
    const sentNoneMatch: (string | null)[] = [];
    const decode = vi.fn((bytes: Uint8Array) =>
      Effect.succeed(decodedValue(new TextDecoder().decode(bytes))),
    );
    const fetch: typeof globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      sentNoneMatch.push(new Headers(init?.headers).get("If-None-Match"));
      return new Response("v1", { status: 200 });
    }) as typeof fetch;

    const poll = () =>
      Effect.runPromise(
        fetchDecodedFeeds([conditionalTestRequest(decode)], {
          fetch,
          conditionalStore: { cache: fake.cache, now: () => 1_000 },
        }),
      );

    const first = await poll();
    const second = await poll();

    expect(sentNoneMatch).toEqual([null, null]);
    expect(decode).toHaveBeenCalledTimes(2);
    expect(first.usable).toEqual(second.usable);
    expect(fake.storedUrls()).toHaveLength(1);
  });

  it("re-decodes byte-identically when the board changed and tracks the new validator", async () => {
    const fake = createFakeConditionalCache();
    const nowRef = { now: 1_000 };
    const decode = vi.fn((bytes: Uint8Array) =>
      Effect.succeed(decodedValue(new TextDecoder().decode(bytes))),
    );
    const { fetch, sentValidators } = scriptedUpstream([
      new Response("same-body", { status: 200, headers: { ETag: '"e1"' } }),
      new Response("same-body", { status: 200, headers: { ETag: '"e2"' } }),
      new Response(null, { status: 304 }),
    ]);
    const poll = () =>
      Effect.runPromise(
        fetchDecodedFeeds([conditionalTestRequest(decode)], {
          fetch,
          conditionalStore: { cache: fake.cache, now: () => nowRef.now },
        }),
      );

    const first = await poll();
    const second = await poll();
    expect(decode).toHaveBeenCalledTimes(2);
    expect(second.usable).toEqual(first.usable);

    nowRef.now = 2_000;
    const third = await poll();
    expect(sentValidators).toEqual([null, '"e1"', '"e2"']);
    expect(decode).toHaveBeenCalledTimes(2);
    expect(third.usable).toEqual([{ text: "same-body", at: 2_000 }]);
  });

  it("treats a corrupt cache entry as a miss and heals it on the next 200", async () => {
    const fake = createFakeConditionalCache();
    const key = await conditionalCacheKey(
      URL,
      new Headers({ "User-Agent": DEFAULT_USER_AGENT }),
      "test-decoder-v1",
    );
    await fake.cache.put(key, new Response("not json{{"));
    const decode = vi.fn((bytes: Uint8Array) =>
      Effect.succeed(decodedValue(new TextDecoder().decode(bytes))),
    );
    const { fetch, sentValidators } = scriptedUpstream([
      new Response("v1", { status: 200, headers: { ETag: '"e1"' } }),
      new Response(null, { status: 304 }),
    ]);
    const poll = () =>
      Effect.runPromise(
        fetchDecodedFeeds([conditionalTestRequest(decode)], {
          fetch,
          conditionalStore: { cache: fake.cache, now: () => 1_000 },
        }),
      );

    const first = await poll();
    expect(first.usable).toEqual([{ text: "v1", at: -1 }]);
    expect(sentValidators).toEqual([null]);

    const second = await poll();
    expect(sentValidators).toEqual([null, '"e1"']);
    expect(second.usable).toEqual([{ text: "v1", at: 1_000 }]);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it("leaves declared POST requests unconditional", async () => {
    const fake = createFakeConditionalCache();
    const sentNoneMatch: (string | null)[] = [];
    const decode = vi.fn((bytes: Uint8Array) =>
      Effect.succeed(decodedValue(new TextDecoder().decode(bytes))),
    );
    const fetch: typeof globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      sentNoneMatch.push(new Headers(init?.headers).get("If-None-Match"));
      return new Response("v1", { status: 200, headers: { ETag: '"e1"' } });
    }) as typeof fetch;

    const poll = () =>
      Effect.runPromise(
        fetchDecodedFeeds([conditionalTestRequest(decode)], {
          fetch,
          conditionalStore: { cache: fake.cache, now: () => 1_000 },
        }),
      );
    // The shared kernel narrows GETs only: the leading GET stores its entry,
    // and the POSTs below must neither read it nor write one of their own.
    await poll();

    const postRequest = {
      url: URL,
      method: "POST" as const,
      body: "{}",
      decode,
      mapError: (cause: unknown): TestError => ({
        source: URL,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    };
    const post = () =>
      Effect.runPromise(
        fetchDecodedFeeds([postRequest], {
          fetch,
          conditionalStore: { cache: fake.cache, now: () => 1_000 },
        }),
      );
    await post();
    await post();

    expect(sentNoneMatch).toEqual([null, null, null]);
    expect(decode).toHaveBeenCalledTimes(3);
    expect(fake.storedUrls()).toHaveLength(1);
  });

  it("fails honestly when a 304 arrives with nothing cached", async () => {
    const fake = createFakeConditionalCache();
    const seen: unknown[] = [];
    const fetch: typeof globalThis.fetch = (async () =>
      new Response(null, { status: 304 })) as typeof fetch;

    const result = await Effect.runPromise(
      fetchDecodedFeeds(
        [
          request(URL, {
            mapError: (cause) => {
              seen.push(cause);
              return { source: URL, message: "mapped" };
            },
          }),
        ],
        { fetch, conditionalStore: { cache: fake.cache, now: () => 1_000 } },
      ),
    );

    expect(result.usable).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ status: 304 });
  });
  it.each([
    {
      name: "decoder configuration",
      before: { cacheIdentity: "decoder-v1-zone-a" },
      after: { cacheIdentity: "decoder-v1-zone-b" },
    },
    {
      name: "representation",
      before: { format: "json" as const },
      after: { format: "protobuf" as const },
    },
    {
      name: "header credentials",
      before: { headers: { Authorization: "secret-one" } },
      after: { headers: { Authorization: "secret-two" } },
    },
    {
      name: "arbitrary query credentials",
      before: { url: `${URL}?private_password=secret-one` },
      after: { url: `${URL}?private_password=secret-two` },
    },
    {
      name: "URL userinfo",
      before: { url: "https://alice:secret-one@feeds.example.test/conditional" },
      after: { url: "https://alice:secret-two@feeds.example.test/conditional" },
    },
  ])(
    "isolates cached decoded values by $name without exposing credentials",
    async ({ before, after }) => {
      const fake = createFakeConditionalCache();
      const decode = vi.fn((bytes: Uint8Array) =>
        Effect.succeed(decodedValue(new TextDecoder().decode(bytes))),
      );
      const { fetch, sentValidators } = scriptedUpstream([
        new Response("first", { headers: { ETag: '"one"' } }),
        new Response("second", { headers: { ETag: '"two"' } }),
      ]);
      for (const overrides of [before, after]) {
        await Effect.runPromise(
          fetchDecodedFeeds([{ ...conditionalTestRequest(decode), ...overrides }], {
            fetch,
            conditionalStore: { cache: fake.cache, now: () => 1_000 },
          }),
        );
      }
      expect(sentValidators).toEqual([null, null]);
      expect(decode).toHaveBeenCalledTimes(2);
      expect(fake.storedUrls()).toHaveLength(2);
      for (const key of fake.storedUrls()) {
        expect(key).toMatch(/^https:\/\/conditional-feed\.schematic\.invalid\/v2\/[a-f0-9]{64}$/);
      }
    },
  );

  it("reuses a recent validatorless observation without HTTP, decoding, refreshing or writing", async () => {
    const fake = createFakeConditionalCache();
    let now = 1_000;
    const decode = vi.fn((bytes: Uint8Array) =>
      Effect.succeed(decodedValue(new TextDecoder().decode(bytes))),
    );
    const fetch = vi.fn(async () => new Response("first")) as unknown as typeof globalThis.fetch;
    const request = conditionalTestRequest(decode);
    const options = { fetch, conditionalStore: { cache: fake.cache, now: () => now } };
    await Effect.runPromise(fetchDecodedFeeds([request], options));
    now = 2_000;
    const result = await Effect.runPromise(
      fetchDecodedFeeds([request], { ...options, maxCacheAgeMs: 1_000 }),
    );
    expect(result.usable).toEqual([{ text: "first", at: -1 }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(fake.operations().map(({ type }) => type)).toEqual(["match", "put", "match"]);
  });

  it.each([
    {
      name: "cadence age expired",
      observedAt: 1_000,
      now: 2_001,
      maxAge: 1_000,
      validators: [null, '"one"'],
    },
    {
      name: "observation from the future",
      observedAt: 2_000,
      now: 1_000,
      maxAge: 5_000,
      validators: [null, null],
    },
    {
      name: "cache retention expired",
      observedAt: 1_000,
      now: 86_401_001,
      maxAge: 100_000_000,
      validators: [null, null],
    },
  ])("falls back to a normal fetch when $name", async ({ observedAt, now, maxAge, validators }) => {
    const fake = createFakeConditionalCache();
    let clock = observedAt;
    const decode = vi.fn((bytes: Uint8Array) =>
      Effect.succeed(decodedValue(new TextDecoder().decode(bytes))),
    );
    const { fetch, sentValidators } = scriptedUpstream([
      new Response("first", { headers: { ETag: '"one"' } }),
      new Response("second", { headers: { ETag: '"two"' } }),
    ]);
    const request = conditionalTestRequest(decode);
    const options = { fetch, conditionalStore: { cache: fake.cache, now: () => clock } };
    await Effect.runPromise(fetchDecodedFeeds([request], options));
    clock = now;
    const result = await Effect.runPromise(
      fetchDecodedFeeds([request], { ...options, maxCacheAgeMs: maxAge }),
    );
    expect(result.usable).toEqual([{ text: "second", at: -1 }]);
    expect(result.firstError).toBeUndefined();
    expect(decode).toHaveBeenCalledTimes(2);
    expect(sentValidators).toEqual(validators);
    expect(fake.operations().map(({ type }) => type)).toEqual(["match", "put", "match", "put"]);
  });

  it.each([true, false])(
    "fetches normally on a cache miss with conditional cache available=%s",
    async (available) => {
      const fake = createFakeConditionalCache();
      const decode = vi.fn((bytes: Uint8Array) =>
        Effect.succeed(decodedValue(new TextDecoder().decode(bytes))),
      );
      const fetch = vi.fn(
        async () => new Response("upstream"),
      ) as unknown as typeof globalThis.fetch;
      const result = await Effect.runPromise(
        fetchDecodedFeeds([conditionalTestRequest(decode)], {
          fetch,
          maxCacheAgeMs: 60_000,
          ...(available ? { conditionalStore: { cache: fake.cache, now: () => 1_000 } } : {}),
        }),
      );
      expect(result.usable).toEqual([{ text: "upstream", at: -1 }]);
      expect(result.firstError).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(decode).toHaveBeenCalledTimes(1);
      expect(fake.operations().map(({ type }) => type)).toEqual(available ? ["match", "put"] : []);
    },
  );

  it("refreshes a 304 observation and its validators with one lookup and one write", async () => {
    const fake = createFakeConditionalCache();
    let now = 1_000;
    const { fetch, sentValidators } = scriptedUpstream([
      new Response("first", { headers: { ETag: '"one"' } }),
      new Response(null, { status: 304, headers: { ETag: '"two"' } }),
      new Response(null, { status: 304 }),
    ]);
    const request = conditionalTestRequest((bytes) =>
      Effect.succeed(decodedValue(new TextDecoder().decode(bytes))),
    );
    const options = { fetch, conditionalStore: { cache: fake.cache, now: () => now } };
    await Effect.runPromise(fetchDecodedFeeds([request], options));
    now = 2_000;
    await Effect.runPromise(fetchDecodedFeeds([request], options));
    now = 2_001;
    const reused = await Effect.runPromise(
      fetchDecodedFeeds([request], { ...options, maxCacheAgeMs: 1 }),
    );
    expect(reused.usable).toEqual([{ text: "first", at: 2_000 }]);
    await Effect.runPromise(fetchDecodedFeeds([request], options));
    expect(sentValidators).toEqual([null, '"one"', '"two"']);
    expect(fake.operations().map(({ type }) => type)).toEqual([
      "match",
      "put",
      "match",
      "put",
      "match",
      "match",
      "put",
    ]);
  });

  it("revalidates explicit GET requests", async () => {
    const fake = createFakeConditionalCache();
    const { fetch, sentValidators } = scriptedUpstream([
      new Response("first", { headers: { ETag: '"one"' } }),
      new Response(null, { status: 304 }),
    ]);
    const request = {
      ...conditionalTestRequest(() => Effect.succeed(decodedValue("first"))),
      method: "GET" as const,
    };
    for (let poll = 0; poll < 2; poll += 1) {
      await Effect.runPromise(
        fetchDecodedFeeds([request], {
          fetch,
          conditionalStore: { cache: fake.cache, now: () => 1_000 },
        }),
      );
    }
    expect(sentValidators).toEqual([null, '"one"']);
  });

  it("ignores decoded-value caching when no decoder namespace was supplied", async () => {
    const fake = createFakeConditionalCache();
    const fetch = vi.fn(
      async () => new Response("first", { headers: { ETag: '"one"' } }),
    ) as unknown as typeof globalThis.fetch;
    const result = await Effect.runPromise(
      fetchDecodedFeeds([request(URL)], {
        fetch,
        conditionalStore: { cache: fake.cache, now: () => 1_000 },
      }),
    );
    expect(result.usable).toEqual(["decoded:first"]);
    expect(fake.operations()).toEqual([]);
  });

  it("rejects an incompatible cached decoded value and heals it by full fetching", async () => {
    const fake = createFakeConditionalCache();
    const { fetch, sentValidators } = scriptedUpstream([
      new Response("first", { headers: { ETag: '"one"' } }),
      new Response("second", { headers: { ETag: '"two"' } }),
    ]);
    const request = conditionalTestRequest((bytes) =>
      Effect.succeed(decodedValue(new TextDecoder().decode(bytes))),
    );
    const options = { fetch, conditionalStore: { cache: fake.cache, now: () => 1_000 } };
    await Effect.runPromise(fetchDecodedFeeds([request], options));
    const result = await Effect.runPromise(
      fetchDecodedFeeds(
        [{ ...request, validateCached: (_value): _value is { text: string; at: number } => false }],
        options,
      ),
    );
    expect(result.usable).toEqual([{ text: "second", at: -1 }]);
    expect(sentValidators).toEqual([null, null]);
    expect(fake.operations().map(({ type }) => type)).toEqual(["match", "put", "match", "put"]);
  });
  it.each(["match", "put"] as const)(
    "keeps live feeds usable when cache %s rejects",
    async (operation) => {
      const fake = createFakeConditionalCache();
      vi.spyOn(fake.cache, operation).mockRejectedValue(new Error("cache unavailable"));
      const fetch = vi.fn(
        async () => new Response("first", { headers: { ETag: '"one"' } }),
      ) as unknown as typeof globalThis.fetch;
      const result = await Effect.runPromise(
        fetchDecodedFeeds([conditionalTestRequest(() => Effect.succeed(decodedValue("first")))], {
          fetch,
          conditionalStore: { cache: fake.cache, now: () => 1_000 },
        }),
      );
      expect(result.usable).toEqual([{ text: "first", at: -1 }]);
      expect(result.firstError).toBeUndefined();
    },
  );

  it("replaces old validators when a later complete response has none", async () => {
    const fake = createFakeConditionalCache();
    const { fetch, sentValidators } = scriptedUpstream([
      new Response("first", { headers: { ETag: '"one"' } }),
      new Response("second"),
      new Response("third"),
    ]);
    const request = conditionalTestRequest((bytes) =>
      Effect.succeed(decodedValue(new TextDecoder().decode(bytes))),
    );
    const options = { fetch, conditionalStore: { cache: fake.cache, now: () => 1_000 } };
    await Effect.runPromise(fetchDecodedFeeds([request], options));
    await Effect.runPromise(fetchDecodedFeeds([request], options));
    const third = await Effect.runPromise(fetchDecodedFeeds([request], options));
    expect(third.usable).toEqual([{ text: "third", at: -1 }]);
    expect(sentValidators).toEqual([null, '"one"', null]);
    expect(fake.operations().filter(({ type }) => type === "delete")).toEqual([]);
  });
  it.each(["transport", "decode"] as const)(
    "does not reuse a fresh cached value after a failed %s poll and heals on 304",
    async (failure) => {
      const fake = createFakeConditionalCache();
      let now = 1_000;
      const { fetch, sentValidators } = scriptedUpstream([
        new Response("first", { headers: { ETag: '"one"' } }),
        failure === "transport"
          ? new Response(null, { status: 500 })
          : new Response("invalid", { headers: { ETag: '"bad"' } }),
        new Response(null, { status: 304 }),
      ]);
      const request = conditionalTestRequest((bytes) => {
        const body = new TextDecoder().decode(bytes);
        return body === "invalid"
          ? Effect.fail(new Error("invalid feed"))
          : Effect.succeed(decodedValue(body));
      });
      const options = { fetch, conditionalStore: { cache: fake.cache, now: () => now } };
      await Effect.runPromise(fetchDecodedFeeds([request], options));
      now = 2_000;
      const failed = await Effect.runPromise(fetchDecodedFeeds([request], options));
      expect(failed.usable).toEqual([]);
      expect(failed.firstError).toBeDefined();
      now = 3_000;
      const revalidated = await Effect.runPromise(
        fetchDecodedFeeds([request], { ...options, maxCacheAgeMs: 16 * 60_000 }),
      );
      expect(revalidated.usable).toEqual([{ text: "first", at: 3_000 }]);
      expect(revalidated.firstError).toBeUndefined();
      now = 4_000;
      const healthyCached = await Effect.runPromise(
        fetchDecodedFeeds([request], { ...options, maxCacheAgeMs: 16 * 60_000 }),
      );
      expect(healthyCached.usable).toEqual([{ text: "first", at: 3_000 }]);
      expect(sentValidators).toEqual([null, '"one"', '"one"']);
      expect(fake.operations().map(({ type }) => type)).toEqual([
        "match",
        "put",
        "match",
        "put",
        "match",
        "put",
        "match",
      ]);
    },
  );
  it("updates response staleness on 200 and 304 while preserving decoded source timestamps", async () => {
    const fake = createFakeConditionalCache();
    const { fetch } = scriptedUpstream([
      new Response("first", { headers: { ETag: '"one"' } }),
      new Response(null, { status: 304, headers: { Warning: '110 proxy "Response is stale"' } }),
      new Response(null, { status: 304 }),
    ]);
    const decode = vi.fn((bytes: Uint8Array) =>
      Effect.succeed({ text: new TextDecoder().decode(bytes), at: 99, stale: false }),
    );
    const request = {
      url: URL,
      cacheIdentity: "response-state-v1",
      decode,
      mapError: (cause: unknown) => ({ source: URL, message: String(cause) }),
      onResponse: (value: { text: string; at: number; stale: boolean }, response: Response) => ({
        ...value,
        stale: response.headers.has("Warning"),
      }),
    };
    const options = { fetch, conditionalStore: { cache: fake.cache, now: () => 1_000 } };
    const first = await Effect.runPromise(fetchDecodedFeeds([request], options));
    expect(first.usable).toEqual([{ text: "first", at: 99, stale: false }]);
    const second = await Effect.runPromise(fetchDecodedFeeds([request], options));
    expect(second.usable).toEqual([{ text: "first", at: 99, stale: true }]);
    const staleCached = await Effect.runPromise(
      fetchDecodedFeeds([request], { ...options, maxCacheAgeMs: 60_000 }),
    );
    expect(staleCached.usable).toEqual(second.usable);
    const third = await Effect.runPromise(fetchDecodedFeeds([request], options));
    expect(third.usable).toEqual([{ text: "first", at: 99, stale: false }]);
    const healthyCached = await Effect.runPromise(
      fetchDecodedFeeds([request], { ...options, maxCacheAgeMs: 60_000 }),
    );
    expect(healthyCached.usable).toEqual(third.usable);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it("transforms response metadata without a conditional store", async () => {
    const fetch = vi.fn(
      async () => new Response("first", { headers: { Warning: '110 proxy "Response is stale"' } }),
    ) as unknown as typeof globalThis.fetch;
    const request = {
      ...conditionalTestRequest(() => Effect.succeed(decodedValue("first"))),
      onResponse: (value: { text: string; at: number }, response: Response) => ({
        ...value,
        at: response.headers.has("Warning") ? 12 : 0,
      }),
    };
    const result = await Effect.runPromise(fetchDecodedFeeds([request], { fetch }));
    expect(result.usable).toEqual([{ text: "first", at: 12 }]);
  });
  it.each(["transport", "decode", "redirect"] as const)(
    "preserves a cache invalidation slot when a %s failure exhausts ordinary request capacity",
    async (failure) => {
      const fake = createFakeConditionalCache();
      let now = 1_000;
      const request = conditionalTestRequest((bytes) => {
        const text = new TextDecoder().decode(bytes);
        return text === "invalid"
          ? Effect.fail(new Error("invalid feed"))
          : Effect.succeed(decodedValue(text));
      });
      await Effect.runPromise(
        fetchDecodedFeeds([request], {
          fetch: (async () =>
            new Response("first", { headers: { ETag: '"one"' } })) as typeof fetch,
          conditionalStore: { cache: fake.cache, now: () => now },
        }),
      );
      const upstream = vi.fn(async () =>
        failure === "transport"
          ? new Response(null, { status: 500 })
          : failure === "redirect"
            ? new Response(null, { status: 302, headers: { Location: "/another-hop" } })
            : new Response("invalid"),
      );
      const io = createCloudflareInvocationIo({
        fetch: upstream as typeof fetch,
        cache: fake.cache,
        limit: 3,
      });
      now = 2_000;
      const result = await Effect.runPromise(
        fetchDecodedFeeds([request], {
          fetch: io.fetch,
          conditionalStore: { cache: io.cache!, now: () => now },
        }),
      );
      expect(result.usable).toEqual([]);
      expect(result.firstError).toBeDefined();
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(
        fake
          .operations()
          .slice(2)
          .map(({ type }) => type),
      ).toEqual(["match", "put"]);
      await expect(io.fetch("https://example.test/excess")).rejects.toBeInstanceOf(
        InvocationBudgetExceeded,
      );
      const revalidate = vi.fn(async () => new Response(null, { status: 304 }));
      now = 3_000;
      const healed = await Effect.runPromise(
        fetchDecodedFeeds([request], {
          fetch: revalidate as typeof fetch,
          conditionalStore: { cache: fake.cache, now: () => now },
          maxCacheAgeMs: 15 * 60_000,
        }),
      );
      expect(revalidate).toHaveBeenCalledTimes(1);
      expect(healed.usable).toEqual([{ text: "first", at: 3_000 }]);
    },
  );

  it("releases the unused mutation reservation after a failed cold poll", async () => {
    const fake = createFakeConditionalCache();
    const upstream = vi.fn(async () => new Response(null, { status: 500 }));
    const io = createCloudflareInvocationIo({
      fetch: upstream as typeof fetch,
      cache: fake.cache,
      limit: 3,
    });
    const result = await Effect.runPromise(
      fetchDecodedFeeds([conditionalTestRequest(() => Effect.succeed(decodedValue("unused")))], {
        fetch: io.fetch,
        conditionalStore: { cache: io.cache!, now: () => 1_000 },
      }),
    );
    expect(result.usable).toEqual([]);
    expect(fake.operations().map(({ type }) => type)).toEqual(["match"]);
    await io.fetch("https://example.test/next-request");
    expect(upstream).toHaveBeenCalledTimes(2);
    await expect(io.fetch("https://example.test/excess")).rejects.toBeInstanceOf(
      InvocationBudgetExceeded,
    );
  });
  it("warms a successful 200 using the final reserved write slot", async () => {
    const fake = createFakeConditionalCache();
    const upstream = vi.fn(async () => new Response("first", { headers: { ETag: '"one"' } }));
    const io = createCloudflareInvocationIo({
      fetch: upstream as typeof fetch,
      cache: fake.cache,
      limit: 3,
    });
    const request = conditionalTestRequest((bytes) =>
      Effect.succeed(decodedValue(new TextDecoder().decode(bytes))),
    );
    const result = await Effect.runPromise(
      fetchDecodedFeeds([request], {
        fetch: io.fetch,
        conditionalStore: { cache: io.cache!, now: () => 1_000 },
      }),
    );
    expect(result.usable).toEqual([{ text: "first", at: -1 }]);
    expect(fake.operations().map(({ type }) => type)).toEqual(["match", "put"]);
    await expect(io.fetch("https://example.test/excess")).rejects.toBeInstanceOf(
      InvocationBudgetExceeded,
    );
    const neverFetch = vi.fn(async () => {
      throw new Error("unexpected cache miss");
    });
    const reused = await Effect.runPromise(
      fetchDecodedFeeds([request], {
        fetch: neverFetch as typeof fetch,
        conditionalStore: { cache: fake.cache, now: () => 2_000 },
        maxCacheAgeMs: 60_000,
      }),
    );
    expect(reused.usable).toEqual(result.usable);
    expect(neverFetch).not.toHaveBeenCalled();
  });
});
