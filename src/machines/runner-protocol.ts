import Type, { type Static } from "typebox";
import { Value } from "typebox/value";
import { decodeOr, parseOr } from "../core/decode.ts";

/**
 * The machine protocol: what MachineHub (src/machines/machines.ts) and the runner
 * (`ky runner run`, cli/runner/) say to each other over the runner's WebSocket. Both ends import
 * this file and decode every frame they receive with it, so a frame either
 * matches these schemas or is not acted on.
 *
 * The runner ships with the worker: bump PROTOCOL on any change. The object
 * reads a hello's `protocol` before the rest of it, and answers a runner that
 * says another one with `goodbye` and OUTDATED.
 */

export const PROTOCOL = 4;

/** Where a runner's socket connects: `GET /runner/<machine>`. */
export const RUNNER_PATH = "/runner/";

/**
 * The close code for a runner's socket when a runner of the same name says
 * hello on another: one socket per name, so commands and reports have one
 * path, and the newest runner wins.
 */
export const REPLACED = 4409;

/** The close code after `goodbye` to a runner that speaks another protocol. */
export const OUTDATED = 4426;

/** The close code after `goodbye` to a runner whose machine the user removed: its token is revoked. */
export const REVOKED = 4401;

const Seq = Type.Integer({ minimum: 1 });

/**
 * A task's turn: 1 for its run, one more for each message sent to it. A
 * report names the turn it ends or speaks for, and the object drops a report
 * for a turn it has already closed.
 */
const Turn = Type.Integer({ minimum: 1 });

const Text = Type.String();

const Session = Type.Union([Type.String(), Type.Null()]);

/** The coding agent a task runs as. */
export const AgentSchema = Type.Union([Type.Literal("claude"), Type.Literal("codex")]);

/** A ChatGPT login for `codex`, written to the task's own `CODEX_HOME`. */
const CodexCredsSchema = Type.Object({
  accessToken: Text,
  refreshToken: Type.Null(),
  idToken: Text,
  accountId: Text,
  /** Epoch milliseconds. */
  expiresAt: Type.Integer({ minimum: 0 })
});

/**
 * Per-task credentials, handed only to that task's agent: `claude` gets
 * CLAUDE_CODE_OAUTH_TOKEN. Absent, the task uses the machine's own login.
 * No GitHub token is ever handed out: the cloud machine reaches GitHub only
 * through the Worker's github.internal (src/github.ts), which holds it.
 */
const RunCredsSchema = Type.Object({
  claude: Type.Optional(Type.Object({ oauthToken: Text })),
  codex: Type.Optional(CodexCredsSchema)
});

const Headers = Type.Record(Type.String(), Type.String());

const Port = Type.Integer({ minimum: 1, maximum: 65_535 });

/** Object → runner: start a task's turn, or steer the session that runs it. */
const RunCommandSchema = Type.Object({
  type: Type.Literal("run"),
  seq: Seq,
  task: Text,
  turn: Turn,
  prompt: Text,
  /** The agent's session to resume, once the first turn named one. */
  session: Session,
  agent: AgentSchema,
  /** The task's own token, for `ky attach` and `ky diff`, as KY_TASK_TOKEN. */
  taskToken: Text,
  creds: Type.Optional(RunCredsSchema)
});

/** Object → runner: stop the task's session; `turn` is its latest. */
const StopCommandSchema = Type.Object({
  type: Type.Literal("stop"),
  seq: Seq,
  task: Text,
  turn: Turn
});

/** Object → runner: a refreshed ChatGPT login for a Codex task that is still open. */
const CredsCommandSchema = Type.Object({
  type: Type.Literal("creds"),
  seq: Seq,
  task: Text,
  codex: CodexCredsSchema
});

/** The commands the object keeps in its inbox until the runner acks their seq. */
const RunnerCommandSchema = Type.Union([RunCommandSchema, StopCommandSchema, CredsCommandSchema]);

/**
 * Everything the object sends a runner: commands; a request to one of the
 * machine's allowed ports, which the runner answers with `http_*` reports;
 * and `goodbye` just before it closes the socket for good.
 */
