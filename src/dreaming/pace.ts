import * as Schema from "effect/Schema";

/**
 * How often ky looks on its own between the user's look times (docs/research/proactivity/night-shift-model.md).
 * quiet keeps to the look times; balanced adds a heartbeat every two hours and wakes on events; eager every hour.
 */
export const Pace = Schema.Literals(["quiet", "balanced", "eager"]);

export type Pace = typeof Pace.Type;

export const DEFAULT_PACE: Pace = "balanced";

/** Minutes between heartbeats, by pace; quiet has none. */
export const HEARTBEAT_EVERY: Readonly<Record<Pace, number | null>> = { quiet: null, balanced: 120, eager: 60 };

/** Heartbeat and event looks that may reach the model in a day, by pace. Looks at the user's times are not counted. */
export const EXTRA_A_DAY: Readonly<Record<Pace, number>> = { quiet: 0, balanced: 4, eager: 10 };

/** Work ky may start on its own in a day, by pace. */
export const STARTS_A_DAY: Readonly<Record<Pace, number>> = { quiet: 0, balanced: 1, eager: 2 };

/** A heartbeat this close to a look time is left out: the look covers it. */
export const NEAR_A_LOOK = 30;

/** How long after an event its look runs, so events arriving together share one. */
export const EVENT_DELAY_MS = 5 * 60_000;

/** The time an event look fires with. */
export const EVENT_TIME = "event";

/** The time a look ky booked for itself fires with. */
export const NEXT_TIME = "next";

/** A look ky books for itself is at least this far out, so it can't spin. */
export const MIN_GAP_MS = 15 * 60_000;

/** ...and at most this far: past it, the look times and heartbeats cover the day. */
export const MAX_GAP_MS = 4 * 3_600_000;

/** A look is booked this long before something on the map or an anticipation is due. */
export const DUE_LEAD_MS = 30 * 60_000;

/** How far back the user's reactions move the day's budget. */
export const REACTIONS_MS = 7 * 86_400_000;

export type Trigger = "look" | "heartbeat" | "event" | "next";

const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** The heartbeat times, HH:MM, strictly inside the waking window (first look to last), on the pace's grid, away from every look. */
export function heartbeats(looks: readonly string[], pace: Pace): string[] {
  const every = HEARTBEAT_EVERY[pace];

  if (every === null || looks.length < 2) return [];
  const at = looks.map(minutesOf).toSorted((a, b) => a - b);
  const first = at[0] ?? 0;
  const last = at.at(-1) ?? 0;
  const beats: string[] = [];

  for (let minutes = Math.ceil((first + 1) / every) * every; minutes < last; minutes += every) {
    if (at.every((look) => Math.abs(look - minutes) >= NEAR_A_LOOK)) beats.push(clock(minutes));
  }

  return beats;
}

/** Whether `minutes` (local) falls in the waking window, the first look time to the last. */
export function awake(looks: readonly string[], minutes: number): boolean {
  if (looks.length < 2) return false;
  const at = looks.map(minutesOf);

  return minutes >= Math.min(...at) && minutes <= Math.max(...at);
}

export function triggerOf(time: string, looks: readonly string[]): Trigger {
  if (time === EVENT_TIME) return "event";

  if (time === NEXT_TIME) return "next";

  return looks.includes(time) ? "look" : "heartbeat";
}

export type AskInput = {
  readonly trigger: Trigger;
  /** Whether what a look reads differs from what the last look that asked read. */
  readonly changed: boolean;
  /** Events waiting for a look. */
  readonly waiting: number;
  /** Heartbeat, event and booked looks that asked the model in the last day. */
  readonly extraToday: number;
  /** The day's budget for them: budgetOf. */
  readonly most: number;
};

/**
 * Whether a look asks the model. A look at the user's time always does; the rest only while the day's budget lasts,
 * and then: a look ky booked for itself always (it booked it for a reason), an event look when an event waits, a
 * heartbeat when something changed or an event waits.
 */
export function shouldAsk({ trigger, changed, waiting, extraToday, most }: AskInput): boolean {
  if (trigger === "look") return true;

  if (extraToday >= most) return false;

  if (trigger === "next") return true;

  return trigger === "event" ? waiting > 0 : changed || waiting > 0;
}

export type Reactions = {
  /** 👍 on ky's posts, and starts the user kept, in the last REACTIONS_MS. */
  readonly liked: number;
  /** 👎 on ky's posts, and starts the user discarded. */
  readonly disliked: number;
};

/**
 * The day's budget of extra looks: the pace's, moved one per reaction, never below half of it or above twice it.
 * Quiet stays 0: the user asked for the look times alone.
 */
export function budgetOf(pace: Pace, { liked, disliked }: Reactions): number {
  const base = EXTRA_A_DAY[pace];

  if (base === 0) return 0;

  return Math.min(base * 2, Math.max(Math.ceil(base / 2), base + liked - disliked));
}

export type NextInput = {
  readonly now: number;
  /** When the look's answer asked to look again, if it did. */
  readonly asked: number | null;
  /** When things on the map and open anticipations are due. */
  readonly dues: readonly number[];
  /** Whether a moment falls in the user's waking window (first look time to last). */
  readonly awake: (at: number) => boolean;
};

/**
 * When ky looks next on its own: the earlier of what the look asked for (held between MIN_GAP_MS and MAX_GAP_MS out)
 * and DUE_LEAD_MS before the next thing due in that span; null when neither, or when it falls outside the waking window.
 */
export function nextAt({ now, asked, dues, awake }: NextInput): number | null {
  const soonest = now + MIN_GAP_MS;
  const latest = now + MAX_GAP_MS;
  const before = dues.map((due) => due - DUE_LEAD_MS).filter((at) => at >= soonest && at <= latest);
  const wanted = asked === null || Number.isNaN(asked) ? [] : [Math.min(latest, Math.max(soonest, asked))];
  const candidates = [...wanted, ...before];

  if (candidates.length === 0) return null;

  const at = Math.min(...candidates);

  return awake(at) ? at : null;
}

/** What a look reads, reduced to a string that changes when any of it does. */
export function fingerprint(parts: { readonly anticipations: readonly number[]; readonly map: readonly string[]; readonly wrote: string; readonly verdicts: number }): string {
  return JSON.stringify([parts.anticipations.toSorted((a, b) => a - b), parts.map.toSorted(), parts.wrote, parts.verdicts]);
}
