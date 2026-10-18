import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";
import { Guard } from "typebox/guard";
import type { PiMessage, PiMessagePart } from "../transcript";
import { imageSrc } from "./pick-images";
import type { PiRunningTool } from "../view";
import type { Item, Tool, Turn } from "./conversation";

/** Reports from subagents, machines, specialists, discussions and check-ins arrive as user messages that start like this. */
const REPORT = /^\[(subagent|machine|specialist|discussion|check-in) ("[^"]*"|[^\],\s]+(?:, @[^\],\s]+)*)[^\]]*\]\s*/;

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

/**
 * A string per part, kept, so building the turns again yields the very same
 * strings: comparing those is instant, where a fresh copy of a long output or
 * an image's base64 would be compared character by character.
 */
function keptPer<Part extends object>(make: (part: Part) => string): (part: Part) => string {
  const kept = new WeakMap<Part, string>();

  return (part) => {
    const known = kept.get(part);

    if (known !== undefined) return known;
    const made = make(part);
    kept.set(part, made);

    return made;
  };
}

const resultText = keptPer((part: Extract<PiMessagePart, { type: "tool-result" }>) =>
  part.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("\n")
);

const keptImageSrc = keptPer(imageSrc);

/** A value a turn or one of its items holds. */
type Field = string | number | boolean | null | readonly string[];

const sameField = (a: Field, b: Field) =>
  a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((each, index) => each === b[index]));

/** Whether two records of fields hold the same values under the same keys. */
function sameFields<Value extends { readonly [Key in keyof Value]: Field }>(a: Value, b: Value): boolean {
  // SAFETY: Object.keys lists the record's own keys, each a key of Value.
  const keys = Object.keys(a) as (keyof Value)[];

  return keys.length === Object.keys(b).length && keys.every((key) => sameField(a[key], b[key]));
}

function sameTurn({ items, ...turn }: Turn, { items: otherItems, ...other }: Turn): boolean {
  return sameFields(turn, other) && items.length === otherItems.length && items.every((item, index) => sameFields<Item>(item, otherItems[index]!));
}

/** The turns the last build returned, by id. */
let previous = new Map<string, Turn>();

/**
 * Each turn as the last build returned it when nothing in it changed, so a
 * memoised turn view skips it: while a reply streams, only the last turn is new.
 */
function keepUnchanged(turns: Turn[]): Turn[] {
  const kept = turns.map((turn) => {
    const before = previous.get(turn.id);

    return before !== undefined && sameTurn(before, turn) ? before : turn;
  });

  previous = new Map(kept.map((turn) => [turn.id, turn]));

  return kept;
}

function userText(message: PiMessage): string {
  return message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** What the user wrote in this chat, oldest first: their own words, without reports or image-only messages. */
export function sentTexts(messages: readonly PiMessage[]): string[] {
  return messages.flatMap((message) => {
    const text = message.role === "user" ? userText(message) : "";

    return text.trim() === "" || REPORT.test(text) ? [] : [text];
  });
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
      images: message ? message.parts.flatMap((part) => (part.type === "image" ? [keptImageSrc(part)] : [])) : [],
      from: report ? `${report[1]} ${report[2]}` : null,
      task: report ? (/\btask (m-[\w-]+)/.exec(report[0])?.[1] ?? null) : null,
      to: message?.to ?? [],
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
            images: [],
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
        // A post starts no turn, so it is one of its own, and what a run going on writes after it opens another.
        if (message.posted) {
          current = open(null);
          current.id = message.id;
        }

        addAssistant(message, false);

        if (message.posted) current = undefined;
        break;
      case "tool":
        for (const part of message.parts) {
          if (part.type !== "tool-result") continue;
          const tool = calls.get(part.id);

          if (!tool) continue;
          tool.status = part.error ? "failed" : "done";
          tool.output = resultText(part);
          tool.images = part.content.flatMap((content) => (content.type === "image" ? [keptImageSrc(content)] : []));
          const at = started.get(part.id);
          tool.durationMs = at && message.timestamp ? message.timestamp - at : null;
        }

        if (current) current.endedAt = iso(message.timestamp);
        break;
      case "specialist":
        (current ?? (current = open(null))).items.push({
          kind: "specialist",
          id: message.id,
          from: message.from ?? "specialist",
          text: userText(message),
          failed: message.error !== undefined
        });
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

  return keepUnchanged(turns);
}
