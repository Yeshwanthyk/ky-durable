import Type from "typebox";
import { Value } from "typebox/value";
import { decodeOr, parseOr } from "../../core/decode";

/**
 * How an Executor result says what a program came to. `execute` answers with
 * an envelope, `{ status, execution: { ok, value | error, toolCalls },
 * unavailableApps }`, and model mode answers a call that needs approval or
 * input with `status: "approval-required"` or `"input-required"`. Its own
 * module, so callers like automation gates need nothing else of Executor's
 * client.
 */

/** Whether a program's result paused for the user, which an unattended caller can never answer. */
function pausedForUser(text: string): boolean {
  return /"status"\s*:\s*"(approval|input)-required"/.test(text);
}

/** `execute`'s envelope, by the fields a caller reads; `value` is what the program returned, absent for undefined. */
const Envelope = Type.Object({
  status: Type.String(),
  execution: Type.Object({ ok: Type.Boolean(), value: Type.Optional(Type.Unknown()), error: Type.Optional(Type.Unknown()) })
});

/** What a program came to: what it returned, why it failed, or that it paused for the user. */
export type ProgramOutcome =
  | { readonly kind: "returned"; readonly value: unknown }
  | { readonly kind: "failed"; readonly text: string }
  | { readonly kind: "paused" };

/** What `execute`'s answer says the program came to; an answer that isn't the envelope fails, quoting it. */
export function programOutcome(text: string): ProgramOutcome {
  if (pausedForUser(text)) return { kind: "paused" };
  const envelope = parseOr(Envelope, text, undefined);

  if (envelope === undefined) return { kind: "failed", text: `Executor answered something ky can't read: ${text.trim().slice(0, 200)}` };

  if (envelope.status !== "completed") return { kind: "failed", text: `Executor said ${envelope.status}` };

  if (!envelope.execution.ok) return { kind: "failed", text: errorText(envelope.execution.error) };

  return { kind: "returned", value: envelope.execution.value };
}

/** What a program may have thrown that says why: text, or an error with a message. */
const Said = Type.Union([Type.String({ pattern: "\\S" }), Type.Object({ message: Type.String({ pattern: "\\S" }) })]);

/** A failed program's error as a line: its text, its message, or the error as JSON. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Executor's error is whatever the program threw.
function errorText(error: unknown): string {
  const said = decodeOr(Said, error, undefined);

  if (said !== undefined) return (Value.Check(Type.String(), said) ? said : said.message).trim();

  return error === undefined ? "the program failed" : JSON.stringify(error);
}
