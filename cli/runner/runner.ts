/**
 * The runner's protocol logic, apart from the process around it: which
 * commands it has handled, which agent sessions are live, and what it
 * reports back. `ky-runner.ts` gives it a socket and a way to start each
 * agent's CLI; the tests give it a socket to a real object and fake CLIs.
 */

import type { Adapter, AgentEvent, ToolUse } from "./agent.ts";
import { endStep, startStep } from "../../src/step-labels.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { Forwarder, type LocalFetch } from "./forward.ts";
import type { HandledSeqs } from "./handled.ts";
import {
  AGENT_NAMES,
  decodeObjectFrame,
  PROTOCOL,
  type Agent,
  type CodexCreds,
  type MachineFacts,
  type ObjectFrame,
  type RunCommand,
  type RunCreds,
  type RunnerCommand,
  type RunnerReport
} from "../../src/machines/contract.ts";

/** One open socket to the object. `send` is false once it can no longer send; `buffered` is what waits to go out, in bytes. */
export type Link = { send(text: string): boolean; buffered(): number };

/** A running agent CLI. */
export type AgentProcess = {
  /** Write to its stdin. */
  write(text: string): void;
  /** Close its stdin, so it exits once it has answered. */
  end(): void;
  /** SIGINT, then SIGKILL if it lingers. */
  interrupt(): void;
  /** Hand a Codex process that was started with ky's ChatGPT login the refreshed one, for its next request. */
  renew(codex: CodexCreds): void;
  /** Its process id, once it has one. */
  readonly pid: number | undefined;
  /** The end of what it has written to stderr so far. */
  stderr(): string;
};

/** What an agent process says: each stdout line, then its exit, with the signal that ended it if one did. */
export type ProcessEvents = {
  line(text: string): void;
  exit(code: number | null, stderr: string, signal?: NodeJS.Signals | null): void;
};

/**
 * Start `agent`'s CLI for a task, with the task's token, resuming `session`
 * when it is set, and signed in with `creds` when ky sent them, else with
 * the machine's own login.
 */
export type SpawnAgent = (agent: Agent, task: string, launch: Launch, events: ProcessEvents) => AgentProcess;

/** What a turn's process starts with, besides its prompt. */
export type Launch = { taskToken: string; session: string | null; creds: RunCreds | undefined };

const ADAPTERS: Readonly<Record<Agent, Adapter>> = { claude, codex };

/** A turn to run once the process it came to has exited. */
type Turn = Launch & { turn: number; prompt: string };

type Run = {
  agent: Agent;
  child: AgentProcess;
  /** Whether it was started with ky's ChatGPT login, which a `creds` frame renews. */
  handed: boolean;
  session: string | null;
  /** Whether this process's session has been reported yet. */
  announced: boolean;
  /** The latest turn written to it; its reports speak for every turn up to this one. */
  turn: number;
  /** Messages written to it, and how many the agent has taken in. */
  written: number;
  taken: number;
  stopped: boolean;
  last: string;
  /** Turns that came while it was stopping, or while an agent that takes no prompt mid-turn ran one; a new process runs them once it exits. */
  next: Turn[];
  /** Its result is reported; it stays only until it exits, so `next` waits for it. */
  ended: boolean;
  /** Queued turns a later stop dropped. */
  dropped: number;
  /** What the agent said this process spent, as of its latest result. */
  spent: { turns: number; costUsd: number } | undefined;
  /** When what the agent said was last reported as a step. */
  saidAt: number;
  /** The tools running now by id, so each one's end is titled by what it was. */
  calls: Map<string, ToolUse>;
};

/** How often what the agent says between tools is reported as a step; each tool it uses always is. */
const TEXT_STEP_EVERY_MS = 4_000;

/**
 * How long a started agent has to write its first line. Claude Code and Codex each write one at
 * once; one that writes nothing for this long is stuck (a blocked open(), a prompt nobody sees),
 * so it is interrupted and its turn fails, saying so, rather than showing as working for ever.
 */
export const FIRST_OUTPUT_WITHIN_MS = 60_000;

