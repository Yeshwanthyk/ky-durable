import { countOf } from "./contract";

/**
 * When the user was last here: they sent a chat a message. A browser that
 * connects does not count, since an open tab reconnects at night by itself. The dream waits until they have been away a while
 * (src/dreaming/dreaming.ts), so it never tends the library mid-conversation.
 */
export class Presence {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_presence (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      at INTEGER NOT NULL)`);
  }

  /** The user is here now. */
  seen(at = Date.now()): void {
    this.#sql.exec("INSERT OR REPLACE INTO ky_presence (id, at) VALUES (1, ?)", at);
  }

  /** When the user was last here; 0 if never, or when a restore damaged it. */
  last(): number {
    return countOf(this.#sql.exec("SELECT at AS n FROM ky_presence WHERE id = 1").toArray()[0]);
  }
}
