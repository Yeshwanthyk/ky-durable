import { defineDoc, type ConversationId, ROOT_CONVERSATION_ID, type Tx } from "@earendil-works/pi-durable";
import { ROOT_SESSION } from "agents/harness/pi";
import type { Schedule, Scheduler } from "agents/schedules";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ChatList } from "../chats/chats";
import { Sql } from "../core/sql";
import { programOutcome } from "../executor/contract";
import type { MachineHub } from "../machines/contract";
import type { Models } from "../providers/wiring";
import type { Spawn } from "../skills/contract";
import type { BackgroundWork } from "../spend/contract";
import {
  AlreadyRan,
  AUTOMATION_SOURCE as SOURCE,
  AUTOMATION_TABLES,
  automationRows,
  type AutomationAuthor,
  type AutomationDraft,
  type AutomationRow,
  type AutomationStatus,
  type AutomationView,
  CannotSchedule,
  type CheckIns,
  draftProblem,
  type Delivery,
  type LastRun,
  ModelUnavailable,
  NoAutomation,
  NoRunGoing,
  NotAZone,
  NotSaved,
  RUN_HISTORY,
  type RunInfo,
  type TaskFeed,
  type TaskRow,
  WrongStatus
} from "./contract";
import { isLive } from "./tasks";
import { cronIn, nextLocal } from "./zoned";

type AutomationRuntime = {
  readonly spawn: Spawn;
  readonly commit: (change: (tx: Tx) => Promise<void>) => Promise<void>;
  readonly wake: () => Promise<void>;
  readonly abort: (session: string) => Promise<void>;
  readonly deliver: (item: Delivery) => Promise<void>;
};

export type GateAnswer = { readonly text: string; readonly error: boolean };

export type AutomationDeps = {
  readonly feed: TaskFeed;
  readonly machines: MachineHub;
  readonly chats: ChatList;
  readonly models: Pick<Models, "worker" | "valid" | "choices">;
  readonly runtime: AutomationRuntime;
  readonly gate: (code: string, signal: AbortSignal) => Promise<GateAnswer>;
  readonly dream: { readonly cron: (zone: string | null) => string; readonly run: () => void };
  readonly looks: { readonly booked: (zone: string | null) => ReadonlyArray<{ readonly time: string; readonly cron: string }>; readonly run: (time: string) => void };
  readonly peers: () => Promise<void>;
  readonly approvals: () => void;
  readonly sites: () => Promise<void>;
  readonly unwatched: (anticipation: number) => void;
  /** Whether a scheduled run may start now (src/spend); a run the user asks for always may. */
  readonly allows: (work: BackgroundWork) => boolean;
};

const LookFire = Schema.Struct({ time: Schema.String });

type LookFire = typeof LookFire.Type;

export type Fire = { id: string; slot?: number };

export type Callbacks = {
  automation: (fire: Fire, schedule: Schedule<Fire>) => Promise<void>;
  dream: () => Promise<void>;
  look: (payload: LookFire) => Promise<void>;
  peers: () => Promise<void>;
  machines: () => Promise<void>;
  approvals: () => Promise<void>;
  sites: () => Promise<void>;
};

export type GateCheck =
  | { readonly kind: "found"; readonly text: string; readonly items?: number }
  | { readonly kind: "nothing"; readonly returned: string }
  | { readonly kind: "error"; readonly text: string };

export class Host extends Context.Service<
  Host,
  AutomationDeps & {
    readonly scheduler: Pick<Scheduler<Callbacks>, "set" | "get" | "list" | "cancel">;
    readonly emit: () => void;
  }
>()("ky/automations/Host") {}

const isCheckIn = (row: AutomationRow) => row.created_by === "dream" || row.watch !== null;

const CHECK_INS_A_DAY = 2;

const CHECK_INS_WAITING = 6;

const POSTED = "\n\nYour answer is posted to the user as ky's own message, exactly as written: write only that message, no preamble.";

const CHECK_IN_POSTS = "A check-in's report goes to the main agent, not posted.";

const CHECK_IN = `[check-in] You are looking again at something the user asked about, on the day it matters. Search the web for it in general terms: never put the user's name, their family's names or their address in a query. Read only; change nothing anywhere.

If you find nothing new, or nothing they could act on now, answer exactly NOTHING_NEW and nothing else. Otherwise answer with only the new facts, each with its source link, in a few lines.

What to look at:
`;

const GATE_TIMEOUT_MS = 30_000;

const GATE_ERRORS = 3;

const GATE_FOUND_MAX = 8_000;

const DREAM_DUE_MS = 5 * 60_000;

const SAME_NOTE = "same: found what the last fire found, so this one did not run";

const MINUTE_MS = 60_000;

type Admission = { readonly prefix: string; readonly found?: string };

const UNGATED: Admission = { prefix: "" };

type Found = { readonly hash: string; readonly task: string };

type Timing = Pick<AutomationRow, "cron" | "zone" | "at">;

type Draft = AutomationDraft & { readonly zone: string | null };

type Run = { slot: number; task: string; chat: string };

