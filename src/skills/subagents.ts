import type { Context } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  type ConversationId,
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  type EntryId,
  type Extension,
  GenerationTask,
  hook,
  LiveDoc,
  type TaskId,
  type ToolExecutionApi,
  ToolTask,
  type Tx
} from "@earendil-works/pi-durable";
import { agentModel } from "../models";
import type { ModelChoice } from "../settings";
import { DISCUSS_MAX, DISCUSS_MIN, discussionTitle, reply, type Specialist, type Specialists } from "./specialists";
import { type Delivery, summarize, type TaskFeed } from "../automations/contract";
import { must } from "../core/must";
import { endStep, startStep } from "../step-labels";
import { setUp, type SpecialistRow, type SubagentAction, SubagentInput, textOf, TOOLS } from "./contract";

/**
 * Persistent cloud subagents, after pi-durable's example 23. One `subagent`
 * tool spawns named subagents, messages them (steer or follow-up), stops
 * them, and lists them. Each subagent is its own pi conversation in this
 * object, so it remembers earlier messages. Each message is delivered by a
 * background reporter task that posts the answer back to the main agent as
 * a steer, so it lands after the main agent's current tool round, and records it in the task feed.
 * An automation's run is the exception: its report is handed to delivery (src/automations/delivery.ts),
 * which puts it in the chat only between turns, or in the brief while the user is away.
 */

/** How a subagent's message ended, for its row in the task feed. */
type Outcome = { status: "done" | "failed" | "stopped"; summary: string };

type Subagent = {
  conversationId: ConversationId;
  /** Answers already reported, so several messages ending in one answer report once. */
  reported: EntryId[];
};

const Subagents = defineDoc<{
  agents: Record<string, Subagent>;
  reporters: Record<string, TaskId>;
}>({
  kind: "ky.subagents",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ agents: {}, reporters: {} })
});

/**
 * Owns a subagent's conversation. A background task that finishes at once:
 * the main agent's Esc and idle waits stop at it, so subagents outlive turns.
 */
const Anchor = defineTask<null, { phase: "done" }, null>({
  name: "ky.subagent-anchor",
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: (_anchor, runtime, context) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
        context
      )
  },
  abort: (_anchor, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context)
});

type ReporterInput = {
  name: string;
  conversationId: ConversationId;
  message: string;
  followUp: boolean;
  /** The task feed row it updates; the reporter's own id when unset. */
  feedId?: string;
  /** Who reports to the main agent when the user wants the result, like `automation "Daily digest"`. */
  label?: string;
  /** The specialist answering, by id. */
  specialist?: string;
  /** A check-in's run: it reports only what it found new, and a failure stays in Activity. */
  checkIn?: boolean;
  /** An automation's run: its report is delivered between turns, or to the brief (src/automations/delivery.ts), not steered in. */
  deliver?: boolean;
};

/** A fresh subagent conversation registered under `name`, sent `message` on `model`. */
export type SpawnRequest = {
  name: string;
  message: string;
  model: ModelChoice;
  feedId?: string;
  label?: string;
  checkIn?: boolean;
  deliver?: boolean;
};

/** Spawn inside a commit on `owner`, the conversation the answer is reported to; returns the subagent's conversation. */
export type Spawn = (tx: Tx, owner: ConversationId, request: SpawnRequest) => Promise<ConversationId>;

/** The subagent tool, and the same spawn for work that starts outside a tool call. */
type SubagentTools = { extension: Extension; spawn: Spawn };

/** What `ask` and `discuss` need: the specialists, their task, what they do without, and their model. */
export type SpecialistDeps = {
  readonly store: Specialists;
  readonly tools: Specialist;
  /** Extensions a specialist's conversations do not get: the main agent's persona and managers. */
  readonly remove: readonly Extension[];
  /** A specialist's model as it can run: its own, or the worker's. */
  readonly model: (own: ModelChoice | null) => ModelChoice;
};

