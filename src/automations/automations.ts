import {
  defineDoc,
  defineExtension,
  defineTool,
  type Extension,
  type ConversationId,
  hook,
  ROOT_CONVERSATION_ID,
  ToolTask,
  type Tx
} from "@earendil-works/pi-durable";
import { ROOT_SESSION } from "agents/harness/pi";
import { type Schedule, Scheduler } from "agents/schedules";
import Type, { type Static } from "typebox";
import { Value } from "typebox/value";
import type { ChatList } from "../chats";
import { decodeOr } from "../core/decode";
import { must } from "../core/must";
import { isRefusal, type Refusal, refused, type Result } from "../core/refusal";
import type { MachineHub } from "../machines/contract";
import { type Models, parseModel } from "../models";
import type { ModelChoice } from "../settings";
import type { Spawn } from "../skills/contract";
import {
  AUTOMATION_SOURCE as SOURCE,
  AUTOMATION_TABLES,
  AUTOMATION_TOOL,
  automationRows,
  type AutomationAuthor,
  type AutomationDraft,
  type AutomationRow,
  type AutomationStatus,
  AutomationToolInput,
  type AutomationToolArgs,
  type AutomationView,
  type ByIdAction,
  CHECK_IN_TOOLS,
  ColumnInfo,
  type CheckIns,
  CountRow,
  draftProblem,
  type Delivery,
  EXTENSIONS,
  type LastRun,
  GateFoundRow,
  StoredCheckIns,
  type TaskFeed,
  type TaskRow,
  type ToolAction
} from "./contract";
import { programOutcome } from "../executor-status";
import { isLive } from "./tasks";

/**
 * Automations: jobs that run on a schedule, set up from chat for the user or
 * by ky for itself ("every weekday at 9 UTC, check X and tell me"). Each
 * automation is a row here, booked on the Agents SDK Scheduler as a UTC cron
 * or a one-off time. Each fire starts one run: a fresh cloud subagent, or a
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

/** A check-in's run, or a watch's: read only, and saying nothing when nothing is new. */
const isCheckIn = (row: AutomationRow) => row.created_by === "dream" || row.watch !== null;

/** A look's booking: its local HH:MM. */
const LookFire = Type.Object({ time: Type.String() });

type LookFire = Static<typeof LookFire>;

/** Check-ins booked in one day, and waiting at once. */
const CHECK_INS_A_DAY = 2;

const CHECK_INS_WAITING = 6;

const CHECK_IN_ALLOWED: ReadonlySet<string> = new Set(CHECK_IN_TOOLS);

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

/** The most of a gate's answer a create or update's gate test shows. */
const GATE_PREVIEW_MAX = 500;

/** A dream booked this soon, or overdue, is firing or about to: booking the dream again leaves it be. */
const DREAM_DUE_MS = 5 * 60_000;

/** What a fire's gate found the last fire's gate found too, as the row's note says it. */
const SAME_NOTE = "same: found what the last fire found, so this one did not run";

/** What a fire may run with: what goes before its prompt, and the hash of what its gate found, if it found something. */
type Admission = { readonly prefix: string; readonly found?: string };

/** What a gate last found, as a hash, and the run (task id) it started. */
type Found = { readonly hash: string; readonly task: string };

const encoder = new TextEncoder();

/** A gate's found text as the row keeps it: its SHA-256, in hex. */
async function digest(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** What a gate came to: something found (and how many items, for a list), nothing (as it returned it), or why it failed. */
type GateCheck =
  | { readonly kind: "found"; readonly text: string; readonly items?: number }
  | { readonly kind: "nothing"; readonly returned: string }
  | { readonly kind: "error"; readonly text: string };

/** A fire: the automation, and the slot run-now picks; a scheduled fire's slot is its due time. */
type Fire = { id: string; slot?: number };

/** One run: its slot, its task id, and the chat it reports to. */
type Run = { slot: number; task: string; chat: string };

/** The latest run each automation started in the cloud, so a fire delivered twice starts it once. */
const Runs = defineDoc<{ runs: Record<string, { slot: number; task: string }> }>({
  kind: "ky.automation-runs",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ runs: {} })
});

/** A session's pi conversation: sessions are conversation ids written out, as agents/harness/pi makes them. */
// SAFETY: every chat is ROOT_SESSION or a session from harness.sessions.create(), both String(conversation id).
const conversationOf = (session: string) => Number(session) as ConversationId;

const sourceOf = (id: string) => `${SOURCE}${id}`;

/** The subagent name of an automation's runs; each run replaces the last, so `subagent send` reaches it. */
const workerOf = (id: string) => `automation-${id}`;

/** Run-now's slot is the second it was asked; a cron fire's is its due time; a one-off's is its time, so booking it again after a restart cannot run it twice. */
function slotOf(fire: Fire, schedule: Schedule<Fire>, row: AutomationRow): number {
  if (fire.slot !== undefined) return fire.slot;

  return row.at === null ? schedule.time : Math.floor(row.at / 1000);
}

function lastOf(task: TaskRow | undefined): LastRun | null {
  return task ? { id: task.id, status: task.status, summary: task.summary, finished_at: task.finished_at } : null;
}

export class Automations {
  readonly #sql: SqlStorage;
  readonly #deps: AutomationDeps;
  readonly #listeners = new Set<() => void>();
  /** Install with `Lifecycle.use()`; its alarm fires the automations. */
  readonly scheduler = new Scheduler<{
    automation: (fire: Fire, schedule: Schedule<Fire>) => Promise<void>;
    dream: () => Promise<void>;
    look: (payload: LookFire) => Promise<void>;
    peers: () => Promise<void>;
    machines: () => Promise<void>;
  }>({
    callbacks: {
      automation: (fire, schedule) => this.#fire(fire, schedule),
      // It only starts the dream, so it never holds up the alarm.
      dream: async () => this.#deps.dream.run(),
      look: async ({ time }) => this.#deps.looks.run(time),
      peers: () => this.#deps.peers(),
      // A runner silent past ONLINE_WITHIN_MS shows offline though its socket looks open.
      machines: async () => this.#deps.machines.recheck()
    }
  });

