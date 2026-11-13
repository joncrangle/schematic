const DAY_MS = 86400_000;

function stableHash(id: string): number {
  let hash = 2166136261;
  for (const char of id) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Stable hash order and preferred weekday, with least-loaded collision resolution. */
export function assignTopologyWeekdays(ids: readonly string[]): ReadonlyMap<string, number> {
  const sorted = [...new Set(ids)].sort(
    (a, b) => stableHash(a) - stableHash(b) || (a < b ? -1 : a > b ? 1 : 0),
  );
  const loads = Array<number>(7).fill(0),
    schedule = new Map<string, number>();
  for (const id of sorted) {
    const preferred = stableHash(id) % 7,
      minimum = Math.min(...loads);
    let day = preferred;
    while (loads[day] !== minimum) day = (day + 1) % 7;
    schedule.set(id, day);
    loads[day]++;
  }
  return schedule;
}

export function nextTopologyRunAt(now: number): number {
  const today = Math.floor(now / DAY_MS) * DAY_MS + 4 * 3600_000;
  return today > now ? today : today + DAY_MS;
}
