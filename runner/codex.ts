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

import { parse, type Adapter, type AgentEvent } from "./agent.ts";
import { describeTool } from "../src/tool-labels.ts";

/**
 * Flags every `codex exec` takes: JSON events, run anywhere, nothing to
 * approve. Its commands get the whole environment the runner gives it,
 * KY_TASK_TOKEN and KY_TASK too, which ky-attach and ky-diff need: by default
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
const TOOLS = new Map<string, (item: any) => string[]>([
  ["command_execution", (item) => [describeTool("Bash", { command: unwrapShell(String(item.command ?? "")) }).label]],
  [
    "file_change",
    (item) => (item.changes ?? []).map((change: any) => describeTool(FILE_TOOLS.get(change.kind) ?? "Edit", { file_path: String(change.path ?? "") }).label)
  ],
  ["mcp_tool_call", (item) => [describeTool(`mcp__${item.server}__${item.tool}`, item.arguments ?? {}).label]],
  ["web_search", (item) => [describeTool("WebSearch", { query: String(item.query ?? "") }).label]],
  ["todo_list", () => [describeTool("TodoWrite").label]]
]);

/** A failed turn's error, which Codex often gives as the API's JSON error body. */
function failure(message: string): string {
  const body = parse(message);

  return body?.error?.message ? String(body.error.message) : message;
}

/**
 * A reader for one `codex exec`: the thread is the session, a started turn
 * takes the prompt in, each tool item is labelled once (when it starts, or
 * completes if it never said it started), and the turn's answer is the last
 * thing Codex said. Its `error` items are warnings, and a failed turn says
 * why in `turn.failed`, so neither is read.
 */
function reader(): (line: string) => AgentEvent[] {
  const labelled = new Set<string>();
  let said = "";

  const tools = (item: any): AgentEvent[] => {
    const labels = labelled.has(item.id) ? [] : (TOOLS.get(item.type)?.(item) ?? []);

    if (labels.length === 0) return [];
    labelled.add(item.id);

    return [{ type: "message", text: "", tools: labels }];
  };

  const answer = (item: any): AgentEvent[] => {
    said = String(item.text ?? "").trim();

    return [{ type: "message", text: said, tools: [] }];
  };

  const on = new Map<string, (event: any) => AgentEvent[]>([
    ["thread.started", (event) => [{ type: "session", session: String(event.thread_id) }]],
    ["turn.started", () => [{ type: "taken" }]],
    ["item.started", (event) => tools(event.item ?? {})],
    ["item.completed", (event) => (event.item?.type === "agent_message" ? answer(event.item) : tools(event.item ?? {}))],
    // Each process runs one turn. Its token counts have nowhere to go in a result, and on a subscription nothing says what they cost.
    ["turn.completed", () => [{ type: "result", ok: true, text: said, spent: { turns: 1 } }]],
    ["turn.failed", (event) => [{ type: "result", ok: false, text: failure(String(event.error?.message ?? "")) }]]
  ]);

  return (line) => {
    const event = parse(line);

    return on.get(event?.type)?.(event) ?? [];
  };
}

export const codex: Adapter = {
  prompt: (text) => text,
  steers: false,
  reader
};
