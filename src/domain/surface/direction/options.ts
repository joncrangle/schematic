import type { RouteInterpretationConfig } from "~/agencies";
import type { SurfaceRouteType } from "../types";
import {
  directionLabelFor,
  directionSemanticForCanonicalLabel,
  directionSemanticForPath,
  generatedDirectionLabelText,
  oppositeDirectionLabel,
} from "./compass";
import { decodePolyline } from "~/domain/map/MapGeometry";
import { parseHeadsign, statedCompassLabel } from "./headsign";
import type {
  DirectionAxis,
  GeneratedDirectionLabel,
  ParsedHeadsign,
  RouteDirectionOption,
} from "./types";

/**
 * Direction options and labels for Surface Transit.
 *
 * Canonical per-route-type direction pairs, live-headsign enrichment, and
 * the single-homed server label derivation (D4). Pure domain logic.
 */

/**
 * Derives the route's direction axis from agency directionInference policy.
 * Precedence: routeOverrides[routeId] ?? default.
 */
export function resolveDirectionAxis(
  routeId: string,
  policy?: RouteInterpretationConfig,
): DirectionAxis | undefined {
  return (
    policy?.directionInference?.routeOverrides?.[routeId] ?? policy?.directionInference?.default
  );
}

/** Whether this route's north/south direction IDs use the reversed feed order. */
export function isNorthSouthDirectionIdsInverted(
  routeId: string,
  policy?: RouteInterpretationConfig,
): boolean {
  return (
    resolveDirectionAxis(routeId, policy) === "north-south" &&
    policy?.directionInference?.invertNorthSouth === true
  );
}

/** Resolve the display pair using the route's declared axis and feed polarity. */
export function getRouteDirectionsForRoute(
  routeType: SurfaceRouteType = "bus",
  routeId: string,
  policy?: RouteInterpretationConfig,
): readonly [RouteDirectionOption, RouteDirectionOption] {
  const axis = resolveDirectionAxis(routeId, policy);
  return getRouteDirections(routeType, axis, isNorthSouthDirectionIdsInverted(routeId, policy));
}

/**
 * Returns the two canonical directional options for a surface route.
 * Falls back to generic labels based on axis or route type, live headsign provides real destination.
 */
export function getRouteDirections(
  routeType: SurfaceRouteType = "bus",
  axis?: DirectionAxis,
  invertNorthSouth = false,
): readonly [RouteDirectionOption, RouteDirectionOption] {
  // The axis vocabulary, named once. Every branch below picks a pair from this
  // map rather than restating two labels, so a word added here reaches every
  // caller instead of only the branch someone remembered to update.
  const PAIR_BY_AXIS: Readonly<Record<string, readonly [string, string]>> = {
    "east-west": ["Eastbound", "Westbound"],
    "north-south": ["Northbound", "Southbound"],
  };

  // A declared axis overrides whatever the route type implies, and rail keeps
  // its terminal vocabulary only where the operator declared no axis.
  const declaredAxis = axis ? PAIR_BY_AXIS[axis] : undefined;
  if (routeType === "rail" && !declaredAxis) {
    // Rail keeps terminal vocabulary, and only where the operator has not
    // stated a bearing. `buildDirectionLabels` overrides both fields for every
    // direction the feed does describe, so these two literals stand only for a
    // direction nothing was said about.
    return [
      { directionId: 0, label: "Outbound", destination: "", generatedLabel: "outbound" },
      { directionId: 1, label: "Inbound", destination: "", generatedLabel: "inbound" },
    ];
  }

  const canonicalPair =
    declaredAxis ?? PAIR_BY_AXIS[routeType === "streetcar" ? "east-west" : "north-south"];
  const pair =
    axis === "north-south" && invertNorthSouth
      ? ([canonicalPair[1], canonicalPair[0]] as const)
      : canonicalPair;
  return [
    {
      directionId: 0,
      label: pair[0],
      destination: "",
      generatedLabel: directionSemanticForCanonicalLabel(pair[0]),
    },
    {
      directionId: 1,
      label: pair[1],
      destination: "",
      generatedLabel: directionSemanticForCanonicalLabel(pair[1]),
    },
  ];
}

/**
 * Enriches a list of base route direction options with live headsign/destination labels.
 */
export function enrichRouteDirections(
  base: readonly RouteDirectionOption[],
  directionLabels?: Record<number, ParsedHeadsign>,
): RouteDirectionOption[] {
  if (!directionLabels || Object.keys(directionLabels).length === 0) {
    return [...base];
  }

  // Every labelled direction is an option, not only those already in `base`:
  // the canonical pair supplies 0/1, but a route can declare a group per
  // headsign and so more than two.
  //
  // A supplied entry is authoritative in both fields, not merged per field. An
  // empty label is a decision, not a gap: the operator stated a terminal and no
  // bearing, so backfilling "Northbound" reintroduced the very compass word
  // the empty label exists to withhold.
  const enriched = base.map((d) => {
    const fields = directionLabels[d.directionId];
    if (fields) {
      const { generatedLabel: _generatedLabel, ...current } = d;
      return {
        ...current,
        label: fields.label,
        destination: fields.destination,
        ...(fields.generatedLabel ? { generatedLabel: fields.generatedLabel } : {}),
      };
    }
    return d;
  });
  const present = new Set(base.map((d) => d.directionId));
  for (const [rawDirectionId, fields] of Object.entries(directionLabels)) {
    const directionId = Number(rawDirectionId);
    if (!Number.isInteger(directionId) || present.has(directionId)) continue;
    present.add(directionId);
    enriched.push({
      directionId,
      label: fields.label,
      destination: fields.destination,
      ...(fields.generatedLabel ? { generatedLabel: fields.generatedLabel } : {}),
    });
  }
  return enriched;
}

