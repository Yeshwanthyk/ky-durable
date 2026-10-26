/**
 * Screenshots and recordings a machine task shares with the user, after
 * scotty's attachments. The runner's `ky attach` PUTs a file to
 * `/api/files?task=<id>`; the Worker stores the bytes in R2 first and only
 * then has the agent record it, so no record names missing bytes. The UI
 * shows each file on its task and in the task's report in the chat.
 *
 * A task's code changes travel the same way: the runner's `ky diff` PUTs a
 * git patch as `text/x-diff`, and the UI renders its newest one as a diff.
 *
 * `ky attach` types a file by its extension, so a sound saved as .webm or .mp4 arrives as video; its own
 * tracks decide, and it is stored as the audio type (file-types.ts).
 */
import Type from "typebox";
import { decode } from "../../core/decode";

const Row = Type.Object({
  id: Type.String(),
  task: Type.String(),
  name: Type.String(),
  type: Type.String(),
  size: Type.Number(),
  caption: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.Number()
});

export type FileRow = {
  readonly id: string;
  readonly task: string;
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly caption: string | null;
  readonly created_at: number;
};

export const DIFF_TYPE = "text/x-diff";

const FILE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "video/webm",
  "video/mp4",
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  DIFF_TYPE
]);

const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Larger patches would not render on a phone anyway. */
export const MAX_DIFF_BYTES = 2 * 1024 * 1024;

const LIST_LIMIT = 200;

export class FileStore {
  readonly #sql: SqlStorage;
  readonly #listeners = new Set<() => void>();

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_files (
      id TEXT PRIMARY KEY,
      task TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      size INTEGER NOT NULL,
      caption TEXT,
      created_at INTEGER NOT NULL)`);
    // Whether the files stored as video before upload read their tracks have been given their tracks' type.
    sql.exec("CREATE TABLE IF NOT EXISTS ky_files_typed (done INTEGER NOT NULL)");
  }

  /** The files stored as video that may hold only sound, until they've been read once (file-types.ts); then none. */
  untyped(): FileRow[] {
    return this.#sql.exec("SELECT 1 FROM ky_files_typed").toArray().length > 0 ? [] : this.#rows("type IN ('video/webm', 'video/mp4')");
  }

  /** Give the files read their tracks' types, and mark the store read. */
  typed(types: ReadonlyMap<string, string>): void {
    for (const [id, type] of types) this.#sql.exec("UPDATE ky_files SET type = ? WHERE id = ?", type, id);
    this.#sql.exec("DELETE FROM ky_files_typed");
    this.#sql.exec("INSERT INTO ky_files_typed (done) VALUES (1)");

    if (types.size > 0) for (const listener of this.#listeners) listener();
  }

  /** A restore's files may come from before upload read tracks: they're read again. */
  restored(): void {
    this.#sql.exec("DELETE FROM ky_files_typed");
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  list(): FileRow[] {
    return this.#rows("1 = 1 ORDER BY created_at DESC LIMIT ?", LIST_LIMIT);
  }

  forTask(task: string): FileRow[] {
    return this.#rows("task = ? ORDER BY created_at", task);
  }

  #rows(where: string, ...bindings: SqlStorageValue[]): FileRow[] {
    return this.#sql.exec(`SELECT * FROM ky_files WHERE ${where}`, ...bindings).toArray().map((row) => decode(Row, row, "a file row"));
  }

  record(file: Omit<FileRow, "created_at">): FileRow {
    const row = { ...file, created_at: Date.now() };
    this.#sql.exec(
      "INSERT INTO ky_files (id, task, name, type, size, caption, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      row.id,
      row.task,
      row.name,
      row.type,
      row.size,
      row.caption,
      row.created_at
    );

    for (const listener of this.#listeners) listener();

    return row;
  }
}

function decoded(value: string | null, max: number): string | undefined {
  if (value === null) return undefined;

  try {
    const text = decodeURIComponent(value);

    return text.length > 0 && text.length <= max ? text : undefined;
  } catch {
    return undefined;
  }
}

const reply = (status: number, text: string) => new Response(`${text}\n`, { status });

/** PUT /api/files?task=<id>: store the bytes, then have the agent record them. */
export async function upload(
  request: Request,
  bucket: R2Bucket,
  record: (file: Omit<FileRow, "created_at">) => Promise<string | null>,
  typeOf: (declared: string, bytes: Uint8Array) => Promise<string>
): Promise<Response> {
  if (request.method !== "PUT") return reply(405, "Use PUT");
  const task = new URL(request.url).searchParams.get("task");

  if (!task) return reply(400, "Name the task: ?task=<id>");
  const type = request.headers.get("Content-Type") ?? "";

  if (!FILE_TYPES.has(type)) return reply(415, "Type must be png, jpeg, webp, gif, webm, mp4, an audio type of webm, mp4, mpeg, ogg or wav, or x-diff");
  const size = Number(request.headers.get("Content-Length"));
  const max = type === DIFF_TYPE ? MAX_DIFF_BYTES : MAX_FILE_BYTES;

  if (!Number.isInteger(size) || size < 1 || size > max) {
    return reply(413, `File must be 1 byte to ${max / 1024 / 1024} MB`);
  }

  const name = decoded(request.headers.get("X-Ky-Name"), 255);

  const caption = request.headers.has("X-Ky-Caption")
    ? decoded(request.headers.get("X-Ky-Caption"), 2000)
    : null;

  if (!name || caption === undefined) return reply(400, "Bad file name or caption");
  const body = await request.arrayBuffer();

  if (body.byteLength !== size) return reply(400, "Body is not Content-Length bytes");
  const id = crypto.randomUUID().replaceAll("-", "");
  const kept = await typeOf(type, new Uint8Array(body));
  await bucket.put(`files/${id}`, body, { httpMetadata: { contentType: kept } });
  const refused = await record({ id, task, name, type: kept, size, caption });

  if (refused !== null) {
    await bucket.delete(`files/${id}`);

    return reply(404, refused);
  }

  return Response.json({ id, url: `/files/${id}` });
}

/** Keep an image ky made itself, such as a browse screenshot, where /files/<id> serves it; returns the id. */
