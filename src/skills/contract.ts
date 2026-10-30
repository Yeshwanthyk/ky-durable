import type { Context } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type AgentChange, AssistantEntry, type Conversation, type ConversationId, configure, type EntryId, type Extension, type Tx } from "@earendil-works/pi-durable";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import Type, { type Static } from "typebox";
import { CHECK_IN_TOOLS, summarize, type TaskFeed } from "../automations/contract";
import type { Refusable } from "../core/edge";
import { must } from "../core/must";
import { agentModel } from "../providers/contract";
import { type ModelChoice, ModelChoiceSchema, ThinkingLevelSchema } from "../settings/contract";
import type { BackgroundWork } from "../spend/contract";

export type { Reviews, Skills } from "./wiring";

export type { Specialists } from "./wiring";

export type { Spawn } from "./subagents";

export const SKILL_CRAFT = `A good skill:
- Does one job: one class of task. Two jobs are two skills.
- Has a description that says when to use it and, when a neighbouring skill is close, when not ("Not for ...").
- Opens with the trigger, then numbered steps; a step that isn't obvious says why, so it can be adapted rather than followed blindly.
- Lists pitfalls: what went wrong before and how the user corrected it.
- Ends with how to tell it is done: what a finished result has.
- Holds nothing else: no details of one day's task, no facts about the user, no step that never helped.`;

export const SKILL_TABLES = Object.freeze({
  skills: "ky_skills",
  skillVersions: "ky_skill_versions",
  skillReviews: "ky_skill_reviews",
  specialists: "ky_specialists",
  specialistSessions: "ky_specialist_sessions"
} as const);

export const TOOLS = Object.freeze({
  skillView: "skill_view",
  skillManage: "skill_manage",
  specialist: "specialist",
  subagent: "subagent"
} as const);

export const SkillAction = Type.Union([
  Type.Literal("create"),
  Type.Literal("edit"),
  Type.Literal("patch"),
  Type.Literal("archive"),
  Type.Literal("restore"),
  Type.Literal("revert")
]);

export type SkillAction = Static<typeof SkillAction>;

export const PinAction = Type.Union([Type.Literal("pin"), Type.Literal("unpin")]);

export const AnswerAction = Type.Literal("answer");

export const isMachine = (actor: string): boolean => !["user", "agent", "ky"].includes(actor);

const SkillOrigin = Schema.Literals(["agent", "review", "dream", "user"]);

export type SkillOrigin = typeof SkillOrigin.Type;

const SkillStatus = Schema.Literals(["active", "archived"]);

export type SkillStatus = typeof SkillStatus.Type;

const SkillKind = Type.Union([Type.Literal("skill"), Type.Literal("kit")]);

export type SkillKind = Static<typeof SkillKind>;

const EDITS = {
  old: Type.Optional(Type.String()),
  new: Type.Optional(Type.String()),
  version: Type.Optional(Type.Number())
};

export const SkillChange = Type.Object({
  action: Type.Union([SkillAction, PinAction, AnswerAction]),
  name: Type.String(),
  description: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  ...EDITS,
  absorbed_into: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  answers: Type.Optional(Type.Record(Type.String(), Type.String())),
  kind: Type.Optional(SkillKind)
});

export type SkillChange = Static<typeof SkillChange>;

export const SkillViewInput = Type.Object({
  name: Type.String(),
  history: Type.Optional(Type.Boolean())
});

export const SkillStored = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  body: Schema.String,
  status: SkillStatus,
  uses: Schema.Number,
  created_at: Schema.Number,
  updated_at: Schema.Number,
  last_used_at: Schema.NullOr(Schema.Number),
  pinned: Schema.Number,
  created_by: SkillOrigin,
  answers: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["skill", "kit"])
});

export type SkillRow = Omit<typeof SkillStored.Type, "pinned" | "answers"> & {
  readonly pinned: boolean;
  readonly answers: Readonly<Record<string, string>>;
};

export type Need = {
  readonly key: string;
  readonly question: string;
  readonly choices: readonly string[];
};

export type Sections = {
  readonly needs: readonly Need[];
  readonly members: readonly string[];
};