/**
 * Merges parsed live-headsign fields onto an existing label/destination pair
 * (or full direction option), falling back per-field to the current values.
 * Shared by enrichRouteDirections and callers composing single-headsign
 * fallbacks.
 */
export function applyParsedHeadsign<
  T extends {
    readonly label: string;
    readonly destination: string;
    readonly generatedLabel?: GeneratedDirectionLabel;
  },
>(
  current: T,
  parsed: ParsedHeadsign,
): Omit<T, "label" | "destination" | "generatedLabel"> & ParsedHeadsign {
  const {
    label: currentLabel,
    destination: currentDestination,
    generatedLabel: currentGeneratedLabel,
    ...currentFields
  } = current;
  return {
    ...currentFields,
    label: parsed.label || currentLabel,
    destination: parsed.destination || currentDestination,
    ...(parsed.label
      ? parsed.generatedLabel
        ? { generatedLabel: parsed.generatedLabel }
        : {}
      : currentGeneratedLabel
        ? { generatedLabel: currentGeneratedLabel }
        : {}),
  };
}

/**
 * Resolves the rendered direction options for a surface route from whatever
 * live facts are available:
 *
 * 1. A per-direction labels map from the tracking payload (correct for BOTH
 *    directions) wins outright, enriched via enrichRouteDirections.
 * 2. Otherwise a single live headsign enriches the active direction; with
 *    inferOppositeDirection, the other direction's label is inferred as the
 *    opposite compass direction (RouteControls behavior). Without it, only
 *    the active direction is touched (LinearStopStrip behavior).
 * 3. With no live facts at all, canonical base options pass through.
 *
 * The opposite-label inference targets every non-active entry because
 * surface routes are canonically two-directional (getRouteDirections always
 * returns a 2-tuple); with exactly one non-active direction this is the
 * opposite by construction.
 */
export function buildDirectionOptions(params: {
  base: readonly RouteDirectionOption[];
  directionLabels?: Record<number, ParsedHeadsign>;
  headsign?: string;
  activeDirectionId?: number;
  inferOppositeDirection?: boolean;
}): RouteDirectionOption[] {
  const { base, directionLabels, headsign, activeDirectionId, inferOppositeDirection } = params;

  if (directionLabels && Object.keys(directionLabels).length > 0) {
    return enrichRouteDirections(base, directionLabels);
  }

  if (headsign) {
    const parsed = parseHeadsign(headsign);
    if (parsed.label || parsed.destination) {
      const oppositeLabel =
        inferOppositeDirection && parsed.label ? oppositeDirectionLabel(parsed.label) : "";
      return base.map((d) => {
        if (d.directionId === activeDirectionId) {
          return applyParsedHeadsign(d, parsed);
        }
        if (oppositeLabel) {
          return {
            ...d,
            label: oppositeLabel,
            generatedLabel: directionSemanticForCanonicalLabel(oppositeLabel),
          };
        }
        return d;
      });
    }
  }

  return [...base];
}

/**
 * Infers a display headsign for a route direction when no live config is
 * available: "X → X Terminal" from the canonical direction labels for the
 * route type.
 */
export function inferRouteHeadsign(
  directionId: number,
  routeType: SurfaceRouteType,
  axis?: DirectionAxis,
  invertNorthSouth = false,
): string {
  const dirs = getRouteDirections(routeType, axis, invertNorthSouth);
  const matched = dirs.find((d) => d.directionId === directionId);
  if (matched) {
    const dirLabel = matched.label.replace("bound", "");
    return `${dirLabel} → ${matched.destination}`;
  }

  if (routeType === "streetcar") {
    return directionId === 0 ? "East → East Terminal" : "West → West Terminal";
  }
  return directionId === 0 ? "North → North Terminal" : "South → South Terminal";
}

/**
 * Single-homed direction label derivation.
 *
 * Unifies the two server direction-label derivations. Given a routeType and a per-direction
 * details map, returns a Record keyed by directionId with label + destination for
 * every direction the agency declared, plus 0/1 so a caller can still read the
 * canonical fallback literals.
 *
 * `detailsByDir` is a per-direction details map. The label is a bearing the
 * operator stated and the destination is the terminal, and the two are separate
 * facts, so a card reads "Eastbound → Steeles Ave" when both are known and
 * "→ Steeles Ave" when only the terminal is. Where the feed states no bearing
 * the direction is omitted rather than filled from the canonical literal in
 * `getRouteDirections`, because that literal is our guess about an axis the
 * operator never claimed, and its rail pair is terminal vocabulary that means
 * nothing away from a terminal.
 */
