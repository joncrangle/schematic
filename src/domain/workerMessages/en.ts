import type { WorkerMessages } from "../localeWorkerMessage";

export const enWorkerMessages = {
  offlineDocumentTitle: "Offline",
  offlineHeading: "Unable to retrieve live transit status",
  offlineMessage:
    "You are currently offline. Please check your internet connection to receive real-time transit updates.",
  offlineApiError: "Offline",
  offlineApiMessage: "Unable to retrieve live transit status while offline.",
  genericPushTitle: "🚨 Transit Disruption Alert",
  genericPushBody: "Severe disruption detected on your commute.",
} satisfies WorkerMessages;

/** Browser-decryption/no-data fallback remains English by product contract. */
export const ENGLISH_UNREADABLE_PUSH_FALLBACK = {
  title: "🚨 Transit Status",
  body: "A transit alert was received.",
} as const;