  constructor(sql: SqlStorage, deps: AutomationDeps) {
    this.#sql = sql;
    this.#deps = deps;
    sql.exec("CREATE TABLE IF NOT EXISTS ky_check_ins (id INTEGER PRIMARY KEY CHECK (id = 1), off INTEGER NOT NULL, zone TEXT)");
    addColumns(sql, AUTOMATION_TABLES.checkIns, [["zone_pinned", "INTEGER NOT NULL DEFAULT 0"]]);
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_automations (
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
    addColumns(sql, AUTOMATION_TABLES.automations, [
      ["gate", "TEXT"],
      ["gate_checked_at", "INTEGER"],
      ["gate_note", "TEXT"],
      ["gate_errors", "INTEGER NOT NULL DEFAULT 0"],
      ["gate_found", "TEXT"],
      ["gate_found_by", "TEXT"],
      ["watch", "INTEGER"],
      ["post", "INTEGER NOT NULL DEFAULT 0"]
    ]);
    // A run's progress changes an automation's last run; the feed does not say which task changed.
    deps.feed.onChange((tasks) => {
      if (tasks.some((task) => task.source.startsWith(SOURCE))) this.#emit();
    });
  }

  /** Called when an automation or its last run changes. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  get(id: string): AutomationRow | undefined {
    return this.#rows("SELECT * FROM ky_automations WHERE id = ?", id)[0];
  }

  /** Newest first; without `all`, only the active and paused ones. */
  async list(all = true): Promise<AutomationView[]> {
    const rows = this.#rows(
      all
        ? "SELECT * FROM ky_automations ORDER BY created_at DESC"
        : "SELECT * FROM ky_automations WHERE status IN ('active', 'paused') ORDER BY created_at DESC"
    );

    return Promise.all(rows.map((row) => this.#view(row)));
  }

  /** The looks' watches (src/dreaming/looks.ts): each automation booked for a watch anticipation, its id and status. */
  watches(): Array<{ readonly id: string; readonly watch: number; readonly status: AutomationStatus }> {
    return this.#rows("SELECT * FROM ky_automations WHERE watch IS NOT NULL").flatMap(({ id, watch, status }) => (watch === null ? [] : [{ id, watch, status }]));
  }

  /** Whether the dream may book check-ins, and the user's time zone. On until the user turns them off. */
  checkIns(): CheckIns {
    const row = decodeOr(StoredCheckIns, this.#sql.exec("SELECT off, zone, zone_pinned FROM ky_check_ins WHERE id = 1").toArray()[0], undefined);

    return { on: row?.off !== 1, zone: row?.zone ?? null, pinned: row?.zone_pinned === 1 };
  }

  /** Turn check-ins on or off; off pauses the ones waiting. */
  async setCheckIns(on: boolean): Promise<void> {
    this.#sql.exec(
      "INSERT INTO ky_check_ins (id, off, zone) VALUES (1, ?, NULL) ON CONFLICT (id) DO UPDATE SET off = excluded.off",
      on ? 0 : 1
    );

    if (!on) {
      for (const row of this.#rows("SELECT * FROM ky_automations WHERE created_by = 'dream' AND status = 'active'")) {
        await this.#halt(row, "paused");
      }
    }

    this.#emit();
  }

  /**
   * The user's time zone, from where their browser connects, unless they pinned one; check-ins are booked for their
   * morning, and the dream for their night.
   */
  async setZone(zone: string): Promise<void> {
    const now = this.checkIns();

    if (now.pinned || zone === now.zone) return;
    // A pin that lands first keeps its zone.
    this.#sql.exec(
      "INSERT INTO ky_check_ins (id, off, zone) VALUES (1, 0, ?) ON CONFLICT (id) DO UPDATE SET zone = excluded.zone WHERE ky_check_ins.zone_pinned = 0",
      zone
    );
    await this.#bookZone();
  }

  /** Pin the user's time zone, an IANA name, which later connects leave alone. */
  async pinZone(zone: string): Promise<void> {
    const name = ianaZone(zone);

    if (name === undefined) throw new Error(`${zone} isn't a time zone, like Europe/Berlin.`);
    this.#keepZone(name, true);
    await this.#bookZone();
  }

  /** Follow where the user's browser connects again, from `detected`, the asking connection's zone, when it has one. */
  async unpinZone(detected: string | null): Promise<void> {
    if (detected === null) {
      this.#sql.exec("UPDATE ky_check_ins SET zone_pinned = 0 WHERE id = 1");

      return;
    }

    this.#keepZone(detected, false);
    await this.#bookZone();
  }

  #keepZone(zone: string, pinned: boolean): void {
    this.#sql.exec(
      "INSERT INTO ky_check_ins (id, off, zone, zone_pinned) VALUES (1, 0, ?, ?) ON CONFLICT (id) DO UPDATE SET zone = excluded.zone, zone_pinned = excluded.zone_pinned",
      zone,
      pinned ? 1 : 0
    );
  }

  /**
   * Book the dream and the looks in the zone kept, again if another write changed it meanwhile. The zone is kept
   * first: a booking that fails is booked again when the object next starts (recover).
   */
  async #bookZone(): Promise<void> {
    let zone = this.checkIns().zone;

    for (;;) {
      await this.#bookDream(zone);
      await this.#bookLooks(zone);
      const now = this.checkIns().zone;

      if (now === zone) return;
      zone = now;
    }
  }

  /** Whether the pi session is a check-in's or a watch's run at work. */
  checkInRun(session: string): boolean {
    const task = this.#deps.feed.working(session);

    if (!task?.source.startsWith(SOURCE)) return false;

    const row = this.get(task.source.slice(SOURCE.length));

    return row !== undefined && isCheckIn(row);
  }

  /** A new active automation, booked; or why it was refused. `watch` is the watch anticipation a look books it for. */
  async create(draft: AutomationDraft, author: AutomationAuthor, watch: number | null = null): Promise<Result<AutomationRow>> {
    const problem = author === "dream" ? this.#checkInProblem(draft) : undefined;

    if (problem !== undefined) return refused(problem);
    const checked = this.#check(draft);

    if (isRefusal(checked)) return checked;
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
    const booked = await this.#tryBook(id, checked);

    if (booked.error !== undefined) return refused(booked.error);
    const now = Date.now();
    this.#sql.exec(
      `INSERT INTO ky_automations
        (id, title, prompt, cron, at, model, machine, chat, gate, watch, post, created_by, status, schedule_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
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
      booked.id,
      now,
      now
    );
    this.#emit();

    return must(this.get(id), `Automation ${id} wasn't saved.`);
  }

  /**
   * Change what it is or does; a new time re-books an active one. The changed automation, or why not.
   * Only what it is and does is written: a pause or archive that lands while it re-books wins.
   */
  async update(id: string, patch: Partial<AutomationDraft>): Promise<Result<AutomationRow>> {
    const row = this.get(id);

    if (!row) return refused(`No automation ${id}.`);

    if (patch.post && isCheckIn(row)) return refused(CHECK_IN_POSTS);
    const retimed = patch.cron !== undefined || patch.at !== undefined;
    const checked = this.#check(draftOf({ ...row, ...patch, ...timingOf(patch) }));

    if (isRefusal(checked)) return checked;
    const why = row.status === "active" && retimed ? await this.#rebook(row, checked) : this.#save(id, checked);

    if (why) return why;

    // A new gate starts with no checks, no failures, and nothing found before.
    if (checked.gate !== row.gate) {
      this.#set(id, { gate_checked_at: null, gate_note: null, gate_errors: 0 });
      this.#found(id, null);
    }

    return this.get(id) ?? refused(`No automation ${id}.`);
  }

  /** Book an active automation's new time and save the draft; or, when the time can't be booked, keep the old one. */
  async #rebook(row: AutomationRow, draft: AutomationDraft): Promise<Refusal | undefined> {
    await this.#unbook(row);

    const booked = await this.#tryBook(row.id, draft);

    if (booked.id === undefined) {
      await this.#keepBooking(row.id, (await this.#tryBook(row.id, row)).id ?? null);

      return refused(booked.error ?? `Cannot schedule "${draft.cron}".`);
    }

    this.#set(row.id, draft);
    await this.#keepBooking(row.id, booked.id);

    return undefined;
  }

  /** Save what it is and does, leaving its status and booking as they are. */
  #save(id: string, draft: AutomationDraft): undefined {
    this.#set(id, draft);

    return undefined;
  }

  async pause(id: string): Promise<string> {
    const row = this.get(id);

    if (row?.status !== "active") return refusal(id, row, "active");
    await this.#halt(row, "paused");

    return `Paused "${row.title}".`;
  }

  async archive(id: string): Promise<string> {
    const row = this.get(id);

    if (!row || row.status === "archived") return refusal(id, row, "not archived");
    await this.#halt(row, "archived");

    return `Archived "${row.title}".`;
  }

  /** Book it again from now; a one-off whose time has passed runs at once. */
  async resume(id: string): Promise<string> {
    const row = this.get(id);

    if (row?.status !== "paused" && row?.status !== "done") return refusal(id, row, "paused or done");

    // Its slot is its time, which has run.
    if (row.status === "done" && row.at !== null && row.at <= Date.now()) {
      return `"${row.title}" ran at ${new Date(row.at).toISOString()}. Update \`at\` to run it again.`;
    }

    const booked = await this.#book(row.id, row);

    // Archived or deleted while it was booked: that wins, and the booking goes.
    if (!this.#set(id, { status: "active", schedule_id: booked }, ["paused", "done"])) {
      await this.scheduler.cancel(booked);

      return refusal(id, this.get(id), "paused or done");
    }

    return `Resumed "${row.title}".`;
  }

  /**
   * Gone for good: no more fires, the run in progress stops, and the row is removed. Its past runs stay in Activity.
   * A watch the user deletes dismisses its anticipation, so no look books it again.
   */
  async delete(id: string): Promise<string> {
    const row = this.get(id);

    if (!row) return `No automation ${id}.`;
    await this.retire(id);

    if (row.watch !== null) this.#deps.unwatched(row.watch);

    return `Deleted "${row.title}".`;
  }

  /** Gone for good as delete has it, but by ky: a look's watch (src/dreaming/looks.ts), its anticipation left as it is. */
  async retire(id: string): Promise<void> {
    const row = this.get(id);

    if (!row) return;
    await this.#halt(row, "archived");
    this.#sql.exec("DELETE FROM ky_automations WHERE id = ?", id);
    this.#emit();
  }

  /** Back to paused, so resuming it is a separate choice. */
  unarchive(id: string): string {
    const row = this.get(id);

    if (row?.status !== "archived") return refusal(id, row, "archived");
    this.#set(id, { status: "paused" });

    return `Unarchived "${row.title}"; it is paused.`;
  }

  /** Fire it now, through the Scheduler like any fire, as its own slot. */
  async run(id: string): Promise<string> {
    const row = this.get(id);

    if (row?.status !== "active") return `${refusal(id, row, "active")} Resume it first.`;
    const now = new Date();
    await this.scheduler.set(now, "automation", { id, slot: Math.floor(now.getTime() / 1000) });

    return `Running "${row.title}" now; its result is reported when it ends.`;
  }

  /** Whether a task's report should still reach the chat: not for a paused or archived automation. */
  wanted(feedId: string): boolean {
    const source = this.#deps.feed.get(feedId)?.source ?? "";

    if (!source.startsWith(SOURCE)) return true;
    const status = this.get(source.slice(SOURCE.length))?.status;

    return status === "active" || status === "done";
  }

  /** Book a look at the machines at `at`, epoch ms (MachineHub.recheck). */
  async recheckMachinesAt(at: number): Promise<void> {
    await this.scheduler.set(new Date(at), "machines");
  }

  /** Book peers' sweep at `at`, epoch ms. */
  async sweepPeersAt(at: number): Promise<void> {
    await this.scheduler.set(new Date(at), "peers");
  }

  /** One dream at `at`, epoch ms, besides the nightly one: the dream's own, when the user was here. It replaces any such look already booked, so they never pile up. */
  async dreamAt(at: number): Promise<void> {
    for (const old of await this.scheduler.list()) {
      if (old.callback === "dream" && old.type !== "cron") await this.scheduler.cancel(old.id);
    }

    await this.scheduler.set(new Date(at), "dream");
  }

  /** On start: book the nightly dream, the looks, and any active automation whose booking is missing. */
  async recover(): Promise<void> {
    await this.#bookDream(this.checkIns().zone);
    await this.bookLooks();

    for (const row of this.#rows("SELECT * FROM ky_automations WHERE status = 'active'")) {
      if (row.schedule_id !== null && (await this.scheduler.get(row.schedule_id))) continue;
      await this.#keepBooking(row.id, await this.#book(row.id, row));
    }
  }

  /**
   * Book the nightly dream in `zone`, dropping one booked at another cron, so ky never dreams twice a night.
   * A start the dream's own fire woke (or one just before it) leaves the booking alone, so a daylight-saving
   * change never cancels tonight's dream as it fires; the next start books it again.
   */
  async #bookDream(zone: string | null): Promise<void> {
    const cron = this.#deps.dream.cron(zone);
    const stale = (await this.scheduler.list()).filter((old) => old.callback === "dream" && old.type === "cron" && old.cron !== cron);

    if (stale.some((old) => old.time * 1000 < Date.now() + DREAM_DUE_MS)) return;

    for (const old of stale) await this.scheduler.cancel(old.id);

    await this.scheduler.set(cron, "dream", undefined, { idempotent: true });
  }

  /** Book the looks again: the user changed their times or turned Proactivity on or off. */
  bookLooks(): Promise<void> {
    return this.#bookLooks(this.checkIns().zone);
  }

  /** Book a look at each time wanted in `zone`, and drop those booked at another time or cron; none while Proactivity is off. */
  async #bookLooks(zone: string | null): Promise<void> {
    const wanted = this.#deps.looks.booked(zone);
    const key = (time: string | undefined, cron: string | undefined) => `${time} ${cron}`;
    const keep = new Set(wanted.map((look) => key(look.time, look.cron)));

    for (const old of await this.scheduler.list()) {
      if (old.callback === "look" && !keep.has(key(decodeOr(LookFire, old.payload, undefined)?.time, old.type === "cron" ? old.cron : undefined))) await this.scheduler.cancel(old.id);
    }

    for (const look of wanted) await this.scheduler.set(look.cron, "look", { time: look.time }, { idempotent: true });
  }

  /**
   * A fire: start the slot's run unless it is not wanted, already started,
   * the last run is still going, or its gate found nothing. It only checks
   * the gate (at most GATE_TIMEOUT_MS) and starts the run, so it never holds
   * up the alarm for long.
   */
  async #fire(fire: Fire, schedule: Schedule<Fire>): Promise<void> {
    const row = this.get(fire.id);

    if (row?.status !== "active") return;
    const slot = slotOf(fire, schedule, row);
    const task = `a-${row.id}-${slot}`;

    if (this.#overlaps(row.id, task)) return;

    // Delivered again after its run started, it starts nothing; a one-off still ends done.
    if (!this.#ran(task)) {
      // Run now is the user asking: it runs whatever the gate says.
      const admitted = await this.#admit(row, task, fire.slot !== undefined);

      if (admitted === null) {
        if (row.at !== null) await this.#done(row.id, schedule.id);

        return;
      }

      await this.#start({ ...row, prompt: `${admitted.prefix}${row.prompt}` }, slot, task);

      // Only once its run started: a fire that failed to start is tried again, and must not be skipped as a repeat.
      if (admitted.found !== undefined) this.#found(row.id, { hash: admitted.found, task });
    }

    if (row.at !== null) await this.#done(row.id, schedule.id);
  }

  /**
   * Check the fire's gate: what to put before the prompt ("" without a gate),
   * or null to skip the slot: it found nothing, or what the last fire found
   * (a repeat, no model run). The check is noted on the row, and the
   * GATE_ERRORS-th failure in a row pauses the automation and tells its chat.
   */
  async #admit(row: AutomationRow, task: string, forced: boolean): Promise<Admission | null> {
    if (row.gate === null) return { prefix: "" };
    const check = await this.checkGate(row.gate);

    if (check.kind === "found") return this.#admitFound(row.id, task, check.text, forced);
    const errors = check.kind === "error" ? row.gate_errors + 1 : 0;
    this.#set(row.id, { gate_checked_at: Date.now(), gate_note: noteOf(check), gate_errors: errors });

    // Found, then nothing, then the same again is new: the last fire found nothing.
    if (check.kind === "nothing") this.#found(row.id, null);

    if (forced) return { prefix: "" };

    if (check.kind === "error" && errors >= GATE_ERRORS) await this.#gatePaused(row, task, errors, check.text);

    return null;
  }

  /**
   * The gate found `text`: run with it, unless an earlier slot's fire found the same and the user did not ask to
   * run now. The same slot delivered again (the Scheduler may) is no repeat: its run starts once by its task id,
   * and neither is a finding whose run failed, which nobody was told about.
   */
  async #admitFound(id: string, task: string, text: string, forced: boolean): Promise<Admission | null> {
    const found = await digest(text);
    const last = this.#lastFound(id);
    const failed = last !== undefined && this.#deps.feed.get(last.task)?.status === "failed";
    const repeat = !forced && last !== undefined && !failed && last.hash === found && last.task !== task;
    this.#set(id, { gate_checked_at: Date.now(), gate_note: repeat ? SAME_NOTE : noteOf({ kind: "found", text }), gate_errors: 0 });

    return repeat ? null : { prefix: `Gate found:\n${text.slice(0, GATE_FOUND_MAX)}\n\n`, found };
  }

  /** The gate failed GATE_ERRORS fires in a row: pause the automation and tell its chat. */
  async #gatePaused(row: AutomationRow, task: string, errors: number, said: string): Promise<void> {
    await this.#halt(must(this.get(row.id), `Automation ${row.id} is gone.`), "paused");
    await this.#deps.runtime.deliver({
      id: `gate-paused:${task}`,
      session: this.#reportTo(row.chat),
      content: `[automation "${row.title}" paused] Its gate failed ${errors} fires in a row; the last said: ${said}. Fix the gate (automation update) and resume it.`,
      line: `automation "${row.title}" paused: its gate failed ${errors} fires in a row.`,
      ref: `automation:${row.id}`
    });
  }

  /** The hash of what the automation's gate last found and the run it started; undefined when its last check found nothing. */
  #lastFound(id: string): Found | undefined {
    const row = decodeOr(GateFoundRow, this.#sql.exec("SELECT gate_found, gate_found_by FROM ky_automations WHERE id = ?", id).toArray()[0], undefined);

    return row?.gate_found && row.gate_found_by ? { hash: row.gate_found, task: row.gate_found_by } : undefined;
  }

  /** Keep `found` as what the gate last found, or null for nothing. */
  #found(id: string, found: Found | null): void {
    this.#sql.exec("UPDATE ky_automations SET gate_found = ?, gate_found_by = ? WHERE id = ?", found?.hash ?? null, found?.task ?? null, id);
  }

  /** Run a gate's program once, as a fire does, and say what it came to. A tool's create and update test it this way. */
  async checkGate(code: string): Promise<GateCheck> {
    const signal = AbortSignal.timeout(GATE_TIMEOUT_MS);
    let answer: GateAnswer;

    try {
      answer = await this.#deps.gate(code, signal);
    } catch (error) {
      answer = { text: error instanceof Error ? error.message : String(error), error: true };
    }

    if (signal.aborted) return { kind: "error", text: `timed out after ${GATE_TIMEOUT_MS / 1000}s` };

    if (answer.error) return { kind: "error", text: answer.text.trim() || "Executor gave no reason" };
    const outcome = programOutcome(answer.text);

    // A gate runs unattended, so nobody is there to approve or answer.
    if (outcome.kind === "paused") return { kind: "error", text: "it asked for an approval or input; a gate may only read" };

    if (outcome.kind === "failed") return { kind: "error", text: outcome.text };

    const { value } = outcome;

    if (value === undefined || Value.Check(Nothing, value)) return { kind: "nothing", returned: JSON.stringify(value) ?? "undefined" };
    const items = decodeOr(Type.Array(Type.Unknown()), value, undefined)?.length;

    return items === undefined ? { kind: "found", text: foundText(value) } : { kind: "found", text: foundText(value), items };
  }

  async #start(row: AutomationRow, slot: number, task: string): Promise<void> {
    const chat = this.#reportTo(row.chat);

    await (row.machine === null
      ? this.#runInCloud(row, { slot, task, chat })
      : this.#runOnMachine(row, row.machine, { task, chat }));
  }

  /** The slot's run has started. A queued one may not have yet, and a failed one did not. */
  #ran(task: string): boolean {
    const own = this.#deps.feed.get(task);

    return own !== undefined && own.status !== "queued" && own.status !== "failed";
  }

  /** Another run of the automation is still going. */
  #overlaps(id: string, task: string): boolean {
    const last = this.#deps.feed.latestFrom(sourceOf(id));

    return last !== undefined && last.id !== task && isLive(last.status);
  }

  /**
   * The chat a run reports to: an archived side chat is brought back so the
   * report is seen, and a deleted one gives way to the main chat.
   */
  #reportTo(chat: string): string {
    const { chats } = this.#deps;

    if (chat === ROOT_SESSION) return chat;
    const row = chats.list().find((each) => each.session === chat);

    if (!row) return ROOT_SESSION;

    if (row.archived_at !== null) chats.archive(chat, false);

    return chat;
  }

  async #runInCloud(row: AutomationRow, { slot, task, chat }: Run): Promise<void> {
    const { feed, runtime } = this.#deps;
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

    try {
      await runtime.commit(async (tx) => {
        const { runs } = await tx.doc(Runs, ROOT_CONVERSATION_ID);

        if (runs[row.id]?.task === task) return;
        runs[row.id] = { slot, task };
        const checkIn = isCheckIn(row);
        await runtime.spawn(tx, conversationOf(chat), {
          name: workerOf(row.id),
          message: `${checkIn ? CHECK_IN : ""}${row.prompt}${row.post ? POSTED : ""}`,
          model: this.#modelOf(row),
          feedId: task,
          label: `${checkIn ? "check-in" : "automation"} "${row.title}"`,
          checkIn,
          deliver: true,
          post: row.post && !checkIn
        });
      });
    } catch (error) {
      // A retry of this fire tries again; until then the row says why it has not started.
      feed.update(task, { status: "failed", summary: `Could not start: ${error instanceof Error ? error.message : String(error)}` });

      // A one-off has no later fire: it waits paused for the user to resume it. Its booking is
      // this fire's, which the Scheduler retries and then drops; a retry finds it paused.
      if (row.at !== null && this.get(row.id)?.status === "active") {
        this.#set(row.id, { status: "paused", schedule_id: null });
      }

      throw error;
    }

    await runtime.wake();
  }

  /** A machine the user has paused or turned off takes no new tasks, so the slot's run fails and says why. */
  async #runOnMachine(row: AutomationRow, machine: string, { task, chat }: Omit<Run, "slot">): Promise<void> {
    const { feed, machines } = this.#deps;
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
  }

  /**
   * A one-off has run: it is done, and the fire's booking ends with this fire.
   * Read again, since a pause or an update may have come while it started.
   */
  async #done(id: string, firing: string): Promise<void> {
    const row = this.get(id);

    if (row?.status !== "active") return;

    if (row.schedule_id !== null && row.schedule_id !== firing) await this.scheduler.cancel(row.schedule_id);
    this.#set(id, { status: "done", schedule_id: null }, ["active"]);
  }

  /**
   * Pause or archive: no more fires, and the run in progress stops. The status is written before
   * anything awaits, with the booking it had then, so a re-book still in flight finds it halted.
   */
  async #halt(row: AutomationRow, status: "paused" | "archived"): Promise<void> {
    const booked = this.get(row.id)?.schedule_id ?? null;

    this.#set(row.id, { status, schedule_id: null });

    if (booked !== null) await this.scheduler.cancel(booked);
    const run = this.#deps.feed.latestFrom(sourceOf(row.id));

    if (!run || !isLive(run.status)) return;

    if (run.kind === "machine") return this.#deps.machines.stop(run);

    // Not started yet: its reporter sees the automation is not wanted and stops before it begins.
    if (run.session === null) return this.#deps.feed.update(run.id, { status: "stopped", summary: "Stopped" });

    return this.#deps.runtime.abort(run.session);
  }

  /** The automation's model while it can run, else the worker's. */
  #modelOf(row: AutomationRow): ModelChoice {
    return this.#deps.models.worker(row.model);
  }

  /** The draft as it can be saved, or why not. */
  #check(draft: AutomationDraft): Result<AutomationDraft> {
    const problem = draftProblem(draft) ?? this.#machineProblem(draft.machine, draft.post) ?? this.#chatProblem(draft.chat);

    if (problem !== undefined) return refused(problem);

    if (draft.model === null) return draft;
    const model = this.#deps.models.valid(draft.model);

    return model ? { ...draft, model } : refused(`${draft.model.provider}/${draft.model.modelId} is not available. ${this.#deps.models.choices()}`);
  }

  /** A check-in is a one-off in the cloud that reports to the main chat, within the day's and the waiting caps. */
  #checkInProblem(draft: AutomationDraft): string | undefined {
    if (!this.checkIns().on) return "The user turned check-ins off.";

    if (draft.cron !== null || draft.at === null) return "A check-in runs once: give at, not cron.";

    // A time already gone would run it now, in the night.
    if (draft.at <= Date.now()) return "A check-in's time must be ahead.";

    if (draft.machine !== null || draft.chat !== ROOT_SESSION) return "A check-in runs in the cloud and reports to the main chat.";

    if (draft.gate !== null) return "A check-in has no gate.";

    if (draft.post) return CHECK_IN_POSTS;

    return this.#checkInCapProblem();
  }

  /** Whether another check-in would pass the day's or the waiting cap. */
  #checkInCapProblem(): string | undefined {
    const count = (query: string, ...bindings: number[]) => decodeOr(CountRow, this.#sql.exec(query, ...bindings).one(), { n: 0 }).n;

    if (count("SELECT COUNT(*) AS n FROM ky_automations WHERE created_by = 'dream' AND created_at > ?", Date.now() - 86_400_000) >= CHECK_INS_A_DAY) {
      return `${CHECK_INS_A_DAY} check-ins were booked in the last day; that is the limit.`;
    }

    if (count("SELECT COUNT(*) AS n FROM ky_automations WHERE created_by = 'dream' AND status = 'active'") >= CHECK_INS_WAITING) {
      return `${CHECK_INS_WAITING} check-ins are already waiting; that is the limit.`;
    }

    return undefined;
  }

  /** Why it can't run on `machine`: one ky doesn't know, or a post, whose report is posted from the cloud. */
  #machineProblem(machine: string | null, post = false): string | undefined {
    if (machine === null) return undefined;

    if (post) return "A posted report runs in the cloud: ask ky to update it with post false first.";
    const known = this.#deps.machines.machines().map((each) => each.name);

    if (known.includes(machine)) return undefined;

    return `No machine ${machine}. Known: ${known.join(", ") || "none"}.`;
  }

  #chatProblem(chat: string): string | undefined {
    const { chats } = this.#deps;

    if (chat === ROOT_SESSION || chats.has(chat)) return undefined;
    const known = chats.list().map((each) => `${each.title || "untitled"} (${each.session})`);

    return `No chat ${chat}. Use main, or one of: ${known.join(", ") || "no side chats"}.`;
  }

  /** How the tool names a chat: main, or a side chat's title and session. */
  chatLabel(session: string): string {
    if (session === ROOT_SESSION) return "main";
    const title = this.#deps.chats.list().find((each) => each.session === session)?.title;

    return `${title || "untitled"} (${session})`;
  }

  /** Book its fires: the cron, or the one-off at its time, or now if that has passed. */
  async #book(id: string, timing: Pick<AutomationRow, "cron" | "at">): Promise<string> {
    const when = timing.cron ?? new Date(Math.max(timing.at ?? 0, Date.now()));

    return (await this.scheduler.set(when, "automation", { id }, { idempotent: true })).id;
  }

  /** Booking is how a cron is checked: the Scheduler refuses one it cannot parse. */
  async #tryBook(id: string, timing: Pick<AutomationRow, "cron" | "at">): Promise<{ id?: string; error?: string }> {
    try {
      return { id: await this.#book(id, timing) };
    } catch (error) {
      return { error: `Cannot schedule "${timing.cron}": ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async #unbook(row: AutomationRow): Promise<void> {
    if (row.schedule_id !== null) await this.scheduler.cancel(row.schedule_id);
  }

  /** Keep a booking made while awaiting only if the automation is still active; else it goes, as a pause or archive cancelled the rest. */
  async #keepBooking(id: string, scheduleId: string | null): Promise<void> {
    if (this.#set(id, { schedule_id: scheduleId }, ["active"]) || scheduleId === null) return;
    await this.scheduler.cancel(scheduleId);
  }

  async #view(row: AutomationRow): Promise<AutomationView> {
    const { schedule_id: scheduleId, ...rest } = row;
    const next = scheduleId === null ? undefined : await this.scheduler.get(scheduleId);

    return {
      ...rest,
      next_run: next ? next.time * 1000 : null,
      last_run: lastOf(this.#deps.feed.latestFrom(sourceOf(row.id)))
    };
  }

  #rows(query: string, ...bindings: string[]): AutomationRow[] {
    return automationRows(this.#sql.exec(query, ...bindings).toArray());
  }

  /**
   * Write `patch`, only while its status is one of `when` if that is given; whether it was written.
   * Read and write happen with no await between, so nothing changes the row in the middle.
   */
  #set(
    id: string,
    patch: Partial<Omit<AutomationRow, "id" | "watch" | "created_by" | "created_at" | "updated_at">>,
    when?: readonly AutomationStatus[]
  ): boolean {
    const current = this.get(id);

    if (!current || (when !== undefined && !when.includes(current.status))) return false;
    const next = { ...current, ...patch };
    this.#sql.exec(
      `UPDATE ky_automations SET title = ?, prompt = ?, cron = ?, at = ?, model = ?, machine = ?, chat = ?, gate = ?, post = ?,
         gate_checked_at = ?, gate_note = ?, gate_errors = ?, status = ?, schedule_id = ?, updated_at = ? WHERE id = ?`,
      next.title,
      next.prompt,
      next.cron,
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
      Date.now(),
      id
    );
    this.#emit();

    return true;
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

/** What a gate returns when there is nothing to do; undefined, which JSON has no form for, is nothing too. */
const Nothing = Type.Union([
  Type.Null(),
  Type.Literal(false),
  Type.Literal(0),
  Type.String({ pattern: "^\\s*$" }),
  Type.Array(Type.Unknown(), { maxItems: 0 }),
  Type.Object({}, { maxProperties: 0 })
]);

/** What a gate found as text for the prompt: a string as it is, anything else as JSON. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a gate returns whatever its program does.
function foundText(value: unknown): string {
  return decodeOr(Type.String(), value, undefined)?.trim() ?? JSON.stringify(value);
}

/** A gate check as the row keeps it, in a line. */
function noteOf(check: GateCheck): string {
  if (check.kind === "nothing") return "nothing";

  const text = check.text.replaceAll(/\s+/g, " ");

  return `${check.kind}: ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`;
}

/** Add the columns ky_automations was first made without. */
function addColumns(sql: SqlStorage, table: string, columns: ReadonlyArray<readonly [string, string]>): void {
  const have = sql
    .exec(`PRAGMA table_info(${table})`)
    .toArray()
    .flatMap((column) => decodeOr(ColumnInfo, column, undefined)?.name ?? []);

  for (const [name, type] of columns) {
    if (!have.includes(name)) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
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

/** Why an action does not apply to this automation. */
function refusal(id: string, row: AutomationRow | undefined, wanted: string): string {
  return row ? `"${row.title}" is ${row.status}, not ${wanted}.` : `No automation ${id}.`;
}

type Args = AutomationToolArgs;

const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });

/**
 * The model the tool asked for. `base` is what a level alone changes and a model alone keeps the
 * level of: the automation's own model on update, else the worker's.
 */
function modelArg(args: Args, base: ModelChoice): ModelChoice | null | undefined {
  if (args.model === "worker") return null;

  if (args.model === undefined) return args.thinking === undefined ? undefined : { ...base, thinkingLevel: args.thinking };

  return parseModel(args.model, args.thinking ?? base.thinkingLevel);
}

/** What an automation is and does, without its status, booking or anything else a row carries. */
function draftOf({ title, prompt, cron, at, model, machine, chat, gate, post }: AutomationDraft): AutomationDraft {
  return { title, prompt, cron, at, model, machine, chat, gate, post };
}

/** What the tool's arguments change, leaving out what they do not mention. */
function patchOf(args: Args, fallback: ModelChoice): Partial<AutomationDraft> {
  const patch: Partial<AutomationDraft> = {
    title: args.title,
    prompt: args.prompt,
    cron: args.cron,
    at: args.at === undefined ? undefined : Date.parse(args.at),
    model: modelArg(args, fallback),
    machine: args.machine === "cloud" ? null : args.machine,
    chat: args.chat === "main" ? ROOT_SESSION : args.chat,
    gate: args.gate === "none" || args.gate?.trim() === "" ? null : args.gate,
    post: args.post
  };

  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

/** Create, reporting to the calling chat unless another is named. A dream creates check-ins only. */
async function create(automations: Automations, args: Args, fallback: ModelChoice, caller: string, dream: boolean): Promise<string> {
  if (!args.title || !args.prompt) return "create needs a title and a prompt.";

  // What the arguments leave out: no model or machine, and reports to this chat.
  const unset = { cron: null, at: null, model: null, machine: null, chat: caller, gate: null };
  const asked = { ...unset, ...patchOf(args, fallback), title: args.title, prompt: args.prompt };
  const draft = dream ? { ...asked, model: null, machine: null, chat: ROOT_SESSION, post: false } : asked;
  const created = await automations.create(draft, dream ? "dream" : (args.createdBy ?? "user"));

  if (isRefusal(created)) return created.refused;

  return `Created automation ${created.id}, "${created.title}" (${scheduleOf(created)}).${await gateTest(automations, created.gate)}`;
}

/** A new gate run once, so the model sees what fires will make of it and can fix it now. */
async function gateTest(automations: Automations, gate: string | null): Promise<string> {
  if (gate === null) return "";
  const check = await automations.checkGate(gate);

  if (check.kind === "nothing") return `\nGate test: returned nothing (${check.returned}), so a fire now would be skipped.`;

  if (check.kind === "error") return `\nGate test failed: ${check.text}. Fix it with update; three failed fires in a row pause it.`;
  const found = check.items === undefined ? "found something" : `found ${check.items} item${check.items === 1 ? "" : "s"}`;
  const preview = check.text.length > GATE_PREVIEW_MAX ? `${check.text.slice(0, GATE_PREVIEW_MAX)}… (${check.text.length} characters in all)` : check.text;

  return `\nGate test: ${found}, so a fire now would run with it before its prompt:\n${preview}`;
}

function scheduleOf(row: Pick<AutomationRow, "cron" | "at">): string {
  return row.cron === null ? `once at ${new Date(row.at ?? 0).toISOString()}` : `cron ${row.cron} UTC`;
}

function lineOf(automations: Automations, view: AutomationView): string {
  const model = view.model ? `${view.model.provider}/${view.model.modelId} ${view.model.thinkingLevel}` : "worker model";
  const next = view.next_run === null ? "none" : new Date(view.next_run).toISOString();
  const last = view.last_run ? `${view.last_run.status}${view.last_run.summary ? `: ${view.last_run.summary}` : ""}` : "never";

  return [
    `${view.id} "${view.title}" [${view.status}] ${scheduleOf(view)}, by ${view.created_by}`,
    `  model: ${model}; where: ${view.machine ?? "cloud"}; reports to: ${automations.chatLabel(view.chat)}${view.post ? ", posted as ky's message" : ""}`,
    `  next: ${next}; last run: ${last}`,
    ...(view.gate === null
      ? []
      : [`  gate: last check ${view.gate_checked_at === null ? "never" : `${new Date(view.gate_checked_at).toISOString()}, ${view.gate_note}`}`])
  ].join("\n");
}

async function list(automations: Automations, all: boolean): Promise<string> {
  const views = await automations.list(all);

  return views.length === 0 ? "No automations." : views.map((view) => lineOf(automations, view)).join("\n");
}

/** The actions on one automation, by id: one handler each, so a new action can't go unhandled. */
const BY_ID = {
  pause: (automations, id) => automations.pause(id),
  resume: (automations, id) => automations.resume(id),
  archive: (automations, id) => automations.archive(id),
  unarchive: (automations, id) => automations.unarchive(id),
  run: (automations, id) => automations.run(id),
  delete: (automations, id) => automations.delete(id)
} satisfies { readonly [Action in ByIdAction]: (automations: Automations, id: string) => Promise<string> | string };

/** The user's actions from Activity, as the tool takes them. */
function act(automations: Automations, action: ByIdAction, id: string): Promise<string> | string {
  return BY_ID[action](automations, id);
}

type Call = {
  readonly action: ToolAction;
  readonly args: Args;
  readonly fallback: ModelChoice;
  readonly caller: string;
  /** The caller is a dream: it may create check-ins and list, nothing more. */
  readonly dream: boolean;
};

async function dispatch(automations: Automations, { action, args, fallback, caller, dream }: Call): Promise<string> {
  if (action === "create") return create(automations, args, fallback, caller, dream);

  if (action === "list") return list(automations, args.all ?? false);

  if (dream) return "A dream may only create check-ins and list automations.";

  if (!args.id) return `${action} needs an id.`;

  return action === "update" ? update(automations, args.id, args, fallback) : act(automations, action, args.id);
}

/** Update from the tool: a level alone is the automation's own model at that level, not the worker's. */
async function update(automations: Automations, id: string, args: Args, fallback: ModelChoice): Promise<string> {
  const patch = patchOf(args, automations.get(id)?.model ?? fallback);
  const updated = await automations.update(id, patch);

  if (isRefusal(updated)) return updated.refused;

  return `Updated "${updated.title}".${patch.gate === undefined ? "" : await gateTest(automations, updated.gate)}`;
}

/** The automation tool, for the main agent, and for a dream to book check-ins. */
export function automationExtension(
  automations: Automations,
  worker: () => ModelChoice,
  /** Whether a pi session is a dream's. */
  dreaming: (session: string) => boolean
): Extension {
  return defineExtension({
    name: EXTENSIONS.automations,
    tools: [
      defineTool({
        name: AUTOMATION_TOOL,
        description:
          "Schedule work to run later or on repeat, for the user or for yourself (to check back on something). " +
          "Each run is a fresh subagent, or a task on a machine, that knows only the prompt; its result is reported to this conversation, for you to pass on. " +
          "Crons are UTC: convert the user's local time. " +
          "Actions: create (title, prompt, cron or at, model and thinking optional, machine optional, chat optional, createdBy: user when the user asked, ky when it is yours). " +
          "Results go to this chat unless chat names another: main, or a side chat's session. " +
          "Every report goes to its chat in full, whether or not the user is around: a side chat archived by the time a run starts is brought back for it, and a deleted one's go to main. " +
          "update (id, any of the create fields). list (all optional): each one's schedule, status, next and last run. " +
          "pause, resume, archive, unarchive, run, delete (id): run fires it now; delete only when the user asks. " +
          "Pause or archive your own once they are no longer needed. " +
          "For \"tell me when X happens\" (new mail from someone, a PR review, a price), add a gate and a frequent cron like */15 * * * *: " +
          "the gate is an executor_execute program body run before each fire with no model, so a fire costs nothing until it finds something. " +
          "Return the matching items (a short list of what the run needs), or null when there are none. " +
          "Keep it narrow: only the window since the last fire (newer_than:15m for a 15-minute cron), only what the user cares about, read only. " +
          "Create and update test the gate once and tell you what it returned; fix it until that is what you meant. " +
          "Without a gate every fire runs.",
        parameters: AutomationToolInput,
        replay: "unsafe",
        execute: async (args, api) =>
          reply(
            await dispatch(automations, {
              action: args.action,
              args,
              fallback: worker(),
              caller: String(api.conversationId),
              dream: dreaming(String(api.conversationId))
            })
          )
      })
    ]
  });
}

/** A check-in's run may only search and read the web; every conversation gets this, as subagents drop the rest. */
export function checkInGuardExtension(automations: Automations): Extension {
  return defineExtension({
    name: EXTENSIONS.checkInGuard,
    hooks: [
      hook(ToolTask, {
        beforeTool: (call, api) => {
          if (CHECK_IN_ALLOWED.has(call.name) || !automations.checkInRun(String(api.conversationId))) return undefined;

          return { block: `A check-in may only call ${CHECK_IN_TOOLS.join(", ")}.` };
        }
      })
    ]
  });
}