type Patch = Partial<Omit<AutomationRow, "id" | "watch" | "created_by" | "created_at" | "updated_at">>;

const StoredCheckIns = Schema.Struct({ off: Schema.Number, zone: Schema.NullOr(Schema.String), zone_pinned: Schema.Number });

const CountRow = Schema.Struct({ n: Schema.Number });

const GateFoundRow = Schema.Struct({ gate_found: Schema.NullOr(Schema.String), gate_found_by: Schema.NullOr(Schema.String) });

const ColumnInfo = Schema.Struct({ name: Schema.String });

const Nothing = Schema.Union([
  Schema.Null,
  Schema.Literal(false),
  Schema.Literal(0),
  Schema.String.check(Schema.isPattern(/^\s*$/)),
  Schema.Array(Schema.Unknown).check(Schema.isMaxLength(0)),
  Schema.Record(Schema.String, Schema.Unknown).check(Schema.isMaxProperties(0))
]);

const isNothing = Schema.is(Nothing);

const isText = Schema.is(Schema.String);

const isList = Schema.is(Schema.Array(Schema.Unknown));

const Runs = defineDoc<{ runs: Record<string, { slot: number; task: string }> }>({
  kind: "ky.automation-runs",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: () => false,
  initial: () => ({ runs: {} })
});

// SAFETY: every chat is ROOT_SESSION or a session from harness.sessions.create(), both String(conversation id).
const conversationOf = (session: string) => Number(session) as ConversationId;

const sourceOf = (id: string) => `${SOURCE}${id}`;

const workerOf = (id: string) => `automation-${id}`;

const encoder = new TextEncoder();

async function digest(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function slotOf(fire: Fire, schedule: Schedule<Fire>, row: AutomationRow): number {
  if (fire.slot !== undefined) return fire.slot;

  return row.at === null ? schedule.time : Math.floor(row.at / 1000);
}

function lastOf(task: TaskRow | undefined): LastRun | null {
  return task ? { id: task.id, status: task.status, summary: task.summary, finished_at: task.finished_at } : null;
}

function runOf(task: TaskRow): RunInfo {
  const { id, status, summary, created_at, started_at, finished_at, cost_usd } = task;

  return { id, status, summary, created_at, started_at, finished_at, cost_usd };
}

function noteOf(check: GateCheck): string {
  if (check.kind === "nothing") return "nothing";

  const text = check.text.replaceAll(/\s+/g, " ");

  return `${check.kind}: ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`;
}

function ianaZone(zone: string): string | undefined {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;

    return /^[+-]/.test(name) ? undefined : name;
  } catch {
    return undefined;
  }
}

function timingOf(patch: Partial<AutomationDraft>): Partial<AutomationDraft> {
  if (patch.cron !== undefined) return { cron: patch.cron, at: null };

  return patch.at === undefined ? {} : { cron: null, at: patch.at };
}

function draftOf({ title, prompt, cron, at, model, machine, chat, gate, post }: AutomationDraft): AutomationDraft {
  return { title, prompt, cron, at, model, machine, chat, gate, post };
}

function refusal(id: string, row: AutomationRow | undefined, wanted: string, next?: string) {
  const then = next === undefined ? {} : { next };

  return row ? new WrongStatus({ title: row.title, status: row.status, wanted, ...then }) : new NoAutomation({ id, ...then });
}

