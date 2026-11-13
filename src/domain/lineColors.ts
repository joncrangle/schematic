export interface LineMetadata {
  readonly id: string;
  readonly name: string;
  readonly color: string;
}

/** Looks up line presentation data from the caller's agency schematic. */
function lineMetaFor(lineId: string, lines?: readonly LineMetadata[]): LineMetadata | undefined {
  return lines?.find((candidate) => candidate.id === lineId);
}

export function lineColorFor(lineId: string, lines?: readonly LineMetadata[]): string | undefined {
  return lineMetaFor(lineId, lines)?.color;
}

export function lineNameFor(lineId: string, lines?: readonly LineMetadata[]): string | undefined {
  return lineMetaFor(lineId, lines)?.name;
}

export function contrastTextColorForLine(hex: string): string {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.55 ? "#000000" : "#ffffff";
}
