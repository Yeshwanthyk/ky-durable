import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type Extension
} from "@earendil-works/pi-durable";
import type { PiHarness } from "agents/harness/pi";
import type { FileRow, FileStore } from "./files";
import type { RunnerCommand, RunnerReport, UnnumberedCommand } from "./runner-protocol";
import { summarize, type TaskFeed, type TaskRow } from "./tasks";

/**
 * Machines: computers that run work for the main agent, such as the user's
 * Mac. A machine runs `runner/ky-runner.ts`, which dials into this object
 * over a WebSocket (`?runner=<name>`), so nothing on the machine listens on
 * a port. Each task runs as a Claude Code session on that machine, with its
 * shell, browser, files and the user's own Claude login.
 *
 * What the runner must do is kept in an inbox table until it acknowledges
 * it, so a message sent while the machine is offline is delivered when it
 * reconnects. Each finished turn is recorded in the task feed and posted to
 * the main agent as a steer, so it lands after its current tool round.
 */

export const RUNNER_QUERY = "runner";

const RUNNER_TAG_PREFIX = "runner:";

const OPEN = 1;

export function runnerTag(machine: string): string {
  return `${RUNNER_TAG_PREFIX}${machine}`;
}

export function runnerOf(tags: readonly string[]): string | undefined {
  return tags.find((tag) => tag.startsWith(RUNNER_TAG_PREFIX))?.slice(RUNNER_TAG_PREFIX.length);
}

type Turns = { turn: number; closed: number; sent: number };

export class MachineHub {
  readonly #sql: SqlStorage;
  readonly #feed: TaskFeed;
  readonly #sockets: (tag: string) => WebSocket[];
  readonly #files: FileStore;
  #harness: PiHarness | undefined;

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
    // `sent`: the command went out on an open socket, so the runner may have it.
    const inbox = sql.exec<{ name: string }>("PRAGMA table_info(ky_machine_inbox)").toArray();

    if (!inbox.some((column) => column.name === "sent")) {
      sql.exec("ALTER TABLE ky_machine_inbox ADD COLUMN sent INTEGER NOT NULL DEFAULT 0");
    }

    // Commands from before turns were numbered; no runner of this protocol accepts them.
    sql.exec("DELETE FROM ky_machine_inbox WHERE json_extract(payload, '$.turn') IS NULL");
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

  /** The harness reports go to; set once it exists. */
  attach(harness: PiHarness): void {
    this.#harness = harness;
  }

  online(machine: string): boolean {
    return this.#sockets(runnerTag(machine)).some((socket) => socket.readyState === OPEN);
  }

  machines(): Array<{ name: string; online: boolean; seenAt: number; active: number }> {
    return this.#sql
      .exec<{ name: string; seen_at: number }>("SELECT name, seen_at FROM ky_machines ORDER BY name")
      .toArray()
      .map((row) => ({
        name: row.name,
        online: this.online(row.name),
        seenAt: row.seen_at,
        active: this.#feed.open("machine", row.name).length
      }));
  }

  /** Runners are seen when they connect and when they leave. */
  seen(machine: string): void {
    this.#sql.exec(
      "INSERT INTO ky_machines (name, seen_at) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET seen_at = excluded.seen_at",
      machine,
      Date.now()
    );
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

