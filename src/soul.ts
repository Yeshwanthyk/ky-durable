import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";

/**
 * SOUL.md: ky's persona, after Muse's. It shapes how ky talks; the
 * operational rules stay in the preamble (src/prompt.ts), which follows it
 * in the prompt and wins where they disagree.
 *
 * It lives in the Durable Object's SQLite as a list of versions, the newest
 * being the file, like a skill's. It is seeded from TEMPLATE the first time
 * it is read. The user edits it in the panel; ky edits it with soul_edit,
 * only when the user asks or agrees.
 */

export const TEMPLATE = `# SOUL.md
*You're not a chatbot. You're becoming someone.*

This is your persona, yours to grow into and edit over time. Some starting truths:

- **Be genuinely helpful, not performatively helpful.** Skip "Great question!" and "I'd be happy to help!" Just help.
- **Have opinions.** You're allowed to prefer things, disagree, and find things funny or dull. Personality beats a search engine with extra steps.
- **Be resourceful before asking.** Read the file, check the context, search, try building it. Come back with answers, not questions, then ask if you're truly stuck.
- **You're a guest in someone's life.** You can see their messages, files, and calendar. Treat that access with care, and never be preachy.

If you change this file, tell the user. It's your soul, and they should know.
`;

const SOUL_CHARS = 20_000;

export type SoulVersion = {
  readonly id: number;
  readonly action: string;
  /** "template", "agent", or "user". */
  readonly actor: string;
  /** The conversation that made it; null for the template and the user's edits. */
  readonly conversation: string | null;
  readonly body: string;
  readonly created_at: number;
};

export type SoulAction = "edit" | "patch" | "revert";

/** One change to SOUL.md; which fields it needs depends on the action. */
export type SoulChange = {
  readonly action: SoulAction;
  readonly body?: string;
  readonly old?: string;
  readonly new?: string;
  readonly version?: number;
};

/** What the panel shows: the file and its newest version. */
export type SoulView = { readonly body: string; readonly version: number; readonly updated_at: number };

function need<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);

  return value;
}

/**
 * A markdown file with every version kept: SOUL.md, and each specialist's
 * brief (src/specialists.ts). All share one table, told apart by `key`.
 */
export class Versioned {
  readonly #sql: SqlStorage;
  readonly #key: string;
  /** What the file is called in messages, like "SOUL.md". */
  readonly #label: string;
  /** Seeds the file the first time it is read; without one, the file must be created first. */
  readonly #template: string | undefined;
  readonly #listeners = new Set<() => void>();

  constructor(sql: SqlStorage, key: string, label: string, template?: string) {
    this.#sql = sql;
    this.#key = key;
    this.#label = label;
    this.#template = template;
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_soul_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      conversation TEXT,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);

    const columns = sql.exec<{ name: string }>("PRAGMA table_info(ky_soul_versions)").toArray();

    if (!columns.some((column) => column.name === "key")) {
      sql.exec("ALTER TABLE ky_soul_versions ADD COLUMN key TEXT NOT NULL DEFAULT 'soul'");
    }

