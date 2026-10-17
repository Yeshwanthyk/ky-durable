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
  /** The brief: one row per local day, its lines as JSON, gone at the user's midnight. */
  brief: "ky_brief",
  /** Each thing ky put in front of the user unasked (a brief line), and what they did with it. */
  surfaced: "ky_surfaced",
  /** How proactive ky is: off, the brief only, or the brief and boundary lines. One row. */
  proactivity: "ky_proactivity",
  /** Automations a dream suggested from a check the user kept doing by hand, until the user accepts or dismisses each. */
  proposals: "ky_proposals",
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

// The brief and what ky surfaced.

/** How proactive ky is: nothing unasked, a morning brief, or the brief and lines at a task's boundary. */
export const ProactivityLevelSchema = Type.Union([Type.Literal("off"), Type.Literal("brief"), Type.Literal("boundary")]);

export type ProactivityLevel = Static<typeof ProactivityLevelSchema>;

export const PROACTIVITY_LEVELS: readonly ProactivityLevel[] = ["off", "brief", "boundary"];

/** Where a brief line came from: the dream, or an event while the user was away; `ref` names what it rests on, like anticipation:12. */
const BriefSourceSchema = Type.Object({ loop: Type.Union([Type.Literal("dream"), Type.Literal("event")]), ref: Type.String() });

export type BriefSource = Static<typeof BriefSourceSchema>;

/** A line as ky_brief stores it: its text, source, and the prepared ask its chip puts in the composer. */
const BriefLineSchema = Type.Object({ text: Type.String(), source: BriefSourceSchema, chip: Type.Union([Type.String(), Type.Null()]) });

export type BriefLine = Static<typeof BriefLineSchema>;

/** A row of ky_brief as stored: its lines as JSON text, and its midnight. */
const BriefStoredSchema = Type.Object({ lines: Type.String(), expires_at: Type.Number() });

/** A day's stored lines and midnight, or undefined when there is no row or a restore damaged it (lines included). */
export function briefRow(row: Row): { lines: BriefLine[]; expires_at: number } | undefined {
  const stored = decodeOr(BriefStoredSchema, row, undefined);
  const lines = stored === undefined ? undefined : parseOr(Type.Array(BriefLineSchema), stored.lines, undefined);

  return stored === undefined || lines === undefined ? undefined : { lines, expires_at: stored.expires_at };
}

/** A line as the card shows it: its key (day#n), where it came from (like "anticipation #12 · chat 14 Oct"), and whether the user pinned it. */
const BriefCardLineSchema = Type.Object({
  key: Type.String(),
  text: Type.String(),
  source: Type.String(),
  chip: Type.Union([Type.String(), Type.Null()]),
  pinned: Type.Boolean()
});

export type BriefCardLine = Static<typeof BriefCardLineSchema>;

/** The card: the local day, when it goes (the user's midnight, epoch ms), and its lines. */
const BriefViewSchema = Type.Object({ day: Type.String(), expires_at: Type.Number(), lines: Type.Array(BriefCardLineSchema) });

export type BriefView = Static<typeof BriefViewSchema>;

/**
 * What became of a surfaced thing; ignored is a boundary line the user went past, and cleared a line the user
 * swept away with the rest of the card (Dismiss all): milder than dismissed, it is neither a dismissal in the
 * rates nor something the dream is told to avoid. Missed is a recall block after which the model still searched
 * memory or the chats itself in the same turn.
 */
const SurfacedOutcomeSchema = Type.Union([
  Type.Literal("acted"),
  Type.Literal("pinned"),
  Type.Literal("dismissed"),
  Type.Literal("cleared"),
  Type.Literal("ignored"),
  Type.Literal("expired"),
  Type.Literal("missed")
]);

export type SurfacedOutcome = Static<typeof SurfacedOutcomeSchema>;

export const SURFACED_OUTCOMES: readonly SurfacedOutcome[] = ["acted", "pinned", "dismissed", "cleared", "ignored", "expired", "missed"];

/** A shown thing's key and text, as a chat's recall blocks are read back. */
const ShownItemRow = Type.Object({ item: Type.String(), text: Type.String() });

export type ShownItem = Static<typeof ShownItemRow>;

/** A shown item's row, or undefined when it is damaged: callers skip it. */
export const shownItem = (row: Row): ShownItem | undefined => decodeOr(ShownItemRow, row, undefined);

/** A pi entry's id and its message's timestamp, as recall reads a chat's user messages. */
const EntryAtRow = Type.Object({ id: Type.Integer(), at: Type.Number() });

/** An entry's id and timestamp, or undefined when the row has none (not a message): callers skip it. */
export const entryAt = (row: Row): Static<typeof EntryAtRow> | undefined => decodeOr(EntryAtRow, row, undefined);

