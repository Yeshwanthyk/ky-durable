/**
 * Claude Code as a task's agent: `claude -p` with stream-json on both ends,
 * one process for a whole session of turns. A prompt written while a turn
 * runs joins that turn, and Claude Code echoes each prompt it takes in.
 */

import Type from "typebox";
import { type Adapter, type AgentEvent, JsonObjectSchema, TextSchema } from "./agent.ts";
import { decodeOr, parseOr } from "../../src/core/decode.ts";
import { describeTool } from "../../src/tool-labels.ts";

type Options = { permissionMode: string; systemPrompt: string; chrome: boolean; session: string | null };

/** `claude`'s arguments for a task, resuming `session` when it is set. */
export function claudeArgs({ permissionMode, systemPrompt, chrome, session }: Options): string[] {
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
    ...(session ? ["--resume", session] : [])
  ];
}

/** One part of an assistant message: text, or a tool it uses. */
const PartSchema = Type.Object({ type: Type.Optional(Type.Unknown()), name: Type.Optional(Type.Unknown()), input: Type.Optional(Type.Unknown()), text: Type.Optional(Type.Unknown()) });

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

/** An assistant message: each tool it uses, labelled, and what it says as one line. */
function messageOf(event: Line): AgentEvent {
  const parts = decodeOr(MessageSchema, event.message, { content: [] }).content;

  return {
    type: "message",
    tools: parts.flatMap((part) => (part.type === "tool_use" ? [describeTool(String(part.name), decodeOr(JsonObjectSchema, part.input, {})).label] : [])),
    text: parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join(" ")
      .trim()
  };
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
