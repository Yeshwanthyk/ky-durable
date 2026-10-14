/**
 * The backup archive (B1): a gzipped tar the Worker writes for `ky backup`,
 * and the client `ky restore` drives the Worker's restore routes with. It has
 * no imports, so the CLI, the Worker and the tests share it.
 *
 * In order, the archive holds:
 * - `manifest.json`: the Manifest, what follows and what was left out;
 * - `db/<table>/<part>.ndjson`: each table's rows, one JSON array a line, in
 *   the manifest's column order, its rowid first when the table has a rowid
 *   no column names;
 * - `files/<id>`: each upload in the bucket, byte for byte;
 * - `end.json`: the End, the rows and files written. An archive without it
 *   was cut off, and is never restored.
 */

import Type, { type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

export const FORMAT = "ky-backup";

/** Bumped when an archive this code writes can't be read by the code before it. */
export const FORMAT_VERSION = 1;

export const MANIFEST = "manifest.json";

export const END = "end.json";

export const TableDumpSchema = Type.Object({
  name: Type.String(),
  /** Its CREATE TABLE statement, for a ky that lacks the table. */
  sql: Type.String(),
  /** Its indexes' CREATE INDEX statements. */
  indexes: Type.Array(Type.String()),
  columns: Type.Array(Type.String()),
  /** Whether each row starts with its rowid: a rowid table with no INTEGER PRIMARY KEY column. */
  rowid: Type.Boolean(),
  /** Its AUTOINCREMENT counter, if it has one. */
  sequence: Type.Union([Type.Number(), Type.Null()])
});

export type TableDump = Static<typeof TableDumpSchema>;

/** Something the archive leaves out, and what to do about it after a restore. */
export const LeftOutSchema = Type.Object({ what: Type.String(), why: Type.String(), next: Type.Optional(Type.String()) });

export type LeftOut = Static<typeof LeftOutSchema>;

/** What the archive holds, as `ky backup` prints it. */
const SummarySchema = Type.Object({
  chats: Type.Number(),
  messages: Type.Number(),
  notes: Type.Number(),
  skills: Type.Number(),
  specialists: Type.Number(),
  automations: Type.Number(),
  /** Files in ky's workspace. */
  workspaceFiles: Type.Number(),
  /** Files tasks shared, in the bucket. */
  uploads: Type.Number(),
  uploadBytes: Type.Number()
});

export type Summary = Static<typeof SummarySchema>;

/** Schema versions of the libraries whose tables are copied whole; a restore needs the same. */
const SchemasSchema = Type.Object({ pi: Type.Union([Type.Number(), Type.Null()]), workspace: Type.Union([Type.Number(), Type.Null()]) });

export type Schemas = Static<typeof SchemasSchema>;

export const ArchivedFileSchema = Type.Object({ key: Type.String(), size: Type.Number(), type: Type.Union([Type.String(), Type.Null()]) });

export type ArchivedFile = Static<typeof ArchivedFileSchema>;

const ManifestSchema = Type.Object({
  format: Type.Literal(FORMAT),
  version: Type.Number(),
  createdAt: Type.String(),
  /** The ky it came from: its address and the Worker version that wrote it. */
  source: Type.Object({ origin: Type.String(), worker: Type.Union([Type.String(), Type.Null()]) }),
  schemas: SchemasSchema,
  tables: Type.Array(TableDumpSchema),
  /** Tables not in the archive, with why: rebuilt on restore, or meaningless on another deploy. */
  skipped: Type.Record(Type.String(), Type.String()),
  files: Type.Array(ArchivedFileSchema),
  leftOut: Type.Array(LeftOutSchema),
  summary: SummarySchema,
  /** Agent runs that were not finished when the backup started; back up while ky is idle. */
  unfinished: Type.Number()
});

export type Manifest = Static<typeof ManifestSchema>;

const EndSchema = Type.Object({ rows: Type.Record(Type.String(), Type.Number()), files: Type.Number() });

export type End = Static<typeof EndSchema>;

/** What a restore did, as `ky restore` prints it. */
const RestoredSchema = Type.Object({ summary: SummarySchema, rows: Type.Number(), files: Type.Number(), leftOut: Type.Array(LeftOutSchema) });

export type Restored = Static<typeof RestoredSchema>;

/** The body that starts a restore. */
export const RestoreStartSchema = Type.Object({ manifest: ManifestSchema, end: EndSchema, force: Type.Optional(Type.Boolean()) });

/** The body that finishes one. */
export const RestoreFinishSchema = Type.Object({ force: Type.Optional(Type.Boolean()) });

/**
 * One SQLite value as JSON, exactly: a blob as base64, an integer JSON can't
 * hold as a string, and a real JSON would read back as an integer (or can't
 * hold at all) as a string.
 */
const CellSchema = Type.Union([
  Type.Null(),
  Type.Number(),
  Type.String(),
  Type.Object({ $blob: Type.String() }),
  Type.Object({ $int: Type.String() }),
  Type.Object({ $real: Type.String() })
]);

export type Cell = Static<typeof CellSchema>;

/** One NDJSON line of a table's rows. */
export const RowSchema = Type.Array(CellSchema);

/** `value` as `schema` says, or an error saying `what` is damaged. */
export function parsed<Schema extends TSchema>(schema: Schema, text: string, what: string): Static<Schema> {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${what} isn't JSON.`);
  }

  if (!Value.Check(schema, value)) throw new Error(`${what} isn't what ky expects.`);

  return value;
}

