import { defineExtension, type Extension, GenerationTask, hook } from "@earendil-works/pi-durable";
import { ROOT_SESSION } from "agents/harness/pi";
import Type from "typebox";
import { decodeOr } from "../../core/decode";

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
  /** When it was archived, hiding it from the list; null while it is in the list. */
  readonly archived_at: number | null;
  /** The chat that opened it with the chats tool (src/chats-tool.ts), and steers it; null when the user opened it. */
  readonly opened_by: string | null;
  /** The request its first message went in by, `chat-create:<opener>:<task>`, so a create run again finds it; null when the user opened it. */
  readonly opened_request: string | null;
};

const SessionOf = Type.Object({ session: Type.String() });

const OpenedBy = Type.Object({ opened_by: Type.Union([Type.String(), Type.Null()]) });

/** Who opened a chat with the chats tool, and by which request. */
export type Opener = { readonly by: string; readonly request: string };

const TITLE_CHARS = 60;

/** A chat's title from its first message: the first line, trimmed to fit the list. */
function titleOf(text: string): string {
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

    const columns = sql.exec<{ name: string }>("PRAGMA table_info(ky_chats)").toArray();

    if (!columns.some((column) => column.name === "archived_at")) {
      sql.exec("ALTER TABLE ky_chats ADD COLUMN archived_at INTEGER");
    }

    // Chats a chat opens came after: a table from before has every chat the user's.
    if (!columns.some((column) => column.name === "opened_by")) {
      sql.exec("ALTER TABLE ky_chats ADD COLUMN opened_by TEXT");
      sql.exec("ALTER TABLE ky_chats ADD COLUMN opened_request TEXT");
    }

    // The main chat is not in the list, but the sidebar shows when it last heard from ky too.
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_main_chat (
      id INTEGER PRIMARY KEY CHECK (id = 1),
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

  /** When ky last answered in the main chat; 0 if it never has. */
  mainUpdatedAt(): number {
    return this.#sql.exec<{ updated_at: number }>("SELECT updated_at FROM ky_main_chat").toArray()[0]?.updated_at ?? 0;
  }

  has(session: string): boolean {
    return this.#sql.exec("SELECT 1 FROM ky_chats WHERE session = ?", session).toArray().length > 0;
  }

  /** The chat `session` is in the list: the user's, or one `opener` opened and steers. */
  add(session: string, opener?: Opener): void {
    const now = Date.now();
    this.#sql.exec(
      "INSERT OR IGNORE INTO ky_chats (session, created_at, updated_at, opened_by, opened_request) VALUES (?, ?, ?, ?, ?)",
      session,
      now,
      now,
      opener?.by ?? null,
      opener?.request ?? null
    );
    this.#emit();
  }

  /** The chat a chats tool create opened by `request`, if one did. */
  openedFor(request: string): string | undefined {
    const row = this.#sql.exec("SELECT session FROM ky_chats WHERE opened_request = ?", request).toArray()[0];

    return decodeOr(SessionOf, row, undefined)?.session;
  }

  /** The chat that opened `session` and steers it; null for the main chat and the user's own. */
  openedBy(session: string): string | null {
    const row = this.#sql.exec("SELECT opened_by FROM ky_chats WHERE session = ?", session).toArray()[0];

    return decodeOr(OpenedBy, row, undefined)?.opened_by ?? null;
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

  /**
   * ky answered in the chat, maybe while the user was elsewhere: an automation's
   * report, a specialist's reply. Move it to the top so the sidebar shows it.
   */
  answered(session: string): void {
    const now = Date.now();

    if (session === ROOT_SESSION) {
      this.#sql.exec("INSERT OR REPLACE INTO ky_main_chat (id, updated_at) VALUES (1, ?)", now);
      this.#emit();

      return;
    }

    const cursor = this.#sql.exec("UPDATE ky_chats SET updated_at = ? WHERE session = ?", now, session);
    cursor.toArray();

    if (cursor.rowsWritten > 0) this.#emit();
  }

  /** Swap the title for a better one, unless it was renamed since `was`. */
  retitle(session: string, was: string, title: string): void {
    const cursor = this.#sql.exec("UPDATE ky_chats SET title = ? WHERE session = ? AND title = ?", title, session, was);
    cursor.toArray();

    if (cursor.rowsWritten > 0) this.#emit();
  }

  /** The user named the chat. A blank name leaves it as it was. */
  rename(session: string, title: string): void {
    const name = titleOf(title);

    if (name === "") return;

    const cursor = this.#sql.exec("UPDATE ky_chats SET title = ? WHERE session = ?", name, session);
    cursor.toArray();

    if (cursor.rowsWritten > 0) this.#emit();
  }

  /** Hide the chat from the list, or put it back. Its transcript stays either way. */
  archive(session: string, archived: boolean): void {
    const cursor = this.#sql.exec(
      "UPDATE ky_chats SET archived_at = ? WHERE session = ?",
      archived ? Date.now() : null,
      session
    );

    cursor.toArray();

    if (cursor.rowsWritten > 0) this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

/** Tells the chat list each time ky finishes an answer in the main chat or a side chat; subagents' are ignored. */
export function chatActivityExtension(chats: ChatList): Extension {
  return defineExtension({
    name: "chat-activity",
    hooks: [
      hook(GenerationTask, {
        onYield(_answer, api) {
          chats.answered(String(api.conversationId));

          return undefined;
        }
      })
    ]
  });
}