const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const NEED = /^[-*]\s+([^:\s]+)\s*:\s*(.+)$/;

const MEMBER = /^[-*]\s+`?([^`\s]+)`?\s*$/;

const CHOICES = /\s*\(([^()]*\|[^()]*)\)\s*$/;

function sections(body: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  let current: string[] | undefined;

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^##\s+(.+?)\s*#*$/.exec(line);

    if (heading) {
      const title = (heading[1] ?? "").toLowerCase();
      current = found.get(title) ?? [];
      found.set(title, current);
    } else if (/^#\s/.test(line)) {
      current = undefined;
    } else if (line !== "") {
      current?.push(line);
    }
  }

  return found;
}

function need(line: string): Need | undefined {
  const match = NEED.exec(line);
  const key = match?.[1];
  const rest = match?.[2]?.trim();

  if (key === undefined || rest === undefined || !KEY.test(key)) return undefined;
  const choices = CHOICES.exec(rest);
  const options = (choices?.[1] ?? "").split("|").map((option) => option.trim()).filter((option) => option !== "");
  const question = choices && options.length >= 2 ? rest.slice(0, choices.index).trim() : rest;

  return question === "" ? undefined : { key, question, choices: choices && options.length >= 2 ? options : [] };
}

export function parse(body: string): Sections {
  const found = sections(body);
  const needs = new Map<string, Need>();

  for (const line of found.get("needs") ?? []) {
    const each = need(line);

    if (each && !needs.has(each.key)) needs.set(each.key, each);
  }

  const members = new Set<string>();

  for (const line of found.get("members") ?? []) {
    const name = MEMBER.exec(line)?.[1];

    if (name !== undefined && KEY.test(name)) members.add(name);
  }

  return { needs: [...needs.values()], members: [...members] };
}

export function kitsOf(skills: readonly SkillRow[]): Map<string, string[]> {
  const kits = new Map<string, string[]>();

  for (const kit of skills) {
    if (kit.kind !== "kit" || kit.status !== "active") continue;

    for (const member of parse(kit.body).members) {
      if (member !== kit.name) kits.set(member, [...(kits.get(member) ?? []), kit.name]);
    }
  }

  return kits;
}

const decodeAnswers = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)));

const answersOf = (stored: string | null): Readonly<Record<string, string>> => (stored === null ? {} : Option.getOrElse(decodeAnswers(stored), () => ({})));

export function skillOf({ pinned, answers, ...row }: typeof SkillStored.Type): SkillRow {
  return { ...row, pinned: pinned !== 0, answers: answersOf(answers) };
}

export type SkillWrite = {
  readonly name: string;
  readonly action: SkillAction;
  readonly actor: string;
  readonly conversation: string | null;
  readonly run: string | null;
  readonly before: number | null;
  readonly absorbed_into: string | null;
  readonly reason: string | null;
};

export const SkillVersion = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  action: Schema.String,
  actor: Schema.String,
  description: Schema.String,
  body: Schema.String,
  status: SkillStatus,
  created_at: Schema.Number,
  conversation: Schema.NullOr(Schema.String)
});

export type SkillVersion = typeof SkillVersion.Type;

/** A demo's recording made into a skill, or why not. */
export class NoDraft extends Schema.TaggedError<NoDraft>()("NoDraft", { said: Schema.String }) implements Refusable {
  get refusal(): string {
    return this.said;
  }
}

/** What a demo's draft made: the skill it created, kept archived until the user says yes, and any other change. */
export type Drafted = { readonly draft: string | undefined; readonly changed: ReadonlyArray<SkillVersion> };

export class NoSuchAction extends Schema.TaggedError<NoSuchAction>()("NoSuchAction", { action: Schema.String }) implements Refusable {
  get refusal(): string {
    return `There is no skill action "${this.action}".`;
  }
}

export class BadName extends Schema.TaggedError<BadName>()("BadName", { name: Schema.String }) implements Refusable {
  get refusal(): string {
    return `Bad skill name "${this.name}": lowercase letters, digits and hyphens, at most 64.`;
  }
}

export class KindStays extends Schema.TaggedError<KindStays>()("KindStays", {}) implements Refusable {
  get refusal(): string {
    return "A skill's kind is set when it's created and stays.";
  }
}

export class NoSkill extends Schema.TaggedError<NoSkill>()("NoSkill", { name: Schema.String }) implements Refusable {
  get refusal(): string {
    return `No skill named ${this.name}.`;
  }
}

export class Exists extends Schema.TaggedError<Exists>()("Exists", { name: Schema.String }) implements Refusable {
  get refusal(): string {
    return `${this.name} exists; edit or patch it.`;
  }
}

const NEEDS = { create: "create needs a description and a body.", patch: "patch needs old and new.", revert: "revert needs a version." } as const;

export class Incomplete extends Schema.TaggedError<Incomplete>()("Incomplete", { action: Schema.Literals(["create", "patch", "revert"]) }) implements Refusable {
  get refusal(): string {
    return NEEDS[this.action];
  }
}

export class NotInBody extends Schema.TaggedError<NotInBody>()("NotInBody", { name: Schema.String }) implements Refusable {
  get refusal(): string {
    return `The text to replace is not in ${this.name}.`;
  }
}

export class Ambiguous extends Schema.TaggedError<Ambiguous>()("Ambiguous", { name: Schema.String, count: Schema.Number }) implements Refusable {
  get refusal(): string {
    return `The text to replace appears ${this.count} times in ${this.name}; quote more of it.`;
  }
}

export class NoVersion extends Schema.TaggedError<NoVersion>()("NoVersion", { name: Schema.String, version: Schema.Number }) implements Refusable {
  get refusal(): string {
    return `${this.name} has no version ${this.version}.`;
  }
}

export class Pinned extends Schema.TaggedError<Pinned>()("Pinned", { name: Schema.String }) implements Refusable {
  get refusal(): string {
    return `${this.name} is pinned; ky's background runs leave it as it is.`;
  }
}

