import { parseCronExpression } from "cron-schedule";
import { offsetMinutes } from "../dreaming/contract.ts";

function instantOf(wall: number, zone: string | null): number {
  const guess = wall - offsetMinutes(zone, wall) * 60_000;

  return wall - offsetMinutes(zone, guess) * 60_000;
}

const localDate = (wall: Date) =>
  new Date(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), wall.getUTCHours(), wall.getUTCMinutes(), wall.getUTCSeconds());

const wallOf = (local: Date) =>
  Date.UTC(local.getFullYear(), local.getMonth(), local.getDate(), local.getHours(), local.getMinutes(), local.getSeconds());

export function nextLocal(cron: string, zone: string | null, after: number): number {
  const expression = parseCronExpression(cron);
  let from = after;

  for (let tries = 0; tries < 3; tries++) {
    const wall = new Date(from + offsetMinutes(zone, from) * 60_000);
    const next = instantOf(wallOf(expression.getNextDate(localDate(wall))), zone);

    if (next > after) return next;
    from += 3_600_000;
  }

  throw new Error(`No time after ${new Date(after).toISOString()} for "${cron}" in ${zone ?? "UTC"}.`);
}

export function nextLocals(cron: string, zone: string | null, after: number, count: number): number[] {
  const times: number[] = [];

  for (let at = after; times.length < count; ) {
    at = nextLocal(cron, zone, at);
    times.push(at);
  }

  return times;
}

const NUMBER = /^\d+$/;

function daysField(days: ReadonlySet<number>): string {
  const sorted = [...days].sort((a, b) => a - b);
  const parts: string[] = [];

  for (let i = 0; i < sorted.length; ) {
    let end = i;

    while (end + 1 < sorted.length && sorted[end + 1] === (sorted[end] ?? 0) + 1) end++;
    parts.push(end - i >= 2 ? `${sorted[i]}-${sorted[end]}` : sorted.slice(i, end + 1).join(","));
    i = end + 1;
  }

  return parts.join(",");
}

function shiftDays(field: string, shift: number): string | undefined {
  if (field === "*") return field;
  const days = new Set<number>();

  for (const part of field.split(",")) {
    const [from = "", to = from] = part.split("-");

    if (!NUMBER.test(from) || !NUMBER.test(to)) return undefined;

    for (let day = Number(from); day <= Number(to); day++) days.add((((day + shift) % 7) + 7) % 7);
  }

  return daysField(days);
}

export function cronIn(cron: string, zone: string | null, now: number): string | undefined {
  const [minute = "", hour = "", day = "", month = "", weekday = "", ...rest] = cron.trim().split(/\s+/);

  if (!weekday || rest.length > 0) return undefined;
  const offset = offsetMinutes(zone, now);

  if (offset === 0) return cron;

  if (hour === "*") return offset % 60 === 0 ? cron : undefined;

  if (!NUMBER.test(minute) || !NUMBER.test(hour)) return undefined;
  const total = Number(hour) * 60 + Number(minute) + offset;
  const shift = Math.floor(total / 1440);
  const local = total - shift * 1440;

  if (shift !== 0 && (day !== "*" || month !== "*")) return undefined;
  const weekdays = shiftDays(weekday, shift);

  return weekdays === undefined ? undefined : `${local % 60} ${Math.floor(local / 60)} ${day} ${month} ${weekdays}`;
}
