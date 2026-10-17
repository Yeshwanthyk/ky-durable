/**
 * The user's local day, from their IANA time zone (the browser's, via Automations.setZone): what the dream's
 * 04:00, the brief's day and its midnight are counted in. An unknown or unnamed zone counts as UTC.
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

/** The local date at `now` in `zone`, YYYY-MM-DD. */
export function localDay(zone: string | null, now: number): string {
  return new Date(now + offsetMinutes(zone, now) * 60_000).toISOString().slice(0, 10);
}

/** How far ahead the search for the next midnight looks: a day, and the most a daylight-saving change adds. */
const SEARCH_MS = 26 * 3_600_000;

/** The search's step; every zone's offset, now and in the past century, is a whole number of quarter hours. */
const STEP_MS = 15 * 60_000;

/**
 * The next local midnight after `now` in `zone`, epoch ms: the first instant whose local date is not today's.
 * Searched for, not computed from today's offset, because a daylight-saving change can fall on midnight itself
 * (America/Santiago, Cuba, Egypt, Lebanon), where the first instant of tomorrow is 01:00.
 */
export function nextMidnight(zone: string | null, now: number): number {
  const today = localDay(zone, now);
  const later = (at: number) => localDay(zone, at) !== today;
  // Start from the stroke of the minute after now, so every step lands on a whole minute.
  let before = now;
  let after = Math.floor(now / 60_000) * 60_000 + 60_000;

  while (!later(after) && after - now < SEARCH_MS) {
    before = after;
    after += STEP_MS;
  }

  // Between a step still today and the first step that is not, to the millisecond.
  while (after - before > 1) {
    const middle = Math.floor((before + after) / 2);

    if (later(middle)) after = middle;
    else before = middle;
  }

  return after;
}
