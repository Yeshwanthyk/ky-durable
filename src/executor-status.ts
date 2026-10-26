import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const pausedForUser = (text: string): boolean => /"status"\s*:\s*"(approval|input)-required"/.test(text);

const Execution = Schema.Struct({ ok: Schema.Boolean, value: Schema.optionalKey(Schema.Unknown), error: Schema.optionalKey(Schema.Unknown) });

const envelopeOf = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ status: Schema.String, execution: Execution })));

const Line = Schema.String.check(Schema.isPattern(/\S/));

const lineOf = Schema.decodeUnknownOption(Line);

const messageOf = Schema.decodeUnknownOption(Schema.Struct({ message: Line }));

export type ProgramOutcome =
  | { readonly kind: "returned"; readonly value: unknown }
  | { readonly kind: "failed"; readonly text: string }
  | { readonly kind: "paused" };

export function programOutcome(text: string): ProgramOutcome {
  if (pausedForUser(text)) return { kind: "paused" };
  const envelope = envelopeOf(text);

  if (Option.isNone(envelope)) return { kind: "failed", text: `Executor answered something ky can't read: ${text.trim().slice(0, 200)}` };
  const { status, execution } = envelope.value;

  if (status !== "completed") return { kind: "failed", text: `Executor said ${status}` };

  if (!execution.ok) return { kind: "failed", text: errorText(execution) };

  return { kind: "returned", value: execution.value };
}

function errorText({ error }: typeof Execution.Type): string {
  return lineOf(error).pipe(
    Option.orElse(() => Option.map(messageOf(error), (said) => said.message)),
    Option.match({ onSome: (said) => said.trim(), onNone: () => (error === undefined ? "the program failed" : JSON.stringify(error)) })
  );
}
