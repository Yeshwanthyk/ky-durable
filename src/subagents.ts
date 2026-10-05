import { type AssistantMessage, Type } from "@earendil-works/pi-ai";
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
  LiveDoc,
  type TaskId
} from "@earendil-works/pi-durable";
import type { SlotSetting } from "./settings";
import { summarize, type TaskFeed } from "./tasks";

/**
 * Persistent cloud subagents, after pi-durable's example 23. One `subagent`
 * tool spawns named subagents, messages them (steer or follow-up), stops
 * them, and lists them. Each subagent is its own pi conversation in this
 * object, so it remembers earlier messages. Each message is delivered by a
 * background reporter task that posts the answer back to the main agent as
 * a steer, so it lands after the main agent's current tool round, and records it in the task feed.
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
};

type ReporterState = { phase: "deliver" } | { phase: "report"; report?: string };

function textOf(message: AssistantMessage | undefined): string {
  return (message?.content ?? [])
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });

export function subagentExtension(
  feed: TaskFeed,
  /** Main-agent-only extensions that subagents do not get, besides this one. */
  mainOnly: readonly Extension[],
  /** The subagent slot, applied to each subagent whenever it is messaged. */
  model: () => SlotSetting
): Extension {
  const Reporter = defineTask<ReporterInput, ReporterState, null>({
    name: "ky.subagent-reporter",
    version: 1,
    initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: async (reporter, runtime, context) => {
        const { name, conversationId, message, followUp } = reporter.input;
        feed.update(String(reporter.id), { status: "working" });
        const subagent = (await runtime.conversation(conversationId, context))!;

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
          const next = (report?: string) =>
            ({ status: "running", checkpoint: { phase: "report", report } }) as const;

          if (settled.status === "unanswered") {
            if (settled.reason === "aborted") {
              outcome = { status: "stopped", summary: "Stopped" };

              return next();
            }

            outcome = { status: "failed", summary: `Failed: ${settled.reason}` };

            return next(`[subagent ${name} failed: ${settled.reason}]`);
          }

          if (settled.type !== "input") return next();
          const agent = (await tx.doc(Subagents, runtime.conversationId)).agents[name]!;

          if (agent.reported.includes(settled.answer)) return next();
          agent.reported.push(settled.answer);

          // SAFETY: pi-durable types AssistantEntry as Entry<never>, but documents its `model` as [AssistantMessage].
          const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as
            | AssistantMessage
            | undefined;

          const text = textOf(answer);
          outcome = { status: "done", summary: summarize(text) };
          report = text;

          return next(`[subagent ${name} answered, no reply needed] ${text}`);
        }, context);
        feed.update(String(reporter.id), outcome);

        if (outcome.status === "done") feed.describe(String(reporter.id), report);
      },
      report: async (reporter, runtime, context) => {
        const report = reporter.state.checkpoint.report;

        if (report !== undefined) {
          const main = (await runtime.conversation(runtime.conversationId, context))!;
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
      feed.update(String(reporter.id), { status: "stopped" });

      return runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context
      );
    }
  });

  const tool = defineTool({
    name: "subagent",
    description:
      "Delegate work to persistent cloud subagents that run in the background with your tools (minus memory and subagents). " +
      "They are your default for any work beyond a quick call: research, web lookups, browsing, multi-step work. Spawn several when the work splits; they run while you keep talking to the user. Actions: " +
      "spawn (name, title, message): start a new subagent. " +
      "send (name, title, message; followUp: true queues it after the current answer instead of steering it): message an existing one, which also resumes an idle one with its history. " +
      "stop (name): abort its current work; it stays usable. " +
      "status (name, or none for all). " +
      "Answers are reported back to you as messages when they arrive; do not wait or poll for them. " +
      "Subagents know nothing you do not tell them: give them the full context in the message.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("spawn"),
        Type.Literal("send"),
        Type.Literal("stop"),
        Type.Literal("status")
      ]),
      name: Type.Optional(Type.String({ description: "Short, like researcher or pharmacy-finder." })),
      title: Type.Optional(Type.String({ description: "3-6 words for the task list, like 'Find compounding pharmacies'." })),
      message: Type.Optional(Type.String()),
      followUp: Type.Optional(Type.Boolean())
    }),
    // A rerun after a crash could stop newer work; the model can check status.
    replay: "unsafe",
    execute: async (args, api, context) => {
      const { action, name, title, message, followUp } = args;

      const registry = (await api.snapshot(Subagents, api.conversationId, context)) ?? {
        agents: {},
        reporters: {}
      };

      if (action === "status") {
        const names = name === undefined ? Object.keys(registry.agents) : [name];
        const lines: string[] = [];

        for (const each of names) {
          const found = registry.agents[each];

          if (!found) continue;

          const busy =
            (await api.snapshot(LiveDoc, found.conversationId, context))?.run !== undefined;

          const last = feed.latest("cloud", each);
          lines.push(
            `${each}: ${busy ? "working" : "idle"}${last ? ` (last: ${last.title}, ${last.status}${last.summary ? `: ${last.summary}` : ""})` : ""}`
          );
        }

        return reply(lines.length === 0 ? "No subagents." : lines.join("\n"));
      }

      if (name === undefined) return reply(`${action} needs a name.`);
      const agent = registry.agents[name];

      if (action !== "spawn" && agent === undefined) return reply(`No subagent named ${name}.`);

      if (action === "stop") {
        await (await api.conversation(agent!.conversationId, context))!.abort(context);

        return reply(`Stopped ${name}.`);
      }

      if (message === undefined) return reply(`${action} needs a message.`);

      let reporterId: string | undefined;

      const result = await api.commit(async (tx) => {
        const state = await tx.doc(Subagents, api.conversationId);
        const background = { ownership: { kind: "conversation" }, background: true } as const;

        if (action === "spawn") {
          if (state.agents[name]) return `${name} already exists; use send.`;
          const anchor = await tx.createTask(Anchor, null, background);
          const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
          await configure(tx, child.id, {
            extensions: { remove: [extension, ...mainOnly] },
            instructions: `You are the subagent "${name}", working for the main agent. Do the task you are given and answer with what you found or did. Your answer is reported to the main agent, so make it complete and self-contained.`
          });
          state.agents[name] = { conversationId: child.id, reported: [] };
        }

        const conversationId = state.agents[name]!.conversationId;
        const { provider, modelId, thinkingLevel } = model();
        await configure(tx, conversationId, { model: { provider, modelId }, thinkingLevel });

        const input = {
          name,
          conversationId,
          message,
          followUp: action === "send" && followUp === true
        };

        const reporter = await tx.createTask(Reporter, input, background);
        state.reporters[api.taskId] = reporter;
        reporterId = String(reporter);

        return action === "send" ? `Sent to ${name}.` : `Started ${name}.`;
      }, context);

      const conversationId = registry.agents[name]?.conversationId ??
        (await api.snapshot(Subagents, api.conversationId, context))?.agents[name]?.conversationId;

      if (reporterId !== undefined) {
        feed.create({
          id: reporterId,
          kind: "cloud",
          worker: name,
          title: title ?? summarize(message).slice(0, 60),
          status: "working",
          session: conversationId === undefined ? null : String(conversationId)
        });

        if (title === undefined) feed.name(reporterId, message);
      }

      return reply(result);
    }
  });

  const extension: Extension = defineExtension({
    name: "subagents",
    tasks: [Anchor, Reporter],
    tools: [tool]
  });

  return extension;
}
