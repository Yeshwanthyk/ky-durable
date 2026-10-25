import { defineDoc, type ConversationId, ROOT_CONVERSATION_ID, type Tx } from "@earendil-works/pi-durable";
import { ROOT_SESSION } from "agents/harness/pi";
import type { Schedule, Scheduler } from "agents/schedules";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ChatList } from "../chats";
import { Sql } from "../core/sql";
import { programOutcome } from "../executor-status";
import type { MachineHub } from "../machines/contract";
import type { Models } from "../models";
import type { Spawn } from "../skills/contract";
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

/**
 * Automations: jobs that run on a schedule, set up from chat for the user or
 * by ky for itself ("every weekday at 9, check X and tell me"). Each
 * automation is a row here, booked on the Agents SDK Scheduler as a one-off:
 * its time, or the next time its cron names in the user's zone, each cron fire
 * booking the next (src/automations/zoned.ts), so 9 AM stays 9 AM across a
 * daylight-saving change and moves with the user. Each fire starts one run: a fresh cloud subagent, or a
 * task on a machine. Its result reaches the main chat through the subagent
 * reporter or the machines report path, and its row in the task feed, with
 * source `automation:<id>`, is the automation's last run.
 *
 * A gate keeps a frequent automation cheap: a short Executor program run
 * before each fire, with no model. What counts is the program's return value
 * (`execution.value` in Executor's envelope), never the envelope. When it
 * returns nothing (null, undefined, false, 0, a blank string, an empty list
 * or object) the slot is skipped and only the row's last check says so;
 * when it returns something, that is put before the run's prompt. A program
 * that fails or pauses for an approval is a failed gate, never a find. When it
 * returns what it did the last fire it found something (the same unread mail
 * again), the slot is skipped too: the row keeps a hash of that text. A gate
 * that fails three fires in a row pauses its automation and the chat is told.
 * What a run or a pause tells its chat goes through delivery
 * (src/automations/delivery.ts), between its turns.
 *
 * The Scheduler delivers a fire at least once, so a run is keyed by its slot
 * (the fire's due time): task `a-<id>-<slot>`. A slot runs once, a fire is
 * skipped while the previous run is still going, and nothing starts or
 * reports once the automation is paused or archived.
 *
 * Check-ins are the dream's own one-offs (author `dream`): something the user
 * asked about with a date ahead, looked at again on the day. Each run may only
 * search and read the web, answers NOTHING_NEW when it found nothing worth
 * saying, and only then stays out of the chat. Two may be booked a day, six
 * may wait at once, and the user can turn them off.
 *
 * Watches are ky's own gated automations a look books for a watch
 * anticipation (src/dreaming/looks.ts): `watch` holds its id, and the look's
 * side deletes the automation once that closes.
 *
 * The domain is an Effect service over the Durable Object's SQLite (`Sql`) and what the object gives it (`Host`);
 * it fails with the contract's refusals, and src/automations/wiring.ts is its edge.
 */

/** What runs need from pi, set up in server.ts. */
export type AutomationRuntime = {
  readonly spawn: Spawn;
  /** One commit on pi's session. */
  readonly commit: (change: (tx: Tx) => Promise<void>) => Promise<void>;
  /** Keep pi awake for the tasks a commit created. */
  readonly wake: () => Promise<void>;
  /** Abort what a pi conversation is doing. */
  readonly abort: (session: string) => Promise<void>;
  /** Tell a chat something, between its turns (src/automations/delivery.ts); once per id. */
  readonly deliver: (item: Delivery) => Promise<void>;
};

/** What an Executor program answered: its text, and whether it failed. */
export type GateAnswer = { readonly text: string; readonly error: boolean };

export type AutomationDeps = {
  readonly feed: TaskFeed;
  readonly machines: MachineHub;
  readonly chats: ChatList;
  readonly models: Pick<Models, "worker" | "valid" | "choices">;
  readonly runtime: AutomationRuntime;
  /** Run a gate's program on the user's Executor. */
  readonly gate: (code: string, signal: AbortSignal) => Promise<GateAnswer>;
  /** ky's own nightly job, Dreaming (src/dreaming/dreaming.ts): booked here so one Scheduler holds every fire, at its cron in the user's zone. */
  readonly dream: { readonly cron: (zone: string | null) => string; readonly run: () => void };
  /** ky's looks over the day (src/dreaming/looks.ts), booked here too: those to book in a zone, each a local time and its cron, and one to take. */
  readonly looks: { readonly booked: (zone: string | null) => ReadonlyArray<{ readonly time: string; readonly cron: string }>; readonly run: (time: string) => void };
  /** Peers' sweep (src/peers/peers.ts sweepPeers): questions that expire, and answers to send again. */
  readonly peers: () => Promise<void>;
  /** The user deleted the watch for this anticipation: it is dismissed, so no look books it again. */
  readonly unwatched: (anticipation: number) => void;
};

