import type { AgencyAlert, RouteIdNormalization } from "~/agencies/types";
import {
  composeAlertLanguageData,
  type AlertDirectionalScope,
  type AlertDirectionalScopePattern,
} from "~/domain/alerts/rules";
import { normalizeRouteId } from "~/domain/routeId";
import { SEVERITY_RANK } from "~/domain/severity";

/**
 * Surface route alert presentation severity.
 *
 * Semantics follow the GLOSSARY.md surface-transit taxonomy:
 * - `severe`   -> route suspension, line cancellation, major corridor detour (Red #ef4444)
 * - `degraded` -> traffic congestion delay, minor short turn, stop relocation (Amber #f59e0b)
 */
export type SurfaceAlertSeverityKind = "severe" | "degraded";

export const SURFACE_SEVERE_COLOR = "#ef4444";
export const SURFACE_DEGRADED_COLOR = "#f59e0b";

const normalizeAlertText = (alert: Pick<AgencyAlert, "title" | "description">): string =>
  `${alert.title || ""} ${alert.description || ""}`
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

export interface SurfaceAlertPresentation {
  readonly severity: SurfaceAlertSeverityKind;
  /** Exact semantic color (#ef4444 severe / #f59e0b degraded). */
  readonly color: string;
  /** Collapsed pill/chip label: "Detour" or "Delay". */
  readonly label: "Detour" | "Delay";
  /** Numeric rank for severity sorting (2 severe > 1 degraded). */
  readonly rank: number;
}

/**
 * Directional advisory scope parsed from alert text heuristics.
 * Defaults to `both` when no direction is mentioned so opposite-direction
 * advisories are never dropped.
 */
export type DirectionalScope = AlertDirectionalScope | "both";

/**
 * Projects an already interpreted alert into surface presentation. The source
 * adapter/interpreter owns all semantic classification; this function never
 * re-parses operator prose.
 */
export function classifySurfaceAlert(
  alert: Pick<AgencyAlert, "kind" | "severity" | "serviceChange">,
): SurfaceAlertPresentation {
  const structuredSevere = alert.severity === "severe" || alert.kind === "suspension";
  const isDetour = alert.serviceChange === "detour";

  return {
    severity: structuredSevere ? "severe" : "degraded",
    color: structuredSevere ? SURFACE_SEVERE_COLOR : SURFACE_DEGRADED_COLOR,
    label: isDetour ? "Detour" : "Delay",
    rank: structuredSevere ? SEVERITY_RANK.severe : SEVERITY_RANK.degraded,
  };
}

const DIRECTIONAL_SCOPE_PATTERNS: readonly AlertDirectionalScopePattern[] =
  composeAlertLanguageData().directionalScopePatterns;

const matchesAny = (text: string, patterns: readonly RegExp[]): boolean =>
  patterns.some((pattern) => {
    // Catalog patterns are shared across alert evaluations, so normalize
    // stateful flags before matching to keep every call deterministic.
    const matcher =
      pattern.global || pattern.sticky
        ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""))
        : pattern;
    return matcher.test(text);
  });

/**
 * Parses the directional scope of a surface alert from its text.
 * Both compass directions (or explicit "both directions") yield "both";
 * an unspecified direction also defaults to "both" so no advisory is dropped.
 */
export function parseDirectionalScope(
  alert: Pick<AgencyAlert, "title" | "description">,
): DirectionalScope {
  const text = normalizeAlertText(alert);

  if (
    DIRECTIONAL_SCOPE_PATTERNS.some(
      (rule) => rule.scope === "both" && matchesAny(text, rule.patterns),
    )
  ) {
    return "both";
  }

  const matched = new Set<Exclude<DirectionalScope, "both">>();
  for (const rule of DIRECTIONAL_SCOPE_PATTERNS) {
    if (rule.scope !== "both" && matchesAny(text, rule.patterns)) {
      matched.add(rule.scope);
    }
  }

  const hasEastWest = matched.has("eastbound") && matched.has("westbound");
  const hasNorthSouth = matched.has("northbound") && matched.has("southbound");
  if (hasEastWest || hasNorthSouth) {
    return "both";
  }

  if (matched.size === 1) {
    return [...matched][0];
  }

  return "both";
}

/**
 * Formats a directional scope as the display chip label,
 * e.g. `[Eastbound]` or `[Both Directions]`. Derived from the scope name so
 * the canonical compass vocabulary lives in one place (direction seam).
 */
export function formatDirectionalChip(scope: DirectionalScope): string {
  if (scope === "both") return "[Both Directions]";
  const word = scope[0].toUpperCase() + scope.slice(1);
  return `[${word}]`;
}

/**
 * Sorts surface alerts for display: most severe first, then most recently updated.
 */
export function sortSurfaceAlerts(alerts: readonly AgencyAlert[]): readonly AgencyAlert[] {
  return [...alerts].sort((a, b) => {
    const rankA = classifySurfaceAlert(a).rank;
    const rankB = classifySurfaceAlert(b).rank;
    if (rankA !== rankB) return rankB - rankA;
    return b.updatedAt - a.updatedAt;
  });
}

/**
 * Pure collapse/expand state derivation: toggles an alert id inside an
 * immutable expanded-ids set (used by banner and pill accordions).
 */
export function toggleAlertId(
  expandedIds: ReadonlySet<string>,
  alertId: string,
): ReadonlySet<string> {
  const next = new Set(expandedIds);
  if (next.has(alertId)) {
    next.delete(alertId);
  } else {
    next.add(alertId);
  }
  return next;
}

/**
 * Escapes a string for literal (non-pattern) use inside a RegExp.
 * Single home for this helper, shared by every dynamic-pattern site.
 */
