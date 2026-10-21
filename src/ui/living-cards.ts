import type { UiCard } from "../ui-blocks";
import { card } from "./card-answers";
import type { Turn } from "./conversation";

/** What the user wrote to start a turn; a report or a post has nothing of theirs, so it answers no card. */
export const wrote = (turn: Turn | undefined) => (turn !== undefined && turn.from === null && turn.user !== "" ? turn.user : null);

/**
 * Where each card ky showed lands in the thread. A card without an id shows where it was called. A card with an
 * id lives: the first call with that id is where it shows, always as its newest version, and each later call
 * with the id reads as a quiet "Updated" line in its own turn. The newest call is the card's identity, so its
 * answer is kept by that call. A card waits for its answer until the user writes something after its newest
 * version: a report or a post that lands after it leaves it waiting, so a routine's card can still be answered.
 * A ui call still streaming or running shows as a draft of what its arguments hold so far, grown as they stream.
 */

export type Placement =
  | {
      readonly kind: "card";
      /** The call the card shows as: its newest version's. */
      readonly call: string;
      readonly ui: UiCard;
      /** Whether nothing the user wrote came after its newest version, so it still takes taps. */
      readonly latest: boolean;
      /** Whether it was updated since it first showed. */
      readonly living: boolean;
      /** Whether its newest version is still being written, so it shows what has streamed so far. */
      readonly drafting: boolean;
    }
  | { readonly kind: "updated"; readonly name: string };

type Shown = { readonly call: string; readonly ui: UiCard; readonly turn: number; readonly drafting: boolean };

/** Each ui call's placement in the turns shown, by call id; a call whose arguments do not read (yet) has none. */
export function placements(turns: readonly Turn[]): ReadonlyMap<string, Placement> {
  const shown = turns.flatMap((turn, index) =>
    turn.items.flatMap((item): Shown[] => {
      if (item.kind !== "tool" || item.name !== "ui" || item.status === "failed") return [];
      const ui = card(item);

      return ui === null ? [] : [{ call: item.id, ui, turn: index, drafting: item.status === "running" }];
    })
  );

  const newest = new Map<string, Shown>();

  for (const each of shown) if (each.ui.id !== undefined) newest.set(each.ui.id, each);

  const out = new Map<string, Placement>();
  const placed = new Set<string>();
  // The last turn the user wrote: not a report, and not a post, which has no words of the user's.
  const said = turns.findLastIndex((turn) => wrote(turn) !== null);

  for (const each of shown) {
    const id = each.ui.id;
    const top = id === undefined ? each : (newest.get(id) ?? each);

    if (id !== undefined && placed.has(id)) out.set(each.call, { kind: "updated", name: each.ui.title ?? "card" });
    else out.set(each.call, { kind: "card", call: top.call, ui: top.ui, latest: top.turn >= said, living: top !== each, drafting: top.drafting });

    if (id !== undefined) placed.add(id);
  }

  return out;
}
