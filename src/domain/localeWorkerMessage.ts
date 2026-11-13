import type { UiLocale } from "~/domain/locale";

export interface WorkerMessages {
  readonly offlineDocumentTitle: string;
  readonly offlineHeading: string;
  readonly offlineMessage: string;
  readonly offlineApiError: string;
  readonly offlineApiMessage: string;
  readonly genericPushTitle: string;
  readonly genericPushBody: string;
}

export const SET_LOCALE_MESSAGE_TYPE = "SET_LOCALE" as const;

/** The worker accepts new locale catalogs without a new worker implementation. */
export interface SetLocaleMessage {
  readonly type: typeof SET_LOCALE_MESSAGE_TYPE;
  readonly locale: string;
  readonly direction: "ltr" | "rtl";
  /** Monotonic per-origin selection order, allocated before a catalog loads. */
  readonly revision: number;
  /** Stable generation embedded in every page bundle from one app build. */
  readonly catalogGeneration: number;
  readonly messages: WorkerMessages;
}

export function createSetLocaleMessage(
  locale: UiLocale,
  messages: WorkerMessages,
  direction: "ltr" | "rtl",
  revision: number,
  catalogGeneration = 0,
): SetLocaleMessage {
  return {
    type: SET_LOCALE_MESSAGE_TYPE,
    locale,
    direction,
    revision,
    catalogGeneration,
    messages,
  };
}

/** Validate a bounded data catalog, independent of the page's supported-locale registry. */
export function readSetLocaleMessage(value: unknown): SetLocaleMessage | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const message = value as Partial<SetLocaleMessage>;
  if (message.type !== SET_LOCALE_MESSAGE_TYPE || typeof message.locale !== "string")
    return undefined;
  if (message.locale.length > 100 || (message.direction !== "ltr" && message.direction !== "rtl"))
    return undefined;
  // Missing revisions are legacy durable catalogs. Treat them as generation 0
  // so they remain readable after a worker restart but can never replace a
  // revisioned selection.
  const revision = message.revision === undefined ? 0 : message.revision;
  if (!Number.isSafeInteger(revision) || revision < 0) return undefined;
  // Older worker catalogs and page bundles have no build generation. Treat
  // them as the original generation so a current build can refresh their copy.
  const catalogGeneration = message.catalogGeneration === undefined ? 0 : message.catalogGeneration;
  if (!Number.isSafeInteger(catalogGeneration) || catalogGeneration < 0) return undefined;
  let locale: string;
  try {
    locale = Intl.getCanonicalLocales(message.locale)[0]!;
  } catch {
    return undefined;
  }
  if (!locale || !message.messages || typeof message.messages !== "object") return undefined;
  const fields = [
    "offlineDocumentTitle",
    "offlineHeading",
    "offlineMessage",
    "offlineApiError",
    "offlineApiMessage",
    "genericPushTitle",
    "genericPushBody",
  ] as const;
  const messages = {} as Record<keyof WorkerMessages, string>;
  for (const key of fields) {
    const text = message.messages[key];
    if (typeof text !== "string" || !text.trim() || text.length > 4096) return undefined;
    messages[key] = text;
  }
  return {
    type: SET_LOCALE_MESSAGE_TYPE,
    locale,
    direction: message.direction,
    revision,
    catalogGeneration,
    messages,
  };
}
