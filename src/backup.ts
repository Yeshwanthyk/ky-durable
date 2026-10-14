import { ROOT_SESSION } from "agents/harness/pi";
import Type from "typebox";
import { Value } from "typebox/value";
import {
  type ArchivedFile,
  type Cell,
  END,
  type End,
  FORMAT,
  FORMAT_VERSION,
  isUploadKey,
  type LeftOut,
  MANIFEST,
  type Manifest,
  parsed,
  partPath,
  type Restored,
  RestoreFinishSchema,
  RestoreStartSchema,
  RowSchema,
  type Schemas,
  type Summary,
  type TableDump,
  tarEnd,
  tarEntry,
  tarHeader,
  tarPadding
} from "./archive";
import { saveKey } from "./sandboxes";
import { fromBase64, toBase64 } from "./machines/contract";
import type { SecretStatus } from "./vault";

/**
 * `ky backup` and `ky restore` (B1). Only the Worker can read the agent's
 * SQLite, so the agent dumps it here, table by table, and the Worker streams
 * it with the bucket's uploads as one archive (src/archive.ts). A restore
 * goes the other way, in steps the CLI drives: start, upload the files and
 * the rows, which the agent keeps aside in staging tables, then finish, which
 * swaps every table in one transaction and restarts the agent, so nothing it
 * held in memory outlives the swap.
 *
 * Every table is copied, those added later included, but for SKIPPED and
 * SQLite's own: what is tied to this deploy, like machine pairings, and what
 * is rebuilt, like chat search. No secret is ever in the agent's SQLite; they
 * are all the Vault's, which is never copied, so the manifest lists the ones
 * there were, for the owner to add again.
 */

/** Tables an archive leaves out, by name or `prefix*`, and why. */
const SKIPPED: ReadonlyArray<readonly [string, string]> = [
  ["ky_machine*", "machine pairings and their runs: each machine pairs again with the new deploy"],
  ["ky_providers", "model providers: their keys are in the Vault; a provider comes back when its key is added"],
  ["ky_history*", "chat search: rebuilt from the chats on restore"],
  ["cf_agents_jobs", "scheduled runs: automations and dreams are booked again on start"],
  ["computer_execution_runtime", "the workspace's sandboxes: started fresh"],
  ["ky_restore*", "a restore in progress"]
];

/** SQLite's and the runtime's own tables, which nothing copies. */
const isSystem = (name: string) => name.startsWith("sqlite_") || name.startsWith("_cf_");

const isIdentifier = (name: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);

function skipped(name: string): string | undefined {
  return SKIPPED.find(([pattern]) => (pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern))?.[1];
}

/** Whether a backup's table may be restored: a plain table of ky's, not SQLite's, a skipped one or a virtual table's. */
const restorable = (name: string, found: { virtual: boolean } | undefined) => isIdentifier(name) && !isSystem(name) && !skipped(name) && !found?.virtual;

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Rows read per query while dumping. */
const PAGE_ROWS = 256;

/** About how many characters of NDJSON one part holds; a row bigger than this is a part of its own. */
const PART_CHARS = 4 * 1024 * 1024;

/** Integers past this don't survive a JS number, so they are dumped as text. */
const SAFE = Number.MAX_SAFE_INTEGER;

/** A table as the dump reads it: its columns, and what orders its rows. */
type Dumping = TableDump & { readonly key: readonly string[] };

/** A restore in progress, as begin left it. */
type Started = { readonly tables: TableDump[]; readonly rows: Record<string, number>; readonly leftOut: LeftOut[] };

/** What finish swapped in. */
type Finished = { readonly rows: number; readonly leftOut: LeftOut[] };

const Numeric = Type.Number();

const Text = Type.String();

/** One part of a table's rows, and where the next starts; null once the table is done. */
export type Page = { readonly text: string; readonly rows: number; readonly after: SqlStorageValue[] | null };

/** What the agent says about itself for the manifest; the Worker adds the bucket and the Vault. */
export type Plan = Pick<Manifest, "tables" | "skipped" | "schemas" | "unfinished"> & {
  readonly summary: Omit<Summary, "uploads" | "uploadBytes">;
  /** The computers to pair again: every listed machine but the sandboxes. */
  readonly machines: readonly string[];
  /** Every sandbox, and whether it is a kept disk, for the saved disks a backup leaves out. */
  readonly sandboxes: readonly { readonly id: string; readonly name: string; readonly kept: boolean }[];
};

