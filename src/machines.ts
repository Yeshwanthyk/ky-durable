import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type Extension
} from "@earendil-works/pi-durable";
import { type PiHarness, ROOT_SESSION } from "agents/harness/pi";
import { CLOUD, CLOUD_FACTS } from "./cloud-facts";
import type { FileRow, FileStore } from "./files";
import { type MachineInfo, osName } from "./protocol";
import { type Agent, AGENT_NAMES, ISSUED_TTL_MS, type MachineFacts, type RunCreds, type RunnerCommand, type TaskReport, type UnnumberedCommand } from "./runner-protocol";
import { summarize, type TaskFeed, type TaskRow } from "./tasks";

/**
 * Machines: computers that run work for the main agent, such as the user's
 * Mac. A machine runs `ky runner run`, which dials into this object
 * over a WebSocket (`/runner/<name>`), so nothing on the machine listens on
 * a port. Each task runs as a Claude Code or Codex session on that machine,
 * with its shell, browser, files and the user's own login to that agent.
 *
 * What the runner must do is kept in an inbox table until it acknowledges
 * it, so a message sent while the machine is offline is delivered when it
 * reconnects. Each run carries its task's token, which the Vault issues as
 * the run is sent and revokes when the task ends; the inbox keeps no token.
 *
 * A run on a machine that isn't signed in to its agent, or that the user
 * set to sign in with ky's login, carries the Vault's subscription for it,
 * added as it is sent like the token. A Codex task handed ky's ChatGPT login
 * is sent the refreshed one (a `creds` command) while it is open: at each
 * hello, which the runner says every 30 seconds, the hub asks the Vault for
 * the login, which the Vault refreshes before it expires.
 *
 * A machine is paired when its row has a pairing: the id the Worker's pair
 * route made when it minted the machine's token. Removing the machine
 * deletes the row and pairing it again replaces the id, so a runner whose
 * token the Worker checked before either is refused by the object, however
 * the two interleave. A hello never adds a machine.
 *
 * Each finished turn is recorded in the task feed and posted as
 * a steer, so it lands after the current tool round, to the conversation
 * that sent the turn: the main one or a side chat. A report is kept until
 * it is posted, so one cut off by a restart is posted when the object starts.
 *
 * The user decides which machines ky may use (on, paused, off) and what each
 * is for (a note); the runner says what each is (its OS, Chrome, repos). The
 * agent chooses among the machines that are on, and the tool refuses the rest.
 */

const RUNNER_TAG_PREFIX = "runner:";

const OPEN = 1;

export function runnerTag(machine: string): string {
  return `${RUNNER_TAG_PREFIX}${machine}`;
}

export function runnerOf(tags: readonly string[]): string | undefined {
  return tags.find((tag) => tag.startsWith(RUNNER_TAG_PREFIX))?.slice(RUNNER_TAG_PREFIX.length);
}

type Turns = { turn: number; closed: number; sent: number };

/** on: takes new tasks. paused: finishes its tasks and takes their messages, but no new ones. off: takes nothing from the agent. */
export type MachineState = "on" | "paused" | "off";

const MACHINE_STATES: readonly MachineState[] = ["on", "paused", "off"];

/** own: tasks sign in with the machine's own login when it has one. ky: always with ky's subscriptions. */
export type MachineLogin = "own" | "ky";

const MACHINE_LOGINS: readonly MachineLogin[] = ["own", "ky"];

/** What the user changes about a machine: whether ky may use it, what it is for, and whose login its tasks use. */
export type MachineChange = { state?: MachineState; note?: string; login?: MachineLogin };

const NOTE_CHARS = 200;

type MachineRow = { name: string; seen_at: number; state: MachineState; note: string; facts: string | null; login: MachineLogin };

type Command<T extends UnnumberedCommand["type"]> = Extract<UnnumberedCommand, { type: T }>;

/** A command as the inbox keeps it: no secret. A run's task token and credentials, and a creds command's login, are added as it is sent. */
type Queued = Command<"stop"> | Omit<Command<"run">, "taskToken" | "creds"> | Omit<Command<"creds">, "codex">;

/** A queued command and its place in the inbox. */
type Pending = Queued & { seq: number };

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

/** The cloud machine, on a deploy that has one: started when a command waits for it, and handed GitHub. */
export type CloudHook = {
  wake(): void;
  github(): Promise<{ token: string } | null>;
};

/** How many times a delivery the Vault failed is tried again, a second and then twice as long apart each time. */
const DELIVERY_RETRIES = 5;

/** A turn for the runner to run, as `agent`. */
function runCommand(task: string, turn: number, prompt: string, session: string | null, agent: Agent): Queued {
  return { type: "run", task, turn, prompt, session, agent };
}

/** The agents, in the order a task takes one when none is named. */
const PREFERRED: readonly Agent[] = ["claude", "codex"];

/** Agents that take a message mid-turn; Codex runs one once its turn ends. */
const STEERS: ReadonlySet<Agent> = new Set(["claude"]);

/** Whether a machine has `agent` installed, as it last said; one that never said is taken to. */
function has(facts: MachineFacts | null, agent: Agent): boolean {
  return facts === null || facts.agents[agent].installed;
}

/** Whether a machine runs `agent`: installed and signed in, as it last said; one that never said is taken to. */
function runs(facts: MachineFacts | null, agent: Agent): boolean {
  return has(facts, agent) && (facts === null || facts.agents[agent].signedIn);
}

/** Whether a machine's runs of `agent` are handed ky's subscription: set to, or not signed in itself. */
function handsCreds(machine: MachineInfo | undefined, agent: Agent): boolean {
  return machine !== undefined && (machine.login === "ky" || machine.facts?.kind === "cloud" || !runs(machine.facts, agent));
}

/** Throw for a change to a state or login a machine can't have. */
function checkChange(change: MachineChange): void {
  if (change.state !== undefined && !MACHINE_STATES.includes(change.state)) {
    throw new Error(`A machine is on, paused or off, not ${JSON.stringify(change.state)}.`);
  }

  if (change.login !== undefined && !MACHINE_LOGINS.includes(change.login)) {
    throw new Error(`A machine's tasks sign in with its own login or ky's, not ${JSON.stringify(change.login)}.`);
  }
}