  start(machine: string, title: string, prompt: string, id: string): TaskRow {
    const task = this.#feed.create({
      id,
      kind: "machine",
      worker: machine,
      title,
      status: "queued",
      session: null
    });

    if (task.status === "queued") {
      this.#setTurns(id, { turn: 1, closed: 0, sent: 0 });
      this.#enqueue(machine, { type: "run", task: id, turn: 1, prompt, session: null });
    }

    return task;
  }

  /** Steer a running task, or resume a finished one, as its next turn. */
  send(task: TaskRow, message: string): void {
    const turn = this.#turns(task.id).turn + 1;
    this.#setTurns(task.id, { turn });
    this.#feed.update(task.id, { status: task.status === "working" ? "working" : "queued" });
    this.#enqueue(task.worker, { type: "run", task: task.id, turn, prompt: message, session: task.session });
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
  async #onHello(machine: string, active: readonly string[]): Promise<void> {
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

  async onReport(machine: string, report: RunnerReport): Promise<void> {
    if (report.type === "hello") return this.#onHello(machine, report.active);

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
   * not reported again, and the report's operation id is the turn's.
   */
  async #finish(id: string, ok: boolean, text: string, turn: number): Promise<void> {
    const task = this.#feed.get(id);

    if (!task || this.#closed(id, turn)) return;
    this.#setTurns(id, { closed: turn });
    const ended = endOf(ok, text);
    this.#feed.update(id, { status: ended.status, summary: summarize(text) || (ok ? "Done" : "Failed") });

    if (ok) this.#feed.describe(id, text);

    if (!this.#harness) return;

    await this.#harness.submit(
      `[machine ${task.worker}, task ${id} "${task.title}" ${ended.word}, no reply needed unless the user is waiting on it]\n${text}${sharedLine(this.#files.forTask(id))}`,
      { operationId: `task:${id}:${turn}`, whenBusy: "steer" }
    );
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

export function machineExtension(hub: MachineHub, feed: TaskFeed): Extension {
  return defineExtension({
    name: "machines",
    tools: [
      defineTool({
        name: "machine",
        description:
          "Run tasks on the user's real computers, each as a Claude Code session with a shell, files, scripts, installed tools and a real browser. " +
          "Use it only when the user asks for a machine, or for what the cloud cannot do: web pages that need the user's logins (have a subagent try Exa search and browse first), running scripts or builds, touching local files. " +
          "Actions: list (machines and their recent tasks). " +
          "run (title, prompt, machine optional when one is online): start a task; the prompt must be self-contained. " +
          "send (task, message): steer a working task, or resume a finished one with its history. " +
          "stop (task): stop it; send resumes it later. " +
          "Results are reported back to you as messages when they arrive; do not poll.",
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal("list"),
            Type.Literal("run"),
            Type.Literal("send"),
            Type.Literal("stop")
          ]),
          machine: Type.Optional(Type.String()),
          title: Type.Optional(Type.String({ description: "3-6 words for the task list." })),
          prompt: Type.Optional(Type.String()),
          task: Type.Optional(Type.String({ description: "A task id from run or list." })),
          message: Type.Optional(Type.String())
        }),
        replay: "unsafe",
        execute: async (args, api) => {
          const machines = hub.machines();

          if (args.action === "list") {
            if (machines.length === 0) {
              return reply("No machines have connected yet. The user starts one with runner/ky-runner.ts.");
            }

            const lines = machines.map((m) => {
              const tasks = feed
                .list(200)
                .filter((t) => t.kind === "machine" && t.worker === m.name)
                .slice(0, 8)
                .map((t) => `  ${t.id} [${t.status}] ${t.title}${t.summary ? ` — ${t.summary}` : ""}`);

              return [`${m.name}: ${m.online ? "online" : "offline"}`, ...tasks].join("\n");
            });

            return reply(lines.join("\n"));
          }

          if (args.action === "run") {
            const online = machines.filter((m) => m.online);
            const machine = args.machine ?? (online.length === 1 ? online[0]!.name : undefined);

            if (!machine) {
              return reply(
                `Name a machine. Known: ${machines.map((m) => `${m.name} (${m.online ? "online" : "offline"})`).join(", ") || "none"}.`
              );
            }

            if (!args.prompt) return reply("run needs a prompt.");
            // Model call ids repeat across turns (Kimi: functions.machine:0); pi's task id does not.
            const id = `m-${String(api.taskId)}`;
            const task = hub.start(machine, args.title ?? summarize(args.prompt).slice(0, 60), args.prompt, id);

            if (args.title === undefined) feed.name(task.id, args.prompt);

            return reply(
              `Started task ${task.id} on ${machine}${hub.online(machine) ? "" : " (offline: it starts when the machine connects)"}.`
            );
          }

          const task = args.task ? feed.get(args.task) : undefined;

          if (!task || task.kind !== "machine") return reply(`No machine task ${args.task ?? ""}.`);

          if (args.action === "stop") {
            await hub.stop(task);

            return reply(`Stopping ${task.id}.`);
          }

          if (!args.message) return reply("send needs a message.");
          hub.send(task, args.message);

          return reply(
            task.status === "working" ? `Steering ${task.id}.` : `Resuming ${task.id} with your message.`
          );
        }
      })
    ]
  });
}
