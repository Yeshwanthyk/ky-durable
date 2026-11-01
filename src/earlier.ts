import type { Context } from "@earendil-works/chord";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { Conversation, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import Type from "typebox";
import { decodeOr } from "./core/decode";

/**
 * A page of the chat before what the browser has: the `earlier` ask's answer. pi keeps every entry after a
 * compaction or reset; only the model's context starts later. The page walks back from `before`, newest first, and
 * stops at a count or a size, so a chat of photos and long thinking still pages in small steps.
 */

/** Entries a page holds at most: about a dozen of the user's turns. */
const EARLIER_ENTRIES = 120;

/** Bytes of entries a page holds at most; one larger entry still goes alone. */
const EARLIER_BYTES = 512 * 1024;

/** Entries read per scan of the store. */
const SCAN = 40;

/** Entries the page never shows: the system prompt pi keeps per run, about 100 KB each. */
const UNSHOWN = new Set(["pi.system"]);

export type EarlierPage = {
  /** Oldest first. */
  readonly entries: readonly EntryRecord[];
  /** Whether the chat has entries before the oldest of these. */
  readonly more: boolean;
};

export async function earlierPage(conversation: Pick<Conversation, "entries">, before: number, context: Context): Promise<EarlierPage> {
  const entries: EntryRecord[] = [];
  let bytes = 0;
  let cursor: Parameters<Conversation["entries"]>[2];

  if (before <= 1) return { entries: [], more: false };

  do {
    // SAFETY: entry ids are numbers pi brands by kind; `before` is one the snapshot or a page named.
    const below = (before - 1) as EntryId;
    const page = await conversation.entries({ maxEntryId: below, order: "descending" }, SCAN, cursor, context);

    for (const entry of page.items) {
      if (UNSHOWN.has(entry.kind)) continue;
      const size = JSON.stringify(entry).length;

      if (entries.length > 0 && (entries.length >= EARLIER_ENTRIES || bytes + size > EARLIER_BYTES)) {
        return { entries: entries.reverse(), more: true };
      }

      entries.push(entry);
      bytes += size;
    }

    cursor = page.next;
  } while (cursor !== undefined);

  return { entries: entries.reverse(), more: false };
}

/** Entries as they go on the wire: pi stores each as JSON, so each already is. */
const Wire = Type.Unsafe<JsonValue>(Type.Array(Type.Object({ id: Type.Number(), kind: Type.String() })));

/** The page as the ask's answer. */
export function earlierAnswer(page: EarlierPage): JsonValue {
  return { entries: decodeOr(Wire, page.entries, []), more: page.more };
}
