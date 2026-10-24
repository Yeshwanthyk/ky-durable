import type { Workspace } from "@cloudflare/computer";
import { type JsonValue, Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  type Extension,
  hook,
  type ToolDiagnostic,
  type ToolExecutionResult,
  type ToolHookCall,
  ToolTask
} from "@earendil-works/pi-durable";
import { Guard } from "typebox/guard";
import { decodeOr, parseOr } from "./core/decode";

/**
 * Two guards on the model's tool calls, for every tool, in one place:
 *
 * - **Loop guard** (`beforeTool`): the fifth call of one tool with the same arguments in one run is blocked when the
 *   four before it answered alike, and the block tells the model to change approach. A run is the entries after the
 *   conversation's latest user (or reset) entry, so a new message starts the count over. The count is read from the
 *   committed entries, never from memory: a call's own entry is committed before its `beforeTool` runs, so an eviction,
 *   restart or replay reads the same entries and reaches the same answer. A repeat counts only when it changed nothing:
 *   a call whose answer differs from the one before it (a poll that saw progress) starts the streak over, and a blocked
 *   call is skipped, so the sixth stays blocked too.
 * - **Spill** (`afterTool`): a result whose text is over SPILL_CHARS is written whole to a workspace file,
 *   `.tool-results/<call id>.txt`, and the model gets its start and end, the path, and a line saying to `read` it for
 *   the rest. The path is the call's, so a replayed call writes the same file again. Tools whose output is already a
 *   file, the workspace's own, are left alone: `read` of a spilled file would only spill again.
 *
 * Nested calls (code mode's `executeTool`) are left alone by both: their output is a program's value, not the model's.
 */

/**
 * A result's text over this many characters goes to a file: about 4k tokens, a long article whole. Just over the 16,000
 * that subagent and chats `last` cut an answer to, with their note: an answer a tool bounded already stays whole.
 */
export const SPILL_CHARS = 16_500;

/** How much of a spilled result the model still sees: its start, and its end, where a page's last lines or a log's error are. */
export const PREVIEW_HEAD = 6_000;

export const PREVIEW_TAIL = 1_500;

/** The identical calls a run may make before the next is blocked. */
export const LOOP_LIMIT = 4;

/**
 * `read`'s byte cap, for the workspace tools. Its own default is 256 KiB, which pi then cuts to 50 KiB from the head,
 * dropping the envelope's `nextOffset` with the tail; under 25 KiB the envelope stays whole even when JSON escaping
 * doubles it, so a spilled file reads back page by page.
 */
export const READ_MAX_BYTES = 24 * 1024;

/** Where spilled results go, inside the workspace; hidden, so a site never publishes it. */
const SPILL_DIR = "/workspace/.tool-results";

/** A spilled call's file. */
export function spillPath(callId: string): string {
  return `${SPILL_DIR}/${callId.replace(/[^\w-]/g, "_")}.txt`;
}

type Guardrails = {
  readonly sql: SqlStorage;
  readonly workspace: Workspace;
  /** Tools whose results are never spilled: the workspace's own, which page through files already. */
  readonly unspilled: ReadonlySet<string>;
};

export function guardrailsExtension({ sql, workspace, unspilled }: Guardrails): Extension {
  return defineExtension({
    name: "guardrails",
    hooks: [
      hook(ToolTask, {
        beforeTool(call, api) {
          if (call.parent !== undefined) return undefined;
          const count = repeats(sql, api.conversationId, call);

          return count < LOOP_LIMIT ? undefined : { block: loopMessage(call.name, count) };
        },
        async afterTool(call, result) {
          if (call.parent !== undefined || unspilled.has(call.name)) return undefined;

          return spill(workspace, call.id, result);
        }
      })
    ]
  });
}

/** What the model reads when a call is blocked; pi puts "Tool call blocked: " in front. */
function loopMessage(name: string, count: number): string {
  return `${name} was already called ${count} times in this turn with these same arguments, and it gave the same answer each time. Calling it again will not change that: change approach (other arguments, another tool), or answer with what you have.`;
}

const RUN_START = `SELECT coalesce(max(id), 0) AS id FROM pi_entries
  WHERE conversation_id = ?1 AND id < ?2 AND json_extract(record, '$.kind') IN ('pi.user', 'pi.reset')`;

