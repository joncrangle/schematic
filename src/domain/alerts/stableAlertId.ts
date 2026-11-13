function stableJson(value: unknown): string {
  if (typeof value === "number") return JSON.stringify(String(value));
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * A compact cross-language FNV-1a id for alerts whose source has no id.
 * Rust twins use the same sorted JSON representation and 64-bit hash.
 */
export function stableAlertFallbackId(
  namespace: string,
  sourceScope: string,
  content: unknown,
): string {
  const input = new TextEncoder().encode(`${sourceScope}\u0000${stableJson(content)}`);
  let high = 0xcbf29ce4;
  let low = 0x84222325;
  for (let index = 0, length = input.length; index < length; index++) {
    const byte = input[index]!;
    low = (low ^ byte) >>> 0;
    const product = low * 0x1b3;
    high = (high * 0x1b3 + Math.floor(product / 0x100000000) + ((low << 8) >>> 0)) >>> 0;
    low = product >>> 0;
  }
  const hash = `${high.toString(16).padStart(8, "0")}${low.toString(16).padStart(8, "0")}`;
  return `${namespace}-${hash}`;
}