/** The context recalled for a user's message, by its pi entry id: the lines its chip shows (src/dreaming/recall.ts). */
export type Recalled = { readonly entry: number; readonly lines: readonly string[] };

/** One outcome's count, null for the shown ones that have none yet. */
const OutcomeCountRow = Type.Object({ outcome: Type.Union([SurfacedOutcomeSchema, Type.Null()]), n: Type.Integer() });

/** A GROUP BY outcome row, or undefined when it is damaged: callers skip it. */
export const outcomeCount = (row: Row): Static<typeof OutcomeCountRow> | undefined => decodeOr(OutcomeCountRow, row, undefined);

/** A rate as Settings › Proactivity shows it: so many of so many; nothing to show while `of` is 0. */
const RateSchema = Type.Object({ count: Type.Integer(), of: Type.Integer() });

export type Rate = Static<typeof RateSchema>;

/** Settings › Proactivity: the level, and how the last week's brief and the last month's anticipations went. */
const ProactivityViewSchema = Type.Object({
  level: ProactivityLevelSchema,
  /** Brief lines acted on or pinned, of those shown and settled (handled, or past their midnight), the last 7 days. */
  accepted: RateSchema,
  /** Brief lines dismissed one by one, of those shown and settled, the last 7 days. */
  dismissed: RateSchema,
  /** Anticipations that expired unseen, of those made, the last 30 days. */
  expired: RateSchema
});

export type ProactivityView = Static<typeof ProactivityViewSchema>;

// Proposals.

/** Open until the user decides; accepted made the automation, dismissed latches its key forever. */
const ProposalStatusSchema = Type.Union([Type.Literal("open"), Type.Literal("accepted"), Type.Literal("dismissed")]);

export type ProposalStatus = Static<typeof ProposalStatusSchema>;

/** What a proposal would create: a recurring automation's schedule (UTC cron), its prompt, and an optional gate. */
const ProposalSpecSchema = Type.Object({ cron: Type.String(), prompt: Type.String(), gate: Type.Union([Type.String(), Type.Null()]) });

export type ProposalSpec = Static<typeof ProposalSpecSchema>;

/** A row of ky_proposals as stored: the spec and evidence as JSON text, times in epoch ms. */
const ProposalStoredSchema = Type.Object({
  id: Type.Integer(),
  dedup_key: Type.String(),
  title: Type.String(),
  why: Type.String(),
  spec: Type.String(),
  evidence: Type.String(),
  status: ProposalStatusSchema,
  created_at: Type.Number(),
  decided_at: Type.Union([Type.Number(), Type.Null()])
});

export type Proposal = Omit<Static<typeof ProposalStoredSchema>, "spec" | "evidence"> & { readonly spec: ProposalSpec; readonly evidence: Evidence };

/** A stored row, or undefined when a restore left it damaged (spec or evidence included): callers skip it. */
export function proposalRow(row: Row): Proposal | undefined {
  const stored = decodeOr(ProposalStoredSchema, row, undefined);
  const spec = stored === undefined ? undefined : parseOr(ProposalSpecSchema, stored.spec, undefined);
  const evidence = stored === undefined ? undefined : parseOr(EvidenceSchema, stored.evidence, undefined);

  return stored === undefined || spec === undefined || evidence === undefined ? undefined : { ...stored, spec, evidence };
}

/** A key and its status, as the dream's digest lists them so it never offers one twice. */
const ProposalKeyRow = Type.Object({ dedup_key: Type.String(), status: ProposalStatusSchema });

export const proposalKey = (row: Row): Static<typeof ProposalKeyRow> | undefined => decodeOr(ProposalKeyRow, row, undefined);

/** Activity › Suggested: an open proposal, with the local days of the user's messages it rests on. */
const ProposalViewSchema = Type.Object({
  id: Type.Integer(),
  title: Type.String(),
  why: Type.String(),
  cron: Type.String(),
  prompt: Type.String(),
  gate: Type.Union([Type.String(), Type.Null()]),
  days: Type.Array(Type.String()),
  created_at: Type.Number()
});

export type ProposalView = Static<typeof ProposalViewSchema>;

// SOUL.md.

export {
  columnName,
  type SoulChange,
  SoulChangeSchema,
  soulVersion,
  type SoulVersion,
  type SoulView,
  Versioned,
  versionLine,
  versionOf
} from "./versioned.ts";

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

/** A ledger row as stored, or undefined when a restore left it damaged: callers skip it. */
export const ledgerRow = (row: Row): DreamLedgerRow | undefined => decodeOr(DreamLedgerRow, row, undefined);

export type { DreamLedger } from "./ledger";

export type { Compressor, Memory } from "./memory";

export type { Presence } from "./presence";

export type { Brief } from "./brief";

export type { Proactivity } from "./proactivity";

export type { Proposals } from "./proposals";

export type { Recall } from "./recall";

export type { Soul } from "./soul";
