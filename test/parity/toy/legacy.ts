/** The toy domain at "B": reminders on a clock. It takes a reminder in the past, which the port refuses. */
type Reminder = { id: number; text: string; at: number };

export function legacyReminders(clock: { now(): number }) {
  let next = 1;
  const pending = new Map<number, Reminder>();
  const sent: string[] = [];

  return {
    add(text: string, inMs: number): Reminder | { refused: string } {
      if (text.trim() === "") return { refused: "Say what to remind you of." };
      const reminder = { id: next++, text, at: clock.now() + inMs };

      pending.set(reminder.id, reminder);

      return reminder;
    },
    cancel(id: number): { cancelled: number } | { refused: string } {
      return pending.delete(id) ? { cancelled: id } : { refused: `There's no reminder ${id}.` };
    },
    due(): void {
      const now = clock.now();

      for (const [id, reminder] of pending) {
        if (reminder.at > now) continue;
        sent.push(reminder.text);
        pending.delete(id);
      }
    },
    nextAlarm: () => (pending.size === 0 ? null : Math.min(...[...pending.values()].map((reminder) => reminder.at))),
    rows: () => [...pending.values()].sort((a, b) => a.id - b.id),
    sent: () => [...sent]
  };
}
