/**
 * What the runner needs from a coding agent's CLI, whichever it is: how to
 * hand it a prompt on stdin, and what its stdout lines mean. `claude.ts`
 * and `codex.ts` each read their own CLI's JSON into these events.
 */
import type { JsonObject } from "@earendil-works/pi-ai";
import Type from "typebox";

/** What an agent's output says, in the terms the runner reports. */
export type AgentEvent =
  /** The session it runs in: Claude Code's session id, or Codex's thread id. */
  | { type: "session"; session: string }
  /** It took a prompt in, to start a turn or to join the one running. */
  | { type: "taken" }
  /** One message: what it says, and each tool it uses. */
  | { type: "message"; text: string; tools: ToolUse[] }
  /** A tool it used is done, with what it returned. */
  | { type: "tool-end"; id: string; ok: boolean; output: string }
  /** A turn ended, with its answer, and what the process has spent so far when it says any of it. */
  | { type: "result"; ok: boolean; text: string; spent?: { turns?: number; costUsd?: number } };

/** A tool call, by the Claude Code tool it is or is most like; `id` pairs it with its end. */
export type ToolUse = { id?: string; name: string; args: JsonObject };

export type Adapter = {
  /** What to write to its stdin to give it a prompt. */
  prompt(text: string): string;
  /** Whether a running process takes more prompts; if not, stdin closes after the first, and each turn is a process. */
  steers: boolean;
  /** A reader for one process's stdout, a line at a time. */
  reader(): (line: string) => AgentEvent[];
};

/** A JSON object an agent's output carries, such as a tool's input: what was parsed from JSON is JSON. */
export const JsonObjectSchema = Type.Unsafe<JsonObject>(Type.Record(Type.String(), Type.Unknown()));

/** A field an agent writes as text, which may come as a number or boolean. */
export const TextSchema = Type.Union([Type.String(), Type.Number(), Type.Boolean()]);
