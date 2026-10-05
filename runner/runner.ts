/**
 * The runner's protocol logic, apart from the process around it: which
 * commands it has handled, which Claude Code sessions are live, and what it
 * reports back. `ky-runner.ts` gives it a socket and a way to start
 * `claude`; the tests give it a socket to a real object and a fake `claude`.
 */

import type { HandledSeqs } from "./handled.ts";
import { decodeCommand, PROTOCOL, type RunnerCommand, type RunnerReport } from "../src/runner-protocol.ts";

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

type Run = {
  child: ClaudeProcess;
  session: string | null;
  /** The latest turn written to it; its reports speak for every turn up to this one. */
  turn: number;
  /** Messages written that have no result yet. */
  pending: number;
  stopped: boolean;
  last: string;
};

const PROGRESS_EVERY_MS = 4_000;

function userLine(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
}

export class Runner {
  readonly #spawn: SpawnClaude;
  readonly #log: (line: string) => void;
  readonly #runs = new Map<string, Run>();
  readonly #handled: HandledSeqs;
  /** Reports made while disconnected, sent on the next connect. */
  readonly #outbox: RunnerReport[] = [];
  #link: Link | undefined;

  constructor(spawn: SpawnClaude, log: (line: string) => void, handled: HandledSeqs) {
    this.#spawn = spawn;
    this.#log = log;
    this.#handled = handled;
  }

  /** Tasks with a live Claude Code session. */
  active(): string[] {
    return [...this.#runs.keys()];
  }

  /**
   * A socket opened: first send what was made offline, then hello. The
   * object reads hello's `active` as "everything else is over", so a result
   * finished offline must land before it, or the task is first declared
   * interrupted and then reported again as done.
   */
  open(link: Link): void {
    this.#link = link;

    for (const message of this.#outbox.splice(0)) link.send(JSON.stringify(message));

    link.send(JSON.stringify(this.#hello()));
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
    // The socket also carries the Agents SDK's own frames; only commands are acted on.
    const command = decodeCommand(text);

    if (command) this.#onCommand(command);
  }

  #hello(): RunnerReport {
    return { type: "hello", protocol: PROTOCOL, active: this.active() };
  }

  #report(message: RunnerReport): void {
    if (this.#link?.send(JSON.stringify(message))) return;

    if (message.type !== "progress" && message.type !== "ack") this.#outbox.push(message);
  }

  /**
   * Record, then ack, then act. The seq is on disk before the ack goes out,
   * so a command the object stops resending is never run twice, even across
   * a restart. A crash between the record and the act loses the command;
   * the next hello does not list the task, and the object closes it.
   */
  #onCommand(command: RunnerCommand): void {
    const fresh = !this.#handled.has(command.seq);

    if (fresh) this.#handled.add(command.seq);
    this.#report({ type: "ack", seq: command.seq });

    if (!fresh) return;
    const run = this.#runs.get(command.task);

    if (command.type === "stop") {
      if (run) {
        run.stopped = true;
        run.child.interrupt();
      }

      return;
    }

    if (run) {
      // Steer: Claude Code takes it as the next user message in this session.
      run.pending += 1;
      run.turn = command.turn;
      run.child.write(userLine(command.prompt));
      this.#log(`${command.task}: steer`);

      return;
    }

    this.#start(command.task, command.turn, command.prompt, command.session);
  }

  #start(task: string, turn: number, prompt: string, session: string | null): void {
    this.#log(`${task}: start${session ? ` (resume ${session.slice(0, 8)})` : ""}`);
    let lastProgress = 0;

    const child = this.#spawn(task, session, {
      line: (line) => {
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

        if (event.type === "assistant") {
          const text = (event.message?.content ?? [])
            .flatMap((part: any) =>
              part.type === "text" ? [part.text] : part.type === "tool_use" ? [`Using ${part.name}`] : []
            )
            .join(" ")
            .trim();

          if (text && Date.now() - lastProgress > PROGRESS_EVERY_MS) {
            lastProgress = Date.now();
            this.#report({ type: "progress", task, turn: run.turn, text });
          }
        }

        if (event.type === "result") {
          run.pending = Math.max(0, run.pending - 1);
          run.last = String(event.result ?? "");

          if (run.pending > 0) {
            this.#report({ type: "progress", task, turn: run.turn, text: run.last });

            return;
          }

          // Nothing more to answer: end the session so the result is final.
          run.child.end();
          this.#report({
            type: "result",
            task,
            turn: run.turn,
            ok: !event.is_error && !run.stopped,
            text: run.stopped ? "Stopped." : run.last || (event.is_error ? "Failed." : "Done."),
            session: run.session
          });
          this.#runs.delete(task);
        }
      },
      exit: (code, stderr) => {
        this.#log(`${task}: exit ${code}`);

        if (this.#runs.get(task) !== run) return;
        this.#runs.delete(task);
        this.#report({
          type: "result",
          task,
          turn: run.turn,
          ok: false,
          text: run.stopped ? "Stopped." : `claude exited with ${code}. ${stderr.trim()}`,
          session: run.session
        });
      }
    });

    const run: Run = { child, session, turn, pending: 1, stopped: false, last: "" };
    this.#runs.set(task, run);
    child.write(userLine(prompt));
  }
}
