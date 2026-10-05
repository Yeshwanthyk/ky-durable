import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";
import { Guard } from "typebox/guard";
import type { PiMessage } from "../transcript";
import type { PiRunningTool } from "../view";
import type { IconName } from "./Icon";

/** What the agent is doing right now, in a few words, for the activity island. */
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

const THINKING: Activity = { icon: "thought", label: "Thinking…" };

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
  ["machine", machineTool]
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
  ["memory_nap", { icon: "repo", label: "Saving memory" }],
  ["memory_recall", { icon: "repo", label: "Recalling memory" }],
  ["memory_zoom", { icon: "repo", label: "Recalling memory" }],
  ["memory_forget", { icon: "repo", label: "Tidying memory" }]
]);

/** A short, human label for one tool call; unknown tools fall back to their name. */
export function describeTool(name: string, args: Args = {}): Activity {
  return DESCRIBE.get(name)?.(args) ?? FIXED.get(name) ?? { icon: "gear", label: short(name, 32) };
}

/** The arguments of a call, from the newest messages that could hold it. */
function findArgs(messages: readonly PiMessage[], callId: string): Args {
  for (let index = messages.length - 1; index >= 0 && index >= messages.length - 8; index--) {
    for (const part of messages[index]?.parts ?? []) {
      if (part.type === "tool-call" && part.id === callId) return part.arguments;
    }
  }

  return {};
}

/**
 * What the agent is doing, from the same live state the thread renders: the
 * message it is streaming, then the tools running now. Null when it is idle.
 */
export function currentActivity({
  running,
  live,
  tools,
  messages,
  retrying = false
}: {
  running: boolean;
  live: PiMessage | null;
  tools: readonly PiRunningTool[];
  messages: readonly PiMessage[];
  retrying?: boolean;
}): Activity | null {
  if (!running) return null;

  if (retrying) return { icon: "refresh", label: "Retrying…" };

  // The newest part of the streaming message is what it is doing this moment.
  const part = live?.parts.findLast(
    (each) => each.type === "tool-call" || ((each.type === "text" || each.type === "thinking") && each.text.trim() !== "")
  );

  if (part?.type === "tool-call") return describeTool(part.name, part.arguments);

  if (part?.type === "text") return { icon: "chat", label: "Writing reply" };

  if (part?.type === "thinking") return THINKING;

  const tool = tools.at(-1);

  if (tool) return describeTool(tool.name, findArgs(messages, tool.callId));

  return THINKING;
}
