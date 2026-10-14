import Type, { type Static } from "typebox";
import { decodeOr } from "../core/decode";

/**
 * The dreaming domain's shapes, names and row decoders: memory (OptMem), SOUL.md and its versioned
 * files, and the nightly dream's mark. A leaf module, so memory.ts, soul.ts and dreaming.ts can
 * import it and contract.ts can re-export it without a cycle. Outside src/dreaming/, import
 * contract.ts.
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
  /** Every version of SOUL.md and of each specialist's brief, told apart by `key`. */
  soulVersions: "ky_soul_versions"
} as const;

// Tool names.

export const MEMORY_NOTE = "memory_note";

export const MEMORY_RECALL = "memory_recall";

export const MEMORY_ZOOM = "memory_zoom";

export const MEMORY_FORGET = "memory_forget";

export const CHAT_SEARCH = "chat_search";

export const SOUL_EDIT = "soul_edit";

/** The memory tools that change it; what a specialist may never call. */
export const MEMORY_WRITE_TOOLS = [MEMORY_NOTE, MEMORY_FORGET] as const;

/** The memory extension's tools a dream may call, in the order its prompt lists them. */
export const DREAM_MEMORY_TOOLS = [MEMORY_RECALL, MEMORY_ZOOM, MEMORY_NOTE, MEMORY_FORGET, CHAT_SEARCH] as const;

// Memory.

const MemoryRowSchema = Type.Object({ id: Type.Integer(), date: Type.String(), text: Type.String() });

export type MemoryRow = Static<typeof MemoryRowSchema>;

/** One line of the memory as the panel shows it: a raw memory, or a block and its summary. */
const MemoryItemSchema = Type.Union([
  Type.Object({ kind: Type.Literal("memory"), ...MemoryRowSchema.properties }),
  Type.Object({
    kind: Type.Literal("block"),
    /** Its id, like "16-31". */
    block: Type.String(),
    /** Its summary; null until the agent writes it. */
    text: Type.Union([Type.String(), Type.Null()]),
    /** The dates of its oldest and newest memory. */
    from: Type.String(),
    to: Type.String()
  })
]);

export type MemoryItem = Static<typeof MemoryItemSchema>;

/** What the panel shows first: wake's view of the memory, newest first. */
const MemoryViewSchema = Type.Object({
  count: Type.Integer(),
  /** The newest memory's date, YYYY-MM-DD; null when there are none. */
  newest: Type.Union([Type.String(), Type.Null()]),
  items: Type.Array(MemoryItemSchema)
});

export type MemoryView = Static<typeof MemoryViewSchema>;

/** A search's newest matches, and how many there were. */
const MemorySearchSchema = Type.Object({ matches: Type.Array(MemoryRowSchema), total: Type.Integer(), regex: Type.Boolean() });

export type MemorySearch = Static<typeof MemorySearchSchema>;

const CountRow = Type.Object({ n: Type.Integer() });

const SummaryRow = Type.Object({ text: Type.String() });

const DatesRow = Type.Object({ from: Type.String(), to: Type.String() });

/** A memory row as stored, or undefined when a restore left it damaged: callers skip it. */
export const memoryRow = (row: Row): MemoryRow | undefined => decodeOr(MemoryRowSchema, row, undefined);

/** A COUNT(*) row; 0 when it isn't one. */
export const countOf = (row: Row): number => decodeOr(CountRow, row, { n: 0 }).n;

/** A summary row's text, or undefined when there is none or it is damaged: the block is then owed again. */
export const summaryOf = (row: Row): string | undefined => decodeOr(SummaryRow, row, undefined)?.text;

/** A block's oldest and newest dates; empty when they can't be read. */
export const datesOf = (row: Row): Static<typeof DatesRow> => decodeOr(DatesRow, row, { from: "", to: "" });

// SOUL.md.

const SoulVersionSchema = Type.Object({
  id: Type.Integer(),
  action: Type.String(),
  /** "template", "agent", or "user". */
  actor: Type.String(),
  /** The conversation that made it; null for the template and the user's edits. */
  conversation: Type.Union([Type.String(), Type.Null()]),
  body: Type.String(),
  created_at: Type.Number()
});

export type SoulVersion = Static<typeof SoulVersionSchema>;

const SoulActionSchema = Type.Union([Type.Literal("edit"), Type.Literal("patch"), Type.Literal("revert")]);

export type SoulAction = Static<typeof SoulActionSchema>;

/** One change to SOUL.md; which fields it needs depends on the action. */
const SoulChangeSchema = Type.Object({
  action: SoulActionSchema,
  body: Type.Optional(Type.String()),
  old: Type.Optional(Type.String()),
  new: Type.Optional(Type.String()),
  version: Type.Optional(Type.Number())
});

export type SoulChange = Static<typeof SoulChangeSchema>;

/** What the panel shows: the file and its newest version. */
const SoulViewSchema = Type.Object({ body: Type.String(), version: Type.Integer(), updated_at: Type.Number() });

export type SoulView = Static<typeof SoulViewSchema>;

const ColumnRow = Type.Object({ name: Type.String() });

const VersionRow = Type.Object({ version: Type.Integer() });

/** A version row as stored, or undefined when a restore left it damaged: callers skip it. */
export const soulVersion = (row: Row): SoulVersion | undefined => decodeOr(SoulVersionSchema, row, undefined);

/** A PRAGMA table_info row's column name; "" when it isn't one. */
export const columnName = (row: Row): string => decodeOr(ColumnRow, row, { name: "" }).name;

/** The version an insert returned; 0 when it isn't one. */
export const versionOf = (row: Row): number => decodeOr(VersionRow, row, { version: 0 }).version;

// Dreaming.

/** The point the last dream read up to: the memory count and the time. */
const MarkSchema = Type.Object({ memories: Type.Integer({ minimum: 0 }), at: Type.Number({ minimum: 0 }) });

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
