import * as Effect from "effect/Effect";
import { fetchDecodedFeeds } from "./fetchDecodedFeeds";
import { createFeedPollingFetch } from "./feedPolling";

const EMPTY_BODY = Symbol("empty vendor body");

export interface VendorOptions {
  readonly fetch: typeof fetch;
  readonly now?: () => number;
  readonly devProxyOrigin?: string;
}
/** Cache dynamic vendor requests with the same byte limits and failure policy as declared feeds. */
export async function readVendorDocument(
  options: VendorOptions,
  url: string,
  request: {
    readonly interval?: number;
    readonly requestsPerMinute?: number;
    readonly body?: unknown;
    readonly headers?: Record<string, string>;
    readonly text?: boolean;
    readonly form?: string;
    readonly emptyOn204?: boolean;
    readonly observeResponse?: (response: Response) => void;
  } = {},
): Promise<unknown> {
  const pollingFetch = createFeedPollingFetch(
    [
      {
        url,
        pollIntervalSeconds: request.interval ?? 30,
        requestsPerMinute: request.requestsPerMinute,
      },
    ],
    options,
  );
  const result = await Effect.runPromise(
    fetchDecodedFeeds(
      [
        {
          url,
          format: "json",
          headers: request.form
            ? { ...request.headers, "Content-Type": "application/x-www-form-urlencoded" }
            : request.body === undefined
              ? request.headers
              : { ...request.headers, "Content-Type": "application/json" },
          ...(request.body === undefined && request.form === undefined
            ? {}
            : { method: "POST" as const, body: request.form ?? JSON.stringify(request.body) }),
          decode: (bytes) =>
            Effect.try(() => {
              if (bytes.length === 0 && request.emptyOn204) return EMPTY_BODY;
              const text = new TextDecoder().decode(bytes);
              return request.text ? text : (JSON.parse(text) as unknown);
            }),
          onResponse: (value, response) => {
            request.observeResponse?.(response);
            if (value !== EMPTY_BODY) return value;
            if (response.status === 204) return [];
            throw new Error("Unrecognized empty vendor document");
          },
          mapError: (cause) => cause,
        },
      ],
      { fetch: pollingFetch, attempts: 1, timeoutMs: 8000 },
    ),
  );
  if (!result.usable.length) throw result.firstError ?? new Error("Incomplete vendor document");
  return result.usable[0];
}