const handle = (id: string | undefined) => (id ?? "").trim().replace(/^@/, "");

/** `line` is the report in a line, for the brief; checkpoints from before it have none. */
type ReporterState = { phase: "deliver" } | { phase: "report"; report?: string; line?: string };

/** A check-in's answer when it found nothing worth saying. */
const NOTHING_NEW = /^\s*NOTHING_NEW\b/;

/** What the main agent reads of a failed run; a check-in's failure stays in Activity. */
function failureOf(input: ReporterInput, reason: string): string | undefined {
  if (input.checkIn) return undefined;

  return `[${input.label ?? `subagent ${input.name}`} failed: ${reason}]`;
}

/** A report in one line, for the brief while the user is away. */
const lineOf = (input: ReporterInput, said: string) => `${input.label ?? `subagent ${input.name}`}: ${said}`;

/** An answer's summary and report for Activity, and what the main agent reads; a check-in with nothing new posts nothing. */
function answeredOf(input: ReporterInput, text: string) {
  if (input.checkIn && NOTHING_NEW.test(text)) return { summary: "Nothing new", report: "", message: undefined };

  return { summary: summarize(text), report: text, message: reportOf(input, text) };
}

/** What the main agent reads: a subagent's answer needs no reply, a labelled report is for the user. */
function reportOf(input: ReporterInput, text: string): string {
  if (input.specialist !== undefined) return `[specialist @${input.specialist} answered: pass on what matters] ${text}`;

  if (input.checkIn) {
    return `[${input.label} found something new: if memory shows you already told the user, say nothing more than "Nothing new." Otherwise tell them in one or two lines, tied to what they asked and who it concerns, with the source; then memory_note what you told them] ${text}`;
  }

  return input.label === undefined
    ? `[subagent ${input.name} answered, no reply needed] ${text}`
    : `[${input.label} result: tell the user] ${text}`;
}

const background = (conversationId: ConversationId) =>
  ({ ownership: { kind: "conversation" }, conversationId, background: true }) as const;