/** A look's booking: its local HH:MM. */
const LookFire = Schema.Struct({ time: Schema.String });

type LookFire = typeof LookFire.Type;

/** A fire: the automation, and the slot run-now picks; a scheduled fire's slot is its due time. */
export type Fire = { id: string; slot?: number };

/** What the Scheduler calls back, by name: an automation's fire, the dream, a look, peers' sweep and the machines' recheck. */
export type Callbacks = {
  automation: (fire: Fire, schedule: Schedule<Fire>) => Promise<void>;
  dream: () => Promise<void>;
  look: (payload: LookFire) => Promise<void>;
  peers: () => Promise<void>;
  machines: () => Promise<void>;
};

/** What a gate came to: something found (and how many items, for a list), nothing (as it returned it), or why it failed. */
export type GateCheck =
  | { readonly kind: "found"; readonly text: string; readonly items?: number }
  | { readonly kind: "nothing"; readonly returned: string }
  | { readonly kind: "error"; readonly text: string };

/**
 * What the Durable Object gives the domain: its deps, the Scheduler that holds every fire, how to tell listeners a
 * row changed, and the gate check a fire runs (the edge's own, so a test may stand in for it).
 */
export class Host extends Context.Service<
  Host,
  AutomationDeps & {
    readonly scheduler: Pick<Scheduler<Callbacks>, "set" | "get" | "list" | "cancel">;
    readonly emit: () => void;
    readonly checkGate: (code: string) => Promise<GateCheck>;
  }
>()("ky/automations/Host") {}

/** A check-in's run, or a watch's: read only, and saying nothing when nothing is new. */
const isCheckIn = (row: AutomationRow) => row.created_by === "dream" || row.watch !== null;

/** Check-ins booked in one day, and waiting at once. */
const CHECK_INS_A_DAY = 2;

const CHECK_INS_WAITING = 6;

/** What a post automation's run is told after its prompt. */
const POSTED = "\n\nYour answer is posted to the user as ky's own message, exactly as written: write only that message, no preamble.";

/** Why a check-in may not post: the main agent checks memory before it tells the user. */
const CHECK_IN_POSTS = "A check-in's report goes to the main agent, not posted.";

/** What a check-in run is told before its prompt. */
const CHECK_IN = `[check-in] You are looking again at something the user asked about, on the day it matters. Search the web for it in general terms: never put the user's name, their family's names or their address in a query. Read only; change nothing anywhere.

If you find nothing new, or nothing they could act on now, answer exactly NOTHING_NEW and nothing else. Otherwise answer with only the new facts, each with its source link, in a few lines.

What to look at:
`;

/** How long a gate may take before its fire counts it failed. */
const GATE_TIMEOUT_MS = 30_000;

/** Gate failures in a row that pause an automation. */
const GATE_ERRORS = 3;

/** The most of a gate's answer put before a run's prompt. */
const GATE_FOUND_MAX = 8_000;

/** A dream booked this soon, or overdue, is firing or about to: booking the dream again leaves it be. */
const DREAM_DUE_MS = 5 * 60_000;

/** What a fire's gate found the last fire's gate found too, as the row's note says it. */
const SAME_NOTE = "same: found what the last fire found, so this one did not run";

/** A cron booking due this soon, or overdue, is about to fire: booking again leaves it be. */
const MINUTE_MS = 60_000;

/** What a fire may run with: what goes before its prompt, and the hash of what its gate found, if it found something. */
type Admission = { readonly prefix: string; readonly found?: string };

/** What a fire without a gate, or one the user ran now, runs with. */
const UNGATED: Admission = { prefix: "" };

/** What a gate last found, as a hash, and the run (task id) it started. */
type Found = { readonly hash: string; readonly task: string };

/** When it runs: a cron in its zone (null for the user's), or a one-off time. */
type Timing = Pick<AutomationRow, "cron" | "zone" | "at">;

/** A draft as saved, with the zone its cron is in. */
type Draft = AutomationDraft & { readonly zone: string | null };

/** One run: its slot, its task id, and the chat it reports to. */
type Run = { slot: number; task: string; chat: string };

