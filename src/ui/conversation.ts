/** Scotty's conversation shape: turns of a prompt, a work log and an answer. */

export type Tool = {
  kind: "tool";
  id: string;
  name: string;
  category: "inspect" | "change" | "check" | "research" | "agent" | "run" | "other";
  summary: string;
  status: "running" | "done" | "failed" | "declined";
  input: string;
  output: string;
  exitCode: number | null;
  durationMs: number | null;
};

export type Item =
  | { kind: "text"; id: string; text: string; final: boolean }
  | { kind: "thinking"; id: string; text: string }
  | Tool
  | { kind: "plan"; id: string; steps: ReadonlyArray<{ step: string; status: string }> }
  | { kind: "notice"; id: string; text: string; tone: "info" | "error" };

export type Turn = {
  id: string;
  state: "completed" | "streaming" | "failed" | "aborted";
  user: string;
  /** Set when the turn was started by a subagent or machine report, not the user. */
  from: string | null;
  assistant: string;
  items: Item[];
  startedAt: string | null;
  endedAt: string | null;
};
