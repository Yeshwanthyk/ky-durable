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
import type { ChatList } from "../chats";
import { decodeOr } from "../core/decode";
import { must } from "../core/must";
import { isRefusal, type Refusal, refused, type Result } from "../core/refusal";
import type { MachineHub } from "../machines/contract";
import type { Models } from "../models";
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
  EXTENSIONS,
  type LastRun,
  StoredCheckIns,
  type TaskFeed,
  type TaskRow,
  type ToolAction
} from "./contract";
import { pausedForUser } from "../executor-status";
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
 * before each fire, with no model. When it returns nothing (null, false, an
 * empty list) the slot is skipped and only the row's last check says so;
 * when it returns something, that is put before the run's prompt. A gate that
 * fails three fires in a row pauses its automation and the chat is told.
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
  /** Say something to a chat, as a steer; `requestId` keeps a retry from saying it twice. */
  readonly tell: (session: string, content: string, requestId: string) => Promise<void>;
};

/** What an Executor program answered: its text, and whether it failed. */
export type GateAnswer = { readonly text: string; readonly error: boolean };

export type AutomationDeps = {
  readonly feed: TaskFeed;
  readonly machines: MachineHub;
  readonly chats: ChatList;
  readonly models: Pick<Models, "worker" | "valid" | "catalog">;
  readonly runtime: AutomationRuntime;
  /** Run a gate's program on the user's Executor. */
  readonly gate: (code: string, signal: AbortSignal) => Promise<GateAnswer>;
  /** ky's own nightly job, Dreaming (src/dreaming/dreaming.ts): booked here so one Scheduler holds every fire. */
  readonly dream: { readonly cron: string; readonly run: () => void };
  /** Peers' sweep (src/peers/peers.ts sweepPeers): questions that expire, and answers to send again. */
  readonly peers: () => Promise<void>;
};

/** Check-ins booked in one day, and waiting at once. */
const CHECK_INS_A_DAY = 2;

const CHECK_INS_WAITING = 6;

const CHECK_IN_ALLOWED: ReadonlySet<string> = new Set(CHECK_IN_TOOLS);

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

/** What a gate returns when there is nothing to do, once spaces are taken out. */
const NOTHING: ReadonlySet<string> = new Set(["", "null", "undefined", "false", "0", "[]", "{}", '""']);

