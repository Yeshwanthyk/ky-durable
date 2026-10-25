/** The toy domain at "B": reminders on a clock. It takes a reminder in the past, which the port refuses. */
export type Reminder = { id: number; text: string; at: number };

export function legacyReminders() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, Reminder>();
  const sent: string[] = [];

  return {
    add(text: string, inMs: number): Reminder | { refused: string } {
      if (text.trim() === "") return { refused: "Say what to remind you of." };
      const reminder = { id: next++, text, at: now + inMs };

      pending.set(reminder.id, reminder);

      return reminder;
    },
    cancel(id: number): { cancelled: number } | { refused: string } {
      return pending.delete(id) ? { cancelled: id } : { refused: `There's no reminder ${id}.` };
    },
    advance(ms: number): void {
      now += ms;

      for (const [id, reminder] of pending) {
        if (reminder.at > now) continue;
        sent.push(reminder.text);
        pending.delete(id);
      }
    },
    rows: () => [...pending.values()].sort((a, b) => a.id - b.id),
    sent: () => [...sent]
  };
}
