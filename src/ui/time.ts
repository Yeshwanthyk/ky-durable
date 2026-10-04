/** How long ago, compact: now, 5m, 3h, 2d. */
export function ago(time: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - time) / 1000));

  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);

  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);

  if (hours < 24) return `${hours}h`;

  return `${Math.round(hours / 24)}d`;
}

/** A clock time, like 2:32 pm. */
export function clock(time: number): string {
  return new Date(time)
    .toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    .toLowerCase();
}

const startOfDay = (time: number) => new Date(time).setHours(0, 0, 0, 0);

/** The day a time falls on, for grouping a feed: Today, Yesterday, Monday, or Sep 28. */
export function day(time: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(time)) / 86_400_000);

  if (days <= 0) return "Today";

  if (days === 1) return "Yesterday";

  if (days < 7) return new Date(time).toLocaleDateString(undefined, { weekday: "long" });

  return new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
