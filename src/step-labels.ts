import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Guard } from "typebox/guard";
import { parseOr } from "./core/decode.ts";
import { describeTool } from "./tool-labels.ts";

/**
 * A tool call as a step on a task's timeline: a one-line title in plain
 * words with the key result ("Searched for TaskFeed — 3 matches"), a dim
 * line or two of what came back, and the raw input and output to open.
 * Deterministic and cheap, from the tool's name, arguments and output; the
 * machine runner loads it as it is, so it imports nothing but typebox, the
 * decoder and tool-labels.
 */

export type StepState = "running" | "done" | "failed";

/** What a step says when its tool starts. */
export type StepStart = { readonly text: string; readonly input: string };

/** What a step says once its tool is done. */
export type StepEnd = { readonly text: string; readonly detail: string; readonly output: string; readonly state: Exclude<StepState, "running"> };

/** How much of a step's raw input and output is kept to open. */
const INPUT_CHARS = 2000;

const OUTPUT_CHARS = 4000;

const DETAIL_CHARS = 160;

const COMMAND_CHARS = 48;

const text = (value: JsonValue | undefined) => (Guard.IsString(value) ? value.trim() : "");

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value);

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

const lines = (output: string) =>
  output
    .replace(ANSI, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** Tools that run a command or a program: their title quotes it. */
const SHELLS = new Map<string, (args: JsonObject) => string>([
  ["Bash", (args) => text(args.command)],
  ["exec", (args) => text(args.code) || text(args.command) || text(args.source)]
]);

/** A command's first line, quoted and cut to fit one row. */
const quoted = (command: string) => `\`${clip(command.split("\n")[0]?.trim() ?? "", COMMAND_CHARS)}\``;

/** Present participles as the activity labels start, and their past tense. */
const PAST = new Map([
  ["Reading", "Read"],
  ["Writing", "Wrote"],
  ["Editing", "Edited"],
  ["Deleting", "Deleted"],
  ["Listing", "Listed"],
  ["Searching", "Searched"],
  ["Browsing", "Browsed"],
  ["Checking", "Checked"],
  ["Running", "Ran"],
  ["Using", "Used"],
  ["Delegating", "Delegated"],
  ["Messaging", "Messaged"],
  ["Stopping", "Stopped"],
  ["Starting", "Started"],
  ["Saving", "Saved"],
  ["Recalling", "Recalled"],
  ["Tidying", "Tidied"],
  ["Updating", "Updated"],
  ["Finding", "Found"],
  ["Resuming", "Resumed"]
]);

/** A label in the past tense: "Reading x.ts" becomes "Read x.ts". */
export function pastTense(label: string): string {
  const [first = "", ...rest] = label.split(" ");
  const past = PAST.get(first);

  return past === undefined ? label : [past, ...rest].join(" ");
}

const JsonSchema = Type.Unsafe<JsonValue>(Type.Any());

/** A JSON output, if it is one. */
function json(output: string): JsonValue | undefined {
  const trimmed = output.trim();

  return /^[[{]/.test(trimmed) ? parseOr(JsonSchema, trimmed, undefined) : undefined;
}

const isList = (value: JsonValue): value is JsonValue[] => Array.isArray(value);

/** The list a JSON result holds: itself, or its first array field, such as `{ messages: [...] }`. */
function listIn(value: JsonValue | undefined): readonly JsonValue[] | undefined {
  if (value === undefined) return undefined;

  if (isList(value)) return value;

  if (!Guard.IsObject(value)) return undefined;

  return Object.values(value).find((field): field is JsonValue[] => Guard.IsArray(field));
}

/** How many things a search found: "Found 3 files" as Claude Code says it, else one per line. */
function found(output: string): number {
  const said = /^Found (\d+)/.exec(output.trim())?.[1];

  if (said !== undefined) return Number(said);

  return /^No (files|matches) found/i.test(output.trim()) ? 0 : lines(output).length;
}

/** Tools whose output is a list, with what one of its lines is. */
const COUNTED = new Map<string, readonly [string, string?]>([
  ["grep", ["match", "matches"]],
  ["Grep", ["match", "matches"]],
  ["find", ["file"]],
  ["Glob", ["file"]],
  ["ls", ["entry", "entries"]]
]);

/** The key result a done step's title ends on, such as "3 matches"; empty when there is none to say. */
function resultOf(name: string, output: string): string {
  const counted = COUNTED.get(name);

  if (counted !== undefined) {
    const [one, many] = counted;

    return plural(found(output), one, many);
  }

  const list = listIn(json(output));

  return list === undefined ? "" : plural(list.length, "result");
}

/** A step's title: what the tool is doing while it runs, what it did once it is done, with its key result. */
export function stepTitle(name: string, args: JsonObject, state: StepState, output = ""): string {
  const command = SHELLS.get(name)?.(args);

  if (command) return `${state === "running" ? "Running" : "Ran"} ${quoted(command)}`;

  const label = describeTool(name, args).label;

  if (state === "running") return label;

  const result = state === "done" ? resultOf(name, output) : "";

  return result ? `${pastTense(label)} — ${result}` : pastTense(label);
}

/** The text values of a JSON result, in order, such as a message's subject and sender. */
function strings(value: JsonValue, out: string[] = []): string[] {
  if (out.length >= 6) return out;

  if (Guard.IsString(value) && value.trim() !== "") out.push(value.trim());
  else if (isList(value)) value.slice(0, 2).forEach((each) => strings(each, out));
  else if (value !== null && !Guard.IsNumber(value) && !Guard.IsBoolean(value) && !Guard.IsString(value)) Object.values(value).forEach((each) => strings(each, out));

  return out;
}

/** A step's dim line: what came back, in a sentence or two; why it failed when it did. */
export function stepSummary(name: string, output: string, ok: boolean): string {
  const said = lines(output);

  if (!ok) return clip(said[0] ?? "Failed", DETAIL_CHARS);

  if (name === "read" || name === "Read") return said.length === 0 ? "Empty" : plural(output.split("\n").length, "line");

  const parsed = json(output);

  if (parsed !== undefined) return clip(strings(parsed).join(" · ").replace(/\s+/g, " "), DETAIL_CHARS);

  return clip(said.slice(0, 2).join(" "), DETAIL_CHARS);
}

/** A tool's input to open: the command or program it runs, else its arguments. */
export function stepInput(name: string, args: JsonObject): string {
  const source = SHELLS.get(name)?.(args) || (name === "executor_execute" ? text(args.code) : "");

  return clip(source || (Object.keys(args).length > 0 ? JSON.stringify(args, null, 2) : ""), INPUT_CHARS);
}

/** What a step says when its tool starts. */
export const startStep = (name: string, args: JsonObject): StepStart => ({
  text: stepTitle(name, args, "running"),
  input: stepInput(name, args)
});

/** What a step says once its tool is done. */
export function endStep(name: string, args: JsonObject, output: string, ok: boolean): StepEnd {
  const state = ok ? "done" : "failed";

  return {
    text: stepTitle(name, args, state, output),
    detail: stepSummary(name, output, ok),
    output: clip(output.replace(/\n+$/, ""), OUTPUT_CHARS),
    state
  };
}
