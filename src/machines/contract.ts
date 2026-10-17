/**
 * The machines domain's public surface: what the rest of ky, and the runner in cli/runner/, may
 * use of it. runner-protocol.ts stays the wire file; everything outside src/machines/ imports
 * from here, never from machines.ts or runner-protocol.ts.
 *
 * Nothing here loads the Worker: the runner imports this file in Node, so it has no runtime
 * import of machines.ts (MachineHub is a type here; src/server.ts gets the class from wiring.ts).
 */
import Type, { type Static } from "typebox";
import { AgentSchema, type Agent, type RunCreds, type TaskReport } from "./runner-protocol.ts";

export {
  AGENT_NAMES,
  decodeObjectFrame,
  decodeReport,
  fromBase64,
  isMachineFacts,
  isMachineName,
  isPairRequest,
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

export type { MachineHub } from "./machines.ts";

/** What a task shares through `ky diff` on the machine: a git patch, up to this size. */
export { DIFF_TYPE, MAX_DIFF_BYTES } from "../files.ts";

/**
 * The tables the hub keeps, by name. Frozen: they hold a machine's pairing and its runs, which a
 * backup leaves out by the `ky_machine*` prefix (src/backup.ts), so a rename would be restored.
 */
export const MACHINE_TABLES = Object.freeze({
  machines: "ky_machines",
  inbox: "ky_machine_inbox",
  turns: "ky_machine_turns",
  senders: "ky_machine_senders",
  logins: "ky_machine_logins",
  reports: "ky_machine_reports"
} as const);

/** The agent's tool for machines, and the extension that registers it. */
export const MACHINE_TOOL = "machine";

export const MACHINE_EXTENSION = "machines";

/** What the machine tool can be asked to do. */
export const MACHINE_ACTIONS = ["list", "run", "send", "stop", "move", "set"] as const;

/** on: takes new tasks. paused: finishes its tasks and takes their messages, but no new ones. off: takes nothing from the agent. */
export const MachineStateSchema = Type.Union([Type.Literal("on"), Type.Literal("paused"), Type.Literal("off")]);

export type MachineState = Static<typeof MachineStateSchema>;

/** own: tasks sign in with the machine's own login when it has one. ky: always with ky's subscriptions. */
export const MachineLoginSchema = Type.Union([Type.Literal("own"), Type.Literal("ky")]);

export type MachineLogin = Static<typeof MachineLoginSchema>;

/** What the user changes about a machine: whether ky may use it, what it is for, and whose login its tasks use. */
export type MachineChange = { state?: MachineState; note?: string; login?: MachineLogin };

/** How a task's turn ended, as its status in the task list and the word its report uses. */
export type TaskOutcome = "done" | "failed" | "stopped";

/**
 * Every report a runner may send about its tasks and itself, each of which MachineHub handles.
 * Checked against the wire's schema by test/invariants/machines.test.ts.
 */
export const TASK_REPORT_TYPES = { hello: true, ack: true, session: true, step: true, result: true } as const satisfies Record<TaskReport["type"], true>;

const Text = Type.String();

const Count = Type.Integer();

/** A row of ky_machines, as the hub reads it. `state`, `login` and the JSON `facts` are checked apart, each to its default. */
export const MachineRowSchema = Type.Object({
  name: Text,
  seen_at: Type.Number(),
  state: Text,
  note: Text,
  facts: Type.Union([Text, Type.Null()]),
  login: Text,
  hello: Type.Union([Text, Type.Null()]),
  reason: Type.Union([Text, Type.Null()])
});

/** A machine row's runner socket and why it went offline, for `online` and `#send`. */
export const HelloRowSchema = Type.Object({ seen_at: Type.Number(), hello: Type.Union([Text, Type.Null()]) });

/** A row of ky_machine_inbox: its seq, and the queued command as JSON. */
export const InboxRowSchema = Type.Object({ seq: Count, payload: Text });

/** A command as the inbox keeps it, its JSON payload: no secret, and no seq, which is the row's. */
export const QueuedSchema = Type.Union([
  Type.Object({ type: Type.Literal("run"), task: Text, turn: Count, prompt: Text, session: Type.Union([Text, Type.Null()]), agent: AgentSchema }),
  Type.Object({ type: Type.Literal("stop"), task: Text, turn: Count }),
  Type.Object({ type: Type.Literal("creds"), task: Text })
]);

export type Queued = Static<typeof QueuedSchema>;

/** A row of ky_machine_turns: a task's latest turn, the highest reported over, sent to its runner, and asked to stop. */
export const TurnsRowSchema = Type.Object({ turn: Count, closed: Count, sent: Count, stopping: Count });

export type Turns = Static<typeof TurnsRowSchema>;

/** A row of ky_machine_reports: a report owed to a conversation. */
export const ReportRowSchema = Type.Object({ task: Text, turn: Count, session: Text, text: Text });

/** A row of ky_machine_logins: a Codex task handed ky's ChatGPT login, and when the one it was sent expires. */
export const LoginRowSchema = Type.Object({ task: Text, expires_at: Type.Number() });

/** The Vault's task tokens, for the runs the hub sends. */
export type TaskTokens = {
  /** The task's live token, the same for every run of it until it is revoked or expires. */
  issue: (task: string) => Promise<string>;
  revoke: (task: string) => Promise<void>;
  /** Revoke the tokens of all of `tasks`. */
  revokeAll: (tasks: readonly string[]) => Promise<void>;
};

/** The Vault's subscriptions: what a run is handed for `agent` when the machine doesn't use its own login; none without one. */
export type SessionCreds = (agent: Agent) => Promise<RunCreds>;

/** The sandboxes, on a deploy that has them: each started when a command waits for it. */
export type CloudHook = {
  /** Start the sandbox listed as `machine`. */
  wake(machine: string): void;
};

const RUNNER_TAG_PREFIX = "runner:";

/** The tag on a machine's runner socket. */
export function runnerTag(machine: string): string {
  return `${RUNNER_TAG_PREFIX}${machine}`;
}

/** The machine a socket's tags say it is the runner of, if any. */
export function runnerOf(tags: readonly string[]): string | undefined {
  return tags.find((tag) => tag.startsWith(RUNNER_TAG_PREFIX))?.slice(RUNNER_TAG_PREFIX.length);
}
