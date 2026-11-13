import { describe, expect, it, vi } from "vitest";
import { createFeedPollingFetch } from "~/infrastructure/realtime/feedPolling";

const feeds = [{ url: "https://polling.example.test/trips", pollIntervalSeconds: 60 }];

describe("declared feed polling", () => {
  it("shares one upstream document across consumers until the interval expires", async () => {
    let now = 1_000;
    const upstream = vi.fn(async () => new Response("predictions"));
    const cache = new Map();
    const first = createFeedPollingFetch(feeds, { fetch: upstream, now: () => now, memory: cache });
    const second = createFeedPollingFetch(feeds, { fetch: upstream, now: () => now, memory: cache });
    const responses = await Promise.all([first(feeds[0].url), second(feeds[0].url)]);
    expect(await Promise.all(responses.map((response) => response.text()))).toEqual([
      "predictions", "predictions",
    ]);
    now += 59_999;
    expect(await (await second(feeds[0].url)).text()).toBe("predictions");
    expect(upstream).toHaveBeenCalledTimes(1);
    now += 1;
    await first(feeds[0].url);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("refreshes recency when a fresh document is reused", async () => {
    const memory = new Map();
    const fetch = createFeedPollingFetch(feeds, {
      fetch: vi.fn(async () => new Response("document")),
      memory,
    });
    await fetch(`${feeds[0].url}?apikey=one`);
    const [first] = [...memory.keys()];
    await fetch(`${feeds[0].url}?apikey=two`);
    await fetch(`${feeds[0].url}?apikey=one`);
    expect([...memory.keys()].at(-1)).toBe(first);
  });

  it("moves a re-polled document to the most recent position", async () => {
    let now = 1_000;
    const memory = new Map();
    const fetch = createFeedPollingFetch(feeds, {
      fetch: vi.fn(async () => new Response("document")),
      now: () => now,
      memory,
    });
    await fetch(`${feeds[0].url}?apikey=one`);
    const [first] = [...memory.keys()];
    await fetch(`${feeds[0].url}?apikey=two`);
    now += 60_000;
    await fetch(`${feeds[0].url}?apikey=one`);
    expect([...memory.keys()].at(-1)).toBe(first);
  });

  it("keeps credentials, POST bodies, and undeclared requests separate", async () => {
    const upstream = vi.fn(async () => new Response("document"));
    const fetch = createFeedPollingFetch(feeds, { fetch: upstream, memory: new Map() });
    for (const key of ["one", "two", "one"]) {
      await fetch(`${feeds[0].url}?apikey=${key}`);
    }
    await fetch(feeds[0].url, { method: "POST", body: "stop=one" });
    await fetch(feeds[0].url, { method: "POST", body: "stop=two" });
    await fetch("https://polling.example.test/other");
    await fetch("https://polling.example.test/other");
    expect(upstream).toHaveBeenCalledTimes(6);
  });

  it("returns upstream failures during the cooldown and retries at the next interval", async () => {
    let now = 0;
    const upstream = vi.fn().mockResolvedValueOnce(new Response("limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("recovered"));
    const fetch = createFeedPollingFetch(feeds, { fetch: upstream, now: () => now, memory: new Map() });
    expect((await fetch(feeds[0].url)).status).toBe(429);
    expect((await fetch(feeds[0].url)).status).toBe(429);
    expect(upstream).toHaveBeenCalledTimes(1);
    now = 60_000;
    expect(await (await fetch(feeds[0].url)).text()).toBe("recovered");
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("retries immediately after a read that produced no upstream document", async () => {
    const upstream = vi.fn().mockRejectedValueOnce(new TypeError("network lost"))
      .mockResolvedValueOnce(new Response("recovered"));
    const fetch = createFeedPollingFetch(feeds, { fetch: upstream, now: () => 0, memory: new Map() });
    await expect(fetch(feeds[0].url)).rejects.toThrow("network lost");
    expect(await (await fetch(feeds[0].url)).text()).toBe("recovered");
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("matches authenticated dev-proxy and per-stop URLs without caching other hosts", async () => {
    const upstream = vi.fn(async () => new Response("document"));
    const fetch = createFeedPollingFetch([
      { url: "https://operator.example.test/stops/{stopId}", devProxyPrefix: "/__dev/operator", pollIntervalSeconds: 30 },
    ], { fetch: upstream, devProxyOrigin: "https://localhost:3000", memory: new Map() });
    for (let i = 0; i < 2; i += 1) {
      await fetch("https://localhost:3000/__dev/operator/stops/123?key=synthetic");
      await fetch("https://unrelated.example.test/stops/123");
    }
    expect(upstream).toHaveBeenCalledTimes(3);
  });
});

it("isolates consumer cancellation from the upstream poll", async () => {
  let finish!: (response: Response) => void;
  const upstream = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  const fetch = createFeedPollingFetch(feeds, { fetch: upstream, memory: new Map() });
  const first = new AbortController();
  const aborted = fetch(feeds[0].url, { signal: first.signal }).catch(() => "aborted");
  const remaining = fetch(feeds[0].url);
  await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(1));
  first.abort();
  finish(new Response("predictions"));
  expect(await aborted).toBe("aborted");
  expect(await (await remaining).text()).toBe("predictions");
  expect(await (await fetch(feeds[0].url)).text()).toBe("predictions");
});

it("reuses the same wire observation when conditional validators appear", async () => {
  const upstream = vi.fn(async () => new Response("predictions", { headers: { ETag: "v1" } }));
  const fetch = createFeedPollingFetch(feeds, { fetch: upstream, memory: new Map() });
  await fetch(feeds[0].url);
  expect(await (await fetch(feeds[0].url, { headers: { "If-None-Match": "v1" } })).text()).toBe("predictions");
  expect(upstream).toHaveBeenCalledTimes(1);
});

it("evicts an observation when the production decoder rejects it", async () => {
  const { Effect } = await import("effect");
  const { fetchDecodedFeeds } = await import("~/infrastructure/realtime/fetchDecodedFeeds");
  const upstream = vi.fn().mockResolvedValueOnce(new Response("broken"))
    .mockResolvedValueOnce(new Response("valid"));
  const fetch = createFeedPollingFetch(feeds, { fetch: upstream, memory: new Map() });
  const query = () => Effect.runPromise(fetchDecodedFeeds([{
    url: feeds[0].url,
    decode: (bytes) => new TextDecoder().decode(bytes) === "valid" ? Effect.succeed("valid") : Effect.fail(new Error("torn")),
    mapError: (cause) => cause,
  }], { fetch }));
  expect((await query()).usable).toEqual([]);
  expect((await query()).usable).toEqual(["valid"]);
  expect(upstream).toHaveBeenCalledTimes(2);
});

it("keeps polling cache reads and writes inside the caller's invocation budget", async () => {
  const { createCloudflareInvocationIo } = await import("~/infrastructure/http/InvocationIo");
  const { createFakeConditionalCache } = await import("../helpers/fake-conditional-cache");
  const { makeTestProvider } = await import("../helpers/agency-fixtures");
  const scoped = createFakeConditionalCache();
  const global = createFakeConditionalCache();
  vi.stubGlobal("caches", { default: global.cache });
  const upstream = vi.fn(async () => new Response(new Uint8Array([10, 5, 10, 3, 50, 46, 48])));
  const io = createCloudflareInvocationIo({ fetch: upstream, cache: scoped.cache, limit: 6 });
  try {
    const provider = makeTestProvider({ alerts: [{ type: "gtfs-rt", url: "https://budget.example.test/alerts", format: "protobuf", pollIntervalSeconds: 60 }] });
    const snapshot = await provider.snapshot!.get({ fetch: io.fetch, now: Date.now, alertConditionalCache: io.cache });
    expect(snapshot.freshness).toBe("live");
    expect(global.operations()).toHaveLength(0);
    expect(scoped.operations().length + upstream.mock.calls.length).toBe(6 - io.budget.remaining);
  } finally { vi.unstubAllGlobals(); }
});

it("lets a new invocation recover after another invocation exhausts its budget", async () => {
  const { createCloudflareInvocationIo } = await import("~/infrastructure/http/InvocationIo");
  const { createFakeConditionalCache } = await import("../helpers/fake-conditional-cache");
  const { makeTestProvider } = await import("../helpers/agency-fixtures");
  const upstream = vi.fn(async () => new Response(new Uint8Array([10, 5, 10, 3, 50, 46, 48])));
  const cache = createFakeConditionalCache();
  const provider = makeTestProvider({ alerts: [{ type: "gtfs-rt", url: "https://recovery.example.test/alerts", format: "protobuf", pollIntervalSeconds: 60 }] });
  const exhausted = createCloudflareInvocationIo({ fetch: upstream, cache: cache.cache, limit: 2 });
  await expect(provider.snapshot!.get({ fetch: exhausted.fetch, now: Date.now, alertConditionalCache: exhausted.cache })).rejects.toThrow();
  const next = createCloudflareInvocationIo({ fetch: upstream, cache: cache.cache, limit: 50 });
  const snapshot = await provider.snapshot!.get({ fetch: next.fetch, now: Date.now, alertConditionalCache: next.cache });
  expect(snapshot.freshness).toBe("live");
  expect(upstream).toHaveBeenCalledTimes(1);
});

it("shares a sliding upstream request budget across provider ports without charging cached stops", async () => {
  let now = 1000;
  const upstream = vi.fn(async () => new Response("board"));
  const memory = new Map();
  const feeds = [
    { url: "https://budget.test/stops/{stopId}", pollIntervalSeconds: 60, requestsPerMinute: 2 },
  ];
  const first = createFeedPollingFetch(feeds, { fetch: upstream, memory, now: () => now });
  const second = createFeedPollingFetch(feeds, { fetch: upstream, memory, now: () => now });
  await first("https://budget.test/stops/1");
  await second("https://budget.test/stops/1");
  await second("https://budget.test/stops/2");
  expect((await first("https://budget.test/stops/3")).status).toBe(429);
  expect(upstream).toHaveBeenCalledTimes(2);
  now += 60000;
  expect((await second("https://budget.test/stops/3")).status).toBe(200);
  expect(upstream).toHaveBeenCalledTimes(3);
});
