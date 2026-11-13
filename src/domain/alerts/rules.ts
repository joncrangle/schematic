import type { AlertInterpretationRule } from "~/agencies/types";

export type AlertDirectionalScope = "eastbound" | "westbound" | "northbound" | "southbound";

export interface AlertDirectionalScopePattern {
  readonly scope: AlertDirectionalScope | "both";
  readonly patterns: readonly RegExp[];
}

export interface AlertLanguageCatalog {
  readonly baselineRules: readonly AlertInterpretationRule[];
  readonly equipmentKeywords: Readonly<Record<string, readonly string[]>>;
  /** Words after an equipment keyword that describe its status, not its name. */
  readonly equipmentNonIdentifierWords?: readonly string[];
  readonly stationSpanConnectors: readonly {
    readonly between: string;
    readonly separator: string;
  }[];
  /** Optional operator prose patterns used to infer a directional advisory scope. */
  readonly directionalScopePatterns?: readonly AlertDirectionalScopePattern[];
}

/** Protocol-level GTFS effect names and their normalized alert semantics. */
export const STRUCTURED_ALERT_EFFECTS: Readonly<Record<string, AlertInterpretationRule["result"]>> =
  {
    ACCESSIBILITY_ISSUE: { kind: "accessibility", severity: "normal" },
    NO_SERVICE: { kind: "suspension", severity: "severe" },
    REDUCED_SERVICE: { kind: "slow-service", severity: "degraded" },
    SIGNIFICANT_DELAYS: { kind: "delay", severity: "degraded" },
    DETOUR: { kind: "information", severity: "normal", serviceChange: "detour" },
    MODIFIED_SERVICE: { kind: "delay", severity: "degraded" },
    ADDITIONAL_SERVICE: { kind: "information", severity: "normal" },
  };

/** Numeric GTFS-Realtime effect enum values mapped to canonical names. */
export const NUMERIC_ALERT_EFFECTS: Readonly<Record<number, string>> = {
  1: "NO_SERVICE",
  2: "REDUCED_SERVICE",
  3: "SIGNIFICANT_DELAYS",
  4: "DETOUR",
  5: "ADDITIONAL_SERVICE",
  6: "MODIFIED_SERVICE",
  7: "OTHER_EFFECT",
  8: "UNKNOWN_EFFECT",
  11: "ACCESSIBILITY_ISSUE",
};

/** The canonical GTFS-RT effect name of a wire value, or undefined when it names none. */
export function alertEffectName(effect: string | number | undefined): string | undefined {
  const name = typeof effect === "number" ? NUMERIC_ALERT_EFFECTS[effect] : effect;
  if (!name) return undefined;
  return name
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
}

/**
 * Operator-language rules live in data keyed by BCP-47 language subtag.
 * Adding a language means registering its vocabulary here; interpretation
 * composes the matching catalogs with the default catalog without branching
 * on specific language names.
 */
