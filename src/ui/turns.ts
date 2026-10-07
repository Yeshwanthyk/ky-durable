import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";
import { Guard } from "typebox/guard";
import type { PiMessage, PiMessagePart } from "../transcript";
import { imageSrc } from "./pick-images";
import type { PiRunningTool } from "../view";
import type { Tool, Turn } from "./conversation";

/** Reports from subagents, machines, specialists and discussions arrive as user messages that start like this. */
const REPORT = /^\[(subagent|machine|specialist|discussion) ([^\],\s]+(?:, @[^\],\s]+)*)[^\]]*\]\s*/;

/** A tool argument shows as text only when it is a string. */
const text = (value: JsonValue | undefined) => (Guard.IsString(value) ? value : "");

const short = (value: string, max = 80) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

const firstLine = (value: string) => value.trim().split("\n")[0] ?? "";

/** Scotty's category and imperative summary for one of ky's tools. */
function describe(name: string, args: JsonObject): Pick<Tool, "category" | "summary" | "input"> {
  const path = text(args.path) || text(args.file_path) || text(args.dir);

  switch (name) {
    case "read":
      return { category: "inspect", summary: `Read ${path}`, input: "" };
    case "ls":
      return { category: "inspect", summary: `List ${path || "/workspace"}`, input: "" };
    case "find":
    case "grep":
      return {
        category: "inspect",
        summary: `Search ${short(text(args.pattern) || text(args.query) || path)}`,
        input: ""
      };
    case "write":
      return { category: "change", summary: `Write ${path}`, input: "" };
    case "edit":
      return { category: "change", summary: `Edit ${path}`, input: "" };
    case "delete":
      return { category: "change", summary: `Delete ${path}`, input: "" };
    case "exec": {
      const source = text(args.code) || text(args.command) || text(args.source);

      return { category: "run", summary: short(firstLine(source)) || "exec", input: source };
    }

    case "executor_skills":
      return {
        category: "research",
        summary: `Read ${text(args.app) || text(args.name) || "skills"}`,
        input: JSON.stringify(args, null, 2)
      };
    case "executor_execute":
    case "executor_resume":
      return {
        category: "research",
        summary: `Executor · ${short(firstLine(text(args.description) || text(args.code)) || name)}`,
        input: text(args.code) || JSON.stringify(args, null, 2)
      };
    case "subagent":
    case "machine": {
      const who = text(args.name) || text(args.machine) || text(args.task);

      const verb =
        args.action === "spawn" || args.action === "run"
          ? "Start"
          : args.action === "send"
            ? "Message"
            : args.action === "stop"
              ? "Stop"
              : "List";

      const title = text(args.title);
      const target = [who, title].filter(Boolean).join(" · ") || name;

      return {
        category: "agent",
        summary: verb === "Stop" ? `Stopped ${target}` : `${verb} ${target}`,
        input: text(args.message) || text(args.prompt)
      };
    }

    case "skill_view":
      return { category: "research", summary: `Read skill ${text(args.name)}`, input: JSON.stringify(args, null, 2) };
    case "soul_edit": {
      const action = text(args.action);

      return action === "view" || action === "history"
        ? { category: "research", summary: "Read SOUL.md", input: "" }
        : {
            category: "change",
            summary: `${action.replace(/^./, (c) => c.toUpperCase())} SOUL.md`,
            input: text(args.body) || text(args.new) || JSON.stringify(args, null, 2)
          };
    }

    case "skill_manage":
      return {
        category: "change",
        summary: `${text(args.action).replace(/^./, (c) => c.toUpperCase())} skill ${text(args.name)}`,
        input: text(args.body) || text(args.new) || JSON.stringify(args, null, 2)
      };

    default:
      if (name.startsWith("memory_")) {
        return {
          category: "other",
          summary: `${name.slice(7).replace(/^./, (c) => c.toUpperCase())} memory`,
          input: text(args.text) || text(args.query) || JSON.stringify(args, null, 2)
        };
      }

      return { category: "other", summary: name, input: JSON.stringify(args, null, 2) };
  }
}

function resultText(part: Extract<PiMessagePart, { type: "tool-result" }>): string {
  return part.content.map((content) => (content.type === "text" ? content.text : "[image]")).join("\n");
}