export class UsersOwn extends Schema.TaggedError<UsersOwn>()("UsersOwn", { name: Schema.String }) implements Refusable {
  get refusal(): string {
    return `${this.name} is the user's own skill; a background run may not archive it.`;
  }
}

export class NotAMerge extends Schema.TaggedError<NotAMerge>()("NotAMerge", { name: Schema.String }) implements Refusable {
  get refusal(): string {
    return `That archives ${this.name}, and a background run archives a skill only as a merge: give absorbed_into, the active skill that now covers it. Skills nobody uses are archived by ky itself.`;
  }
}

export class MachinePins extends Schema.TaggedError<MachinePins>()("MachinePins", {}) implements Refusable {
  get refusal(): string {
    return "Only the user, or ky's own seeding, pins or unpins a skill.";
  }
}

export class MachineAnswers extends Schema.TaggedError<MachineAnswers>()("MachineAnswers", {}) implements Refusable {
  get refusal(): string {
    return "Only the user answers a skill's needs.";
  }
}

export class NotAsked extends Schema.TaggedError<NotAsked>()("NotAsked", {
  name: Schema.String,
  unknown: Schema.Array(Schema.String),
  asked: Schema.Array(Schema.String)
}) implements Refusable {
  get refusal(): string {
    return `${this.name} doesn't ask ${this.unknown.join(", ")}; it asks ${this.asked.length === 0 ? "nothing" : this.asked.join(", ")}.`;
  }
}

export class NoAnswers extends Schema.TaggedError<NoAnswers>()("NoAnswers", {}) implements Refusable {
  get refusal(): string {
    return "No answers to save.";
  }
}

export class NoDescription extends Schema.TaggedError<NoDescription>()("NoDescription", {}) implements Refusable {
  get refusal(): string {
    return "A skill needs a description.";
  }
}

export class TooLong extends Schema.TaggedError<TooLong>()("TooLong", { field: Schema.Literals(["description", "body"]), length: Schema.Number, limit: Schema.Number }) implements Refusable {
  get refusal(): string {
    return `The ${this.field} is ${this.length} characters; keep it under ${this.limit}.`;
  }
}

export type TextRefusal = NoDescription | TooLong;

