/**
 * Schedules as the user reads them. A cron is five fields of wall-clock time in its automation's zone:
 * `0 9 * * *` is 9:00 AM there, every day. This file puts one in words and turns the form's rhythm
 * chips into a cron and back; when one runs next is src/automations/zoned.ts's, as the server books it.
 */

/** The zone this browser is in, for when ky doesn't know the user's. */
export const BROWSER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const EVERY = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"] as const;

/** Each field's bounds: minute, hour, day of month, month, weekday (7 is Sunday too). */
const BOUNDS = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;

/** A cron as the values each field matches, and whether the two day fields are left open. */
type Fields = {
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly days: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly weekdays: ReadonlySet<number>;
  readonly anyDay: boolean;
  readonly anyWeekday: boolean;
};

/** One field's values, sorted; undefined for what this reader doesn't know, like names. */
function values(text: string, [low, high]: readonly [number, number]): number[] | undefined {
  const found = new Set<number>();

  for (const part of text.split(",")) {
    const match = /^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);

    if (!match) return undefined;
    const step = Number(match[4] ?? 1);
    const from = match[1] ? low : Number(match[2]);
    const to = match[1] ? high : match[3] !== undefined ? Number(match[3]) : match[4] ? high : from;

    if (step < 1 || from < low || to > high || from > to) return undefined;

    for (let value = from; value <= to; value += step) found.add(value);
  }

  return [...found].sort((a, b) => a - b);
}

/** A 5-field cron's fields, or undefined when it isn't one this reader knows. */
export function parseCron(cron: string): Fields | undefined {
  const parts = cron.trim().split(/\s+/);

  if (parts.length !== 5) return undefined;
  const [minutes, hours, days, months, weekdays] = BOUNDS.map((bounds, index) => values(parts[index] ?? "", bounds));

  if (!minutes || !hours || !days || !months || !weekdays) return undefined;

  return {
    minutes,
    hours,
    days: new Set(days),
    months: new Set(months),
    weekdays: new Set(weekdays.map((day) => day % 7)),
    anyDay: parts[2] === "*",
    anyWeekday: parts[4] === "*",
  };
}

/** A moment as a wall clock in some zone shows it. */
type Wall = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

const formats = new Map<string, Intl.DateTimeFormat>();

function formatIn(zone: string): Intl.DateTimeFormat {
  let format = formats.get(zone);

  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formats.set(zone, format);
  }

  return format;
}

/** What a wall clock in `zone` reads at `time`. */
export function wallIn(time: number, zone: string): Wall {
  const parts = Object.fromEntries(formatIn(zone).formatToParts(time).map((part) => [part.type, part.value]));

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEK.findIndex((day) => day === parts.weekday),
  };
}

/** The moment a wall clock in `zone` reads the given time. */
export function timeAt(wall: Omit<Wall, "weekday">, zone: string): number {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);

  const offset = (time: number) => {
    const seen = wallIn(time, zone);

    return Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute) - Math.floor(time / 60_000) * 60_000;
  };

  const guess = asUtc - offset(asUtc);

  return asUtc - offset(guess);
}

/** A wall-clock hour and minute as the user's locale writes it: "9:00 AM". */
export function clockOf(hour: number, minute: number): string {
  return new Date(Date.UTC(2000, 0, 1, hour, minute)).toLocaleTimeString(undefined, { timeZone: "UTC", hour: "numeric", minute: "2-digit" });
}

/** A moment's clock time in `zone`: "2:30 PM". */
export function clockIn(time: number, zone: string): string {
  return new Date(time).toLocaleTimeString(undefined, { timeZone: zone, hour: "numeric", minute: "2-digit" });
}

/** Whether two moments fall on the same date in `zone`. */
export function sameDay(a: number, b: number, zone: string): boolean {
  const [x, y] = [wallIn(a, zone), wallIn(b, zone)];

  return x.year === y.year && x.month === y.month && x.day === y.day;
}

/** A run's time, short: the clock today, else the weekday and clock, "Mon 9:00 AM". */
export function runIn(time: number, zone: string, now: number): string {
  const clock = clockIn(time, zone);

  return sameDay(time, now, zone) ? clock : `${WEEK[wallIn(time, zone).weekday]} ${clock}`;
}

/** A zone as the form names it: "America/New_York", or "UTC". */
export function zoneName(zone: string): string {
  return zone === "Etc/UTC" ? "UTC" : zone;
}

/** Days 0-6 in words: Daily, Weekdays, Weekends, Mondays, or Mon, Wed, Fri. */
export function daysInWords(days: readonly number[]): string {
  const key = days.join(",");

  if (days.length === 7) return "Daily";

  if (key === "1,2,3,4,5") return "Weekdays";

  if (key === "0,6") return "Weekends";

  if (days.length === 1) return EVERY[days[0] ?? 0] ?? key;

  // Monday first, as a week reads.
  return mondayFirst(days).map((day) => WEEK[day]).join(", ");
}

const mondayFirst = (days: readonly number[]) => [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));

/** The shapes of cron the form's chips write, each with what the chip needs; anything else is a raw cron. */
export type Rhythm =
  | { readonly kind: "minutes"; readonly every: number }
  | { readonly kind: "hourly"; readonly minute: number; readonly days: readonly number[] }
  | { readonly kind: "hours"; readonly every: number; readonly hour: number; readonly minute: number }
  | { readonly kind: "daily"; readonly hour: number; readonly minute: number; readonly days: readonly number[] }
  | { readonly kind: "cron" };

