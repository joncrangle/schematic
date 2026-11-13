import { hashKey, type QueryKey } from "@tanstack/solid-query";
import { createMemo, createSignal, onCleanup, untrack } from "solid-js";
import { queryClient } from "~/lib/queryClient";

/**
 * Read only the requested cache identity without Solid Query's async data
 * projection retaining the previous key during a transition. Cache events,
 * rather than receipt timestamps, invalidate the read: two successful writes
 * can share a millisecond and must still update the rendered evidence.
 */
export function useSettledQueryData<T>(key: () => QueryKey | undefined) {
  const [revision, setRevision] = createSignal(0);
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (
      event.type !== "removed" &&
      (event.type !== "updated" ||
        (event.action.type !== "success" && event.action.type !== "setState"))
    )
      return;
    const requestedKey = untrack(key);
    if (requestedKey && hashKey(event.query.queryKey) === hashKey(requestedKey)) {
      setRevision((value) => value + 1);
    }
  });
  onCleanup(unsubscribe);

  return createMemo(() => {
    revision();
    const requestedKey = key();
    return requestedKey ? queryClient.getQueryData<T>(requestedKey) : undefined;
  });
}
