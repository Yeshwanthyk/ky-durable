/**
 * The skills domain's contract: what other domains may know of skills, specialists and subagents.
 * The shapes of their stored skill rows in Schema and their tool inputs in typebox (pi's tools take typebox), the actions each tool takes,
 * the tool names, the tables this domain owns, and the few functions other domains call. Nothing
 * here imports the domain's own modules at run time, so they can all import it.
 */
import type { Context } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type AgentChange, AssistantEntry, type Conversation, type ConversationId, configure, type EntryId, type Extension, type Tx } from "@earendil-works/pi-durable";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import Type, { type Static } from "typebox";
import { CHECK_IN_TOOLS, summarize, type TaskFeed } from "../automations/contract";
import type { Refusable } from "../core/edge";
import { must } from "../core/must";
import { agentModel } from "../models";
import { type ModelChoice, ModelChoiceSchema, ThinkingLevelSchema } from "../settings";

export type { Reviews, Skills } from "./wiring";

export type { Specialists } from "./wiring";

export type { Spawn } from "./subagents";

/**
 * The tables this domain owns. A backup restore stages each as `ky_restore__<table>` and matches
 * it by name, so these never change.
 */
/** What a good skill is: the bar the agent, a skill review, the nightly dream and make-skill write to. */
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

/** The tools this domain registers. */
export const TOOLS = Object.freeze({
  skillView: "skill_view",
  skillManage: "skill_manage",
  specialist: "specialist",
  subagent: "subagent"
} as const);

// Skills.

export const SkillAction = Type.Union([
  Type.Literal("create"),
  Type.Literal("edit"),
  Type.Literal("patch"),
  Type.Literal("archive"),
  Type.Literal("restore"),
  Type.Literal("revert")
]);

export type SkillAction = Static<typeof SkillAction>;

/** Pinning keeps a skill from ky's background runs (a dream, a review): no archive, merge or patch. Not a version: it changes no content. */
export const PinAction = Type.Union([Type.Literal("pin"), Type.Literal("unpin")]);

/**
 * The user's answers to a skill's Needs (`parse` below), saved from a chat or the panel. Not a version
 * either: answers are the user's facts for the skill, not its text, so a revert or a dream's undo leaves them.
 */
export const AnswerAction = Type.Literal("answer");

/**
 * Whether `actor` is one of ky's background runs (a dream, a skill review, or any later one) rather than the
 * user or the agent they are talking to: such a write must leave pinned skills alone, archive only as a merge
 * and never the user's own, and is kept in the dream's ledger so the user can undo it. "ky" is not one: it is
 * ky's own seeding (src/seeds.ts): its starter skills on a new ky's first start, and on any start the default skills
 * it creates and pins when missing.
 */
export const isMachine = (actor: string): boolean => !["user", "agent", "ky"].includes(actor);

/** Who made a skill. A dream may archive only what ky made (agent, review or dream); ky's starter skills count as the user's. */
const SkillOrigin = Schema.Literals(["agent", "review", "dream", "user"]);

export type SkillOrigin = typeof SkillOrigin.Type;

const SkillStatus = Schema.Literals(["active", "archived"]);

export type SkillStatus = typeof SkillStatus.Type;

/**
 * A skill does one job; a kit runs several, the skills and kits its `## Members` names. Set when it's created
 * and never changed after, so an edit that drops the Members section leaves a kit a kit, with no members.
 */
export const SkillKind = Type.Union([Type.Literal("skill"), Type.Literal("kit")]);

export type SkillKind = Static<typeof SkillKind>;

/** A patch's passage and its replacement, or the version a revert goes back to. */
const EDITS = {
  old: Type.Optional(Type.String()),
  new: Type.Optional(Type.String()),
  version: Type.Optional(Type.Number())
};

