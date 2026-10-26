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
import { agentModel, type Models, parseModel } from "../models";
import type { ModelChoice } from "../settings";
import { DISCUSS_MAX, DISCUSS_MIN, discussionTitle, type Specialist } from "./specialists";
import type { Specialists } from "./wiring";
import { toolReply as reply } from "../core/reply";
import { type Delivery, summarize, type TaskFeed } from "../automations/contract";
import { must } from "../core/must";
import { endStep, startStep } from "../step-labels";
import { RunCards } from "../ui-tool";
import { setUp, type SpecialistRow, type SubagentAction, SubagentInput, textOf, TOOLS } from "./contract";

type Outcome = { status: "done" | "failed" | "stopped"; summary: string };

type Subagent = {
  conversationId: ConversationId;
  reported: EntryId[];
  model?: ModelChoice;
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
  checkpointWhen: () => false,
  initial: () => ({ agents: {}, reporters: {} })
});

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
  feedId?: string;
  label?: string;
  specialist?: string;
  checkIn?: boolean;
  deliver?: boolean;
  post?: boolean;
};

type SpawnRequest = {
  name: string;
  message: string;
  model: ModelChoice;
  feedId?: string;
  label?: string;
  checkIn?: boolean;
  deliver?: boolean;
  post?: boolean;
};

export type Spawn = (tx: Tx, owner: ConversationId, request: SpawnRequest) => Promise<ConversationId>;

type SubagentTools = { extension: Extension; spawn: Spawn };

type SpecialistDeps = {
  readonly store: Specialists;
  readonly tools: Specialist;
  readonly remove: readonly Extension[];
  readonly model: (own: ModelChoice | null) => ModelChoice;
};

const handle = (id: string | undefined) => (id ?? "").trim().replace(/^@/, "");

type ReporterState = { phase: "deliver" } | { phase: "report"; report?: string; line?: string; kind?: "post"; cards?: string };

const NOTHING_NEW = /^\s*NOTHING_NEW\b/;

function failureOf(input: ReporterInput, reason: string): string | undefined {
  if (input.checkIn) return undefined;

  return `[${input.label ?? `subagent ${input.name}`} failed: ${reason}]`;
}

const labelOf = (input: ReporterInput) => input.label ?? `subagent ${input.name}`;

const lineOf = (input: ReporterInput, said: string) => `${labelOf(input)}: ${said}`;

function answeredOf(input: ReporterInput, text: string, cards: number) {
  if (input.checkIn && NOTHING_NEW.test(text)) return { summary: "Nothing new", report: "", message: undefined };

  if (input.post && !text.trim()) return cards > 0 ? { summary: "Posted a card", report: "", message: "" } : { summary: "Nothing to post", report: "", message: undefined };

  return { summary: summarize(text), report: text, message: reportOf(input, text, cards) };
}

function reportOf(input: ReporterInput, text: string, cards: number): string {
  if (input.post) return text;

  if (input.specialist !== undefined) return `[specialist @${input.specialist} answered: pass on what matters] ${text}`;

  if (input.checkIn) {
    return `[${input.label} found something new: if memory shows you already told the user, say nothing more than "Nothing new." Otherwise tell them in one or two lines, tied to what they asked and who it concerns, with the source; then memory_note what you told them] ${text}`;
  }

  if (input.label === undefined) return `[subagent ${input.name} answered, no reply needed] ${text}`;

  return cards > 0
    ? `[${input.label} result, its card already shown to the user just above: tell the user the rest] ${text}`
    : `[${input.label} result: tell the user] ${text}`;
}

const background = (conversationId: ConversationId) =>
  ({ ownership: { kind: "conversation" }, conversationId, background: true }) as const;

