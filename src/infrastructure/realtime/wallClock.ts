const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/** Resolves an offset-free local `YYYY-MM-DD HH:MM:SS` in an IANA zone, including DST. */
export function parseWallClock(value: string, timeZone: string): number {
  const match = WALL_CLOCK.exec(value);
  if (!match) throw new Error(`Invalid local time: ${value}`);
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  if (new Date(target).toISOString().slice(0, 19).replace("T", " ") !== value)
    throw new Error(`Invalid local time: ${value}`);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const asUtc = (epoch: number) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(epoch).map(({ type, value: part }) => [type, Number(part)]),
    );
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  };
  let candidate = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = target - (asUtc(candidate) - candidate);
    if (next === candidate) break;
    candidate = next;
  }
  // Skipped spring-forward times don't exist; repeated ones resolve to their first instant.
  if (asUtc(candidate) !== target) throw new Error(`Nonexistent local time: ${value}`);
  return candidate;
}
