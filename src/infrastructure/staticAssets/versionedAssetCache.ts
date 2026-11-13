import { MAX_STATIC_ASSET_BYTES, type VersionedAssetReference } from "./versionedAssetReference";
const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const READ_TIMEOUT_MS = 5_000;

export function createVersionedAssetCache(options: {
  readonly readAsset: (path: string, signal: AbortSignal) => Promise<Response>;
  readonly now?: () => number;
}) {
  const cache = new Map<string, { value: unknown; bytes: number }>();
  const inflight = new Map<string, { promise: Promise<unknown>; startedAt: number }>();
  const now = options.now ?? Date.now;
  let cacheBytes = 0;
  const slots = new Map<
    symbol,
    { expiresAt: number; done: Promise<void>; release: () => void; abort: () => void }
  >();
  async function acquireReadSlot(
    controller: AbortController,
    stoppedBody: () => Promise<void> | undefined,
  ): Promise<() => void> {
    const signal = controller.signal;
    let abort: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new Error("Static data asset timed out"));
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      while (true) {
        if (signal.aborted) throw new Error("Static data asset timed out");
        for (const slot of slots.values())
          if (slot.expiresAt <= now()) {
            slot.abort();
          }
        if (slots.size < 4) break;
        await Promise.race([...Array.from(slots.values(), (slot) => slot.done), cancelled]);
      }
      const key = Symbol();
      let finish: () => void = () => {};
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const release = () => {
        slots.delete(key);
        finish();
      };
      slots.set(key, {
        expiresAt: now() + READ_TIMEOUT_MS,
        done,
        release,
        abort: () => {
          controller.abort();
          const stopped = stoppedBody();
          if (stopped) void stopped.then(release);
          else release();
        },
      });
      return release;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  async function load<T>(
    path: string,
    ref: VersionedAssetReference,
    decode: (value: unknown) => T,
  ): Promise<T> {
    const hit = cache.get(path);
    if (hit) {
      cache.delete(path);
      cache.set(path, hit);
      return hit.value as T;
    }
    const pending = inflight.get(path);
    if (pending && now() - pending.startedAt < READ_TIMEOUT_MS)
      return pending.promise as Promise<T>;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let release: (() => void) | undefined;
    let stoppedBody: Promise<void> | undefined;
    const operation = (async () => {
      release = await acquireReadSlot(controller, () => stoppedBody);
      if (ref.bytes > MAX_STATIC_ASSET_BYTES) throw new Error("Oversized static data artifact");
      const response = await options.readAsset(path, controller.signal);
      if (!response.ok || !response.body || controller.signal.aborted) {
        await response.body?.cancel();
        throw new Error("Static data asset unavailable");
      }
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      const cancel = () => {
        try {
          stoppedBody ??= reader.cancel().catch(() => undefined);
        } catch {
          stoppedBody = Promise.resolve();
        }
      };
      controller.signal.addEventListener("abort", cancel, { once: true });
      let length = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          length += next.value.byteLength;
          if (length > ref.bytes || length > MAX_STATIC_ASSET_BYTES)
            throw new Error("Static data artifact size mismatch");
          chunks.push(next.value);
        }
      } finally {
        controller.signal.removeEventListener("abort", cancel);
        cancel();
        await stoppedBody;
      }
      if (controller.signal.aborted) throw new Error("Static data asset timed out");
      if (length !== ref.bytes) throw new Error("Static data artifact size mismatch");
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const hash = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
      if (hash !== ref.hash) throw new Error("Static data artifact integrity mismatch");
      return decode(JSON.parse(new TextDecoder().decode(bytes)));
    })();
    void operation.finally(() => release?.()).catch(() => undefined);
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Static data asset timed out"));
      }, READ_TIMEOUT_MS);
    });
    const promise = Promise.race([operation, deadline])
      .then((value) => {
        if (inflight.get(path)?.promise === promise) {
          while (cache.size >= 64 || cacheBytes + ref.bytes > MAX_CACHE_BYTES) {
            const key = cache.keys().next().value!;
            cacheBytes -= cache.get(key)!.bytes;
            cache.delete(key);
          }
          cache.set(path, { value, bytes: ref.bytes });
          cacheBytes += ref.bytes;
        }
        return value;
      })
      .finally(() => {
        clearTimeout(timer);
        if (stoppedBody) void stoppedBody.then(() => release?.());
        if (inflight.get(path)?.promise === promise) inflight.delete(path);
      });
    inflight.set(path, { promise, startedAt: now() });
    return promise;
  }
  return { load };
}
export type VersionedAssetCache = ReturnType<typeof createVersionedAssetCache>;
