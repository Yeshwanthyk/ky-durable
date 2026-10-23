import type { UiCard } from "../ui-blocks";
import { card } from "./card-answers";
import type { Turn } from "./conversation";

/**
 * Where each card ky showed lands in the thread. A card without an id shows where it was called. A card with an
 * id lives: the first call with that id is where it shows, always as its newest version, and each later call
 * with the id reads as a quiet "Updated" line in its own turn. The newest call is the card's identity, so its
 * answer is kept by that call, and it takes taps only once the newest call is in the last turn and it ended.
 */

export type Placement =
  | {
      readonly kind: "card";
      /** The call the card shows as: its newest version's. */
      readonly call: string;
      readonly ui: UiCard;
      /** Whether its newest version is in the thread's last turn. */
      readonly latest: boolean;
      /** Whether it was updated since it first showed. */
      readonly living: boolean;
    }
  | { readonly kind: "updated"; readonly name: string };

type Shown = { readonly call: string; readonly ui: UiCard; readonly turn: number };

/** Each done ui call's placement in the turns shown, by call id; a call whose arguments do not read has none. */
export function placements(turns: readonly Turn[]): ReadonlyMap<string, Placement> {
  const shown = turns.flatMap((turn, index) =>
    turn.items.flatMap((item): Shown[] => {
      const ui = item.kind === "tool" && item.name === "ui" && item.status === "done" ? card(item) : null;

      return ui === null ? [] : [{ call: item.id, ui, turn: index }];
    })
  );

  const newest = new Map<string, Shown>();

  for (const each of shown) if (each.ui.id !== undefined) newest.set(each.ui.id, each);

  const out = new Map<string, Placement>();
  const placed = new Set<string>();
  const last = turns.length - 1;

  for (const each of shown) {
    const id = each.ui.id;
    const top = id === undefined ? each : (newest.get(id) ?? each);

    if (id !== undefined && placed.has(id)) out.set(each.call, { kind: "updated", name: each.ui.title ?? "card" });
    else out.set(each.call, { kind: "card", call: top.call, ui: top.ui, latest: top.turn === last, living: top !== each });

    if (id !== undefined) placed.add(id);
  }

  return out;
}