/** Why a process ended without a result: the signal that killed it or its exit code, then the end of its stderr. */
function exitText(agent: Agent, code: number | null, signal: NodeJS.Signals | null, stderr: string): string {
  const how = signal ? `${agent} was killed by ${signal}.` : code === null ? "" : `${agent} exited with ${code}.`;

  return `${how} ${stderr.trim()}`.trim();
}

/** A stopped session's result, naming the queued messages a second stop dropped. */
function stoppedText(run: Run): string {
  if (run.dropped === 0) return "Stopped.";

  return `Stopped. Dropped ${run.dropped} queued message${run.dropped === 1 ? "" : "s"}.`;
}

/**
 * What a process has spent, by its latest result: the totals so far, and
 * the larger kept in case one omits them.
 */
function spentBy({ spent }: Extract<AgentEvent, { type: "result" }>, before: Run["spent"]): Run["spent"] {
  if (!spent) return before;

  return { turns: most(before?.turns, spent.turns), costUsd: most(before?.costUsd, spent.costUsd) };
}

/** The larger of two counts, either of which may be missing. */
const most = (a: number | undefined, b: number | undefined) => Math.max(a ?? 0, b ?? 0);

export class Runner {
  readonly #spawn: SpawnAgent;
  readonly #log: (line: string) => void;
  readonly #runs = new Map<string, Run>();
  readonly #handled: HandledSeqs;
  readonly #version: string;
  readonly #facts: () => MachineFacts;
  readonly #forwarder: Forwarder;
  /** Reports made while disconnected, sent on the next connect. */
  readonly #outbox: RunnerReport[] = [];
  #link: Link | undefined;
  /** Shut down: no socket takes reports, and no process starts. */
  #closing = false;

  constructor(
    spawn: SpawnAgent,
    log: (line: string) => void,
    handled: HandledSeqs,
    /** The runner's build, sent with each hello. */
    version: string,
    /** What this machine is, sent with each hello. Its `ports` are the only ones `http_request`s may reach. */
    facts: () => MachineFacts,
    /** How a request reaches one of those ports. */
    local: LocalFetch
  ) {
    this.#spawn = spawn;
    this.#log = log;
    this.#handled = handled;
    this.#version = version;
    this.#facts = facts;
    this.#forwarder = new Forwarder(local, () => facts().ports, (line) => log(`forward ${line}`));
  }