/**
 * A value as JSON, by the kind the dump's query read it as: SQLite's typeof,
 * or `bigint` for an integer past SAFE, which the query reads as text.
 */
function cell(value: SqlStorageValue, kind: SqlStorageValue): Cell {
  switch (kind) {
    case "blob":
      // SAFETY: SQLite said it is a blob, which the runtime returns as an ArrayBuffer.
      return { $blob: toBase64(new Uint8Array(value as ArrayBuffer)) };
    case "bigint":
      // SAFETY: the query reads an integer past SAFE as text.
      return { $int: value as string };
    case "real": {
      // SAFETY: SQLite said it is a real, which the runtime returns as a number.
      const real = value as number;

      if (!Number.isFinite(real)) return { $real: real > 0 ? "9e999" : "-9e999" };

      return Number.isInteger(real) ? { $real: String(real) } : real;
    }

    default:
      // SAFETY: what's left is SQLite's null, a safe integer or text, which the runtime returns as null, a number or a string.
      return value as number | string | null;
  }
}

/** A cell as SQL to insert: the placeholder, cast where JSON loses the type, and what to bind. */
function placeholder(value: Cell): [string, SqlStorageValue[]] {
  if (value === null) return ["NULL", []];

  if (Value.Check(Numeric, value)) return [Number.isInteger(value) ? "CAST(? AS INTEGER)" : "?", [value]];

  if (Value.Check(Text, value)) return ["?", [value]];

  if ("$blob" in value) return ["?", [fromBase64(value.$blob).buffer]];

  if ("$int" in value) return ["CAST(? AS INTEGER)", [value.$int]];

  return ["CAST(? AS REAL)", [value.$real]];
}

/**
 * The dump's select list: each column as its value, an integer past SAFE as
 * text, then the kind cell() reads it by.
 */
function selectCells(dumping: Dumping): string {
  return (dumping.rowid ? ["rowid", ...dumping.columns] : dumping.columns)
    .map((column) => {
      const name = column === "rowid" ? "rowid" : quote(column);
      const big = `typeof(${name}) = 'integer' AND (${name} > ${SAFE} OR ${name} < -${SAFE})`;

      return `CASE WHEN ${big} THEN CAST(${name} AS TEXT) ELSE ${name} END, CASE WHEN ${big} THEN 'bigint' ELSE typeof(${name}) END`;
    })
    .join(", ");
}

/** A row the dump's select read, value and kind by turns, as cells. */
function rowCells(values: readonly SqlStorageValue[]): Cell[] {
  const line: Cell[] = [];

  for (let at = 0; at < values.length; at += 2) line.push(cell(values[at]!, values[at + 1]!));

  return line;
}

const staging = (table: string) => `ky_restore__${table}`;