/** What `set` may write: what the automation is and does, its status, booking and last gate check. */
type Patch = Partial<Omit<AutomationRow, "id" | "watch" | "created_by" | "created_at" | "updated_at">>;

/** The `ky_check_ins` row: whether the user turned check-ins off, their time zone, and whether they pinned it. */
const StoredCheckIns = Schema.Struct({ off: Schema.Number, zone: Schema.NullOr(Schema.String), zone_pinned: Schema.Number });

/** A `SELECT COUNT(*) AS n` row. */
const CountRow = Schema.Struct({ n: Schema.Number });

/** What an automation's gate last found, as a hash, and the task it started; null for nothing. */
const GateFoundRow = Schema.Struct({ gate_found: Schema.NullOr(Schema.String), gate_found_by: Schema.NullOr(Schema.String) });

/** A `PRAGMA table_info` row: only the column name is read. */
const ColumnInfo = Schema.Struct({ name: Schema.String });

/** What a gate returns when there is nothing to do; undefined, which JSON has no form for, is nothing too. */
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

/** The latest run each automation started in the cloud, so a fire delivered twice starts it once. */
const Runs = defineDoc<{ runs: Record<string, { slot: number; task: string }> }>({
  kind: "ky.automation-runs",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  // Each change is stored as a delta; no full copy is written.
  checkpointWhen: () => false,
  initial: () => ({ runs: {} })
});

/** A session's pi conversation: sessions are conversation ids written out, as agents/harness/pi makes them. */
// SAFETY: every chat is ROOT_SESSION or a session from harness.sessions.create(), both String(conversation id).
const conversationOf = (session: string) => Number(session) as ConversationId;

const sourceOf = (id: string) => `${SOURCE}${id}`;

/** The subagent name of an automation's runs; each run replaces the last, so `subagent send` reaches it. */
const workerOf = (id: string) => `automation-${id}`;

const encoder = new TextEncoder();

/** A gate's found text as the row keeps it: its SHA-256, in hex. */
async function digest(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Run-now's slot is the second it was asked; a cron fire's is its due time; a one-off's is its time, so booking it again after a restart cannot run it twice. */
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

/** A gate check as the row keeps it, in a line. */
function noteOf(check: GateCheck): string {
  if (check.kind === "nothing") return "nothing";

  const text = check.text.replaceAll(/\s+/g, " ");

  return `${check.kind}: ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`;
}

/** `zone` as Intl spells its IANA name; undefined for none, or for an offset like +05:30. */
function ianaZone(zone: string): string | undefined {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;

    return /^[+-]/.test(name) ? undefined : name;
  } catch {
    return undefined;
  }
}

/** A new cron replaces a one-off's time, and a new time replaces the cron. */
function timingOf(patch: Partial<AutomationDraft>): Partial<AutomationDraft> {
  if (patch.cron !== undefined) return { cron: patch.cron, at: null };

  return patch.at === undefined ? {} : { cron: null, at: patch.at };
}

/** What an automation is and does, without its status, booking or anything else a row carries. */
function draftOf({ title, prompt, cron, at, model, machine, chat, gate, post }: AutomationDraft): AutomationDraft {
  return { title, prompt, cron, at, model, machine, chat, gate, post };
}

/** Why an action does not apply to this automation; `next` is what to do first. */
function refusal(id: string, row: AutomationRow | undefined, wanted: string, next?: string) {
  const then = next === undefined ? {} : { next };

  return row ? new WrongStatus({ title: row.title, status: row.status, wanted, ...then }) : new NoAutomation({ id, ...then });
}

