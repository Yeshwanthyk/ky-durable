import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const LookRow = Schema.Struct({
  ref: Schema.String,
  needed: Schema.String,
  current: Schema.String,
  action: Schema.Literals(["tell", "prepare", "skip", "start"]),
  by: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  gate: Schema.optionalKey(Schema.String),
  prompt: Schema.optionalKey(Schema.String),
  changed: Schema.optionalKey(Schema.String)
});

export type LookRow = typeof LookRow.Type;

const decodeLookRow = Schema.decodeUnknownOption(LookRow);

export type WatchRow = LookRow & {
  readonly gate: string;
  readonly prompt: string;
};

export type SaidRef = {
  readonly at: number;
  readonly replied: boolean;
  readonly open: boolean;
};

export type LookContext = {
  readonly now: number;
  readonly next: number | null;
  readonly known: ReadonlySet<string>;
  readonly said: ReadonlyMap<string, SaidRef>;
  /** Each ref whose last post the user marked not useful, and when. */
  readonly unwanted?: ReadonlyMap<string, number>;
};

export const LOOK_POSTS = 3;

export const SAID_QUIET_MS = 48 * 3_600_000;

export const UNWANTED_MS = 30 * 86_400_000;

// A 👎'd ref is said already and unwanted: it goes again only on a row that says what changed since.
const unwanted = (row: LookRow, { unwanted: marked, now }: LookContext) => {
  const at = marked?.get(row.ref);

  return at !== undefined && now - at < UNWANTED_MS && (row.changed ?? "").trim() === "";
};

const sayAgain = (said: SaidRef, now: number) => said.replied || (!said.open && now - said.at >= SAID_QUIET_MS);

function due(row: LookRow, { now, next }: LookContext): boolean {
  const by = Date.parse(row.by ?? "");

  return by > now && (next === null || by <= next);
}

/** A tell or prepare row with a message, on a known ref the user still wants and was not told about lately. */
function postable(row: LookRow, context: LookContext): boolean {
  if (row.action === "skip" || row.action === "start" || (row.message ?? "").trim() === "") return false;
  const said = context.said.get(row.ref);

  return context.known.has(row.ref) && !unwanted(row, context) && (said === undefined || sayAgain(said, context.now));
}

export function decide(rows: readonly LookRow[], context: LookContext): LookRow[] {
  const wanted = rows.filter((row) => postable(row, context) && (row.action === "tell" || due(row, context)));

  const ordered = [...wanted.filter((row) => row.action === "prepare"), ...wanted.filter((row) => row.action === "tell")];

  return ordered.filter((row, index) => ordered.findIndex((other) => other.ref === row.ref) === index).slice(0, LOOK_POSTS);
}

/**
 * The work a look starts on its own: start rows with a task (prompt) and a message, on a known ref not said lately and
 * not 👎'd, one per ref, at most `left` (what the day's STARTS_A_DAY leaves).
 */
export function starts(rows: readonly LookRow[], context: LookContext, left: number): Array<LookRow & { readonly prompt: string; readonly message: string }> {
  const wanted = rows.filter((row): row is LookRow & { readonly prompt: string; readonly message: string } => {
    if (row.action !== "start" || (row.prompt ?? "").trim() === "" || (row.message ?? "").trim() === "" || !context.known.has(row.ref) || unwanted(row, context)) return false;
    const said = context.said.get(row.ref);

    return said === undefined || sayAgain(said, context.now);
  });

  return wanted.filter((row, index) => wanted.findIndex((other) => other.ref === row.ref) === index).slice(0, Math.max(0, left));
}

export const WATCHES = 5;

export const NEW_WATCHES = 2;

const isWatch = (row: LookRow): row is WatchRow => (row.gate ?? "").trim() !== "" && (row.prompt ?? "").trim() !== "";

export function newWatches(rows: readonly LookRow[], watchable: ReadonlySet<string>, watched: ReadonlySet<string>, live: number): WatchRow[] {
  const wanted = rows.filter(isWatch).filter((row) => watchable.has(row.ref) && !watched.has(row.ref));

  return wanted.filter((row, index) => wanted.findIndex((other) => other.ref === row.ref) === index).slice(0, Math.max(0, Math.min(NEW_WATCHES, WATCHES - live)));
}

const decodeRows = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.Unknown)));

export function lookRows(answer: string): LookRow[] {
  const start = answer.indexOf("[");
  const end = answer.lastIndexOf("]");

  const rows = start < 0 || end < start ? [] : Option.getOrElse(decodeRows(answer.slice(start, end + 1)), () => []);

  return rows.flatMap((row) => Option.toArray(decodeLookRow(row)));
}