export function subagentExtension(
  feed: TaskFeed,
  mainOnly: readonly Extension[],
  runKeeps: readonly Extension[],
  model: () => ModelChoice,
  models: Pick<Models, "valid" | "choices">,
  wanted: (feedId: string) => boolean,
  specialists?: SpecialistDeps,
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
          const next = (report?: string, line?: string, kind?: "post", cards?: string) =>
            ({ status: "running", checkpoint: { phase: "report", report, line, kind, cards } }) as const;

          if (settled.status === "unanswered") {
            if (settled.reason === "aborted") {
              outcome = { status: "stopped", summary: "Stopped" };

              return next();
            }

            outcome = { status: "failed", summary: `Failed: ${settled.reason}` };

            return next(failureOf(reporter.input, settled.reason), lineOf(reporter.input, `failed: ${settled.reason}`));
          }

          if (settled.type !== "input") return next();
          const agent = (await tx.doc(Subagents, runtime.conversationId)).agents[name];

          if (agent?.reported.includes(settled.answer)) return next();
          agent?.reported.push(settled.answer);

          // SAFETY: pi-durable types AssistantEntry as Entry<never>, but documents its `model` as [AssistantMessage].
          const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as
            | AssistantMessage
            | undefined;

          const text = textOf(answer);
          const shown = reporter.input.deliver ? await tx.doc(RunCards, conversationId) : undefined;
          const cards = reporter.input.checkIn && NOTHING_NEW.test(text) ? [] : (shown?.cards.splice(0) ?? []);
          const read = answeredOf(reporter.input, text, cards.length);
          outcome = { status: "done", summary: read.summary };
          report = read.report;
          const posted = cards.length > 0 ? `[${cards.map((each) => each.card).join(",")}]` : undefined;

          return next(read.message, lineOf(reporter.input, read.summary), reporter.input.post ? "post" : undefined, posted);
        }, context);
        const wantedStill = wanted(feedId);
        feed.update(feedId, wantedStill ? outcome : { status: "stopped", summary: "Stopped" });

        if (report && wantedStill) feed.describe(feedId, report);
      },
      report: async (reporter, runtime, context) => {
        const { report, line, kind, cards } = reporter.state.checkpoint;
        const feedId = reporter.input.feedId ?? String(reporter.id);

        if (report !== undefined && wanted(feedId)) {
          if (reporter.input.deliver && handOver) {
            await handOver({
              id: `subagent-report:${reporter.id}`,
              session: String(runtime.conversationId),
              content: report,
              line: line ?? lineOf(reporter.input, summarize(report)),
              ref: `task:${feedId}`,
              kind,
              cards
            });
          } else {
            const main = must(await runtime.conversation(runtime.conversationId, context), "The main conversation is gone.");
            await main.submit(
              {
                type: "input",
                content: report,
                whenBusy: "steer",
                requestId: `subagent-report:${reporter.id}`
              },
              context
            );
          }
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
      "last (name): its latest answer in full. " +
      "spawn and send take model (provider/modelId, kept for later sends; worker to clear it) and thinking to run on other than the worker model; not on a followUp send while it is busy. " +
      "Answers are reported back to you as messages when they arrive; do not wait or poll for them. " +
      "Subagents know nothing you do not tell them: give them the full context in the message. " +
      "Specialists (see the roster, if any): " +
      "ask (specialist, title, message): give one specialist a task or a question; its answer is reported back like a subagent's. " +
      `discuss (specialists: ${DISCUSS_MIN} to ${DISCUSS_MAX} ids, message: the topic, rounds: 1 or 2, default 2): they each answer, then reply to each other; the transcript is reported back for you to sum up.`,
    parameters: SubagentInput,
    replay: "unsafe",
    execute: async (args, api, context) => reply(await ACTIONS[args.action](desk, args, api, context))
  });

  const extension: Extension = defineExtension({
    name: "subagents",
    tasks: [Anchor, Reporter],
    tools: [tool]
  });

  async function register(tx: Tx, owner: ConversationId, name: string, run = false): Promise<ConversationId> {
    const state = await tx.doc(Subagents, owner);
    const anchor = await tx.createTask(Anchor, null, background(owner));
    const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });

    if (run) (await tx.doc(RunCards, child.id)).run = true;
    await configure(tx, child.id, {
      extensions: { remove: [extension, ...mainOnly.filter((each) => !(run && runKeeps.includes(each)))] },
      instructions: `You are the subagent "${name}", working for the main agent. Do the task you are given and answer with what you found or did. Your answer is reported to the main agent, so make it complete and self-contained.`
    });
    state.agents[name] = { conversationId: child.id, reported: [] };

    return child.id;
  }

  async function deliver(tx: Tx, owner: ConversationId, input: ReporterInput, choice: ModelChoice): Promise<TaskId> {
    await configure(tx, input.conversationId, agentModel(choice));

    return tx.createTask(Reporter, input, background(owner));
  }

  const desk: Desk = { feed, specialists, model, models, register, deliver };

  const spawn: Spawn = async (tx, owner, { name, message, model, feedId, label, checkIn, deliver: delivered, post }) => {
    const conversationId = await register(tx, owner, name, delivered === true);
    await deliver(tx, owner, { name, conversationId, message, followUp: false, feedId, label, checkIn, deliver: delivered, post }, model);

    return conversationId;
  };

  return { extension, spawn };
}

