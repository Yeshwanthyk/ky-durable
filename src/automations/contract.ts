/**
 * The automations domain's contract: what the rest of ky may know of it. Its stored rows and their
 * schemas, the automation tool's input, the actions and statuses as closed unions, and the names
 * that must never change: the SQL tables, which a backup restores by name (`ky_restore__<table>`),
 * and the tools. Other folders import automations and the task feed from here, never from the
 * files behind it.
 */
import Type, { type Static, type TSchema } from "typebox";
import { decodeOr, parseOr } from "../core/decode";
import type { Agent } from "../machines/contract";
import { type ModelChoice, ModelChoiceSchema, ThinkingLevelSchema } from "../settings";

export type { Automations } from "./automations";

export type { TaskFeed } from "./tasks";

/** The domain's SQL tables, by name. A restore stages each as `ky_restore__<table>`: never rename one. */
export const AUTOMATION_TABLES = Object.freeze({
  automations: "ky_automations",
  checkIns: "ky_check_ins",
  tasks: "ky_tasks",
  taskSteps: "ky_task_steps",
  deliveries: "ky_deliveries"
} as const);

/** The automation tool, and the extensions that carry it and the check-in guard. */
export const AUTOMATION_TOOL = "automation";

export const EXTENSIONS = Object.freeze({ automations: "automations", checkInGuard: "check-in-guard" } as const);

/** The tools a check-in run may call: web search through Executor, and the cloud browser. */
export const CHECK_IN_TOOLS: readonly string[] = Object.freeze(["executor_skills", "executor_execute", "browse"]);

/** Where an automation's runs say they came from in the task feed: `automation:<id>`. */
export const AUTOMATION_SOURCE = "automation:";

// Automations.

const Level = ThinkingLevelSchema;

/** A model choice as the `model` column holds it, JSON. */
const ModelColumn = ModelChoiceSchema;

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
  zone: Nullable(Type.String()),
  at: Nullable(Type.Number()),
  model: Nullable(Type.String()),
  machine: Nullable(Type.String()),
  chat: Type.String(),
  gate: Nullable(Type.String()),
  gate_checked_at: Nullable(Type.Number()),
  gate_note: Nullable(Type.String()),
  gate_errors: Type.Number(),
  watch: Nullable(Type.Integer()),
  post: Type.Integer(),
  created_by: AuthorSchema,
  status: AutomationStatusSchema,
  schedule_id: Nullable(Type.String()),
  created_at: Type.Number(),
  updated_at: Type.Number()
});

/**
 * An automation. `prompt` is all each run is told; `cron` is a 5-field cron and `at` a one-off's
 * epoch ms, exactly one set. `cron` names wall-clock times in `zone`, or in the user's zone when that is null;
 * "UTC" marks one written before crons followed the user's zone that could not be moved to it.
 * `model` null runs on the worker's; `machine` null runs in the cloud;
 * `chat` is the main chat or a side chat's session; `schedule_id` is its Scheduler booking while active.
 * `gate` is an Executor program each fire runs first, with no model: the run starts only when it returns
 * something (null runs every fire); `gate_checked_at` and `gate_note` say when the last check ran and what
 * it came to, and `gate_errors` counts fires in a row whose gate failed (three pause it). `watch` is the watch
 * anticipation a look booked it for (src/dreaming/looks.ts), which retires it when that closes; null for any other.
 * `post` puts each run's report in its chat as ky's own message, as written, instead of giving it to the chat's agent.
 */
export type AutomationRow = Readonly<Omit<Static<typeof StoredAutomation>, "model" | "post"> & { model: ModelChoice | null; post: boolean }>;

/** What a schedule is and does: everything create and update set. */
export const AutomationDraftSchema = Type.Object({
  title: Type.String(),
  prompt: Type.String(),
  cron: Nullable(Type.String()),
  at: Nullable(Type.Number()),
  model: Nullable(ModelChoiceSchema),
  machine: Nullable(Type.String()),
  chat: Type.String(),
  gate: Nullable(Type.String()),
  post: Type.Optional(Type.Boolean())
});

/** Without `post`, a create reports as an event and an update keeps what it had. */
export type AutomationDraft = Pick<AutomationRow, "title" | "prompt" | "cron" | "at" | "model" | "machine" | "chat" | "gate"> & Partial<Pick<AutomationRow, "post">>;

