import type { Turn } from "./conversation";

/**
 * What sits above each turn of the thread: a day stamp where the day changes,
 * and a New divider above the first turn that landed since the user last saw
 * the chat. Turns that land while the chat is open are not news to them.
 */

export type Mark = { readonly day: string | null; readonly isNew: boolean };

/** When the chat was last seen, and when this visit opened it; null when its seen time is unknown. */
export type Visit = { readonly since: number; readonly opened: number } | null;

const DAY = 86_400_000;

const time = (stamp: string | null) => (stamp === null ? Number.NaN : Date.parse(stamp));

const dayOf = (at: number) => new Date(at).setHours(0, 0, 0, 0);

/** A day in words: Today, Yesterday, or its date, with the year once it is not this one. */
export function dayWords(at: number, now: number): string {
  const days = Math.round((dayOf(now) - dayOf(at)) / DAY);

  if (days === 0) return "Today";

  if (days === 1) return "Yesterday";
  const year = new Date(at).getFullYear() === new Date(now).getFullYear() ? undefined : "numeric";

  return new Date(at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year });
}

/** Whether a turn is news on this visit: it ended after the chat was last seen, and started before this visit. */
const landed = (turn: Turn, visit: Visit) => visit !== null && time(turn.endedAt) > visit.since && time(turn.startedAt) <= visit.opened;

/** The day stamp above a turn: its day, when it differs from the turn before's. */
function stamp(turn: Turn, before: Turn | undefined, now: number): string | null {
  const at = time(turn.startedAt);

  if (Number.isNaN(at)) return null;

  return before !== undefined && dayOf(time(before.startedAt)) === dayOf(at) ? null : dayWords(at, now);
}

/** Where the news starts: the first turn that landed since the chat was last seen, or -1. */
export const firstNew = (turns: readonly Turn[], visit: Visit) => turns.findIndex((turn) => landed(turn, visit));

/**
 * How many of `count` turns fold behind "earlier turns": all but the last
 * `open`, but never the news at `news`, so its New divider shows.
 */
export const folded = (count: number, open: number, news: number) => Math.max(0, Math.min(count - open, news < 0 ? count : news));

/** The marks above each of `turns`, in order. */
export function marks(turns: readonly Turn[], visit: Visit, now: number): Mark[] {
  const first = firstNew(turns, visit);

  return turns.map((turn, index) => ({ day: stamp(turn, turns[index - 1], now), isNew: index === first }));
}
