import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type Extension
} from "@earendil-works/pi-durable";
import { type PiHarness, ROOT_SESSION } from "agents/harness/pi";
import type { FileRow, FileStore } from "./files";
import { type MachineInfo, osName } from "./protocol";
import type { MachineFacts, RunnerCommand, TaskReport, UnnumberedCommand } from "./runner-protocol";
import { summarize, type TaskFeed, type TaskRow } from "./tasks";

/**
 * Machines: computers that run work for the main agent, such as the user's
 * Mac. A machine runs `runner/ky-runner.ts`, which dials into this object
 * over a WebSocket (`/runner/<name>`), so nothing on the machine listens on
 * a port. Each task runs as a Claude Code session on that machine, with its
 * shell, browser, files and the user's own Claude login.
 *
 * What the runner must do is kept in an inbox table until it acknowledges
 * it, so a message sent while the machine is offline is delivered when it
 * reconnects. Each finished turn is recorded in the task feed and posted as
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

/** What the user changes about a machine: whether ky may use it, and what it is for. */
export type MachineChange = { state?: MachineState; note?: string };

const NOTE_CHARS = 200;

type MachineRow = { name: string; seen_at: number; state: MachineState; note: string; facts: string | null };

/** A run's `taskToken` until runner-auth mints one per task; the runner does not read it yet. */
const NO_TASK_TOKEN = "";

/** A turn for the runner to run. Every task is a Claude Code session for now. */
function runCommand(task: string, turn: number, prompt: string, session: string | null): UnnumberedCommand {
  return { type: "run", task, turn, prompt, session, agent: "claude", taskToken: NO_TASK_TOKEN };
}

export class MachineHub {
  readonly #sql: SqlStorage;
  readonly #feed: TaskFeed;
  readonly #sockets: (tag: string) => WebSocket[];
  readonly #files: FileStore;
  readonly #watchers = new Set<() => void>();
  #harness: PiHarness | undefined;
  #wanted: (task: string) => boolean = () => true;