export const ALERT_LANGUAGE_CATALOGS: Readonly<Record<string, AlertLanguageCatalog>> = {
  en: {
    baselineRules: [
      {
        priority: 250,
        match: {
          textIncludes: [
            "detour ended",
            "emergency detour ended",
            "stops have reopened",
            "stop has reopened",
            "road has reopened",
            "road reopened",
            "service resumed",
            "service has resumed",
            "regular service resumed",
          ],
        },
        result: { kind: "information", severity: "normal" },
      },
      {
        priority: 200,
        match: {
          textIncludes: [
            "no service",
            "suspended",
            "suspension",
            "service suspended",
            "route cancelled",
          ],
        },
        result: { kind: "suspension", severity: "severe" },
      },
      {
        priority: 150,
        match: { textIncludes: ["emergency detour", "emergency"] },
        result: { kind: "delay", severity: "degraded", serviceChange: "detour" },
      },
      {
        priority: 100,
        match: {
          textIncludes: [
            "detour",
            "detoured",
            "detouring",
            "bypass",
            "bypassed",
            "reroute",
            "rerouted",
            "rerouting",
            "divert",
            "diverted",
          ],
        },
        result: { kind: "information", severity: "normal", serviceChange: "detour" },
      },
    ],
    equipmentKeywords: {
      escalator: ["escalator"],
      elevator: ["elevator"],
    },
    equipmentNonIdentifierWords: ["out", "unavailable", "closed", "is", "in", "temporarily"],
    stationSpanConnectors: [{ between: "between", separator: "and" }],
    directionalScopePatterns: [
      {
        scope: "both",
        patterns: [
          /\bboth\s*directions\b/i,
          /\bin\s*both\b/i,
          /\b(?:east|west)\s*(?:[/-]|\band\b)\s*(?:west|east)(?:[\s-]*bound)?\b/i,
          /\b(?:north|south)\s*(?:[/-]|\band\b)\s*(?:south|north)(?:[\s-]*bound)?\b/i,
        ],
      },
      {
        scope: "eastbound",
        patterns: [
          /\beast[\s-]*bound\b/i,
          /\beb\b/i,
          /\b(?:heading|headed|traveling|travelling|moving|proceeding|toward|towards)\s+(?:to\s+)?(?:the\s+)?east\b/i,
          /\bin\s+(?:the\s+)?direction(?:\s+of)?\s+east\b/i,
          /^\s*east\s*[-–—:]\s*(?:(?:route|line)\s*)?\d+\b/i,
        ],
      },
      {
        scope: "westbound",
        patterns: [
          /\bwest[\s-]*bound\b/i,
          /\bwb\b/i,
          /\b(?:heading|headed|traveling|travelling|moving|proceeding|toward|towards)\s+(?:to\s+)?(?:the\s+)?west\b/i,
          /\bin\s+(?:the\s+)?direction(?:\s+of)?\s+west\b/i,
          /^\s*west\s*[-–—:]\s*(?:(?:route|line)\s*)?\d+\b/i,
        ],
      },
      {
        scope: "northbound",
        patterns: [
          /\bnorth[\s-]*bound\b/i,
          /\bnb\b/i,
          /\b(?:heading|headed|traveling|travelling|moving|proceeding|toward|towards)\s+(?:to\s+)?(?:the\s+)?north\b/i,
          /\bin\s+(?:the\s+)?direction(?:\s+of)?\s+north\b/i,
          /^\s*north\s*[-–—:]\s*(?:(?:route|line)\s*)?\d+\b/i,
        ],
      },
      {
        scope: "southbound",
        patterns: [
          /\bsouth[\s-]*bound\b/i,
          /\bsb\b/i,
          /\b(?:heading|headed|traveling|travelling|moving|proceeding|toward|towards)\s+(?:to\s+)?(?:the\s+)?south\b/i,
          /\bin\s+(?:the\s+)?direction(?:\s+of)?\s+south\b/i,
          /^\s*south\s*[-–—:]\s*(?:(?:route|line)\s*)?\d+\b/i,
        ],
      },
    ],
  },
  fr: {
    baselineRules: [
      {
        priority: 250,
        match: {
          textIncludes: [
            "service rétabli",
            "service rétablie",
            "service repris",
            "service reprise",
            "retour au service normal",
            "arrêt rouvert",
            "arrêts rouverts",
          ],
        },
        result: { kind: "information", severity: "normal" },
      },
      {
        priority: 200,
        match: {
          textIncludes: [
            "aucun service",
            "service interrompu",
            "suspendu",
            "suspendue",
            "suspendus",
            "suspendues",
            "suspension de service",
            "service annulé",
            "trajet annulé",
            "voyage annulé",
            "circuit annulé",
          ],
        },
        result: { kind: "suspension", severity: "severe" },
      },
      {
        priority: 150,
        match: { textIncludes: ["urgence", "déviation d'urgence"] },
        result: { kind: "delay", severity: "degraded", serviceChange: "detour" },
      },
      {
        priority: 125,
        match: { textIncludes: ["déviation", "dévié", "déviée", "déroutement"] },
        // Match the existing English baseline: a routine detour is informational.
        // Agency rules can still refine this for operators with different policy.
        result: { kind: "information", severity: "normal", serviceChange: "detour" },
      },
      {
        priority: 120,
        match: {
          textIncludes: ["retard", "retardé", "retardée", "ralenti", "ralentie", "ralentissement"],
        },
        result: { kind: "delay", severity: "degraded" },
      },
    ],
    equipmentKeywords: {
      // A bare escalier is an ordinary staircase; the qualifier identifies
      // powered equipment and keeps French station-access alerts out of this
      // category.
      escalator: ["escalier mécanique"],
      elevator: ["ascenseur", "élévateur"],
    },
    equipmentNonIdentifierWords: ["fermé", "fermée", "fermés", "fermées", "hors", "service"],
    stationSpanConnectors: [{ between: "entre", separator: "et" }],
    directionalScopePatterns: [
      {
        scope: "both",
        patterns: [
          /\bdans\s+les\s+deux\s+(?:sens|directions)\b/,
          /\b(?:nord|sud)\s*[-/]\s*(?:sud|nord)\b/,
          /\b(?:est|ouest)\s*[-/]\s*(?:ouest|est)\b/,
        ],
      },
      {
        scope: "eastbound",
        patterns: [
          /\ben\s+direction\s+(?:de\s+l['’])?est\b(?![-\u2010-\u2015]\p{L})/u,
          /\bvers\s+l['’]est\b(?![-\u2010-\u2015]\p{L})/u,
        ],
      },
      {
        scope: "westbound",
        patterns: [
          /\ben\s+direction\s+(?:de\s+l['’])?ouest\b(?![-\u2010-\u2015]\p{L})/u,
          /\bvers\s+l['’]ouest\b(?![-\u2010-\u2015]\p{L})/u,
        ],
      },
      {
        scope: "northbound",
        patterns: [
          /\ben\s+direction\s+(?:du\s+)?nord\b(?![-\u2010-\u2015]\p{L})/u,
          /\bvers\s+le\s+nord\b(?![-\u2010-\u2015]\p{L})/u,
        ],
      },
      {
        scope: "southbound",
        patterns: [
          /\ben\s+direction\s+(?:du\s+)?sud\b(?![-\u2010-\u2015]\p{L})/u,
          /\bvers\s+le\s+sud\b(?![-\u2010-\u2015]\p{L})/u,
        ],
      },
    ],
  },
};

/** Language catalog used when a feed does not identify its content language. */
export const DEFAULT_ALERT_LANGUAGE = "en";

export interface ComposedAlertLanguageData {
  readonly baselineRules: readonly AlertInterpretationRule[];
  readonly equipmentKeywords: Readonly<Record<string, readonly string[]>>;
  readonly equipmentNonIdentifierWords: readonly string[];
  readonly stationSpanConnectors: readonly {
    readonly between: string;
    readonly separator: string;
  }[];
  readonly directionalScopePatterns: readonly AlertDirectionalScopePattern[];
}

/**
 * Composes every registered alert-language catalog. Operator feeds can return
 * fallback or mixed-language text independently of the rider's UI locale, so
 * every configured vocabulary participates in safety classification.
 */
export function composeAlertLanguageData(): ComposedAlertLanguageData {
  const catalogs = [
    ALERT_LANGUAGE_CATALOGS[DEFAULT_ALERT_LANGUAGE],
    ...Object.entries(ALERT_LANGUAGE_CATALOGS)
      .filter(([language]) => language !== DEFAULT_ALERT_LANGUAGE)
      .map(([, catalog]) => catalog),
  ];
  const equipmentKeywords = new Map<string, string[]>();
  const equipmentNonIdentifierWords = new Set<string>();
  for (const catalog of catalogs) {
    for (const [type, words] of Object.entries(catalog.equipmentKeywords)) {
      const entries = equipmentKeywords.get(type) ?? [];
      for (const word of words) if (!entries.includes(word)) entries.push(word);
      equipmentKeywords.set(type, entries);
    }
    for (const word of catalog.equipmentNonIdentifierWords ?? []) {
      equipmentNonIdentifierWords.add(word);
    }
  }
  return {
    baselineRules: catalogs.flatMap((catalog) => catalog.baselineRules),
    equipmentKeywords: Object.fromEntries(equipmentKeywords),
    equipmentNonIdentifierWords: [...equipmentNonIdentifierWords],
    stationSpanConnectors: catalogs.flatMap((catalog) => catalog.stationSpanConnectors),
    directionalScopePatterns: catalogs.flatMap((catalog) => catalog.directionalScopePatterns ?? []),
  };
}

/** Default composed set retained for callers that consume baseline rules directly. */
export const BASELINE_ALERT_RULES: readonly AlertInterpretationRule[] =
  composeAlertLanguageData().baselineRules;

/** Default composed equipment vocabulary for callers without locale context. */
export const DEFAULT_EQUIPMENT_KEYWORDS = composeAlertLanguageData().equipmentKeywords;

/** Default composed station-span connectors for callers without locale context. */
export const STATION_SPAN_CONNECTORS = composeAlertLanguageData().stationSpanConnectors;