/** A title and a prompt are needed: the list shows one, and a run knows only the other. */
function wordsProblem(draft: Pick<AutomationDraft, "title" | "prompt">): string | undefined {
  return draft.title.trim() && draft.prompt.trim() ? undefined : "An automation needs a title and a prompt.";
}

/** What is wrong with when it runs, if anything. */
function timingProblem(draft: Pick<AutomationDraft, "cron" | "at">): string | undefined {
  if ((draft.cron === null) === (draft.at === null)) return "Give exactly one of cron or at.";

  if (draft.at !== null && !Number.isFinite(draft.at)) return "at must be an ISO time, like 2026-10-06T09:00:00Z.";

  return undefined;
}

/** A gate is a program body; blank means no gate, and is saved as null by the tool and the UI. */
function gateProblem(gate: string | null): string | undefined {
  return gate !== null && gate.trim() === "" ? "A gate is an Executor program; leave it out for none." : undefined;
}

/**
 * What is wrong with what a draft is and does, before anything else is checked (its model, machine and chat, and
 * a cron's syntax, which booking checks): the automation tool's and the UI's saves alike.
 */
export function draftProblem(draft: Pick<AutomationDraft, "title" | "prompt" | "cron" | "at" | "gate">): string | undefined {
  return wordsProblem(draft) ?? timingProblem(draft) ?? gateProblem(draft.gate);
}

/** The `ky_check_ins` row: whether the user turned check-ins off, their time zone, and whether they pinned it. */
export const StoredCheckIns = Type.Object({ off: Type.Number(), zone: Nullable(Type.String()), zone_pinned: Type.Number() });

/** Whether check-ins are on, and the user's time zone: pinned in Settings, or as their browser's connection last placed it. */
export type CheckIns = { readonly on: boolean; readonly zone: string | null; readonly pinned: boolean };

/** Settings › Proactivity's time zone: the check-ins, and the zone the asking browser's connection is placed in, if known. */
export type ZoneView = CheckIns & { readonly detected: string | null };

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

const StepStateSchema = Type.Union([Type.Literal("running"), Type.Literal("done"), Type.Literal("failed")]);

/**
 * One step of a task's full log, for its timeline: `call` the tool call it is, when there is one;
 * `text` its title, `detail` what came back, `input` and `output` the raw call, cut to fit.
 */
const TaskLogStepSchema = Type.Object({
  seq: Type.Number(),
  call: Nullable(Type.String()),
  at: Type.Number(),
  ended_at: Nullable(Type.Number()),
  state: StepStateSchema,
  text: Type.String(),
  detail: Type.String(),
  input: Type.String(),
  output: Type.String()
});

export type TaskLogStep = Readonly<Static<typeof TaskLogStepSchema>>;

/** The rows of `ky_task_steps` that read as steps. */
export const taskLogRows = (rows: readonly unknown[]): TaskLogStep[] => rows.flatMap((row) => decodeOr(TaskLogStepSchema, row, undefined) ?? []);

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
  chat: Nullable(Type.String()),
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
 * does now; `session` the pi session (cloud) or the agent's own session (machine); `chat` the session
 * of the chat it works for, if any; `agent` the coding agent a machine task runs as;
 * `started_at`/`finished_at` its latest stretch of work; `turns` and `cost_usd` null until something
 * reports them.
 */
export type TaskRow = Readonly<Omit<Static<typeof StoredTask>, "steps" | "agent"> & { steps: readonly TaskStep[]; agent: Agent | null }>;

export type TaskPatch = Partial<Pick<TaskRow, "title" | "status" | "summary" | "session">>;

/**
 * Something ky tells a chat between turns: an event, an automation run's report or the notice that it paused,
 * which the chat's agent is given and answers; or a look's message (src/dreaming/looks.ts), or a post automation's
 * report, which is posted as ky's own, as written, and starts no turn. `id` is its one identity, the request id pi takes it by, so however
 * often it is handed over it is delivered once; `content` is what the chat's agent is given, or the look's
 * message; `line` is it in one line, as what ky surfaced keeps it; `ref` is what it rests on, like
 * task:a-1f2e-1760600000 or anticipation:12. Without a kind it is an event. A chat's is an event another chat sent
 * with an older chats tool, kept so a row it left queued still goes in: its agent answers it, but the user is not
 * pushed it, nor is it kept as surfaced.
 */