/** One change to the library, skill_manage's input; which fields it needs depends on the action. */
export const SkillChange = Type.Object({
  action: Type.Union([SkillAction, PinAction, AnswerAction]),
  name: Type.String(),
  description: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  ...EDITS,
  /** On an archive that is a merge: the active skill that now covers this one. A dream must give it. */
  absorbed_into: Type.Optional(Type.String()),
  /** Why, in a few words; a dream's shows in Activity's Last night. */
  reason: Type.Optional(Type.String()),
  /** On an answer: each need's key and the user's answer; a blank answer clears it. */
  answers: Type.Optional(Type.Record(Type.String(), Type.String())),
  /** On a create: "kit" for a kit; a skill otherwise. */
  kind: Type.Optional(SkillKind)
});

export type SkillChange = Static<typeof SkillChange>;

/** skill_view's input. */
export const SkillViewInput = Type.Object({
  name: Type.String(),
  history: Type.Optional(Type.Boolean())
});

/** A row of ky_skills as SQLite holds it: `pinned` is 0 or 1. Fields in the table's column order, which a decoded row keeps. */
export const SkillStored = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  body: Schema.String,
  status: SkillStatus,
  uses: Schema.Number,
  created_at: Schema.Number,
  updated_at: Schema.Number,
  /** When skill_view last opened it; null if never. */
  last_used_at: Schema.NullOr(Schema.Number),
  pinned: Schema.Number,
  created_by: SkillOrigin,
  /** The user's answers to its Needs as a JSON object; null until the first. */
  answers: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["skill", "kit"])
});

export type SkillRow = Omit<typeof SkillStored.Type, "pinned" | "answers"> & {
  /** The user pinned it: a dream leaves it as it is. */
  readonly pinned: boolean;
  /** The user's answer to each need, by its key. */
  readonly answers: Readonly<Record<string, string>>;
};

// A skill's sections ky reads, besides following it: `## Needs`, what the skill asks the user before it can
// run, one `- key: question` line each, with the choices in a trailing `(a | b)`; and `## Members`, the skills a
// kit runs, one `- name` line each. Anything else in the body is its steps. Parsing never throws: a line that
// doesn't fit is the skill's text, not a need.

export type Need = {
  /** lowercase-with-hyphens, as skill names are; the answer is kept under it. */
  readonly key: string;
  readonly question: string;
  /** The options to pick from, when the question lists them; none means a free answer. */
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

/** The lines under each `## heading`, by its lowercased title. */
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

/** A body's needs, first of each key, and its members, each once, in the order written. */
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

/**
 * Each skill's kits, by its name: the active kits whose Members name it, in the order given. A kit naming
 * itself doesn't count; a kit inside a kit is fine, and a cycle is harmless, since nothing follows Members
 * further than one step.
 */
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

/** Stored answers; a column that doesn't hold an object of strings reads as none. */
const answersOf = (stored: string | null): Readonly<Record<string, string>> => (stored === null ? {} : Option.getOrElse(decodeAnswers(stored), () => ({})));

/** A stored skill, its pin as a boolean and its answers as an object. */
export function skillOf({ pinned, answers, ...row }: typeof SkillStored.Type): SkillRow {
  return { ...row, pinned: pinned !== 0, answers: answersOf(answers) };
}

/**
 * A change about to be written, as Skills tells its watchers (the dream's ledger, src/dreaming/ledger.ts):
 * `before` is the skill's newest version until now, null for a create.
 */
export type SkillWrite = {
  readonly name: string;
  readonly action: SkillAction;
  readonly actor: string;
  /** The conversation that made it; null for the user's and for ky's staleness pass. */
  readonly conversation: string | null;
  /** The run it belongs to when it has no conversation: ky's staleness pass gives the dream's that runs it. */
  readonly run: string | null;
  readonly before: number | null;
  readonly absorbed_into: string | null;
  readonly reason: string | null;
};

/** A row of ky_skill_versions. */
export const SkillVersion = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  action: Schema.String,
  /** "agent", "review", "dream", "user" or "ky". */
  actor: Schema.String,
  description: Schema.String,
  body: Schema.String,
  status: SkillStatus,
  created_at: Schema.Number,
  /** The conversation that made it; null for the user's edits and versions from before it was kept. */
  conversation: Schema.NullOr(Schema.String)
});

