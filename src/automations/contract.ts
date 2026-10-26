import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import Type, { type Static, type TSchema } from "typebox";
import { decodeOr, parseOr } from "../core/decode";
import type { Refusable } from "../core/edge";
import type { Agent } from "../machines/contract";
import { type ModelChoice, ModelChoiceSchema, ThinkingLevelSchema } from "../settings";

export type { Automations } from "./wiring";

export { nextLocals } from "./zoned";

export type { TaskFeed } from "./tasks";

export const AUTOMATION_TABLES = Object.freeze({
  automations: "ky_automations",
  checkIns: "ky_check_ins",
  tasks: "ky_tasks",
  taskSteps: "ky_task_steps",
  deliveries: "ky_deliveries"
} as const);

export const AUTOMATION_TOOL = "automation";

export const EXTENSIONS = Object.freeze({ automations: "automations", checkInGuard: "check-in-guard" } as const);

export const CHECK_IN_TOOLS: readonly string[] = Object.freeze(["executor_skills", "executor_execute", "browse"]);

export const AUTOMATION_SOURCE = "automation:";

const ModelColumn = Schema.NullOr(
  Schema.fromJsonString(
    Schema.Struct({
      provider: Schema.String,
      modelId: Schema.String,
      thinkingLevel: Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
    }) satisfies Schema.Codec<ModelChoice, unknown>
  )
).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(null))));

const AutomationStatus = Schema.Literals(["active", "paused", "done", "archived"]);

export type AutomationStatus = typeof AutomationStatus.Type;

const Author = Schema.Literals(["user", "ky", "dream"]);

export type AutomationAuthor = typeof Author.Type;

const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

const StoredAutomation = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  prompt: Schema.String,
  cron: Schema.NullOr(Schema.String),
  zone: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed("UTC"))),
  at: Schema.NullOr(Schema.Number),
  model: ModelColumn,
  machine: Schema.NullOr(Schema.String),
  chat: Schema.String,
  gate: Schema.NullOr(Schema.String),
  gate_checked_at: Schema.NullOr(Schema.Number),
  gate_note: Schema.NullOr(Schema.String),
  gate_errors: Schema.Number,
  watch: Schema.NullOr(Schema.Int),
  post: Schema.Int,
  created_by: Author,
  status: AutomationStatus,
  schedule_id: Schema.NullOr(Schema.String),
  created_at: Schema.Number,
  updated_at: Schema.Number
});

export type AutomationRow = Readonly<Omit<typeof StoredAutomation.Type, "post"> & { post: boolean }>;

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

export type AutomationDraft = Pick<AutomationRow, "title" | "prompt" | "cron" | "at" | "model" | "machine" | "chat" | "gate"> & Partial<Pick<AutomationRow, "post">>;

function wordsProblem(draft: Pick<AutomationDraft, "title" | "prompt">): string | undefined {
  return draft.title.trim() && draft.prompt.trim() ? undefined : "An automation needs a title and a prompt.";
}

function timingProblem(draft: Pick<AutomationDraft, "cron" | "at">): string | undefined {
  if ((draft.cron === null) === (draft.at === null)) return "Give exactly one of cron or at.";

  if (draft.at !== null && !Number.isFinite(draft.at)) return "at must be an ISO time, like 2026-10-06T09:00:00Z.";

  return undefined;
}

function gateProblem(gate: string | null): string | undefined {
  return gate !== null && gate.trim() === "" ? "A gate is an Executor program; leave it out for none." : undefined;
}

export function draftProblem(draft: Pick<AutomationDraft, "title" | "prompt" | "cron" | "at" | "gate">): string | undefined {
  return wordsProblem(draft) ?? timingProblem(draft) ?? gateProblem(draft.gate);
}

export type CheckIns = { readonly on: boolean; readonly zone: string | null; readonly pinned: boolean };

export type ZoneView = CheckIns & { readonly detected: string | null };

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

const TaskStepSchema = Type.Object({ at: Type.Number(), text: Type.String() });

type TaskStep = Readonly<Static<typeof TaskStepSchema>>;

const StepStateSchema = Type.Union([Type.Literal("running"), Type.Literal("done"), Type.Literal("failed")]);

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

export const taskLogRows = (rows: readonly unknown[]): TaskLogStep[] => rows.flatMap((row) => decodeOr(TaskLogStepSchema, row, undefined) ?? []);

const StepsColumn = Type.Array(TaskStepSchema);

const AgentSchema = Type.Union([Type.Literal("claude"), Type.Literal("codex")]);

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

export type TaskRow = Readonly<Omit<Static<typeof StoredTask>, "steps" | "agent"> & { steps: readonly TaskStep[]; agent: Agent | null }>;

export type TaskPatch = Partial<Pick<TaskRow, "title" | "status" | "summary" | "session">>;

export const DeliverySchema = Type.Object({
  id: Type.String(),
  session: Type.String(),
  content: Type.String(),
  line: Type.String(),
  ref: Type.String(),
  kind: Type.Optional(Type.Union([Type.Literal("event"), Type.Literal("look"), Type.Literal("post"), Type.Literal("chat")])),
  cards: Type.Optional(Nullable(Type.String()))
});

export type Delivery = Readonly<Static<typeof DeliverySchema>>;

export const SessionRow = Type.Object({ session: Type.String() });

export const ColumnInfo = Type.Object({ name: Type.String() });

