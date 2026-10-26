import type { JsonValue } from "@earendil-works/pi-ai";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Refusable } from "../core/edge";

export const ExecutorConnection = Schema.Struct({ url: Schema.String, token: Schema.String });

export type ExecutorConnection = typeof ExecutorConnection.Type;

export type ExecutorConfig = ExecutorConnection & { readonly fetch?: typeof fetch };

export type CallResult = { output: Array<{ type: "text"; text: string }>; isError?: boolean };

export const resultText = (result: CallResult): string => result.output.map((part) => part.text).join("\n");

export type ExecutorCall = (name: string, args: Record<string, JsonValue | undefined>) => Promise<CallResult>;

export type ResumeAction = "answer" | "decline" | "cancel";

export interface ExecutorGate {
  replied(result: CallResult, conversation: string, call: ExecutorCall): Promise<CallResult>;
  beforeResume(requestId: string, action: ResumeAction, conversation: string): string | undefined;
  resumed(requestId: string): void;
}

export type Attempt = { result: CallResult; neverRan: boolean };

export type ExecutorRetarget = (url: string) => Promise<{ refused?: string }>;

type SecretMeta = { readonly [field: string]: string | number | boolean | null | readonly string[] };

export interface ExecutorVault {
  executor(id: string): Promise<ExecutorConnection | null>;
  status(): Promise<ReadonlyArray<{ readonly kind: string; readonly id: string; readonly meta: SecretMeta | null }>>;
  put(kind: "executor", id: string, value: ExecutorConnection, meta: { url: string }): Promise<void>;
  remove(kind: "executor", id: string): Promise<void>;
}

export class NoToken extends Schema.TaggedError<NoToken>()("NoToken", {}) implements Refusable {
  get refusal(): string {
    return "Paste an Executor personal access token.";
  }
}

export class NotAUrl extends Schema.TaggedError<NotAUrl>()("NotAUrl", {}) implements Refusable {
  get refusal(): string {
    return "That isn't a URL. Paste Executor's MCP address, like https://mcp.executor.sh/mcp.";
  }
}

export class NotHttps extends Schema.TaggedError<NotHttps>()("NotHttps", {}) implements Refusable {
  get refusal(): string {
    return "Executor's address must start with https://.";
  }
}

export class TokenRefused extends Schema.TaggedError<TokenRefused>()("TokenRefused", {}) implements Refusable {
  get refusal(): string {
    return "Executor refused that token.";
  }
}

export class Unreachable extends Schema.TaggedError<Unreachable>()("Unreachable", { origin: Schema.String, message: Schema.String }) implements Refusable {
  get refusal(): string {
    return `ky couldn't reach Executor at ${this.origin}: ${this.message}`;
  }
}

export class NotConnected extends Schema.TaggedError<NotConnected>()("NotConnected", {}) implements Refusable {
  get refusal(): string {
    return "Executor is not connected. Connect it in Settings › Tools › Executor.";
  }
}

export class OtherOrigin extends Schema.TaggedError<OtherOrigin>()("OtherOrigin", { origin: Schema.String }) implements Refusable {
  get refusal(): string {
    return `ky only changes the path and query here, on ${this.origin}. Change the host in Settings › Tools › Executor.`;
  }
}

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