/** The agent's half: the dump, and the staged restore. */
export class Backups {
  readonly #storage: DurableObjectStorage;
  readonly #sql: SqlStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
    this.#sql = storage.sql;
  }

  #scalar(query: string, ...bindings: SqlStorageValue[]): number | null {
    try {
      const value = this.#sql.exec(query, ...bindings).raw().next().value?.[0];

      return Value.Check(Numeric, value) ? value : null;
    } catch {
      // The table isn't there.
      return null;
    }
  }

  #schemas(): Schemas {
    return {
      pi: this.#scalar("SELECT version FROM pi_durable_schema"),
      workspace: this.#scalar("SELECT v FROM vfs_meta WHERE k = 'schema_version'")
    };
  }

  /** Every table, with the virtual ones and their own tables told apart. */
  #tables(): Array<{ name: string; sql: string; virtual: boolean }> {
    const all = this.#sql
      .exec<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .toArray()
      .filter((table) => !isSystem(table.name));

    const virtual = all.filter((table) => /^CREATE VIRTUAL TABLE/i.test(table.sql)).map((table) => table.name);

    return all.map((table) => ({ ...table, virtual: virtual.some((name) => table.name === name || table.name.startsWith(`${name}_`)) }));
  }

  #dumping(name: string, sql: string): Dumping {
    const info = this.#sql.exec<{ name: string; type: string; pk: number }>(`PRAGMA table_info(${quote(name)})`).toArray();
    const columns = info.map((column) => column.name);
    const primary = info.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);
    const withoutRowid = /\)\s*WITHOUT\s+ROWID\s*$/i.test(sql);
    // An INTEGER PRIMARY KEY column is the rowid itself.
    const aliased = primary.length === 1 && primary[0]!.type.toUpperCase() === "INTEGER";

    const indexes = this.#sql
      .exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name", name)
      .toArray()
      .map((index) => index.sql);

    return {
      name,
      sql,
      indexes,
      columns,
      rowid: !withoutRowid && !aliased,
      sequence: this.#scalar("SELECT seq FROM sqlite_sequence WHERE name = ?", name),
      key: withoutRowid ? primary.map((column) => column.name) : ["rowid"]
    };
  }

  plan(): Plan {
    const tables: Dumping[] = [];
    const left: Record<string, string> = {};

    for (const table of this.#tables()) {
      const why = skipped(table.name) ?? (table.virtual ? "a virtual table's index: rebuilt on restore" : undefined);

      if (why) left[table.name] = why;
      else tables.push(this.#dumping(table.name, table.sql));
    }

    const count = (query: string) => this.#scalar(query) ?? 0;
    const chats = this.#sql.exec<{ session: string }>("SELECT session FROM ky_chats").toArray().map((chat) => chat.session);

    return {
      tables: tables.map(({ key: _key, ...table }) => table),
      skipped: left,
      schemas: this.#schemas(),
      unfinished: count("SELECT count(*) FROM pi_tasks WHERE status != 'terminal'"),
      summary: {
        chats: chats.length + 1,
        messages: this.#scalar(
          `SELECT count(*) FROM pi_entries WHERE json_extract(record, '$.kind') IN ('pi.user', 'pi.assistant')
             AND CAST(conversation_id AS TEXT) IN (SELECT value FROM json_each(?))`,
          JSON.stringify([ROOT_SESSION, ...chats])
        ) ?? 0,
        notes: count("SELECT count(*) FROM memo_log"),
        skills: count("SELECT count(*) FROM ky_skills"),
        specialists: count("SELECT count(*) FROM ky_specialists"),
        automations: count("SELECT count(*) FROM ky_automations"),
        workspaceFiles: count("SELECT count(*) FROM vfs_nodes WHERE type = 'file'")
      },
      machines: this.#sql
        .exec<{ name: string }>("SELECT name FROM ky_machines WHERE name NOT IN (SELECT name FROM ky_sandboxes WHERE deleted_at IS NULL) ORDER BY name")
        .toArray()
        .map((machine) => machine.name),
      sandboxes: this.#sql
        .exec<{ id: string; name: string; kept: number }>("SELECT id, name, deleted_at IS NOT NULL AS kept FROM ky_sandboxes ORDER BY kept, name")
        .toArray()
        .map((sandbox) => ({ id: sandbox.id, name: sandbox.name, kept: sandbox.kept === 1 }))
    };
  }

  /** The next part of `table`'s rows, after the row whose key is `after`. */
  rows(table: string, after: SqlStorageValue[] | null): Page {
    const found = this.#tables().find((each) => each.name === table);

    if (!found || found.virtual || skipped(table)) throw new Error(`No table ${table} to back up.`);
    const dumping = this.#dumping(found.name, found.sql);
    const keys = dumping.key.map(quote).join(", ");
    const cells = selectCells(dumping);
    let text = "";
    let rows = 0;
    let last = after;

    while (text.length < PART_CHARS) {
      const where = last === null ? "" : `WHERE (${keys}) > (${last.map(() => "?").join(", ")})`;

      const page = Array.from(
        this.#sql.exec(`SELECT ${keys}, ${cells} FROM ${quote(table)} ${where} ORDER BY ${keys} LIMIT ${PAGE_ROWS}`, ...(last ?? [])).raw()
      );

      for (const row of page) text += `${JSON.stringify(rowCells(row.slice(dumping.key.length)))}\n`;
      rows += page.length;

      if (page.length < PAGE_ROWS) return { text, rows, after: null };
      last = page.at(-1)!.slice(0, dumping.key.length);
    }

    return { text, rows, after: last };
  }

  /** Whether this ky has been used: a side chat, a note, or a message from the user. */
  lived(): boolean {
    return (
      (this.#scalar(
        `SELECT (SELECT count(*) FROM ky_chats) + (SELECT count(*) FROM memo_log)
           + (SELECT count(*) FROM pi_entries WHERE json_extract(record, '$.kind') = 'pi.user')`
      ) ?? 0) > 0
    );
  }

  #refuseLived(force: boolean): void {
    if (!force && this.lived()) {
      throw new Error("This ky already has chats or memory, which a restore replaces. Restore into a fresh ky, or pass --force to replace them.");
    }
  }

  /** Start a restore of `manifest`: check it fits this ky, and make a staging table for each of its tables. */
  begin(manifest: Manifest, end: End, force: boolean): void {
    if (manifest.format !== FORMAT || manifest.version > FORMAT_VERSION) throw new Error("This ky can't read that backup's format.");
    this.#refuseLived(force);
    this.#checkSchemas(manifest.schemas);
    const existing = new Map(this.#tables().map((table) => [table.name, table]));

    for (const table of manifest.tables) this.#checkTable(table, existing.get(table.name));

    this.#sql.exec("CREATE TABLE IF NOT EXISTS ky_restore (id INTEGER PRIMARY KEY CHECK (id = 1), tables TEXT NOT NULL, rows TEXT NOT NULL, left_out TEXT NOT NULL)");
    this.#sql.exec("CREATE TABLE IF NOT EXISTS ky_restore_files (key TEXT PRIMARY KEY, size INTEGER NOT NULL, type TEXT)");
    this.#drop();

    for (const table of manifest.tables) {
      const columns = [...(table.rowid ? ["rowid"] : []), ...table.columns].map((_, at) => `c${at}`);
      this.#sql.exec(`CREATE TABLE ${quote(staging(table.name))} (${columns.join(", ")})`);
    }

    for (const file of manifest.files) {
      if (!isUploadKey(file.key)) throw new Error(`The backup has a file ky doesn't restore: ${file.key}`);
      this.#sql.exec("INSERT INTO ky_restore_files (key, size, type) VALUES (?, ?, ?)", file.key, file.size, file.type);
    }

    this.#sql.exec(
      "INSERT INTO ky_restore (id, tables, rows, left_out) VALUES (1, ?, ?, ?)",
      JSON.stringify(manifest.tables),
      JSON.stringify(end.rows),
      JSON.stringify(manifest.leftOut)
    );
  }

  /** Refuse a backup whose pi or workspace tables are another version than this ky's. */
  #checkSchemas(theirs: Schemas): void {
    const here = this.#schemas();

    for (const library of ["pi", "workspace"] as const) {
      if (theirs[library] !== null && here[library] !== null && theirs[library] !== here[library]) {
        throw new Error(`The backup's ${library} tables are version ${theirs[library]}, this ky's ${here[library]}: restore into a ky on the release the backup came from.`);
      }
    }
  }

  /** Refuse a table ky doesn't restore, or one with columns this ky's lacks. */
  #checkTable(table: TableDump, found: { name: string; sql: string; virtual: boolean } | undefined): void {
    if (!restorable(table.name, found)) throw new Error(`The backup has a table ky doesn't restore: ${table.name}`);

    if (!table.columns.every(isIdentifier)) throw new Error(`The backup's ${table.name} has a column ky can't name.`);

    if (!found) {
      if (!new RegExp(`^CREATE TABLE "?${table.name}"?\\s*\\(`, "i").test(table.sql)) throw new Error(`The backup's ${table.name} is not a plain table.`);

      return;
    }

    const have = this.#dumping(found.name, found.sql).columns;
    const missing = table.columns.filter((column) => !have.includes(column));

    if (missing.length > 0) throw new Error(`This ky's ${table.name} has no ${missing.join(", ")}: restore into a ky on the release the backup came from.`);
  }

  /** Forget a restore: its staging tables, and what it expects. */
  #drop(): void {
    for (const { name } of this.#sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ky\\_restore\\_\\_%' ESCAPE '\\'").toArray()) {
      this.#sql.exec(`DROP TABLE ${quote(name)}`);
    }

    this.#sql.exec("DELETE FROM ky_restore");
    this.#sql.exec("DELETE FROM ky_restore_files");
  }

  #started(): Started {
    const row = this.#sql.exec<{ tables: string; rows: string; left_out: string }>("SELECT tables, rows, left_out FROM ky_restore").toArray()[0];

    if (!row) throw new Error("No restore is in progress: start it again.");

    return { tables: JSON.parse(row.tables), rows: JSON.parse(row.rows), leftOut: JSON.parse(row.left_out) };
  }

  /** Put every staged table in place of the live one; `existing` are the tables this ky has. */
  #swap(tables: readonly TableDump[], existing: ReadonlySet<string>): void {
    // Rows reference each other across tables; check that once, when all are in.
    this.#sql.exec("PRAGMA defer_foreign_keys = ON");

    for (const table of tables.filter((each) => !existing.has(each.name))) {
      this.#sql.exec(table.sql);

      for (const index of table.indexes) this.#sql.exec(index);
    }

    // Empty every table before filling any, so no cascade deletes rows already restored.
    for (const table of tables) this.#sql.exec(`DELETE FROM ${quote(table.name)}`);

    for (const table of tables) {
      const columns = [...(table.rowid ? ["rowid"] : []), ...table.columns.map(quote)];
      const from = columns.map((_, at) => `c${at}`);
      this.#sql.exec(`INSERT INTO ${quote(table.name)} (${columns.join(", ")}) SELECT ${from.join(", ")} FROM ${quote(staging(table.name))} ORDER BY rowid`);

      if (table.sequence !== null) this.#keepSequence(table.name, table.sequence);
    }
  }

  /** The table's AUTOINCREMENT counter, at least `sequence`, so no id a deleted row had is used again. */
  #keepSequence(table: string, sequence: number): void {
    const updated = this.#sql.exec("UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = ?", sequence, table).rowsWritten;

    if (updated === 0) this.#sql.exec("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)", table, sequence);
  }

  /** The upload at `key` the restore expects, with its size and type. */
  file(key: string): ArchivedFile | undefined {
    this.#started();

    return this.#sql.exec<ArchivedFile>("SELECT key, size, type FROM ky_restore_files WHERE key = ?", key).toArray()[0];
  }

  files(): ArchivedFile[] {
    return this.#sql.exec<ArchivedFile>("SELECT key, size, type FROM ky_restore_files ORDER BY key").toArray();
  }

  /** Keep one part of `table`'s rows aside; returns how many. */
  stage(table: string, text: string): number {
    const dump = this.#started().tables.find((each) => each.name === table);

    if (!dump) throw new Error(`The backup has no table ${table}.`);
    const width = dump.columns.length + (dump.rowid ? 1 : 0);
    const columns = Array.from({ length: width }, (_, at) => `c${at}`).join(", ");
    let rows = 0;

    for (const line of text.split("\n")) {
      if (line === "") continue;
      const values = parsed(RowSchema, line, `A row of ${table}`);

      if (values.length !== width) throw new Error(`A row of ${table} has the wrong number of values.`);
      const cells = values.map(placeholder);
      this.#sql.exec(
        `INSERT INTO ${quote(staging(table))} (${columns}) VALUES (${cells.map(([sql]) => sql).join(", ")})`,
        ...cells.flatMap(([, bindings]) => bindings)
      );
      rows++;
    }

    return rows;
  }

  /**
   * Swap the staged rows in, every table at once, then `after` in the same
   * transaction; returns how many rows. Refuses unless every row arrived.
   */
  finish(force: boolean, after: () => void): Finished {
    const { tables, rows: expected, leftOut } = this.#started();
    this.#refuseLived(force);

    for (const table of tables) {
      const staged = this.#scalar(`SELECT count(*) FROM ${quote(staging(table.name))}`) ?? 0;

      if (staged !== (expected[table.name] ?? 0)) {
        throw new Error(`${table.name} has ${staged} of its ${expected[table.name]} rows: the upload was cut off. Run the restore again.`);
      }
    }

    const existing = new Set(this.#tables().map((table) => table.name));

    this.#storage.transactionSync(() => {
      this.#swap(tables, existing);
      this.#drop();
      after();
    });

    const rows = tables.reduce((total, table) => total + (expected[table.name] ?? 0), 0);

    return { rows, leftOut };
  }
}

