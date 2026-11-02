import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import Type from "typebox";
import type { Refusable } from "../core/edge.ts";
import type { MachineInfo } from "../protocol.ts";
import { AGENT_EFFORTS, AGENT_MODELS, AGENT_NAMES, AgentModelSchema, AgentSchema, type Agent, type AgentModel, FactsSchema, Integer, type MachineFacts, type RunCreds, type TaskReport } from "./runner-protocol.ts";

export {
  AGENT_EFFORTS,
  AGENT_MODELS,
  AGENT_NAMES,
  AgentModelSchema,
  CHATGPT_MODELS,
  decodeObjectFrame,
  decodeReport,
  fromBase64,
  isMachineFacts,
  isMachineName,
  isPipeReport,
  ISSUED_TTL_MS,
  OUTDATED,
  PAIRING_HEADER,
  PROTOCOL,
  REPLACED,
  REVOKED,
  RUNNER_PATH,
  runnerPathMachine,
  toBase64,
  WIRE
} from "./runner-protocol.ts";

export type {
  Agent,
  AgentModel,
  CodexCreds,
  HttpRequest,
  MachineFacts,
  ObjectFrame,
  PipeReport,
  RunCommand,
  RunCreds,
  RunnerCommand,
  RunnerReport,
  TaskReport
} from "./runner-protocol.ts";

export type { MachineHub } from "./wiring.ts";

export const MACHINE_TABLES = Object.freeze({
  machines: "ky_machines",
  inbox: "ky_machine_inbox",
  turns: "ky_machine_turns",
  senders: "ky_machine_senders",
  logins: "ky_machine_logins",
  reports: "ky_machine_reports"
} as const);

export const MACHINE_TOOL = "machine";

export const MACHINE_EXTENSION = "machines";

export const CLOUD = "cloud";

/** The one address the cloud machine sends a chat's requests to for the Worker (CloudMachine.chatgpt). */
export const CHATGPT_RESPONSES = "https://chatgpt.com/backend-api/codex/responses";

export const CLOUD_FACTS: MachineFacts = {
  os: "linux",
  chrome: false,
  repos: [],
  agents: { claude: { installed: true, signedIn: false }, codex: { installed: true, signedIn: false } },
  ports: [],
  kind: "cloud",
  // The cloud machine runs the image this ky's deploy pinned, whose runner is this ky's.
  models: true
};

/** Whether a listed machine is one of the user's paired computers, not a sandbox. */
export const isMac = (machine: { readonly sandbox: object | null; readonly facts: { readonly kind?: string } | null }) =>
  machine.sandbox === null && machine.facts?.kind !== "cloud";

export const MACHINE_ACTIONS = ["list", "run", "send", "stop", "move", "set"] as const;

const STATES = ["on", "paused", "off"] as const;

const LOGINS = ["own", "ky"] as const;

export const MachineStateSchema = Type.Union([Type.Literal("on"), Type.Literal("paused"), Type.Literal("off")]);

export const MachineLoginSchema = Type.Union([Type.Literal("own"), Type.Literal("ky")]);

const MachineState = Schema.Literals(STATES);

const MachineLogin = Schema.Literals(LOGINS);

export type MachineState = typeof MachineState.Type;

export type MachineLogin = typeof MachineLogin.Type;

export const isMachineState = Schema.is(MachineState);

export const isMachineLogin = Schema.is(MachineLogin);

export type MachineChange = { state?: MachineState; note?: string; login?: MachineLogin };

export type TaskOutcome = "done" | "failed" | "stopped";

export const TASK_REPORT_TYPES = { hello: true, ack: true, session: true, step: true, result: true } as const satisfies Record<TaskReport["type"], true>;

const Text = Schema.String;

const orElse = <S extends Schema.Top>(schema: S, fallback: S["Type"]) => schema.pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(fallback))));

export const MachineRow = Schema.Struct({
  name: Text,
  seen_at: Schema.Number,
  state: orElse(MachineState, "on"),
  note: Text,
  facts: orElse(Schema.NullOr(Schema.fromJsonString(FactsSchema)), null),
  login: orElse(MachineLogin, "own"),
  hello: Schema.NullOr(Text),
  reason: Schema.NullOr(Text)
});

