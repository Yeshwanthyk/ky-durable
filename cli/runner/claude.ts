/**
 * Claude Code as a task's agent: `claude -p` with stream-json on both ends,
 * one process for a whole session of turns. A prompt written while a turn
 * runs joins that turn, and Claude Code echoes each prompt it takes in.
 */

import Type from "typebox";
import { Guard } from "typebox/guard";
import { type Adapter, type AgentEvent, JsonObjectSchema, TextSchema } from "./agent.ts";
import { decodeOr, parseOr } from "../../src/core/decode.ts";
import { AGENT_EFFORTS, type AgentModel } from "../../src/machines/contract.ts";

type Options = { permissionMode: string; systemPrompt: string; chrome: boolean; session: string | null; model?: AgentModel | undefined };

/** The flags that pin `model`, and its effort when Claude Code takes it; none leaves Claude Code's own. */
function modelFlags(model: AgentModel | undefined): string[] {
  if (!model) return [];
  const effort = model.effort !== null && AGENT_EFFORTS.claude.includes(model.effort) ? ["--effort", model.effort] : [];

  return ["--model", model.id, ...effort];
}

/** `claude`'s arguments for a task, resuming `session` when it is set. */
export function claudeArgs({ permissionMode, systemPrompt, chrome, session, model }: Options): string[] {
  return [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    // Echo each message as Claude Code takes it in; the runner counts them to know what a result answers.
    "--replay-user-messages",
    "--permission-mode", permissionMode,
    "--append-system-prompt", systemPrompt,
    ...(chrome ? ["--chrome"] : []),
    ...modelFlags(model),
    ...(session ? ["--resume", session] : [])
  ];
}

/** One part of an assistant message: text, or a tool it uses. */
const PartSchema = Type.Object({
  type: Type.Optional(Type.Unknown()),
  id: Type.Optional(Type.Unknown()),
  name: Type.Optional(Type.Unknown()),
  input: Type.Optional(Type.Unknown()),
  text: Type.Optional(Type.Unknown()),
  tool_use_id: Type.Optional(Type.Unknown()),
  content: Type.Optional(Type.Unknown()),
  is_error: Type.Optional(Type.Unknown())
});

type Part = Type.Static<typeof PartSchema>;

/** A tool result's content: its text, or its parts, of which the text ones are read. */
const ResultContentSchema = Type.Union([Type.String(), Type.Array(Type.Object({ type: Type.Optional(Type.Unknown()), text: Type.Optional(Type.Unknown()) }))]);

/** An assistant message's content, as far as the runner reads it; a message that isn't one says nothing. */
const MessageSchema = Type.Object({ content: Type.Array(PartSchema) });


/** A line of `claude`'s stream-json, as far as the runner reads it: every field may be missing. */
const LineSchema = Type.Object({
  type: Type.Optional(Type.Unknown()),
  session_id: Type.Optional(Type.Unknown()),
  isReplay: Type.Optional(Type.Unknown()),
  message: Type.Optional(Type.Unknown()),
  is_error: Type.Optional(Type.Unknown()),
  result: Type.Optional(Type.Unknown()),
  num_turns: Type.Optional(Type.Unknown()),
  total_cost_usd: Type.Optional(Type.Unknown())
});

type Line = Type.Static<typeof LineSchema>;

const partsOf = (event: Line) => decodeOr(MessageSchema, event.message, { content: [] }).content;

/** An assistant message: each tool it uses, and what it says as one line. */
function messageOf(event: Line): AgentEvent {
  const parts = partsOf(event);

  return {
    type: "message",
    tools: parts.flatMap((part) =>
      part.type === "tool_use"
        ? [{ id: Guard.IsString(part.id) ? part.id : undefined, name: String(part.name), args: decodeOr(JsonObjectSchema, part.input, {}) }]
        : []
    ),
    text: parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join(" ")
      .trim()
  };
}

/** A tool result's text. */
function resultText(part: Part): string {
  const content = decodeOr(ResultContentSchema, part.content ?? "", "");

  return Guard.IsString(content) ? content : content.flatMap((each) => (each.type === "text" ? [String(each.text)] : [])).join("\n");
}

/** A user message that carries tool results: each tool it answers is done. */
function resultsOf(event: Line): AgentEvent[] {
  return partsOf(event).flatMap((part) =>
    part.type === "tool_result" && Guard.IsString(part.tool_use_id)
      ? [{ type: "tool-end", id: part.tool_use_id, ok: part.is_error !== true, output: resultText(part) } as const]
      : []
  );
}

/** A count Claude Code reported, if it is one. */
const counted = (value: number) => (Number.isFinite(value) ? value : undefined);

/** What the process has spent: its counters run for the whole process, so the latest result holds the total. */
function spentBy(result: Line): { turns?: number; costUsd?: number } | undefined {
  const turns = counted(Number(result.num_turns));
  const costUsd = counted(Number(result.total_cost_usd));

  return turns === undefined && costUsd === undefined ? undefined : { turns, costUsd };
}

function read(line: string): AgentEvent[] {
  const event = parseOr(LineSchema, line, undefined);

  if (!event) return [];

  return [
    ...(event.session_id ? [{ type: "session", session: String(decodeOr(TextSchema, event.session_id, "")) } as const] : []),
    // With --replay-user-messages, Claude Code echoes each message it takes in, whether it starts a turn or joins one.
    ...(event.type === "user" && event.isReplay === true ? [{ type: "taken" } as const] : []),
    ...(event.type === "user" && event.isReplay !== true ? resultsOf(event) : []),
    ...(event.type === "assistant" ? [messageOf(event)] : []),
    ...(event.type === "result"
      ? [
          {
            type: "result",
            ok: !event.is_error,
            text: String(decodeOr(TextSchema, event.result, "")),
            spent: spentBy(event)
          } as const
        ]
      : [])
  ];
}

export const claude: Adapter = {
  prompt: (text) => `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`,
  steers: true,
  reader: () => read
};