  /** Tasks with a live agent process. */
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
    if (this.#closing) return;
    this.#link = link;
    link.send(JSON.stringify(this.#hello()));

    for (const message of this.#outbox.splice(0)) link.send(JSON.stringify(message));
  }

  closed(link: Link): void {
    if (this.#link !== link) return;

    this.#link = undefined;
    this.#forwarder.closed();
  }

  /** The 30s hello that keeps the socket alive through idle proxies. */
  keepalive(): void {
    this.#link?.send(JSON.stringify(this.#hello()));
  }

  /**
   * The process was told to stop, as a container the platform stops is: while the socket is open,
   * end each task's open turns with `text`, so ky fails them saying so, not at the next hello as a
   * restart. False when no socket takes the reports; the next hello ends them then.
   */
  stopping(text: string): boolean {
    const link = this.#link;

    if (!link) return false;

    for (const [task, run] of this.#runs) {
      const latest = run.next.at(-1)?.turn ?? (run.ended ? undefined : run.turn);

      if (latest !== undefined) link.send(JSON.stringify({ type: "result", task, turn: latest, ok: false, text, session: run.session, agent: run.agent } satisfies RunnerReport));
    }

    return true;
  }

  /**
   * The process is exiting: end every session, and report nothing more, so the next hello, which
   * lists none of them, tells the object they were interrupted. Queued turns never start.
   */
  shutdown(): void {
    this.#closing = true;
    this.#link = undefined;

    for (const run of this.#runs.values()) run.child.interrupt();
  }

  message(text: string): void {
    if (this.#closing) return;
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
        if (this.#link) this.#forwarder.request(this.#link, frame);

        return;
      case "http_cancel":
        this.#forwarder.cancel(frame.id);

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
    const fresh = this.#record(command.seq);

    if (fresh === undefined) return;

    this.#report({ type: "ack", seq: command.seq });

    if (fresh) this.#act(command);
  }

  /** Whether `seq` is new, recorded now; undefined when it is new but could not be recorded. */
  #record(seq: number): boolean | undefined {
    if (this.#handled.has(seq)) return false;

    try {
      this.#handled.add(seq);
    } catch (error) {
      this.#log(`could not record command ${seq}, leaving it unacked: ${String(error)}`);

      return undefined;
    }

    return true;
  }

  /** Run a command, each type by its case; a stop or creds acts only on a live process. */
  #act(command: RunnerCommand): void {
    const run = command.type === "run" ? undefined : this.#runs.get(command.task);

    switch (command.type) {
      case "run":
        this.#onRun(command);

        return;
      case "stop":
        if (run) this.#stop(command.task, run);

        return;
      case "creds":
        if (run) this.#renew(run, command.codex);

        return;
      default:
        command satisfies never;
    }
  }

  /** A refreshed ChatGPT login: the live process gets it, and so do the turns queued behind it. */
  #renew(run: Run, codex: CodexCreds): void {
    if (run.handed && !run.ended) run.child.renew(codex);

    for (const next of run.next) if (next.creds?.codex) next.creds = { ...next.creds, codex };
  }

  #onRun(command: RunCommand): void {
    const run = this.#runs.get(command.task);

    if (run && (run.stopped || run.ended || !ADAPTERS[run.agent].steers)) {
      // The process is dying, or takes nothing more: run it in a new one after.
      run.next.push({ turn: command.turn, prompt: command.prompt, session: command.session, taskToken: command.taskToken, creds: command.creds });
      this.#log(`${command.task}: queued behind ${run.stopped ? "the stop" : "its turn"}`);

      return;
    }

    if (run) {
      // Steer: the agent takes it as the next user message in this session.
      this.#steer(run, command.turn, command.prompt);
      this.#log(`${command.task}: steer`);

      return;
    }

    // Only a missing CLI is turned away: a login that looks signed out, or an
    // answer that was not readable, may be wrong, and the CLI says so itself.
    if (!this.#facts().agents[command.agent].installed) {
      const text = `${AGENT_NAMES[command.agent]} is not installed on this machine.`;
      this.#report({ type: "result", task: command.task, turn: command.turn, ok: false, text, session: command.session, agent: command.agent });

      return;
    }

    this.#start(command.task, command.agent, { ...command, creds: command.creds });
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
        this.#report({ type: "result", task, turn: latest, ok: false, text: stoppedText(run), session: run.session, agent: run.agent });
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
    run.child.write(ADAPTERS[run.agent].prompt(prompt));
  }

  /** A started agent wrote nothing in time: interrupt it, and fail its turn now, naming the process and what it said on stderr. */
  #silent(task: string, run: Run): void {
    if (run.ended || run.stopped || this.#runs.get(task) !== run) return;
    const stderr = run.child.stderr().trim();
    const text = `${run.agent} started (pid ${run.child.pid ?? "unknown"}) but wrote nothing in ${FIRST_OUTPUT_WITHIN_MS / 1000}s, so it was stopped. ${stderr ? `stderr: ${stderr.slice(-500)}` : "Nothing on stderr."}`;
    this.#log(`${task}: ${text}`);
    run.child.interrupt();
    this.#end(task, run, false, text);
  }

  /** Report the session's last turn over; turns queued behind it start once it exits. */
  #end(task: string, run: Run, ok: boolean, text: string): void {
    this.#report({ type: "result", task, turn: run.turn, ok, text, session: run.session, agent: run.agent, ...run.spent });
    run.spent = undefined;

    if (run.next.length === 0) this.#runs.delete(task);
    else run.ended = true;
  }

  /**
   * The agent ended a turn. A message written while a turn runs joins that
   * turn, so one result can answer several messages: the run ends once every
   * message written to it has been taken in, and a result before then is a
   * step.
   */
  #onResult(task: string, run: Run, result: Extract<AgentEvent, { type: "result" }>): void {
    run.last = result.text;
    run.spent = spentBy(result, run.spent);

    if (!run.stopped && run.taken < run.written) {
      this.#report({ type: "step", task, turn: run.turn, text: run.last });

      return;
    }

    // Nothing more to answer: end the session so the result is final.
    run.child.end();
    this.#end(
      task,
      run,
      result.ok && !run.stopped,
      run.stopped ? stoppedText(run) : run.last || (result.ok ? "Done." : "Failed.")
    );
  }

  /** Each tool the agent uses is a step; what it says between tools is one too, at most every few seconds. */
  #onMessage(task: string, run: Run, { text, tools }: Extract<AgentEvent, { type: "message" }>): void {
    if (text && tools.length === 0 && Date.now() - run.saidAt > TEXT_STEP_EVERY_MS) {
      run.saidAt = Date.now();
      this.#report({ type: "step", task, turn: run.turn, text });
    }

    for (const tool of tools) {
      const start = startStep(tool.name, tool.args);

      if (tool.id === undefined) {
        this.#report({ type: "step", task, turn: run.turn, text: start.text });
        continue;
      }

      run.calls.set(tool.id, tool);
      this.#report({ type: "step", task, turn: run.turn, text: start.text, call: tool.id, input: start.input });
    }
  }

