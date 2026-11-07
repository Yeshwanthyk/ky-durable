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

export type Trigger = "look" | "heartbeat" | "event";

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

  return looks.includes(time) ? "look" : "heartbeat";
}

export type AskInput = {
  readonly trigger: Trigger;
  readonly pace: Pace;
  /** Whether what a look reads differs from what the last look that asked read. */
  readonly changed: boolean;
  /** Events waiting for a look. */
  readonly waiting: number;
  /** Heartbeat and event looks that asked the model in the last day. */
  readonly extraToday: number;
};

/** Whether a look asks the model. A look at the user's time always does; the rest only when something is new and the day's budget allows. */
export function shouldAsk({ trigger, pace, changed, waiting, extraToday }: AskInput): boolean {
  if (trigger === "look") return true;

  if (pace === "quiet" || extraToday >= EXTRA_A_DAY[pace]) return false;

  return trigger === "event" ? waiting > 0 : changed || waiting > 0;
}

/** What a look reads, reduced to a string that changes when any of it does. */
export function fingerprint(parts: { readonly anticipations: readonly number[]; readonly map: readonly string[]; readonly wrote: string; readonly verdicts: number }): string {
  return JSON.stringify([parts.anticipations.toSorted((a, b) => a - b), parts.map.toSorted(), parts.wrote, parts.verdicts]);
}
