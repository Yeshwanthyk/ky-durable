/**
 * The runner's protocol logic, apart from the process around it: which
 * commands it has handled, which Claude Code sessions are live, and what it
 * reports back. `ky-runner.ts` gives it a socket and a way to start
 * `claude`; the tests give it a socket to a real object and a fake `claude`.
 */

type Command =
  | { type: "run"; seq: number; task: string; prompt: string; session: string | null }
  | { type: "stop"; seq: number; task: string };

type Report =
  | { type: "hello"; active: string[] }
  | { type: "ack"; seq: number }
  | { type: "session"; task: string; session: string }
  | { type: "progress"; task: string; text: string }
  | { type: "result"; task: string; ok: boolean; text: string; session: string | null };

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
  readonly #handled = new Set<number>();
  /** Reports made while disconnected, sent on the next connect. */
  readonly #outbox: Report[] = [];
  #link: Link | undefined;

  constructor(spawn: SpawnClaude, log: (line: string) => void) {
    this.#spawn = spawn;
    this.#log = log;
  }

  /** Tasks with a live Claude Code session. */
  active(): string[] {
    return [...this.#runs.keys()];
  }

  /** A socket opened: say hello, then send what was made offline. */
  open(link: Link): void {
    this.#link = link;
    link.send(JSON.stringify({ type: "hello", active: this.active() } satisfies Report));

    for (const message of this.#outbox.splice(0)) link.send(JSON.stringify(message));
  }

  closed(link: Link): void {
    if (this.#link === link) this.#link = undefined;
  }

  /** The 30s hello that keeps the socket alive through idle proxies. */
  keepalive(): void {
    this.#link?.send(JSON.stringify({ type: "hello", active: this.active() } satisfies Report));
  }

  /** The process is exiting: end every session. */
  shutdown(): void {
    for (const run of this.#runs.values()) run.child.interrupt();
  }

  message(text: string): void {
    let message: Partial<Command>;

    try {
      message = JSON.parse(text);
    } catch {
      return;
    }

    // The socket also carries the Agents SDK's own frames; skip those.
    // JSON has no NaN or Infinity, so a finite seq is any number seq.
    if ((message.type === "run" || message.type === "stop") && Number.isFinite(message.seq)) {
      // SAFETY: only the hub sends run and stop frames with a seq, and it sends whole Commands.
      this.#onCommand(message as Command);
    }
  }

  #report(message: Report): void {
    if (this.#link?.send(JSON.stringify(message))) return;

    if (message.type !== "progress" && message.type !== "ack") this.#outbox.push(message);
  }

  #onCommand(command: Command): void {
    this.#report({ type: "ack", seq: command.seq });

    if (this.#handled.has(command.seq)) return;
    this.#handled.add(command.seq);
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
      run.child.write(userLine(command.prompt));
      this.#log(`${command.task}: steer`);

      return;
    }

    this.#start(command.task, command.prompt, command.session);
  }

  #start(task: string, prompt: string, session: string | null): void {
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
          this.#report({ type: "session", task, session: event.session_id });
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
            this.#report({ type: "progress", task, text });
          }
        }

        if (event.type === "result") {
          run.pending = Math.max(0, run.pending - 1);
          run.last = String(event.result ?? "");

          if (run.pending > 0) {
            this.#report({ type: "progress", task, text: run.last });

            return;
          }

          // Nothing more to answer: end the session so the result is final.
          run.child.end();
          this.#report({
            type: "result",
            task,
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
          ok: false,
          text: run.stopped ? "Stopped." : `claude exited with ${code}. ${stderr.trim()}`,
          session: run.session
        });
      }
    });

    const run: Run = { child, session, pending: 1, stopped: false, last: "" };
    this.#runs.set(task, run);
    child.write(userLine(prompt));
  }
}