export function subagentExtension(
  feed: TaskFeed,
  /** Main-agent-only extensions that subagents do not get, besides this one. */
  mainOnly: readonly Extension[],
  /** The worker's model, applied to each subagent whenever it is messaged. */
  model: () => ModelChoice,
  /** Whether a task's work is still wanted; checked before it starts and before its report is posted. */
  wanted: (feedId: string) => boolean,
  specialists?: SpecialistDeps,
  /** How an automation's report reaches the user (src/automations/delivery.ts). */
  handOver?: (item: Delivery) => Promise<void>
): SubagentTools {
  const Reporter = defineTask<ReporterInput, ReporterState, null>({
    name: "ky.subagent-reporter",
    version: 1,
    initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: async (reporter, runtime, context) => {
        const { name, conversationId, message, followUp } = reporter.input;
        const feedId = reporter.input.feedId ?? String(reporter.id);

        if (!wanted(feedId)) {
          feed.update(feedId, { status: "stopped", summary: "Stopped" });

          return runtime.commit(
            () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
            context
          );
        }

        feed.update(feedId, { status: "working", session: String(conversationId) });
        const subagent = must(await runtime.conversation(conversationId, context), `${name}'s conversation is gone.`);

        const submission = await subagent.submit(
          {
            type: "input",
            content: message,
            whenBusy: followUp ? "followUp" : "steer",
            requestId: `subagent:${reporter.id}`
          },
          context
        );

        const settled = await submission.wait(context);

        let outcome: Outcome = {
          status: "done",
          summary: ""
        };

        let report = "";

        await runtime.commit(async (tx) => {
          const next = (report?: string, line?: string) =>
            ({ status: "running", checkpoint: { phase: "report", report, line } }) as const;

          if (settled.status === "unanswered") {
            if (settled.reason === "aborted") {
              outcome = { status: "stopped", summary: "Stopped" };

              return next();
            }

            outcome = { status: "failed", summary: `Failed: ${settled.reason}` };

            return next(failureOf(reporter.input, settled.reason), lineOf(reporter.input, `failed: ${settled.reason}`));
          }

          if (settled.type !== "input") return next();
          // A specialist's fresh conversation is not registered: it answers once.
          const agent = (await tx.doc(Subagents, runtime.conversationId)).agents[name];

          if (agent?.reported.includes(settled.answer)) return next();
          agent?.reported.push(settled.answer);

          // SAFETY: pi-durable types AssistantEntry as Entry<never>, but documents its `model` as [AssistantMessage].
          const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as
            | AssistantMessage
            | undefined;

          const text = textOf(answer);
          const read = answeredOf(reporter.input, text);
          outcome = { status: "done", summary: read.summary };
          report = read.report;

          return next(read.message, lineOf(reporter.input, read.summary));
        }, context);
        feed.update(feedId, outcome);

        if (report) feed.describe(feedId, report);
      },
      report: async (reporter, runtime, context) => {
        const { report, line } = reporter.state.checkpoint;
        const feedId = reporter.input.feedId ?? String(reporter.id);

        if (report !== undefined && wanted(feedId) && reporter.input.deliver && handOver) {
          // The same request id as a steer's below, so a report a deploy caught between the two goes in once.
          await handOver({
            id: `subagent-report:${reporter.id}`,
            session: String(runtime.conversationId),
            content: report,
            line: line ?? lineOf(reporter.input, summarize(report)),
            ref: `task:${feedId}`
          });
        } else if (report !== undefined && wanted(feedId)) {
          const main = must(await runtime.conversation(runtime.conversationId, context), "The main conversation is gone.");
          await main.submit(
            {
              type: "input",
              content: report,
              // A follow-up would wait for the main agent's whole run; a steer joins after its current tool round.
              whenBusy: "steer",
              requestId: `subagent-report:${reporter.id}`
            },
            context
          );
        }

        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
          context
        );
      }
    },
    abort: (reporter, runtime, context) => {
      feed.update(reporter.input.feedId ?? String(reporter.id), { status: "stopped" });

      return runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context
      );
    }
  });

  const tool = defineTool({
    name: TOOLS.subagent,
    description:
      "Delegate work to persistent cloud subagents that run in the background with your tools (minus memory and subagents). " +
      "They are your default for any work beyond a quick call: research, web lookups, browsing, multi-step work. Spawn several when the work splits; they run while you keep talking to the user. Actions: " +
      "spawn (name, title, message): start a new subagent. " +
      "send (name, title, message; followUp: true queues it after the current answer instead of steering it): message an existing one, which also resumes an idle one with its history. " +
      "stop (name): abort its current work; it stays usable. " +
      "status (name, or none for all). " +
      "Answers are reported back to you as messages when they arrive; do not wait or poll for them. " +
      "Subagents know nothing you do not tell them: give them the full context in the message. " +
      "Specialists (see the roster, if any): " +
      "ask (specialist, title, message): give one specialist a task or a question; its answer is reported back like a subagent's. " +
      `discuss (specialists: ${DISCUSS_MIN} to ${DISCUSS_MAX} ids, message: the topic, rounds: 1 or 2, default 2): they each answer, then reply to each other; the transcript is reported back for you to sum up.`,
    parameters: SubagentInput,
    // A rerun after a crash could stop newer work; the model can check status.
    replay: "unsafe",
    execute: async (args, api, context) => reply(await ACTIONS[args.action](desk, args, api, context))
  });

  const extension: Extension = defineExtension({
    name: "subagents",
    tasks: [Anchor, Reporter],
    tools: [tool]
  });

  /** A fresh child conversation, configured as a subagent and registered under `name`, replacing any before it. */
  async function register(tx: Tx, owner: ConversationId, name: string): Promise<ConversationId> {
    const state = await tx.doc(Subagents, owner);
    const anchor = await tx.createTask(Anchor, null, background(owner));
    const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
    await configure(tx, child.id, {
      extensions: { remove: [extension, ...mainOnly] },
      instructions: `You are the subagent "${name}", working for the main agent. Do the task you are given and answer with what you found or did. Your answer is reported to the main agent, so make it complete and self-contained.`
    });
    state.agents[name] = { conversationId: child.id, reported: [] };

    return child.id;
  }

  /** Message a subagent on `choice`: a reporter task delivers it and reports the answer to `owner`. */
  async function deliver(tx: Tx, owner: ConversationId, input: ReporterInput, choice: ModelChoice): Promise<TaskId> {
    await configure(tx, input.conversationId, agentModel(choice));

    return tx.createTask(Reporter, input, background(owner));
  }

  const desk: Desk = { feed, specialists, model, register, deliver };

  const spawn: Spawn = async (tx, owner, { name, message, model, feedId, label, checkIn, deliver: delivered }) => {
    const conversationId = await register(tx, owner, name);
    await deliver(tx, owner, { name, conversationId, message, followUp: false, feedId, label, checkIn, deliver: delivered }, model);

    return conversationId;
  };

  return { extension, spawn };
}