export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Bounded get-or-compile cache for dynamic regex patterns. Inputs are
 * escaped internally; the factory receives the escaped key. The cache resets
 * at the entry bound so arbitrary user input cannot grow it without limit —
 * recompiling after a reset is cheap relative to matching.
 */
export function createPatternCache(
  buildFromEscaped: (escapedKey: string) => RegExp,
  maxEntries = 512,
): (rawInput: string) => RegExp {
  const cache = new Map<string, RegExp>();
  return (rawInput: string) => {
    const key = escapeRegExp(rawInput);
    let pattern = cache.get(key);
    if (!pattern) {
      if (cache.size >= maxEntries) cache.clear();
      pattern = buildFromEscaped(key);
      cache.set(key, pattern);
    }
    return pattern;
  };
}

// Compiled non-digit-boundary matchers for route-number tokens: "25" never
// matches inside "125 Don Mills Rd", "6" never inside "506/106", while a
// route number at end-of-string ("...on the 25") still matches. Route ids
// are a small finite set, so hot loops (alert evaluation) never recompile.
const routeTokenPattern = createPatternCache((key) => new RegExp(`(^|\\D)${key}(\\D|$)`, "i"));

/**
 * Text-pattern matcher linking alerts to a surface route for ROUTE CHIPS and
 * banners. Alerts carrying structured `routeIds` attribution (populated at
 * ingest from informedEntity.route_id / live-alerts `route`) match ONLY
 * through that attribution, title/description text is never consulted, so
 * non-surface advisories mentioning unrelated numbers cannot leak into a
 * route chip. Stored tokens are compared exactly: ingest owns their
 * normalization (normalizeRouteIdList at every ingest point), while this
 * matcher normalizes only its own routeId argument. Unattributed alerts fall
 * back to the text heuristic: the route number (prefixed, "route N", or with
 * a mode suffix) matched against title/description. Accessibility and station
 * equipment outage alerts (elevators, escalators) are excluded either way so
 * Surface Transit cards only display direct SurfaceAlert disruptions (see
 * GLOSSARY.md "SurfaceAlert" taxonomy).
 *
 * For favourite/notification matching use matchAlertsForSubscribedRoute,
 * which trades some of this precision for recall.
 */
export function matchAlertsForRoute(
  routeId: string,
  alerts: readonly AgencyAlert[],
  routeIdNormalization?: RouteIdNormalization,
): readonly AgencyAlert[] {
  return matchRouteAlerts(routeId, alerts, false, routeIdNormalization);
}

/**
 * Text-pattern matcher linking alerts to a user's SUBSCRIBED surface route
 * during push-notification evaluation. Structured attribution is consulted
 * first (same exact-token contract as matchAlertsForRoute), but an
 * attribution MISS falls through to the title/description heuristic: a
 * severe advisory mis-attributed at ingest must still reach a subscriber
 * whose favourited route appears only in its text.
 *
 * NOT for chips or banners, those surfaces keep matchAlertsForRoute's
 * strict-attribution semantics. Only favourite/notification matching
 * (doesAlertMatchSubscription) may call this; accessibility/equipment
 * exclusions apply on both paths.
 */
export function matchAlertsForSubscribedRoute(
  routeId: string,
  alerts: readonly AgencyAlert[],
  routeIdNormalization?: RouteIdNormalization,
): readonly AgencyAlert[] {
  return matchRouteAlerts(routeId, alerts, true, routeIdNormalization);
}

/**
 * Shared matcher core behind both public variants. `rescueAttributionMiss`
 * selects the policy: false = chip/banner strictness (an attribution miss
 * never text-matches), true = notification recall (a miss consults
 * title/description text).
 */
function matchRouteAlerts(
  routeId: string,
  alerts: readonly AgencyAlert[],
  rescueAttributionMiss: boolean,
  routeIdNormalization?: RouteIdNormalization,
): readonly AgencyAlert[] {
  const matching: AgencyAlert[] = [];
  const routeNum = normalizeRouteId(routeId, routeIdNormalization);
  if (!routeNum) return matching;

  const bareToken = routeTokenPattern(routeNum);
  const labeled = `route ${routeNum.toLowerCase()}`;

  for (const alert of alerts) {
    if (alert.lifecycle !== "active" || alert.kind === "upcoming") {
      continue;
    }

    // Exclude accessibility alerts (which carry station equipment outages —
    // elevators, escalators, by construction of every provider's ingest
    // pipeline) from surface route alerts
    if (alert.kind === "accessibility") {
      continue;
    }

    // Trip-level notices name a small set of departures. Resolve their route
    // from static trip data at ingest; never infer it from clock times or prose.
    if (alert.scope === "trip") {
      if (alert.affectedRouteIds?.includes(routeNum)) matching.push(alert);
      continue;
    }

    // Structured attribution is consulted first on every path: exact
    // equality against stored tokens, they are already normalized by the
    // ingest contract on AgencyAlert.affectedRouteIds. On the strict path a miss ends
    // the alert's candidacy; on the notification path it falls through to
    // the text heuristic below.
    if (alert.affectedRouteIds && alert.affectedRouteIds.length > 0) {
      if (alert.affectedRouteIds.includes(routeNum)) {
        matching.push(alert);
        continue;
      }
      if (!rescueAttributionMiss) {
        continue;
      }
    }

    const text = `${alert.title} ${alert.description || ""}`.toLowerCase();

    // Secondary text safety check for elevator/escalator outages
    if (
      text.includes("elevator") ||
      text.includes("escalator") ||
      text.includes("accessibility alert")
    ) {
      continue;
    }

    if (bareToken.test(text) || text.includes(labeled)) {
      matching.push(alert);
    }
  }

  return matching;
}
