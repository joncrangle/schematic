import { describe, expect, it, vi } from "vitest";
import {
  createCloudflareInvocationIo,
  InvocationBudgetExceeded,
  InvocationRedirectRefused,
} from "~/infrastructure/http/InvocationIo";
import { createFakeConditionalCache } from "../helpers/fake-conditional-cache";

describe("invocation request accounting", () => {
  it("refuses the 51st external request before contacting the upstream", async () => {
    const upstream = vi.fn(async () => new Response(null, { status: 204 }));
    const io = createCloudflareInvocationIo({ fetch: upstream as typeof fetch });
    for (let request = 0; request < 50; request += 1) await io.fetch("https://example.test/feed");
    await expect(io.fetch("https://example.test/feed")).rejects.toBeInstanceOf(
      InvocationBudgetExceeded,
    );
    expect(upstream).toHaveBeenCalledTimes(50);
  });

  it("shares one quota between cache operations and HTTP", async () => {
    const fake = createFakeConditionalCache();
    const upstream = vi.fn(async () => new Response("feed"));
    const io = createCloudflareInvocationIo({
      fetch: upstream as typeof fetch,
      cache: fake.cache,
      limit: 4,
    });
    await io.cache!.match("https://cache.example.test/feed");
    await io.fetch("https://example.test/feed");
    await io.cache!.put("https://cache.example.test/feed", new Response("cached"));
    await io.cache!.delete("https://cache.example.test/feed");
    await expect(io.fetch("https://example.test/feed")).rejects.toBeInstanceOf(
      InvocationBudgetExceeded,
    );
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(fake.operations().map(({ type }) => type)).toEqual(["match", "put", "delete"]);
  });

  it.each([
    ["https://other.example.test/feed", false],
    ["https://example.test/destination", true],
  ])(
    "counts redirect hops and limits credentials to their origin: %s",
    async (destination, sameOrigin) => {
      const first = new Response("redirect", {
        status: 302,
        headers: { Location: destination },
      });
      const cancel = vi.spyOn(first.body!, "cancel");
      const upstream = vi.fn(async () =>
        upstream.mock.calls.length === 1 ? first : new Response("feed"),
      );
      const io = createCloudflareInvocationIo({ fetch: upstream as typeof fetch, limit: 2 });
      const response = await io.fetch("https://example.test/feed", {
        headers: {
          Authorization: "secret",
          Cookie: "session",
          "X-Feed-Token": "proxy-secret",
          "Api-Key": "custom-secret",
          Accept: "application/json",
        },
      });
      expect(await response.text()).toBe("feed");
      expect(upstream).toHaveBeenCalledTimes(2);
      expect(cancel).toHaveBeenCalledOnce();
      const headers = new Headers(
        (upstream.mock.calls[1] as unknown as [string, RequestInit])[1].headers,
      );
      expect(headers.has("Authorization")).toBe(sameOrigin);
      expect(headers.has("Cookie")).toBe(sameOrigin);
      expect(headers.has("X-Feed-Token")).toBe(sameOrigin);
      expect(headers.has("Api-Key")).toBe(sameOrigin);
      expect(headers.get("Accept")).toBe("application/json");
      await expect(io.fetch("https://example.test/feed")).rejects.toBeInstanceOf(
        InvocationBudgetExceeded,
      );
    },
  );

  it("refuses a redirect destination when the remaining quota is exhausted", async () => {
    const upstream = vi.fn(
      async () => new Response("redirect", { status: 302, headers: { Location: "/destination" } }),
    );
    const io = createCloudflareInvocationIo({ fetch: upstream as typeof fetch, limit: 1 });
    await expect(io.fetch("https://example.test/feed")).rejects.toBeInstanceOf(
      InvocationBudgetExceeded,
    );
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("bounds a redirect loop even while request capacity remains", async () => {
    const upstream = vi.fn(
      async () => new Response("redirect", { status: 302, headers: { Location: "/again" } }),
    );
    const io = createCloudflareInvocationIo({ fetch: upstream as typeof fetch });
    await expect(io.fetch("https://example.test/feed")).rejects.toBeInstanceOf(
      InvocationRedirectRefused,
    );
    expect(upstream).toHaveBeenCalledTimes(6);
  });

  it("returns the redirect response when redirect mode is manual", async () => {
    const upstream = vi.fn(
      async () => new Response(null, { status: 302, headers: { Location: "/destination" } }),
    );
    const io = createCloudflareInvocationIo({ fetch: upstream as typeof fetch });

    expect((await io.fetch("https://example.test/feed", { redirect: "manual" })).status).toBe(302);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("rejects redirect mode error without following a push endpoint", async () => {
    const upstream = vi.fn(
      async () => new Response(null, { status: 302, headers: { Location: "/destination" } }),
    );
    const io = createCloudflareInvocationIo({ fetch: upstream as typeof fetch });

    await expect(
      io.fetch("https://example.test/feed", { redirect: "error" }),
    ).rejects.toBeInstanceOf(InvocationRedirectRefused);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh budget for the next invocation", async () => {
    const upstream = vi.fn(async () => new Response("feed"));
    const first = createCloudflareInvocationIo({ fetch: upstream as typeof fetch, limit: 1 });
    await first.fetch("https://example.test/feed");
    expect(() => first.sendOptions.beforeSend()).toThrow(InvocationBudgetExceeded);
    const next = createCloudflareInvocationIo({ fetch: upstream as typeof fetch, limit: 1 });
    await next.fetch("https://example.test/feed");
    expect(upstream).toHaveBeenCalledTimes(2);
  });
  it("protects a reserved cache mutation from competing requests and consumes it only once", async () => {
    const fake = createFakeConditionalCache();
    const upstream = vi.fn(async () => new Response("feed"));
    const io = createCloudflareInvocationIo({
      fetch: upstream as typeof fetch,
      cache: fake.cache,
      limit: 2,
    });
    const mutation = io.cache!.reserveMutation();
    await io.fetch("https://example.test/feed");
    await expect(io.fetch("https://example.test/competitor")).rejects.toBeInstanceOf(
      InvocationBudgetExceeded,
    );
    await mutation.put("https://cache.example.test/feed", new Response("saved"));
    mutation.release();
    expect(() => mutation.put("https://cache.example.test/feed", new Response("twice"))).toThrow(
      InvocationBudgetExceeded,
    );
    await expect(io.fetch("https://example.test/excess")).rejects.toBeInstanceOf(
      InvocationBudgetExceeded,
    );
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(fake.operations().map(({ type }) => type)).toEqual(["put"]);
  });
});
