/**
 * The runner's protocol logic, apart from the process around it: which
 * commands it has handled, which Claude Code sessions are live, and what it
 * reports back. `ky-runner.ts` gives it a socket and a way to start
 * `claude`; the tests give it a socket to a real object and a fake `claude`.
 */

import type { HandledSeqs } from "./handled.ts";
import {
  decodeObjectFrame,
  PROTOCOL,
  type MachineFacts,
  type ObjectFrame,
  type RunCommand,
  type RunnerCommand,
  type RunnerReport
} from "../src/runner-protocol.ts";
import { describeTool } from "../src/tool-labels.ts";

/** One open socket to the object. `send` is false once it can no longer send. */
export type Link = { send(text: string): boolean };

/** A running `claude -p --input-format stream-json` process. */
export type ClaudeProcess = {
  /** Write a line to its stdin. */
  write(line: string): void;
  /** Close its stdin, so it exits once it has answered. */
  end(): void;
  /** SIGINT, then SIGKILL if it lingers. */
  interrupt(): void;
};

/** What a `claude` process says: each stdout line, then its exit. */
export type ClaudeEvents = {
  line(text: string): void;
  exit(code: number | null, stderr: string): void;
};

/** Start `claude` for a task, resuming `session` when it is set. */
export type SpawnClaude = (task: string, session: string | null, events: ClaudeEvents) => ClaudeProcess;

/** A turn to run once the session it came to has stopped. */
type Turn = { turn: number; prompt: string; session: string | null };

type Run = {
  child: ClaudeProcess;
  session: string | null;
  /** The latest turn written to it; its reports speak for every turn up to this one. */
  turn: number;
  /** Messages written to it, and how many Claude Code has taken in (it echoes each one as it does). */
  written: number;
  taken: number;
  stopped: boolean;
  last: string;
  /** Turns that came while it was stopping; a new session runs them once it exits. */
  next: Turn[];
  /** Its result is reported; it stays only until it exits, so `next` waits for it. */
  ended: boolean;
  /** Queued turns a later stop dropped. */
  dropped: number;
  /** What Claude Code said this process spent, as of its latest result. */
  spent: { turns: number; costUsd: number } | undefined;
  /** When what Claude said was last reported as a step. */
  saidAt: number;
};

/** The one agent this runner runs. */
const AGENT = "claude";

/** How often what Claude says between tools is reported as a step; each tool it uses always is. */
const TEXT_STEP_EVERY_MS = 4_000;

/** A stopped session's result, naming the queued messages a second stop dropped. */
function stoppedText(run: Run): string {
  if (run.dropped === 0) return "Stopped.";

  return `Stopped. Dropped ${run.dropped} queued message${run.dropped === 1 ? "" : "s"}.`;
}

/** An assistant message's steps: each tool it uses, labelled, and what it says as one line. */
type Steps = { tools: string[]; text: string };

function stepsOf(event: any): Steps {
  const parts: any[] = event.message?.content ?? [];

  return {
    tools: parts.flatMap((part) => (part.type === "tool_use" ? [describeTool(String(part.name), part.input ?? {}).label] : [])),
    text: parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join(" ")
      .trim()
  };
}

/**
 * What a Claude Code result says the process has spent. Its counters run for
 * the whole process, so the latest result holds the total; the larger is kept
 * in case one omits them.
 */
function spentBy(event: any, before: Run["spent"]): Run["spent"] {
  const turns = Number(event.num_turns);
  const costUsd = Number(event.total_cost_usd);

  if (!Number.isFinite(turns) && !Number.isFinite(costUsd)) return before;

  return {
    turns: Math.max(before?.turns ?? 0, Number.isFinite(turns) ? turns : 0),
    costUsd: Math.max(before?.costUsd ?? 0, Number.isFinite(costUsd) ? costUsd : 0)
  };
}

function userLine(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
}

export class Runner {
  readonly #spawn: SpawnClaude;
  readonly #log: (line: string) => void;
  readonly #runs = new Map<string, Run>();
  readonly #handled: HandledSeqs;
  readonly #version: string;
  readonly #facts: () => MachineFacts;
  /** Reports made while disconnected, sent on the next connect. */
  readonly #outbox: RunnerReport[] = [];
  #link: Link | undefined;

