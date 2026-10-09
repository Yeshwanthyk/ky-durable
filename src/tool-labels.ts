import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";
import { Guard } from "typebox/guard";
import type { IconName } from "./ui/Icon";

/**
 * Tool calls in a few human words, such as "Reading tasks.ts" or "Browsing
 * github.com": for the activity pill, a task's steps, and the machine runner,
 * which labels Claude Code's tools, and Codex's as the Claude Code tool each
 * is most like, with it. No runtime imports beyond
 * typebox, so the runner can load it as it is.
 */

/** What an agent is doing, in a few words, with an icon. */
export type Activity = { readonly icon: IconName; readonly label: string };

type Args = JsonObject;

/** A tool argument as trimmed text; anything but a string reads as empty. */
const text = (value: JsonValue | undefined) => (Guard.IsString(value) ? value.trim() : "");

const short = (value: string, max = 28) =>
  value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;

const base = (path: string) => path.split("/").filter(Boolean).at(-1) ?? "";

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** Executor apps by the name a program calls them with, as `tools.<app>.<tool>`. */
const APPS: ReadonlyArray<[RegExp, Activity]> = [
  [/^exa/i, { icon: "globe", label: "Searching the web" }],
  [/mail/i, { icon: "chat", label: "Checking Gmail" }],
  [/calendar/i, { icon: "list", label: "Checking calendar" }],
  [/drive|docs|sheets/i, { icon: "file", label: "Checking Google Drive" }],
  [/github/i, { icon: "branch", label: "Checking GitHub" }],
  [/slack/i, { icon: "chat", label: "Checking Slack" }]
];