/** The agent a task on a machine runs as when none is named: the first it runs, else the first it has, Claude Code first. */
function defaultAgent(facts: MachineFacts | null): Agent {
  return PREFERRED.find((agent) => runs(facts, agent)) ?? PREFERRED.find((agent) => has(facts, agent)) ?? "claude";
}

/**
 * Why a machine cannot run `agent`, or null if it can. Only a missing CLI
 * is: a login that looks signed out may be wrong, as the runner does too,
 * and the CLI says so itself.
 */
function cannotRun(machine: MachineInfo | undefined, agent: Agent): string | null {
  if (!machine || has(machine.facts, agent)) return null;

  return `${machine.name} cannot run ${AGENT_NAMES[agent]}: it is not installed there.`;
}

export class MachineHub {
  readonly #sql: SqlStorage;
  readonly #feed: TaskFeed;
  readonly #sockets: (tag: string) => WebSocket[];
  readonly #files: FileStore;
  readonly #tokens: TaskTokens;
  readonly #creds: SessionCreds;
  /** Token work in call order, so a task's token is never issued for a run after its revoke was asked for. */
  #tokenWork: Promise<void> = Promise.resolve();
  /** The retries of each machine's failed delivery so far. */
  readonly #retries = new Map<string, number>();
  /** The machines with a retry waiting. */
  readonly #waiting = new Set<string>();
  /** The wait before a failed delivery's first retry, doubled for each one after; tests shorten it. */
  retryMs = 1_000;
  readonly #watchers = new Set<() => void>();
  #harness: PiHarness | undefined;
  /** The cloud machine, once the deploy says it has one. */
  cloud: CloudHook | undefined;
  #wanted: (task: string) => boolean = () => true;

