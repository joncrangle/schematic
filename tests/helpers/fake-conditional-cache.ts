/**
 * In-memory Cache stand-in for conditional-fetch tests. Behaves like the
 * Cache API surface the kernel touches (`match`/`put`/`delete` keyed by
 * request URL); everything else throws if reached, so tests stay honest
 * about which surface they exercise.
 */
export interface FakeConditionalCache {
  readonly cache: Cache;
  readonly storedUrls: () => readonly string[];
  readonly operations: () => readonly {
    readonly type: "match" | "put" | "delete";
    readonly url: string;
  }[];
}

export function createFakeConditionalCache(): FakeConditionalCache {
  const entries = new Map<string, Response>();
  const operations: { type: "match" | "put" | "delete"; url: string }[] = [];
  const keyOf = (request: RequestInfo | URL): string =>
    typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
  const cache = {
    async match(request: RequestInfo | URL): Promise<Response | undefined> {
      const url = keyOf(request);
      operations.push({ type: "match", url });
      return entries.get(url)?.clone();
    },
    async put(request: RequestInfo | URL, response: Response): Promise<void> {
      const url = keyOf(request);
      operations.push({ type: "put", url });
      entries.set(url, response.clone());
    },
    async delete(request: RequestInfo | URL): Promise<boolean> {
      const url = keyOf(request);
      operations.push({ type: "delete", url });
      return entries.delete(url);
    },
  } as unknown as Cache;
  return { cache, storedUrls: () => [...entries.keys()], operations: () => operations };
}
