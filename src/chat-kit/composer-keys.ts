/** What the composer's keys do, apart from the DOM: the @ menu and bringing back what was sent. */

/** Someone the composer offers when the user types @. */
export type Mentionable = { readonly id: string; readonly description: string };

/** Options the menu shows at most. */
const MENU_ROWS = 6;

/** The @word the caret is in, at the start of the text or after a space: where it starts and what is typed. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const match = /(^|\s)@([a-z0-9-]*)$/i.exec(text.slice(0, caret));
  const query = match?.[2];

  return query === undefined ? null : { start: caret - query.length - 1, query: query.toLowerCase() };
}

/** The ids that match what is typed after @: those it starts first, then those it is in. */
export function matching(all: readonly Mentionable[], query: string): Mentionable[] {
  const starts = all.filter((each) => each.id.startsWith(query));
  const within = all.filter((each) => !each.id.startsWith(query) && each.id.includes(query));

  return [...starts, ...within].slice(0, MENU_ROWS);
}

/** What a key does while the menu is open: move the highlight, pick it, close the menu, or nothing. */
export type MenuKey = "down" | "up" | "pick" | "close";

const MENU_KEYS = new Map<string, MenuKey>([
  ["ArrowDown", "down"],
  ["ArrowUp", "up"],
  ["Enter", "pick"],
  ["Tab", "pick"],
  ["Escape", "close"]
]);

export const menuKey = (key: string): MenuKey | null => MENU_KEYS.get(key) ?? null;

/** The highlight after ↓ or ↑, wrapping round the options. */
export const moved = (active: number, key: "down" | "up", count: number) => (active + (key === "down" ? 1 : -1) + count) % count;

/** The message before the one recalled, counting from the newest; none past the oldest, or when ↑ can't start. */
function older(recalling: number | null, canStart: boolean, count: number): number | undefined {
  const next = recalling === null ? (canStart ? 0 : count) : recalling + 1;

  return next < count ? next : undefined;
}

/**
 * Which sent message a key brings back, counting from the newest: ↑ on the first line steps back (from an empty
 * composer, or from a message ↑ already brought back), ↓ on the last line steps forward, then to empty (null).
 * Undefined when the key brings nothing back.
 */
export function recallStep(key: string, before: string, after: string, recalling: number | null, canStart: boolean, count: number): number | null | undefined {
  if (key === "ArrowUp" && !before.includes("\n")) return older(recalling, canStart, count);

  if (key === "ArrowDown" && recalling !== null && !after.includes("\n")) return recalling === 0 ? null : recalling - 1;

  return undefined;
}