  constructor(
    spawn: SpawnClaude,
    log: (line: string) => void,
    handled: HandledSeqs,
    /** The runner's build, sent with each hello. */
    version: string,
    /** What this machine is, sent with each hello. */
    facts: () => MachineFacts
  ) {
    this.#spawn = spawn;
    this.#log = log;
    this.#handled = handled;
    this.#version = version;
    this.#facts = facts;
  }

  /** Tasks with a live Claude Code session. */
  active(): string[] {
    return [...this.#runs.keys()];
  }

  /**
   * A socket opened: hello first, so a runner of another protocol is turned
   * away before it hands over anything, then what was made offline. The
   * object reads hello's `active` as "everything else is over", so hello
   * lists the tasks whose results are still in the outbox, or they would be
   * declared interrupted and then reported again as done.
   */
  open(link: Link): void {
    this.#link = link;
    link.send(JSON.stringify(this.#hello()));

    for (const message of this.#outbox.splice(0)) link.send(JSON.stringify(message));
  }

  closed(link: Link): void {
    if (this.#link === link) this.#link = undefined;
  }

  /** The 30s hello that keeps the socket alive through idle proxies. */
  keepalive(): void {
    this.#link?.send(JSON.stringify(this.#hello()));
  }

  /** The process is exiting: end every session. */
  shutdown(): void {
    for (const run of this.#runs.values()) run.child.interrupt();
  }

  message(text: string): void {
    // The socket also carries the Agents SDK's own frames; only the object's are acted on.
    const frame = decodeObjectFrame(text);

    if (frame) this.#onFrame(frame);
  }

  #onFrame(frame: ObjectFrame): void {
    switch (frame.type) {
      case "goodbye":
        this.#log(`ky said goodbye: ${frame.reason}`);

        return;
      case "http_request":
        // Its facts share no ports, so no request is for an allowed one. Not kept for a reconnect: the request dies with the socket.
        this.#link?.send(JSON.stringify({ type: "http_error", id: frame.id, message: "This machine shares no ports." } satisfies RunnerReport));

        return;
      case "http_cancel":
        return;
      default:
        this.#onCommand(frame);
    }
  }

  #hello(): RunnerReport {
    const owed = this.#outbox.flatMap((message) => (message.type === "result" ? [message.task] : []));

    return {
      type: "hello",
      protocol: PROTOCOL,
      version: this.#version,
      active: [...new Set([...this.active(), ...owed])],
      facts: this.#facts()
    };
  }

  #report(message: RunnerReport): void {
    if (this.#link?.send(JSON.stringify(message))) return;

    if (message.type !== "step" && message.type !== "ack") this.#outbox.push(message);
  }

  /**
   * Record, then ack, then act. The seq is on disk before the ack goes out,
   * so a command the object stops resending is never run twice, even across
   * a restart. A crash between the record and the act loses the command;
   * the next hello does not list the task, and the object closes it. If the
   * record fails (disk full, permissions), the command is neither acked nor
   * run; the object resends it later.
   */
  #onCommand(command: RunnerCommand): void {
    const fresh = !this.#handled.has(command.seq);

    if (fresh) {
      try {
        this.#handled.add(command.seq);
      } catch (error) {
        this.#log(`could not record command ${command.seq}, leaving it unacked: ${String(error)}`);

        return;
      }
    }

    this.#report({ type: "ack", seq: command.seq });

    if (!fresh) return;

    if (command.type === "run") {
      this.#onRun(command);

      return;
    }

    const run = this.#runs.get(command.task);

    // Fresh credentials are for Codex tasks, and this runner runs none.
    if (command.type === "stop" && run) this.#stop(command.task, run);
  }

  #onRun(command: RunCommand): void {
    if (command.agent !== AGENT) {
      const text = `This runner runs only ${AGENT}, not ${command.agent}.`;
      this.#report({ type: "result", task: command.task, turn: command.turn, ok: false, text, session: command.session, agent: command.agent });

      return;
    }

    const run = this.#runs.get(command.task);

    if (run?.stopped) {
      // The session is dying and would take this message with it: run it in a new one after.
      run.next.push({ turn: command.turn, prompt: command.prompt, session: command.session });
      this.#log(`${command.task}: queued behind the stop`);

      return;
    }

    if (run) {
      // Steer: Claude Code takes it as the next user message in this session.
      this.#steer(run, command.turn, command.prompt);
      this.#log(`${command.task}: steer`);

      return;
    }

    this.#start(command.task, command.turn, command.prompt, command.session);
  }

  /**
   * Stop the session, and drop turns queued behind an earlier stop: this
   * stop's result speaks for them, so they never run.
   */
  #stop(task: string, run: Run): void {
    const latest = run.next.at(-1)?.turn;
    const dropped = run.next.length;
    run.next = [];
    run.dropped += dropped;

    if (run.ended) {
      if (latest !== undefined) {
        this.#report({ type: "result", task, turn: latest, ok: false, text: stoppedText(run), session: run.session, agent: AGENT });
      }

      return;
    }

    if (latest !== undefined) run.turn = latest;
    run.stopped = true;
    run.child.interrupt();
  }

  #steer(run: Run, turn: number, prompt: string): void {
    run.written += 1;
    run.turn = turn;
    run.child.write(userLine(prompt));
  }