/** The assistant entry holding a call, searched from `from` on. */
const CALL_ENTRY = `SELECT max(e.id) AS id FROM pi_entries AS e, json_each(e.record, '$.model[0].content') AS c
  WHERE e.conversation_id = ?1 AND e.id > ?2 AND json_extract(e.record, '$.kind') = 'pi.assistant'
    AND json_extract(c.value, '$.type') = 'toolCall' AND json_extract(c.value, '$.id') = ?3`;

/** The run's calls of one tool, in the order the model made them. */
const RUN_CALLS = `SELECT json_extract(c.value, '$.id') AS id, json_extract(c.value, '$.arguments') AS args
  FROM pi_entries AS e, json_each(e.record, '$.model[0].content') AS c
  WHERE e.conversation_id = ?1 AND e.id > ?2 AND e.id <= ?3 AND json_extract(e.record, '$.kind') = 'pi.assistant'
    AND json_extract(c.value, '$.type') = 'toolCall' AND json_extract(c.value, '$.name') = ?4
  ORDER BY e.id, c.key`;

/** The run's results of one tool. */
const RUN_RESULTS = `SELECT json_extract(record, '$.model[0].toolCallId') AS id, json_extract(record, '$.model[0].content') AS content,
    json_extract(record, '$.data.diagnostics') AS diagnostics
  FROM pi_entries
  WHERE conversation_id = ?1 AND id > ?2 AND json_extract(record, '$.kind') = 'pi.tool-result'
    AND json_extract(record, '$.model[0].toolName') = ?3`;

type Settled = { readonly content: string; readonly blocked: boolean };

const Json = Type.Unsafe<JsonValue>(Type.Any());

const IdRow = Type.Object({ id: Type.Union([Type.Number(), Type.Null()]) });

const CallRow = Type.Object({ id: Type.String(), args: Type.Union([Type.String(), Type.Null()]) });

const ResultRow = Type.Object({ id: Type.String(), content: Type.String(), diagnostics: Type.Union([Type.String(), Type.Null()]) });

const Codes = Type.Array(Type.Object({ code: Type.Optional(Type.String()) }));

/** One id a query answers; null when its row is damaged or it found none. */
const idOf = (sql: SqlStorage, query: string, ...bindings: Array<number | string>): number | null => decodeOr(IdRow, sql.exec(query, ...bindings).one(), { id: null }).id;

/**
 * How many calls before `call` in its run named the same tool with the same arguments and answered as the last of them
 * did, not counting blocked ones: the loop guard blocks at LOOP_LIMIT. A call still running (one of the same round)
 * counts. Read only from committed entries, so it is the same before and after an eviction; a call whose entry is
 * not found counts 0.
 */
export function repeats(sql: SqlStorage, conversation: number, call: Pick<ToolHookCall, "id" | "name" | "arguments">): number {
  const run = runOf(sql, conversation, call.id);

  if (run === undefined) return 0;

  const earlier = sameCalls(sql, conversation, run, call);

  return earlier.length < LOOP_LIMIT ? 0 : streak(earlier, settled(sql, conversation, run.start, call.name));
}

type Run = { readonly start: number; readonly entry: number };

/** Where the run holding the call `callId` starts, and the entry the call is in; undefined when it is not found. */
function runOf(sql: SqlStorage, conversation: number, callId: string): Run | undefined {
  const latestUser = idOf(sql, RUN_START, conversation, Number.MAX_SAFE_INTEGER) ?? 0;
  // Nearly always in the run the latest user entry opens; a message that came in after the call means a search back.
  const entry = idOf(sql, CALL_ENTRY, conversation, latestUser, callId) ?? idOf(sql, CALL_ENTRY, conversation, 0, callId);

  return entry === null ? undefined : { start: idOf(sql, RUN_START, conversation, entry) ?? 0, entry };
}

/** The ids of the run's calls before `call` that named its tool with its arguments, in order. */
function sameCalls(sql: SqlStorage, conversation: number, run: Run, call: Pick<ToolHookCall, "id" | "name" | "arguments">): string[] {
  const same = canonical(call.arguments);
  const earlier: string[] = [];

  for (const raw of sql.exec(RUN_CALLS, conversation, run.start, run.entry, call.name)) {
    const row = decodeOr(CallRow, raw, undefined);

    if (row?.id === call.id) break;

    if (row !== undefined && canonical(parseOr(Json, row.args ?? "{}", {})) === same) earlier.push(row.id);
  }

  return earlier;
}

