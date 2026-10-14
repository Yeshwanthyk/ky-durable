/**
 * Versioned markdown files: SOUL.md and each specialist's brief, every version kept in one table
 * (ky_soul_versions) and told apart by key. A leaf, so contract.ts re-exports it and specialists use it
 * without loading the rest of the dreaming domain.
 */
import Type, { type Static } from "typebox";
import { decodeOr } from "../core/decode";
import { must } from "../core/must";

/** A row as `sql.exec` returns it, or none: what the decoders below check. */
type Row = Readonly<Record<string, SqlStorageValue>> | undefined;

const SoulVersionSchema = Type.Object({
  id: Type.Integer(),
  action: Type.String(),
  /** "template", "agent", or "user". */
  actor: Type.String(),
  /** The conversation that made it; null for the template and the user's edits. */
  conversation: Type.Union([Type.String(), Type.Null()]),
  body: Type.String(),
  created_at: Type.Number()
});

export type SoulVersion = Static<typeof SoulVersionSchema>;

const SoulActionSchema = Type.Union([Type.Literal("edit"), Type.Literal("patch"), Type.Literal("revert")]);

/** One change to SOUL.md; which fields it needs depends on the action. */
export const SoulChangeSchema = Type.Object({
  action: SoulActionSchema,
  body: Type.Optional(Type.String()),
  old: Type.Optional(Type.String()),
  new: Type.Optional(Type.String()),
  version: Type.Optional(Type.Number())
});

export type SoulChange = Static<typeof SoulChangeSchema>;

/** What the panel shows: the file and its newest version. */
const SoulViewSchema = Type.Object({ body: Type.String(), version: Type.Integer(), updated_at: Type.Number() });

export type SoulView = Static<typeof SoulViewSchema>;

const ColumnRow = Type.Object({ name: Type.String() });

const VersionRow = Type.Object({ version: Type.Integer() });

/** A version row as stored, or undefined when a restore left it damaged: callers skip it. */
export const soulVersion = (row: Row): SoulVersion | undefined => decodeOr(SoulVersionSchema, row, undefined);

/** A PRAGMA table_info row's column name; "" when it isn't one. */
export const columnName = (row: Row): string => decodeOr(ColumnRow, row, { name: "" }).name;

/** The version an insert returned; 0 when it isn't one. */
export const versionOf = (row: Row): number => decodeOr(VersionRow, row, { version: 0 }).version;

const SOUL_CHARS = 20_000;

/**
 * A markdown file with every version kept: SOUL.md, and each specialist's
 * brief (src/skills/specialists.ts). All share one table, told apart by `key`.
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

    const columns = sql.exec("PRAGMA table_info(ky_soul_versions)").toArray().map(columnName);

    if (!columns.includes("key")) {
      sql.exec("ALTER TABLE ky_soul_versions ADD COLUMN key TEXT NOT NULL DEFAULT 'soul'");
    }

    // Numbered per file; rows from before were all SOUL.md's, numbered by id.
    if (!columns.includes("version")) {
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
    // A damaged newest version (after a restore) hides behind the last good one rather than failing every read.
    const latest = this.#versions(1)[0] ?? this.#versions()[0];

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

    return this.#versions();
  }

  /** This file's newest `limit` versions, newest first, leaving out any a restore damaged. Read whole, so no cursor stays open. */
  #versions(limit = -1): SoulVersion[] {
    return this.#sql
      .exec(
        "SELECT version AS id, action, actor, conversation, body, created_at FROM ky_soul_versions WHERE key = ? ORDER BY version DESC LIMIT ?",
        this.#key,
        limit
      )
      .toArray()
      .flatMap((row) => soulVersion(row) ?? []);
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
        return must(change.body, "edit needs a body.");
      case "patch": {
        const old = must(change.old, "patch needs old and new.");
        const replacement = must(change.new, "patch needs old and new.");
        const count = was.split(old).length - 1;

        if (old === "" || count === 0) throw new Error(`The text to replace is not in ${this.#label}.`);

        if (count > 1) throw new Error(`The text to replace appears ${count} times in ${this.#label}; quote more of it.`);

        return was.replace(old, () => replacement);
      }

      case "revert": {
        const id = must(change.version, "revert needs a version.");

        return must(this.history().find((each) => each.id === id), `${this.#label} has no version ${id}.`).body;
      }
    }
  }

  #insert(action: string, actor: string, conversation: string | null, body: string): number {
    const inserted = this.#sql.exec(
      `INSERT INTO ky_soul_versions (key, version, action, actor, conversation, body, created_at)
       VALUES (?, (SELECT COALESCE(MAX(version), 0) + 1 FROM ky_soul_versions WHERE key = ?), ?, ?, ?, ?, ?) RETURNING version`,
      this.#key,
      this.#key,
      action,
      actor,
      conversation,
      body,
      Date.now()
    );

    return versionOf(inserted.one());
  }
}

/** One line of a file's history, for the agent. */
export const versionLine = (each: SoulVersion) => `v${each.id} ${new Date(each.created_at).toISOString()} ${each.action} by ${each.actor}`;