export const HelloRow = Schema.Struct({ seen_at: Schema.Number, hello: Schema.NullOr(Text) });

export const InboxRow = Schema.Struct({ seq: Integer, payload: Text });

const Queued = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("run"),
    task: Text,
    turn: Integer,
    prompt: Text,
    session: Schema.NullOr(Text),
    agent: AgentSchema,
    model: Schema.optionalKey(AgentModelSchema)
  }),
  Schema.Struct({ type: Schema.Literal("stop"), task: Text, turn: Integer }),
  Schema.Struct({ type: Schema.Literal("creds"), task: Text })
]);

export type Queued = typeof Queued.Type;

export const QueuedJson = Schema.fromJsonString(Queued);

export const TurnsRow = Schema.Struct({ turn: Integer, closed: Integer, sent: Integer, stopping: Integer });

export type Turns = typeof TurnsRow.Type;

export const ReportRow = Schema.Struct({ task: Text, turn: Integer, session: Text, text: Text });

export const LoginRow = Schema.Struct({ task: Text, expires_at: Schema.Number });

export class NoMachine extends Schema.TaggedError<NoMachine>()("NoMachine", { name: Schema.String }) implements Refusable {
  get refusal(): string {
    return `No machine ${this.name}.`;
  }
}

export class NotAState extends Schema.TaggedError<NotAState>()("NotAState", { state: Schema.Unknown }) implements Refusable {
  get refusal(): string {
    return `A machine is on, paused or off, not ${JSON.stringify(this.state)}.`;
  }
}

export class NotALogin extends Schema.TaggedError<NotALogin>()("NotALogin", { login: Schema.Unknown }) implements Refusable {
  get refusal(): string {
    return `A machine's tasks sign in with its own login or ky's, not ${JSON.stringify(this.login)}.`;
  }
}

export type TaskTokens = {
  issue: (task: string) => Promise<string>;
  revoke: (task: string) => Promise<void>;
  revokeAll: (tasks: readonly string[]) => Promise<void>;
};

export type SessionCreds = (agent: Agent) => Promise<RunCreds>;

export type CloudHook = {
  wake(machine: string): void;
  turnEnded(machine: string): void;
};

const RUNNER_TAG_PREFIX = "runner:";

export function runnerTag(machine: string): string {
  return `${RUNNER_TAG_PREFIX}${machine}`;
}

export function runnerOf(tags: readonly string[]): string | undefined {
  return tags.find((tag) => tag.startsWith(RUNNER_TAG_PREFIX))?.slice(RUNNER_TAG_PREFIX.length);
}

/**
 * Why `machine` can't run `agent` on `model`, or null when it can. A runner from before models
 * would drop the model without a word, so one that doesn't say it pins one is refused.
 */
export function cannotPin(machine: MachineInfo | undefined, agent: Agent, model: AgentModel | null): string | null {
  if (model === null || !machine) return null;

  if (!AGENT_MODELS[agent].includes(model.id)) return `${AGENT_NAMES[agent]} runs ${AGENT_MODELS[agent].join(", ")}, not ${model.id}.`;

  if (model.effort !== null && !AGENT_EFFORTS[agent].includes(model.effort)) return `${AGENT_NAMES[agent]} takes effort ${AGENT_EFFORTS[agent].join(", ")}, not ${model.effort}.`;

  if (machine.facts === null) return `${machine.name} hasn't connected yet, so ky can't tell whether its runner picks a model.`;

  if (machine.facts.models !== true) return `${machine.name}'s ky-runner is too old to pick a model; update ky on it (ky upgrade).`;

  return null;
}

/** Why `machine` can't run `agent`, or null when it can; one that hasn't connected yet may have it. */
export function cannotRun(machine: MachineInfo | undefined, agent: Agent): string | null {
  if (!machine || machine.facts === null || machine.facts.agents[agent].installed) return null;

  return `${machine.name} cannot run ${AGENT_NAMES[agent]}: it is not installed there.`;
}
