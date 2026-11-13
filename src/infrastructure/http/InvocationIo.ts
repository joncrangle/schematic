import * as Data from "effect/Data";

export class InvocationBudgetExceeded extends Data.TaggedError("InvocationBudgetExceeded")<{
  readonly message: string;
}> {}

export class InvocationRedirectRefused extends Data.TaggedError("InvocationRedirectRefused")<{
  readonly message: string;
}> {}

/** One invocation owns this counter; cached services receive it only through call options. */
export interface InvocationBudget {
  readonly remaining: number;
  readonly assertAvailable: () => void;
  readonly consume: () => void;
  readonly reserve: () => InvocationPermit;
}

export interface InvocationPermit {
  readonly consume: () => void;
  readonly release: () => void;
}

export interface CacheMutationReservation {
  readonly put: (request: RequestInfo | URL, response: Response) => Promise<void>;
  readonly release: () => void;
}

export interface ReservableCache extends Cache {
  readonly reserveMutation: () => CacheMutationReservation;
}

export function createInvocationBudget(limit = 50): InvocationBudget {
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError("Invalid invocation budget");
  let remaining = limit;
  const assertAvailable = () => {
    if (remaining === 0)
      throw new InvocationBudgetExceeded({ message: "Invocation request budget exhausted" });
  };
  return {
    get remaining() {
      return remaining;
    },
    assertAvailable,
    consume: () => {
      assertAvailable();
      remaining -= 1;
    },
    reserve: () => {
      assertAvailable();
      remaining -= 1;
      let held = true;
      return {
        consume: () => {
          if (!held)
            throw new InvocationBudgetExceeded({
              message: "Invocation permit already released or consumed",
            });
          held = false;
        },
        release: () => {
          if (!held) return;
          held = false;
          remaining += 1;
        },
      };
    },
  };
}

export interface InvocationIo {
  readonly budget: InvocationBudget;
  readonly fetch: typeof fetch;
  readonly cache?: ReservableCache;
  readonly sendOptions: { readonly beforeSend: () => void; readonly fetch: typeof fetch };
}

// Custom headers can contain manifest-declared credentials such as X-Feed-Token.
// Cross-origin redirects keep only representation, cache, and body metadata.
const CROSS_ORIGIN_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "content-type",
  "content-length",
  "content-encoding",
  "content-language",
  "content-location",
  "if-match",
  "if-none-match",
  "if-modified-since",
  "if-unmodified-since",
  "if-range",
  "range",
  "user-agent",
]);

/** Cache operations and every HTTP redirect hop share Workers' invocation quota. */
export function createCloudflareInvocationIo(options: {
  readonly fetch: typeof fetch;
  readonly cache?: Cache;
  readonly limit?: number;
}): InvocationIo {
  const budget = createInvocationBudget(options.limit);
  const boundedFetch: typeof fetch = async (input, init) => {
    const incomingRequest = input instanceof Request ? input : undefined;
    let url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let requestInit: RequestInit = {
      ...(incomingRequest
        ? {
            method: incomingRequest.method,
            headers: incomingRequest.headers,
            body: incomingRequest.body,
            signal: incomingRequest.signal,
            redirect: incomingRequest.redirect,
          }
        : {}),
      ...init,
    };
    if (requestInit.body instanceof ReadableStream)
      requestInit = Object.assign({ duplex: "half" }, requestInit);
    const redirectMode = requestInit.redirect ?? "follow";
    for (let redirects = 0; ; redirects += 1) {
      budget.consume();
      const response = await options.fetch(url, { ...requestInit, redirect: "manual" });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      if (redirectMode === "manual") return response;
      const location = response.headers.get("Location");
      if (location === null) return response;
      await response.body?.cancel().catch(() => {});
      if (redirectMode === "error" || redirects >= 5) {
        throw new InvocationRedirectRefused({ message: "Upstream redirect refused" });
      }
      const next = new URL(location, url);
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw new InvocationRedirectRefused({ message: "Unsupported upstream redirect protocol" });
      }
      let headers = new Headers(requestInit.headers);
      if (next.origin !== new URL(url).origin) {
        headers = new Headers(
          Array.from(headers.entries()).filter(([name]) => CROSS_ORIGIN_HEADERS.has(name)),
        );
      }
      const method = (requestInit.method ?? "GET").toUpperCase();
      if (
        (response.status === 303 && method !== "GET" && method !== "HEAD") ||
        ((response.status === 301 || response.status === 302) && method === "POST")
      ) {
        requestInit = { ...requestInit, method: "GET", body: undefined };
        for (const name of [
          "Content-Type",
          "Content-Length",
          "Content-Encoding",
          "Content-Language",
          "Content-Location",
        ])
          headers.delete(name);
      } else if (requestInit.body instanceof ReadableStream) {
        throw new InvocationRedirectRefused({ message: "Cannot replay a streaming redirect body" });
      }
      requestInit = { ...requestInit, headers };
      url = next.href;
    }
  };
  const cache =
    options.cache === undefined
      ? undefined
      : (new Proxy(options.cache, {
          get(target, property) {
            if (property === "reserveMutation")
              return () => {
                const permit = budget.reserve();
                return {
                  put: (request: RequestInfo | URL, response: Response) => {
                    permit.consume();
                    return target.put(request, response);
                  },
                  release: permit.release,
                };
              };
            const value = Reflect.get(target, property, target);
            if (typeof value !== "function") return value;
            if (property === "match" || property === "put" || property === "delete") {
              return (...args: unknown[]) => {
                budget.consume();
                return Reflect.apply(value, target, args);
              };
            }
            return value.bind(target);
          },
        }) as ReservableCache);
  return {
    budget,
    fetch: boundedFetch,
    cache,
    sendOptions: { beforeSend: budget.assertAvailable, fetch: boundedFetch },
  };
}