type Desk = {
  readonly feed: TaskFeed;
  readonly specialists: SpecialistDeps | undefined;
  readonly model: () => ModelChoice;
  readonly models: Pick<Models, "valid" | "choices">;
  readonly register: (tx: Tx, owner: ConversationId, name: string) => Promise<ConversationId>;
  readonly deliver: (tx: Tx, owner: ConversationId, input: ReporterInput, choice: ModelChoice) => Promise<TaskId>;
};

type Act = (desk: Desk, args: SubagentInput, api: ToolExecutionApi, context: Context) => Promise<string>;

async function registryOf(api: ToolExecutionApi, context: Context) {
  return (await api.snapshot(Subagents, api.conversationId, context)) ?? { agents: {}, reporters: {} };
}

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

async function lastAnswer(api: ToolExecutionApi, agent: Subagent, context: Context): Promise<string | undefined> {
  const id = agent.reported.at(-1);

  if (id === undefined) return undefined;
  const message = (await api.commit((tx) => tx.entry(id), context))?.model?.[0];
  const text = message?.role === "assistant" ? textOf(message) : "";

  return text === "" ? undefined : text;
}

const LAST_MAX = 16_000;

function capped(text: string): string {
  if (text.length <= LAST_MAX) return text;
  const code = text.charCodeAt(LAST_MAX - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? LAST_MAX - 1 : LAST_MAX;

  return `${text.slice(0, end)}…[truncated; ${text.length} chars total]`;
}

const last: Act = async (_desk, { name }, api, context) => {
  if (name === undefined) return "last needs a name.";
  const agent = (await registryOf(api, context)).agents[name];

  if (agent === undefined) return `No subagent named ${name}.`;
  const text = await lastAnswer(api, agent, context);

  return text === undefined ? `${name} has no answer yet.` : capped(text);
};

const stop: Act = async (_desk, { name }, api, context) => {
  const registry = await registryOf(api, context);

  if (name === undefined) return "stop needs a name.";
  const agent = registry.agents[name];

  if (agent === undefined) return `No subagent named ${name}.`;
  await must(await api.conversation(agent.conversationId, context), `${name}'s conversation is gone.`).abort(context);

  return `Stopped ${name}.`;
};

function show(feed: TaskFeed, id: string, worker: string, title: string | undefined, text: string, session: ConversationId | undefined, chat: ConversationId | null): void {
  feed.create({
    id,
    kind: "cloud",
    worker,
    title: title ?? summarize(text).slice(0, 60),
    status: "working",
    session: session === undefined ? null : String(session),
    chat: chat === null ? null : String(chat)
  });

  if (title === undefined) feed.name(id, text);
}

type Registry = Awaited<ReturnType<typeof registryOf>>;

function messageRefusal(action: "spawn" | "send", name: string | undefined, text: string | undefined, registry: Registry): string | undefined {
  if (name === undefined) return `${action} needs a name.`;

  if (action !== "spawn" && registry.agents[name] === undefined) return `No subagent named ${name}.`;

  return text === undefined ? `${action} needs a message.` : undefined;
}

type Run = { choice: ModelChoice; own: ModelChoice | undefined } | { refused: string };

function runOf({ model, models }: Desk, kept: ModelChoice | undefined, args: SubagentInput): Run {
  const worker = model();
  const named = args.model?.trim();

  if (named === undefined || named === "worker") {
    const own = named === undefined ? kept : undefined;
    const base = (own && models.valid(own)) ?? worker;

    if (args.thinking === undefined) return { choice: base, own };
    const leveled = { ...base, thinkingLevel: args.thinking };

    return { choice: models.valid(leveled) ?? leveled, own: own && { ...own, thinkingLevel: args.thinking } };
  }

  const asked = parseModel(named, args.thinking ?? (kept ?? worker).thinkingLevel);
  const choice = models.valid(asked);

  return choice ? { choice, own: asked } : { refused: `No connected model ${asked.provider}/${asked.modelId}. ${models.choices()}` };
}

function message(action: "spawn" | "send"): Act {
  return async (desk, args, api, context) => {
    const { feed, register, deliver } = desk;
    const { name, title, message: text, followUp } = args;

    if (action === "spawn" && name?.startsWith("@")) return "Names starting with @ are specialists'; use ask.";
    const registry = await registryOf(api, context);
    const refusal = messageRefusal(action, name, text, registry);

    if (refusal !== undefined || name === undefined || text === undefined) return refusal ?? "";

    let reporterId: string | undefined;

    const result = await api.commit(async (tx) => {
      const state = await tx.doc(Subagents, api.conversationId);

      if (action === "spawn" && state.agents[name]) return `${name} already exists; use send.`;
      const run = runOf(desk, state.agents[name]?.model, args);

      if ("refused" in run) return run.refused;
      const queued = action === "send" && followUp === true && (args.model !== undefined || args.thinking !== undefined);

      if (queued && (await tx.doc(LiveDoc, must(state.agents[name], `No subagent named ${name}.`).conversationId)).run !== undefined) {
        return `${name} is busy: a followUp send can't change its model. Send it without followUp, or once it answers.`;
      }

      if (action === "spawn") await register(tx, api.conversationId, name);
      const agent = must(state.agents[name], `No subagent named ${name}.`);

      if (run.own === undefined) delete agent.model;
      else agent.model = run.own;

      const input = { name, conversationId: agent.conversationId, message: text, followUp: action === "send" && followUp === true };

      const reporter = await deliver(tx, api.conversationId, input, run.choice);
      state.reporters[api.taskId] = reporter;
      reporterId = String(reporter);

      return action === "send" ? `Sent to ${name}.` : `Started ${name}.`;
    }, context);

    const conversationId =
      registry.agents[name]?.conversationId ?? (await api.snapshot(Subagents, api.conversationId, context))?.agents[name]?.conversationId;

    if (reporterId !== undefined) show(feed, reporterId, name, title, text, conversationId, api.conversationId);

    return result;
  };
}

async function fresh(deps: SpecialistDeps, tx: Tx, id: string, kind: "home" | "consult" | "discuss"): Promise<ConversationId> {
  const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
  await setUp(tx, child.id, deps.remove, deps.model(must(deps.store.get(id), `No specialist @${id}.`).model));
  deps.store.attach(String(child.id), id, kind);

  return child.id;
}

async function askedIn(deps: SpecialistDeps, tx: Tx, owner: ConversationId, row: SpecialistRow, caller: string | undefined): Promise<ConversationId> {
  if (caller !== undefined) return fresh(deps, tx, row.id, "consult");
  // SAFETY: a specialist's session is the id, as text, of a conversation fresh() made.
  const conversationId = row.session === null ? await fresh(deps, tx, row.id, "home") : (Number(row.session) as ConversationId);
  const state = await tx.doc(Subagents, owner);
  const name = `@${row.id}`;

  if (state.agents[name]?.conversationId !== conversationId) state.agents[name] = { conversationId, reported: [] };

  return conversationId;
}

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

  show(feed, feedId, caller === undefined ? name : `@${caller} → ${name}`, title, text, conversationId, caller === undefined ? api.conversationId : null);

  return `Asked ${name}.`;
};

function discussRefusal(deps: SpecialistDeps, owner: ConversationId, ids: readonly string[], topic: string | undefined): string | undefined {
  if (deps.store.bySession(String(owner))) return "Specialists cannot start a discussion.";

  if (ids.length < DISCUSS_MIN || ids.length > DISCUSS_MAX || new Set(ids).size !== ids.length) {
    return `discuss needs ${DISCUSS_MIN} to ${DISCUSS_MAX} different specialists.`;
  }

  const missing = ids.find((id) => !deps.store.has(id));

  if (missing !== undefined) return `No specialist @${missing}.`;

  return topic === undefined || topic.trim() === "" ? "discuss needs a message: the topic." : undefined;
}

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
  feed.create({ id: feedId, kind: "cloud", worker: who, title: args.title ?? discussionTitle(topic), status: "working", session: null, chat: String(api.conversationId) });

  return `Started a discussion with ${who}.`;
};

export const ACTIONS: Readonly<Record<SubagentAction, Act>> = {
  spawn: message("spawn"),
  send: message("send"),
  stop,
  status: (desk, { name }, api, context) => status(desk.feed, name, api, context),
  last,
  ask,
  discuss
};

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
          const output = (result.output ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
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