const ObjectFrameSchema = Type.Union([
  RunnerCommandSchema,
  Type.Object({
    type: Type.Literal("http_request"),
    id: Text,
    port: Port,
    method: Text,
    path: Text,
    headers: Headers,
    /** Base64. */
    body: Type.Optional(Text)
  }),
  Type.Object({ type: Type.Literal("http_cancel"), id: Text }),
  /** `expected` is the protocol the object speaks, when that is why. */
  Type.Object({ type: Type.Literal("goodbye"), reason: Text, expected: Type.Optional(Type.Integer()) })
]);

/** A git repository on the machine: its folder name, and its `origin` remote when it has one. */
const RepoSchema = Type.Object({ name: Text, remote: Type.Union([Text, Type.Null()]) });

const AgentFactsSchema = Type.Object({ installed: Type.Boolean(), signedIn: Type.Boolean() });

/** What the machine is, for the agent to choose where work goes. */
export const FactsSchema = Type.Object({
  /** `process.platform`: darwin, linux, win32. */
  os: Text,
  /** Tasks drive the user's own Chrome, with its logins. */
  chrome: Type.Boolean(),
  repos: Type.Array(RepoSchema),
  /** Which agents run here, and whether each has its own login. */
  agents: Type.Object({ claude: AgentFactsSchema, codex: AgentFactsSchema }),
  /** Local ports the runner forwards `http_request`s to. */
  ports: Type.Array(Port),
  /** One of the user's own computers, or ky's cloud machine. */
  kind: Type.Union([Type.Literal("computer"), Type.Literal("cloud")])
});

/**
 * Runner → object, on connect and as a keepalive. `version` is the runner's
 * own build; `active` lists the tasks with a live session. The object keeps
 * the last facts it was told.
 */
const HelloSchema = Type.Object({
  type: Type.Literal("hello"),
  protocol: Type.Integer(),
  version: Text,
  active: Type.Array(Text),
  facts: FactsSchema
});

/** A runner's answers to an `http_request`, by its id: the head, base64 chunks of the body, then an end or an error. */
const PipeReportSchema = Type.Union([
  Type.Object({ type: Type.Literal("http_head"), id: Text, status: Type.Integer({ minimum: 100, maximum: 599 }), headers: Headers }),
  Type.Object({ type: Type.Literal("http_chunk"), id: Text, data: Text }),
  Type.Object({ type: Type.Literal("http_end"), id: Text }),
  Type.Object({ type: Type.Literal("http_error"), id: Text, message: Text })
]);

const RunnerReportSchema = Type.Union([
  HelloSchema,
  Type.Object({ type: Type.Literal("ack"), seq: Seq }),
  Type.Object({ type: Type.Literal("session"), task: Text, turn: Turn, session: Text }),
  /**
   * What the session is doing now, in a few words, such as "Editing tasks.ts". A tool's step has its
   * `call` id and `input`; the same call again with a `state` is the tool done, with what came back.
   */
  Type.Object({
    type: Type.Literal("step"),
    task: Text,
    turn: Turn,
    text: Text,
    call: Type.Optional(Text),
    input: Type.Optional(Text),
    state: Type.Optional(Type.Union([Type.Literal("done"), Type.Literal("failed")])),
    detail: Type.Optional(Text),
    output: Type.Optional(Text)
  }),
  /** The end of every turn up to `turn`, with what the session spent on them when the agent says. */
  Type.Object({
    type: Type.Literal("result"),
    task: Text,
    turn: Turn,
    ok: Type.Boolean(),
    text: Text,
    session: Session,
    agent: AgentSchema,
    turns: Type.Optional(Type.Integer({ minimum: 0 })),
    costUsd: Type.Optional(Type.Number({ minimum: 0 }))
  }),
  PipeReportSchema
]);

export type RunnerCommand = Static<typeof RunnerCommandSchema>;

export type RunCommand = Static<typeof RunCommandSchema>;

export type ObjectFrame = Static<typeof ObjectFrameSchema>;

export type RunnerReport = Static<typeof RunnerReportSchema>;

export type PipeReport = Static<typeof PipeReportSchema>;

/** A request for one of the machine's allowed ports. */
export type HttpRequest = Extract<ObjectFrame, { type: "http_request" }>;

/** What a runner says about its tasks and itself, as against its answers to `http_request`. */
export type TaskReport = Exclude<RunnerReport, PipeReport>;

export type MachineFacts = Static<typeof FactsSchema>;

