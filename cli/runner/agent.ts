/**
 * What the runner needs from a coding agent's CLI, whichever it is: how to
 * hand it a prompt on stdin, and what its stdout lines mean. `claude.ts`
 * and `codex.ts` each read their own CLI's JSON into these events.
 */

/** What an agent's output says, in the terms the runner reports. */
export type AgentEvent =
  /** The session it runs in: Claude Code's session id, or Codex's thread id. */
  | { type: "session"; session: string }
  /** It took a prompt in, to start a turn or to join the one running. */
  | { type: "taken" }
  /** One message: what it says, and a label for each tool it uses. */
  | { type: "message"; text: string; tools: string[] }
  /** A turn ended, with its answer, and what the process has spent so far when it says any of it. */
  | { type: "result"; ok: boolean; text: string; spent?: { turns?: number; costUsd?: number } };

export type Adapter = {
  /** What to write to its stdin to give it a prompt. */
  prompt(text: string): string;
  /** Whether a running process takes more prompts; if not, stdin closes after the first, and each turn is a process. */
  steers: boolean;
  /** A reader for one process's stdout, a line at a time. */
  reader(): (line: string) => AgentEvent[];
};

/** A line as JSON, or undefined. */
export function parse(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
