/**
 * The task feed: one row per piece of delegated work, cloud subagent or
 * machine run, with a title, a status, the last few steps it took and, once
 * it ends, its result and what it cost. It is what the UI's task list shows,
 * and what the main agent's `status` reads.
 */

import { decodeOr } from "../core/decode";
import { must } from "../core/must";
import type { Agent } from "../machines/contract";
import type { StepEnd } from "../step-labels";
import {
  ColumnInfo,
  summarize,
  taskLogRows,
  taskRows,
  type TaskLogStep,
  type TaskKind,
  type TaskNamer,
  type TaskPatch,
  type TaskRow,
  type TaskStatus
} from "./contract";

const STEPS_KEPT = 5;

/** How many steps a task's full log keeps, and how many of the newest tasks keep one. */
const LOG_KEPT = 60;

const LOGS_KEPT = 200;

const LIVE: readonly TaskStatus[] = ["queued", "working"];

/** Queued or working: not over yet. */
export const isLive = (status: TaskStatus) => LIVE.includes(status);

/** Columns added after ky_tasks was first made, with their types. */
const ADDED = [
  ["source", "TEXT NOT NULL DEFAULT 'chat'"],
  ["steps", "TEXT NOT NULL DEFAULT '[]'"],
  ["started_at", "INTEGER"],
  ["finished_at", "INTEGER"],
  ["turns", "INTEGER"],
  ["cost_usd", "REAL"],
  ["agent", "TEXT"]
] as const;

/** When a status change moves the task's working stretch: it starts working again, or it ends. */
function stretch(current: TaskRow, status: TaskStatus, now: number): Pick<TaskRow, "started_at" | "finished_at"> {
  if (!isLive(status)) return { started_at: current.started_at ?? now, finished_at: current.finished_at ?? now };

  const reopened = !isLive(current.status);

  if (status === "working" && (reopened || current.started_at === null)) return { started_at: now, finished_at: null };

  return { started_at: reopened ? null : current.started_at, finished_at: null };
}

export class TaskFeed {
  readonly #sql: SqlStorage;
  readonly #listeners = new Set<(tasks: TaskRow[]) => void>();
  #namer: TaskNamer | undefined;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_tasks (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      worker TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      session TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL)`);

    const columns = sql
      .exec("PRAGMA table_info(ky_tasks)")
      .toArray()
      .flatMap((column) => decodeOr(ColumnInfo, column, undefined)?.name ?? []);

    for (const [name, type] of ADDED) {
      if (!columns.includes(name)) sql.exec(`ALTER TABLE ky_tasks ADD COLUMN ${name} ${type}`);
    }