export type RunCreds = Static<typeof RunCredsSchema>;

export type CodexCreds = Static<typeof CodexCredsSchema>;

export type Agent = Static<typeof AgentSchema>;

/** Each agent by the name the user knows it by. */
export const AGENT_NAMES: Readonly<Record<Agent, string>> = { claude: "Claude Code", codex: "Codex" };

export function isPipeReport(report: RunnerReport): report is PipeReport {
  return Value.Check(PipeReportSchema, report);
}

/** Bytes as a pipe frame carries them: base64. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";

  // In slices: spreading a whole chunk into fromCharCode overflows the stack.
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));

  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

/**
 * How long a task token the Vault issues lives past its last issue. Each run of a task the
 * runner is sent issues it again, so the token outlives any one turn of
 * Claude Code, which runs minutes to a few hours; and a token whose revoke
 * was lost lives a day at most, if the agent's sweep at start missed it.
 */
export const ISSUED_TTL_MS = 24 * 60 * 60_000;

/**
 * The header the Worker adds to a runner's socket request: the pairing its
 * machine token belongs to, which the agent compares with its machine's.
 * Not a secret; the Worker sets it over whatever the runner sent.
 */
export const PAIRING_HEADER = "X-Ky-Pairing";

/** A machine's name, as the last segment of its runner's path: lowercase letters, digits and dashes, up to 32. */
const MachineNameSchema = Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,31}$" });

/** Whether `name` can name a machine. */
export function isMachineName(name: string): boolean {
  return Value.Check(MachineNameSchema, name);
}

/** What a runner sends to pair: the user's code, the name it wants, and what it says about its machine. */
const PairRequestSchema = Type.Object({ code: Type.String({ minLength: 1 }), name: MachineNameSchema, facts: Type.Unknown() });

export type PairRequest = Static<typeof PairRequestSchema>;

/**
 * Every schema that crosses the runner's socket or its pairing request. test/invariants hashes
 * these against PROTOCOL, so changing one without a bump fails the check.
 */
export const WIRE = {
  command: RunnerCommandSchema,
  frame: ObjectFrameSchema,
  report: RunnerReportSchema,
  pair: PairRequestSchema
};

/** Whether `body`, a parsed JSON request, asks to pair; its facts are checked apart, with isMachineFacts. */
export function isPairRequest(body: unknown): body is PairRequest {
  return Value.Check(PairRequestSchema, body);
}

/** Whether `facts` is what a runner says about its machine. */
export function isMachineFacts(facts: unknown): facts is MachineFacts {
  return Value.Check(FactsSchema, facts);
}

/** The machine a runner's path names, or undefined if the path is not `/runner/<machine>`. */
export function runnerPathMachine(pathname: string): string | undefined {
  if (!pathname.startsWith(RUNNER_PATH)) return undefined;

  const machine = pathname.slice(RUNNER_PATH.length);

  return isMachineName(machine) ? machine : undefined;
}

/** A runner's frame, parsed once: what it says, or why the object will not act on it. */
export type Decoded =
  | { readonly kind: "report"; readonly report: RunnerReport }
  | { readonly kind: "outdated"; readonly protocol: number }
  | { readonly kind: "malformed" };

/** Just enough of a frame to see that it is a hello, and which protocol it speaks. */
const HelloProtocolSchema = Type.Object({ type: Type.Literal("hello"), protocol: Type.Integer() });

/**
 * A frame a runner sent. A hello's `protocol` is read before the rest of it,
 * so a runner of another protocol is "outdated" whatever else it says.
 */
export function decodeReport(text: string): Decoded {
  // Text that isn't JSON is undefined here: neither a hello nor a report.
  const frame = parseOr(Type.Unknown(), text, undefined);
  const hello = decodeOr(HelloProtocolSchema, frame, undefined);

  if (hello && hello.protocol !== PROTOCOL) return { kind: "outdated", protocol: hello.protocol };
  const report = decodeOr(RunnerReportSchema, frame, undefined);

  return report ? { kind: "report", report } : { kind: "malformed" };
}

/** A frame the object sent, or undefined if it is not one (the Agents SDK's own frames). */
export function decodeObjectFrame(text: string): ObjectFrame | undefined {
  return parseOr(ObjectFrameSchema, text, undefined);
}
