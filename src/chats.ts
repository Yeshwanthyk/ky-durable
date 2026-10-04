/**
 * Side chats: top-level conversations the user starts beside the main one.
 * They are full ky conversations, memory included, so everything learned in
 * one is there in the others. pi owns their transcripts; this only keeps a
 * title and times for the chat list.
 */

export type ChatRow = {
  readonly session: string;
  /** Empty until the first message names it. */
  readonly title: string;
  readonly created_at: number;
  readonly updated_at: number;
};

const TITLE_CHARS = 60;

/** A chat's title from its first message: the first line, trimmed to fit the list. */
export function titleOf(text: string): string {
  const line = text.trim().split("\n").find((part) => part.trim() !== "")?.trim() ?? "";

  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line;
}

export class ChatList {
  readonly #sql: SqlStorage;
  readonly #listeners = new Set<() => void>();
  readonly #namers = new Set<(session: string, text: string) => void>();

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_chats (
      session TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL)`);
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  /** A chat got its first message, so its first-line title can be replaced with a better one. */
  onNamed(listener: (session: string, text: string) => void): () => void {
    this.#namers.add(listener);

    return () => this.#namers.delete(listener);
  }

  list(): ChatRow[] {
    return this.#sql.exec<ChatRow>("SELECT * FROM ky_chats ORDER BY updated_at DESC").toArray();
  }

  has(session: string): boolean {
    return this.#sql.exec("SELECT 1 FROM ky_chats WHERE session = ?", session).toArray().length > 0;
  }

  add(session: string): void {
    const now = Date.now();
    this.#sql.exec(
      "INSERT OR IGNORE INTO ky_chats (session, created_at, updated_at) VALUES (?, ?, ?)",
      session,
      now,
      now
    );
    this.#emit();
  }

  /** A message went to the chat: move it to the top, and name it if it has no name yet. */
  touch(session: string, text: string): void {
    const unnamed = this.#sql
      .exec("SELECT 1 FROM ky_chats WHERE session = ? AND title = ''", session)
      .toArray().length > 0;

    this.#sql.exec(
      "UPDATE ky_chats SET updated_at = ?, title = CASE WHEN title = '' THEN ? ELSE title END WHERE session = ?",
      Date.now(),
      titleOf(text),
      session
    );
    this.#emit();

    if (unnamed && titleOf(text) !== "") for (const namer of this.#namers) namer(session, text);
  }

  /** Swap the title for a better one, unless it was renamed since `was`. */
  retitle(session: string, was: string, title: string): void {
    const cursor = this.#sql.exec("UPDATE ky_chats SET title = ? WHERE session = ? AND title = ?", title, session, was);
    cursor.toArray();

    if (cursor.rowsWritten > 0) this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