/** What a gate came to: something found, nothing, or why it failed. */
type GateCheck =
  | { readonly kind: "found"; readonly text: string }
  | { readonly kind: "nothing" }
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
    peers: () => Promise<void>;
  }>({
    callbacks: {
      automation: (fire, schedule) => this.#fire(fire, schedule),
      // It only starts the dream, so it never holds up the alarm.
      dream: async () => this.#deps.dream.run(),
      peers: () => this.#deps.peers()
    }
  });

  constructor(sql: SqlStorage, deps: AutomationDeps) {
    this.#sql = sql;
    this.#deps = deps;
    sql.exec("CREATE TABLE IF NOT EXISTS ky_check_ins (id INTEGER PRIMARY KEY CHECK (id = 1), off INTEGER NOT NULL, zone TEXT)");
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
      created_by TEXT NOT NULL,
      status TEXT NOT NULL,
      schedule_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL)`);
    addColumns(sql, AUTOMATION_TABLES.automations, [
      ["gate", "TEXT"],
      ["gate_checked_at", "INTEGER"],
      ["gate_note", "TEXT"],
      ["gate_errors", "INTEGER NOT NULL DEFAULT 0"]
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

  /** Whether the dream may book check-ins, and the user's time zone. On until the user turns them off. */
  checkIns(): CheckIns {
    const row = decodeOr(StoredCheckIns, this.#sql.exec("SELECT off, zone FROM ky_check_ins WHERE id = 1").toArray()[0], undefined);

    return { on: row?.off !== 1, zone: row?.zone ?? null };
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

  /** The user's time zone, from where their browser connects; check-ins are booked for their morning. */
  setZone(zone: string): void {
    if (zone === this.checkIns().zone) return;
    this.#sql.exec("INSERT INTO ky_check_ins (id, off, zone) VALUES (1, 0, ?) ON CONFLICT (id) DO UPDATE SET zone = excluded.zone", zone);
  }

  /** Whether the pi session is a check-in's run at work. */
  checkInRun(session: string): boolean {
    const task = this.#deps.feed.working(session);

    if (!task?.source.startsWith(SOURCE)) return false;

    return this.get(task.source.slice(SOURCE.length))?.created_by === "dream";
  }

  /** A new active automation, booked; or why it was refused. */
  async create(draft: AutomationDraft, author: AutomationAuthor): Promise<Result<AutomationRow>> {
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
        (id, title, prompt, cron, at, model, machine, chat, gate, created_by, status, schedule_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      id,
      checked.title,
      checked.prompt,
      checked.cron,
      checked.at,
      checked.model === null ? null : JSON.stringify(checked.model),
      checked.machine,
      checked.chat,
      checked.gate,
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
    const retimed = patch.cron !== undefined || patch.at !== undefined;
    const checked = this.#check(draftOf({ ...row, ...patch, ...timingOf(patch) }));

    if (isRefusal(checked)) return checked;
    const why = row.status === "active" && retimed ? await this.#rebook(row, checked) : this.#save(id, checked);

    if (why) return why;

    // A new gate starts with no checks and no failures.
    if (checked.gate !== row.gate) this.#set(id, { gate_checked_at: null, gate_note: null, gate_errors: 0 });

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

  /** Gone for good: no more fires, the run in progress stops, and the row is removed. Its past runs stay in Activity. */
  async delete(id: string): Promise<string> {
    const row = this.get(id);

    if (!row) return `No automation ${id}.`;
    await this.#halt(row, "archived");
    this.#sql.exec("DELETE FROM ky_automations WHERE id = ?", id);
    this.#emit();

    return `Deleted "${row.title}".`;
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

  /** Book peers' sweep at `at`, epoch ms. */
  async sweepPeersAt(at: number): Promise<void> {
    await this.scheduler.set(new Date(at), "peers");
  }

  /** On start: book the nightly dream, and any active automation whose booking is missing. */
  async recover(): Promise<void> {
    for (const old of await this.scheduler.list()) {
      if (old.callback === "dream" && (old.type !== "cron" || old.cron !== this.#deps.dream.cron)) {
        await this.scheduler.cancel(old.id);
      }
    }

    await this.scheduler.set(this.#deps.dream.cron, "dream", undefined, { idempotent: true });

    for (const row of this.#rows("SELECT * FROM ky_automations WHERE status = 'active'")) {
      if (row.schedule_id !== null && (await this.scheduler.get(row.schedule_id))) continue;
      await this.#keepBooking(row.id, await this.#book(row.id, row));
    }
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
      const found = await this.#admit(row, task, fire.slot !== undefined);

      if (found === null) {
        if (row.at !== null) await this.#done(row.id, schedule.id);

        return;
      }

      await this.#start({ ...row, prompt: found === "" ? row.prompt : `${found}${row.prompt}` }, slot, task);
    }

    if (row.at !== null) await this.#done(row.id, schedule.id);
  }

  /**
   * Check the fire's gate: what to put before the prompt ("" without a gate),
   * or null to skip the slot. The check is noted on the row, and the
   * GATE_ERRORS-th failure in a row pauses the automation and tells its chat.
   */
  async #admit(row: AutomationRow, task: string, forced: boolean): Promise<string | null> {
    if (row.gate === null) return "";
    const check = await this.checkGate(row.gate);
    const failed = check.kind === "error";
    const errors = failed ? row.gate_errors + 1 : 0;
    this.#set(row.id, { gate_checked_at: Date.now(), gate_note: noteOf(check), gate_errors: errors });

    if (check.kind === "found") return `Gate found:\n${check.text.slice(0, GATE_FOUND_MAX)}\n\n`;

    if (forced) return "";

    if (failed && errors >= GATE_ERRORS) {
      await this.#halt(must(this.get(row.id), `Automation ${row.id} is gone.`), "paused");
      await this.#deps.runtime.tell(
        this.#reportTo(row.chat),
        `[automation "${row.title}" paused] Its gate failed ${errors} fires in a row; the last said: ${check.text}. Fix the gate (automation update) and resume it.`,
        `gate-paused:${task}`
      );
    }

    return null;
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

    // A gate runs unattended, so nobody is there to approve or answer.
    if (pausedForUser(answer.text)) return { kind: "error", text: "it asked for an approval or input; a gate may only read" };

    const text = answer.text.trim();

    return NOTHING.has(text.replaceAll(/\s/g, "")) ? { kind: "nothing" } : { kind: "found", text };
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
        const checkIn = row.created_by === "dream";
        await runtime.spawn(tx, conversationOf(chat), {
          name: workerOf(row.id),
          message: checkIn ? `${CHECK_IN}${row.prompt}` : row.prompt,
          model: this.#modelOf(row),
          feedId: task,
          label: `${checkIn ? "check-in" : "automation"} "${row.title}"`,
          checkIn
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
    const problem =
      wordsProblem(draft) ??
      timingProblem(draft) ??
      this.#machineProblem(draft.machine) ??
      this.#chatProblem(draft.chat) ??
      gateProblem(draft.gate);

    if (problem !== undefined) return refused(problem);

    if (draft.model === null) return draft;
    const model = this.#deps.models.valid(draft.model);

    return model ? { ...draft, model } : refused(`${draft.model.provider}/${draft.model.modelId} is not available. ${this.#choices()}`);
  }

  /** A check-in is a one-off in the cloud that reports to the main chat, within the day's and the waiting caps. */
  #checkInProblem(draft: AutomationDraft): string | undefined {
    if (!this.checkIns().on) return "The user turned check-ins off.";

    if (draft.cron !== null || draft.at === null) return "A check-in runs once: give at, not cron.";

    // A time already gone would run it now, in the night.
    if (draft.at <= Date.now()) return "A check-in's time must be ahead.";

    if (draft.machine !== null || draft.chat !== ROOT_SESSION) return "A check-in runs in the cloud and reports to the main chat.";

    if (draft.gate !== null) return "A check-in has no gate.";

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

  #machineProblem(machine: string | null): string | undefined {
    const known = this.#deps.machines.machines().map((each) => each.name);

    if (machine === null || known.includes(machine)) return undefined;

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

  /** The featured models an automation can use, and their thinking levels; any other a provider offers works too. */
  #choices(): string {
    const models = this.#deps.models.catalog().flatMap((provider) =>
      provider.connected
        ? provider.models.flatMap((model) => (model.featured ? [`${provider.id}/${model.modelId} (${model.levels.join(", ") || "off"})`] : []))
        : []
    );

    return `Choose one of: ${models.join("; ")}. Any other model those providers offer works too, by its id.`;
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
    patch: Partial<Omit<AutomationRow, "id" | "created_by" | "created_at" | "updated_at">>,
    when?: readonly AutomationStatus[]
  ): boolean {
    const current = this.get(id);

    if (!current || (when !== undefined && !when.includes(current.status))) return false;
    const next = { ...current, ...patch };
    this.#sql.exec(
      `UPDATE ky_automations SET title = ?, prompt = ?, cron = ?, at = ?, model = ?, machine = ?, chat = ?, gate = ?,
         gate_checked_at = ?, gate_note = ?, gate_errors = ?, status = ?, schedule_id = ?, updated_at = ? WHERE id = ?`,
      next.title,
      next.prompt,
      next.cron,
      next.at,
      next.model === null ? null : JSON.stringify(next.model),
      next.machine,
      next.chat,
      next.gate,
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

/** A title and a prompt are needed: the list shows one, and a run knows only the other. */
function wordsProblem(draft: Pick<AutomationDraft, "title" | "prompt">): string | undefined {
  return draft.title.trim() && draft.prompt.trim() ? undefined : "An automation needs a title and a prompt.";
}

/** A gate is a program body; blank means no gate, and is saved as null by the tool and the UI. */
function gateProblem(gate: string | null): string | undefined {
  return gate !== null && gate.trim() === "" ? "A gate is an Executor program; leave it out for none." : undefined;
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

/** What is wrong with when it runs, if anything. */
function timingProblem(draft: Pick<AutomationDraft, "cron" | "at">): string | undefined {
  if ((draft.cron === null) === (draft.at === null)) return "Give exactly one of cron (UTC) or at.";

  if (draft.at !== null && !Number.isFinite(draft.at)) return "at must be an ISO time, like 2026-10-06T09:00:00Z.";

  return undefined;
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
  const [provider = "", ...rest] = args.model.split("/");

  return { provider, modelId: rest.join("/"), thinkingLevel: args.thinking ?? base.thinkingLevel };
}

/** What an automation is and does, without its status, booking or anything else a row carries. */
function draftOf({ title, prompt, cron, at, model, machine, chat, gate }: AutomationDraft): AutomationDraft {
  return { title, prompt, cron, at, model, machine, chat, gate };
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
    gate: args.gate === "none" || args.gate?.trim() === "" ? null : args.gate
  };

  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

/** Create, reporting to the calling chat unless another is named. A dream creates check-ins only. */
async function create(automations: Automations, args: Args, fallback: ModelChoice, caller: string, dream: boolean): Promise<string> {
  if (!args.title || !args.prompt) return "create needs a title and a prompt.";

  // What the arguments leave out: no model or machine, and reports to this chat.
  const unset = { cron: null, at: null, model: null, machine: null, chat: caller, gate: null };
  const asked = { ...unset, ...patchOf(args, fallback), title: args.title, prompt: args.prompt };
  const draft = dream ? { ...asked, model: null, machine: null, chat: ROOT_SESSION } : asked;
  const created = await automations.create(draft, dream ? "dream" : (args.createdBy ?? "user"));

  if (isRefusal(created)) return created.refused;

  return `Created automation ${created.id}, "${created.title}" (${scheduleOf(created)}).${await gateTest(automations, created.gate)}`;
}

/** A new gate run once, so the model sees what fires will make of it and can fix it now. */
async function gateTest(automations: Automations, gate: string | null): Promise<string> {
  if (gate === null) return "";
  const check = await automations.checkGate(gate);

  if (check.kind === "nothing") return "\nGate test: nothing, so a fire now would be skipped.";

  if (check.kind === "error") return `\nGate test failed: ${check.text}. Fix it with update; three failed fires in a row pause it.`;

  return `\nGate test: found, so a fire now would run with this before its prompt:\n${check.text.slice(0, GATE_FOUND_MAX)}`;
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
    `  model: ${model}; where: ${view.machine ?? "cloud"}; reports to: ${automations.chatLabel(view.chat)}`,
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
