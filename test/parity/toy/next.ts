/** The toy domain's port: the same reminders, but one in the past is refused (a divergence from B). */
type Reminder = { id: number; text: string; at: number };

export function nextReminders(clock: { now(): number }) {
  let next = 1;
  const pending = new Map<number, Reminder>();
  const sent: string[] = [];

  return {
    add(text: string, inMs: number): Reminder | { refused: string } {
      if (text.trim() === "") return { refused: "Say what to remind you of." };

      if (inMs < 0) return { refused: "That time has passed." };
      const reminder = { id: next++, text, at: clock.now() + inMs };

      pending.set(reminder.id, reminder);

      return reminder;
    },
    cancel(id: number): { cancelled: number } | { refused: string } {
      return pending.delete(id) ? { cancelled: id } : { refused: `There's no reminder ${id}.` };
    },
    due(): void {
      const now = clock.now();
      const due = [...pending.values()].filter((reminder) => reminder.at <= now).sort((a, b) => a.id - b.id);

      for (const reminder of due) {
        sent.push(reminder.text);
        pending.delete(reminder.id);
      }
    },
    nextAlarm: () => (pending.size === 0 ? null : Math.min(...[...pending.values()].map((reminder) => reminder.at))),
    rows: () => [...pending.values()].sort((a, b) => a.id - b.id),
    sent: () => [...sent]
  };
}