export type TaskNamer = {
  readonly title: (id: string, text: string) => void;
  readonly summary: (id: string, text: string) => void;
};

const SUMMARY_CHARS = 240;

export function summarize(text: string): string {
  const line = text.trim().split("\n").find((part) => part.trim() !== "") ?? "";

  return line.length > SUMMARY_CHARS ? `${line.slice(0, SUMMARY_CHARS - 1)}…` : line;
}

export type LastRun = Pick<TaskRow, "id" | "status" | "summary" | "finished_at">;

export type RunInfo = Pick<TaskRow, "id" | "status" | "summary" | "created_at" | "started_at" | "finished_at" | "cost_usd">;

export const RUN_HISTORY = 14;

export type AutomationView = Omit<AutomationRow, "schedule_id" | "zone"> & {
  readonly zone: string;
  readonly next_run: number | null;
  readonly last_run: LastRun | null;
  readonly runs: readonly RunInfo[];
};

export const BY_ID_ACTIONS = ["pause", "resume", "archive", "unarchive", "run", "stop", "delete"] as const;

export type AutomationAction = (typeof BY_ID_ACTIONS)[number];

export const AutomationActionSchema = Type.Unsafe<AutomationAction>(Type.Union(BY_ID_ACTIONS.map((action) => Type.Literal(action))));

export const TOOL_ACTIONS = ["create", "update", "list", ...BY_ID_ACTIONS] as const;

export type ToolAction = (typeof TOOL_ACTIONS)[number];

export const AutomationToolInput = Type.Object({
  action: Type.Union(TOOL_ACTIONS.map((action) => Type.Literal(action))),
  id: Type.Optional(Type.String({ description: "An automation id from create or list." })),
  title: Type.Optional(Type.String({ description: "3-6 words for the automations list." })),
  prompt: Type.Optional(Type.String({ description: "What each run does; self-contained, since a run knows nothing else." })),
  cron: Type.Optional(Type.String({ description: "A 5-field cron in the user's time zone, like 0 9 * * 1-5 for 9 AM on weekdays." })),
  at: Type.Optional(Type.String({ description: "A one-off's time, ISO with a zone, like 2026-10-06T09:00:00Z." })),
  model: Type.Optional(Type.String({ description: "provider/modelId; leave out, or worker to clear it, for the worker model." })),
  thinking: Type.Optional(ThinkingLevelSchema),
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

const decodeAutomation = Schema.decodeUnknownOption(StoredAutomation);

export function automationRows(rows: readonly unknown[]): AutomationRow[] {
  return rows.flatMap((row) => {
    const stored = decodeAutomation(row);

    if (Option.isNone(stored)) return [];

    return [{ ...stored.value, post: stored.value.post === 1 }];
  });
}

export function taskRows(rows: readonly unknown[]): TaskRow[] {
  return rows.flatMap((row) => {
    const stored = decodeOr(StoredTask, row, undefined);

    return stored === undefined ? [] : [{ ...stored, steps: parseOr(StepsColumn, stored.steps, []) }];
  });
}

const withNext = (said: string, next: string | undefined) => (next === undefined ? said : `${said} ${next}`);

export class NoAutomation extends Schema.TaggedError<NoAutomation>()("NoAutomation", { id: Schema.String, next: Schema.optionalKey(Schema.String) }) implements Refusable {
  get refusal(): string {
    return withNext(`No automation ${this.id}.`, this.next);
  }
}

export class WrongStatus extends Schema.TaggedError<WrongStatus>()("WrongStatus", {
  title: Schema.String,
  status: AutomationStatus,
  wanted: Schema.String,
  next: Schema.optionalKey(Schema.String)
}) implements Refusable {
  get refusal(): string {
    return withNext(`"${this.title}" is ${this.status}, not ${this.wanted}.`, this.next);
  }
}

export class AlreadyRan extends Schema.TaggedError<AlreadyRan>()("AlreadyRan", { title: Schema.String, at: Schema.Number }) implements Refusable {
  get refusal(): string {
    return `"${this.title}" ran at ${new Date(this.at).toISOString()}. Update \`at\` to run it again.`;
  }
}

export class NoRunGoing extends Schema.TaggedError<NoRunGoing>()("NoRunGoing", { title: Schema.String }) implements Refusable {
  get refusal(): string {
    return `"${this.title}" has no run going.`;
  }
}

export class NotSaved extends Schema.TaggedError<NotSaved>()("NotSaved", { problem: Schema.String }) implements Refusable {
  get refusal(): string {
    return this.problem;
  }
}

export class ModelUnavailable extends Schema.TaggedError<ModelUnavailable>()("ModelUnavailable", {
  provider: Schema.String,
  modelId: Schema.String,
  choices: Schema.String
}) implements Refusable {
  get refusal(): string {
    return `${this.provider}/${this.modelId} is not available. ${this.choices}`;
  }
}

export class CannotSchedule extends Schema.TaggedError<CannotSchedule>()("CannotSchedule", { cron: Schema.NullOr(Schema.String), why: Schema.String }) implements Refusable {
  get refusal(): string {
    return `Cannot schedule "${this.cron}": ${this.why}`;
  }
}

export class NotAZone extends Schema.TaggedError<NotAZone>()("NotAZone", { zone: Schema.String }) implements Refusable {
  get refusal(): string {
    return `${this.zone} isn't a time zone, like Europe/Berlin.`;
  }
}
