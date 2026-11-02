import type { TaskLogStep, TaskRow } from "../protocol";
import { stepInput, stepTitle } from "../step-labels";
import type { PiMessage } from "../core/transcript";
import type { PiRunningTool } from "../view";
import { plainKeepingCode } from "./plain";

/** How a step on a timeline stands: `stopped` is a tool the work ended before it returned. */
export type TimelineState = "running" | "done" | "failed" | "stopped";

/** A step on a timeline: a tool's title with its key result, and the raw call to open. */
export type TimelineStep = {
  readonly kind: "step";
  readonly id: string;
  readonly state: TimelineState;
  readonly title: string;
  readonly input: string;
  readonly output: string;
};

/** What the agent said between its tools: plain text on the timeline, not a step. */
export type TimelineNote = {
  readonly kind: "note";
  readonly id: string;
  readonly text: string;
};

/** One entry of a timeline, newest last. */
export type TimelineEntry = TimelineStep | TimelineNote;

const live = (task: TaskRow) => task.status === "queued" || task.status === "working";

/**
 * A task's timeline from its log. A tool still running when the task ended
 * was stopped. A logged line with no tool call is the agent's own words, a
 * note between its steps. Before its log loads, or for a task from before
 * logs, the few steps on its row, the newest running while the task works.
 */
export function taskTimeline(task: TaskRow, log: readonly TaskLogStep[] | null): TimelineEntry[] {
  const working = live(task);

  if (log === null || log.length === 0) {
    return task.steps.map((step, index) => ({
      kind: "step",
      id: `row:${step.at}:${index}`,
      state: working && index === task.steps.length - 1 ? "running" : "done",
      title: plainKeepingCode(step.text),
      input: "",
      output: ""
    }));
  }

  return log.map((step): TimelineEntry => {
    const id = String(step.seq);

    // An agent's words are markdown; a tool's title is already plain but for its `quoted` command.
    if (step.call === null) return { kind: "note", id, text: plainKeepingCode(step.text) };

    return {
      kind: "step",
      id,
      state: step.state === "running" ? (working ? "running" : "stopped") : step.state === "failed" ? "failed" : "done",
      title: step.text,
      input: step.input,
      output: step.output
    };
  });
}

/** The messages of the newest turn: from its user message on, without it. */
function newestTurn(messages: readonly PiMessage[]): readonly PiMessage[] {
  const start = messages.findLastIndex((message) => message.role === "user");

  return messages.slice(start + 1);
}

const textOf = (part: Extract<PiMessage["parts"][number], { type: "tool-result" }>) =>
  part.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("\n");

/**
 * The main agent's newest turn as a timeline: each tool it called, in order,
 * titled by what it did once its result is in. A call with no result is
 * running while the turn runs, and was stopped once it is over.
 */
export function turnTimeline({
  messages,
  live: streaming,
  running,
  tools
}: {
  messages: readonly PiMessage[];
  live: PiMessage | null;
  running: boolean;
  tools: readonly PiRunningTool[];
}): TimelineStep[] {
  const turn = [...newestTurn(messages), ...(streaming ? [streaming] : [])];

  const results = new Map(
    turn.flatMap((message) => message.parts.flatMap((part) => (part.type === "tool-result" ? [[part.id, part] as const] : [])))
  );

  return turn.flatMap((message) =>
    message.role !== "assistant"
      ? []
      : message.parts.flatMap((part): TimelineStep[] => {
          if (part.type !== "tool-call") return [];
          const args = part.arguments ?? {};
          const result = results.get(part.id);
          const input = stepInput(part.name, args);

          if (result === undefined) {
            const output = tools.find((tool) => tool.callId === part.id)?.output ?? "";

            return [{ kind: "step", id: part.id, state: running ? "running" : "stopped", title: stepTitle(part.name, args, "running"), input, output }];
          }

          const output = textOf(result);
          const ok = !result.error;

          return [
            {
              kind: "step",
              id: part.id,
              state: ok ? "done" : "failed",
              title: stepTitle(part.name, args, ok ? "done" : "failed", output),
              input,
              output: output.replace(/\n+$/, "")
            }
          ];
        })
  );
}

/** A title in pieces: plain words, and the `quoted` command or name a step shows in mono. */
export function titleParts(title: string): { readonly text: string; readonly code: boolean }[] {
  return title
    .split(/(`[^`]+`)/)
    .filter((piece) => piece !== "")
    .map((piece) => (/^`[^`]+`$/.test(piece) ? { text: piece.slice(1, -1), code: true } : { text: piece, code: false }));
}
