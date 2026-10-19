import type { IconName } from "./Icon";

/** Scotty's conversation shape: turns of a prompt, a work log and an answer. */

export type Tool = {
  kind: "tool";
  id: string;
  name: string;
  category: "inspect" | "change" | "research" | "agent" | "run" | "other";
  summary: string;
  status: "running" | "done" | "failed";
  input: string;
  output: string;
  /** Images the tool returned, such as a browser screenshot, as data URLs. */
  images: string[];
  durationMs: number | null;
};

export type Item =
  | { kind: "text"; id: string; text: string; final: boolean }
  | { kind: "thinking"; id: string; text: string }
  | Tool
  | { kind: "notice"; id: string; text: string; tone: "info" | "error" }
  /** A specialist's own reply to the user's message, posted in the chat. */
  | { kind: "specialist"; id: string; from: string; text: string; failed: boolean };

/** Who a report is from, as its quiet line says it: "Ran routine · Daily weather". */
export type ReportFrom = { readonly verb: string; readonly icon: IconName; readonly name: string };

export type Turn = {
  id: string;
  state: "completed" | "streaming" | "failed" | "aborted";
  user: string;
  /** Images the user sent with the prompt, as data URLs. */
  images: string[];
  /** Set when the turn was started by a report (a subagent, machine, automation, peer…), not the user. */
  from: ReportFrom | null;
  /** The machine task a report is from; its files show under the report. */
  task: string | null;
  /** The specialists the user's message went to, @'d or routed in a group chat; empty when it went to ky. */
  to: readonly string[];
  items: Item[];
  startedAt: string | null;
  endedAt: string | null;
};