  constructor(
    sql: SqlStorage,
    feed: TaskFeed,
    sockets: (tag: string) => WebSocket[],
    /** Files tasks share; a report lists them so the agent can mention them. */
    files: FileStore,
    tokens: TaskTokens,
    creds: SessionCreds
  ) {
    this.#sql = sql;
    this.#feed = feed;
    this.#sockets = sockets;
    this.#files = files;
    this.#tokens = tokens;
    this.#creds = creds;
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_machine_inbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      machine TEXT NOT NULL,
      payload TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_machines (
      name TEXT PRIMARY KEY, seen_at INTEGER NOT NULL)`);
    // Each task's turns: its latest, the highest one reported over, and the highest one sent to its runner.
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_machine_turns (
      task TEXT PRIMARY KEY,
      turn INTEGER NOT NULL,
      closed INTEGER NOT NULL,
      sent INTEGER NOT NULL)`);
    // The conversation each turn came from: its report goes back there.
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_machine_senders (
      task TEXT NOT NULL,
      turn INTEGER NOT NULL,
      session TEXT NOT NULL,
      PRIMARY KEY (task, turn))`);
    // Each open Codex task handed ky's ChatGPT login, and when the login it was last sent expires.
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_machine_logins (
      task TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL)`);
    // Reports owed to a conversation, from when a turn closes until it is posted there.
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_machine_reports (
      task TEXT NOT NULL,
      turn INTEGER NOT NULL,
      session TEXT NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (task, turn, session))`);
    // `sent`: the command went out on an open socket, so the runner may have it.
    const inbox = sql.exec<{ name: string }>("PRAGMA table_info(ky_machine_inbox)").toArray();

    if (!inbox.some((column) => column.name === "sent")) {
      sql.exec("ALTER TABLE ky_machine_inbox ADD COLUMN sent INTEGER NOT NULL DEFAULT 0");
    }

    const known = sql.exec<{ name: string }>("PRAGMA table_info(ky_machines)").toArray();

    if (!known.some((column) => column.name === "state")) {
      sql.exec("ALTER TABLE ky_machines ADD COLUMN state TEXT NOT NULL DEFAULT 'on'");
      sql.exec("ALTER TABLE ky_machines ADD COLUMN note TEXT NOT NULL DEFAULT ''");
      // JSON MachineFacts, as the runner last said them.
      sql.exec("ALTER TABLE ky_machines ADD COLUMN facts TEXT");
    }

    // The id of the machine's live pairing; null for a machine from before pairing, whose runner must pair.
    if (!known.some((column) => column.name === "pairing")) sql.exec("ALTER TABLE ky_machines ADD COLUMN pairing TEXT");

    if (!known.some((column) => column.name === "login")) sql.exec("ALTER TABLE ky_machines ADD COLUMN login TEXT NOT NULL DEFAULT 'own'");

    // Commands from before turns were numbered, which no runner accepts: their tasks end as interrupted
    // at the runner's next hello.
    sql.exec("DELETE FROM ky_machine_inbox WHERE json_extract(payload, '$.turn') IS NULL");
    // Runs from before they named an agent were all Claude Code's.
    sql.exec(
      `UPDATE ky_machine_inbox SET payload = json_set(payload, '$.agent', 'claude')
       WHERE json_extract(payload, '$.type') = 'run' AND json_extract(payload, '$.agent') IS NULL`
    );
    // Facts from before runners said what kind of machine they are, until the runner says hello again.
    sql.exec("UPDATE ky_machines SET facts = NULL WHERE json_extract(facts, '$.kind') IS NULL");
  }

  /** A task's turns; a task from before they were kept is on its first. */
  #turns(task: string): Turns {
    return (
      this.#sql
        .exec<Turns>("SELECT turn, closed, sent FROM ky_machine_turns WHERE task = ?", task)
        .toArray()[0] ?? { turn: 1, closed: 0, sent: 0 }
    );
  }

  #setTurns(task: string, turns: Partial<Turns>): void {
    // Read, merge, write with no await between: the object runs nothing else meanwhile.
    const next = { ...this.#turns(task), ...turns };
    this.#sql.exec(
      `INSERT INTO ky_machine_turns (task, turn, closed, sent) VALUES (?, ?, ?, ?)
       ON CONFLICT(task) DO UPDATE SET turn = excluded.turn, closed = excluded.closed, sent = excluded.sent`,
      task,
      next.turn,
      next.closed,
      next.sent
    );
  }

  /** Record that `session` sent the task's `turn`. */
  #sentBy(task: string, turn: number, session: string): void {
    this.#sql.exec(
      "INSERT OR REPLACE INTO ky_machine_senders (task, turn, session) VALUES (?, ?, ?)",
      task,
      turn,
      session
    );
  }

  /**
   * Who hears about turns `from` (exclusive) to `to`: everyone who sent one.
   * With no sender among them (a stop, a lost run), whoever sent the last
   * turn before; the main conversation for a task from before senders were kept.
   */
  #listeners(task: string, from: number, to: number): string[] {
    const senders = this.#sql
      .exec<{ session: string }>(
        "SELECT session FROM ky_machine_senders WHERE task = ? AND turn > ? AND turn <= ? GROUP BY session ORDER BY MIN(turn)",
        task,
        from,
        to
      )
      .toArray()
      .map((row) => row.session);

    return senders.length > 0 ? senders : [this.#lastSender(task, to)];
  }

  #lastSender(task: string, upTo = Number.MAX_SAFE_INTEGER): string {
    return (
      this.#sql
        .exec<{ session: string }>(
          "SELECT session FROM ky_machine_senders WHERE task = ? AND turn <= ? ORDER BY turn DESC LIMIT 1",
          task,
          upTo
        )
        .toArray()[0]?.session ?? ROOT_SESSION
    );
  }

  /** The harness reports go to, set once it exists; a task's report is dropped once its work is not `wanted`. */
  attach(harness: PiHarness, wanted: (task: string) => boolean = () => true): void {
    this.#harness = harness;
    this.#wanted = wanted;
  }

  online(machine: string): boolean {
    return this.#sockets(runnerTag(machine)).some((socket) => socket.readyState === OPEN);
  }

  machines(): MachineInfo[] {
    return this.#sql
      .exec<MachineRow>("SELECT name, seen_at, state, note, facts, login FROM ky_machines ORDER BY name")
      .toArray()
      .map((row) => ({
        name: row.name,
        online: this.online(row.name),
        seenAt: row.seen_at,
        active: this.#feed.open("machine", row.name).length,
        state: row.state,
        note: row.note,
        // SAFETY: only #onHello and paired write facts, each a checked MachineFacts.
        facts: row.facts === null ? null : (JSON.parse(row.facts) as MachineFacts),
        login: row.login
      }));
  }

  machine(name: string): MachineInfo | undefined {
    return this.machines().find((machine) => machine.name === name);
  }

  /** Call `listener` when the user's choices for a machine change. */
  onChange(listener: () => void): void {
    this.#watchers.add(listener);
  }

  /** Set whether ky may use a machine, or what it is for. Throws for a machine that never connected. */
  configure(name: string, change: MachineChange): MachineInfo {
    if (!this.machine(name)) throw new Error(`No machine ${name}.`);
    checkChange(change);

    if (change.state !== undefined) this.#sql.exec("UPDATE ky_machines SET state = ? WHERE name = ?", change.state, name);

    if (change.login !== undefined) this.#sql.exec("UPDATE ky_machines SET login = ? WHERE name = ?", change.login, name);

    if (change.note !== undefined) {
      this.#sql.exec("UPDATE ky_machines SET note = ? WHERE name = ?", change.note.trim().slice(0, NOTE_CHARS), name);
    }

    for (const watcher of this.#watchers) watcher();

    return this.machine(name)!;
  }

  /** A runner left. Only a machine whose runner said hello has a row to update. */
  seen(machine: string): void {
    this.#sql.exec("UPDATE ky_machines SET seen_at = ? WHERE name = ?", Date.now(), machine);
  }

  /**
   * Add a command and send every unacked one, in seq order. Sending only the
   * new one could overtake an older run still waiting for a hello; the
   * runner skips the seqs it has already handled.
   */
  #enqueue(machine: string, command: Queued): Promise<void> {
    this.#sql.exec("INSERT INTO ky_machine_inbox (machine, payload) VALUES (?, ?)", machine, JSON.stringify(command));

    return this.#deliver(machine);
  }

  /** Run `work` after the token work asked for before it; a failure is logged, then handed to `failed`. */
  #afterTokens(what: string, work: () => Promise<void>, failed: () => void = () => {}): Promise<void> {
    this.#tokenWork = this.#tokenWork.then(work).catch((error) => {
      console.warn(`${what} failed`, error);
      failed();
    });

    return this.#tokenWork;
  }

  /**
   * Deliver again after a failed issue, a few times, further apart each time;
   * the inbox keeps the runs meanwhile. A retry is a timer in memory, so an
   * eviction loses it. Then, as past the last retry, the runs wait for the
   * runner's next hello, which it says each time it connects, or the next
   * command for the machine.
   */
  #retry(machine: string): void {
    // One retry waits at a time: a delivery that fails meanwhile is the one it makes.
    if (this.#waiting.has(machine)) return;
    const tries = this.#retries.get(machine) ?? 0;

    if (tries >= DELIVERY_RETRIES) {
      this.#retries.delete(machine);

      return;
    }

    this.#retries.set(machine, tries + 1);
    this.#waiting.add(machine);
    setTimeout(() => {
      this.#waiting.delete(machine);
      void this.#deliver(machine);
    }, this.retryMs * 2 ** tries);
  }

  /**
   * Send the machine's unacked commands, each run with its task's token,
   * and with ky's subscription for its agent when the machine is handed it.
   * The tokens and logins are fetched first, then the inbox is read again,
   * so a run withdrawn meanwhile is not sent, and a run queued meanwhile
   * waits for the delivery its own enqueue starts. A creds command with no
   * ChatGPT login left to send is dropped.
   */
  #deliver(machine: string): Promise<void> {
    return this.#afterTokens(`delivery to ${machine}`, async () => {
      if (!this.online(machine)) {
        if (machine === CLOUD && this.#pending(machine).length > 0) this.cloud?.wake();

        return;
      }

      const info = this.machine(machine);
      const pending = this.#pending(machine);
      const tasks = new Set(pending.flatMap((command) => (command.type === "run" ? [command.task] : [])));

      const agents = new Set(
        pending.flatMap((command): Agent[] => {
          if (command.type === "creds") return ["codex"];

          return command.type === "run" && handsCreds(info, command.agent) ? [command.agent] : [];
        })
      );

      const [tokens, creds, github] = await Promise.all([
        Promise.all([...tasks].map(async (task) => [task, await this.#tokens.issue(task)] as const)).then((issued) => new Map(issued)),
        Promise.all([...agents].map((agent) => this.#creds(agent))).then((all): RunCreds => Object.assign({}, ...all)),
        info?.facts?.kind === "cloud" && tasks.size > 0 ? this.cloud?.github() : undefined
      ]);

      this.#send(machine, this.#outgoing(machine, tokens, github ? { ...creds, github } : creds, agents));
      this.#retries.delete(machine);
    }, () => this.#retry(machine));
  }

  /**
   * The machine's unacked commands as they are sent, read again after the
   * tokens and logins were fetched: up to the first run whose token wasn't.
   */
  #outgoing(machine: string, tokens: ReadonlyMap<string, string>, creds: RunCreds, agents: ReadonlySet<Agent>): RunnerCommand[] {
    const commands: RunnerCommand[] = [];

    for (const command of this.#pending(machine)) {
      if (command.type === "stop") commands.push(command);
      else if (command.type === "creds" && creds.codex) commands.push({ ...command, codex: creds.codex });
      else if (command.type === "creds") this.#sql.exec("DELETE FROM ky_machine_inbox WHERE seq = ?", command.seq);
      else if (!tokens.has(command.task)) break;
      else {
        const handed = agents.has(command.agent) ? creds[command.agent] : undefined;
        const run: RunnerCommand = { ...command, taskToken: tokens.get(command.task)! };
        const given: RunCreds = { ...(handed && { [command.agent]: handed }), ...(creds.github && { github: creds.github }) };

        commands.push(Object.keys(given).length > 0 ? { ...run, creds: given } : run);
      }
    }

    return commands;
  }

  /**
   * Queue the refreshed ChatGPT login for each open Codex task on `machine`
   * that was handed an older one. The Vault refreshes the login before it
   * expires, so the task's next request has a live token.
   */
  async #renew(machine: string): Promise<void> {
    const open = new Set(this.#feed.open("machine", machine).map((task) => task.id));

    const handed = this.#sql
      .exec<{ task: string; expires_at: number }>("SELECT task, expires_at FROM ky_machine_logins")
      .toArray()
      .filter((row) => open.has(row.task));

    if (handed.length === 0) return;
    const { codex } = await this.#creds("codex");

    if (!codex) return;
    const queued = new Set(this.#pending(machine).flatMap((command) => (command.type === "creds" ? [command.task] : [])));

    for (const { task, expires_at } of handed) {
      if (codex.expiresAt <= expires_at || queued.has(task)) continue;
      this.#sql.exec("INSERT INTO ky_machine_inbox (machine, payload) VALUES (?, ?)", machine, JSON.stringify({ type: "creds", task } satisfies Queued));
    }
  }

  #send(machine: string, commands: readonly RunnerCommand[]): void {
    for (const socket of this.#sockets(runnerTag(machine))) {
      if (socket.readyState !== OPEN) continue;

      for (const command of commands) {
        try {
          socket.send(JSON.stringify(command));
        } catch {
          // Closed meanwhile; the inbox keeps it for the next connect.
          continue;
        }

        this.#sent(command);
      }
    }
  }

  /**
   * Revoke the tokens of the tasks that are over, for a revoke a failure or
   * a restart lost. Over is what `#finish` revokes on: every turn reported
   * over, and no run of it in the inbox. A task stopped with a follow-up
   * queued shows as ended while that turn runs, so its status is not enough.
   * A task that ended longer than ISSUED_TTL_MS ago was last issued its
   * token before that, so the token has expired. Only this agent's tasks:
   * the Vault serves every agent object. It runs after the token work asked
   * for before it and reads the tasks then; a run sent after it is issued a
   * new token, so it revokes no token a run still needs.
   */
  sweepTokens(): Promise<void> {
    return this.#afterTokens("sweeping task tokens", () =>
      this.#tokens.revokeAll(this.#feed.closedSince("machine", Date.now() - ISSUED_TTL_MS).filter((task) => this.#over(task)))
    );
  }

  /** Whether every turn of the task is reported over and none of its runs waits in the inbox. */
  #over(task: string): boolean {
    const { turn, closed } = this.#turns(task);

    const queued = this.#sql
      .exec(
        "SELECT 1 FROM ky_machine_inbox WHERE json_extract(payload, '$.type') = 'run' AND json_extract(payload, '$.task') = ? LIMIT 1",
        task
      )
      .toArray();

    return closed >= turn && queued.length === 0;
  }

  /** The task's token stops working, once no turn of it is left to run. */
  #revoke(task: string): Promise<void> {
    return this.#afterTokens(`revoking ${task}'s token`, () => this.#tokens.revoke(task));
  }

  /**
   * The runner may have this command now: a run can no longer be withdrawn,
   * and a stop must wait for the runner to say how the turn ended.
   */
  #sent(command: RunnerCommand): void {
    this.#sql.exec("UPDATE ky_machine_inbox SET sent = 1 WHERE seq = ?", command.seq);
    const codex = command.type === "creds" ? command.codex : command.type === "run" ? command.creds?.codex : undefined;

    if (codex) {
      this.#sql.exec(
        `INSERT INTO ky_machine_logins (task, expires_at) VALUES (?, ?)
         ON CONFLICT(task) DO UPDATE SET expires_at = MAX(expires_at, excluded.expires_at)`,
        command.task,
        codex.expiresAt
      );
    }

    if (command.type === "run" && command.turn > this.#turns(command.task).sent) {
      this.#setTurns(command.task, { sent: command.turn });
    }
  }

  #pending(machine: string): Pending[] {
    return this.#sql
      .exec<{ seq: number; payload: string }>(
        "SELECT seq, payload FROM ky_machine_inbox WHERE machine = ? ORDER BY seq",
        machine
      )
      .toArray()
      .map((row): Pending => {
        // SAFETY: only #enqueue writes payloads, each a Queued command.
        const command = JSON.parse(row.payload) as Queued;

        return { ...command, seq: row.seq };
      });
  }

  /** The agent a new task on `machine` runs as when none is named. */
  defaultAgent(machine: string): Agent {
    return defaultAgent(this.machine(machine)?.facts ?? null);
  }

  /**
   * Start a task for the conversation `parent`, which hears how it ends. A
   * repeated id returns the task it already started, without running it again.
   */
  start(
    machine: string,
    title: string,
    prompt: string,
    id: string,
    parent: string,
    source = "chat",
    agent = this.defaultAgent(machine)
  ): TaskRow {
    const existed = this.#feed.get(id) !== undefined;

    const task = this.#feed.create({
      id,
      kind: "machine",
      source,
      worker: machine,
      title,
      status: "queued",
      session: null,
      agent
    });

    if (!existed) {
      this.#setTurns(id, { turn: 1, closed: 0, sent: 0 });
      this.#sentBy(id, 1, parent);
      void this.#enqueue(machine, runCommand(id, 1, prompt, null, agent));
    }

    return task;
  }

  /**
   * Steer a running task, or resume a finished one, as its next turn, for
   * the conversation `parent`; by default, the one that sent its last turn.
   */
  send(task: TaskRow, message: string, parent = this.#lastSender(task.id)): void {
    const turn = this.#turns(task.id).turn + 1;
    this.#setTurns(task.id, { turn });
    this.#sentBy(task.id, turn, parent);
    this.#feed.update(task.id, { status: task.status === "working" ? "working" : "queued" });
    // SAFETY: every machine task names its agent: start sets it, and the feed set it on older ones.
    void this.#enqueue(task.worker, runCommand(task.id, turn, message, task.session, task.agent!));
  }

  /**
   * Move a task the runner has never been sent to another machine, which
   * must run its agent; why not, otherwise. Once a turn reached a runner,
   * its session lives on that machine's disk, so the task stays there.
   */
  move(task: TaskRow, to: string): string | null {
    if (task.worker === to) return `${task.id} is already on ${to}.`;

    if (task.status !== "queued" || this.#turns(task.id).sent > 0) {
      return `${task.id} has already run on ${task.worker}, and its session lives there, so it stays. Start a new task on ${to} with what it needs.`;
    }

    // SAFETY: as in send.
    const refusal = cannotRun(this.machine(to), task.agent!);

    if (refusal) return `${refusal} ${task.id} runs as ${AGENT_NAMES[task.agent!]}, so it stays.`;

    const commands = this.#sql
      .exec<{ seq: number; payload: string }>(
        "SELECT seq, payload FROM ky_machine_inbox WHERE machine = ? AND sent = 0 AND json_extract(payload, '$.task') = ? ORDER BY seq",
        task.worker,
        task.id
      )
      .toArray();

    for (const command of commands) {
      this.#sql.exec("DELETE FROM ky_machine_inbox WHERE seq = ?", command.seq);
      this.#sql.exec("INSERT INTO ky_machine_inbox (machine, payload) VALUES (?, ?)", to, command.payload);
    }

    this.#feed.reassign(task.id, to);
    // A token issued for a run that was withdrawn before it was sent: the task starts afresh on `to`.
    void this.#revoke(task.id);
    void this.#deliver(to);

    return null;
  }

  /**
   * Stop a task. Runs never sent to the runner are withdrawn. If no open
   * turn ever reached the runner, the task ends here; otherwise the runner
   * gets a stop and its result ends the task, since a run already sent may
   * be running whatever the inbox says.
   */
  async stop(task: TaskRow): Promise<void> {
    const { turn, closed, sent } = this.#turns(task.id);

    // Open turns, not the status: a follow-up queued behind a finished turn leaves the task done until it starts.
    if (turn <= closed) return;

    const withdrawn = this.#sql.exec(
      `DELETE FROM ky_machine_inbox WHERE machine = ? AND sent = 0
         AND json_extract(payload, '$.type') = 'run' AND json_extract(payload, '$.task') = ?`,
      task.worker,
      task.id
    ).rowsWritten;

    if (withdrawn > 0 && sent <= closed) {
      await this.#finish(task.id, false, "Stopped before it started.", turn);

      return;
    }

    await this.#enqueue(task.worker, { type: "stop", task: task.id, turn });
  }

  /**
   * Forget a machine the user removed: its tasks end, their tokens stop
   * working, and what waited for it is dropped. Its runner must pair again.
   */
  async remove(machine: string): Promise<string | null> {
    // First, before any await: from here a runner of this machine is refused.
    const pairing = this.#sql
      .exec<{ pairing: string | null }>("DELETE FROM ky_machines WHERE name = ? RETURNING pairing", machine)
      .toArray()[0]?.pairing ?? null;

    this.#sql.exec("DELETE FROM ky_machine_inbox WHERE machine = ?", machine);

    for (const task of this.#feed.open("machine", machine)) {
      await this.#finish(task.id, false, `${machine} was removed from ky.`, this.#turns(task.id).turn);
    }

    for (const watcher of this.#watchers) watcher();

    return pairing;
  }

  /**
   * A runner paired as `machine` with the pairing id `pairing`: it is listed
   * from now, with what it said it is, keeping what the user chose for it.
   * Returns the pairing it replaces, whose token the caller revokes.
   */
  paired(machine: string, facts: MachineFacts, pairing: string): string | null {
    const previous = this.#pairing(machine);

    this.#sql.exec(
      `INSERT INTO ky_machines (name, seen_at, facts, pairing) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET seen_at = excluded.seen_at, facts = excluded.facts, pairing = excluded.pairing`,
      machine,
      Date.now(),
      JSON.stringify(facts),
      pairing
    );

    for (const watcher of this.#watchers) watcher();

    return previous;
  }

  /** List the cloud machine, unpaired until it first starts, so tasks can be sent to it while it sleeps. */
  listCloud(): void {
    const listed = this.#sql.exec("INSERT OR IGNORE INTO ky_machines (name, seen_at, facts) VALUES (?, ?, ?)", CLOUD, Date.now(), JSON.stringify(CLOUD_FACTS));

    if (listed.rowsWritten > 0) for (const watcher of this.#watchers) watcher();
  }

  /** Whether `machine` has an open task or a command waiting: the cloud machine stays awake while it has. */
  busy(machine: string): boolean {
    return this.#feed.open("machine", machine).length > 0 || this.#pending(machine).length > 0;
  }

  /** Whether `machine` is paired, and `pairing` is its live pairing: a runner's socket is the machine's only then. */
  pairedAs(machine: string, pairing: string | undefined): boolean {
    return pairing !== undefined && this.#pairing(machine) === pairing;
  }

  #pairing(machine: string): string | null {
    return this.#sql.exec<{ pairing: string | null }>("SELECT pairing FROM ky_machines WHERE name = ?", machine).toArray()[0]?.pairing ?? null;
  }

  /** A runner said hello, running the tasks in `active`: end the ones it lost, then resend what it has not acked. */
  async #onHello(machine: string, active: readonly string[], facts: MachineFacts): Promise<void> {
    // Only pairing makes a machine; the socket checked the pairing before this hello came.
    this.#sql.exec("UPDATE ky_machines SET seen_at = ?, facts = ? WHERE name = ?", Date.now(), JSON.stringify(facts), machine);

    // An open task the runner is not running is over, unless one of its runs is still unacked:
    // the socket is in order, so every run the runner had seen when it said hello was acked first.
    const unacked = new Set(
      this.#pending(machine).flatMap((command) => (command.type === "run" ? [command.task] : []))
    );

    const lost = this.#feed
      .open("machine", machine)
      .filter((task) => !unacked.has(task.id) && !active.includes(task.id));

    for (const task of lost) {
      await this.#finish(
        task.id,
        false,
        "Interrupted: the runner restarted. Send it a message to resume.",
        this.#turns(task.id).turn
      );
    }

    try {
      await this.#renew(machine);
    } catch (error) {
      // The Vault failed; the next hello asks again.
      console.warn(`renewing ChatGPT logins on ${machine} failed`, error);
    }

    await this.#deliver(machine);
  }

  async onReport(machine: string, report: TaskReport): Promise<void> {
    if (report.type === "hello") return this.#onHello(machine, report.active, report.facts);

    if (report.type === "ack") {
      this.#sql.exec("DELETE FROM ky_machine_inbox WHERE machine = ? AND seq = ?", machine, report.seq);

      return;
    }

    if (this.#closed(report.task, report.turn)) return;

    switch (report.type) {
      case "session":
        this.#feed.update(report.task, { session: report.session, status: "working" });

        return;
      case "step":
        this.#feed.step(report.task, report.text);

        return;
      case "result":
        if (report.session) this.#feed.update(report.task, { session: report.session });

        if (report.turns !== undefined || report.costUsd !== undefined) {
          this.#feed.spend(report.task, report.turns ?? 0, report.costUsd ?? 0);
        }

        await this.#finish(report.task, report.ok, report.text, report.turn);
    }
  }

  /** Whether `turn` is already reported over: what the runner says about it is late. */
  #closed(task: string, turn: number): boolean {
    return turn <= this.#turns(task).closed;
  }

  /**
   * Report every turn up to `turn` as over, once: a turn already closed is
   * not reported again. The report is owed to everyone who sent one of
   * those turns from the moment the turn closes, and posted to each.
   */
  async #finish(id: string, ok: boolean, text: string, turn: number): Promise<void> {
    const task = this.#feed.get(id);

    if (!task || this.#closed(id, turn)) return;
    const turns = this.#turns(id);
    const from = turns.closed;
    this.#setTurns(id, { closed: turn });

    // A turn sent after this one is still to run, with the same token and login.
    if (turn === turns.turn) {
      void this.#revoke(id);
      this.#sql.exec("DELETE FROM ky_machine_logins WHERE task = ?", id);
    }

    const ended = endOf(ok, text);
    this.#feed.update(id, { status: ended.status, summary: summarize(text) || (ok ? "Done" : "Failed") });

    if (ok) this.#feed.describe(id, text);
    const report = `[machine ${task.worker}, task ${id} "${task.title}" ${ended.word}, no reply needed unless the user is waiting on it]\n${text}${sharedLine(this.#files.forTask(id))}`;

    for (const session of this.#listeners(id, from, turn)) {
      this.#sql.exec(
        "INSERT OR IGNORE INTO ky_machine_reports (task, turn, session, text) VALUES (?, ?, ?, ?)",
        id,
        turn,
        session,
        report
      );
    }

    await this.post(id);
  }

  /**
   * Post the reports still owed, for one task or all of them, and forget
   * each once its conversation has it. A report's operation id is its turn
   * and conversation, so posting one twice adds it once.
   */
  async post(task?: string): Promise<void> {
    if (!this.#harness) return;

    type Owed = { task: string; turn: number; session: string; text: string };

    const owed = (
      task === undefined
        ? this.#sql.exec<Owed>("SELECT * FROM ky_machine_reports ORDER BY task, turn")
        : this.#sql.exec<Owed>("SELECT * FROM ky_machine_reports WHERE task = ? ORDER BY turn", task)
    ).toArray();

    for (const report of owed) {
      // A report nobody wants any more, like a paused automation's, is forgotten unposted.
      if (this.#wanted(report.task)) {
        try {
          await this.#harness.submit(report.text, {
            session: report.session,
            operationId: `task:${report.task}:${report.turn}:${report.session}`,
            whenBusy: "steer"
          });
        } catch (error) {
          // Kept, and posted again when the object next starts.
          console.warn(`report for ${report.task} turn ${report.turn} not posted`, error);
          continue;
        }
      }

      this.#sql.exec(
        "DELETE FROM ky_machine_reports WHERE task = ? AND turn = ? AND session = ?",
        report.task,
        report.turn,
        report.session
      );
    }
  }
}

