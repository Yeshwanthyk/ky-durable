import * as Schema from "effect/Schema";
import Type, { type Static } from "typebox";
import { decodeOr, parseOr } from "../core/decode.ts";

/**
 * The dreaming domain's contract: the shapes, tool names, frozen table names and row decoders of
 * memory (OptMem), SOUL.md and its versioned files, the nightly dream's mark, and anticipations. A leaf: it imports
 * nothing else from the folder, so the files here use it without a cycle. Outside src/dreaming/,
 * import this for types and names, and ./wiring for the classes that run.
 */

/** A row as `sql.exec` returns it, or none: what the decoders below check. */
type Row = Readonly<Record<string, SqlStorageValue>> | undefined;

// Tables. A backup restores each by name (staged as ky_restore__<table>), so these never change.
export const DREAMING_TABLES = {
  /** OptMem's append-only log of one-line memories. */
  memoryLog: "memo_log",
  /** OptMem's summaries, one per aligned power-of-two block of the log. */
  memoryTree: "memo_tree",
  /** Where the last finished dream read up to: one row. */
  dreamMark: "ky_dream",
  /** When the user was last here, so the dream waits until they are away: one row. */
  presence: "ky_presence",
  /** Every version of SOUL.md and of each specialist's brief, told apart by `key`. */
  soulVersions: "ky_soul_versions",
  /** One row per change a dream made, with what it replaced, so the user can undo it. */
  dreamLedger: "ky_dream_ledger",
  /** What ky expects to matter soon: open loops, dates ahead, likely asks, watches; each cites its evidence. */
  anticipations: "ky_anticipations",
  /** Each thing ky put in front of the user unasked (a report in a chat, a recall block), and what became of it. */
  surfaced: "ky_surfaced",
  /** How proactive ky is: on or off. One row. */
  proactivity: "ky_proactivity",
  /** The memories each dream run noted, against its cap: one row per dream conversation. */
  dreamNotes: "ky_dream_notes"
} as const;

// Tool names.

export const MEMORY_NOTE = "memory_note";

export const MEMORY_RECALL = "memory_recall";

export const MEMORY_ZOOM = "memory_zoom";

export const MEMORY_FORGET = "memory_forget";

export const CHAT_SEARCH = "chat_search";

export const SOUL_EDIT = "soul_edit";

export const ANTICIPATE = "anticipate";

/** The memory tools that change it; what a specialist may never call. */
export const MEMORY_WRITE_TOOLS = [MEMORY_NOTE, MEMORY_FORGET, ANTICIPATE] as const;

/** The memory extension's tools a dream may call, in the order its prompt lists them. */
export const DREAM_MEMORY_TOOLS = [MEMORY_RECALL, MEMORY_ZOOM, MEMORY_NOTE, MEMORY_FORGET, CHAT_SEARCH, ANTICIPATE] as const;

// Memory.

export const MemoryRow = Schema.Struct({ id: Schema.Int, date: Schema.String, text: Schema.String });

export type MemoryRow = typeof MemoryRow.Type;

const MemoryItem = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("memory"), ...MemoryRow.fields }),
  Schema.Struct({ kind: Schema.Literal("block"), block: Schema.String, text: Schema.NullOr(Schema.String), from: Schema.String, to: Schema.String })
]);

export type MemoryItem = typeof MemoryItem.Type;

const MemoryView = Schema.Struct({ count: Schema.Int, newest: Schema.NullOr(Schema.String), items: Schema.Array(MemoryItem) });

export type MemoryView = typeof MemoryView.Type;

const MemorySearch = Schema.Struct({ matches: Schema.Array(MemoryRow), total: Schema.Int, regex: Schema.Boolean });

export type MemorySearch = typeof MemorySearch.Type;

const CountRow = Type.Object({ n: Type.Integer() });

/** A COUNT(*) row; 0 when it isn't one. */
export const countOf = (row: Row): number => decodeOr(CountRow, row, { n: 0 }).n;

// Anticipations.

/** Who made a row: the nightly dream, an episode review, or the user (through the chat). Only machine-made rows are the dream's to change. */
const CreatorSchema = Type.Union([Type.Literal("dream"), Type.Literal("episode"), Type.Literal("user")]);

export type Creator = Static<typeof CreatorSchema>;

/** A commitment or thread; a date; a question likely next; a condition worth a gate. */
const AnticipationKindSchema = Type.Union([Type.Literal("open_loop"), Type.Literal("upcoming"), Type.Literal("predicted_ask"), Type.Literal("watch")]);