export type SkillVersion = typeof SkillVersion.Type;

// Why ky won't change the library, in B's words: Skills (wiring.ts) throws each as an Error with the refusal as its message, as B threw them.

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

/** A change without the fields its action needs. */
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

/** A version's text that can't be written. */
export type TextRefusal = NoDescription | TooLong;

/** Why a change to the library is refused. */
export type SkillRefusal = NoSuchAction | BadName | KindStays | NoSkill | Exists | Incomplete | NotInBody | Ambiguous | NoVersion | Pinned | UsersOwn | NotAMerge | MachinePins | MachineAnswers | NotAsked | NoAnswers | TextRefusal;

/**
 * What runs in the background: a review of one turn, a nightly dream (src/dreaming/dreaming.ts), an episode
 * reflection that keeps what a chat left open (src/dreaming/episodes.ts), or a look over the user's day
 * (src/dreaming/looks.ts).
 */
export const ReviewKind = Schema.Literals(["review", "dream", "episode", "look"]);

export type ReviewKind = typeof ReviewKind.Type;

const REVIEW_TOOLS = [TOOLS.skillView, TOOLS.skillManage, "memory_recall", "memory_zoom"] as const;

/** The tools each kind may call; each is offered every tool, so the rest are blocked. */
export const REVIEW_ALLOWED: Readonly<Record<ReviewKind, readonly string[]>> = Object.freeze({
  review: REVIEW_TOOLS,
  // automation books check-ins (src/automations/automations.ts), and only them; anticipate keeps what is open (src/dreaming/anticipations.ts).
  dream: [...REVIEW_TOOLS, "memory_note", "memory_forget", "chat_search", "anticipate", "automation"],
  // An episode only keeps what is open, checking memory first; it writes no memory and no skill.
  episode: ["anticipate", "memory_recall"],
  // A look only reads: memory, the chats, what is open (anticipate's list alone), and a check-in's web and browser.
  look: ["memory_recall", "memory_zoom", "chat_search", "anticipate", ...CHECK_IN_TOOLS]
});

// Specialists.

const SessionKind = Schema.Literals(["home", "consult", "discuss", "group"]);

export type SessionKind = typeof SessionKind.Type;

/** A model choice as a specialist stores it, JSON in ky_specialists.model. */
const StoredModel = Schema.Struct({
  provider: Schema.String,
  modelId: Schema.String,
  thinkingLevel: Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
});

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** A row of ky_specialists as SQLite holds it: the model as JSON text. */
export const SpecialistStored = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  model: Schema.NullOr(Schema.String),
  machine: Schema.NullOr(Schema.String),
  session: Schema.NullOr(Schema.String),
  created_at: Schema.Number
});

export type SpecialistRow = Omit<typeof SpecialistStored.Type, "model"> & {
  /** Its model; the worker's when null or no longer available. */
  readonly model: ModelChoice | null;
};

/** A stored specialist, its model checked and kept as stored; a damaged model reads as none, so the worker's runs. */
export function specialistOf({ model, ...row }: typeof SpecialistStored.Type): SpecialistRow {
  return { ...row, model: model === null ? null : Option.getOrNull(Option.filter(parseJson(model), Schema.is(StoredModel))) };
}

/** A row of ky_specialist_sessions, as `bySession` reads it. */
export const SpecialistSession = Schema.Struct({ specialist: Schema.String, kind: SessionKind });

/** A specialist's brief as the panel shows it (src/dreaming/soul.ts's SoulView). */
type BriefView = { readonly body: string; readonly version: number; readonly updated_at: number };

/** What the panel shows: a specialist and its brief. */
export type SpecialistView = SpecialistRow & { readonly brief: BriefView };

