import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const PROTOCOL = 4;

export const RUNNER_PATH = "/runner/";

export const REPLACED = 4409;

export const OUTDATED = 4426;

export const REVOKED = 4401;

export const Integer = Schema.Number.check(Schema.makeFilter((n: number) => Number.isInteger(n), { expected: "an integer" }));

const Positive = Integer.check(Schema.isGreaterThanOrEqualTo(1));

const Count = Integer.check(Schema.isGreaterThanOrEqualTo(0));

const Text = Schema.String;

const Session = Schema.NullOr(Schema.String);

export const AgentSchema = Schema.Literals(["claude", "codex"]);

const CodexCredsSchema = Schema.Struct({
  accessToken: Text,
  refreshToken: Schema.Null,
  idToken: Text,
  accountId: Text,
  expiresAt: Count
});

const RunCredsSchema = Schema.Struct({
  claude: Schema.optionalKey(Schema.Struct({ oauthToken: Text })),
  codex: Schema.optionalKey(CodexCredsSchema)
});

const Headers = Schema.Record(Schema.String, Schema.String);

const Port = Integer.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }));

const RunCommandSchema = Schema.Struct({
  type: Schema.Literal("run"),
  seq: Positive,
  task: Text,
  turn: Positive,
  prompt: Text,
  session: Session,
  agent: AgentSchema,
  taskToken: Text,
  creds: Schema.optionalKey(RunCredsSchema)
});

const StopCommandSchema = Schema.Struct({ type: Schema.Literal("stop"), seq: Positive, task: Text, turn: Positive });

const CredsCommandSchema = Schema.Struct({ type: Schema.Literal("creds"), seq: Positive, task: Text, codex: CodexCredsSchema });

const RunnerCommandSchema = Schema.Union([RunCommandSchema, StopCommandSchema, CredsCommandSchema]);

const ObjectFrameSchema = Schema.Union([
  RunnerCommandSchema,
  Schema.Struct({
    type: Schema.Literal("http_request"),
    id: Text,
    port: Port,
    method: Text,
    path: Text,
    headers: Headers,
    body: Schema.optionalKey(Text)
  }),
  Schema.Struct({ type: Schema.Literal("http_cancel"), id: Text }),
  Schema.Struct({ type: Schema.Literal("goodbye"), reason: Text, expected: Schema.optionalKey(Integer) })
]);

const RepoSchema = Schema.Struct({ name: Text, remote: Schema.NullOr(Text) });

const AgentFactsSchema = Schema.Struct({ installed: Schema.Boolean, signedIn: Schema.Boolean });

export const FactsSchema = Schema.Struct({
  os: Text,
  chrome: Schema.Boolean,
  repos: Schema.Array(RepoSchema),
  agents: Schema.Struct({ claude: AgentFactsSchema, codex: AgentFactsSchema }),
  ports: Schema.Array(Port),
  kind: Schema.Literals(["computer", "cloud"])
});

const HelloSchema = Schema.Struct({
  type: Schema.Literal("hello"),
  protocol: Integer,
  version: Text,
  active: Schema.Array(Text),
  facts: FactsSchema
});

const PipeReportSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("http_head"), id: Text, status: Integer.check(Schema.isBetween({ minimum: 100, maximum: 599 })), headers: Headers }),
  Schema.Struct({ type: Schema.Literal("http_chunk"), id: Text, data: Text }),
  Schema.Struct({ type: Schema.Literal("http_end"), id: Text }),
  Schema.Struct({ type: Schema.Literal("http_error"), id: Text, message: Text })
]);

const RunnerReportSchema = Schema.Union([
  HelloSchema,
  Schema.Struct({ type: Schema.Literal("ack"), seq: Positive }),
  Schema.Struct({ type: Schema.Literal("session"), task: Text, turn: Positive, session: Text }),
  Schema.Struct({
    type: Schema.Literal("step"),
    task: Text,
    turn: Positive,
    text: Text,
    call: Schema.optionalKey(Text),
    input: Schema.optionalKey(Text),
    state: Schema.optionalKey(Schema.Literals(["done", "failed"])),
    detail: Schema.optionalKey(Text),
    output: Schema.optionalKey(Text)
  }),
  Schema.Struct({
    type: Schema.Literal("result"),
    task: Text,
    turn: Positive,
    ok: Schema.Boolean,
    text: Text,
    session: Session,
    agent: AgentSchema,
    turns: Schema.optionalKey(Count),
    costUsd: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)))
  }),
  PipeReportSchema
]);

export type RunnerCommand = typeof RunnerCommandSchema.Type;

export type RunCommand = typeof RunCommandSchema.Type;

export type ObjectFrame = typeof ObjectFrameSchema.Type;

export type RunnerReport = typeof RunnerReportSchema.Type;

export type PipeReport = typeof PipeReportSchema.Type;

export type HttpRequest = Extract<ObjectFrame, { type: "http_request" }>;

export type TaskReport = Exclude<RunnerReport, PipeReport>;

export type MachineFacts = typeof FactsSchema.Type;

export type RunCreds = typeof RunCredsSchema.Type;

export type CodexCreds = typeof CodexCredsSchema.Type;

export type Agent = typeof AgentSchema.Type;

export const AGENT_NAMES: Readonly<Record<Agent, string>> = { claude: "Claude Code", codex: "Codex" };

export const isPipeReport: (report: RunnerReport) => report is PipeReport = Schema.is(PipeReportSchema);

export function toBase64(bytes: Uint8Array): string {
  let binary = "";

  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));

  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

export const ISSUED_TTL_MS = 24 * 60 * 60_000;

export const PAIRING_HEADER = "X-Ky-Pairing";

const MachineNameSchema = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,31}$/u));

export const isMachineName: (name: string) => boolean = Schema.is(MachineNameSchema);

const PairRequestSchema = Schema.Struct({ code: Schema.String.check(Schema.isMinLength(1)), name: MachineNameSchema, facts: Schema.Unknown });

export const WIRE = {
  command: RunnerCommandSchema,
  frame: ObjectFrameSchema,
  report: RunnerReportSchema,
  pair: PairRequestSchema
};

export const isMachineFacts = Schema.is(FactsSchema);

export function runnerPathMachine(pathname: string): string | undefined {
  if (!pathname.startsWith(RUNNER_PATH)) return undefined;

  const machine = pathname.slice(RUNNER_PATH.length);

  return isMachineName(machine) ? machine : undefined;
}

export type Decoded =
  | { readonly kind: "report"; readonly report: RunnerReport }
  | { readonly kind: "outdated"; readonly protocol: number }
  | { readonly kind: "malformed" };

const jsonOf = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const helloOf = Schema.decodeUnknownOption(Schema.Struct({ type: Schema.Literal("hello"), protocol: Integer }));

const reportOf = Schema.decodeUnknownOption(RunnerReportSchema);

const frameOf = Schema.decodeUnknownOption(Schema.fromJsonString(ObjectFrameSchema));

export function decodeReport(text: string): Decoded {
  const frame = jsonOf(text);
  const hello = Option.flatMap(frame, helloOf);

  if (Option.isSome(hello) && hello.value.protocol !== PROTOCOL) return { kind: "outdated", protocol: hello.value.protocol };
  const report = Option.flatMap(frame, reportOf);

  return Option.isSome(report) ? { kind: "report", report: report.value } : { kind: "malformed" };
}

export function decodeObjectFrame(text: string): ObjectFrame | undefined {
  return Option.getOrUndefined(frameOf(text));
}
