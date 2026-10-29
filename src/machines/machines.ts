import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { type PiHarness, ROOT_SESSION } from "agents/harness/pi";
import { summarize, type TaskFeed, type TaskRow } from "../automations/contract";
import { must } from "../core/must";
import { Sql } from "../core/sql";
import type { FileRow } from "../files/contract";
import type { CloudState, MachineInfo } from "../protocol";
import type { Sandboxes } from "../runners/wiring";
import {
  CLOUD_FACTS,
  type CloudHook,
  HelloRow,
  InboxRow,
  isMachineLogin,
  isMachineState,
  LoginRow,
  type MachineChange,
  MachineRow,
  NoMachine,
  NotALogin,
  NotAState,
  type Queued,
  QueuedJson,
  ReportRow,
  type SessionCreds,
  type TaskOutcome,
  type TaskTokens,
  type Turns,
  TurnsRow
} from "./contract";
import {
  AGENT_NAMES,
  type Agent,
  ISSUED_TTL_MS,
  type MachineFacts,
  OUTDATED,
  PROTOCOL,
  REPLACED,
  REVOKED,
  type RunCreds,
  type RunnerCommand,
  type TaskReport
} from "./runner-protocol";

const OPEN = 1;

const ONLINE_WITHIN_MS = 75_000;

const DELIVERY_RETRIES = 5;

const NOTE_CHARS = 200;

const FIRST_TURN: Turns = { turn: 1, closed: 0, sent: 0, stopping: 0 };

const ENDINGS: Readonly<Record<TaskOutcome, string>> = { done: "finished", failed: "failed", stopped: "stopped" };

export const PREFERRED: readonly Agent[] = ["claude", "codex"];

type Pending = Queued & { readonly seq: number };

const NameRow = Schema.Struct({ name: Schema.String });

const SessionRow = Schema.Struct({ session: Schema.String });

const PairingRow = Schema.Struct({ pairing: Schema.NullOr(Schema.String) });

const TurnsEndedRow = Schema.Struct({ turns_ended: Schema.Number });

const KindRow = Schema.Struct({ name: Schema.String, kind: Schema.NullOr(Schema.String) });

const SeqRow = Schema.Struct({ seq: Schema.Number });

const queuedOf = Schema.decodeUnknownOption(QueuedJson);

function closedReason(code: number | undefined): string | null {
  switch (code) {
    case OUTDATED:
      return "Its runner speaks another runner protocol than ky. Get the newer ky on it, then run ky upgrade.";
    case REVOKED:
      return "It was removed from ky, or its token is not ky's. Pair it again.";
    case REPLACED:
      return "Another runner connected with its name. Give each machine its own name.";
    case 1008:
      return "ky closed its runner's connection on a report it could not read. Update ky on it.";
    default:
      return null;
  }
}

function runWith(command: Extract<Pending, { type: "run" }>, taskToken: string | undefined, creds: RunCreds): RunnerCommand | undefined {
  if (taskToken === undefined) return undefined;

  const run: RunnerCommand = { ...command, taskToken };
  const handed = creds[command.agent];

  return handed ? { ...run, creds: { [command.agent]: handed } } : run;
}

function outcomeOf(ok: boolean, turn: number, stopping: number): TaskOutcome {
  if (ok) return "done";

  return stopping >= turn ? "stopped" : "failed";
}

export function agentOf(task: TaskRow): Agent {
  return must(task.agent, `Machine task ${task.id} names no agent.`);
}

function runCommand(task: string, turn: number, prompt: string, session: string | null, agent: Agent): Queued {
  return { type: "run", task, turn, prompt, session, agent };
}

function has(facts: MachineFacts | null, agent: Agent): boolean {
  return facts === null || facts.agents[agent].installed;
}

export function runs(facts: MachineFacts | null, agent: Agent): boolean {
  return has(facts, agent) && (facts === null || facts.agents[agent].signedIn);
}

function handsCreds(machine: MachineInfo | undefined, agent: Agent): boolean {
  return machine !== undefined && (machine.login === "ky" || machine.facts?.kind === "cloud" || !runs(machine.facts, agent));
}

function defaultAgent(facts: MachineFacts | null): Agent {
  return PREFERRED.find((agent) => runs(facts, agent)) ?? PREFERRED.find((agent) => has(facts, agent)) ?? "claude";
}