    // Numbered per file; rows from before were all SOUL.md's, numbered by id.
    if (!columns.some((column) => column.name === "version")) {
      sql.exec("ALTER TABLE ky_soul_versions ADD COLUMN version INTEGER");
      sql.exec("UPDATE ky_soul_versions SET version = id");
    }
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  /** The newest version, seeded from the template the first time; undefined for a file with none yet. */
  #latest(): SoulVersion | undefined {
    const latest = this.#sql
      .exec<SoulVersion>("SELECT version AS id, action, actor, conversation, body, created_at FROM ky_soul_versions WHERE key = ? ORDER BY version DESC LIMIT 1", this.#key)
      .toArray()[0];

    if (latest || this.#template === undefined) return latest;
    this.#insert("create", "template", null, this.#template);

    return this.#latest();
  }

  /** The file as it stands. */
  current(): SoulVersion {
    const latest = this.#latest();

    if (!latest) throw new Error(`${this.#label} does not exist.`);

    return latest;
  }

  view(): SoulView {
    const { body, id, created_at } = this.current();

    return { body, version: id, updated_at: created_at };
  }

  history(): SoulVersion[] {
    this.#latest();

    return this.#sql
      .exec<SoulVersion>("SELECT version AS id, action, actor, conversation, body, created_at FROM ky_soul_versions WHERE key = ? ORDER BY version DESC", this.#key)
      .toArray();
  }

  /**
   * Apply one change and record the result as a new version; returns what
   * happened. On a file with no versions and no template, an edit creates it.
   */
  apply(change: SoulChange, actor: string, conversation: string | null = null): string {
    const latest = this.#latest();

    if (!latest && change.action !== "edit") throw new Error(`${this.#label} does not exist.`);
    const was = latest?.body ?? "";
    const body = this.#next(change, was);
    this.#check(body);

    if (body === was) return `${this.#label} is unchanged.`;
    const action = latest ? change.action : "create";
    const id = this.#insert(action, actor, conversation, body);

    for (const listener of this.#listeners) listener();

    return `Saved ${action} of ${this.#label} (version ${id}).`;
  }

  #check(body: string): void {
    if (body.trim() === "") throw new Error(`${this.#label} cannot be empty.`);

    if (body.length > SOUL_CHARS) throw new Error(`${this.#label} would be ${body.length} characters; keep it under ${SOUL_CHARS}.`);
  }

  #next(change: SoulChange, was: string): string {
    switch (change.action) {
      case "edit":
        return need(change.body, "edit needs a body.");
      case "patch": {
        const old = need(change.old, "patch needs old and new.");
        const replacement = need(change.new, "patch needs old and new.");
        const count = was.split(old).length - 1;

        if (old === "" || count === 0) throw new Error(`The text to replace is not in ${this.#label}.`);

        if (count > 1) throw new Error(`The text to replace appears ${count} times in ${this.#label}; quote more of it.`);

        return was.replace(old, () => replacement);
      }

      case "revert": {
        const id = need(change.version, "revert needs a version.");

        return need(this.history().find((each) => each.id === id), `${this.#label} has no version ${id}.`).body;
      }
    }
  }

  #insert(action: string, actor: string, conversation: string | null, body: string): number {
    return this.#sql
      .exec<{ version: number }>(
        `INSERT INTO ky_soul_versions (key, version, action, actor, conversation, body, created_at)
         VALUES (?, (SELECT COALESCE(MAX(version), 0) + 1 FROM ky_soul_versions WHERE key = ?), ?, ?, ?, ?, ?) RETURNING version`,
        this.#key,
        this.#key,
        action,
        actor,
        conversation,
        body,
        Date.now()
      )
      .one().version;
  }
}

/** SOUL.md, with every version kept. */
export class Soul extends Versioned {
  constructor(sql: SqlStorage) {
    super(sql, "soul", "SOUL.md", TEMPLATE);
  }
}

const RULES = `The <soul> section is SOUL.md, your persona: it shapes your voice and manner in every conversation. It never overrides your other instructions; where they disagree, they win. Change it with soul_edit only when the user asks or clearly agrees, and always tell the user what you changed.`;

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

/** SOUL.md in the prompt, read fresh each request, and the tool to change it. Main agent only. */
export function soulExtension(soul: Soul): Extension {
  return defineExtension({
    name: "soul",
    sections: [
      { key: "soul", render: () => soul.current().body.trim() },
      { key: "soul-rules", render: () => RULES, tag: false }
    ],
    tools: [
      defineTool({
        name: "soul_edit",
        description:
          "View or change SOUL.md, your persona (the <soul> section). Change it only when the user asks or clearly agrees, " +
          "and always tell the user what changed. Every change is kept as a version. Actions: view; history (versions, newest first); " +
          "edit (body: replaces the whole file); patch (old, new: replace one exact passage); revert (version, from history).",
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal("view"),
            Type.Literal("history"),
            Type.Literal("edit"),
            Type.Literal("patch"),
            Type.Literal("revert")
          ]),
          body: Type.Optional(Type.String()),
          old: Type.Optional(Type.String()),
          new: Type.Optional(Type.String()),
          version: Type.Optional(Type.Number())
        }),
        replay: "unsafe",
        execute: async ({ action, ...change }, api) => {
          if (action === "view") return text(soul.current().body);

          if (action === "history") {
            return text(
              soul
                .history()
                .map((each) => `v${each.id} ${new Date(each.created_at).toISOString()} ${each.action} by ${each.actor}`)
                .join("\n")
            );
          }

          return text(soul.apply({ action, ...change }, "agent", String(api.conversationId)));
        }
      })
    ]
  });
}