/** How a task's last turn ended: its status, and the word its report uses. */
function endOf(ok: boolean, text: string) {
  if (ok) return { status: "done", word: "finished" } as const;

  return /\b(stopped|interrupted by user)\b/i.test(text)
    ? ({ status: "stopped", word: "stopped" } as const)
    : ({ status: "failed", word: "failed" } as const);
}

/** The line naming a task's shared files under its report, or nothing. */
function sharedLine(files: readonly FileRow[]): string {
  if (files.length === 0) return "";

  return `\n\nShared with the user, shown under this report: ${files.map((file) => file.caption ?? file.name).join("; ")}`;
}

const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });

/** Which agents a machine runs, and each it has but is not signed in to: "runs Codex, Claude Code not signed in". */
function agentsOf(facts: MachineFacts): string[] {
  const running = PREFERRED.flatMap((agent) => (runs(facts, agent) ? [AGENT_NAMES[agent]] : []));

  const signedOut = PREFERRED.flatMap((agent) =>
    facts.agents[agent].installed && !facts.agents[agent].signedIn ? [`${AGENT_NAMES[agent]} not signed in`] : []
  );

  return [running.length > 0 ? `runs ${running.join(" and ")}` : "runs no agent", ...signedOut];
}

/** A machine as the agent reads it: what the user allows, whether it is up, how busy, what it is, and its repos. */
function describeMachine(machine: MachineInfo): string {
  const parts = [
    machine.state,
    machine.online ? "online" : machine.facts?.kind === "cloud" ? "asleep (wakes for a task in a minute or two)" : "offline",
    `${machine.active} running or queued`,
    ...(machine.facts
      ? [
          osName(machine.facts.os),
          machine.facts.chrome ? "Chrome with the user's logins" : "no logged-in browser",
          ...agentsOf(machine.facts)
        ]
      : [])
  ];

  const lines = [`${machine.name}: ${parts.join(", ")}`];

  if (machine.facts?.kind === "cloud") {
    lines.push("  ky's own Linux machine in Cloudflare: no local files of the user's; it clones from GitHub, and pushes only to ky/* branches of the repos the user picked");
  }

  if (machine.note !== "") lines.push(`  the user says: ${machine.note}`);

  if (machine.facts && machine.facts.repos.length > 0) {
    lines.push(`  repos: ${machine.facts.repos.map((repo) => (repo.remote ? `${repo.name} (${repo.remote})` : repo.name)).join(", ")}`);
  }

  return lines.join("\n");
}

