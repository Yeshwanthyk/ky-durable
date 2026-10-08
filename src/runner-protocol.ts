import Type, { type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

/**
 * The machine protocol: what MachineHub (src/machines.ts) and ky-runner
 * (runner/) say to each other over the runner's WebSocket. Both ends import
 * this file and decode every frame they receive with it, so a frame either
 * matches these schemas or is not acted on.
 *
 * The runner ships with the worker: bump PROTOCOL on any change. The object
 * reads a hello's `protocol` before the rest of it, and answers a runner that
 * says another one with `goodbye` and OUTDATED.
 */

export const PROTOCOL = 3;

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
const AgentSchema = Type.Union([Type.Literal("claude"), Type.Literal("codex")]);

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
  /** The task's own token, for `ky-attach` and `ky-diff`, as KY_TASK_TOKEN. */
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
const FactsSchema = Type.Object({
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

/** The part of a hello the object reads first, so a runner of another version is told so. */
const HelloProtocolSchema = Type.Object({ type: Type.Literal("hello"), protocol: Type.Integer() });

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
  /** What the session is doing now, in a few words, such as "Editing tasks.ts". */
  Type.Object({ type: Type.Literal("step"), task: Text, turn: Turn, text: Text }),
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

type PipeReport = Static<typeof PipeReportSchema>;

/** What a runner says about its tasks and itself, as against its answers to `http_request`. */
export type TaskReport = Exclude<RunnerReport, PipeReport>;

export type MachineFacts = Static<typeof FactsSchema>;

/** A hello of another protocol: the one the runner speaks. */
export type Outdated = { readonly outdated: number };

/** `Omit` applied to each member of a union, so the result stays a union. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A command before the inbox numbers it. */
export type UnnumberedCommand = DistributiveOmit<RunnerCommand, "seq">;

export function isPipeReport(report: RunnerReport): report is PipeReport {
  return report.type.startsWith("http_");
}

/** The frame `text` holds if it is JSON that matches `schema`, else undefined. */
function decode<const S extends TSchema>(schema: S, text: string): Static<S> | undefined {
  let frame;

  try {
    frame = JSON.parse(text);
  } catch {
    return undefined;
  }

  return Value.Check(schema, frame) ? frame : undefined;
}

/** A frame the object sent, or undefined if it is not one (the Agents SDK's own frames). */
export function decodeObjectFrame(text: string): ObjectFrame | undefined {
  return decode(ObjectFrameSchema, text);
}

/** A frame a runner sent; Outdated for a hello of another protocol, whatever the rest says; undefined if malformed. */
export function decodeReport(text: string): RunnerReport | Outdated | undefined {
  const hello = decode(HelloProtocolSchema, text);

  if (hello !== undefined && hello.protocol !== PROTOCOL) return { outdated: hello.protocol };

  return decode(RunnerReportSchema, text);
}