/** What the Worker needs of the agent; the tests restore into an agent other than "me". */
export type BackupAgent = Pick<
  DurableObjectStub<import("./server").PiAgent>,
  "backupPlan" | "backupRows" | "restoreBegin" | "restoreFile" | "restoreFiles" | "restoreRows" | "restoreFinish" | "restart"
>;

const encoder = new TextEncoder();

/** What the Vault holds, as things to add again: never a value, only which. */
function secretsLeftOut(secrets: readonly SecretStatus[]): LeftOut[] {
  const why = "secrets stay in the Vault of the deploy they were added to";

  return secrets.map(({ kind, id, meta }) => {
    switch (kind) {
      case "provider":
        return { what: `API key for ${id}`, why, next: "add it again in Settings, under Models" };
      case "claude":
        return { what: "Claude subscription sign-in", why, next: "sign in to Claude again in Settings" };
      case "chatgpt":
        return { what: "ChatGPT subscription sign-in", why, next: "sign in to ChatGPT again in Settings" };
      case "github":
        return { what: "GitHub token", why, next: "connect GitHub again in Settings" };
      case "executor": {
        const url = meta?.url;

        return { what: `Executor connection${Value.Check(Text, url) ? ` (${url})` : ""}`, why, next: "connect Executor again in Settings" };
      }

      default:
        return { what: `${kind} secret ${id}`, why };
    }
  });
}

