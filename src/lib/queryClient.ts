import { QueryClient } from "@tanstack/solid-query";

/**
 * Shared QueryClient for TanStack Query.
 *
 * Defaults:
 * - staleTime: 30s, data is considered fresh for 30 seconds, reducing
 *   redundant server requests from multiple components querying the same key
 *   and collapsing mount/focus refetch storms (interval polls still fire on
 *   their own cadence; background tabs never poll).
 * - gcTime: 60s, garbage-collect unused cache entries after 1 minute.
 * - refetchOnWindowFocus: true, automatically refetch when the user returns
 *   to the tab (ensures data is current after backgrounding).
 * - retry: 1, single retry on failure before surfacing the error.
 *
 * Route-tracking keys (["route-tracking", routeId, directionId]) renew
 * exclusively via intervals in lib/routeTrackingLifecycle; the global
 * `refetchOnWindowFocus: true` is inert for them today because that module
 * only uses imperative fetchQuery/ensureQueryData, which create no observers.
 * A future useQuery on those keys would silently change their freshness
 * semantics by layering window-focus refetches onto the lifecycle cadence.
 *
 * All server functions remain server-side via Solid 2 start mode (`"use
 * server"` extraction; server-only implementations live in `*Server.ts`
 * modules behind the `server-only` boundary). This client manages only the
 * client-side cache of those responses.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 60_000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});