/** A specialist's settings as the user or ky saves them; the brief only on create. A field left out keeps what is stored. */
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

/** The specialist tool's input. */
export const SpecialistInput = Type.Object({
  action: SpecialistAction,
  id: Type.Optional(Type.String({ description: "Lowercase-with-hyphens, like engineer." })),
  description: Type.Optional(Type.String()),
  brief: Type.Optional(Type.String()),
  machine: Type.Optional(Type.String()),
  ...EDITS
});

export type SpecialistInput = Static<typeof SpecialistInput>;

// Subagents.

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

/** The subagent tool's input. */
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

// What other domains call.

/** The leading `@id`s of a message, in order; empty when it starts otherwise. */
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

/** The text of an assistant message. */
export function textOf(message: AssistantMessage | undefined): string {
  return (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** Configure a conversation as a specialist's: without `remove`, on `model`. */
export async function setUp(tx: Tx, conversation: ConversationId, remove: readonly Extension[], model: ModelChoice): Promise<void> {
  await configure(tx, conversation, { extensions: { remove: [...remove] }, ...agentModel(model) });
}

/** Where a review or a dream runs and reports. */
export type ReviewHost = {
  readonly conversation: (session: string) => Promise<Conversation>;
  readonly feed: TaskFeed;
  /** Run work in the background of the current request, like `ctx.waitUntil`. */
  readonly later: (work: Promise<void>) => void;
  readonly context: Context;
  /** The background purpose's model, which a review's fork runs on. */
  readonly model: () => AgentChange;
};

/**
 * Fork `conversation` at `at` for a review, a dream or an episode: the fork keeps the parent's agent and, since it
 * remembers, the parent's memory section, but runs on the background model.
 */
export async function reviewFork(host: ReviewHost, conversation: Conversation, at: EntryId): Promise<Conversation> {
  const fork = await conversation.fork(at, { ownership: { kind: "ownerless" } }, host.context);
  await fork.configure(host.model(), host.context);

  return fork;
}

/** A background task as it shows in Activity. */
type BackgroundTask = { readonly id: string; readonly worker: string; readonly title: string; readonly content: string };

/** The source of a task `runInFeed` runs: only this object's memory waits on it, so a restart cuts it off. */
export const BACKGROUND_SOURCE = "background";

/** How a background task's one message ended: its answer, or how Activity shows that it got none. */
export type BackgroundOutcome =
  | { readonly status: "done"; readonly answer: string }
  | { readonly status: "stopped" | "failed"; readonly summary: string };

/** Send a background task's one message to `conversation` and wait for the answer, showing nothing; never throws. */
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

/** A background task's card in Activity, working until it ends. */
function startCard(host: ReviewHost, conversation: Conversation, { id, worker, title }: Omit<BackgroundTask, "content">): void {
  host.feed.create({ id, kind: "cloud", source: BACKGROUND_SOURCE, worker, title, status: "working", session: String(conversation.id) });
}

function endCard(host: ReviewHost, id: string, outcome: BackgroundOutcome): void {
  host.feed.update(id, outcome.status === "done" ? { status: "done", summary: summarize(outcome.answer) || "Done" } : outcome);
}

/** A background task that already ended, shown in Activity as `runInFeed` leaves one. */
export function showEnded(host: ReviewHost, conversation: Conversation, task: Omit<BackgroundTask, "content">, outcome: BackgroundOutcome): void {
  startCard(host, conversation, task);
  endCard(host, task.id, outcome);
}

/**
 * Show a task in Activity, send its one message to the conversation, and
 * report the answer. Returns the answer, or undefined when the task failed.
 */
export async function runInFeed(host: ReviewHost, conversation: Conversation, task: BackgroundTask): Promise<string | undefined> {
  startCard(host, conversation, task);
  const outcome = await askInBackground(host, conversation, task);
  endCard(host, task.id, outcome);

  return outcome.status === "done" ? outcome.answer : undefined;
}