/** The uploads in the bucket: `files/<id>`, each with its size and type. */
async function uploads(bucket: R2Bucket): Promise<ArchivedFile[]> {
  const found: ArchivedFile[] = [];
  let cursor: string | undefined;

  do {
    const page = await bucket.list({ prefix: "files/", cursor, include: ["httpMetadata"] });

    for (const object of page.objects) {
      if (isUploadKey(object.key)) found.push({ key: object.key, size: object.size, type: object.httpMetadata?.contentType ?? null });
    }

    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return found;
}

/** The archive's tar, a chunk at a time: the manifest, each table's parts, each upload, then the end. */
async function* archive(env: Env, target: BackupAgent, manifest: Manifest): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  yield* tarEntry(MANIFEST, encoder.encode(JSON.stringify(manifest, null, 1)));
  const rows: Record<string, number> = {};

  for (const table of manifest.tables) {
    let after: SqlStorageValue[] | null = null;
    let part = 0;
    let count = 0;

    do {
      const page: Page = await target.backupRows(table.name, after);

      if (page.rows > 0) {
        yield* tarEntry(partPath(table.name, part++), encoder.encode(page.text));
        count += page.rows;
      }

      after = page.after;
    } while (after !== null);

    rows[table.name] = count;
  }

  for (const file of manifest.files) {
    const object = await env.FILES.get(file.key);

    if (!object || object.size !== file.size) throw new Error(`${file.key} changed while it was being backed up.`);
    yield tarHeader(file.key, file.size);
    const reader = object.body.getReader();

    for (let read = await reader.read(); !read.done; read = await reader.read()) yield read.value;
    yield tarPadding(file.size);
  }

  yield* tarEntry(END, encoder.encode(JSON.stringify({ rows, files: manifest.files.length } satisfies End)));
  yield tarEnd();
}