  /** Report the session's last turn over; turns queued behind it start once it exits. */
  #end(task: string, run: Run, ok: boolean, text: string): void {
    this.#report({ type: "result", task, turn: run.turn, ok, text, session: run.session, agent: AGENT, ...run.spent });
    run.spent = undefined;

    if (run.next.length === 0) this.#runs.delete(task);
    else run.ended = true;
  }

  /**
   * Claude Code ended a turn. A message written while a turn runs joins that
   * turn, so one result can answer several messages: the run ends once every
   * message written to it has been taken in, and a result before then is a
   * step.
   */
  #onResult(task: string, run: Run, event: any): void {
    run.last = String(event.result ?? "");
    run.spent = spentBy(event, run.spent);

    if (!run.stopped && run.taken < run.written) {
      this.#report({ type: "step", task, turn: run.turn, text: run.last });

      return;
    }

    // Nothing more to answer: end the session so the result is final.
    run.child.end();
    this.#end(
      task,
      run,
      !event.is_error && !run.stopped,
      run.stopped ? stoppedText(run) : run.last || (event.is_error ? "Failed." : "Done.")
    );
  }

  /** Each tool Claude uses is a step; what it says between tools is one too, at most every few seconds. */
  #onAssistant(task: string, run: Run, event: any): void {
    const { tools, text } = stepsOf(event);

    if (text && tools.length === 0 && Date.now() - run.saidAt > TEXT_STEP_EVERY_MS) {
      run.saidAt = Date.now();
      this.#report({ type: "step", task, turn: run.turn, text });
    }

    for (const tool of tools) this.#report({ type: "step", task, turn: run.turn, text: tool });
  }

  #start(task: string, turn: number, prompt: string, session: string | null): Run {
    this.#log(`${task}: start${session ? ` (resume ${session.slice(0, 8)})` : ""}`);

    const child = this.#spawn(task, session, {
      line: (line) => {
        if (run.ended) return;
        let event: any;

        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (event.session_id && event.session_id !== run.session) {
          run.session = event.session_id;
          this.#report({ type: "session", task, turn: run.turn, session: event.session_id });
        }

        // With --replay-user-messages, Claude Code echoes each message it takes in, whether it starts a turn or joins one.
        if (event.type === "user" && event.isReplay === true) run.taken += 1;

        if (event.type === "assistant") this.#onAssistant(task, run, event);

        if (event.type === "result") this.#onResult(task, run, event);
      },
      exit: (code, stderr) => {
        this.#log(`${task}: exit ${code}`);

        if (this.#runs.get(task) !== run) return;

        if (!run.ended) {
          this.#end(task, run, false, run.stopped ? stoppedText(run) : `claude exited with ${code}. ${stderr.trim()}`);
        }

        this.#runs.delete(task);

        if (run.next.length === 0) return;
        const [first, ...rest] = run.next;
        const next = this.#start(task, first!.turn, first!.prompt, run.session ?? first!.session);

        for (const queued of rest) this.#steer(next, queued.turn, queued.prompt);
      }
    });

    const run: Run = { child, session, turn, written: 1, taken: 0, stopped: false, last: "", next: [], ended: false, dropped: 0, spent: undefined, saidAt: 0 };
    this.#runs.set(task, run);
    child.write(userLine(prompt));

    return run;
  }
}