const make = Effect.gen(function* () {
  const sql = yield* Sql;
  const host = yield* Host;
  const { machines, chats, models, runtime } = host;
  // Named by its type, so fallow, which reads no types, sees TaskFeed's members used.
  const feed: TaskFeed = host.feed;
  const now = Clock.currentTimeMillis;
  const exec = (query: string, ...bindings: SqlStorageValue[]) => sql.exec(query, ...bindings).pipe(Effect.orDie);
  const rows = (query: string, ...bindings: string[]) => Effect.map(exec(query, ...bindings), automationRows);
  const emit = Effect.sync(() => host.emit());
  /** One Scheduler call; a rejection is a bug, as it was a throw. */
  const scheduled = <A>(call: (scheduler: typeof host.scheduler) => Promise<A>) => Effect.promise(() => call(host.scheduler));
  const cancel = (scheduleId: string) => scheduled((scheduler) => scheduler.cancel(scheduleId));

  /** Add the columns a table was first made without. */
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
    // Crons were UTC before they followed the user's zone; recover moves each it can.
    ["zone", "TEXT DEFAULT 'UTC'"]
  ]);

  const get = (id: string) => Effect.map(rows("SELECT * FROM ky_automations WHERE id = ?", id), (found) => found[0]);

  /**
   * Write `patch`, only while its status is one of `when` if that is given; whether it was written.
   * Read and write happen with no await between, so nothing changes the row in the middle.
   */
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

  /** Whether the dream may book check-ins, and the user's time zone. On until the user turns them off. */
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

  /** The next time a cron names in `zone` after `after`; cron-schedule refuses one it can't read. */
  const nextTime = (cron: string, zone: string | null, after: number) =>
    Effect.try({ try: () => nextLocal(cron, zone, after), catch: (error) => new CannotSchedule({ cron, why: error instanceof Error ? error.message : String(error) }) });

  /** Book its next fire: the next time its cron names in its zone (`zone`, the user's, when it has none), or its one-off time, or now if that has passed. */
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

  /**
   * Book the fire after the one at `due`. Not idempotent: the firing booking is still there, with the same payload,
   * until its callback returns.
   */
  const bookNext = (row: AutomationRow, due: number) =>
    Effect.gen(function* () {
      const at = yield* nextTime(row.cron ?? "", row.zone ?? (yield* checkIns).zone, Math.max(due, yield* now)).pipe(Effect.orDie);

      return (yield* scheduled((scheduler) => scheduler.set(new Date(at), "automation", { id: row.id }))).id;
    });

  const unbook = (row: AutomationRow) => (row.schedule_id === null ? Effect.void : Effect.asVoid(cancel(row.schedule_id)));

  /** Keep a booking made while awaiting only if the automation is still active; else it goes, as a pause or archive cancelled the rest. */
  const keepBooking = (id: string, scheduleId: string | null) =>
    Effect.gen(function* () {
      if ((yield* set(id, { schedule_id: scheduleId }, ["active"])) || scheduleId === null) return;
      yield* cancel(scheduleId);
    });

  /** Stop the automation's live run, if it has one; whether it had. */
  const stopRun = (id: string) =>
    Effect.gen(function* () {
      const run = feed.latestFrom(sourceOf(id));

      if (!run || !isLive(run.status)) return false;

      if (run.kind === "machine") {
        yield* Effect.promise(() => machines.stop(run));

        return true;
      }

      // Marked first: its reporter then sees it is not wanted, so it neither begins nor reports what an abort cut short.
      feed.update(run.id, { status: "stopped", summary: "Stopped" });

      if (run.session !== null) {
        const { session } = run;
        yield* Effect.promise(() => runtime.abort(session));
      }

      return true;
    });

  /**
   * Pause or archive: no more fires, and the run in progress stops. The status is written before
   * anything awaits, with the booking it had then, so a re-book still in flight finds it halted.
   */
  const halt = (row: AutomationRow, status: "paused" | "archived") =>
    Effect.gen(function* () {
      const booked = (yield* get(row.id))?.schedule_id ?? null;

      yield* set(row.id, { status, schedule_id: null });

      if (booked !== null) yield* cancel(booked);
      yield* stopRun(row.id);
    });

  /**
   * A one-off has run: it is done, and the fire's booking ends with this fire.
   * Read again, since a pause or an update may have come while it started.
   */
  const done = (id: string, firing: string) =>
    Effect.gen(function* () {
      const row = yield* get(id);

      if (row?.status !== "active") return;

      if (row.schedule_id !== null && row.schedule_id !== firing) yield* cancel(row.schedule_id);
      yield* set(id, { status: "done", schedule_id: null }, ["active"]);
    });

  /** Why it can't run on `machine`: one ky doesn't know, or a post, whose report is posted from the cloud. */
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

  /** The draft as it can be saved, or why not. */
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

  /** Whether another check-in would pass the day's or the waiting cap. */
  const checkInCapProblem = Effect.gen(function* () {
    if ((yield* count("SELECT COUNT(*) AS n FROM ky_automations WHERE created_by = 'dream' AND created_at > ?", (yield* now) - 86_400_000)) >= CHECK_INS_A_DAY) {
      return `${CHECK_INS_A_DAY} check-ins were booked in the last day; that is the limit.`;
    }

    if ((yield* count("SELECT COUNT(*) AS n FROM ky_automations WHERE created_by = 'dream' AND status = 'active'")) >= CHECK_INS_WAITING) {
      return `${CHECK_INS_WAITING} check-ins are already waiting; that is the limit.`;
    }

    return undefined;
  });

  /** A check-in is a one-off in the cloud that reports to the main chat, within the day's and the waiting caps. */
  const checkInProblem = (draft: AutomationDraft) =>
    Effect.gen(function* () {
      if (!(yield* checkIns).on) return "The user turned check-ins off.";

      if (draft.cron !== null || draft.at === null) return "A check-in runs once: give at, not cron.";

      // A time already gone would run it now, in the night.
      if (draft.at <= (yield* now)) return "A check-in's time must be ahead.";

      if (draft.machine !== null || draft.chat !== ROOT_SESSION) return "A check-in runs in the cloud and reports to the main chat.";

      if (draft.gate !== null) return "A check-in has no gate.";

      if (draft.post) return CHECK_IN_POSTS;

      return yield* checkInCapProblem;
    });

  /** Whether a cron's booking is not at its next time in `zone`: a cron the Scheduler repeats, from before, or a time a zone change moved. */
  const stale = (row: AutomationRow, booked: Schedule<unknown>, zone: string | null, at: number) =>
    Effect.gen(function* () {
      if (booked.type === "cron") return true;
      const due = booked.time * 1000;

      return due > at + MINUTE_MS && due !== (yield* nextTime(row.cron ?? "", row.zone ?? zone, at).pipe(Effect.orDie));
    });

  /**
   * Book each active automation whose booking is missing or no longer its next time in `zone` (the user's zone
   * changed, or a booking from when crons were UTC), first moving UTC crons to `zone` where cron can say them.
   * A booking due within the minute is left to fire, so this never skips the fire that woke the object.
   */
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

  /**
   * Book the nightly dream in `zone`, dropping one booked at another cron, so ky never dreams twice a night.
   * A start the dream's own fire woke (or one just before it) leaves the booking alone, so a daylight-saving
   * change never cancels tonight's dream as it fires; the next start books it again.
   */
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

  /** Book a look at each time wanted in `zone`, and drop those booked at another time or cron; none while Proactivity is off. */
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

  /**
   * Book the dream and the looks in the zone kept, again if another write changed it meanwhile. The zone is kept
   * first: a booking that fails is booked again when the object next starts (recover).
   */
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

  /**
   * The chat a run reports to: an archived side chat is brought back so the
   * report is seen, and a deleted one gives way to the main chat.
   */
  const reportTo = (chat: string): string => {
    if (chat === ROOT_SESSION) return chat;
    const row = chats.list().find((each) => each.session === chat);

    if (!row) return ROOT_SESSION;

    if (row.archived_at !== null) chats.archive(chat, false);

    return chat;
  };

  const decodeFound = Schema.decodeUnknownOption(GateFoundRow);

  /** The hash of what the automation's gate last found and the run it started; undefined when its last check found nothing. */
  const lastFound = (id: string) =>
    Effect.map(exec("SELECT gate_found, gate_found_by FROM ky_automations WHERE id = ?", id), ([stored]): Found | undefined => {
      const row = Option.getOrUndefined(decodeFound(stored));

      return row?.gate_found && row.gate_found_by ? { hash: row.gate_found, task: row.gate_found_by } : undefined;
    });

  /** Keep `found` as what the gate last found, or null for nothing. */
  const keepFound = (id: string, found: Found | null) => exec("UPDATE ky_automations SET gate_found = ?, gate_found_by = ? WHERE id = ?", found?.hash ?? null, found?.task ?? null, id);

  /** Run a gate's program once, as a fire does, and say what it came to. A tool's create and update test it this way. */
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

      // A gate runs unattended, so nobody is there to approve or answer.
      if (outcome.kind === "paused") return { kind: "error", text: "it asked for an approval or input; a gate may only read" } satisfies GateCheck;

      if (outcome.kind === "failed") return { kind: "error", text: outcome.text } satisfies GateCheck;

      const { value } = outcome;

      if (value === undefined || isNothing(value)) return { kind: "nothing", returned: JSON.stringify(value) ?? "undefined" } satisfies GateCheck;
      // What it found, for the prompt: a string as it is, anything else as JSON.
      const text = isText(value) ? value.trim() : JSON.stringify(value);

      return (isList(value) ? { kind: "found", text, items: value.length } : { kind: "found", text }) satisfies GateCheck;
    });

  /** The gate failed GATE_ERRORS fires in a row: pause the automation and tell its chat. */
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

  /**
   * The gate found `text`: run with it, unless an earlier slot's fire found the same and the user did not ask to
   * run now. The same slot delivered again (the Scheduler may) is no repeat: its run starts once by its task id,
   * and neither is a finding whose run failed, which nobody was told about.
   */
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

  /**
   * Check the fire's gate: what to put before the prompt ("" without a gate),
   * or null to skip the slot: it found nothing, or what the last fire found
   * (a repeat, no model run). The check is noted on the row, and the
   * GATE_ERRORS-th failure in a row pauses the automation and tells its chat.
   */
  const admit = (row: AutomationRow, task: string, forced: boolean) =>
    Effect.gen(function* () {
      if (row.gate === null) return UNGATED;
      const { gate } = row;
      const check = yield* Effect.promise(() => host.checkGate(gate));

      if (check.kind === "found") return yield* admitFound(row.id, task, check.text, forced);
      const errors = check.kind === "error" ? row.gate_errors + 1 : 0;
      yield* set(row.id, { gate_checked_at: yield* now, gate_note: noteOf(check), gate_errors: errors });

      // Found, then nothing, then the same again is new: the last fire found nothing.
      if (check.kind === "nothing") yield* keepFound(row.id, null);

      if (forced) return UNGATED;

      if (check.kind === "error" && errors >= GATE_ERRORS) yield* gatePaused(row, task, errors, check.text);

      return null;
    });

  const runInCloud = (row: AutomationRow, { slot, task, chat }: Run) =>
    Effect.gen(function* () {
      // Before the commit, so an eviction between the two cannot lose the row.
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
            // A retry of this fire tries again; until then the row says why it has not started.
            feed.update(task, { status: "failed", summary: `Could not start: ${error instanceof Error ? error.message : String(error)}` });

            // A one-off has no later fire: it waits paused for the user to resume it. Its booking is
            // this fire's, which the Scheduler retries and then drops; a retry finds it paused.
            if (row.at !== null && (yield* get(row.id))?.status === "active") yield* set(row.id, { status: "paused", schedule_id: null });

            return yield* Effect.die(error);
          })
        )
      );

      yield* Effect.promise(() => runtime.wake());
    });

  /** A machine the user has paused or turned off takes no new tasks, so the slot's run fails and says why. */
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

    return row.machine === null ? runInCloud(row, { slot, task, chat }) : Effect.sync(() => runOnMachine(row, row.machine ?? "", { task, chat }));
  };

  /** The slot's run has started. A queued one may not have yet, and a failed one did not. */
  const ran = (task: string): boolean => {
    const own = feed.get(task);

    return own !== undefined && own.status !== "queued" && own.status !== "failed";
  };

  /** Another run of the automation is still going. */
  const overlaps = (id: string, task: string): boolean => {
    const last = feed.latestFrom(sourceOf(id));

    return last !== undefined && last.id !== task && isLive(last.status);
  };

  /**
   * A fire: start the slot's run unless it is not wanted, already started,
   * the last run is still going, or its gate found nothing. It only checks
   * the gate (at most GATE_TIMEOUT_MS) and starts the run, so it never holds
   * up the alarm for long.
   */
  const fire = (fired: Fire, schedule: Schedule<Fire>) =>
    Effect.gen(function* () {
      const row = yield* get(fired.id);

      if (row?.status !== "active") return;

      // Each cron fire books the next before anything can skip this one; a delivery again finds it booked.
      if (row.cron !== null && fired.slot === undefined && schedule.type !== "cron" && row.schedule_id === schedule.id) {
        yield* keepBooking(row.id, yield* bookNext(row, schedule.time * 1000));
      }

      const slot = slotOf(fired, schedule, row);
      const task = `a-${row.id}-${slot}`;

      if (overlaps(row.id, task)) return;

      // Delivered again after its run started, it starts nothing; a one-off still ends done.
      if (!ran(task)) {
        // Run now is the user asking: it runs whatever the gate says.
        const admitted = yield* admit(row, task, fired.slot !== undefined);

        if (admitted === null) {
          if (row.at !== null) yield* done(row.id, schedule.id);

          return;
        }

        yield* start({ ...row, prompt: `${admitted.prefix}${row.prompt}` }, slot, task);

        // Only once its run started: a fire that failed to start is tried again, and must not be skipped as a repeat.
        if (admitted.found !== undefined) yield* keepFound(row.id, { hash: admitted.found, task });
      }

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

  /** Gone for good as delete has it, but by ky: a look's watch (src/dreaming/looks.ts), its anticipation left as it is. */
  const retire = (id: string) =>
    Effect.gen(function* () {
      const row = yield* get(id);

      if (!row) return;
      yield* halt(row, "archived");
      yield* exec("DELETE FROM ky_automations WHERE id = ?", id);
      yield* emit;
    });

  /** Book an active automation's new time and save the draft; or, when the time can't be booked, keep the old one. */
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

    /** Newest first; without `all`, only the active and paused ones. */
    list: (all: boolean) =>
      Effect.flatMap(
        rows(all ? "SELECT * FROM ky_automations ORDER BY created_at DESC" : "SELECT * FROM ky_automations WHERE status IN ('active', 'paused') ORDER BY created_at DESC"),
        (found) => Effect.forEach(found, view)
      ),

    /** The looks' watches (src/dreaming/looks.ts): each automation booked for a watch anticipation, its id and status. */
    watches: Effect.map(rows("SELECT * FROM ky_automations WHERE watch IS NOT NULL"), (found) =>
      found.flatMap(({ id, watch, status }) => (watch === null ? [] : [{ id, watch, status }]))
    ),

    checkIns,

    /** Turn check-ins on or off; off pauses the ones waiting. */
    setCheckIns: (on: boolean) =>
      Effect.gen(function* () {
        yield* exec("INSERT INTO ky_check_ins (id, off, zone) VALUES (1, ?, NULL) ON CONFLICT (id) DO UPDATE SET off = excluded.off", on ? 0 : 1);

        if (!on) {
          for (const row of yield* rows("SELECT * FROM ky_automations WHERE created_by = 'dream' AND status = 'active'")) yield* halt(row, "paused");
        }

        yield* emit;
      }),

    /**
     * The user's time zone, from where their browser connects, unless they pinned one; check-ins are booked for their
     * morning, and the dream for their night.
     */
    setZone: (zone: string) =>
      Effect.gen(function* () {
        const kept = yield* checkIns;

        if (kept.pinned || zone === kept.zone) return;
        // A pin that lands first keeps its zone.
        yield* exec(
          "INSERT INTO ky_check_ins (id, off, zone) VALUES (1, 0, ?) ON CONFLICT (id) DO UPDATE SET zone = excluded.zone WHERE ky_check_ins.zone_pinned = 0",
          zone
        );
        yield* bookZone;
      }),

    /** Pin the user's time zone, an IANA name, which later connects leave alone. */
    pinZone: (zone: string) =>
      Effect.gen(function* () {
        const name = ianaZone(zone);

        if (name === undefined) return yield* new NotAZone({ zone });
        yield* keepZone(name, true);
        yield* bookZone;
      }),

    /** Follow where the user's browser connects again, from `detected`, the asking connection's zone, when it has one. */
    unpinZone: (detected: string | null) =>
      Effect.gen(function* () {
        if (detected === null) {
          yield* exec("UPDATE ky_check_ins SET zone_pinned = 0 WHERE id = 1");

          return;
        }

        yield* keepZone(detected, false);
        yield* bookZone;
      }),

    /** Whether the pi session is a check-in's or a watch's run at work. */
    checkInRun: (session: string) =>
      Effect.gen(function* () {
        const task = feed.working(session);

        if (!task?.source.startsWith(SOURCE)) return false;

        const row = yield* get(task.source.slice(SOURCE.length));

        return row !== undefined && isCheckIn(row);
      }),

    /** A new active automation, booked; or why it was refused. `watch` is the watch anticipation a look books it for. */
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

    /**
     * Change what it is or does; a new time re-books an active one. The changed automation, or why not.
     * Only what it is and does is written: a pause or archive that lands while it re-books wins.
     */
    update: (id: string, patch: Partial<AutomationDraft>) =>
      Effect.gen(function* () {
        const row = yield* get(id);

        if (!row) return yield* new NoAutomation({ id });

        if (patch.post && isCheckIn(row)) return yield* new NotSaved({ problem: CHECK_IN_POSTS });
        const retimed = patch.cron !== undefined || patch.at !== undefined;
        const checked = yield* check(draftOf({ ...row, ...patch, ...timingOf(patch) }));
        // A cron given now is in the user's zone, as the tool and the form both say.
        const timed = { ...checked, zone: patch.cron === undefined ? (row.zone ?? null) : null };

        if (row.status === "active" && retimed) yield* rebook(row, timed);
        else yield* set(id, timed);

        // A new gate starts with no checks, no failures, and nothing found before.
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

    /** Stop the run in progress and leave the automation on its schedule. */
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

    /** Book it again from now; a one-off whose time has passed runs at once. */
    resume: (id: string) =>
      Effect.gen(function* () {
        const row = yield* get(id);

        if (row?.status !== "paused" && row?.status !== "done") return yield* refusal(id, row, "paused or done");

        // Its slot is its time, which has run.
        if (row.status === "done" && row.at !== null && row.at <= (yield* now)) return yield* new AlreadyRan({ title: row.title, at: row.at });

        const booked = yield* book(row.id, row).pipe(Effect.orDie);

        // Archived or deleted while it was booked: that wins, and the booking goes.
        if (!(yield* set(id, { status: "active", schedule_id: booked }, ["paused", "done"]))) {
          yield* cancel(booked);

          return yield* refusal(id, yield* get(id), "paused or done");
        }

        return `Resumed "${row.title}".`;
      }),

    /**
     * Gone for good: no more fires, the run in progress stops, and the row is removed. Its past runs stay in Activity.
     * A watch the user deletes dismisses its anticipation, so no look books it again.
     */
    delete: (id: string) =>
      Effect.gen(function* () {
        const row = yield* get(id);

        if (!row) return yield* new NoAutomation({ id });
        yield* retire(id);

        if (row.watch !== null) host.unwatched(row.watch);

        return `Deleted "${row.title}".`;
      }),

    retire,

    /** Back to paused, so resuming it is a separate choice. */
    unarchive: (id: string) =>
      Effect.gen(function* () {
        const row = yield* get(id);

        if (row?.status !== "archived") return yield* refusal(id, row, "archived");
        yield* set(id, { status: "paused" });

        return `Unarchived "${row.title}"; it is paused.`;
      }),

    /** Fire it now, through the Scheduler like any fire, as its own slot. */
    run: (id: string) =>
      Effect.gen(function* () {
        const row = yield* get(id);

        if (row?.status !== "active") return yield* refusal(id, row, "active", "Resume it first.");
        const at = yield* now;
        yield* scheduled((scheduler) => scheduler.set(new Date(at), "automation", { id, slot: Math.floor(at / 1000) }));

        return `Running "${row.title}" now; its result is reported when it ends.`;
      }),

    /** Whether a task's report should still reach the chat: not for a paused or archived automation. */
    wanted: (feedId: string) =>
      Effect.gen(function* () {
        const task = feed.get(feedId);
        const source = task?.source ?? "";

        if (!source.startsWith(SOURCE)) return true;

        // Stopped by the user: it neither starts nor reports, though the automation runs on.
        if (task?.status === "stopped") return false;
        const status = (yield* get(source.slice(SOURCE.length)))?.status;

        return status === "active" || status === "done";
      }),

    /** Book a callback that takes no payload at `at`, epoch ms: the machines' recheck (MachineHub.recheck), or peers' sweep. */
    bookAt: (callback: "machines" | "peers", at: number) => Effect.asVoid(scheduled((scheduler) => scheduler.set(new Date(at), callback))),

    /** One dream at `at`, epoch ms, besides the nightly one: the dream's own, when the user was here. It replaces any such look already booked, so they never pile up. */
    dreamAt: (at: number) =>
      Effect.gen(function* () {
        for (const old of yield* scheduled((scheduler) => scheduler.list())) {
          if (old.callback === "dream" && old.type !== "cron") yield* cancel(old.id);
        }

        yield* scheduled((scheduler) => scheduler.set(new Date(at), "dream"));
      }),

    /** On start: book the nightly dream, the looks, and any active automation whose booking is missing. */
    recover: Effect.gen(function* () {
      yield* bookDream((yield* checkIns).zone);
      yield* bookLooks((yield* checkIns).zone);

      yield* bookAutomations((yield* checkIns).zone);
    }),

    /** Book the looks again: the user changed their times or turned Proactivity on or off. */
    bookLooks: Effect.flatMap(checkIns, ({ zone }) => bookLooks(zone)),

    checkGate,

    fire,

    /** How the tool names a chat: main, or a side chat's title and session. */
    chatLabel: (session: string) => {
      if (session === ROOT_SESSION) return "main";
      const title = chats.list().find((each) => each.session === session)?.title;

      return `${title || "untitled"} (${session})`;
    }
  };
});

/** The automations domain: its tables, made when the Layer is built, and every action on them. */
export class Automator extends Context.Service<Automator, Effect.Success<typeof make>>()("ky/automations/Automator") {
  static readonly layer = Layer.effect(Automator)(make);
}