const describeAll = (machines: readonly MachineInfo[]) =>
  machines.length === 0 ? "No machines yet. The user adds one in Settings, under Machines, and runs the `ky runner add` command it shows on that computer." : machines.map(describeMachine).join("\n");

/** The machines a task could go to now, for a refusal or an offline start to offer instead. */
function elsewhere(machines: readonly MachineInfo[], not: string): string {
  const ready = machines.filter((machine) => machine.name !== not && machine.state === "on" && machine.online);

  return ready.length === 0
    ? "No other machine is on and online."
    : `On and online: ${ready.map((machine) => `${machine.name} (${machine.active} running or queued)`).join(", ")}.`;
}

/** Each machine and its recent tasks. */
function listAll(machines: readonly MachineInfo[], feed: TaskFeed): string {
  if (machines.length === 0) return describeAll(machines);

  return machines
    .map((m) => {
      const tasks = feed
        .list(200)
        .filter((t) => t.kind === "machine" && t.worker === m.name)
        .slice(0, 8)
        // SAFETY: as in MachineHub.send.
        .map((t) => `  ${t.id} [${t.status}] ${AGENT_NAMES[t.agent!]}: ${t.title}${t.summary ? ` — ${t.summary}` : ""}`);

      return [describeMachine(m), ...tasks].join("\n");
    })
    .join("\n");
}