/** The archive path of a table's `part`th rows. */
export const partPath = (table: string, part: number) => `db/${table}/${String(part).padStart(5, "0")}.ndjson`;

/** The table a rows path is of, or undefined. */
function partTable(path: string): string | undefined {
  return /^db\/([^/]+)\/\d+\.ndjson$/.exec(path)?.[1];
}

/** An upload's key in the bucket, which is also its path in the archive. */
export const isUploadKey = (key: string) => /^files\/[0-9a-f]{32}$/.test(key);

// --- tar ---------------------------------------------------------------------------------------

const BLOCK = 512;

const encoder = new TextEncoder();

const decoder = new TextDecoder();

/** A ustar header for a regular file of `size` bytes, readable by the owner only. */
export function tarHeader(name: string, size: number): Uint8Array<ArrayBuffer> {
  const path = encoder.encode(name);

  if (path.length > 100) throw new Error(`An archive path is longer than 100 bytes: ${name}`);
  const header = new Uint8Array(BLOCK);
  const put = (at: number, text: string) => header.set(encoder.encode(text), at);

  header.set(path, 0);
  put(100, "0000600\0");
  put(108, "0000000\0");
  put(116, "0000000\0");
  put(124, `${size.toString(8).padStart(11, "0")}\0`);
  put(136, `${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")}\0`);
  put(148, "        ");
  put(156, "0");
  put(257, "ustar\0");
  put(263, "00");
  const sum = header.reduce((total, byte) => total + byte, 0);
  put(148, `${sum.toString(8).padStart(6, "0")}\0 `);

  return header;
}

/** The zeros after `size` bytes that fill their last block. */
export const tarPadding = (size: number) => new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK);

/** The two zero blocks that end a tar. */
export const tarEnd = () => new Uint8Array(BLOCK * 2);

/** A whole entry: header, bytes, padding. */
export function tarEntry(name: string, bytes: Uint8Array<ArrayBuffer>): Array<Uint8Array<ArrayBuffer>> {
  return [tarHeader(name, bytes.length), bytes, tarPadding(bytes.length)];
}

export type Entry = { readonly name: string; readonly bytes: Uint8Array<ArrayBuffer> };

/** The regular files in an (ungzipped) tar, in order. */
export function readTar(tar: Uint8Array<ArrayBuffer>): Entry[] {
  const entries: Entry[] = [];

  for (let at = 0; at + BLOCK <= tar.length; ) {
    const header = tar.subarray(at, at + BLOCK);

    if (header.every((byte) => byte === 0)) break;
    const field = (from: number, length: number) => decoder.decode(header.subarray(from, from + length)).replace(/\0.*$/s, "");
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const prefix = field(345, 155);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const type = field(156, 1);

    if (!Number.isFinite(size) || at + BLOCK + size > tar.length) throw new Error("The archive is cut off.");

    if (type === "0" || type === "") entries.push({ name, bytes: tar.subarray(at + BLOCK, at + BLOCK + size) });
    at += BLOCK + size + tarPadding(size).length;
  }

  return entries;
}

// --- reading an archive ------------------------------------------------------------------------