export type SkillRefusal = NoSuchAction | BadName | KindStays | NoSkill | Exists | Incomplete | NotInBody | Ambiguous | NoVersion | Pinned | UsersOwn | NotAMerge | MachinePins | MachineAnswers | NotAsked | NoAnswers | TextRefusal;

export const ReviewKind = Schema.Literals(["review", "dream", "episode", "look"]);

export type ReviewKind = typeof ReviewKind.Type;

const REVIEW_TOOLS = [TOOLS.skillView, TOOLS.skillManage, "memory_recall", "memory_zoom"] as const;

export const REVIEW_ALLOWED: Readonly<Record<ReviewKind, readonly string[]>> = Object.freeze({
  review: REVIEW_TOOLS,
  dream: [...REVIEW_TOOLS, "memory_note", "memory_forget", "chat_search", "anticipate", "automation"],
  episode: ["anticipate", "memory_recall"],
  look: ["memory_recall", "memory_zoom", "chat_search", "anticipate", ...CHECK_IN_TOOLS]
});

const SessionKind = Schema.Literals(["home", "consult", "discuss", "group"]);

export type SessionKind = typeof SessionKind.Type;

const StoredModel = Schema.Struct({
  provider: Schema.String,
  modelId: Schema.String,
  thinkingLevel: Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
});

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export const SpecialistStored = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  model: Schema.NullOr(Schema.String),
  machine: Schema.NullOr(Schema.String),
  session: Schema.NullOr(Schema.String),
  created_at: Schema.Number
});

export type SpecialistRow = Omit<typeof SpecialistStored.Type, "model"> & {
  readonly model: ModelChoice | null;
};

export function specialistOf({ model, ...row }: typeof SpecialistStored.Type): SpecialistRow {
  return { ...row, model: model === null ? null : Option.getOrNull(Option.filter(parseJson(model), Schema.is(StoredModel))) };
}

export const SpecialistSession = Schema.Struct({ specialist: Schema.String, kind: SessionKind });

type BriefView = { readonly body: string; readonly version: number; readonly updated_at: number };

export type SpecialistView = SpecialistRow & { readonly brief: BriefView };

export const SpecialistDraftSchema = Type.Object({
  description: Type.Optional(Type.String()),
  model: Type.Optional(Type.Union([ModelChoiceSchema, Type.Null()])),
  machine: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  brief: Type.Optional(Type.String())
});

export type SpecialistDraft = {
  readonly description?: string;
  readonly model?: ModelChoice | null;
  readonly machine?: string | null;
  readonly brief?: string;
};

export const SpecialistAction = Type.Union([
  Type.Literal("list"),
  Type.Literal("view"),
  Type.Literal("history"),
  Type.Literal("create"),
  Type.Literal("set"),
  Type.Literal("edit"),
  Type.Literal("patch"),
  Type.Literal("revert")
]);

export type SpecialistAction = Static<typeof SpecialistAction>;

export const SpecialistInput = Type.Object({
  action: SpecialistAction,
  id: Type.Optional(Type.String({ description: "Lowercase-with-hyphens, like engineer." })),
  description: Type.Optional(Type.String()),
  brief: Type.Optional(Type.String()),
  machine: Type.Optional(Type.String()),
  ...EDITS
});

export type SpecialistInput = Static<typeof SpecialistInput>;

export const SubagentAction = Type.Union([
  Type.Literal("spawn"),
  Type.Literal("send"),
  Type.Literal("stop"),
  Type.Literal("status"),
  Type.Literal("last"),
  Type.Literal("ask"),
  Type.Literal("discuss")
]);

export type SubagentAction = Static<typeof SubagentAction>;

export const SubagentInput = Type.Object({
  action: SubagentAction,
  name: Type.Optional(Type.String({ description: "Short, like researcher or pharmacy-finder." })),
  title: Type.Optional(Type.String({ description: "3-6 words for the task list, like 'Find compounding pharmacies'." })),
  message: Type.Optional(Type.String()),
  followUp: Type.Optional(Type.Boolean()),
  model: Type.Optional(Type.String({ description: "spawn, send: provider/modelId, kept for later sends; worker to clear it. Leave out for the one it has, or the worker model." })),
  thinking: Type.Optional(ThinkingLevelSchema),
  specialist: Type.Optional(Type.String({ description: "ask: the specialist's id, like engineer." })),
  specialists: Type.Optional(Type.Array(Type.String(), { description: "discuss: the specialists' ids." })),
  rounds: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2)]))
});

