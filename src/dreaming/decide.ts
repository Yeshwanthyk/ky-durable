import Type, { type Static } from "typebox";
import { decodeOr, parseOr } from "../core/decode";

/**
 * What a look (src/dreaming/looks.ts) posts, decided from its rows without a model: pure, so the property tests
 * in test/invariants/looks.test.ts can run it over any rows and any past.
 */

/**
 * One thing a look weighed: `ref` is what it rests on (anticipation:12 or memory:34), `needed` what that asks for,
 * `current` what the chats and connections say now, and `action` what to do: tell the user now, prepare a draft
 * ready before `by` (an ISO time), or skip. `message` is what ky says in the chat, in full.
 */
const LookRowSchema = Type.Object({
  ref: Type.String(),
  needed: Type.String(),
  current: Type.String(),
  action: Type.Union([Type.Literal("tell"), Type.Literal("prepare"), Type.Literal("skip")]),
  by: Type.Optional(Type.String()),
  message: Type.Optional(Type.String())
});

export type LookRow = Static<typeof LookRowSchema>;

/** A ref a look posted before: when, whether the user wrote in the main chat since, and whether its anticipation is still open. */
export type SaidRef = { readonly at: number; readonly replied: boolean; readonly open: boolean };

export type LookContext = {
  readonly now: number;
  /** The next look, epoch ms: later today, else tomorrow's first; null when there are no look times. */
  readonly next: number | null;
  /** The refs that are there: open anticipations and memories. */
  readonly known: ReadonlySet<string>;
  /** Refs posted before, by ref, the latest post of each. */
  readonly said: ReadonlyMap<string, SaidRef>;
};

/** A look posts at most this many messages. */
export const LOOK_POSTS = 3;

/** A ref posted is not posted again for at least this long. */
export const SAID_QUIET_MS = 48 * 3_600_000;

/**
 * Whether a ref said before may be said again: the user replied since, or nothing holds it open (its anticipation is
 * closed, or it is a memory) and SAID_QUIET_MS passed.
 */
const sayAgain = (said: SaidRef, now: number) => said.replied || (!said.open && now - said.at >= SAID_QUIET_MS);

/** A prepare is due now when its time is ahead and the next look would come too late for it, or there is none. */
function due(row: LookRow, { now, next }: LookContext): boolean {
  const by = Date.parse(row.by ?? "");

  return by > now && (next === null || by <= next);
}

/** What to post, in order: prepares before tells, one per ref, at most LOOK_POSTS. */
export function decide(rows: readonly LookRow[], context: LookContext): LookRow[] {
  const wanted = rows.filter((row) => {
    if (row.action === "skip" || (row.message ?? "").trim() === "" || !context.known.has(row.ref)) return false;
    const said = context.said.get(row.ref);

    if (said !== undefined && !sayAgain(said, context.now)) return false;

    return row.action === "tell" || due(row, context);
  });

  const ordered = [...wanted.filter((row) => row.action === "prepare"), ...wanted.filter((row) => row.action === "tell")];

  return ordered.filter((row, index) => ordered.findIndex((other) => other.ref === row.ref) === index).slice(0, LOOK_POSTS);
}

const Rows = Type.Array(Type.Unknown());

/** A look's answer as rows: those of the JSON array in it (fenced or not) that are rows; none when there is no such array. */
export function lookRows(answer: string): LookRow[] {
  const start = answer.indexOf("[");
  const end = answer.lastIndexOf("]");
  const rows = start < 0 || end < start ? [] : parseOr(Rows, answer.slice(start, end + 1), []);

  return rows.flatMap((row) => decodeOr(LookRowSchema, row, undefined) ?? []);
}