/** What the subagent tool's actions work with. */
type Desk = {
  readonly feed: TaskFeed;
  readonly specialists: SpecialistDeps | undefined;
  /** The worker's model, applied to each subagent whenever it is messaged. */
  readonly model: () => ModelChoice;
  /** A fresh child conversation, configured as a subagent and registered under `name`. */
  readonly register: (tx: Tx, owner: ConversationId, name: string) => Promise<ConversationId>;
  /** Message a subagent on `choice`: a reporter task delivers it and reports the answer to `owner`. */
  readonly deliver: (tx: Tx, owner: ConversationId, input: ReporterInput, choice: ModelChoice) => Promise<TaskId>;
};

/** One subagent tool action; returns what the agent reads. */
type Act = (desk: Desk, args: SubagentInput, api: ToolExecutionApi, context: Context) => Promise<string>;

/** This conversation's subagents. */
async function registryOf(api: ToolExecutionApi, context: Context) {
  return (await api.snapshot(Subagents, api.conversationId, context)) ?? { agents: {}, reporters: {} };
}

/** Each subagent, or the one named, with whether it is working and its last task. */
async function status(feed: TaskFeed, name: string | undefined, api: ToolExecutionApi, context: Context): Promise<string> {
  const registry = await registryOf(api, context);
  const names = name === undefined ? Object.keys(registry.agents) : [name];
  const lines: string[] = [];

  for (const each of names) {
    const found = registry.agents[each];

    if (!found) continue;

    const busy = (await api.snapshot(LiveDoc, found.conversationId, context))?.run !== undefined;

    const last = feed.latest("cloud", each);
    lines.push(`${each}: ${busy ? "working" : "idle"}${last ? ` (last: ${last.title}, ${last.status}${last.summary ? `: ${last.summary}` : ""})` : ""}`);
  }

  return lines.length === 0 ? "No subagents." : lines.join("\n");
}

const stop: Act = async (_desk, { name }, api, context) => {
  const registry = await registryOf(api, context);

  if (name === undefined) return "stop needs a name.";
  const agent = registry.agents[name];

  if (agent === undefined) return `No subagent named ${name}.`;
  await must(await api.conversation(agent.conversationId, context), `${name}'s conversation is gone.`).abort(context);

  return `Stopped ${name}.`;
};

/** A task's row in Activity, named by `title` or, without one, from its message. */
function show(feed: TaskFeed, id: string, worker: string, title: string | undefined, text: string, session: ConversationId | undefined): void {
  feed.create({
    id,
    kind: "cloud",
    worker,
    title: title ?? summarize(text).slice(0, 60),
    status: "working",
    session: session === undefined ? null : String(session)
  });

  if (title === undefined) feed.name(id, text);
}

