/**
 * The skills domain's contract: what other domains may know of skills, specialists and subagents.
 * The shapes of their stored rows and tool inputs as typebox schemas, the actions each tool takes,
 * the tool names, the tables this domain owns, and the few functions other domains call. Nothing
 * here imports the domain's own modules at run time, so they can all import it.
 */
import type { Context } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type AgentChange, AssistantEntry, type Conversation, type ConversationId, configure, type EntryId, type Extension, type Tx } from "@earendil-works/pi-durable";
import Type, { type Static } from "typebox";
import { CHECK_IN_TOOLS, summarize, type TaskFeed } from "../automations/contract";
import { parseOr } from "../core/decode";
import { must } from "../core/must";
import { agentModel } from "../models";
import { type ModelChoice, ModelChoiceSchema } from "../settings";

export type { Reviews, Skills } from "./skills";

export type { Specialists } from "./specialists";

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
 * Whether `actor` is one of ky's background runs (a dream, a skill review, or any later one) rather than the
 * user or the agent they are talking to: such a write must leave pinned skills alone, archive only as a merge
 * and never the user's own, and is kept in the dream's ledger so the user can undo it. "ky" is not one: it is
 * a new ky's first start laying down its starter skills (src/seeds.ts), before anything is the user's.
 */
export const isMachine = (actor: string): boolean => !["user", "agent", "ky"].includes(actor);

/** Who made a skill. A dream may archive only what ky made (agent, review or dream); ky's starter skills count as the user's. */
const SkillOrigin = Type.Union([Type.Literal("agent"), Type.Literal("review"), Type.Literal("dream"), Type.Literal("user")]);

export type SkillOrigin = Static<typeof SkillOrigin>;

const SkillStatus = Type.Union([Type.Literal("active"), Type.Literal("archived")]);

export type SkillStatus = Static<typeof SkillStatus>;

/** A patch's passage and its replacement, or the version a revert goes back to. */
const EDITS = {
  old: Type.Optional(Type.String()),
  new: Type.Optional(Type.String()),
  version: Type.Optional(Type.Number())
};

/** One change to the library, skill_manage's input; which fields it needs depends on the action. */
export const SkillChange = Type.Object({
  action: Type.Union([SkillAction, PinAction]),
  name: Type.String(),
  description: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  ...EDITS,
  /** On an archive that is a merge: the active skill that now covers this one. A dream must give it. */
  absorbed_into: Type.Optional(Type.String()),
  /** Why, in a few words; a dream's shows in Activity's Last night. */
  reason: Type.Optional(Type.String())
});

export type SkillChange = Static<typeof SkillChange>;

/** skill_view's input. */
export const SkillViewInput = Type.Object({
  name: Type.String(),
  history: Type.Optional(Type.Boolean())
});

/** A row of ky_skills as SQLite holds it: `pinned` is 0 or 1. */
export const SkillStored = Type.Object({
  name: Type.String(),
  description: Type.String(),
  body: Type.String(),
  status: SkillStatus,
  uses: Type.Number(),
  /** When skill_view last opened it; null if never. */
  last_used_at: Type.Union([Type.Number(), Type.Null()]),
  created_at: Type.Number(),
  updated_at: Type.Number(),
  pinned: Type.Number(),
  created_by: SkillOrigin
});

export type SkillRow = Omit<Static<typeof SkillStored>, "pinned"> & {
  /** The user pinned it: a dream leaves it as it is. */
  readonly pinned: boolean;
};

/** A stored skill, its pin as a boolean. */
export function skillOf({ pinned, ...row }: Static<typeof SkillStored>): SkillRow {
  return { ...row, pinned: pinned !== 0 };
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
export const SkillVersion = Type.Object({
  id: Type.Number(),
  name: Type.String(),
  action: Type.String(),
  /** "agent", "review", "dream", "user" or "ky". */
  actor: Type.String(),
  /** The conversation that made it; null for the user's edits and versions from before it was kept. */
  conversation: Type.Union([Type.String(), Type.Null()]),
  description: Type.String(),
  body: Type.String(),
  status: SkillStatus,
  created_at: Type.Number()
});

export type SkillVersion = Static<typeof SkillVersion>;

/**
 * What runs in the background: a review of one turn, a nightly dream (src/dreaming/dreaming.ts), an episode
 * reflection that keeps what a chat left open (src/dreaming/episodes.ts), or a look over the user's day
 * (src/dreaming/looks.ts).
 */
const ReviewKind = Type.Union([Type.Literal("review"), Type.Literal("dream"), Type.Literal("episode"), Type.Literal("look")]);

export type ReviewKind = Static<typeof ReviewKind>;

/** A row of ky_skill_reviews, as `kind` reads it. */
export const ReviewRow = Type.Object({ kind: ReviewKind });

/** A row of ky_skill_reviews, as `run` reads it: a dream's run token, null for a review, whose run is its conversation. */
export const ReviewRunRow = Type.Object({ run: Type.Union([Type.String(), Type.Null()]) });

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

const SessionKind = Type.Union([Type.Literal("home"), Type.Literal("consult"), Type.Literal("discuss"), Type.Literal("group")]);

export type SessionKind = Static<typeof SessionKind>;

/** A model choice as a specialist stores it, JSON in ky_specialists.model. */
const StoredModel = Type.Object({
  provider: Type.String(),
  modelId: Type.String(),
  thinkingLevel: Type.Union([
    Type.Literal("off"),
    Type.Literal("minimal"),
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
    Type.Literal("xhigh"),
    Type.Literal("max")
  ])
});

/** A row of ky_specialists as SQLite holds it: the model as JSON text. */
export const SpecialistStored = Type.Object({
  id: Type.String(),
  description: Type.String(),
  model: Type.Union([Type.String(), Type.Null()]),
  machine: Type.Union([Type.String(), Type.Null()]),
  session: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.Number()
});

export type SpecialistRow = Omit<Static<typeof SpecialistStored>, "model"> & {
  /** Its model; the worker's when null or no longer available. */
  readonly model: ModelChoice | null;
};

/** A stored specialist, its model decoded; a damaged model reads as none, so the worker's runs. */
export function specialistOf({ model, ...row }: Static<typeof SpecialistStored>): SpecialistRow {
  return { ...row, model: model === null ? null : parseOr(StoredModel, model, null) };
}

/** A row of ky_specialist_sessions, as `bySession` reads it. */
export const SpecialistSession = Type.Object({ specialist: Type.String(), kind: SessionKind });

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