export type SubagentInput = Static<typeof SubagentInput>;

export function mentions(text: string): string[] {
  const found: string[] = [];
  const pattern = /^@([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)\s*/;
  let rest = text.trimStart();

  for (let match = pattern.exec(rest); match; match = pattern.exec(rest)) {
    found.push(must(match[1], "A mention matches its id."));
    rest = rest.slice(match[0].length);
  }

  return found;
}

export function textOf(message: AssistantMessage | undefined): string {
  return (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

export async function setUp(tx: Tx, conversation: ConversationId, remove: readonly Extension[], model: ModelChoice): Promise<void> {
  await configure(tx, conversation, { extensions: { remove: [...remove] }, ...agentModel(model) });
}

export type ReviewHost = {
  readonly conversation: (session: string) => Promise<Conversation>;
  readonly feed: TaskFeed;
  readonly later: (work: Promise<void>) => void;
  readonly context: Context;
  readonly model: () => AgentChange;
  /** Whether unasked work may start now (src/spend). */
  readonly allows: (work: BackgroundWork) => boolean;
};

export async function reviewFork(host: ReviewHost, conversation: Conversation, at: EntryId): Promise<Conversation> {
  const fork = await conversation.fork(at, { ownership: { kind: "ownerless" } }, host.context);
  await fork.configure(host.model(), host.context);

  return fork;
}

type BackgroundTask = { readonly id: string; readonly worker: string; readonly title: string; readonly content: string };

export const BACKGROUND_SOURCE = "background";

type BackgroundOutcome =
  | { readonly status: "done"; readonly answer: string }
  | { readonly status: "stopped" | "failed"; readonly summary: string };

export async function askInBackground(host: ReviewHost, conversation: Conversation, { id, worker, title, content }: BackgroundTask): Promise<BackgroundOutcome> {
  const { context } = host;

  try {
    const submission = await conversation.submit({ type: "input", content, requestId: `${worker}:${id}` }, context);
    const settled = await submission.wait(context);

    if (settled.status === "unanswered") {
      return settled.reason === "aborted" ? { status: "stopped", summary: "Stopped" } : { status: "failed", summary: `Failed: ${settled.reason}` };
    }

    const answer =
      settled.type === "input"
        ? await conversation.commit(
            // SAFETY: pi-durable types AssistantEntry as Entry<never>, but documents its `model` as [AssistantMessage].
            async (tx) => (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as AssistantMessage | undefined,
            context
          )
        : undefined;

    return { status: "done", answer: textOf(answer) };
  } catch (error) {
    console.warn(`${title} failed`, error);

    return { status: "failed", summary: summarize(String(error)) };
  }
}

function startCard(host: ReviewHost, conversation: Conversation, { id, worker, title }: Omit<BackgroundTask, "content">): void {
  host.feed.create({ id, kind: "cloud", source: BACKGROUND_SOURCE, worker, title, status: "working", session: String(conversation.id) });
}

function endCard(host: ReviewHost, id: string, outcome: BackgroundOutcome): void {
  host.feed.update(id, outcome.status === "done" ? { status: "done", summary: summarize(outcome.answer) || "Done" } : outcome);
}

export function showEnded(host: ReviewHost, conversation: Conversation, task: Omit<BackgroundTask, "content">, outcome: BackgroundOutcome): void {
  startCard(host, conversation, task);
  endCard(host, task.id, outcome);
}

export async function runInFeed(host: ReviewHost, conversation: Conversation, task: BackgroundTask): Promise<string | undefined> {
  startCard(host, conversation, task);
  const outcome = await askInBackground(host, conversation, task);
  endCard(host, task.id, outcome);

  return outcome.status === "done" ? outcome.answer : undefined;
}
