import type { UiLocale } from "~/domain/locale";

export interface LocaleMessages {
  readonly notifications: {
    readonly active: {
      readonly lineTarget: string;
      readonly genericTarget: string;
      readonly title: string;
      readonly fallbackTitle: string;
      readonly fallbackBody: string;
    };
    readonly recovery: {
      readonly lineTarget: string;
      readonly routeTarget: string;
      readonly genericTarget: string;
      readonly title: string;
      readonly body: string;
    };
  };
}

/** Server notification copy. Worker catalogs load separately through the page. */
export const LOCALE_MESSAGES = {
  "en-CA": {
    notifications: {
      active: {
        lineTarget: "Line {id}",
        genericTarget: "Transit",
        title: "🚨 {target}: {alert}",
        fallbackTitle: "Transit Alert",
        fallbackBody: "Transit service alert",
      },
      recovery: {
        lineTarget: "Line {id}",
        routeTarget: "Route {id}",
        genericTarget: "Transit service",
        title: "✅ Service Resumed: {target}",
        body: "Normal service has resumed on {target}.",
      },
    },
  },
  "fr-CA": {
    notifications: {
      active: {
        lineTarget: "Ligne {id}",
        genericTarget: "Transport",
        title: "🚨 {target} : {alert}",
        fallbackTitle: "Alerte de transport",
        fallbackBody: "Alerte sur le service de transport.",
      },
      recovery: {
        lineTarget: "Ligne {id}",
        routeTarget: "Itinéraire {id}",
        genericTarget: "Service de transport",
        title: "✅ Service rétabli : {target}",
        body: "Le service normal a repris sur {target}.",
      },
    },
  },
} satisfies Record<UiLocale, LocaleMessages>;

export function getLocaleMessages(locale: UiLocale): LocaleMessages {
  return LOCALE_MESSAGES[locale];
}

export function formatLocaleMessage(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{([^}]+)\}/g, (placeholder, key: string) => values[key] ?? placeholder);
}
