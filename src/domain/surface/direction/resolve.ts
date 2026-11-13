import { directionIdForLabel, directionLabelFor } from "./compass";

/**
 * Three-tier direction-id resolution grammar.
 *
 * Single home for resolving a raw NextBus direction tag / compass text into
 * the feed's direction ID. Core's default is 0 = East/North, 1 = West/South.
 * Pure logic.
 */

/**
 * Resolves a raw NextBus direction tag / compass text into the feed's
 * direction ID. Compass words use Core's canonical mapping unless the caller
 * declares inverted north/south feed IDs. Structured numeric tags remain raw.
 * This is the single home for the three-tier resolution grammar:
 *
 * 1. Structured NextBus tags ("504_0_504A", "504_1_BRDW", "dir=0", …).
 * 2. Leading compass prefix on title/name text ("East - 504a King").
 * 3. Word-boundary compass scan, where a lone west/south word beats a
 *    conflicting east/north word only when unopposed.
 *
 * Falls back to `fallbackIndex` when nothing resolves.
 */
export function resolveDirectionId(
  tag?: string,
  nameOrTitle?: string,
  fallbackIndex: 0 | 1 = 0,
  options: { readonly invertNorthSouth?: boolean } = {},
): 0 | 1 {
  const normalizedTag = (tag || "").toLowerCase();
  const normalizedText = (nameOrTitle || "").toLowerCase().trim();
  const idForCompass = (word: string): 0 | 1 | undefined => {
    const canonical = directionLabelFor(word);
    return directionIdForLabel(canonical, options.invertNorthSouth);
  };

  // Tier 1: NextBus structured direction tags (e.g. 504_0_504A, 504_1_BRDW)
  if (
    normalizedTag.includes("_0_") ||
    normalizedTag.endsWith("_0") ||
    normalizedTag.startsWith("0_") ||
    normalizedTag.includes("_d0") ||
    normalizedTag.includes("dir0") ||
    normalizedTag.includes("dir=0")
  ) {
    return 0;
  }

  if (
    normalizedTag.includes("_1_") ||
    normalizedTag.endsWith("_1") ||
    normalizedTag.startsWith("1_") ||
    normalizedTag.includes("_d1") ||
    normalizedTag.includes("dir1") ||
    normalizedTag.includes("dir=1")
  ) {
    return 1;
  }

  // Tier 2: Prefix matching on title/name (e.g. "East - 504a King", "West - 504b King")
  const leadingWord = normalizedText.match(
    /^(northbound|southbound|eastbound|westbound|north|south|east|west)\b/,
  )?.[1];
  if (leadingWord) {
    const directionId = idForCompass(leadingWord);
    if (directionId !== undefined) return directionId;
  }

  // Tier 3: Word-boundary matching
  const hasWestSouth = /\b(west|south|westbound|southbound)\b/i.test(normalizedText);
  const hasEastNorth = /\b(east|north|eastbound|northbound)\b/i.test(normalizedText);

  if (hasWestSouth && !hasEastNorth) {
    const southId = idForCompass("south");
    return /\bwest(?:bound)?\b/i.test(normalizedText) ? 1 : (southId ?? 1);
  }
  if (hasEastNorth && !hasWestSouth) {
    const northId = idForCompass("north");
    return /\beast(?:bound)?\b/i.test(normalizedText) ? 0 : (northId ?? 0);
  }

  return fallbackIndex;
}
