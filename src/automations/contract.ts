/**
 * The automations domain's contract: what the rest of ky may know of it. Its stored rows and their
 * schemas, the automation tool's input, the actions and statuses as closed unions, and the names
 * that must never change: the SQL tables, which a backup restores by name (`ky_restore__<table>`),
 * and the tools. Other folders import automations and the task feed from here, never from the
 * files behind it.
 */
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import Type, { type Static, type TSchema } from "typebox";
import { decodeOr, parseOr } from "../core/decode";
import type { Agent } from "../machines/runner-protocol";
import type { ModelChoice } from "../settings";

export type { Automations } from "./automations";

export type { TaskFeed } from "./tasks";

/** The domain's SQL tables, by name. A restore stages each as `ky_restore__<table>`: never rename one. */
export const AUTOMATION_TABLES = Object.freeze({
  automations: "ky_automations",
  checkIns: "ky_check_ins",
  tasks: "ky_tasks"
} as const);

/** The automation tool, and the extensions that carry it and the check-in guard. */
export const AUTOMATION_TOOL = "automation";

export const EXTENSIONS = Object.freeze({ automations: "automations", checkInGuard: "check-in-guard" } as const);

/** The tools a check-in run may call: web search through Executor, and the cloud browser. */
export const CHECK_IN_TOOLS: readonly string[] = Object.freeze(["executor_skills", "executor_execute", "browse"]);

/** Where an automation's runs say they came from in the task feed: `automation:<id>`. */
export const AUTOMATION_SOURCE = "automation:";

// Automations.

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ModelThinkingLevel[];

const Level = Type.Union(LEVELS.map((level) => Type.Literal(level)));

/** A model choice as the `model` column holds it, JSON. */
const ModelColumn = Type.Object({ provider: Type.String(), modelId: Type.String(), thinkingLevel: Level });

const AutomationStatusSchema = Type.Union([Type.Literal("active"), Type.Literal("paused"), Type.Literal("done"), Type.Literal("archived")]);

/** `done`: a one-off that has run. */
export type AutomationStatus = Static<typeof AutomationStatusSchema>;

const AuthorSchema = Type.Union([Type.Literal("user"), Type.Literal("ky"), Type.Literal("dream")]);

export type AutomationAuthor = Static<typeof AuthorSchema>;

const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/** A `ky_automations` row as SQL gives it: `model` is JSON text, or null for the worker's. */
const StoredAutomation = Type.Object({
  id: Type.String(),
  title: Type.String(),
  prompt: Type.String(),
  cron: Nullable(Type.String()),
  at: Nullable(Type.Number()),
  model: Nullable(Type.String()),
  machine: Nullable(Type.String()),
  chat: Type.String(),
  created_by: AuthorSchema,
  status: AutomationStatusSchema,
  schedule_id: Nullable(Type.String()),
  created_at: Type.Number(),
  updated_at: Type.Number()
});

/**
 * An automation. `prompt` is all each run is told; `cron` is a 5-field UTC cron and `at` a one-off's
 * epoch ms, exactly one set; `model` null runs on the worker's; `machine` null runs in the cloud;
 * `chat` is the main chat or a side chat's session; `schedule_id` is its Scheduler booking while active.
 */
export type AutomationRow = Readonly<Omit<Static<typeof StoredAutomation>, "model"> & { model: ModelChoice | null }>;

/** What a schedule is and does: everything create and update set. */
export type AutomationDraft = Pick<AutomationRow, "title" | "prompt" | "cron" | "at" | "model" | "machine" | "chat">;

/** The `ky_check_ins` row: whether the user turned check-ins off, and their time zone. */
export const StoredCheckIns = Type.Object({ off: Type.Number(), zone: Nullable(Type.String()) });

/** Whether check-ins are on, and the user's time zone as their browser's connection last placed it. */
export type CheckIns = { readonly on: boolean; readonly zone: string | null };

/** A `SELECT COUNT(*) AS n` row. */
export const CountRow = Type.Object({ n: Type.Number() });

// The task feed.

const TaskKindSchema = Type.Union([Type.Literal("cloud"), Type.Literal("machine")]);

export type TaskKind = Static<typeof TaskKindSchema>;

const TaskStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("working"),
  Type.Literal("done"),
  Type.Literal("failed"),
  Type.Literal("stopped")
]);

export type TaskStatus = Static<typeof TaskStatusSchema>;

/** One thing a task did, such as "Reading tasks.ts", and when. */
const TaskStepSchema = Type.Object({ at: Type.Number(), text: Type.String() });

export type TaskStep = Readonly<Static<typeof TaskStepSchema>>;

/** The `steps` column: JSON, oldest first. */
const StepsColumn = Type.Array(TaskStepSchema);

const AgentSchema = Type.Union([Type.Literal("claude"), Type.Literal("codex")]);