export function cannotRun(machine: MachineInfo | undefined, agent: Agent): string | null {
  if (!machine || has(machine.facts, agent)) return null;

  return `${machine.name} cannot run ${AGENT_NAMES[agent]}: it is not installed there.`;
}

function sharedLine(files: readonly FileRow[]): string {
  if (files.length === 0) return "";

  return `\n\nShared with the user, shown under this report: ${files.map((file) => file.caption ?? file.name).join("; ")}`;
}

export type Harness = Pick<PiHarness, "submit">;

export class Host extends Context.Service<
  Host,
  {
    readonly feed: TaskFeed;
    readonly sockets: (tag: string) => WebSocket[];
    readonly shared: (task: string) => readonly FileRow[];
    readonly tokens: TaskTokens;
    readonly creds: SessionCreds;
    readonly sandboxes: Sandboxes;
    readonly harness: () => Harness | undefined;
    readonly wanted: (task: string) => boolean;
    readonly cloud: () => CloudHook | undefined;
    readonly recheckAt: (at: number) => void;
    readonly changed: () => void;
    readonly retryMs: () => number;
  }
>()("ky/machines/Host") {}

const make = Effect.gen(function* () {
  const sql = yield* Sql;
  const host = yield* Host;
  const feed: TaskFeed = host.feed;
  const { tokens, sandboxes } = host;
  const now = Clock.currentTimeMillis;
  const exec = (query: string, ...bindings: SqlStorageValue[]) => sql.exec(query, ...bindings).pipe(Effect.orDie);
  const rows = <T>(row: Schema.Decoder<T>, query: string, ...bindings: SqlStorageValue[]) => sql.rows(row, query, ...bindings).pipe(Effect.orDie);
  const changed = Effect.sync(() => host.changed());
  const warn = (...said: unknown[]) => Effect.sync(() => console.warn(...said));
  const vault = <A>(call: () => Promise<A>) => Effect.promise(call);
  const columns = (table: string) => Effect.map(rows(NameRow, `PRAGMA table_info(${table})`), (all) => new Set(all.map((column) => column.name)));
  const greeted = (connection: string | null) => (connection === null ? [] : host.sockets(connection).filter((socket) => socket.readyState === OPEN));
  const tokenWork = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  const retries = new Map<string, number>();
  const waiting = new Set<string>();

  yield* exec(`CREATE TABLE IF NOT EXISTS ky_machine_inbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      machine TEXT NOT NULL,
      payload TEXT NOT NULL)`);
  yield* exec(`CREATE TABLE IF NOT EXISTS ky_machines (
      name TEXT PRIMARY KEY, seen_at INTEGER NOT NULL)`);
  yield* exec(`CREATE TABLE IF NOT EXISTS ky_machine_turns (
      task TEXT PRIMARY KEY,
      turn INTEGER NOT NULL,
      closed INTEGER NOT NULL,
      sent INTEGER NOT NULL)`);
  yield* exec(`CREATE TABLE IF NOT EXISTS ky_machine_senders (
      task TEXT NOT NULL,
      turn INTEGER NOT NULL,
      session TEXT NOT NULL,
      PRIMARY KEY (task, turn))`);
  yield* exec(`CREATE TABLE IF NOT EXISTS ky_machine_logins (
      task TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL)`);
  yield* exec(`CREATE TABLE IF NOT EXISTS ky_machine_reports (
      task TEXT NOT NULL,
      turn INTEGER NOT NULL,
      session TEXT NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (task, turn, session))`);

  if (!(yield* columns("ky_machine_inbox")).has("sent")) yield* exec("ALTER TABLE ky_machine_inbox ADD COLUMN sent INTEGER NOT NULL DEFAULT 0");
  const known = yield* columns("ky_machines");

  if (!known.has("state")) {
    yield* exec("ALTER TABLE ky_machines ADD COLUMN state TEXT NOT NULL DEFAULT 'on'");
    yield* exec("ALTER TABLE ky_machines ADD COLUMN note TEXT NOT NULL DEFAULT ''");
    yield* exec("ALTER TABLE ky_machines ADD COLUMN facts TEXT");
  }

  if (!known.has("pairing")) yield* exec("ALTER TABLE ky_machines ADD COLUMN pairing TEXT");

  if (!known.has("login")) yield* exec("ALTER TABLE ky_machines ADD COLUMN login TEXT NOT NULL DEFAULT 'own'");

  if (!known.has("hello")) {
    yield* exec("ALTER TABLE ky_machines ADD COLUMN hello TEXT");
    yield* exec("ALTER TABLE ky_machines ADD COLUMN reason TEXT");
  }

  if (!known.has("turns_ended")) yield* exec("ALTER TABLE ky_machines ADD COLUMN turns_ended INTEGER NOT NULL DEFAULT 0");

  if (!(yield* columns("ky_machine_turns")).has("stopping")) yield* exec("ALTER TABLE ky_machine_turns ADD COLUMN stopping INTEGER NOT NULL DEFAULT 0");

  yield* exec("DELETE FROM ky_machine_inbox WHERE CASE WHEN json_valid(payload) THEN json_extract(payload, '$.turn') IS NULL ELSE 1 END");
  yield* exec(
    `UPDATE ky_machine_inbox SET payload = json_set(payload, '$.agent', 'claude')
       WHERE json_extract(payload, '$.type') = 'run' AND json_extract(payload, '$.agent') IS NULL`
  );
  yield* exec("UPDATE ky_machines SET facts = NULL WHERE CASE WHEN json_valid(facts) THEN json_extract(facts, '$.kind') IS NULL ELSE 1 END");

  const turnsOf = (task: string) => Effect.map(rows(TurnsRow, "SELECT turn, closed, sent, stopping FROM ky_machine_turns WHERE task = ?", task), (all) => all[0] ?? FIRST_TURN);

  const setTurns = (task: string, turns: Partial<Turns>) =>
    Effect.gen(function* () {
      const next = { ...(yield* turnsOf(task)), ...turns };

      yield* exec(
        `INSERT INTO ky_machine_turns (task, turn, closed, sent, stopping) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(task) DO UPDATE SET turn = excluded.turn, closed = excluded.closed, sent = excluded.sent, stopping = excluded.stopping`,
        task,
        next.turn,
        next.closed,
        next.sent,
        next.stopping
      );
    });

  const sentBy = (task: string, turn: number, session: string) => exec("INSERT OR REPLACE INTO ky_machine_senders (task, turn, session) VALUES (?, ?, ?)", task, turn, session);

  const lastSender = (task: string, upTo = Number.MAX_SAFE_INTEGER) =>
    Effect.map(rows(SessionRow, "SELECT session FROM ky_machine_senders WHERE task = ? AND turn <= ? ORDER BY turn DESC LIMIT 1", task, upTo), (all) => all[0]?.session ?? ROOT_SESSION);

  const listeners = (task: string, from: number, to: number) =>
    Effect.gen(function* () {
      const senders = yield* rows(SessionRow, "SELECT session FROM ky_machine_senders WHERE task = ? AND turn > ? AND turn <= ? GROUP BY session ORDER BY MIN(turn)", task, from, to);

      return senders.length > 0 ? senders.map((row) => row.session) : [yield* lastSender(task, to)];
    });

  const closed = (task: string, turn: number) => Effect.map(turnsOf(task), (turns) => turn <= turns.closed);

  const online = (machine: string) =>
    Effect.gen(function* () {
      const [row] = yield* rows(HelloRow, "SELECT seen_at, hello FROM ky_machines WHERE name = ?", machine);

      return row !== undefined && (yield* now) - row.seen_at <= ONLINE_WITHIN_MS && greeted(row.hello).length > 0;
    });

  const pending = (machine: string) =>
    Effect.gen(function* () {
      const commands: Pending[] = [];

      for (const row of yield* rows(InboxRow, "SELECT seq, payload FROM ky_machine_inbox WHERE machine = ? ORDER BY seq", machine)) {
        const command = queuedOf(row.payload);

        if (Option.isSome(command)) {
          commands.push({ ...command.value, seq: row.seq });
          continue;
        }

        yield* warn(`dropping ${machine}'s damaged command ${row.seq}`);
        yield* exec("DELETE FROM ky_machine_inbox WHERE seq = ?", row.seq);
      }

      return commands;
    });

  const busy = (machine: string) => (feed.open("machine", machine).length > 0 ? Effect.succeed(true) : Effect.map(pending(machine), (commands) => commands.length > 0));

  const machines = Effect.gen(function* () {
    const live = new Map(sandboxes.live().map((sandbox, at) => [sandbox.name, { sandbox, at }]));
    const stored = yield* rows(MachineRow, "SELECT name, seen_at, state, note, facts, login, hello, reason FROM ky_machines ORDER BY name");

    return yield* Effect.forEach(
      [...stored].sort((a, b) => (live.get(a.name)?.at ?? Infinity) - (live.get(b.name)?.at ?? Infinity)),
      (row) =>
        Effect.gen(function* () {
          const up = yield* online(row.name);
          const sandbox = live.get(row.name)?.sandbox;
          const cloud: CloudState | null = sandbox ? (up ? "running" : (yield* busy(row.name)) ? "waking" : "asleep") : null;

          return {
            name: row.name,
            online: up,
            seenAt: row.seen_at,
            reason: up && !sandbox ? null : row.reason,
            active: feed.open("machine", row.name).length,
            state: row.state,
            note: row.note,
            facts: row.facts,
            login: row.login,
            cloud,
            sandbox: sandbox ? { id: sandbox.id, repos: sandbox.repos, isDefault: sandbox.isDefault, idleMinutes: sandbox.idleMinutes } : null
          } satisfies MachineInfo;
        })
    );
  });

  const info = (name: string) => Effect.map(machines, (all) => all.find((machine) => machine.name === name));

  const pairingOf = (machine: string) => Effect.map(rows(PairingRow, "SELECT pairing FROM ky_machines WHERE name = ?", machine), (all) => all[0]?.pairing ?? null);

  const queue = (machine: string, command: Queued) => exec("INSERT INTO ky_machine_inbox (machine, payload) VALUES (?, ?)", machine, JSON.stringify(command));

  const afterTokens = <E>(what: string, work: Effect.Effect<void, E>, failed: Effect.Effect<void> = Effect.void) =>
    Effect.gen(function* () {
      const done = yield* Deferred.make<void>();
      const before = yield* Ref.getAndSet(tokenWork, Deferred.await(done));

      return before.pipe(
        Effect.andThen(work),
        Effect.catchCause((cause) => Effect.andThen(warn(`${what} failed`, Cause.squash(cause)), failed)),
        Effect.ensuring(Deferred.succeed(done, undefined))
      );
    });

  const isOver = (task: string) =>
    Effect.gen(function* () {
      const { turn, closed: upTo } = yield* turnsOf(task);
      const queued = yield* exec("SELECT 1 FROM ky_machine_inbox WHERE json_extract(payload, '$.type') = 'run' AND json_extract(payload, '$.task') = ? LIMIT 1", task);

      return upTo >= turn && queued.length === 0;
    });

  const markSent = (command: RunnerCommand) =>
    Effect.gen(function* () {
      yield* exec("UPDATE ky_machine_inbox SET sent = 1 WHERE seq = ?", command.seq);
      const codex = command.type === "creds" ? command.codex : command.type === "run" ? command.creds?.codex : undefined;

      if (codex) {
        yield* exec(
          `INSERT INTO ky_machine_logins (task, expires_at) VALUES (?, ?)
         ON CONFLICT(task) DO UPDATE SET expires_at = MAX(expires_at, excluded.expires_at)`,
          command.task,
          codex.expiresAt
        );
      }

      if (command.type === "run" && command.turn > (yield* turnsOf(command.task)).sent) yield* setTurns(command.task, { sent: command.turn });
    });

  const send = (machine: string, commands: readonly RunnerCommand[]) =>
    Effect.gen(function* () {
      const [hello] = yield* rows(HelloRow, "SELECT seen_at, hello FROM ky_machines WHERE name = ?", machine);

      for (const socket of greeted(hello?.hello ?? null)) {
        for (const command of commands) {
          const out = yield* Effect.option(Effect.try(() => socket.send(JSON.stringify(command))));

          if (Option.isSome(out)) yield* markSent(command);
        }
      }
    });

  const outgoing = (machine: string, issued: ReadonlyMap<string, string>, creds: RunCreds, agents: ReadonlySet<Agent>) =>
    Effect.gen(function* () {
      const commands: RunnerCommand[] = [];

      for (const command of yield* pending(machine)) {
        if (command.type === "stop") commands.push(command);
        else if (command.type === "creds" && creds.codex) commands.push({ ...command, codex: creds.codex });
        else if (command.type === "creds") yield* exec("DELETE FROM ky_machine_inbox WHERE seq = ?", command.seq);
        else {
          const run = runWith(command, issued.get(command.task), agents.has(command.agent) ? creds : {});

          if (!run) break;
          commands.push(run);
        }
      }

      return commands;
    });

  const retry = (machine: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (waiting.has(machine)) return;
      const tries = retries.get(machine) ?? 0;

      if (tries >= DELIVERY_RETRIES) {
        retries.delete(machine);

        return;
      }

      retries.set(machine, tries + 1);
      waiting.add(machine);
      yield* Effect.forkDetach(
        Effect.sleep(host.retryMs() * 2 ** tries).pipe(
          Effect.andThen(Effect.sync(() => waiting.delete(machine))),
          Effect.andThen(Effect.suspend(() => deliver(machine)))
        )
      );
    });

  const deliverWork = (machine: string) =>
    afterTokens(
      `delivery to ${machine}`,
      Effect.gen(function* () {
        if (!(yield* online(machine))) {
          if (sandboxes.named(machine) && (yield* pending(machine)).length > 0) host.cloud()?.wake(machine);

          return;
        }

        const target = yield* info(machine);
        const commands = yield* pending(machine);
        const tasks = new Set(commands.flatMap((command) => (command.type === "run" ? [command.task] : [])));

        const agents = new Set(
          commands.flatMap((command): Agent[] => {
            if (command.type === "creds") return ["codex"];

            return command.type === "run" && handsCreds(target, command.agent) ? [command.agent] : [];
          })
        );

        const [issued, creds] = yield* Effect.all(
          [
            Effect.forEach([...tasks], (task) => Effect.map(vault(() => tokens.issue(task)), (token) => [task, token] as const), { concurrency: "unbounded" }),
            Effect.forEach([...agents], (agent) => vault(() => host.creds(agent)), { concurrency: "unbounded" })
          ],
          { concurrency: "unbounded" }
        );

        yield* send(machine, yield* outgoing(machine, new Map(issued), creds.reduce<RunCreds>((merged, each) => Object.assign(merged, each), {}), agents));
        retries.delete(machine);
      }),
      Effect.suspend(() => retry(machine))
    );

  const deliver = (machine: string) => Effect.flatten(deliverWork(machine));

  const revokeWork = (task: string) => afterTokens(`revoking ${task}'s token`, vault(() => tokens.revoke(task)));

  const enqueue = (machine: string, command: Queued) => Effect.andThen(queue(machine, command), deliver(machine));

  const renew = (machine: string) =>
    Effect.gen(function* () {
      const open = new Set(feed.open("machine", machine).map((task) => task.id));
      const handed = (yield* rows(LoginRow, "SELECT task, expires_at FROM ky_machine_logins")).filter((row) => open.has(row.task));

      if (handed.length === 0) return;
      const { codex } = yield* vault(() => host.creds("codex"));

      if (!codex) return;
      const queued = new Set((yield* pending(machine)).flatMap((command) => (command.type === "creds" ? [command.task] : [])));

      for (const { task, expires_at } of handed) {
        if (codex.expiresAt <= expires_at || queued.has(task)) continue;
        yield* queue(machine, { type: "creds", task });
      }
    });

  const post = (task?: string) =>
    Effect.gen(function* () {
      const harness = host.harness();

      if (!harness) return;

      const owed =
        task === undefined
          ? yield* rows(ReportRow, "SELECT task, turn, session, text FROM ky_machine_reports ORDER BY task, turn")
          : yield* rows(ReportRow, "SELECT task, turn, session, text FROM ky_machine_reports WHERE task = ? ORDER BY turn", task);

      for (const report of owed) {
        if (host.wanted(report.task)) {
          const posted = yield* Effect.result(
            Effect.tryPromise(() => harness.submit(report.text, { session: report.session, operationId: `task:${report.task}:${report.turn}:${report.session}`, whenBusy: "steer" }))
          );

          if (Result.isFailure(posted)) {
            yield* warn(`report for ${report.task} turn ${report.turn} not posted`, posted.failure.cause);
            continue;
          }
        }

        yield* exec("DELETE FROM ky_machine_reports WHERE task = ? AND turn = ? AND session = ?", report.task, report.turn, report.session);
      }
    });

  const finish = (id: string, outcome: TaskOutcome, text: string, turn: number) =>
    Effect.gen(function* () {
      const task = feed.get(id);

      if (!task || (yield* closed(id, turn))) return;
      const turns = yield* turnsOf(id);
      const from = turns.closed;

      yield* setTurns(id, { closed: turn });
      yield* exec("UPDATE ky_machines SET turns_ended = turns_ended + 1 WHERE name = ?", task.worker);

      if (sandboxes.named(task.worker)) host.cloud()?.turnEnded(task.worker);

      if (turn === turns.turn) {
        yield* Effect.forkDetach(yield* revokeWork(id));
        yield* exec("DELETE FROM ky_machine_logins WHERE task = ?", id);
      }

      const ok = outcome === "done";

      feed.update(id, { status: outcome, summary: summarize(text) || (ok ? "Done" : "Failed") });

      if (ok) feed.describe(id, text);
      const report = `[machine ${task.worker}, task ${id} "${task.title}" ${ENDINGS[outcome]}, no reply needed unless the user is waiting on it]\n${text}${sharedLine(host.shared(id))}`;

      for (const session of yield* listeners(id, from, turn)) {
        yield* exec("INSERT OR IGNORE INTO ky_machine_reports (task, turn, session, text) VALUES (?, ?, ?, ?)", id, turn, session, report);
      }

      yield* post(id);
    });

  const finishOpen = (machine: string, text: string) =>
    Effect.gen(function* () {
      for (const task of feed.open("machine", machine)) yield* finish(task.id, "failed", text, (yield* turnsOf(task.id)).turn);
    });

  const onHello = (machine: string, connection: string, active: readonly string[], facts: MachineFacts) =>
    Effect.gen(function* () {
      yield* exec("UPDATE ky_machines SET seen_at = ?, facts = ?, hello = ?, reason = NULL WHERE name = ?", yield* now, JSON.stringify(facts), connection, machine);
      host.recheckAt((yield* now) + ONLINE_WITHIN_MS + 1_000);
      const unacked = new Set((yield* pending(machine)).flatMap((command) => (command.type === "run" ? [command.task] : [])));
      const lost = feed.open("machine", machine).filter((task) => !unacked.has(task.id) && !active.includes(task.id));

      for (const task of lost) yield* finish(task.id, "failed", "Interrupted: the runner restarted. Send it a message to resume.", (yield* turnsOf(task.id)).turn);

      yield* renew(machine).pipe(Effect.catchCause((cause) => warn(`renewing ChatGPT logins on ${machine} failed`, Cause.squash(cause))));
      yield* deliver(machine);
    });

  const onAck = (machine: string, seq: number) =>
    Effect.gen(function* () {
      const command = (yield* pending(machine)).find((each) => each.seq === seq);

      yield* exec("DELETE FROM ky_machine_inbox WHERE machine = ? AND seq = ?", machine, seq);

      if (command?.type !== "run" || (yield* closed(command.task, command.turn))) return;

      if (feed.get(command.task)?.status === "queued") feed.update(command.task, { status: "working" });
    });

  const onStep = ({ task, turn, text, call, input = "", state, detail = "", output = "" }: Extract<TaskReport, { type: "step" }>) =>
    Effect.gen(function* () {
      if (call !== undefined && state !== undefined) return feed.stepEnd(task, call, { text, state, detail, output });

      if (yield* closed(task, turn)) return;
      feed.step(task, text, call === undefined ? {} : { call, input });
    });

  const onResult = (report: Extract<TaskReport, { type: "result" }>) =>
    Effect.gen(function* () {
      const turns = yield* turnsOf(report.task);

      if (report.turn <= turns.closed) return;

      if (report.session) feed.update(report.task, { session: report.session });

      if (report.turns !== undefined || report.costUsd !== undefined) feed.spend(report.task, report.turns ?? 0, report.costUsd ?? 0);

      yield* finish(report.task, outcomeOf(report.ok, report.turn, turns.stopping), report.text, report.turn);
    });

  return {
    online,
    machines,
    machine: info,
    deliver,
    revoke: (task: string) => Effect.flatten(revokeWork(task)),
    post,

    recheck: Effect.gen(function* () {
      const silent = yield* rows(HelloRow, "SELECT seen_at, hello FROM ky_machines WHERE seen_at < ?", (yield* now) - ONLINE_WITHIN_MS);

      if (silent.some((row) => greeted(row.hello).length > 0)) yield* changed;
    }),

    refused: (machine: string, protocol: number) =>
      Effect.gen(function* () {
        const reason =
          protocol < PROTOCOL
            ? `Its runner is older than ky: it speaks runner protocol ${protocol}, ky ${PROTOCOL}. Get the newer ky on it, then run ky upgrade.`
            : `Its runner is newer than ky: it speaks runner protocol ${protocol}, ky ${PROTOCOL}. Deploy ky, or wait for its deploy to finish.`;

        yield* exec("UPDATE ky_machines SET reason = ? WHERE name = ?", reason, machine);
        yield* changed;
      }),

    trouble: (machine: string, reason: string | null) => Effect.andThen(exec("UPDATE ky_machines SET reason = ? WHERE name = ?", reason, machine), changed),

    startFailed: (machine: string, text: string) =>
      Effect.gen(function* () {
        if (yield* online(machine)) return;
        yield* exec("DELETE FROM ky_machine_inbox WHERE machine = ?", machine);
        yield* exec("UPDATE ky_machines SET reason = ? WHERE name = ?", text, machine);
        yield* finishOpen(machine, text);
        yield* changed;
      }),

    configure: (name: string, change: MachineChange) =>
      Effect.gen(function* () {
        if (!(yield* info(name))) return yield* new NoMachine({ name });

        if (change.state !== undefined && !isMachineState(change.state)) return yield* new NotAState({ state: change.state });

        if (change.login !== undefined && !isMachineLogin(change.login)) return yield* new NotALogin({ login: change.login });

        if (change.state !== undefined) yield* exec("UPDATE ky_machines SET state = ? WHERE name = ?", change.state, name);

        if (change.login !== undefined) yield* exec("UPDATE ky_machines SET login = ? WHERE name = ?", change.login, name);

        if (change.note !== undefined) yield* exec("UPDATE ky_machines SET note = ? WHERE name = ?", change.note.trim().slice(0, NOTE_CHARS), name);
        yield* changed;

        return must(yield* info(name), `No machine ${name}.`);
      }),

    seen: (machine: string, code?: number) => Effect.andThen(now, (at) => exec("UPDATE ky_machines SET seen_at = ?, reason = COALESCE(reason, ?) WHERE name = ?", at, closedReason(code), machine)),

    sweepTokens: Effect.flatten(
      afterTokens(
        "sweeping task tokens",
        Effect.gen(function* () {
          const over: string[] = [];

          for (const task of feed.closedSince("machine", (yield* now) - ISSUED_TTL_MS)) if (yield* isOver(task)) over.push(task);

          yield* vault(() => tokens.revokeAll(over));
        })
      )
    ),

    defaultAgent: (machine: string) => Effect.map(info(machine), (target) => defaultAgent(target?.facts ?? null)),

    start: (machine: string, title: string, prompt: string, id: string, parent: string, source: string, agent: Agent) =>
      Effect.gen(function* () {
        const existed = feed.get(id) !== undefined;
        const task = feed.create({ id, kind: "machine", source, worker: machine, title, status: "queued", session: null, agent });

        if (!existed) {
          yield* setTurns(id, { turn: 1, closed: 0, sent: 0 });
          yield* sentBy(id, 1, parent);
          yield* queue(machine, runCommand(id, 1, prompt, null, agent));
        }

        return { task, queued: !existed };
      }),

    send: (task: TaskRow, message: string, parent: string | undefined) =>
      Effect.gen(function* () {
        const from = parent ?? (yield* lastSender(task.id));
        const turn = (yield* turnsOf(task.id)).turn + 1;

        yield* setTurns(task.id, { turn });
        yield* sentBy(task.id, turn, from);
        feed.update(task.id, { status: task.status === "working" ? "working" : "queued" });
        yield* queue(task.worker, runCommand(task.id, turn, message, task.session, agentOf(task)));
      }),

    move: (task: TaskRow, to: string) =>
      Effect.gen(function* () {
        if (task.worker === to) return `${task.id} is already on ${to}.`;

        if (task.status !== "queued" || (yield* turnsOf(task.id)).sent > 0) {
          return `${task.id} has already run on ${task.worker}, and its session lives there, so it stays. Start a new task on ${to} with what it needs.`;
        }

        const agent = agentOf(task);
        const refusal = cannotRun(yield* info(to), agent);

        if (refusal) return `${refusal} ${task.id} runs as ${AGENT_NAMES[agent]}, so it stays.`;

        const commands = yield* rows(
          InboxRow,
          "SELECT seq, payload FROM ky_machine_inbox WHERE machine = ? AND sent = 0 AND json_extract(payload, '$.task') = ? ORDER BY seq",
          task.worker,
          task.id
        );

        for (const command of commands) {
          yield* exec("DELETE FROM ky_machine_inbox WHERE seq = ?", command.seq);
          yield* exec("INSERT INTO ky_machine_inbox (machine, payload) VALUES (?, ?)", to, command.payload);
        }

        feed.reassign(task.id, to);

        return null;
      }),

    stop: (task: TaskRow) =>
      Effect.gen(function* () {
        const { turn, closed: upTo, sent } = yield* turnsOf(task.id);

        if (turn <= upTo) return;

        const withdrawn = yield* rows(
          SeqRow,
          `DELETE FROM ky_machine_inbox WHERE machine = ? AND sent = 0
         AND json_extract(payload, '$.type') = 'run' AND json_extract(payload, '$.task') = ? RETURNING seq`,
          task.worker,
          task.id
        );

        if (withdrawn.length > 0 && sent <= upTo) return yield* finish(task.id, "stopped", "Stopped before it started.", turn);

        yield* setTurns(task.id, { stopping: turn });
        yield* enqueue(task.worker, { type: "stop", task: task.id, turn });
      }),

    remove: (machine: string) =>
      Effect.gen(function* () {
        const [removed] = yield* rows(PairingRow, "DELETE FROM ky_machines WHERE name = ? RETURNING pairing", machine);

        yield* exec("DELETE FROM ky_machine_inbox WHERE machine = ?", machine);
        yield* finishOpen(machine, `${machine} was removed from ky.`);
        yield* changed;

        return removed?.pairing ?? null;
      }),

    paired: (machine: string, facts: MachineFacts, pairing: string) =>
      Effect.gen(function* () {
        const previous = yield* pairingOf(machine);

        yield* exec(
          `INSERT INTO ky_machines (name, seen_at, facts, pairing) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET seen_at = excluded.seen_at, facts = excluded.facts, pairing = excluded.pairing`,
          machine,
          yield* now,
          JSON.stringify(facts),
          pairing
        );
        yield* changed;

        return previous;
      }),

    listSandboxes: Effect.gen(function* () {
      let listed = 0;

      for (const sandbox of sandboxes.live()) {
        listed += (yield* rows(NameRow, "INSERT OR IGNORE INTO ky_machines (name, seen_at, facts) VALUES (?, ?, ?) RETURNING name", sandbox.name, yield* now, JSON.stringify(CLOUD_FACTS))).length;
      }

      if (listed > 0) yield* changed;
      const kinds = yield* rows(KindRow, "SELECT name, CASE WHEN json_valid(facts) THEN json_extract(facts, '$.kind') END AS kind FROM ky_machines ORDER BY name");

      return {
        stale: kinds.filter((row) => row.kind === "cloud" && !sandboxes.named(row.name)).map((row) => row.name),
        clashes: kinds.filter((row) => row.kind !== "cloud" && sandboxes.named(row.name)).map((row) => row.name)
      };
    }),

    sandboxFor: (repo: string) =>
      Effect.map(machines, (all) => {
        const wanted = repo.trim().toLowerCase();
        const owner = all.find((machine) => machine.sandbox?.repos.includes(wanted));
        const target = owner ?? all.find((machine) => machine.sandbox?.isDefault && machine.sandbox.repos.length === 0);

        return target?.state === "on" ? target.name : undefined;
      }),

    cloudOn: Effect.map(machines, (all) => all.find((machine) => machine.sandbox?.isDefault && machine.state === "on")?.name),

    busy,

    turnsEnded: (machine: string) => Effect.map(rows(TurnsEndedRow, "SELECT turns_ended FROM ky_machines WHERE name = ?", machine), (all) => all[0]?.turns_ended ?? 0),

    pairedAs: (machine: string, pairing: string | undefined) => (pairing === undefined ? Effect.succeed(false) : Effect.map(pairingOf(machine), (live) => live === pairing)),

    onReport: (machine: string, report: TaskReport, connection: string): Effect.Effect<void> => {
      switch (report.type) {
        case "hello":
          return onHello(machine, connection, report.active, report.facts);
        case "ack":
          return onAck(machine, report.seq);
        case "session":
          return Effect.gen(function* () {
            if (yield* closed(report.task, report.turn)) return;
            feed.update(report.task, { session: report.session, status: "working" });
          });
        case "step":
          return onStep(report);
        case "result":
          return onResult(report);
        default:
          return report satisfies never;
      }
    }
  };
});

export class Machines extends Context.Service<Machines, Effect.Success<typeof make>>()("ky/machines/Machines") {
  static readonly layer = Layer.effect(Machines)(make);
}
