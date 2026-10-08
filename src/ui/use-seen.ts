import { useCallback, useEffect, useState } from "react";

/**
 * Which chats have news the user has not opened: an automation's report or a
 * reply that landed while they were elsewhere. Each chat's seen time is the
 * last activity time it showed while open, kept in localStorage; a chat this
 * browser never opened counts as seen up to when it first started tracking.
 */

const KEY = "ky:seen";

type Seen = { readonly since: number; readonly at: Readonly<Record<string, number>> };

function read(): Seen {
  try {
    const raw = localStorage.getItem(KEY);
    // SAFETY: only this module writes the key, and always a whole Seen.
    const seen = raw ? (JSON.parse(raw) as Seen) : null;

    if (seen) return seen;
  } catch {
    // Unreadable: start over.
  }

  return { since: Date.now(), at: {} };
}

/** Whether a chat last active at `time` has news since it was last seen. */
const isUnread = (seen: Seen, session: string, time: number) => time > (seen.at[session] ?? seen.since);

/** Marks the open chat seen as its activity time moves; says which others are unread. */
export function useSeen(open: string, times: Readonly<Record<string, number>>): (session: string) => boolean {
  const [seen, setSeen] = useState(read);
  const time = times[open] ?? 0;

  useEffect(() => {
    setSeen((current) => {
      if (time <= (current.at[open] ?? 0)) return current;
      const next = { since: current.since, at: { ...current.at, [open]: time } };

      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Over the quota: unread marks last only this visit.
      }

      return next;
    });
  }, [open, time]);

  return useCallback((session: string) => session !== open && isUnread(seen, session, times[session] ?? 0), [seen, open, times]);
}