function userText(message: PiMessage): string {
  return message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

const iso = (time: number) => (time > 0 ? new Date(time).toISOString() : null);

/**
 * Folds ky's projected transcript into scotty's turns. A turn starts at
 * each user message and holds the assistant's text, thinking and tool calls
 * that follow, with each call's result folded into its row.
 */
export function buildTurns(
  messages: readonly PiMessage[],
  live: PiMessage | null,
  running: boolean,
  runningTools: readonly PiRunningTool[]
): Turn[] {
  const turns: Turn[] = [];
  const calls = new Map<string, Tool>();
  const started = new Map<string, number>();
  let current: Turn | undefined;

  const open = (message: PiMessage | null): Turn => {
    const raw = message ? userText(message) : "";
    const report = REPORT.exec(raw);

    const turn: Turn = {
      id: message?.id ?? `t${turns.length}`,
      state: "completed",
      user: report ? raw.slice(report[0].length) : raw,
      images: message ? message.parts.flatMap((part) => (part.type === "image" ? [imageSrc(part)] : [])) : [],
      from: report ? `${report[1]} ${report[2]}` : null,
      task: report ? (/\btask (m-[\w-]+)/.exec(report[0])?.[1] ?? null) : null,
      items: [],
      startedAt: message ? iso(message.timestamp) : null,
      endedAt: null
    };

    turns.push(turn);

    return turn;
  };

  const addAssistant = (message: PiMessage, streaming: boolean) => {
    const turn = current ?? (current = open(null));
    turn.startedAt ??= iso(message.timestamp);

    message.parts.forEach((part, index) => {
      const id = `${message.id}:${index}`;

      switch (part.type) {
        case "text":
          // Text before a tool call is commentary; the answer is text the turn ends on.
          if (part.text.trim()) {
            turn.items.push({
              kind: "text",
              id,
              text: part.text,
              final: !streaming && message.stopReason !== "toolUse"
            });
          }

          break;
        case "thinking":
          if (part.text.trim()) turn.items.push({ kind: "thinking", id, text: part.text });
          break;
        case "tool-call": {
          // The part arrives over the wire, so a missing arguments object still renders.
          const args: JsonObject = part.arguments ?? {};

          const tool: Tool = {
            kind: "tool",
            id: part.id,
            name: part.name,
            ...describe(part.name, args),
            status: "running",
            output: "",
            durationMs: null
          };

          calls.set(part.id, tool);
          started.set(part.id, message.timestamp);
          turn.items.push(tool);
          break;
        }

        default:
          break;
      }
    });

    if (message.error) {
      turn.items.push({ kind: "notice", id: `${message.id}:error`, text: message.error, tone: "error" });
    }

    if (message.stopReason === "aborted") turn.state = "aborted";
    else if (message.stopReason === "error") turn.state = "failed";
    turn.endedAt = iso(message.timestamp);
  };

  for (const message of messages) {
    switch (message.role) {
      case "user":
        current = open(message);
        break;
      case "assistant":
        addAssistant(message, false);
        break;
      case "tool":
        for (const part of message.parts) {
          if (part.type !== "tool-result") continue;
          const tool = calls.get(part.id);

          if (!tool) continue;
          tool.status = part.error ? "failed" : "done";
          tool.output = resultText(part);
          const at = started.get(part.id);
          tool.durationMs = at && message.timestamp ? message.timestamp - at : null;
        }

        if (current) current.endedAt = iso(message.timestamp);
        break;
      case "notice": {
        const note = userText(message);

        if (note) (current ?? (current = open(null))).items.push({ kind: "notice", id: message.id, text: note, tone: "info" });
        break;
      }
    }
  }

  if (live) addAssistant(live, true);

  // Calls that never got a result were cut off, unless they are running now.
  const active = new Set(runningTools.map((tool) => tool.callId));

  for (const tool of calls.values()) {
    if (tool.status !== "running") continue;

    if (running && active.has(tool.id)) {
      tool.output = runningTools.find((slot) => slot.callId === tool.id)?.output ?? "";
    } else if (!running) tool.status = "failed";
  }

  const last = turns.at(-1);

  if (last && running) {
    last.state = "streaming";
    last.endedAt = null;
  }

  return turns;
}
