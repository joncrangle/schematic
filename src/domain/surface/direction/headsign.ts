import { directionLabelFor } from "./compass";
import type { ParsedHeadsign } from "./types";

/**
 * Live-headsign parsing for Surface Transit. Pure domain logic.
 */

/**
 * The compass word an operator stated, in any of the headsign grammars feeds
 * actually use, or "" when they stated none.
 *
 * `parseHeadsign` only reads a label across a " - " separator, so a headsign
 * like "North to Steeles Ave" or a bare "Westbound to Brampton" yields no
 * label even though the operator plainly named the direction. That is safe
 * while a canonical literal fills the gap and unsafe once a stated headsign
 * outranks it: dropping the label there would discard a true direction the
 * operator gave us. So the leading segment before the first separator is read
 * as a compass word here, and only here.
 *
 * "Fairway Station", "301 Conestoga" and "51 HEREFORD EAST" state no leading
 * compass and return ""; their terminal is the rider-facing fact, and a
 * destination that merely contains a compass word ("East Mall") is not a
 * bearing, so only a leading segment is read.
 */
export function statedCompassLabel(headsign: string): string {
  const trimmed = headsign.trim();
  if (!trimmed) return "";
  const leading = trimmed.split(/ - | — | → | to | towards |, /i)[0] ?? "";
  return directionLabelFor(leading);
}

/**
 * Parses a live headsign string into label + destination.
 * Examples:
 *   "North, 97 Yonge to Steeles Ave"  → { label: "Northbound", destination: "Steeles Ave" }
 *   "East - 504 King to Dundas West Station" → { label: "Eastbound", destination: "Dundas West Station" }
 * Falls back to generic direction when parsing fails.
 *
 * The resulting label feeds Directional Scope interpretation for advisories
 * (see GLOSSARY.md SurfaceAlert "Directional Scope").
 */
export function parseHeadsign(headsign: string): ParsedHeadsign {
  if (!headsign) return { label: "", destination: "" };

  // Extract direction prefix before " - " or ", "
  const dashIdx = headsign.indexOf(" - ");
  const emDashIdx = headsign.indexOf(" — ");
  const sepIdx = dashIdx !== -1 ? dashIdx : emDashIdx;

  // Arrow grammar ("North → North Terminal", produced by
  // inferRouteHeadsign's live-config fallback): the arrow splits direction
  // from destination verbatim, so the terminal text survives parsing.
  if (sepIdx === -1) {
    const arrowIdx = headsign.indexOf(" → ");
    if (arrowIdx !== -1) {
      return {
        label: directionLabelFor(headsign.slice(0, arrowIdx)),
        destination: headsign.slice(arrowIdx + 3).trim(),
      };
    }
  }

  // Separator-required grammar (behavior freeze): a direction
  // label is only inferred across a " - "/", " separator (or the " → "
  // fallback above). Without a separator the whole string participates only
  // in destination extraction, no label is inferred from a leading compass
  // word, so "North to Steeles Ave" yields no label.
  let label = "";
  let rest: string;
  if (sepIdx !== -1) {
    label = directionLabelFor(headsign.slice(0, sepIdx));
    rest = headsign.slice(sepIdx + 3);
  } else {
    rest = headsign;
  }

  // Extract destination after "to" or "towards", one lowercase pass.
  let destination = "";

  const lowerRest = rest.toLowerCase();
  const toIdx = lowerRest.lastIndexOf(" to ");
  const towardsIdx = lowerRest.lastIndexOf(" towards ");
  const splitIdx = Math.max(toIdx, towardsIdx);

  if (splitIdx !== -1) {
    // " towards " = 9 chars, " to " = 4 chars
    const skipLen = splitIdx === towardsIdx ? 9 : 4;
    destination = rest.slice(splitIdx + skipLen).trim();
  }

  return { label, destination };
}

const BARE_DIRECTION = /^(?:north|south|east|west|nord|sud|est|ouest)(?:bound)?$/i;
const NOT_IN_SERVICE = /^(?:fin de service|hors service|not in service|out of service)$/i;

/** The place a static headsign names, or undefined for a route number, bare direction or placeholder. */
export function scheduledHeadsignDestination(
  headsign: string | undefined,
  routeId: string | undefined,
): string | undefined {
  let text = (headsign?.trim() ?? "").replace(/^\d+[A-Za-z]?\s+/, "");
  if (routeId && text.toLowerCase().startsWith(`${routeId.toLowerCase()} `))
    text = text.slice(routeId.length).trim();
  text = parseHeadsign(text).destination || text;
  if (!text || /^\d+$/.test(text) || BARE_DIRECTION.test(text) || NOT_IN_SERVICE.test(text))
    return undefined;
  if (routeId && text.toLowerCase() === routeId.toLowerCase()) return undefined;
  return text;
}