/** The user's change to a machine, made by the agent when they ask. */
function setMachine(hub: MachineHub, machines: readonly MachineInfo[], name: string | undefined, change: MachineChange): string {
  if (!name) return `set needs a machine.\n${describeAll(machines)}`;

  if (change.state === undefined && change.note === undefined) return "set needs a state or a note.";

  try {
    return `Set. ${describeMachine(hub.configure(name, change))}`;
  } catch (error) {
    return `${error instanceof Error ? error.message : String(error)}\n${describeAll(machines)}`;
  }
}

/** The machine a new task goes to: the one named, or the only one on and online; else why not. */
function pickMachine(machines: readonly MachineInfo[], requested: string | undefined): { name: string } | { refusal: string } {
  const ready = machines.filter((m) => m.state === "on" && m.online);
  const name = requested ?? (ready.length === 1 ? ready[0]!.name : undefined);

  if (!name) {
    return {
      refusal:
        ready.length === 0
          ? `No machine is on and online; name one to queue the task for it.\n${describeAll(machines)}`
          : `Name the machine for this task.\n${describeAll(machines)}`
    };
  }

  const target = machines.find((m) => m.name === name);

  if (target && target.state !== "on") {
    return { refusal: `${name} is ${target.state}: the user is not letting it take new tasks. ${elsewhere(machines, name)}` };
  }

  return { name };
}