export type Archive = {
  readonly manifest: Manifest;
  readonly end: End;
  /** Each table's parts, as NDJSON text, in order. */
  readonly parts: ReadonlyArray<{ readonly table: string; readonly text: string; readonly rows: number }>;
  readonly files: ReadonlyArray<{ readonly key: string; readonly bytes: Uint8Array<ArrayBuffer> }>;
};

const lines = (text: string) => (text === "" ? 0 : text.split("\n").filter((line) => line !== "").length);

/** An archive's contents, checked whole: it ends with end.json, and holds exactly the rows and files it says. */
export function readArchive(entries: readonly Entry[]): Archive {
  const first = entries[0];

  if (first?.name !== MANIFEST) throw new Error("This is not a ky backup: it doesn't start with manifest.json.");
  const manifest = parsed(ManifestSchema, decoder.decode(first.bytes), "This backup's manifest");

  if (manifest.version > FORMAT_VERSION) {
    throw new Error(`This backup is format ${manifest.version}; this ky reads up to ${FORMAT_VERSION}. Upgrade ky, then restore.`);
  }

  const last = entries.at(-1);

  if (last?.name !== END) throw new Error("This backup is cut off: it has no end.json. Take the backup again.");
  const end = parsed(EndSchema, decoder.decode(last.bytes), "This backup's end.json");
  const parts: Array<{ table: string; text: string; rows: number }> = [];
  const files: Array<{ key: string; bytes: Uint8Array<ArrayBuffer> }> = [];

  for (const entry of entries.slice(1, -1)) {
    const table = partTable(entry.name);

    if (table !== undefined) {
      const text = decoder.decode(entry.bytes);
      parts.push({ table, text, rows: lines(text) });
    } else if (isUploadKey(entry.name)) {
      files.push({ key: entry.name, bytes: entry.bytes });
    } else {
      throw new Error(`This backup has an entry ky doesn't know: ${entry.name}`);
    }
  }

  for (const table of manifest.tables) {
    const rows = parts.filter((part) => part.table === table.name).reduce((total, part) => total + part.rows, 0);

    if (rows !== (end.rows[table.name] ?? 0)) throw new Error(`This backup is damaged: ${table.name} has ${rows} rows, not ${end.rows[table.name]}.`);
  }

  if (files.length !== end.files || files.length !== manifest.files.length) throw new Error("This backup is damaged: its files don't match its manifest.");

  return { manifest, end, parts, files };
}

// --- restoring ---------------------------------------------------------------------------------

/** Sends one request to the ky being restored, signed in as its owner. */
export type Send = (path: string, init: RequestInit) => Promise<Response>;

async function ok(response: Response, doing: string): Promise<Response> {
  if (response.ok) return response;

  throw new Error(`${doing} failed (${response.status}): ${(await response.text()).trim()}`);
}

/**
 * Restore `archive` into the ky `send` reaches: start, upload the files and
 * the rows, which the agent keeps aside, then finish, which swaps them in at
 * once and restarts the agent. `force` restores over a ky that has chats or
 * memory already.
 */
export async function restoreArchive(archive: Archive, send: Send, force: boolean, progress: (line: string) => void = () => {}): Promise<Restored> {
  const post = (body: string): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body });
  const start: Static<typeof RestoreStartSchema> = { manifest: archive.manifest, end: archive.end, force };

  await ok(await send("/api/restore", post(JSON.stringify(start))), "Starting the restore");

  for (const [index, file] of archive.files.entries()) {
    const type = archive.manifest.files.find((each) => each.key === file.key)?.type ?? "application/octet-stream";
    progress(`file ${index + 1}/${archive.files.length}`);
    await ok(await send(`/api/restore/${file.key}`, { method: "PUT", headers: { "Content-Type": type }, body: file.bytes }), `Uploading ${file.key}`);
  }

  for (const [index, part] of archive.parts.entries()) {
    progress(`rows ${index + 1}/${archive.parts.length}`);
    await ok(
      await send(`/api/restore/rows?table=${encodeURIComponent(part.table)}`, { method: "POST", headers: { "Content-Type": "application/x-ndjson" }, body: part.text }),
      `Uploading ${part.table}`
    );
  }

  progress("finishing");
  const finish: Static<typeof RestoreFinishSchema> = { force };
  const finished = await ok(await send("/api/restore/finish", post(JSON.stringify(finish))), "Finishing the restore");

  return parsed(RestoredSchema, await finished.text(), "The restore's answer");
}
