import type { PiMessage } from "../transcript";
import type { PiRunningTool } from "../view";
import type { IconName } from "./Icon";

/** What the agent is doing right now, in a few words, for the activity island. */
export type Activity = { readonly icon: IconName; readonly label: string };

type Args = Record<string, unknown>;

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

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
  const apps = [...code.matchAll(/\btools\.([A-Za-z_$][\w$]*)\s*\./g)]
    .map((match) => match[1] ?? "")
    .filter((app) => app !== "search");
  const app = apps[0];

  if (app === undefined) {
    return /\btools\.search\s*\(/.test(code)
      ? { icon: "search", label: "Finding the right tool" }
      : { icon: "plug", label: "Using connected apps" };
  }

  const known = APPS.find(([pattern]) => pattern.test(app));

  return known?.[1] ?? { icon: "plug", label: `Using ${short(app.replace(/_/g, " "), 20)}` };
}

/** A short, human label for one tool call; unknown tools fall back to their name. */
export function describeTool(name: string, args: Args = {}): Activity {
  const path = base(text(args.path) || text(args.file_path) || text(args.dir));

  switch (name) {
    case "read":
      return { icon: "file", label: path ? `Reading ${short(path)}` : "Reading a file" };
    case "ls":
      return { icon: "list", label: "Listing files" };
    case "find":
    case "grep":
      return { icon: "search", label: "Searching files" };
    case "write":
      return { icon: "filePlus", label: path ? `Writing ${short(path)}` : "Writing a file" };
    case "edit":
      return { icon: "pencil", label: path ? `Editing ${short(path)}` : "Editing a file" };
    case "delete":
      return { icon: "fileMinus", label: "Deleting a file" };
    case "exec":
      return { icon: "terminal", label: "Running code" };
    case "browse": {
      const site = host(text(args.url));

      return { icon: "globe", label: site ? `Browsing ${short(site, 24)}` : "Browsing the web" };
    }

    case "executor_skills":
      return { icon: "plug", label: "Checking connected apps" };
    case "executor_execute":
      return executorApp(text(args.code));
    case "executor_resume":
      return { icon: "plug", label: "Resuming app action" };
    case "subagent": {
      const who = short(text(args.name), 20);

      switch (args.action) {
        case "spawn":
          return { icon: "nodes", label: who ? `Delegating to ${who}` : "Delegating work" };
        case "send":
          return { icon: "nodes", label: who ? `Messaging ${who}` : "Messaging a subagent" };
        case "stop":
          return { icon: "stop", label: who ? `Stopping ${who}` : "Stopping a subagent" };
        case "status":
          return { icon: "nodes", label: "Checking subagents" };
        default:
          return { icon: "nodes", label: "Delegating work" };
      }
    }

    case "machine": {
      const title = text(args.title);

      switch (args.action) {
        case "run":
          return { icon: "monitor", label: title ? `Running machine task: ${short(title, 20)}` : "Starting a machine task" };
        case "send":
          return { icon: "monitor", label: "Messaging machine task" };
        case "stop":
          return { icon: "stop", label: "Stopping machine task" };
        case "list":
          return { icon: "monitor", label: "Checking machines" };
        default:
          return { icon: "monitor", label: "Using a machine" };
      }
    }

    case "memory_note":
    case "memory_nap":
      return { icon: "repo", label: "Saving memory" };
    case "memory_recall":
    case "memory_zoom":
      return { icon: "repo", label: "Recalling memory" };
    case "memory_forget":
      return { icon: "repo", label: "Tidying memory" };
    default:
      return { icon: "gear", label: short(name, 32) };
  }
}

const argsOf = (value: unknown): Args =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Args) : {};

/** The arguments of a call, from the newest messages that could hold it. */
function findArgs(messages: readonly PiMessage[], callId: string): Args {
  for (let index = messages.length - 1; index >= 0 && index >= messages.length - 8; index--) {
    for (const part of messages[index]?.parts ?? []) {
      if (part.type === "tool-call" && part.id === callId) return argsOf(part.arguments);
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

  if (part?.type === "tool-call") return describeTool(part.name, argsOf(part.arguments));

  if (part?.type === "text") return { icon: "chat", label: "Writing reply" };

  if (part?.type === "thinking") return THINKING;

  const tool = tools.at(-1);

  if (tool) return describeTool(tool.name, findArgs(messages, tool.callId));

  return THINKING;
}
