import { decodeOr } from "../core/decode";
import { must } from "../core/must";
import type { Agent, AgentModel } from "../machines/contract";
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

const LOG_KEPT = 60;

const LOGS_KEPT = 200;

const LIVE: readonly TaskStatus[] = ["queued", "working"];

export const isLive = (status: TaskStatus) => LIVE.includes(status);

const ADDED = [
  ["source", "TEXT NOT NULL DEFAULT 'chat'"],
  ["steps", "TEXT NOT NULL DEFAULT '[]'"],
  ["started_at", "INTEGER"],
  ["finished_at", "INTEGER"],
  ["turns", "INTEGER"],
  ["cost_usd", "REAL"],
  ["agent", "TEXT"],
  ["chat", "TEXT"],
  ["model", "TEXT"]
] as const;

function stretch(current: TaskRow, status: TaskStatus, now: number): Pick<TaskRow, "started_at" | "finished_at"> {
  if (!isLive(status)) return { started_at: current.started_at ?? now, finished_at: current.finished_at ?? now };

  const reopened = !isLive(current.status);

  if (status === "working" && (reopened || current.started_at === null)) return { started_at: now, finished_at: null };

  return { started_at: reopened ? null : current.started_at, finished_at: null };
}

export class TaskFeed {
  readonly #sql: SqlStorage;
  readonly #listeners = new Set<(tasks: TaskRow[]) => void>();
  readonly #spent = new Set<(task: TaskRow, costUsd: number) => void>();
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

    sql.exec("UPDATE ky_tasks SET agent = 'claude' WHERE kind = 'machine' AND agent IS NULL");
  }

  onChange(listener: (tasks: TaskRow[]) => void): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  onSpend(listener: (task: TaskRow, costUsd: number) => void): () => void {
    this.#spent.add(listener);

    return () => this.#spent.delete(listener);
  }

  nameWith(namer: TaskNamer): void {
    this.#namer = namer;
  }

  name(id: string, prompt: string): void {
    this.#namer?.title(id, prompt);
  }

  describe(id: string, report: string): void {
    this.#namer?.summary(id, report);
  }

  #rows(query: string, ...bindings: Array<string | number>): TaskRow[] {
    return taskRows(this.#sql.exec(query, ...bindings).toArray());
  }

  list(limit = 100): TaskRow[] {
    return this.#rows("SELECT * FROM ky_tasks ORDER BY updated_at DESC LIMIT ?", limit);
  }

  finishedSince(at: number, limit: number, except: readonly string[]): TaskRow[] {
    return this.#rows(
      `SELECT * FROM ky_tasks WHERE finished_at > ? AND worker NOT IN (${except.map(() => "?").join(", ")}) ORDER BY finished_at DESC LIMIT ?`,
      at,
      ...except,
      limit
    );
  }

  get(id: string): TaskRow | undefined {
    return this.#rows("SELECT * FROM ky_tasks WHERE id = ?", id)[0];
  }

  latest(kind: TaskKind, worker: string): TaskRow | undefined {
    return this.#rows(
      "SELECT * FROM ky_tasks WHERE kind = ? AND worker = ? ORDER BY created_at DESC LIMIT 1",
      kind,
      worker
    )[0];
  }

  latestFrom(source: string): TaskRow | undefined {
    return this.#rows("SELECT * FROM ky_tasks WHERE source = ? ORDER BY created_at DESC LIMIT 1", source)[0];
  }

  recentFrom(source: string, limit: number): TaskRow[] {
    return this.#rows("SELECT * FROM ky_tasks WHERE source = ? ORDER BY created_at DESC LIMIT ?", source, limit);
  }

  closedSince(kind: TaskKind, since: number): string[] {
    return this.#rows("SELECT * FROM ky_tasks WHERE kind = ? AND status NOT IN ('queued', 'working') AND updated_at >= ?", kind, since).map(
      (task) => task.id
    );
  }

  open(kind: TaskKind, worker: string): TaskRow[] {
    return this.#rows(
      "SELECT * FROM ky_tasks WHERE kind = ? AND worker = ? AND status IN ('queued', 'working') ORDER BY created_at",
      kind,
      worker
    );
  }

  working(session: string): TaskRow | undefined {
    return this.#rows(
      "SELECT * FROM ky_tasks WHERE kind = 'cloud' AND session = ? AND status = 'working' ORDER BY created_at DESC LIMIT 1",
      session
    )[0];
  }

  create(
    task: Pick<TaskRow, "id" | "kind" | "worker" | "title" | "status" | "session"> & {
      summary?: string;
      source?: string;
      agent?: Agent;
      model?: AgentModel | null;
      chat?: string | null;
    }
  ): TaskRow {
    const now = Date.now();
    this.#sql.exec(
      `INSERT OR IGNORE INTO ky_tasks
        (id, kind, source, worker, title, status, summary, session, agent, model, chat, created_at, updated_at, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      task.id,
      task.kind,
      task.source ?? "chat",
      task.worker,
      task.title,
      task.status,
      task.summary ?? "",
      task.session,
      task.agent ?? null,
      task.model ? JSON.stringify(task.model) : null,
      task.chat ?? null,
      now,
      now,
      task.status === "working" ? now : null
    );
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

  cutOff(source: string): void {
    const now = Date.now();
    this.#sql.exec(
      `UPDATE ky_tasks SET status = 'failed', summary = 'Cut off by a restart', finished_at = coalesce(finished_at, ?), updated_at = ?
       WHERE source = ? AND status IN ('queued', 'working')`,
      now,
      now,
      source
    );
    this.#emit();
  }

  reassign(id: string, worker: string): void {
    this.#sql.exec("UPDATE ky_tasks SET worker = ?, updated_at = ? WHERE id = ?", worker, Date.now(), id);
    this.#emit();
  }

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

    if (isLive(this.get(id)?.status ?? "done")) this.update(id, {});
  }

  log(id: string): TaskLogStep[] {
    return taskLogRows(
      this.#sql.exec(`SELECT seq, call, at, ended_at, state, text, detail, input, output FROM ky_task_steps WHERE task = ? ORDER BY seq`, id).toArray()
    );
  }

  spend(id: string, turns: number, costUsd: number): void {
    this.#sql.exec(
      "UPDATE ky_tasks SET turns = COALESCE(turns, 0) + ?, cost_usd = COALESCE(cost_usd, 0) + ? WHERE id = ?",
      turns,
      costUsd,
      id
    );
    const task = this.get(id);

    if (task) for (const listener of this.#spent) listener(task, costUsd);
    this.#emit();
  }

  #emit(): void {
    if (this.#listeners.size === 0) return;
    const tasks = this.list();

    for (const listener of this.#listeners) listener(tasks);
  }
}