export function buildDirectionLabels(
  detailsByDir: ReadonlyMap<number, { shape: { headsign: string; polyline?: string } }>,
  routeShortName?: string,
): Record<
  number,
  { label: string; destination: string; generatedLabel?: GeneratedDirectionLabel }
> {
  // A route can declare more directions than 0/1, one per way of travel, so
  // every direction the feed states gets its own row. The canonical pair is
  // included regardless because callers ask for 0 and 1 by name.
  const dirIds = new Set<number>([...detailsByDir.keys(), 0, 1]);
  const result: Record<
    number,
    { label: string; destination: string; generatedLabel?: GeneratedDirectionLabel }
  > = {};
  for (const dirId of dirIds) {
    // An absent entry parses identically to an empty headsign, so both fall
    // through the same path.
    const headsign = detailsByDir.get(dirId)?.shape.headsign ?? "";
    const parsed = parseHeadsign(headsign);
    const destination = parsed.destination || inferDestination(headsign, routeShortName);
    // Three sources for the direction, in order of how directly the operator
    // stated it. A bearing in the headsign is their own words. Failing that the
    // shape's own geometry is: a shape runs first point to last point in the
    // direction the vehicle travels, so its endpoint bearing is a real bearing
    // rather than a guess about an axis. Only when the feed gives neither is the
    // direction left out, because the canonical literal would be our invention
    // and "Outbound"/"Inbound" is terminal vocabulary that is wrong elsewhere.
    const shapeLabel = directionSemanticForPath(
      decodePolyline(detailsByDir.get(dirId)?.shape.polyline ?? ""),
    );
    const statedLabel = parsed.label || statedCompassLabel(headsign);
    result[dirId] = {
      label: statedLabel || (shapeLabel ? generatedDirectionLabelText(shapeLabel) : ""),
      ...(statedLabel || !shapeLabel ? {} : { generatedLabel: shapeLabel }),
      // Every canonical entry declares an empty destination, so a fallback
      // destination could never contribute here. A future one has to be stated
      // deliberately rather than arriving through an unread variable.
      destination,
    };
  }
  return result;
}

/**
 * GTFS headsigns commonly contain a terminal without compass language
 * (e.g. "Fairway Station" or "301 Conestoga").
 *
 * If a route short name or leading route number prefix is present, it is stripped;
 * the remainder is the rider-facing destination.
 */
export function inferDestination(headsign: string, routeShortName?: string): string {
  const trimmed = headsign.trim();
  if (!trimmed) return "";

  // If headsign has a leading compass direction prefix (e.g. "East — 504 King"),
  // and parseHeadsign found no destination, the rest is just route name/number,
  // not a destination terminal.
  const dashIdx = trimmed.indexOf(" - ");
  const emDashIdx = trimmed.indexOf(" — ");
  const sepIdx = dashIdx !== -1 ? dashIdx : emDashIdx;
  if (sepIdx !== -1) {
    const prefix = trimmed.slice(0, sepIdx).trim();
    if (directionLabelFor(prefix)) {
      return "";
    }
  }

  // Bare compass word (e.g. "North") is a direction, not a destination.
  if (directionLabelFor(trimmed)) {
    return "";
  }

  const shortName = routeShortName?.trim();
  if (shortName && trimmed.slice(0, shortName.length).toUpperCase() === shortName.toUpperCase()) {
    const after = trimmed.slice(shortName.length);
    // Only strip when the short name stands alone. GO names a route "18" but
    // headsigns its branches "18A - Union Station", where the trailing letter
    // is part of the name, not a prefix to remove: stripping there yielded the
    // destination "A - Union Station". The branch variant falls through to the
    // separator grammar below, which recovers "Union Station" whole.
    if (/^[A-Za-z0-9]/.test(after)) {
      const branchSep = after.search(/[\s\-–—:]/);
      if (branchSep === -1) return "";
      const branchRemainder = after
        .slice(branchSep)
        .replace(/^\s*(?:[-–—:]\s*)?/, "")
        .trim();
      if (branchRemainder) return branchRemainder.replace(/^express\s+/i, "");
      return "";
    }
    const remainder = after.replace(/^\s*(?:[-–—:]\s*)?/, "").trim();
    if (remainder) return remainder.replace(/^express\s+/i, "");
  }

  // A route-prefixed headsign still yields a useful terminal when callers do
  // not have the short name at this seam (e.g. "LW - Aldershot GO").
  if (sepIdx > 0) {
    const prefix = trimmed.slice(0, sepIdx).trim();
    const remainder = trimmed.slice(sepIdx + 3).trim();
    if (/^[A-Za-z0-9]+$/.test(prefix)) return remainder;
  }

  // If headsign begins with a route number followed by a space (e.g. "301 Conestoga")
  const leadingRouteMatch = trimmed.match(/^([0-9]+[A-Za-z]?)\s+(.+)$/);
  if (leadingRouteMatch) {
    return leadingRouteMatch[2].trim();
  }

  return trimmed;
}
