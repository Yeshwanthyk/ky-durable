/**
 * The task feed: one row per piece of delegated work, cloud subagent or
 * machine run, with a title, a status and a one-line summary. It is what
 * the UI's task list shows, and what the main agent's `status` reads.
 */

export type TaskKind = "cloud" | "machine";

export type TaskStatus = "queued" | "working" | "done" | "failed" | "stopped";

export type TaskRow = {
  readonly id: string;
  readonly kind: TaskKind;
  /** The subagent's name, or the machine a run is placed on. */
  readonly worker: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly summary: string;
  /** Cloud: the pi session to open. Machine: the Claude Code session id. */
  readonly session: string | null;
  readonly created_at: number;
  readonly updated_at: number;
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

  list(limit = 100): TaskRow[] {
    return this.#sql
      .exec<TaskRow>("SELECT * FROM ky_tasks ORDER BY updated_at DESC LIMIT ?", limit)
      .toArray();
  }

  get(id: string): TaskRow | undefined {
    return this.#sql.exec<TaskRow>("SELECT * FROM ky_tasks WHERE id = ?", id).toArray()[0];
  }

  /** The newest task a worker has, for `send`/`stop` by name. */
  latest(kind: TaskKind, worker: string): TaskRow | undefined {
    return this.#sql
      .exec<TaskRow>(
        "SELECT * FROM ky_tasks WHERE kind = ? AND worker = ? ORDER BY created_at DESC LIMIT 1",
        kind,
        worker
      )
      .toArray()[0];
  }

  /** Insert the task, or leave an existing one alone: ids are idempotency keys. */
  create(task: Omit<TaskRow, "created_at" | "updated_at" | "summary"> & { summary?: string }): TaskRow {
    const now = Date.now();
    this.#sql.exec(
      `INSERT OR IGNORE INTO ky_tasks
        (id, kind, worker, title, status, summary, session, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      task.id,
      task.kind,
      task.worker,
      task.title,
      task.status,
      task.summary ?? "",
      task.session,
      now,
      now
    );
    this.#emit();

    return this.get(task.id)!;
  }

  update(id: string, patch: TaskPatch): void {
    const current = this.get(id);

    if (!current) return;
    const next = { ...current, ...patch };
    this.#sql.exec(
      "UPDATE ky_tasks SET title = ?, status = ?, summary = ?, session = ?, updated_at = ? WHERE id = ?",
      next.title,
      next.status,
      next.summary,
      next.session,
      Date.now(),
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
