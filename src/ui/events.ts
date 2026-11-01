import Type from "typebox";
import { parseOr } from "../core/decode";
import type { Item, Tool } from "./conversation";
import type { IconName } from "../chat-kit/Icon";

/**
 * The lasting changes a turn made, as one quiet line each under its answer:
 * "Created routine · Nightly X likes roundup". Read from what the tool said it
 * did, so a refusal or a no-op shows nothing.
 */

export type ThreadEvent = { readonly id: string; readonly verb: string; readonly icon: IconName; readonly name: string };

type Said = { readonly verb: string; readonly icon: IconName; readonly name: string };

const short = (value: string, max = 48) => (value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value);

const capital = (word: string) => word.replace(/^./, (c) => c.toUpperCase());

/** An automation's change, from its reply: `Created automation a1, "Title" (…)` or `Paused "Title".`. */
function routine(output: string): Said | null {
  const match = /^(Created) automation \S+, "(.+?)"|^(Updated|Paused|Resumed|Archived|Unarchived|Deleted) "(.+?)"/.exec(output);
  const verb = match?.[1] ?? match?.[3];
  const name = match?.[2] ?? match?.[4];

  return verb === undefined || name === undefined ? null : { verb: `${verb} routine`, icon: "clock", name };
}

/** A versioned file's change, from `Saved edit of SOUL.md (version 4).`. */
function versioned(output: string): Said | null {
  const match = /^Saved (\w+) of (.+?) \(version/.exec(output);

  if (match?.[1] === undefined || match[2] === undefined) return null;

  return { verb: match[1] === "create" ? "Created" : "Updated", icon: "pencil", name: match[2] };
}

const Noted = Type.Object({ text: Type.String() });

/** A memory saved, named by what it says. */
function noted(output: string, input: string): Said | null {
  if (!output.startsWith("Saved as #")) return null;
  const text = parseOr(Noted, input, null)?.text.trim() ?? "";

  return { verb: "Saved to memory", icon: "repo", name: short(text) };
}

const READERS = new Map<string, (output: string, input: string) => Said | null>([
  ["automation", routine],
  ["skill_manage", versioned],
  ["soul_edit", versioned],
  ["memory_note", noted]
]);

/** The change a finished tool call made, if it made a lasting one. */
export function eventOf(tool: Tool): ThreadEvent | null {
  const read = READERS.get(tool.name);
  const said = tool.status === "done" && read !== undefined ? read(tool.output.trim(), tool.input) : null;

  return said === null ? null : { id: tool.id, ...said, verb: capital(said.verb) };
}

/** Every lasting change among a turn's items, in order. */
export const eventsOf = (items: readonly Item[]) => items.flatMap((item) => (item.kind === "tool" ? (eventOf(item) ?? []) : []));
