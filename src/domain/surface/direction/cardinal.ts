/** Canonical compass words; a cardinal direction never implies a GTFS direction index. */
export function normalizeCardinalDirection(value: string): string | undefined {
  const word = value.trim().toLowerCase();
  if (["n", "north", "nord"].includes(word)) return "north";
  if (["s", "south", "sud"].includes(word)) return "south";
  if (["e", "east", "est"].includes(word)) return "east";
  if (["w", "west", "ouest"].includes(word)) return "west";
  return undefined;
}
