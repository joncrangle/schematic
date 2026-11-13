import { createMemo } from "solid-js";
import { useQuery } from "@tanstack/solid-query";
import { isPushSupported } from "~/services/notifications/PushNotificationService";
import {
  getVapidPublicKey,
  type VapidKeyResponse,
} from "~/services/notifications/NotificationClient";

export interface PushAvailability {
  readonly isSupported: () => boolean;
  readonly isConfigured: () => boolean;
  readonly isAvailable: () => boolean;
  readonly isLoading: () => boolean;
}

export function usePushAvailability(): PushAvailability {
  // isPushSupported reads the navigator once. It is not reactive, so a
  // const does the job. Tests mock the navigator before render, and the
  // const picks up the mocked value just like the old memo did.
  const supported = isPushSupported();

  const query = useQuery(() => ({
    queryKey: ["vapid-public-key"] as const,
    // Let failures reject so query.error drives the UI. The old
    // catch-to-fake-data hid real errors and wasted the global retry on them.
    queryFn: (): Promise<VapidKeyResponse> => getVapidPublicKey(),
    enabled: supported,
    staleTime: 5 * 60_000,
    retry: false,
    placeholderData: (prev: VapidKeyResponse | undefined) => prev,
  }));

  const isConfigured = createMemo(() => {
    if (!supported) return false;
    // Query v6 suspends reads of never-settled data; gate on the
    // suspension-safe pending flag so first load reports unconfigured
    // instead of suspending.
    return (query.isPending ? undefined : query.data)?.configured ?? false;
  });

  const isAvailable = createMemo(() => supported && isConfigured());

  const isLoading = createMemo(() => supported && query.isLoading);

  return {
    isSupported: () => supported,
    isConfigured,
    isAvailable,
    isLoading,
  };
}