export type AnticipationKind = Static<typeof AnticipationKindSchema>;

export const ANTICIPATION_KINDS: readonly AnticipationKind[] = ["open_loop", "upcoming", "predicted_ask", "watch"];

const StatusSchema = Type.Union([Type.Literal("open"), Type.Literal("surfaced"), Type.Literal("done"), Type.Literal("dismissed"), Type.Literal("expired")]);

export type AnticipationStatus = Static<typeof StatusSchema>;

/** What a row rests on: `ky_history` rowids (chat messages) and `memo_log` ids. */
const EvidenceSchema = Type.Object({ messages: Type.Array(Type.Integer()), memories: Type.Array(Type.Integer()) });

export type Evidence = Static<typeof EvidenceSchema>;

/** A row of ky_anticipations as stored: evidence as JSON text, pinned as 0 or 1, times in epoch ms. */
const AnticipationStoredSchema = Type.Object({
  id: Type.Integer(),
  created_at: Type.Number(),
  created_by: CreatorSchema,
  kind: AnticipationKindSchema,
  text: Type.String(),
  evidence: Type.String(),
  prepared: Type.Union([Type.String(), Type.Null()]),
  window_from: Type.Union([Type.Number(), Type.Null()]),
  window_to: Type.Union([Type.Number(), Type.Null()]),
  status: StatusSchema,
  pinned: Type.Integer(),
  absorbed_into: Type.Union([Type.Integer(), Type.Null()]),
  closed_at: Type.Union([Type.Number(), Type.Null()])
});

export type Anticipation = Omit<Static<typeof AnticipationStoredSchema>, "evidence" | "pinned"> & { readonly evidence: Evidence; readonly pinned: boolean };

/** A stored row, or undefined when a restore left it damaged (evidence included): callers skip it. */
export function anticipationRow(row: Row): Anticipation | undefined {
  const stored = decodeOr(AnticipationStoredSchema, row, undefined);

  if (stored === undefined) return undefined;
  const evidence = parseOr(EvidenceSchema, stored.evidence, undefined);

  return evidence === undefined ? undefined : { ...stored, evidence, pinned: stored.pinned !== 0 };
}

// Proactivity and what ky surfaced.

/** How proactive ky is: on, or off for nothing unasked. */
export const ProactivityLevelSchema = Type.Union([Type.Literal("off"), Type.Literal("on")]);

export type ProactivityLevel = Static<typeof ProactivityLevelSchema>;

/**
 * What became of a surfaced thing: it expired, or, for a recall block, it was missed: the model still searched memory
 * or the chats itself in the same turn. An older ky's brief and suggestions also stored acted and dismissed, never
 * read now.
 */
const SurfacedOutcomeSchema = Type.Union([Type.Literal("expired"), Type.Literal("missed")]);

export type SurfacedOutcome = Static<typeof SurfacedOutcomeSchema>;

export const SURFACED_OUTCOMES: readonly SurfacedOutcome[] = ["expired", "missed"];

/** A shown thing's key and text, as a chat's recall blocks are read back. */
const ShownItemRow = Type.Object({ item: Type.String(), text: Type.String() });

export type ShownItem = Static<typeof ShownItemRow>;

/** A shown item's row, or undefined when it is damaged: callers skip it. */
export const shownItem = (row: Row): ShownItem | undefined => decodeOr(ShownItemRow, row, undefined);

const Recalled = Schema.Struct({ entry: Schema.Int, lines: Schema.Array(Schema.String) });

export type Recalled = typeof Recalled.Type;

/** A look time: local HH:MM. */
export const LOOK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** Look times a user may set, at most. */
export const LOOK_TIMES = 4;

/** Posts a day that may push to the user's devices, at most, as Settings › Proactivity sets it. */
export const RIGHT_AWAY_MOST = 24;

/** Settings › Proactivity: the level, the look times, earliest first, and how many posts a day push right away. */
const ProactivityViewSchema = Type.Object({ level: ProactivityLevelSchema, looks: Type.Array(Type.String()), rightAway: Type.Integer() });

export type ProactivityView = Static<typeof ProactivityViewSchema>;

// SOUL.md.

export const SoulChangeSchema = Type.Object({
  action: Type.Union([Type.Literal("edit"), Type.Literal("patch"), Type.Literal("revert")]),
  body: Type.Optional(Type.String()),
  old: Type.Optional(Type.String()),
  new: Type.Optional(Type.String()),
  version: Type.Optional(Type.Number())
});

export type SoulChange = Static<typeof SoulChangeSchema>;

