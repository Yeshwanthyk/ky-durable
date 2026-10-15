/**
 * Codex as a task's agent: `codex exec --json`, one process per turn. The
 * prompt comes on stdin, which then closes; a follow-up resumes the thread
 * by its id in a new process. `exec` takes no prompt mid-turn (its
 * app-server does, but the plan keeps one CLI interface per agent), so one
 * that comes then waits for the turn to end.
 *
 * Each item Codex works through is mapped onto the Claude Code tool it is
 * most like, so its steps read the same: a command is Bash, a file change
 * is Write, Edit or Delete, and an MCP call is `mcp__<server>__<tool>`.
 */

import Type from "typebox";
import { type Adapter, type AgentEvent, JsonObjectSchema, TextSchema } from "./agent.ts";
import { decodeOr, parseOr } from "../../src/core/decode.ts";
import { describeTool } from "../../src/tool-labels.ts";

const Loose = Type.Optional(Type.Unknown());

/** An item Codex works through, as far as the runner reads it: every field may be missing. */
const ItemSchema = Type.Object({ id: Loose, type: Loose, command: Loose, changes: Loose, server: Loose, tool: Loose, arguments: Loose, query: Loose, text: Loose });

type Item = Type.Static<typeof ItemSchema>;

/** A file change's kind and path. */
const ChangesSchema = Type.Array(Type.Object({ kind: Loose, path: Loose }));

/** A line of `codex exec --json`, as far as the runner reads it. */
const EventSchema = Type.Object({ type: Loose, thread_id: Loose, item: Loose, error: Loose });

type Event = Type.Static<typeof EventSchema>;

/** An error's message, which may be missing. */
const ErrorSchema = Type.Object({ message: Loose });

const NO_ITEM: Item = {};

const NO_ERROR: Type.Static<typeof ErrorSchema> = {};

/**
 * Flags every `codex exec` takes: JSON events, run anywhere, nothing to
 * approve. Its commands get the whole environment the runner gives it,
 * KY_TASK_TOKEN and KY_TASK too, which ky attach and ky diff need: by default
 * Codex drops every variable named like a token, key or secret. And its
 * home keeps only what a follow-up resumes from: no prompt history, no
 * plugins synced in, no memories.
 */
const FLAGS = [
  "--json",
  "--skip-git-repo-check",
  "--dangerously-bypass-approvals-and-sandbox",
  ...["shell_environment_policy.ignore_default_excludes=true", 'history.persistence="none"', "features.plugins=false", "features.memories=false"].flatMap(
    (setting) => ["-c", setting]
  )
];

/** A string as a TOML basic string, as `-c` parses its value: JSON's escapes, and DEL, which TOML also forbids raw. */
function toml(text: string): string {
  return JSON.stringify(text).replaceAll("\x7f", "\\u007f");
}

/**
 * `codex`'s arguments for a turn: a new thread, or `thread` resumed, with
 * `instructions` added to its developer prompt, which a resume does not
 * keep. The prompt is read from stdin (`-`).
 */
export function codexArgs(thread: string | null, instructions: string): string[] {
  const flags = [...FLAGS, "-c", `developer_instructions=${toml(instructions)}`];

  return thread ? ["exec", "resume", ...flags, thread, "-"] : ["exec", ...flags, "-"];
}

/**
 * A command as Codex runs it, `/bin/zsh -lc '<script>'`, as the script.
 * Its quoting is the shlex crate's: a `'` in the script is `'\''`, and a `!`
 * is `'\!'`, so no shell expands it as history.
 */
function unwrapShell(command: string): string {
  const script = /^\S*sh -lc '((?:[^']|'\\[!']')*)'$/s.exec(command)?.[1];

  return script === undefined ? command : script.replaceAll(/'\\([!'])'/g, "$1");
}

/** File change kinds, as the Claude Code tool that would make one. */
const FILE_TOOLS = new Map([
  ["add", "Write"],
  ["update", "Edit"],
  ["delete", "Delete"]
]);

/** Labels for the tools each kind of item uses; other items are not tools. */
const TOOLS = new Map<unknown, (item: Item) => string[]>([
  ["command_execution", (item) => [describeTool("Bash", { command: unwrapShell(String(decodeOr(TextSchema, item.command, ""))) }).label]],
  [
    "file_change",
    (item) => decodeOr(ChangesSchema, item.changes ?? [], []).map((change) => describeTool(FILE_TOOLS.get(String(change.kind)) ?? "Edit", { file_path: String(decodeOr(TextSchema, change.path, "")) }).label)
  ],
  ["mcp_tool_call", (item) => [describeTool(`mcp__${String(item.server)}__${String(item.tool)}`, decodeOr(JsonObjectSchema, item.arguments ?? {}, {})).label]],
  ["web_search", (item) => [describeTool("WebSearch", { query: String(decodeOr(TextSchema, item.query, "")) }).label]],
  ["todo_list", () => [describeTool("TodoWrite").label]]
]);

/** A failed turn's error, which Codex often gives as the API's JSON error body. */
function failure(message: string): string {
  const body = parseOr(Type.Object({ error: Loose }), message, undefined);
  const said = decodeOr(ErrorSchema, body?.error, NO_ERROR).message;

  return String(decodeOr(TextSchema, said, "")) || message;
}

/**
 * A reader for one `codex exec`: the thread is the session, a started turn
 * takes the prompt in, each tool item is labelled once (when it starts, or
 * completes if it never said it started), and the turn's answer is the last
 * thing Codex said. Its `error` items are warnings, and a failed turn says
 * why in `turn.failed`, so neither is read.
 */
function reader(): (line: string) => AgentEvent[] {
  const labelled = new Set<unknown>();
  let said = "";

  const tools = (item: Item): AgentEvent[] => {
    const labels = labelled.has(item.id) ? [] : (TOOLS.get(item.type)?.(item) ?? []);

    if (labels.length === 0) return [];
    labelled.add(item.id);

    return [{ type: "message", text: "", tools: labels }];
  };

  const answer = (item: Item): AgentEvent[] => {
    said = String(decodeOr(TextSchema, item.text, "")).trim();

    return [{ type: "message", text: said, tools: [] }];
  };

  const itemOf = (event: Event) => decodeOr(ItemSchema, event.item ?? NO_ITEM, NO_ITEM);

  const on = new Map<unknown, (event: Event) => AgentEvent[]>([
    ["thread.started", (event) => [{ type: "session", session: String(event.thread_id) }]],
    ["turn.started", () => [{ type: "taken" }]],
    ["item.started", (event) => tools(itemOf(event))],
    ["item.completed", (event) => (itemOf(event).type === "agent_message" ? answer(itemOf(event)) : tools(itemOf(event)))],
    // Each process runs one turn. Its token counts have nowhere to go in a result, and on a subscription nothing says what they cost.
    ["turn.completed", () => [{ type: "result", ok: true, text: said, spent: { turns: 1 } }]],
    ["turn.failed", (event) => [{ type: "result", ok: false, text: failure(String(decodeOr(TextSchema, decodeOr(ErrorSchema, event.error, NO_ERROR).message, ""))) }]]
  ]);

  return (line) => {
    const event = parseOr(EventSchema, line, undefined);

    return (event && on.get(event.type)?.(event)) ?? [];
  };
}

export const codex: Adapter = {
  prompt: (text) => text,
  steers: false,
  reader
};
