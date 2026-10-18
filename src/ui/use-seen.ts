import { useCallback, useEffect, useState } from "react";
import Type, { type Static } from "typebox";
import { parseOr } from "../core/decode";
import type { Visit } from "./thread-marks";

/**
 * Which chats have news the user has not opened: an automation's report or a
 * reply that landed while they were elsewhere. Each chat's seen time is the
 * last activity time it showed while open, kept in localStorage; a chat this
 * browser never opened counts as seen up to when it first started tracking.
 */

const KEY = "ky:seen";

const SeenSchema = Type.Object({ since: Type.Number(), at: Type.Record(Type.String(), Type.Number()) });

type Seen = Readonly<Static<typeof SeenSchema>>;

function read(): Seen {
  const fresh = { since: Date.now(), at: {} };

  try {
    // Unreadable, or written by another version: start over.
    return parseOr(SeenSchema, localStorage.getItem(KEY) ?? "", fresh);
  } catch {
    // Storage blocked: start over.
    return fresh;
  }
}

/** When a chat was last seen: its last activity time while open, else when tracking started. */
const seenAt = (seen: Seen, session: string) => seen.at[session] ?? seen.since;

/** Whether a chat last active at `time` has news since it was last seen. */
const isUnread = (seen: Seen, session: string, time: number) => time > seenAt(seen, session);

type Opened = { readonly session: string; readonly visit: Visit };

const opening = (seen: Seen, session: string): Opened => ({ session, visit: { since: seenAt(seen, session), opened: Date.now() } });

/**
 * Marks the open chat seen as its activity time moves; says which others are
 * unread, and when the open one was last seen before this visit opened it.
 */
export function useSeen(open: string, times: Readonly<Record<string, number>>) {
  const [seen, setSeen] = useState(read);
  const [opened, setOpened] = useState(() => opening(seen, open));
  const time = times[open] ?? 0;

  // Taken as the chat opens, before it is marked seen below.
  if (opened.session !== open) setOpened(opening(seen, open));

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

  const unread = useCallback((session: string) => session !== open && isUnread(seen, session, times[session] ?? 0), [seen, open, times]);

  return { unread, visit: opened.session === open ? opened.visit : null };
}