export type { SoulVersion, SoulView, VersionRefusal } from "./versioned";

// Dreaming.

/**
 * The point the last dream read up to: the memory count, the time, and pi's commit sequence of the last
 * chat message it read (absent or 0 before one was kept, when what was said is read by time).
 */
const MarkSchema = Type.Object({ memories: Type.Integer({ minimum: 0 }), at: Type.Number({ minimum: 0 }), said: Type.Optional(Type.Integer({ minimum: 0 })) });

export type Mark = Static<typeof MarkSchema>;

/** Before the first dream, or when the stored mark is damaged: the beginning, so the next dream reads everything. */
export const NO_MARK: Mark = { memories: 0, at: 0 };

/** The stored mark, or NO_MARK when there is none or it is damaged. */
export const markOf = (row: Row): Mark => decodeOr(MarkSchema, row, NO_MARK);

/** What the dream knows of check-ins: whether it may book them, the user's time zone, and the ones waiting. */
const CheckInsNowSchema = Type.Object({
  on: Type.Boolean(),
  zone: Type.Union([Type.String(), Type.Null()]),
  waiting: Type.Array(Type.String())
});

export type CheckInsNow = Static<typeof CheckInsNowSchema>;

// The dream's ledger.

/**
 * A change a background run made: to a skill (`before` its prior version's id, null for a create; `after` the
 * version it made) or a forget (`before` the summary's words).
 */
export const DreamLedgerRow = Type.Object({
  id: Type.Number(),
  /** The dream's run token, which its stale pass shares; a review's conversation; or, from before tokens, a dream's session or stale-<date>. */
  run: Type.String(),
  /** Who made it: "dream", "review" or a later background run; null for a dream's from before this was kept. */
  actor: Type.Union([Type.String(), Type.Null()]),
  kind: Type.Union([Type.Literal("skill"), Type.Literal("memory")]),
  action: Type.String(),
  /** The skill's name, or the forgotten summary's block. */
  target: Type.String(),
  before: Type.Union([Type.Number(), Type.String(), Type.Null()]),
  reason: Type.Union([Type.String(), Type.Null()]),
  absorbed_into: Type.Union([Type.String(), Type.Null()]),
  /** The skill version the change made; null for a forget, and for changes from before this was kept, whose undo looks at nothing since. */
  after: Type.Union([Type.Number(), Type.Null()]),
  at: Type.Number(),
  undone_at: Type.Union([Type.Number(), Type.Null()])
});

export type DreamLedgerRow = Static<typeof DreamLedgerRow>;

export type { DreamLedger } from "./ledger";

export type { Compressor, Memory } from "./memory";

export type { Presence } from "./presence";

export type { Proactivity } from "./proactivity";

export type { Recall } from "./recall";

export type { Soul } from "./soul";

// The user's local time, from their IANA time zone (the browser's, via Automations.setZone): what the dream's 04:00,
// the look times and a day's pushes are counted in. An unknown or unnamed zone counts as UTC.

/** One formatter per zone, as making one costs far more than using it; null for a zone Intl does not know. */
const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatter(zone: string): Intl.DateTimeFormat | null {
  if (!formatters.has(zone)) {
    try {
      formatters.set(zone, new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }));
    } catch {
      formatters.set(zone, null);
    }
  }

  return formatters.get(zone) ?? null;
}

/** How far `zone` is ahead of UTC at `now`, in minutes; 0 for an unknown or unnamed zone. */
export function offsetMinutes(zone: string | null, now: number): number {
  const format = zone === null ? null : formatter(zone);

  if (format === null) return 0;
  const parts = format.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((each) => each.type === type)?.value ?? 0);
  const wall = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));

  return Math.round((wall - Math.floor(now / 60_000) * 60_000) / 60_000);
}

/**
 * The cron that fires daily at `minutes` past local midnight in `zone`, at its offset at `now`; in UTC when the zone
 * is unknown. A daylight-saving change moves it an hour until it is booked again.
 */
export function localCron(minutes: number, zone: string | null, now = Date.now()): string {
  const utc = (((minutes - offsetMinutes(zone, now)) % 1440) + 1440) % 1440;

  return `${utc % 60} ${Math.floor(utc / 60)} * * *`;
}

/** The local date in `zone` at `now`, YYYY-MM-DD, and the minutes past its midnight. */
export function localNow(zone: string | null, now: number) {
  const wall = now + offsetMinutes(zone, now) * 60_000;

  return { date: new Date(wall).toISOString().slice(0, 10), minutes: Math.floor(wall / 60_000) % 1440 };
}