/** What the agent hears after starting a task: where it runs and as what, or that it waits and where else it could go. */
function startedOn(hub: MachineHub, machines: readonly MachineInfo[], task: TaskRow): string {
  // SAFETY: start names the agent.
  const started = `Started task ${task.id} on ${task.worker} as ${AGENT_NAMES[task.agent!]}`;

  if (hub.online(task.worker)) return `${started}.`;

  if (hub.machine(task.worker)?.facts?.kind === "cloud") return `${started} (asleep: it wakes for the task in a minute or two).`;

  const waiting = machines.some((m) => m.name === task.worker)
    ? `offline: it starts when ${task.worker} connects`
    : `no machine named ${task.worker} has connected yet: it starts when one does`;

  return `${started} (${waiting}). ${elsewhere(machines, task.worker)} move sends it elsewhere.`;
}

function moveTask(hub: MachineHub, machines: readonly MachineInfo[], task: TaskRow, to: string | undefined): string {
  if (!to) return `move needs a machine.\n${describeAll(machines)}`;
  const target = machines.find((m) => m.name === to);

  if (!target) return `No machine ${to}.\n${describeAll(machines)}`;

  if (target.state !== "on") return `${target.name} is ${target.state}: it takes no new tasks. ${elsewhere(machines, task.worker)}`;

  return hub.move(task, target.name) ?? `Moved ${task.id} to ${target.name}${target.online ? "" : " (offline: it starts when it connects)"}.`;
}