export const DeliverySchema = Type.Object({
  id: Type.String(),
  session: Type.String(),
  content: Type.String(),
  line: Type.String(),
  ref: Type.String(),
  kind: Type.Optional(Type.Union([Type.Literal("event"), Type.Literal("look"), Type.Literal("post"), Type.Literal("chat")])),
  /** The cards an automation's run showed (src/ui-tool.ts), as a JSON array, posted before the item. */
  cards: Type.Optional(Nullable(Type.String()))
});

export type Delivery = Readonly<Static<typeof DeliverySchema>>;

/** A row naming a chat, as `ky_deliveries` lists the ones with something waiting. */
export const SessionRow = Type.Object({ session: Type.String() });

/** What an automation's gate last found, as a hash, and the task it started; null for nothing. */
export const GateFoundRow = Type.Object({ gate_found: Nullable(Type.String()), gate_found_by: Nullable(Type.String()) });

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

/** One run for an automation's history: how it went, when, how long and what it cost. */
export type RunInfo = Pick<TaskRow, "id" | "status" | "summary" | "created_at" | "started_at" | "finished_at" | "cost_usd">;

/** How many runs an automation's history shows. */
export const RUN_HISTORY = 14;

/** An automation as the Activity view and the tool show it. */
export type AutomationView = Omit<AutomationRow, "schedule_id" | "zone"> & {
  /** The zone its cron's times are in: its own, else the user's, else UTC. */
  readonly zone: string;
  /** When it fires next, in epoch ms; null when nothing is booked. */
  readonly next_run: number | null;
  readonly last_run: LastRun | null;
  /** Its newest RUN_HISTORY runs, newest first. */
  readonly runs: readonly RunInfo[];
};

// The automation tool and the user's actions.

/** The actions on one automation by its id, each an Automations method of the same name. */
export const BY_ID_ACTIONS = ["pause", "resume", "archive", "unarchive", "run", "stop", "delete"] as const;

export type ByIdAction = (typeof BY_ID_ACTIONS)[number];

/** What the user can do to an automation from Activity: every by-id action. */
export type AutomationAction = ByIdAction;

export const AutomationActionSchema = Type.Unsafe<AutomationAction>(Type.Union(BY_ID_ACTIONS.map((action) => Type.Literal(action))));

/** Every action the tool takes: the ones that make, change or list automations, and the by-id ones. */
export const TOOL_ACTIONS = ["create", "update", "list", ...BY_ID_ACTIONS] as const;

export type ToolAction = (typeof TOOL_ACTIONS)[number];

/** The automation tool's input. */
export const AutomationToolInput = Type.Object({
  action: Type.Union(TOOL_ACTIONS.map((action) => Type.Literal(action))),
  id: Type.Optional(Type.String({ description: "An automation id from create or list." })),
  title: Type.Optional(Type.String({ description: "3-6 words for the automations list." })),
  prompt: Type.Optional(Type.String({ description: "What each run does; self-contained, since a run knows nothing else." })),
  cron: Type.Optional(Type.String({ description: "A 5-field cron in the user's time zone, like 0 9 * * 1-5 for 9 AM on weekdays." })),
  at: Type.Optional(Type.String({ description: "A one-off's time, ISO with a zone, like 2026-10-06T09:00:00Z." })),
  model: Type.Optional(Type.String({ description: "provider/modelId; leave out, or worker to clear it, for the worker model." })),
  thinking: Type.Optional(Level),
  machine: Type.Optional(Type.String({ description: "Run on this machine instead of the cloud; cloud to clear it." })),
  chat: Type.Optional(Type.String({ description: "Where results are reported: main, or a side chat's session; this chat when left out." })),
  gate: Type.Optional(
    Type.String({
      description:
        "An Executor program body run before each fire, with no model: return the matching items to run, or null to skip. none to clear it."
    })
  ),
  post: Type.Optional(Type.Boolean({ description: "true: post each report as ky's own message, as written, without a reply; a card the run shows is posted just before it." })),
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

    return [{ ...stored, model: stored.model === null ? null : parseOr(ModelColumn, stored.model, null), post: stored.post === 1 }];
  });
}

/** The rows that are tasks; damaged steps read as none, and a row a restore damaged past reading is left out. */
export function taskRows(rows: readonly unknown[]): TaskRow[] {
  return rows.flatMap((row) => {
    const stored = decodeOr(StoredTask, row, undefined);

    return stored === undefined ? [] : [{ ...stored, steps: parseOr(StepsColumn, stored.steps, []) }];
  });
}