/** Hours a few apart that divide the day evenly, as Every few hours offers them. */
export const HOUR_STEPS = [2, 3, 4, 6, 8, 12] as const;

/** A cron's rhythm, when it is one of the shapes the chips write. */
export function rhythmOf(cron: string): Rhythm {
  const fields = parseCron(cron);
  const parts = cron.trim().split(/\s+/);

  if (!fields || parts[2] !== "*" || parts[3] !== "*") return { kind: "cron" };
  const days = [...fields.weekdays].sort((a, b) => a - b);
  const { minutes, hours } = fields;

  const [firstMinute = 0, secondMinute = 0] = minutes;
  const [firstHour = 0, secondHour = 0] = hours;

  if (minutes.length > 1 && hours.length === 24 && fields.anyWeekday) {
    const every = secondMinute - firstMinute;

    if (firstMinute === 0 && 60 % every === 0 && minutes.length === 60 / every) return { kind: "minutes", every };
  }

  if (minutes.length !== 1) return { kind: "cron" };

  if (hours.length === 24) return { kind: "hourly", minute: firstMinute, days };

  if (hours.length === 1) return { kind: "daily", hour: firstHour, minute: firstMinute, days };
  const every = secondHour - firstHour;

  if (fields.anyWeekday && hours.length === 24 / every && hours.every((hour, index) => hour === firstHour + index * every))
    return { kind: "hours", every, hour: firstHour, minute: firstMinute };

  return { kind: "cron" };
}

/** Days 0-6 as a cron's weekday field: *, a range like 1-5, or a list. */
function daysField(days: readonly number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);

  if (sorted.length === 7 || sorted.length === 0) return "*";
  const first = sorted[0] ?? 0;
  const last = sorted.at(-1) ?? 0;

  if (sorted.length > 2 && last - first === sorted.length - 1) return `${first}-${last}`;

  return sorted.join(",");
}

/** A rhythm as the cron that runs it. */
export function cronOf(rhythm: Exclude<Rhythm, { kind: "cron" }>): string {
  switch (rhythm.kind) {
    case "minutes":
      return `*/${rhythm.every} * * * *`;
    case "hourly":
      return `${rhythm.minute} * * * ${daysField(rhythm.days)}`;
    case "hours": {
      const start = rhythm.hour % rhythm.every;

      return `${rhythm.minute} ${start === 0 ? `*/${rhythm.every}` : `${start}-23/${rhythm.every}`} * * *`;
    }

    case "daily":
      return `${rhythm.minute} ${rhythm.hour} * * ${daysField(rhythm.days)}`;
  }
}

/** The days phrase after "Hourly": nothing every day, ", weekdays" or ", Mondays" otherwise. */
const hourlyDays = (days: readonly number[]) => {
  const words = daysInWords(days);

  if (words === "Daily") return "";

  return `, ${words === "Weekdays" || words === "Weekends" ? words.toLowerCase() : words}`;
};

/**
 * A cron in words, read as its own wall-clock time: "Every 30 min", "Every 3 hours", "Hourly, weekdays",
 * "Daily · 9:00 AM", "Weekdays · 2:30 PM", "Mondays · 1:30 PM"; else the cron as written.
 */
export function cronInWords(cron: string): string {
  const rhythm = rhythmOf(cron);

  switch (rhythm.kind) {
    case "minutes":
      return rhythm.every === 1 ? "Every minute" : `Every ${rhythm.every} min`;
    case "hourly":
      return `Hourly${rhythm.minute === 0 ? "" : ` at :${String(rhythm.minute).padStart(2, "0")}`}${hourlyDays(rhythm.days)}`;
    case "hours":
      return `Every ${rhythm.every} hours`;
    case "daily":
      return `${daysInWords(rhythm.days)} · ${clockOf(rhythm.hour, rhythm.minute)}`;
    case "cron":
      return cron.trim();
  }
}

/** The form's sentence for a cron: its words, where it starts when that isn't plain, and its zone. */
export function scheduleSentence(cron: string, zone: string): string {
  const rhythm = rhythmOf(cron);
  const from = rhythm.kind === "hours" ? `, from ${clockOf(rhythm.hour, rhythm.minute).replace(":00", "")}` : "";

  return `${cronInWords(cron)}${from} · ${zoneName(zone)}`;
}

/** A frequent rhythm in a word or two for a timeline row, "every 30 min", "hourly"; empty when the time says it. */
export function oftenOf(cron: string | null): string {
  if (cron === null) return "";
  const rhythm = rhythmOf(cron);

  if (rhythm.kind === "minutes" || rhythm.kind === "hours" || rhythm.kind === "hourly") return cronInWords(cron).toLowerCase().split(",")[0] ?? "";

  return "";
}

/** A wall clock in `zone` at `time` as a datetime-local input's value. */
export function wallInput(time: number, zone: string): string {
  const wall = wallIn(time, zone);
  const pad = (value: number) => String(value).padStart(2, "0");

  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`;
}

/** A datetime-local input's value, read in `zone`, as a moment; NaN when it is not a time. */
export function inputTime(value: string, zone: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);

  if (!match) return Number.NaN;
  const [year = 0, month = 1, day = 1, hour = 0, minute = 0] = match.slice(1).map(Number);

  return timeAt({ year, month, day, hour, minute }, zone);
}
