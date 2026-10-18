/**
 * The user's local time, from their IANA time zone (the browser's, via Automations.setZone): what the dream's
 * 04:00 is counted in. An unknown or unnamed zone counts as UTC.
 */

/** One formatter per zone, as making one costs far more than using it; null for a zone Intl does not know. */
const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatter(zone: string): Intl.DateTimeFormat | null {
  if (!formatters.has(zone)) {
    try {
      formatters.set(zone, new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }));
    } catch {
      formatters.set(zone, null);
    }
  }

  return formatters.get(zone) ?? null;
}

/** How far `zone` is ahead of UTC at `now`, in minutes; 0 for an unknown or unnamed zone. */
export function offsetMinutes(zone: string | null, now: number): number {
  const format = zone === null ? null : formatter(zone);

  if (format === null) return 0;
  const parts = format.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((each) => each.type === type)?.value ?? 0);
  const wall = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));

  return Math.round((wall - Math.floor(now / 60_000) * 60_000) / 60_000);
}