/** GET /api/backup: everything, as one gzipped tar. */
async function backup(env: Env, target: BackupAgent, origin: string): Promise<Response> {
  const plan = await target.backupPlan();
  const files = await uploads(env.FILES);
  const saved = (await Promise.all(plan.sandboxes.map(async (sandbox) => ((await env.FILES.head(saveKey(sandbox.id))) ? [sandbox] : [])))).flat();

  const leftOut: LeftOut[] = [
    ...secretsLeftOut(await env.Vault.getByName("owner").status()),
    ...plan.machines.map((machine) => ({
      what: `Machine ${machine}`,
      why: "a pairing's token is the old deploy's",
      next: `pair it again: on ${machine}, \`ky runner add <ky url> <code>\` with a code from Settings`
    })),
    ...saved.map((sandbox) =>
      sandbox.kept
        ? { what: `The kept disk of ${sandbox.name}`, why: "it is the old deploy's container", next: "a sandbox started from it starts with a fresh disk" }
        : { what: `Sandbox ${sandbox.name}'s saved disk`, why: "it is the old deploy's container", next: `${sandbox.name} starts with a fresh disk` }
    )
  ];

  const manifest: Manifest = {
    format: FORMAT,
    version: FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    source: { origin, worker: env.CF_VERSION_METADATA?.id ?? null },
    schemas: plan.schemas,
    tables: plan.tables,
    skipped: plan.skipped,
    files,
    leftOut,
    summary: { ...plan.summary, uploads: files.length, uploadBytes: files.reduce((total, file) => total + file.size, 0) },
    unfinished: plan.unfinished
  };

  const chunks = archive(env, target, manifest);

  const tar = new ReadableStream<BufferSource>({
    async pull(controller) {
      const next = await chunks.next();

      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await chunks.return(undefined);
    }
  });

  const stamp = manifest.createdAt.replace(/[:.]/g, "-");

  return new Response(tar.pipeThrough(new CompressionStream("gzip")), {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="ky-${stamp}.tar.gz"`,
      "Cache-Control": "no-store"
    }
  });
}

/** POST /api/restore: start, with the manifest. */
async function restoreStart(request: Request, target: BackupAgent): Promise<Response> {
  const { manifest, end, force } = parsed(RestoreStartSchema, await request.text(), "The restore's start");
  await target.restoreBegin(manifest, end, force === true);

  return new Response(null, { status: 204 });
}

/** PUT /api/restore/files/<id>: one upload, into the bucket, at the size the manifest says. */
async function restoreUpload(request: Request, env: Env, target: BackupAgent, key: string): Promise<Response> {
  const expected = isUploadKey(key) ? await target.restoreFile(key) : undefined;

  if (!expected) return new Response(`The backup has no file ${key}.`, { status: 404 });

  if (!request.body) return new Response("Send the file's bytes.", { status: 400 });
  await env.FILES.put(key, request.body.pipeThrough(new FixedLengthStream(expected.size)), {
    httpMetadata: expected.type ? { contentType: expected.type } : undefined
  });

  return new Response(null, { status: 204 });
}

/** POST /api/restore/rows?table=: one part of a table's rows, kept aside. */
async function restoreRows(request: Request, target: BackupAgent): Promise<Response> {
  const table = new URL(request.url).searchParams.get("table") ?? "";
  const rows = await target.restoreRows(table, new TextDecoder().decode(await request.arrayBuffer()));

  return Response.json({ rows });
}

/** POST /api/restore/finish: once every upload is whole, swap the rows in and restart the agent. */
async function restoreEnd(request: Request, env: Env, target: BackupAgent): Promise<Response> {
  const { force } = parsed(RestoreFinishSchema, await request.text(), "The restore's finish");

  for (const file of await target.restoreFiles()) {
    const object = await env.FILES.head(file.key);

    if (object?.size !== file.size) return new Response(`${file.key} didn't arrive whole: run the restore again.`, { status: 409 });
  }

  const restored: Restored = await target.restoreFinish(new URL(request.url).origin, force === true);
  // The agent starts over on the restored tables; the call that restarts it never returns.
  await target.restart().catch(() => undefined);

  return Response.json(restored);
}

/** The restore's steps; see restoreArchive in src/archive.ts for the order. A refusal is a 409 saying why. */
async function restore(request: Request, env: Env, target: BackupAgent, path: string): Promise<Response> {
  const step = `${request.method} ${path.startsWith("/files/") ? "/files/" : path}`;

  const steps = new Map([
    ["POST ", () => restoreStart(request, target)],
    ["PUT /files/", () => restoreUpload(request, env, target, path.slice(1))],
    ["POST /rows", () => restoreRows(request, target)],
    ["POST /finish", () => restoreEnd(request, env, target)]
  ]);

  try {
    return (await steps.get(step)?.()) ?? new Response("Not found", { status: 404 });
  } catch (error) {
    return new Response(error instanceof Error ? error.message : String(error), { status: 409 });
  }
}

const agent = (env: Env) => env.PiAgent.getByName("me");

/** The owner's backup and restore routes, of the agent "me" unless the tests say another; undefined for any other path. */
export function backupRoute(request: Request, env: Env, url: URL, target: BackupAgent = agent(env)): Promise<Response> | undefined {
  if (url.pathname === "/api/backup") {
    return request.method === "GET" ? backup(env, target, url.origin) : Promise.resolve(new Response("Method not allowed", { status: 405 }));
  }

  if (url.pathname === "/api/restore" || url.pathname.startsWith("/api/restore/")) {
    return restore(request, env, target, url.pathname.slice("/api/restore".length));
  }

  return undefined;
}
