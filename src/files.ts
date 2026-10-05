/**
 * Screenshots and recordings a machine task shares with the user, after
 * scotty's attachments. The runner's `ky-attach` PUTs a file to
 * `/api/files?task=<id>`; the Worker stores the bytes in R2 first and only
 * then has the agent record it, so no record names missing bytes. The UI
 * shows each file on its task and in the task's report in the chat.
 */

export type FileRow = {
  readonly id: string;
  readonly task: string;
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly caption: string | null;
  readonly created_at: number;
};

export const FILE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "video/webm",
  "video/mp4"
]);

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

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
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  list(): FileRow[] {
    return this.#sql
      .exec<FileRow>("SELECT * FROM ky_files ORDER BY created_at DESC LIMIT ?", LIST_LIMIT)
      .toArray();
  }

  forTask(task: string): FileRow[] {
    return this.#sql
      .exec<FileRow>("SELECT * FROM ky_files WHERE task = ? ORDER BY created_at", task)
      .toArray();
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
  record: (file: Omit<FileRow, "created_at">) => Promise<string | null>
): Promise<Response> {
  if (request.method !== "PUT") return reply(405, "Use PUT");
  const task = new URL(request.url).searchParams.get("task");

  if (!task) return reply(400, "Name the task: ?task=<id>");
  const type = request.headers.get("Content-Type") ?? "";

  if (!FILE_TYPES.has(type)) return reply(415, "Type must be png, jpeg, webp, gif, webm or mp4");
  const size = Number(request.headers.get("Content-Length"));

  if (!Number.isInteger(size) || size < 1 || size > MAX_FILE_BYTES) {
    return reply(413, "File must be 1 byte to 25 MB");
  }

  const name = decoded(request.headers.get("X-Ky-Name"), 255);

  const caption = request.headers.has("X-Ky-Caption")
    ? decoded(request.headers.get("X-Ky-Caption"), 2000)
    : null;

  if (!name || caption === undefined) return reply(400, "Bad file name or caption");
  const body = await request.arrayBuffer();

  if (body.byteLength !== size) return reply(400, "Body is not Content-Length bytes");
  const id = crypto.randomUUID().replaceAll("-", "");
  await bucket.put(`files/${id}`, body, { httpMetadata: { contentType: type } });
  const refused = await record({ id, task, name, type, size, caption });

  if (refused !== null) {
    await bucket.delete(`files/${id}`);

    return reply(404, refused);
  }

  return Response.json({ id, url: `/api/files/${id}` });
}

/** GET /api/files/<id>, with byte ranges: iOS Safari plays a video only from 206 responses. */
export async function download(request: Request, bucket: R2Bucket, id: string): Promise<Response> {
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("Range") ?? "");

  const object = await bucket.get(
    `files/${id}`,
    range ? { range: rangeOf(range[1]!, range[2]!) } : {}
  );

  if (!object) return reply(404, "Not found");

  const headers = new Headers({
    "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=31536000, immutable"
  });

  if (!range || !object.range || !("offset" in object.range)) {
    headers.set("Content-Length", String(object.size));

    return new Response(object.body, { headers });
  }

  const start = object.range.offset ?? 0;
  const length = object.range.length ?? object.size - start;
  headers.set("Content-Range", `bytes ${start}-${start + length - 1}/${object.size}`);
  headers.set("Content-Length", String(length));

  return new Response(object.body, { status: 206, headers });
}

function rangeOf(start: string, end: string): { offset: number; length?: number } {
  const offset = Number(start);

  return end === "" ? { offset } : { offset, length: Number(end) - offset + 1 };
}