const make = Effect.gen(function* () {
  const sql = yield* Sql;
  const host = yield* Host;
  const { machines, chats, models, runtime } = host;
  const feed: TaskFeed = host.feed;
  const now = Clock.currentTimeMillis;
  const exec = (query: string, ...bindings: SqlStorageValue[]) => sql.exec(query, ...bindings).pipe(Effect.orDie);
  const rows = (query: string, ...bindings: string[]) => Effect.map(exec(query, ...bindings), automationRows);
  const emit = Effect.sync(() => host.emit());
  const scheduled = <A>(call: (scheduler: typeof host.scheduler) => Promise<A>) => Effect.promise(() => call(host.scheduler));
  const cancel = (scheduleId: string) => scheduled((scheduler) => scheduler.cancel(scheduleId));

  const addColumns = (table: string, columns: ReadonlyArray<readonly [string, string]>) =>
    Effect.gen(function* () {
      const have = (yield* sql.rows(ColumnInfo, `PRAGMA table_info(${table})`).pipe(Effect.orDie)).map((column) => column.name);

      for (const [name, type] of columns) {
        if (!have.includes(name)) yield* exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
    });

  yield* exec("CREATE TABLE IF NOT EXISTS ky_check_ins (id INTEGER PRIMARY KEY CHECK (id = 1), off INTEGER NOT NULL, zone TEXT)");
  yield* addColumns(AUTOMATION_TABLES.checkIns, [["zone_pinned", "INTEGER NOT NULL DEFAULT 0"]]);
  yield* exec(`CREATE TABLE IF NOT EXISTS ky_automations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      cron TEXT,
      at INTEGER,
      model TEXT,
      machine TEXT,
      chat TEXT NOT NULL,
      gate TEXT,
      gate_checked_at INTEGER,
      gate_note TEXT,
      gate_errors INTEGER NOT NULL DEFAULT 0,
      gate_found TEXT,
      gate_found_by TEXT,
      watch INTEGER,
      post INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      status TEXT NOT NULL,
      schedule_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL)`);
  yield* addColumns(AUTOMATION_TABLES.automations, [
    ["gate", "TEXT"],
    ["gate_checked_at", "INTEGER"],
    ["gate_note", "TEXT"],
    ["gate_errors", "INTEGER NOT NULL DEFAULT 0"],
    ["gate_found", "TEXT"],
    ["gate_found_by", "TEXT"],
    ["watch", "INTEGER"],
    ["post", "INTEGER NOT NULL DEFAULT 0"],
    ["zone", "TEXT DEFAULT 'UTC'"]
  ]);

  const get = (id: string) => Effect.map(rows("SELECT * FROM ky_automations WHERE id = ?", id), (found) => found[0]);

  const set = (id: string, patch: Patch, when?: readonly AutomationStatus[]) =>
    Effect.gen(function* () {
      const current = yield* get(id);

      if (!current || (when !== undefined && !when.includes(current.status))) return false;
      const next = { ...current, ...patch };
      yield* exec(
        `UPDATE ky_automations SET title = ?, prompt = ?, cron = ?, zone = ?, at = ?, model = ?, machine = ?, chat = ?, gate = ?, post = ?,
         gate_checked_at = ?, gate_note = ?, gate_errors = ?, status = ?, schedule_id = ?, updated_at = ? WHERE id = ?`,
        next.title,
        next.prompt,
        next.cron,
        next.zone ?? null,
        next.at,
        next.model === null ? null : JSON.stringify(next.model),
        next.machine,
        next.chat,
        next.gate,
        next.post ? 1 : 0,
        next.gate_checked_at,
        next.gate_note,
        next.gate_errors,
        next.status,
        next.schedule_id,
        yield* now,
        id
      );
      yield* emit;

      return true;
    });

  const decodeCheckIns = Schema.decodeUnknownOption(StoredCheckIns);

  const checkIns = Effect.map(exec("SELECT off, zone, zone_pinned FROM ky_check_ins WHERE id = 1"), ([stored]): CheckIns => {
    const row = Option.getOrUndefined(decodeCheckIns(stored));

    return { on: row?.off !== 1, zone: row?.zone ?? null, pinned: row?.zone_pinned === 1 };
  });

  const keepZone = (zone: string, pinned: boolean) =>
    exec(
      "INSERT INTO ky_check_ins (id, off, zone, zone_pinned) VALUES (1, 0, ?, ?) ON CONFLICT (id) DO UPDATE SET zone = excluded.zone, zone_pinned = excluded.zone_pinned",
      zone,
      pinned ? 1 : 0
    );

  const nextTime = (cron: string, zone: string | null, after: number) =>
    Effect.try({ try: () => nextLocal(cron, zone, after), catch: (error) => new CannotSchedule({ cron, why: error instanceof Error ? error.message : String(error) }) });

  const book = (id: string, timing: Timing, zone?: string | null) =>
    Effect.gen(function* () {
      const userZone = zone === undefined ? (yield* checkIns).zone : zone;
      const at = timing.cron === null ? Math.max(timing.at ?? 0, yield* now) : yield* nextTime(timing.cron, timing.zone ?? userZone, yield* now);

      const booked = yield* Effect.tryPromise({
        try: () => host.scheduler.set(new Date(at), "automation", { id }, { idempotent: true }),
        catch: (error) => new CannotSchedule({ cron: timing.cron, why: error instanceof Error ? error.message : String(error) })
      });

      return booked.id;
    });

  const bookNext = (row: AutomationRow, due: number) =>
    Effect.gen(function* () {
      const at = yield* nextTime(row.cron ?? "", row.zone ?? (yield* checkIns).zone, Math.max(due, yield* now)).pipe(Effect.orDie);

      return (yield* scheduled((scheduler) => scheduler.set(new Date(at), "automation", { id: row.id }))).id;
    });

  const unbook = (row: AutomationRow) => (row.schedule_id === null ? Effect.void : Effect.asVoid(cancel(row.schedule_id)));

  const keepBooking = (id: string, scheduleId: string | null) =>
    Effect.gen(function* () {
      if ((yield* set(id, { schedule_id: scheduleId }, ["active"])) || scheduleId === null) return;
      yield* cancel(scheduleId);
    });

  const stopRun = (id: string) =>
    Effect.gen(function* () {
      const run = feed.latestFrom(sourceOf(id));

      if (!run || !isLive(run.status)) return false;

      if (run.kind === "machine") {
        yield* Effect.promise(() => machines.stop(run));

        return true;
      }

      feed.update(run.id, { status: "stopped", summary: "Stopped" });

      if (run.session !== null) {
        const { session } = run;
        yield* Effect.promise(() => runtime.abort(session));
      }

      return true;
    });

  const halt = (row: AutomationRow, status: "paused" | "archived") =>
    Effect.gen(function* () {
      const booked = (yield* get(row.id))?.schedule_id ?? null;

      yield* set(row.id, { status, schedule_id: null });

      if (booked !== null) yield* cancel(booked);
      yield* stopRun(row.id);
    });

  const done = (id: string, firing: string) =>
    Effect.gen(function* () {
      const row = yield* get(id);

      if (row?.status !== "active") return;

      if (row.schedule_id !== null && row.schedule_id !== firing) yield* cancel(row.schedule_id);
      yield* set(id, { status: "done", schedule_id: null }, ["active"]);
    });

  const machineProblem = (machine: string | null, post = false): string | undefined => {
    if (machine === null) return undefined;

    if (post) return "A posted report runs in the cloud: ask ky to update it with post false first.";
    const known = machines.machines().map((each) => each.name);

    if (known.includes(machine)) return undefined;

    return `No machine ${machine}. Known: ${known.join(", ") || "none"}.`;
  };

  const chatProblem = (chat: string): string | undefined => {
    if (chat === ROOT_SESSION || chats.has(chat)) return undefined;
    const known = chats.list().map((each) => `${each.title || "untitled"} (${each.session})`);

    return `No chat ${chat}. Use main, or one of: ${known.join(", ") || "no side chats"}.`;
  };

  const check = (draft: AutomationDraft) =>
    Effect.gen(function* () {
      const problem = draftProblem(draft) ?? machineProblem(draft.machine, draft.post) ?? chatProblem(draft.chat);

      if (problem !== undefined) return yield* new NotSaved({ problem });

      if (draft.model === null) return draft;
      const model = models.valid(draft.model);

      if (!model) return yield* new ModelUnavailable({ provider: draft.model.provider, modelId: draft.model.modelId, choices: models.choices() });

      return { ...draft, model };
    });

  const decodeCount = Schema.decodeUnknownOption(CountRow);

  const count = (query: string, ...bindings: number[]) => Effect.map(exec(query, ...bindings), ([row]) => Option.getOrElse(decodeCount(row), () => ({ n: 0 })).n);

  const checkInCapProblem = Effect.gen(function* () {
    if ((yield* count("SELECT COUNT(*) AS n FROM ky_automations WHERE created_by = 'dream' AND created_at > ?", (yield* now) - 86_400_000)) >= CHECK_INS_A_DAY) {
      return `${CHECK_INS_A_DAY} check-ins were booked in the last day; that is the limit.`;
    }

    if ((yield* count("SELECT COUNT(*) AS n FROM ky_automations WHERE created_by = 'dream' AND status = 'active'")) >= CHECK_INS_WAITING) {
      return `${CHECK_INS_WAITING} check-ins are already waiting; that is the limit.`;
    }

    return undefined;
  });

  const checkInProblem = (draft: AutomationDraft) =>
    Effect.gen(function* () {
      if (!(yield* checkIns).on) return "The user turned check-ins off.";

      if (draft.cron !== null || draft.at === null) return "A check-in runs once: give at, not cron.";

      if (draft.at <= (yield* now)) return "A check-in's time must be ahead.";

      if (draft.machine !== null || draft.chat !== ROOT_SESSION) return "A check-in runs in the cloud and reports to the main chat.";

      if (draft.gate !== null) return "A check-in has no gate.";

      if (draft.post) return CHECK_IN_POSTS;

      return yield* checkInCapProblem;
    });

  const stale = (row: AutomationRow, booked: Schedule<unknown>, zone: string | null, at: number) =>
    Effect.gen(function* () {
      if (booked.type === "cron") return true;
      const due = booked.time * 1000;

      return due > at + MINUTE_MS && due !== (yield* nextTime(row.cron ?? "", row.zone ?? zone, at).pipe(Effect.orDie));
    });

  const bookAutomations = (zone: string | null) =>
    Effect.gen(function* () {
      const at = yield* now;

      if (zone !== null) {
        for (const row of yield* rows("SELECT * FROM ky_automations WHERE zone = 'UTC' AND cron IS NOT NULL")) {
          const local = cronIn(row.cron ?? "", zone, at);

          if (local !== undefined) yield* set(row.id, { cron: local, zone: null });
        }
      }

      for (const row of yield* rows("SELECT * FROM ky_automations WHERE status = 'active'")) {
        const { schedule_id: scheduleId } = row;
        const booked = scheduleId === null ? undefined : yield* scheduled((scheduler) => scheduler.get(scheduleId));

        if (booked && !(row.cron !== null && (yield* stale(row, booked, zone, at)))) continue;

        if (booked) yield* cancel(booked.id);
        yield* keepBooking(row.id, yield* book(row.id, row, zone).pipe(Effect.orDie));
      }
    });

  const bookDream = (zone: string | null) =>
    Effect.gen(function* () {
      const cron = host.dream.cron(zone);
      const old = (yield* scheduled((scheduler) => scheduler.list())).filter((each) => each.callback === "dream" && each.type === "cron" && each.cron !== cron);
      const at = yield* now;

      if (old.some((each) => each.time * 1000 < at + DREAM_DUE_MS)) return;

      for (const each of old) yield* cancel(each.id);

      yield* scheduled((scheduler) => scheduler.set(cron, "dream", undefined, { idempotent: true }));
    });

  const decodeLook = Schema.decodeUnknownOption(LookFire);

  const bookLooks = (zone: string | null) =>
    Effect.gen(function* () {
      const wanted = host.looks.booked(zone);
      const key = (time: string | undefined, cron: string | undefined) => `${time} ${cron}`;
      const keep = new Set(wanted.map((look) => key(look.time, look.cron)));

      for (const old of yield* scheduled((scheduler) => scheduler.list())) {
        if (old.callback === "look" && !keep.has(key(Option.getOrUndefined(decodeLook(old.payload))?.time, old.type === "cron" ? old.cron : undefined))) {
          yield* cancel(old.id);
        }
      }

      for (const look of wanted) yield* scheduled((scheduler) => scheduler.set(look.cron, "look", { time: look.time }, { idempotent: true }));
    });

  const bookZone = Effect.gen(function* () {
    let zone = (yield* checkIns).zone;

    for (;;) {
      yield* bookDream(zone);
      yield* bookLooks(zone);
      yield* bookAutomations(zone);
      const kept = (yield* checkIns).zone;

      if (kept === zone) return;
      zone = kept;
    }
  });

  const reportTo = (chat: string): string => {
    if (chat === ROOT_SESSION) return chat;
    const row = chats.list().find((each) => each.session === chat);

    if (!row) return ROOT_SESSION;

    if (row.archived_at !== null) chats.archive(chat, false);

    return chat;
  };

  const decodeFound = Schema.decodeUnknownOption(GateFoundRow);

  const lastFound = (id: string) =>
    Effect.map(exec("SELECT gate_found, gate_found_by FROM ky_automations WHERE id = ?", id), ([stored]): Found | undefined => {
      const row = Option.getOrUndefined(decodeFound(stored));

      return row?.gate_found && row.gate_found_by ? { hash: row.gate_found, task: row.gate_found_by } : undefined;
    });

  const keepFound = (id: string, found: Found | null) => exec("UPDATE ky_automations SET gate_found = ?, gate_found_by = ? WHERE id = ?", found?.hash ?? null, found?.task ?? null, id);

  const checkGate = (code: string) =>
    Effect.gen(function* () {
      const answered = yield* Effect.tryPromise({ try: (signal) => host.gate(code, signal), catch: (error) => (error instanceof Error ? error.message : String(error)) }).pipe(
        Effect.catch((text) => Effect.succeed<GateAnswer>({ text, error: true })),
        Effect.timeoutOption(GATE_TIMEOUT_MS)
      );

      if (Option.isNone(answered)) return { kind: "error", text: `timed out after ${GATE_TIMEOUT_MS / 1000}s` } satisfies GateCheck;
      const answer = answered.value;

      if (answer.error) return { kind: "error", text: answer.text.trim() || "Executor gave no reason" } satisfies GateCheck;
      const outcome = programOutcome(answer.text);

      if (outcome.kind === "paused") return { kind: "error", text: "it asked for an approval or input; a gate may only read" } satisfies GateCheck;

      if (outcome.kind === "failed") return { kind: "error", text: outcome.text } satisfies GateCheck;

      const { value } = outcome;

      if (value === undefined || isNothing(value)) return { kind: "nothing", returned: JSON.stringify(value) ?? "undefined" } satisfies GateCheck;
      const text = isText(value) ? value.trim() : JSON.stringify(value);

      return (isList(value) ? { kind: "found", text, items: value.length } : { kind: "found", text }) satisfies GateCheck;
    });

  const gatePaused = (row: AutomationRow, task: string, errors: number, said: string) =>
    Effect.gen(function* () {
      const current = yield* get(row.id);

      if (current === undefined) return yield* Effect.die(new Error(`Automation ${row.id} is gone.`));
      yield* halt(current, "paused");
      yield* Effect.promise(() =>
        runtime.deliver({
          id: `gate-paused:${task}`,
          session: reportTo(row.chat),
          content: `[automation "${row.title}" paused] Its gate failed ${errors} fires in a row; the last said: ${said}. Fix the gate (automation update) and resume it.`,
          line: `automation "${row.title}" paused: its gate failed ${errors} fires in a row.`,
          ref: `automation:${row.id}`
        })
      );
    });

  const admitFound = (id: string, task: string, text: string, forced: boolean) =>
    Effect.gen(function* () {
      const found = yield* Effect.promise(() => digest(text));
      const last = yield* lastFound(id);
      const failed = last !== undefined && feed.get(last.task)?.status === "failed";
      const repeat = !forced && last !== undefined && !failed && last.hash === found && last.task !== task;
      yield* set(id, { gate_checked_at: yield* now, gate_note: repeat ? SAME_NOTE : noteOf({ kind: "found", text }), gate_errors: 0 });

      const admitted: Admission = { prefix: `Gate found:\n${text.slice(0, GATE_FOUND_MAX)}\n\n`, found };

      return repeat ? null : admitted;
    });

  const admit = (row: AutomationRow, task: string, forced: boolean) =>
    Effect.gen(function* () {
      if (row.gate === null) return UNGATED;
      const { gate } = row;
      const check = yield* checkGate(gate);

      if (check.kind === "found") return yield* admitFound(row.id, task, check.text, forced);
      const errors = check.kind === "error" ? row.gate_errors + 1 : 0;
      yield* set(row.id, { gate_checked_at: yield* now, gate_note: noteOf(check), gate_errors: errors });

      if (check.kind === "nothing") yield* keepFound(row.id, null);

      if (forced) return UNGATED;

      if (check.kind === "error" && errors >= GATE_ERRORS) yield* gatePaused(row, task, errors, check.text);

      return null;
    });

  const runInCloud = (row: AutomationRow, { slot, task, chat }: Run) =>
    Effect.gen(function* () {
      feed.create({
        id: task,
        kind: "cloud",
        source: sourceOf(row.id),
        worker: workerOf(row.id),
        title: row.title,
        status: "queued",
        session: null
      });

      yield* Effect.tryPromise({
        try: () =>
          runtime.commit(async (tx) => {
            const { runs } = await tx.doc(Runs, ROOT_CONVERSATION_ID);

            if (runs[row.id]?.task === task) return;
            runs[row.id] = { slot, task };
            const checkIn = isCheckIn(row);
            await runtime.spawn(tx, conversationOf(chat), {
              name: workerOf(row.id),
              message: `${checkIn ? CHECK_IN : ""}${row.prompt}${row.post ? POSTED : ""}`,
              model: models.worker(row.model),
              feedId: task,
              label: `${checkIn ? "check-in" : "automation"} "${row.title}"`,
              checkIn,
              deliver: true,
              post: row.post && !checkIn
            });
          }),
        catch: (error) => error
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            feed.update(task, { status: "failed", summary: `Could not start: ${error instanceof Error ? error.message : String(error)}` });

            if (row.at !== null && (yield* get(row.id))?.status === "active") yield* set(row.id, { status: "paused", schedule_id: null });

            return yield* Effect.die(error);
          })
        )
      );

      yield* Effect.promise(() => runtime.wake());
    });

  const runOnMachine = (row: AutomationRow, machine: string, { task, chat }: Omit<Run, "slot">) => {
    const state = machines.machine(machine)?.state ?? "on";

    if (state === "on") {
      machines.start(machine, row.title, row.prompt, task, chat, sourceOf(row.id));

      return;
    }

    feed.create({
      id: task,
      kind: "machine",
      source: sourceOf(row.id),
      worker: machine,
      title: row.title,
      status: "failed",
      summary: `${machine} is ${state}: the user is not letting it take new tasks.`,
      session: null,
      agent: machines.defaultAgent(machine)
    });
  };

  const start = (row: AutomationRow, slot: number, task: string) => {
    const chat = reportTo(row.chat);
    const { machine } = row;

    return machine === null ? runInCloud(row, { slot, task, chat }) : Effect.sync(() => runOnMachine(row, machine, { task, chat }));
  };

  const ran = (task: string): boolean => {
    const own = feed.get(task);

    return own !== undefined && own.status !== "queued" && own.status !== "failed";
  };

  const overlaps = (id: string, task: string): boolean => {
    const last = feed.latestFrom(sourceOf(id));

    return last !== undefined && last.id !== task && isLive(last.status);
  };

  const rebooks = (row: AutomationRow, fired: Fire, schedule: Schedule<Fire>) => row.cron !== null && fired.slot === undefined && schedule.type !== "cron" && row.schedule_id === schedule.id;

  // A run the user asked for always starts; a scheduled one only when spend allows it.
  const allowed = (row: AutomationRow, fired: Fire) => fired.slot !== undefined || host.allows(isCheckIn(row) ? "check-in" : "automation");

  const runDue = (row: AutomationRow, fired: Fire, slot: number, task: string) =>
    Effect.gen(function* () {
      if (!(yield* Effect.sync(() => allowed(row, fired))) || ran(task)) return;
      const admitted = yield* admit(row, task, fired.slot !== undefined);

      if (admitted === null) return;
      yield* start({ ...row, prompt: `${admitted.prefix}${row.prompt}` }, slot, task);

      if (admitted.found !== undefined) yield* keepFound(row.id, { hash: admitted.found, task });
    });

  const fire = (fired: Fire, schedule: Schedule<Fire>) =>
    Effect.gen(function* () {
      const row = yield* get(fired.id);

      if (row?.status !== "active") return;

      if (rebooks(row, fired, schedule)) yield* keepBooking(row.id, yield* bookNext(row, schedule.time * 1000));
      const slot = slotOf(fired, schedule, row);
      const task = `a-${row.id}-${slot}`;

      if (overlaps(row.id, task)) return;
      yield* runDue(row, fired, slot, task);

      if (row.at !== null) yield* done(row.id, schedule.id);
    });

  const view = (row: AutomationRow) =>
    Effect.gen(function* () {
      const { schedule_id: scheduleId, ...rest } = row;
      const next = scheduleId === null ? undefined : yield* scheduled((scheduler) => scheduler.get(scheduleId));
      const runs = feed.recentFrom(sourceOf(row.id), RUN_HISTORY);

      return {
        ...rest,
        zone: row.zone ?? (yield* checkIns).zone ?? "UTC",
        next_run: next ? next.time * 1000 : null,
        last_run: lastOf(runs[0]),
        runs: runs.map(runOf)
      } satisfies AutomationView;
    });

  const retire = (id: string) =>
    Effect.gen(function* () {
      const row = yield* get(id);

      if (!row) return;
      yield* halt(row, "archived");
      yield* exec("DELETE FROM ky_automations WHERE id = ?", id);
      yield* emit;
    });

  const rebook = (row: AutomationRow, draft: Draft) =>
    Effect.gen(function* () {
      yield* unbook(row);

      const booked = yield* book(row.id, draft).pipe(
        Effect.tapError(() =>
          Effect.flatMap(
            book(row.id, row).pipe(Effect.orElseSucceed(() => null)),
            (kept) => keepBooking(row.id, kept)
          )
        )
      );

      yield* set(row.id, draft);
      yield* keepBooking(row.id, booked);
    });

  return {
    get,

    list: (all: boolean) =>
      Effect.flatMap(
        rows(all ? "SELECT * FROM ky_automations ORDER BY created_at DESC" : "SELECT * FROM ky_automations WHERE status IN ('active', 'paused') ORDER BY created_at DESC"),
        (found) => Effect.forEach(found, view)
      ),

    watches: Effect.map(rows("SELECT * FROM ky_automations WHERE watch IS NOT NULL"), (found) =>
      found.flatMap(({ id, watch, status }) => (watch === null ? [] : [{ id, watch, status }]))
    ),

    checkIns,

    setCheckIns: (on: boolean) =>
      Effect.gen(function* () {
        yield* exec("INSERT INTO ky_check_ins (id, off, zone) VALUES (1, ?, NULL) ON CONFLICT (id) DO UPDATE SET off = excluded.off", on ? 0 : 1);

        if (!on) {
          for (const row of yield* rows("SELECT * FROM ky_automations WHERE created_by = 'dream' AND status = 'active'")) yield* halt(row, "paused");
        }

        yield* emit;
      }),

    setZone: (zone: string) =>
      Effect.gen(function* () {
        const kept = yield* checkIns;

        if (kept.pinned || zone === kept.zone) return;
        yield* exec(
          "INSERT INTO ky_check_ins (id, off, zone) VALUES (1, 0, ?) ON CONFLICT (id) DO UPDATE SET zone = excluded.zone WHERE ky_check_ins.zone_pinned = 0",
          zone
        );
        yield* bookZone;
      }),

    pinZone: (zone: string) =>
      Effect.gen(function* () {
        const name = ianaZone(zone);

        if (name === undefined) return yield* new NotAZone({ zone });
        yield* keepZone(name, true);
        yield* bookZone;
      }),

    unpinZone: (detected: string | null) =>
      Effect.gen(function* () {
        if (detected === null) {
          yield* exec("UPDATE ky_check_ins SET zone_pinned = 0 WHERE id = 1");

          return;
        }

        yield* keepZone(detected, false);
        yield* bookZone;
      }),

    checkInRun: (session: string) =>
      Effect.gen(function* () {
        const task = feed.working(session);

        if (!task?.source.startsWith(SOURCE)) return false;

        const row = yield* get(task.source.slice(SOURCE.length));

        return row !== undefined && isCheckIn(row);
      }),

    create: (draft: AutomationDraft, author: AutomationAuthor, watch: number | null) =>
      Effect.gen(function* () {
        const problem = author === "dream" ? yield* checkInProblem(draft) : undefined;

        if (problem !== undefined) return yield* new NotSaved({ problem });
        const checked = yield* check(draft);
        const id = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
        const booked = yield* book(id, { ...checked, zone: null });
        const at = yield* now;
        yield* exec(
          `INSERT INTO ky_automations
        (id, title, prompt, cron, zone, at, model, machine, chat, gate, watch, post, created_by, status, schedule_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
          id,
          checked.title,
          checked.prompt,
          checked.cron,
          checked.at,
          checked.model === null ? null : JSON.stringify(checked.model),
          checked.machine,
          checked.chat,
          checked.gate,
          watch,
          checked.post ? 1 : 0,
          author,
          booked,
          at,
          at
        );
        yield* emit;
        const row = yield* get(id);

        return row ?? (yield* Effect.die(new Error(`Automation ${id} wasn't saved.`)));
      }),

    update: (id: string, patch: Partial<AutomationDraft>) =>
      Effect.gen(function* () {
        const row = yield* get(id);

        if (!row) return yield* new NoAutomation({ id });

        if (patch.post && isCheckIn(row)) return yield* new NotSaved({ problem: CHECK_IN_POSTS });
        const retimed = patch.cron !== undefined || patch.at !== undefined;
        const checked = yield* check(draftOf({ ...row, ...patch, ...timingOf(patch) }));
        const timed = { ...checked, zone: patch.cron === undefined ? (row.zone ?? null) : null };

        if (row.status === "active" && retimed) yield* rebook(row, timed);
        else yield* set(id, timed);

        if (checked.gate !== row.gate) {
          yield* set(id, { gate_checked_at: null, gate_note: null, gate_errors: 0 });
          yield* keepFound(id, null);
        }

        return (yield* get(id)) ?? (yield* new NoAutomation({ id }));
      }),

    pause: (id: string) =>
      Effect.gen(function* () {
        const row = yield* get(id);

        if (row?.status !== "active") return yield* refusal(id, row, "active");
        yield* halt(row, "paused");

        return `Paused "${row.title}".`;
      }),

    stop: (id: string) =>
      Effect.gen(function* () {
        const row = yield* get(id);

        if (!row) return yield* new NoAutomation({ id });

        if (!(yield* stopRun(row.id))) return yield* new NoRunGoing({ title: row.title });

        return `Stopped "${row.title}"'s run.`;
      }),

    archive: (id: string) =>
      Effect.gen(function* () {
        const row = yield* get(id);

        if (!row || row.status === "archived") return yield* refusal(id, row, "not archived");
        yield* halt(row, "archived");

        return `Archived "${row.title}".`;
      }),

    resume: (id: string) =>
      Effect.gen(function* () {
        const row = yield* get(id);

        if (row?.status !== "paused" && row?.status !== "done") return yield* refusal(id, row, "paused or done");

        if (row.status === "done" && row.at !== null && row.at <= (yield* now)) return yield* new AlreadyRan({ title: row.title, at: row.at });

        const booked = yield* book(row.id, row).pipe(Effect.orDie);

        if (!(yield* set(id, { status: "active", schedule_id: booked }, ["paused", "done"]))) {
          yield* cancel(booked);

          return yield* refusal(id, yield* get(id), "paused or done");
        }

        return `Resumed "${row.title}".`;
      }),

    delete: (id: string) =>
      Effect.gen(function* () {
        const row = yield* get(id);

        if (!row) return yield* new NoAutomation({ id });
        yield* retire(id);

        if (row.watch !== null) host.unwatched(row.watch);

        return `Deleted "${row.title}".`;
      }),

    retire,

    unarchive: (id: string) =>
      Effect.gen(function* () {
        const row = yield* get(id);

        if (row?.status !== "archived") return yield* refusal(id, row, "archived");
        yield* set(id, { status: "paused" });

        return `Unarchived "${row.title}"; it is paused.`;
      }),

    run: (id: string) =>
      Effect.gen(function* () {
        const row = yield* get(id);

        if (row?.status !== "active") return yield* refusal(id, row, "active", "Resume it first.");
        const at = yield* now;
        yield* scheduled((scheduler) => scheduler.set(new Date(at), "automation", { id, slot: Math.floor(at / 1000) }));

        return `Running "${row.title}" now; its result is reported when it ends.`;
      }),

    wanted: (feedId: string) =>
      Effect.gen(function* () {
        const task = feed.get(feedId);
        const source = task?.source ?? "";

        if (!source.startsWith(SOURCE)) return true;

        if (task?.status === "stopped") return false;
        const status = (yield* get(source.slice(SOURCE.length)))?.status;

        return status === "active" || status === "done";
      }),

    bookAt: (callback: "machines" | "peers" | "sites", at: number) => Effect.asVoid(scheduled((scheduler) => scheduler.set(new Date(at), callback))),

    // One alarm, at the earliest card due a reminder or its lapse.
    approvalsAt: (at: number) =>
      Effect.gen(function* () {
        const booked = (yield* scheduled((scheduler) => scheduler.list())).filter((each) => each.callback === "approvals" && each.type !== "cron");

        // The scheduler keeps whole seconds; rounded down, the alarm would fire before the card is due.
        const second = Math.ceil(at / 1000) * 1000;

        if (booked.some((each) => each.time * 1000 <= second)) return;

        for (const old of booked) yield* cancel(old.id);

        yield* scheduled((scheduler) => scheduler.set(new Date(second), "approvals"));
      }),

    dreamAt: (at: number) =>
      Effect.gen(function* () {
        for (const old of yield* scheduled((scheduler) => scheduler.list())) {
          if (old.callback === "dream" && old.type !== "cron") yield* cancel(old.id);
        }

        yield* scheduled((scheduler) => scheduler.set(new Date(at), "dream"));
      }),

    recover: Effect.gen(function* () {
      yield* bookDream((yield* checkIns).zone);
      yield* bookLooks((yield* checkIns).zone);

      yield* bookAutomations((yield* checkIns).zone);
    }),

    bookLooks: Effect.flatMap(checkIns, ({ zone }) => bookLooks(zone)),

    checkGate,

    fire
  };
});

export class Automator extends Context.Service<Automator, Effect.Success<typeof make>>()("ky/automations/Automator") {
  static readonly layer = Layer.effect(Automator)(make);
}

