/** A branch shares junction identities with the main sequence. */
export function sequenceBetween(
  sequences: readonly (readonly string[])[],
  from: string,
  to: string,
): readonly string[] {
  if (sequences.length === 1) {
    const sequence = sequences[0];
    const start = sequence.indexOf(from);
    const end = sequence.indexOf(to);
    return start < 0 || end < 0
      ? []
      : sequence.slice(Math.min(start, end), Math.max(start, end) + 1);
  }
  const neighbours = new Map<string, Set<string>>();
  for (const sequence of sequences) {
    for (let i = 0; i < sequence.length; i += 1) {
      const id = sequence[i];
      const adjacent = neighbours.get(id) ?? new Set<string>();
      if (i > 0) adjacent.add(sequence[i - 1]);
      if (i + 1 < sequence.length) adjacent.add(sequence[i + 1]);
      neighbours.set(id, adjacent);
    }
  }
  if (!neighbours.has(from) || !neighbours.has(to)) return [];
  const order = [...neighbours.keys()];
  if (order.indexOf(from) > order.indexOf(to)) [from, to] = [to, from];
  const queue = [[from]];
  const visited = new Set([from]);
  for (const path of queue) {
    const last = path.at(-1)!;
    if (last === to) return path;
    for (const next of neighbours.get(last) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push([...path, next]);
    }
  }
  return [];
}

/** Membership for seeding includes every branch without inventing a traversal. */
export function stationMembershipSequences(schematic: {
  readonly sequences?: Readonly<Record<string, readonly string[]>>;
  readonly branchSequences?: Readonly<Record<string, readonly (readonly string[])[]>>;
}): Readonly<Record<string, readonly string[]>> {
  const lines = new Set([
    ...Object.keys(schematic.sequences ?? {}),
    ...Object.keys(schematic.branchSequences ?? {}),
  ]);
  return Object.fromEntries(
    [...lines].map((line) => [
      line,
      [
        ...new Set([
          ...(schematic.sequences?.[line] ?? []),
          ...(schematic.branchSequences?.[line] ?? []).flat(),
        ]),
      ],
    ]),
  );
}