type Registry = Awaited<ReturnType<typeof registryOf>>;

/** Why a spawn or a send can't go, if it can't. */
function messageRefusal(action: "spawn" | "send", name: string | undefined, text: string | undefined, registry: Registry): string | undefined {
  if (name === undefined) return `${action} needs a name.`;

  if (action !== "spawn" && registry.agents[name] === undefined) return `No subagent named ${name}.`;

  return text === undefined ? `${action} needs a message.` : undefined;
}

/** Spawn a subagent, or send one a message. */
function message(action: "spawn" | "send"): Act {
  return async ({ feed, model, register, deliver }, { name, title, message: text, followUp }, api, context) => {
    if (action === "spawn" && name?.startsWith("@")) return "Names starting with @ are specialists'; use ask.";
    const registry = await registryOf(api, context);
    const refusal = messageRefusal(action, name, text, registry);

    if (refusal !== undefined || name === undefined || text === undefined) return refusal ?? "";

    let reporterId: string | undefined;

    const result = await api.commit(async (tx) => {
      const state = await tx.doc(Subagents, api.conversationId);

      if (action === "spawn" && state.agents[name]) return `${name} already exists; use send.`;

      const conversationId =
        action === "spawn"
          ? await register(tx, api.conversationId, name)
          : must(state.agents[name], `No subagent named ${name}.`).conversationId;

      const input = { name, conversationId, message: text, followUp: action === "send" && followUp === true };

      const reporter = await deliver(tx, api.conversationId, input, model());
      state.reporters[api.taskId] = reporter;
      reporterId = String(reporter);

      return action === "send" ? `Sent to ${name}.` : `Started ${name}.`;
    }, context);

    const conversationId =
      registry.agents[name]?.conversationId ?? (await api.snapshot(Subagents, api.conversationId, context))?.agents[name]?.conversationId;

    if (reporterId !== undefined) show(feed, reporterId, name, title, text, conversationId);

    return result;
  };
}

/** A fresh conversation for `id`, set up as its own and recorded as `kind`. */
async function fresh(deps: SpecialistDeps, tx: Tx, id: string, kind: "home" | "consult" | "discuss"): Promise<ConversationId> {
  const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
  await setUp(tx, child.id, deps.remove, deps.model(must(deps.store.get(id), `No specialist @${id}.`).model));
  deps.store.attach(String(child.id), id, kind);

  return child.id;
}

/** Where an ask for `row` goes: its home conversation from a chat, registered here; a fresh one from another specialist. */
async function askedIn(deps: SpecialistDeps, tx: Tx, owner: ConversationId, row: SpecialistRow, caller: string | undefined): Promise<ConversationId> {
  if (caller !== undefined) return fresh(deps, tx, row.id, "consult");
  // SAFETY: a specialist's session is the id, as text, of a conversation fresh() made.
  const conversationId = row.session === null ? await fresh(deps, tx, row.id, "home") : (Number(row.session) as ConversationId);
  const state = await tx.doc(Subagents, owner);
  const name = `@${row.id}`;

  if (state.agents[name]?.conversationId !== conversationId) state.agents[name] = { conversationId, reported: [] };

  return conversationId;
}

/**
 * One task for a specialist. From a chat it goes to the specialist's home
 * conversation, queued behind any work it has; from another specialist,
 * to a fresh conversation, so a consult never steers its own work.
 */
const ask: Act = async ({ feed, specialists: deps, deliver }, args, api, context) => {
  if (deps === undefined) return "There are no specialists.";
  const { message: text, title } = args;
  const id = handle(args.specialist);
  const row = deps.store.get(id);

  if (!row) return `No specialist @${id}. Specialists: ${deps.store.list().map((each) => `@${each.id}`).join(", ") || "none yet"}.`;

  if (text === undefined) return "ask needs a message.";
  const caller = deps.store.bySession(String(api.conversationId))?.specialist.id;

  if (caller === id) return "You cannot ask yourself.";
  const name = `@${id}`;
  const feedId = crypto.randomUUID();
  let conversationId: ConversationId | undefined;

  await api.commit(async (tx) => {
    conversationId = await askedIn(deps, tx, api.conversationId, row, caller);
    await deliver(tx, api.conversationId, { name, conversationId, message: text, followUp: true, feedId, specialist: id }, deps.model(row.model));
  }, context);

  show(feed, feedId, caller === undefined ? name : `@${caller} → ${name}`, title, text, conversationId);

  return `Asked ${name}.`;
};