    // Every step a task took, with what came back, for its timeline; the steps column keeps the last few for the feed.
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_task_steps (
      seq INTEGER PRIMARY KEY,
      task TEXT NOT NULL,
      call TEXT,
      at INTEGER NOT NULL,
      ended_at INTEGER,
      state TEXT NOT NULL,
      text TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      input TEXT NOT NULL DEFAULT '',
      output TEXT NOT NULL DEFAULT '')`);
    sql.exec(`CREATE INDEX IF NOT EXISTS task_steps_by_task ON ky_task_steps (task, seq)`);

    // Machine tasks from before they named their agent all ran as Claude Code.
    sql.exec("UPDATE ky_tasks SET agent = 'claude' WHERE kind = 'machine' AND agent IS NULL");
  }

  onChange(listener: (tasks: TaskRow[]) => void): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  nameWith(namer: TaskNamer): void {
    this.#namer = namer;
  }

  /** A task started with no title: name it from its prompt. */
  name(id: string, prompt: string): void {
    this.#namer?.title(id, prompt);
  }

  /** A task finished: sum up its whole report, not just the report's first line. */
  describe(id: string, report: string): void {
    this.#namer?.summary(id, report);
  }

  #rows(query: string, ...bindings: Array<string | number>): TaskRow[] {
    return taskRows(this.#sql.exec(query, ...bindings).toArray());
  }

  list(limit = 100): TaskRow[] {
    return this.#rows("SELECT * FROM ky_tasks ORDER BY updated_at DESC LIMIT ?", limit);
  }

  get(id: string): TaskRow | undefined {
    return this.#rows("SELECT * FROM ky_tasks WHERE id = ?", id)[0];
  }

  /** The newest task a worker has, for `send`/`stop` by name. */
  latest(kind: TaskKind, worker: string): TaskRow | undefined {
    return this.#rows(
      "SELECT * FROM ky_tasks WHERE kind = ? AND worker = ? ORDER BY created_at DESC LIMIT 1",
      kind,
      worker
    )[0];
  }

  /** The newest task started for a reason, such as `automation:<id>`. */
  latestFrom(source: string): TaskRow | undefined {
    return this.#rows("SELECT * FROM ky_tasks WHERE source = ? ORDER BY created_at DESC LIMIT 1", source)[0];
  }

  /** The ids of the tasks of a kind that ended, last changed at or after `since`. */
  closedSince(kind: TaskKind, since: number): string[] {
    return this.#rows("SELECT * FROM ky_tasks WHERE kind = ? AND status NOT IN ('queued', 'working') AND updated_at >= ?", kind, since).map(
      (task) => task.id
    );
  }

  /** A worker's queued and working tasks, oldest first. */
  open(kind: TaskKind, worker: string): TaskRow[] {
    return this.#rows(
      "SELECT * FROM ky_tasks WHERE kind = ? AND worker = ? AND status IN ('queued', 'working') ORDER BY created_at",
      kind,
      worker
    );
  }

  /** The working cloud task a pi session is doing, if any: the newest, as a subagent does one message at a time. */
  working(session: string): TaskRow | undefined {
    return this.#rows(
      "SELECT * FROM ky_tasks WHERE kind = 'cloud' AND session = ? AND status = 'working' ORDER BY created_at DESC LIMIT 1",
      session
    )[0];
  }

  /** Insert the task, or leave an existing one alone: ids are idempotency keys. */
  create(
    task: Pick<TaskRow, "id" | "kind" | "worker" | "title" | "status" | "session"> & {
      summary?: string;
      source?: string;
      agent?: Agent;
    }
  ): TaskRow {
    const now = Date.now();
    this.#sql.exec(
      `INSERT OR IGNORE INTO ky_tasks
        (id, kind, source, worker, title, status, summary, session, agent, created_at, updated_at, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      task.id,
      task.kind,
      task.source ?? "chat",
      task.worker,
      task.title,
      task.status,
      task.summary ?? "",
      task.session,
      task.agent ?? null,
      now,
      now,
      task.status === "working" ? now : null
    );
    // Only the newest tasks keep their full log.
    this.#sql.exec(
      `DELETE FROM ky_task_steps WHERE task NOT IN (SELECT id FROM ky_tasks ORDER BY updated_at DESC LIMIT ?)`,
      LOGS_KEPT
    );
    this.#emit();

    return must(this.get(task.id), `Task ${task.id} wasn't saved.`);
  }

  update(id: string, patch: TaskPatch): void {
    const current = this.get(id);

    if (!current) return;
    const now = Date.now();
    const next = { ...current, ...patch, ...stretch(current, patch.status ?? current.status, now) };
    this.#sql.exec(
      `UPDATE ky_tasks SET title = ?, status = ?, summary = ?, session = ?, started_at = ?, finished_at = ?, updated_at = ?
       WHERE id = ?`,
      next.title,
      next.status,
      next.summary,
      next.session,
      next.started_at,
      next.finished_at,
      now,
      id
    );
    this.#emit();
  }

  /** The task now runs on `worker`: a machine task moved before it started. */
  reassign(id: string, worker: string): void {
    this.#sql.exec("UPDATE ky_tasks SET worker = ?, updated_at = ? WHERE id = ?", worker, Date.now(), id);
    this.#emit();
  }

  /**
   * The task took a step, such as "Reading tasks.ts"; a task that is over takes none. A step with a
   * `call` is a tool running until `stepEnd` says it is done; one without is done as it is said.
   */
  step(id: string, text: string, start: { call?: string; input?: string } = {}): void {
    const current = this.get(id);
    const line = summarize(text);

    if (!current || !isLive(current.status) || line === "") return;
    const repeated = current.steps.at(-1)?.text === line;

    if (repeated && start.call === undefined) return;
    const now = Date.now();
    this.#logStep(id, line, now, start);

    if (!repeated) {
      const steps = [...current.steps, { at: now, text: line }].slice(-STEPS_KEPT);
      this.#sql.exec("UPDATE ky_tasks SET steps = ? WHERE id = ?", JSON.stringify(steps), id);
    }

    this.update(id, { status: "working" });
  }

  /** Add a step to the task's full log, which keeps its newest LOG_KEPT. */
  #logStep(id: string, line: string, at: number, { call = null, input = "" }: { call?: string | null; input?: string }): void {
    this.#sql.exec(
      `INSERT INTO ky_task_steps (task, call, at, state, text, input) VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      call,
      at,
      call === null ? "done" : "running",
      line,
      input
    );
    this.#sql.exec(
      `DELETE FROM ky_task_steps WHERE task = ? AND seq <= (SELECT seq FROM ky_task_steps WHERE task = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)`,
      id,
      id,
      LOG_KEPT
    );
  }

  /** The tool a step's `call` ran is done: its title says what it did, with what came back. */
  stepEnd(id: string, call: string, end: StepEnd): void {
    this.#sql.exec(
      `UPDATE ky_task_steps SET state = ?, text = ?, detail = ?, output = ?, ended_at = ? WHERE task = ? AND call = ? AND state = 'running'`,
      end.state,
      summarize(end.text),
      end.detail,
      end.output,
      Date.now(),
      id,
      call
    );

    // A live task's row changes, so a page showing its timeline asks for it again.
    if (isLive(this.get(id)?.status ?? "done")) this.update(id, {});
  }

  /** Every step the task's log kept, oldest first. */
  log(id: string): TaskLogStep[] {
    return taskLogRows(
      this.#sql.exec(`SELECT seq, call, at, ended_at, state, text, detail, input, output FROM ky_task_steps WHERE task = ? ORDER BY seq`, id).toArray()
    );
  }

  /** Add model turns and their cost to the task's totals. */
  spend(id: string, turns: number, costUsd: number): void {
    this.#sql.exec(
      "UPDATE ky_tasks SET turns = COALESCE(turns, 0) + ?, cost_usd = COALESCE(cost_usd, 0) + ? WHERE id = ?",
      turns,
      costUsd,
      id
    );
    this.#emit();
  }

  #emit(): void {
    if (this.#listeners.size === 0) return;
    const tasks = this.list();

    for (const listener of this.#listeners) listener(tasks);
  }
}