  /** A tool is done: its step says what it did, with what came back. */
  #onToolEnd(task: string, run: Run, { id, ok, output }: Extract<AgentEvent, { type: "tool-end" }>): void {
    const tool = run.calls.get(id);

    if (tool === undefined) return;
    run.calls.delete(id);
    const end = endStep(tool.name, tool.args, output, ok);
    this.#report({ type: "step", task, turn: run.turn, call: id, text: end.text, state: end.state, detail: end.detail, output: end.output });
  }

  #onEvent(task: string, run: Run, event: AgentEvent): void {
    switch (event.type) {
      case "session":
        // Each process says it, so a resumed task shows as working again.
        if (run.announced && event.session === run.session) return;
        run.session = event.session;
        run.announced = true;
        this.#report({ type: "session", task, turn: run.turn, session: event.session });

        return;
      case "taken":
        run.taken += 1;

        return;
      case "message":
        this.#onMessage(task, run, event);

        return;
      case "tool-end":
        this.#onToolEnd(task, run, event);

        return;
      case "result":
        this.#onResult(task, run, event);
    }
  }

  /** A process exited: the turns queued behind it run in a new one, unless the runner is shutting down. */
  #startNext(task: string, run: Run): void {
    const [first, ...rest] = run.next;

    if (!first || this.#closing) return;

    const next = this.#start(task, run.agent, { ...first, session: run.session ?? first.session });

    if (ADAPTERS[run.agent].steers) for (const queued of rest) this.#steer(next, queued.turn, queued.prompt);
    else next.next = rest;
  }

  #start(task: string, agent: Agent, { turn, prompt, session, taskToken, creds }: Turn): Run {
    this.#log(`${task}: start ${agent}${session ? ` (resume ${session.slice(0, 8)})` : ""}`);
    const adapter = ADAPTERS[agent];
    const read = adapter.reader();

    const child = this.#spawn(agent, task, { taskToken, session, creds }, {
      line: (line) => {
        clearTimeout(silence);

        for (const event of read(line)) {
          if (run.ended) return;
          this.#onEvent(task, run, event);
        }
      },
      exit: (code, stderr, signal = null) => {
        clearTimeout(silence);
        this.#log(`${task}: exit ${signal ?? code}`);

        if (this.#runs.get(task) !== run) return;

        if (!run.ended) {
          this.#end(task, run, false, run.stopped ? stoppedText(run) : exitText(agent, code, signal, stderr));
        }

        this.#runs.delete(task);
        this.#startNext(task, run);
      }
    });

    const run: Run = {
      agent,
      child,
      handed: creds?.codex !== undefined,
      session,
      announced: false,
      turn,
      written: 1,
      taken: 0,
      stopped: false,
      last: "",
      next: [],
      ended: false,
      dropped: 0,
      spent: undefined,
      saidAt: 0,
      calls: new Map()
    };

    this.#runs.set(task, run);
    const silence = setTimeout(() => this.#silent(task, run), FIRST_OUTPUT_WITHIN_MS);
    child.write(adapter.prompt(prompt));

    // Each turn is its own process: closing stdin tells it the prompt is all there is.
    if (!adapter.steers) child.end();

    return run;
  }
}
