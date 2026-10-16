/**
 * The user's local day, from their IANA time zone (the browser's, via Automations.setZone): what the dream's
 * 04:00, the brief's day and its midnight are counted in. An unknown or unnamed zone counts as UTC.
 */

/** How far `zone` is ahead of UTC at `now`, in minutes; 0 for an unknown or unnamed zone. */
export function offsetMinutes(zone: string | null, now: number): number {
  if (zone === null) return 0;

  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((each) => each.type === type)?.value ?? 0);
    const wall = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));

    return Math.round((wall - Math.floor(now / 60_000) * 60_000) / 60_000);
  } catch {
    return 0;
  }
}

/** The local date at `now` in `zone`, YYYY-MM-DD. */
export function localDay(zone: string | null, now: number): string {
  return new Date(now + offsetMinutes(zone, now) * 60_000).toISOString().slice(0, 10);
}

/** The next local midnight after `now` in `zone`, epoch ms: when today's local day ends. */
export function nextMidnight(zone: string | null, now: number): number {
  const wall = new Date(now + offsetMinutes(zone, now) * 60_000);
  const midnight = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + 1);
  // The offset at midnight itself, so a daylight-saving change that day lands on the hour it happens.
  const guess = midnight - offsetMinutes(zone, now) * 60_000;

  return midnight - offsetMinutes(zone, guess) * 60_000;
}