/** What each of the run's calls of the tool `name` answered, by call id. */
function settled(sql: SqlStorage, conversation: number, start: number, name: string): Map<string, Settled> {
  const results = new Map<string, Settled>();

  for (const raw of sql.exec(RUN_RESULTS, conversation, start, name)) {
    const row = decodeOr(ResultRow, raw, undefined);

    if (row === undefined) continue;

    const blocked = parseOr(Codes, row.diagnostics ?? "[]", []).some((diagnostic) => diagnostic.code === "blocked");
    // The spill path is the call's own, so two equal answers differ in it: it is left out of the comparison.
    results.set(row.id, { content: row.content.replaceAll(spillPath(row.id), ""), blocked });
  }

  return results;
}

/** How many of `earlier`, counted back from the last, answered as the last did; blocked ones are skipped, running ones count. */
function streak(earlier: readonly string[], results: ReadonlyMap<string, Settled>): number {
  let answer: string | undefined;
  let count = 0;

  for (const previous of earlier.toReversed()) {
    const result = results.get(previous);

    if (result?.blocked === true) continue;

    answer ??= result?.content;

    if (result !== undefined && result.content !== answer) break;

    count++;
  }

  return count;
}

/** JSON with every object's keys sorted, so arguments the model wrote in another order still compare equal. */
export function canonical(value: JsonValue): string {
  return JSON.stringify(sorted(value));
}

const isList = (value: JsonValue): value is readonly JsonValue[] => Array.isArray(value);

function sorted(value: JsonValue): JsonValue {
  if (isList(value)) return value.map(sorted);

  if (value === null || !Guard.IsObject(value)) return value;

  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, sorted(item)])
  );
}

/** `result` with its text in a file and a preview in its place, when the text is over SPILL_CHARS; otherwise undefined. */
async function spill(workspace: Workspace, callId: string, result: ToolExecutionResult): Promise<ToolExecutionResult | undefined> {
  const output = result.output ?? [];
  const text = output.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

  if (text.length <= SPILL_CHARS) return undefined;
  const path = spillPath(callId);
  const file = lined(text);

  try {
    await workspace.fs.mkdir(SPILL_DIR, { recursive: true });
    await workspace.fs.writeFile(path, file);
  } catch (error) {
    // Without the file the model keeps the whole result, which pi bounds as it would any other.
    console.warn(`guardrails: could not write ${path}`, error);

    return undefined;
  }

  const lines = file.split("\n").length;

  const notice: ToolDiagnostic = {
    severity: "info",
    code: "spilled",
    message: `This result was ${file.length} characters (${lines} lines), so only its start and end are shown. The whole text is in ${path}: read it with \`read\` (offset and limit page by line) or search it with \`grep\`.`
  };

  return {
    ...result,
    output: [{ type: "text", text: preview(file, path) }, ...output.filter((part) => part.type !== "text")],
    diagnostics: [...(result.diagnostics ?? []), notice]
  };
}

/**
 * The text a spilled file holds: a result that is one JSON object or array, as an API's often is, indented, so `read`
 * pages it by line instead of meeting one line over its byte cap; any other text as it is.
 */
function lined(text: string): string {
  const value = /^\s*[[{]/.test(text) ? parseOr(Json, text, undefined) : undefined;

  return value === undefined ? text : JSON.stringify(value, null, 2);
}

/** The start and end of `text`, cut at line ends where one is near, with what was left out and where it is between them. */
export function preview(text: string, path: string): string {
  const headCut = text.lastIndexOf("\n", PREVIEW_HEAD);
  const head = text.slice(0, headCut > PREVIEW_HEAD / 2 ? headCut : PREVIEW_HEAD);
  const tailCut = text.indexOf("\n", text.length - PREVIEW_TAIL);
  const tailStart = tailCut !== -1 && tailCut < text.length - PREVIEW_TAIL / 2 ? tailCut + 1 : text.length - PREVIEW_TAIL;
  const tail = text.slice(tailStart);
  const from = head.split("\n").length;
  const to = text.slice(0, tailStart).split("\n").length;

  return `${head}\n\n[… ${tailStart - head.length} characters, lines ${from + 1}–${to - 1}, left out: read ${path} for them …]\n\n${tail}`;
}
