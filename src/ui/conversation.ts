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
  | { kind: "notice"; id: string; text: string; tone: "info" | "error" };

export type Turn = {
  id: string;
  state: "completed" | "streaming" | "failed" | "aborted";
  user: string;
  /** Images the user sent with the prompt, as data URLs. */
  images: string[];
  /** Set when the turn was started by a subagent or machine report, not the user. */
  from: string | null;
  /** The machine task a report is from; its files show under the report. */
  task: string | null;
  items: Item[];
  startedAt: string | null;
  endedAt: string | null;
};
