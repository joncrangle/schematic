import type { UiLocale } from "~/domain/locale";
import type { WorkerMessages } from "~/domain/localeWorkerMessage";
import { enWorkerMessages } from "~/domain/workerMessages/en";

/** Only the selected catalog loads into the page and is copied to its shared worker. */
const WORKER_MESSAGE_LOADERS = {
  "en-CA": async () => enWorkerMessages,
  "fr-CA": async () => (await import("~/domain/workerMessages/fr")).frWorkerMessages,
} satisfies Record<UiLocale, () => Promise<WorkerMessages>>;

export function loadWorkerMessages(locale: UiLocale): Promise<WorkerMessages> {
  return WORKER_MESSAGE_LOADERS[locale]();
}