/** A `ky_tasks` row as SQL gives it: `steps` is JSON text. */
const StoredTask = Type.Object({
  id: Type.String(),
  kind: TaskKindSchema,
  source: Type.String(),
  worker: Type.String(),
  title: Type.String(),
  status: TaskStatusSchema,
  summary: Type.String(),
  steps: Type.String(),
  session: Nullable(Type.String()),
  agent: Nullable(AgentSchema),
  created_at: Type.Number(),
  updated_at: Type.Number(),
  started_at: Nullable(Type.Number()),
  finished_at: Nullable(Type.Number()),
  turns: Nullable(Type.Number()),
  cost_usd: Nullable(Type.Number())
});

/**
 * One piece of delegated work. `source` is why it exists ("chat", `automation:<id>`); `worker` the
 * subagent or machine; `summary` its result once a turn ends; `steps` its last few, the last what it
 * does now; `session` the pi session (cloud) or the agent's own session (machine); `agent` the coding
 * agent a machine task runs as; `started_at`/`finished_at` its latest stretch of work; `turns` and
 * `cost_usd` null until something reports them.
 */
export type TaskRow = Readonly<Omit<Static<typeof StoredTask>, "steps" | "agent"> & { steps: readonly TaskStep[]; agent: Agent | null }>;

export type TaskPatch = Partial<Pick<TaskRow, "title" | "status" | "summary" | "session">>;

/** A `PRAGMA table_info` row: only the column name is read. */
export const ColumnInfo = Type.Object({ name: Type.String() });

/** Writes better titles and summaries than a first line, in the background. */
export type TaskNamer = {
  readonly title: (id: string, text: string) => void;
  readonly summary: (id: string, text: string) => void;
};

const SUMMARY_CHARS = 240;

/** First line of a text, trimmed to fit a task card. */
export function summarize(text: string): string {
  const line = text.trim().split("\n").find((part) => part.trim() !== "") ?? "";

  return line.length > SUMMARY_CHARS ? `${line.slice(0, SUMMARY_CHARS - 1)}…` : line;
}

export type LastRun = Pick<TaskRow, "id" | "status" | "summary" | "finished_at">;

/** An automation as the Activity view and the tool show it. */
export type AutomationView = Omit<AutomationRow, "schedule_id"> & {
  /** When it fires next, in epoch ms; null when nothing is booked. */
  readonly next_run: number | null;
  readonly last_run: LastRun | null;
};

// The automation tool and the user's actions.

/** The actions on one automation by its id, each an Automations method of the same name. */
export const BY_ID_ACTIONS = ["pause", "resume", "archive", "unarchive", "run", "delete"] as const;

export type ByIdAction = (typeof BY_ID_ACTIONS)[number];

/** What the user can do to an automation from Activity: every by-id action. */
export type AutomationAction = ByIdAction;

/** Every action the tool takes: the ones that make, change or list automations, and the by-id ones. */
export const TOOL_ACTIONS = ["create", "update", "list", ...BY_ID_ACTIONS] as const;

export type ToolAction = (typeof TOOL_ACTIONS)[number];

/** The automation tool's input. */
export const AutomationToolInput = Type.Object({
  action: Type.Union(TOOL_ACTIONS.map((action) => Type.Literal(action))),
  id: Type.Optional(Type.String({ description: "An automation id from create or list." })),
  title: Type.Optional(Type.String({ description: "3-6 words for the automations list." })),
  prompt: Type.Optional(Type.String({ description: "What each run does; self-contained, since a run knows nothing else." })),
  cron: Type.Optional(Type.String({ description: "A 5-field cron in UTC, like 0 9 * * 1-5." })),
  at: Type.Optional(Type.String({ description: "A one-off's time, ISO with a zone, like 2026-10-06T09:00:00Z." })),
  model: Type.Optional(Type.String({ description: "provider/modelId; leave out, or worker to clear it, for the worker model." })),
  thinking: Type.Optional(Level),
  machine: Type.Optional(Type.String({ description: "Run on this machine instead of the cloud; cloud to clear it." })),
  chat: Type.Optional(Type.String({ description: "Where results are reported: main, or a side chat's session; this chat when left out." })),
  createdBy: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("ky")])),
  all: Type.Optional(Type.Boolean({ description: "list: include done and archived ones." }))
});

export type AutomationToolArgs = Readonly<Static<typeof AutomationToolInput>>;

// Reading rows: the only way a stored row becomes typed.

/** The rows that are automations; a damaged model reads as none (the worker's), and a row a restore damaged past reading is left out. */
export function automationRows(rows: readonly unknown[]): AutomationRow[] {
  return rows.flatMap((row) => {
    const stored = decodeOr(StoredAutomation, row, undefined);

    if (stored === undefined) return [];

    return [{ ...stored, model: stored.model === null ? null : parseOr(ModelColumn, stored.model, null) }];
  });
}

/** The rows that are tasks; damaged steps read as none, and a row a restore damaged past reading is left out. */
export function taskRows(rows: readonly unknown[]): TaskRow[] {
  return rows.flatMap((row) => {
    const stored = decodeOr(StoredTask, row, undefined);

    return stored === undefined ? [] : [{ ...stored, steps: parseOr(StepsColumn, stored.steps, []) }];
  });
}