/** Why a discussion among `ids` on `topic` can't start, if it can't. */
function discussRefusal(deps: SpecialistDeps, owner: ConversationId, ids: readonly string[], topic: string | undefined): string | undefined {
  if (deps.store.bySession(String(owner))) return "Specialists cannot start a discussion.";

  if (ids.length < DISCUSS_MIN || ids.length > DISCUSS_MAX || new Set(ids).size !== ids.length) {
    return `discuss needs ${DISCUSS_MIN} to ${DISCUSS_MAX} different specialists.`;
  }

  const missing = ids.find((id) => !deps.store.has(id));

  if (missing !== undefined) return `No specialist @${missing}.`;

  return topic === undefined || topic.trim() === "" ? "discuss needs a message: the topic." : undefined;
}

/** A discussion among specialists, each in a fresh conversation, reported back to this one. */
const discuss: Act = async ({ feed, specialists: deps }, args, api, context) => {
  if (deps === undefined) return "There are no specialists.";
  const ids = (args.specialists ?? []).map(handle);
  const topic = args.message;
  const refusal = discussRefusal(deps, api.conversationId, ids, topic);

  if (refusal !== undefined || topic === undefined) return refusal ?? "";
  const feedId = crypto.randomUUID();
  const rounds = args.rounds ?? 2;

  await api.commit(
    (tx) => deps.tools.discuss(tx, api.conversationId, { topic, ids, rounds, feedId }, (inner, id) => fresh(deps, inner, id, "discuss")),
    context
  );

  const who = ids.map((id) => `@${id}`).join(", ");
  feed.create({ id: feedId, kind: "cloud", worker: who, title: args.title ?? discussionTitle(topic), status: "working", session: null });

  return `Started a discussion with ${who}.`;
};

/** One handler per action: the record's type makes it exhaustive, so no action falls through to another. */
export const ACTIONS: Readonly<Record<SubagentAction, Act>> = {
  spawn: message("spawn"),
  send: message("send"),
  stop,
  status: (desk, { name }, api, context) => status(desk.feed, name, api, context),
  ask,
  discuss
};

/**
 * Each tool a subagent uses becomes a step on its task, done with what it
 * returned once it returns, and each model
 * response adds a turn and its cost. Installed for every conversation, since
 * subagents drop the `subagents` extension; a conversation with no working
 * cloud task, such as the main chat, records nothing.
 */
export function subagentProgressExtension(feed: TaskFeed): Extension {
  const task = (conversationId: ConversationId) => feed.working(String(conversationId))?.id;

  return defineExtension({
    name: "subagent-progress",
    hooks: [
      hook(ToolTask, {
        beforeTool(call, api) {
          const id = task(api.conversationId);

          if (id === undefined) return undefined;
          const start = startStep(call.name, call.arguments);
          feed.step(id, start.text, { call: call.id, input: start.input });

          return undefined;
        },
        afterTool(call, result, api) {
          const id = task(api.conversationId);

          if (id === undefined) return undefined;
          const output = (result.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
          feed.stepEnd(id, call.id, endStep(call.name, call.arguments, output, result.isError !== true));

          return undefined;
        }
      }),
      hook(GenerationTask, {
        afterResponse(message, api) {
          const id = task(api.conversationId);

          if (id !== undefined) feed.spend(id, 1, message.usage?.cost?.total ?? 0);
        }
      })
    ]
  });
}
