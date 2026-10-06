/**
 * The task feed: one row per piece of delegated work, cloud subagent or
 * machine run, with a title, a status, the last few steps it took and, once
 * it ends, its result and what it cost. It is what the UI's task list shows,
 * and what the main agent's `status` reads.
 */

export type TaskKind = "cloud" | "machine";

export type TaskStatus = "queued" | "working" | "done" | "failed" | "stopped";

/** One thing a task did, such as "Reading tasks.ts", and when. */
export type TaskStep = { readonly at: number; readonly text: string };

export type TaskRow = {
  readonly id: string;
  /** Where it runs. */
  readonly kind: TaskKind;
  /** Why it exists: "chat" for work asked for in a chat. */
  readonly source: string;
  /** The subagent's name, or the machine a run is placed on. */
  readonly worker: string;
  readonly title: string;
  readonly status: TaskStatus;
  /** Its result, once a turn ends. */
  readonly summary: string;
  /** Its last few steps, oldest first: the last is what it is doing now. */
  readonly steps: readonly TaskStep[];
  /** Cloud: the pi session to open. Machine: the Claude Code session id. */
  readonly session: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  /** When its latest stretch of work began: its start, or the message that resumed it. */
  readonly started_at: number | null;
  /** When that stretch ended; null while it is queued or working. */
  readonly finished_at: number | null;
  /** Model turns and dollars spent, all turns together; null until something reports them. */
  readonly turns: number | null;
  readonly cost_usd: number | null;
};

export type TaskPatch = Partial<
  Pick<TaskRow, "title" | "status" | "summary" | "session">
>;

const SUMMARY_CHARS = 240;

/** First line of a text, trimmed to fit a task card. */
export function summarize(text: string): string {
  const line = text.trim().split("\n").find((part) => part.trim() !== "") ?? "";

  return line.length > SUMMARY_CHARS ? `${line.slice(0, SUMMARY_CHARS - 1)}…` : line;
}

/** Writes better titles and summaries than a first line, in the background. */
export type TaskNamer = {
  readonly title: (id: string, text: string) => void;
  readonly summary: (id: string, text: string) => void;
};

const STEPS_KEPT = 5;

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
  ["cost_usd", "REAL"]
] as const;

type StoredRow = Omit<TaskRow, "steps"> & { steps: string };

function rowOf(stored: StoredRow): TaskRow {
  // SAFETY: only #setSteps writes steps, always a JSON array of TaskStep.
  return { ...stored, steps: JSON.parse(stored.steps) as TaskStep[] };
}

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
    const columns = sql.exec<{ name: string }>("PRAGMA table_info(ky_tasks)").toArray();

    for (const [name, type] of ADDED) {
      if (!columns.some((column) => column.name === name)) sql.exec(`ALTER TABLE ky_tasks ADD COLUMN ${name} ${type}`);
    }
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
    return this.#sql.exec<StoredRow>(query, ...bindings).toArray().map(rowOf);
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
    task: Pick<TaskRow, "id" | "kind" | "worker" | "title" | "status" | "session"> & { summary?: string; source?: string }
  ): TaskRow {
    const now = Date.now();
    this.#sql.exec(
      `INSERT OR IGNORE INTO ky_tasks
        (id, kind, source, worker, title, status, summary, session, created_at, updated_at, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      task.id,
      task.kind,
      task.source ?? "chat",
      task.worker,
      task.title,
      task.status,
      task.summary ?? "",
      task.session,
      now,
      now,
      task.status === "working" ? now : null
    );
    this.#emit();

    return this.get(task.id)!;
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

  /** The task took a step, such as "Reading tasks.ts"; a task that is over takes none. */
  step(id: string, text: string): void {
    const current = this.get(id);
    const line = summarize(text);

    if (!current || !isLive(current.status) || line === "" || current.steps.at(-1)?.text === line) return;
    const steps = [...current.steps, { at: Date.now(), text: line }].slice(-STEPS_KEPT);
    this.#sql.exec("UPDATE ky_tasks SET steps = ? WHERE id = ?", JSON.stringify(steps), id);
    this.update(id, { status: "working" });
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
