import Type, { type Static } from "typebox";
import { decodeOr } from "../../../../src/core/decode.ts";
import { must } from "../../../../src/core/must.ts";
import type { LegacySql, Row } from "./rows";

const SoulVersionSchema = Type.Object({
  id: Type.Integer(),
  action: Type.String(),
  actor: Type.String(),
  conversation: Type.Union([Type.String(), Type.Null()]),
  body: Type.String(),
  created_at: Type.Number()
});

type SoulVersion = Static<typeof SoulVersionSchema>;

const SoulActionSchema = Type.Union([Type.Literal("edit"), Type.Literal("patch"), Type.Literal("revert")]);

const SoulChangeSchema = Type.Object({
  action: SoulActionSchema,
  body: Type.Optional(Type.String()),
  old: Type.Optional(Type.String()),
  new: Type.Optional(Type.String()),
  version: Type.Optional(Type.Number())
});

type SoulChange = Static<typeof SoulChangeSchema>;

const ColumnRow = Type.Object({ name: Type.String() });

const VersionRow = Type.Object({ version: Type.Integer() });

const soulVersion = (row: Row): SoulVersion | undefined => decodeOr(SoulVersionSchema, row, undefined);

const columnName = (row: Row): string => decodeOr(ColumnRow, row, { name: "" }).name;

const versionOf = (row: Row): number => decodeOr(VersionRow, row, { version: 0 }).version;

const SOUL_CHARS = 20_000;

export class LegacyVersioned {
  readonly #sql: LegacySql;
  readonly #key: string;
  readonly #label: string;
  readonly #template: string | undefined;
  readonly #listeners = new Set<() => void>();

  constructor(sql: LegacySql, key: string, label: string, template?: string) {
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

    if (!columns.includes("version")) {
      sql.exec("ALTER TABLE ky_soul_versions ADD COLUMN version INTEGER");
      sql.exec("UPDATE ky_soul_versions SET version = id");
    }
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  #latest(): SoulVersion | undefined {
    const latest = this.#versions(1)[0] ?? this.#versions()[0];

    if (latest || this.#template === undefined) return latest;
    this.#insert("create", "template", null, this.#template);

    return this.#latest();
  }

  current(): SoulVersion {
    const latest = this.#latest();

    if (!latest) throw new Error(`${this.#label} does not exist.`);

    return latest;
  }

  history(): SoulVersion[] {
    this.#latest();

    return this.#versions();
  }

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