function executorApp(code: string): Activity {
  const apps = [...code.matchAll(/\btools\.([A-Za-z_$][\w$]*)\s*\./g)].flatMap((match) =>
    match[1] === undefined || match[1] === "search" ? [] : [match[1]]
  );

  const app = apps[0];

  if (app === undefined) {
    return /\btools\.search\s*\(/.test(code)
      ? { icon: "search", label: "Finding the right tool" }
      : { icon: "plug", label: "Using connected apps" };
  }

  const known = APPS.find(([pattern]) => pattern.test(app));

  return known?.[1] ?? { icon: "plug", label: `Using ${short(app.replace(/_/g, " "), 20)}` };
}

/** A file tool's label: what it does to the file, by its last path segment. */
function fileTool(icon: IconName, verb: string, noun: string, args: Args): Activity {
  const path = base(text(args.path) || text(args.file_path) || text(args.dir));

  return { icon, label: path ? `${verb} ${short(path)}` : `${verb} ${noun}` };
}

/** A subagent call's label, by its action and who it is for. */
function subagentTool(args: Args): Activity {
  const who = short(text(args.name), 20);
  const action = text(args.action);

  if (action === "stop") return { icon: "stop", label: who ? `Stopping ${who}` : "Stopping a subagent" };

  if (action === "send") return { icon: "nodes", label: who ? `Messaging ${who}` : "Messaging a subagent" };

  if (action === "status") return { icon: "nodes", label: "Checking subagents" };

  return { icon: "nodes", label: action === "spawn" && who ? `Delegating to ${who}` : "Delegating work" };
}

/** A machine call's label, by its action. */
function machineTool(args: Args): Activity {
  const title = text(args.title);

  const labels = new Map([
    ["run", title ? `Running machine task: ${short(title, 20)}` : "Starting a machine task"],
    ["send", "Messaging machine task"],
    ["list", "Checking machines"]
  ]);

  if (text(args.action) === "stop") return { icon: "stop", label: "Stopping machine task" };

  return { icon: "monitor", label: labels.get(text(args.action)) ?? "Using a machine" };
}

/** A browse call's label, by the site it opens. */
function browsing(url: string): Activity {
  const site = host(url);

  return { icon: "globe", label: site ? `Browsing ${short(site, 24)}` : "Browsing the web" };
}

/** Tools whose label depends on their arguments. */
const DESCRIBE = new Map<string, (args: Args) => Activity>([
  ["read", (args) => fileTool("file", "Reading", "a file", args)],
  ["write", (args) => fileTool("filePlus", "Writing", "a file", args)],
  ["edit", (args) => fileTool("pencil", "Editing", "a file", args)],
  ["browse", (args) => browsing(text(args.url))],
  ["executor_execute", (args) => executorApp(text(args.code))],
  ["subagent", subagentTool],
  ["machine", machineTool],
  ["skill_view", (args) => ({ icon: "list", label: args.history ? `Checking ${text(args.name)} history` : `Reading ${text(args.name)} skill` })],
  ["skill_manage", (args) => ({ icon: "pencil", label: `Updating ${text(args.name)} skill` })],
  [
    "soul_edit",
    (args) => ({
      icon: "pencil",
      label: args.action === "view" || args.action === "history" ? "Reading SOUL.md" : "Updating SOUL.md"
    })
  ]
]);

/** Tools with one fixed label. */
const FIXED = new Map<string, Activity>([
  ["ls", { icon: "list", label: "Listing files" }],
  ["find", { icon: "search", label: "Searching files" }],
  ["grep", { icon: "search", label: "Searching files" }],
  ["delete", { icon: "fileMinus", label: "Deleting a file" }],
  ["exec", { icon: "terminal", label: "Running code" }],
  ["executor_skills", { icon: "plug", label: "Checking connected apps" }],
  ["executor_resume", { icon: "plug", label: "Resuming app action" }],
  ["memory_note", { icon: "repo", label: "Saving memory" }],
  ["memory_recall", { icon: "repo", label: "Recalling memory" }],
  ["memory_zoom", { icon: "repo", label: "Recalling memory" }],
  ["memory_forget", { icon: "repo", label: "Tidying memory" }],
  ["chat_search", { icon: "search", label: "Searching chats" }]
]);


/** A Claude Code shell call: its own short description, else the command. */
function shell(args: Args): Activity {
  const what = text(args.description) || text(args.command).split("\n")[0] || "";

  return { icon: "terminal", label: what ? `Running ${short(what, 40)}` : "Running a command" };
}

const searching = (key: string) => (args: Args): Activity => {
  const pattern = text(args[key]);

  return { icon: "search", label: pattern ? `Searching for ${short(pattern, 24)}` : "Searching files" };
};

/** Claude Code's tools, as a machine task's runner reports them, and Codex's file deletes, which Claude Code has no tool for. */
const CLAUDE = new Map<string, (args: Args) => Activity>([
  ["Bash", shell],
  ["Read", (args) => fileTool("file", "Reading", "a file", args)],
  ["Write", (args) => fileTool("filePlus", "Writing", "a file", args)],
  ["Edit", (args) => fileTool("pencil", "Editing", "a file", args)],
  ["MultiEdit", (args) => fileTool("pencil", "Editing", "a file", args)],
  ["Delete", (args) => fileTool("fileMinus", "Deleting", "a file", args)],
  ["Grep", searching("pattern")],
  ["Glob", searching("pattern")],
  ["WebFetch", (args) => browsing(text(args.url))],
  ["WebSearch", (args) => ({ icon: "globe", label: text(args.query) ? `Searching the web for ${short(text(args.query), 24)}` : "Searching the web" })],
  ["Task", (args) => ({ icon: "nodes", label: text(args.description) ? `Delegating: ${short(text(args.description), 32)}` : "Delegating work" })],
  ["TodoWrite", () => ({ icon: "list", label: "Updating its plan" })]
]);

/** An MCP tool, `mcp__<server>__<tool>`, by its server. */
function mcpTool(name: string): Activity | undefined {
  const server = /^mcp__(.+?)__/.exec(name)?.[1];

  if (server === undefined) return undefined;

  return /chrome/i.test(server)
    ? { icon: "globe", label: "Using Chrome" }
    : { icon: "plug", label: `Using ${short(server.replace(/[-_]/g, " "), 20)}` };
}

/** A short, human label for one tool call; unknown tools fall back to their name. */
export function describeTool(name: string, args: Args = {}): Activity {
  const describe = DESCRIBE.get(name) ?? CLAUDE.get(name);

  return describe?.(args) ?? FIXED.get(name) ?? mcpTool(name) ?? { icon: "gear", label: short(name, 32) };
}