/** What the tool was called with. */
type MachineArgs = {
  action: "list" | "run" | "send" | "stop" | "move" | "set";
  machine?: string;
  agent?: Agent;
  title?: string;
  prompt?: string;
  task?: string;
  message?: string;
  state?: MachineState;
  note?: string;
};

function changeOf(args: MachineArgs): MachineChange {
  const change: MachineChange = {};

  if (args.state !== undefined) change.state = args.state;

  if (args.note !== undefined) change.note = args.note;

  return change;
}

function runTask(hub: MachineHub, feed: TaskFeed, machines: readonly MachineInfo[], args: MachineArgs, id: string, conversation: string): string {
  const picked = pickMachine(machines, args.machine);

  if ("refusal" in picked) return picked.refusal;

  if (!args.prompt?.trim()) return "run needs a prompt.";
  const agent = args.agent ?? hub.defaultAgent(picked.name);
  const refusal = cannotRun(machines.find((m) => m.name === picked.name), agent);

  if (refusal) return `${refusal} ${elsewhere(machines, picked.name)}`;
  const task = hub.start(picked.name, args.title ?? summarize(args.prompt).slice(0, 60), args.prompt, id, conversation, "chat", agent);

  if (args.title === undefined) feed.name(task.id, args.prompt);

  return startedOn(hub, machines, task);
}

/** Steer or resume a task, unless the user has turned its machine off. */
function sendTask(hub: MachineHub, task: TaskRow, message: string | undefined, conversation: string): string {
  // A blank one would end Codex's resumed turn with nothing to run.
  if (!message?.trim()) return "send needs a message.";

  if (hub.machine(task.worker)?.state === "off") {
    return `${task.worker} is off: the user is not letting it take anything. Start a new task elsewhere with what ${task.id} needs.`;
  }

  hub.send(task, message, conversation);

  if (task.status !== "working") return `Resuming ${task.id} with your message.`;

  // SAFETY: as in MachineHub.send.
  return STEERS.has(task.agent!) ? `Steering ${task.id}.` : `Queued for ${task.id}: ${AGENT_NAMES[task.agent!]} takes it once its turn ends.`;
}

/** stop, move or send, on a task already started. */
async function onTask(hub: MachineHub, feed: TaskFeed, machines: readonly MachineInfo[], args: MachineArgs, conversation: string): Promise<string> {
  const task = args.task ? feed.get(args.task) : undefined;

  if (!task || task.kind !== "machine") return `No machine task ${args.task ?? ""}.`;

  if (args.action === "stop") {
    await hub.stop(task);

    return `Stopping ${task.id}.`;
  }

  if (args.action === "move") return moveTask(hub, machines, task, args.machine);

  return sendTask(hub, task, args.message, conversation);
}

export function machineExtension(hub: MachineHub, feed: TaskFeed): Extension {
  return defineExtension({
    name: "machines",
    tools: [
      defineTool({
        name: "machine",
        description:
          "Run tasks on the user's real computers, each as a Claude Code or Codex session with a shell, files, scripts, installed tools and a real browser. " +
          "Use it only when the user asks for a machine, or for what the cloud cannot do: web pages that need the user's logins (have a subagent try Exa search and browse first), running scripts or builds, touching local files. " +
          "Choose the machine by what the user said about it, which one has the repos the task needs, which one has Chrome with the user's logins when the task needs them, and how busy each is. Only a machine that is on takes new tasks. " +
          "Actions: list (each machine: on, paused or off; online; how busy; OS; Chrome; which agents it runs; repos; the user's note, and its recent tasks). " +
          "run (title, prompt, machine, agent): start a task; name the machine unless only one is on and online; the prompt must be self-contained; agent only when the user asks for one, else the machine's own, Claude Code first. " +
          "send (task, message): steer a working task, or resume a finished one with its history; it goes to the task's own agent. Codex takes no message mid-turn: one sent to a working Codex task runs once its turn ends. " +
          "stop (task): stop it; send resumes it later. " +
          "move (task, machine): send a task that has not started yet to another machine that runs its agent, such as when its machine is offline. " +
          "set (machine, state, note): only when the user asks; state on, paused (finishes its tasks, takes no new ones) or off (takes nothing from you); note says what it is for. " +
          "Results are reported back to this conversation as messages when they arrive; do not poll.",
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal("list"),
            Type.Literal("run"),
            Type.Literal("send"),
            Type.Literal("stop"),
            Type.Literal("move"),
            Type.Literal("set")
          ]),
          machine: Type.Optional(Type.String()),
          agent: Type.Optional(Type.Union([Type.Literal("claude"), Type.Literal("codex")], { description: "claude (Claude Code) or codex (Codex)." })),
          title: Type.Optional(Type.String({ description: "3-6 words for the task list." })),
          prompt: Type.Optional(Type.String()),
          task: Type.Optional(Type.String({ description: "A task id from run or list." })),
          message: Type.Optional(Type.String()),
          state: Type.Optional(Type.Union([Type.Literal("on"), Type.Literal("paused"), Type.Literal("off")])),
          note: Type.Optional(Type.String({ description: "What the machine is for, in the user's words; empty clears it." }))
        }),
        replay: "unsafe",
        execute: async (args, api) => {
          const machines = hub.machines();
          const conversation = String(api.conversationId);

          if (args.action === "list") return reply(listAll(machines, feed));

          if (args.action === "set") return reply(setMachine(hub, machines, args.machine, changeOf(args)));

          // Model call ids repeat across turns (Kimi: functions.machine:0); pi's task id does not.
          if (args.action === "run") return reply(runTask(hub, feed, machines, args, `m-${String(api.taskId)}`, conversation));

          return reply(await onTask(hub, feed, machines, args, conversation));
        }
      })
    ]
  });
}