  constructor(
    sql: SqlStorage,
    feed: TaskFeed,
    sockets: (tag: string) => WebSocket[],
    /** Files tasks share; a report lists them so the agent can mention them. */
    files: FileStore
  ) {
    this.#sql = sql;
    this.#feed = feed;
    this.#sockets = sockets;
    this.#files = files;
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

    // Commands from before turns were numbered, which no runner accepts: their tasks end as interrupted
    // at the runner's next hello.
    sql.exec("DELETE FROM ky_machine_inbox WHERE json_extract(payload, '$.turn') IS NULL");
    // Runs from before they named an agent were all Claude Code's, with no task token.
    sql.exec(
      `UPDATE ky_machine_inbox SET payload = json_set(payload, '$.agent', 'claude', '$.taskToken', '')
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
      .exec<MachineRow>("SELECT name, seen_at, state, note, facts FROM ky_machines ORDER BY name")
      .toArray()
      .map((row) => ({
        name: row.name,
        online: this.online(row.name),
        seenAt: row.seen_at,
        active: this.#feed.open("machine", row.name).length,
        state: row.state,
        note: row.note,
        // SAFETY: only #onHello writes facts, each a decoded MachineFacts.
        facts: row.facts === null ? null : (JSON.parse(row.facts) as MachineFacts)
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

    if (change.state !== undefined && !MACHINE_STATES.includes(change.state)) {
      throw new Error(`A machine is on, paused or off, not ${JSON.stringify(change.state)}.`);
    }

    if (change.state !== undefined) this.#sql.exec("UPDATE ky_machines SET state = ? WHERE name = ?", change.state, name);

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
  #enqueue(machine: string, command: UnnumberedCommand): void {
    this.#sql.exec("INSERT INTO ky_machine_inbox (machine, payload) VALUES (?, ?)", machine, JSON.stringify(command));
    this.#deliver(machine, this.#pending(machine));
  }

  #deliver(machine: string, commands: readonly RunnerCommand[]): void {
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
   * The runner may have this command now: a run can no longer be withdrawn,
   * and a stop must wait for the runner to say how the turn ended.
   */
  #sent(command: RunnerCommand): void {
    this.#sql.exec("UPDATE ky_machine_inbox SET sent = 1 WHERE seq = ?", command.seq);

    if (command.type === "run" && command.turn > this.#turns(command.task).sent) {
      this.#setTurns(command.task, { sent: command.turn });
    }
  }

  #pending(machine: string): RunnerCommand[] {
    return this.#sql
      .exec<{ seq: number; payload: string }>(
        "SELECT seq, payload FROM ky_machine_inbox WHERE machine = ? ORDER BY seq",
        machine
      )
      .toArray()
      .map((row): RunnerCommand => {
        // SAFETY: only #enqueue writes payloads, each a RunnerCommand without its seq.
        const command = JSON.parse(row.payload) as UnnumberedCommand;

        return { ...command, seq: row.seq };
      });
  }

  /**
   * Start a task for the conversation `parent`, which hears how it ends. A
   * repeated id returns the task it already started, without running it again.
   */
  start(machine: string, title: string, prompt: string, id: string, parent: string, source = "chat"): TaskRow {
    const existed = this.#feed.get(id) !== undefined;

    const task = this.#feed.create({
      id,
      kind: "machine",
      source,
      worker: machine,
      title,
      status: "queued",
      session: null
    });

    if (!existed) {
      this.#setTurns(id, { turn: 1, closed: 0, sent: 0 });
      this.#sentBy(id, 1, parent);
      this.#enqueue(machine, runCommand(id, 1, prompt, null));
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
    this.#enqueue(task.worker, runCommand(task.id, turn, message, task.session));
  }

  /**
   * Move a task the runner has never been sent to another machine; why not,
   * otherwise. Once a turn reached a runner, its Claude Code session lives
   * on that machine's disk, so the task stays there.
   */
  move(task: TaskRow, to: string): string | null {
    if (task.worker === to) return `${task.id} is already on ${to}.`;

    if (task.status !== "queued" || this.#turns(task.id).sent > 0) {
      return `${task.id} has already run on ${task.worker}, and its session lives there, so it stays. Start a new task on ${to} with what it needs.`;
    }

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
    this.#deliver(to, this.#pending(to));

    return null;
  }

  /**
   * Stop a task. Runs never sent to the runner are withdrawn. If no open
   * turn ever reached the runner, the task ends here; otherwise the runner
   * gets a stop and its result ends the task, since a run already sent may
   * be running whatever the inbox says.
   */
  async stop(task: TaskRow): Promise<void> {
    if (task.status !== "queued" && task.status !== "working") return;

    const withdrawn = this.#sql.exec(
      `DELETE FROM ky_machine_inbox WHERE machine = ? AND sent = 0
         AND json_extract(payload, '$.type') = 'run' AND json_extract(payload, '$.task') = ?`,
      task.worker,
      task.id
    ).rowsWritten;

    const { turn, closed, sent } = this.#turns(task.id);

    if (withdrawn > 0 && sent <= closed) {
      await this.#finish(task.id, false, "Stopped before it started.", turn);

      return;
    }

    this.#enqueue(task.worker, { type: "stop", task: task.id, turn });
  }

  /** A runner said hello, running the tasks in `active`: end the ones it lost, then resend what it has not acked. */
  async #onHello(machine: string, active: readonly string[], facts: MachineFacts): Promise<void> {
    // A valid hello is what makes a machine: a socket that never says one leaves no row.
    this.#sql.exec(
      `INSERT INTO ky_machines (name, seen_at, facts) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET seen_at = excluded.seen_at, facts = excluded.facts`,
      machine,
      Date.now(),
      JSON.stringify(facts)
    );

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

    this.#deliver(machine, this.#pending(machine));
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
    const from = this.#turns(id).closed;
    this.#setTurns(id, { closed: turn });
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

/** Nothing when Claude Code can run tasks here; else why it cannot. */
function claudeCaveat(claude: MachineFacts["agents"]["claude"]): string[] {
  if (!claude.installed) return ["Claude Code not installed"];

  return claude.signedIn ? [] : ["Claude Code not signed in"];
}

/** A machine as the agent reads it: what the user allows, whether it is up, how busy, what it is, and its repos. */
function describeMachine(machine: MachineInfo): string {
  const parts = [
    machine.state,
    machine.online ? "online" : "offline",
    `${machine.active} running or queued`,
    ...(machine.facts
      ? [
          osName(machine.facts.os),
          machine.facts.chrome ? "Chrome with the user's logins" : "no logged-in browser",
          ...claudeCaveat(machine.facts.agents.claude)
        ]
      : [])
  ];

  const lines = [`${machine.name}: ${parts.join(", ")}`];

  if (machine.note !== "") lines.push(`  the user says: ${machine.note}`);

  if (machine.facts && machine.facts.repos.length > 0) {
    lines.push(`  repos: ${machine.facts.repos.map((repo) => (repo.remote ? `${repo.name} (${repo.remote})` : repo.name)).join(", ")}`);
  }

  return lines.join("\n");
}

const describeAll = (machines: readonly MachineInfo[]) =>
  machines.length === 0 ? "No machines have connected yet. The user starts one with runner/ky-runner.ts." : machines.map(describeMachine).join("\n");

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
        .map((t) => `  ${t.id} [${t.status}] ${t.title}${t.summary ? ` — ${t.summary}` : ""}`);

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

/** What the agent hears after starting a task: where it runs, or that it waits and where else it could go. */
function startedOn(hub: MachineHub, machines: readonly MachineInfo[], task: string, machine: string): string {
  if (hub.online(machine)) return `Started task ${task} on ${machine}.`;

  const waiting = machines.some((m) => m.name === machine)
    ? `offline: it starts when ${machine} connects`
    : `no machine named ${machine} has connected yet: it starts when one does`;

  return `Started task ${task} on ${machine} (${waiting}). ${elsewhere(machines, machine)} move sends it elsewhere.`;
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

  if (!args.prompt) return "run needs a prompt.";
  const task = hub.start(picked.name, args.title ?? summarize(args.prompt).slice(0, 60), args.prompt, id, conversation);

  if (args.title === undefined) feed.name(task.id, args.prompt);

  return startedOn(hub, machines, task.id, picked.name);
}

/** Steer or resume a task, unless the user has turned its machine off. */
function sendTask(hub: MachineHub, task: TaskRow, message: string | undefined, conversation: string): string {
  if (!message) return "send needs a message.";

  if (hub.machine(task.worker)?.state === "off") {
    return `${task.worker} is off: the user is not letting it take anything. Start a new task elsewhere with what ${task.id} needs.`;
  }

  hub.send(task, message, conversation);

  return task.status === "working" ? `Steering ${task.id}.` : `Resuming ${task.id} with your message.`;
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
          "Run tasks on the user's real computers, each as a Claude Code session with a shell, files, scripts, installed tools and a real browser. " +
          "Use it only when the user asks for a machine, or for what the cloud cannot do: web pages that need the user's logins (have a subagent try Exa search and browse first), running scripts or builds, touching local files. " +
          "Choose the machine by what the user said about it, which one has the repos the task needs, which one has Chrome with the user's logins when the task needs them, and how busy each is. Only a machine that is on takes new tasks. " +
          "Actions: list (each machine: on, paused or off; online; how busy; OS; Chrome; repos; the user's note, and its recent tasks). " +
          "run (title, prompt, machine): start a task; name the machine unless only one is on and online; the prompt must be self-contained. " +
          "send (task, message): steer a working task, or resume a finished one with its history. " +
          "stop (task): stop it; send resumes it later. " +
          "move (task, machine): send a task that has not started yet to another machine, such as when its machine is offline. " +
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
