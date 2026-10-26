import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Sql } from "../core/sql";
import {
  BadLabel,
  ClipTooLarge,
  DIFF_TYPE,
  FILE_TABLES,
  FileRow,
  FileTooLarge,
  MAX_DIFF_BYTES,
  type NewFile,
  NoClip,
  NoTask,
  NotAClip,
  NotAFileType,
  NotRecorded,
  ShortBody,
  WrongMethod
} from "./contract";
import { baseType, MAX_MEDIA_BYTES, mediaKind, soundTypeOf } from "./media";
import { hasPicture, inMemory, type ReadRange } from "./tracks";

const TABLE = FILE_TABLES.files;

const TYPED = FILE_TABLES.typed;

const COLUMNS = "id, task, name, type, size, caption, created_at";

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

const LIST_LIMIT = 200;

export class Files extends Context.Service<
  Files,
  {
    readonly untyped: Effect.Effect<ReadonlyArray<FileRow>>;
    typed(types: ReadonlyMap<string, string>): Effect.Effect<void>;
    readonly restored: Effect.Effect<void>;
    readonly list: Effect.Effect<ReadonlyArray<FileRow>>;
    forTask(task: string): Effect.Effect<ReadonlyArray<FileRow>>;
    record(file: NewFile): Effect.Effect<FileRow>;
  }
>()("ky/files/Files") {
  static readonly layer = Layer.effect(
    Files,
    Effect.gen(function* () {
      const sql = yield* Sql;
      const exec = (query: string, ...params: SqlStorageValue[]) => Effect.orDie(sql.exec(query, ...params));
      const select = (where: string, ...params: SqlStorageValue[]) => Effect.orDie(sql.rows(FileRow, `SELECT ${COLUMNS} FROM ${TABLE} WHERE ${where}`, ...params));

      yield* exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      task TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      size INTEGER NOT NULL,
      caption TEXT,
      created_at INTEGER NOT NULL)`);
      yield* exec(`CREATE TABLE IF NOT EXISTS ${TYPED} (done INTEGER NOT NULL)`);

      return Files.of({
        untyped: Effect.gen(function* () {
          const done = yield* exec(`SELECT 1 FROM ${TYPED}`);

          return done.length > 0 ? [] : yield* select("type IN ('video/webm', 'video/mp4')");
        }),
        typed: Effect.fnUntraced(function* (types) {
          for (const [id, type] of types) yield* exec(`UPDATE ${TABLE} SET type = ? WHERE id = ?`, type, id);
          yield* exec(`DELETE FROM ${TYPED}`);
          yield* exec(`INSERT INTO ${TYPED} (done) VALUES (1)`);
        }),
        restored: Effect.asVoid(exec(`DELETE FROM ${TYPED}`)),
        list: select("1 = 1 ORDER BY created_at DESC LIMIT ?", LIST_LIMIT),
        forTask: (task) => select("task = ? ORDER BY created_at", task),
        record: Effect.fnUntraced(function* (file) {
          const row = { ...file, created_at: yield* Clock.currentTimeMillis };

          yield* exec(
            `INSERT INTO ${TABLE} (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            row.id,
            row.task,
            row.name,
            row.type,
            row.size,
            row.caption,
            row.created_at
          );

          return row;
        })
      });
    })
  );
}

const fileId = () => crypto.randomUUID().replaceAll("-", "");

const label = (value: string, max: number) =>
  Effect.try({ try: () => decodeURIComponent(value), catch: () => new BadLabel() }).pipe(
    Effect.filterOrFail(
      (text) => text.length > 0 && text.length <= max,
      () => new BadLabel()
    )
  );

export const upload = (
  request: Request,
  bucket: R2Bucket,
  record: (file: NewFile) => Promise<string | null>,
  typeOf: (declared: string, bytes: Uint8Array) => Promise<string>
) =>
  Effect.gen(function* () {
    if (request.method !== "PUT") return yield* new WrongMethod();
    const task = new URL(request.url).searchParams.get("task");

    if (!task) return yield* new NoTask();
    const type = request.headers.get("Content-Type") ?? "";

    if (!FILE_TYPES.has(type)) return yield* new NotAFileType();
    const size = Number(request.headers.get("Content-Length"));
    const max = type === DIFF_TYPE ? MAX_DIFF_BYTES : MAX_FILE_BYTES;

    if (!Number.isInteger(size) || size < 1 || size > max) return yield* new FileTooLarge({ max });
    const named = request.headers.get("X-Ky-Name");

    if (named === null) return yield* new BadLabel();
    const name = yield* label(named, 255);
    const captioned = request.headers.get("X-Ky-Caption");
    const caption = captioned === null ? null : yield* label(captioned, 2000);
    const body = yield* Effect.promise(() => request.arrayBuffer());

    if (body.byteLength !== size) return yield* new ShortBody();
    const id = fileId();
    const kept = yield* Effect.promise(() => typeOf(type, new Uint8Array(body)));
    yield* Effect.promise(() => bucket.put(`files/${id}`, body, { httpMetadata: { contentType: kept } }));
    const refused = yield* Effect.promise(() => record({ id, task, name, type: kept, size, caption }));

    if (refused !== null) {
      yield* Effect.promise(() => bucket.delete(`files/${id}`));

      return yield* new NotRecorded({ why: refused });
    }

    return Response.json({ id, url: `/files/${id}` });
  });

export const uploadMedia = (request: Request, bucket: R2Bucket) =>
  Effect.gen(function* () {
    if (request.method !== "PUT") return yield* new WrongMethod();
    const type = baseType(request.headers.get("Content-Type") ?? "");

    if (mediaKind(type) === null) return yield* new NotAClip();
    const size = Number(request.headers.get("Content-Length"));

    if (!Number.isInteger(size) || size < 1 || size > MAX_MEDIA_BYTES) return yield* new ClipTooLarge({ max: MAX_MEDIA_BYTES });

    if (request.body === null) return yield* new NoClip();
    const id = fileId();
    const body = request.body.pipeThrough(new FixedLengthStream(size));
    yield* Effect.promise(() => bucket.put(`files/${id}`, body, { httpMetadata: { contentType: type } }));

    return Response.json({ id, url: `/files/${id}` });
  });

export async function typeOf(declared: string, read: ReadRange, size: number): Promise<string> {
  const sound = soundTypeOf.get(declared);

  return sound && (await hasPicture(read, size)) === false ? sound : declared;
}

export const uploadedType = (declared: string, bytes: Uint8Array) => typeOf(declared, inMemory(bytes), bytes.length);

export const stored =
  (bucket: R2Bucket, key: string): ReadRange =>
  async (offset, length) => {
    const object = await bucket.get(key, { range: { offset, length } });

    return object ? new Uint8Array(await object.arrayBuffer()) : new Uint8Array();
  };

export async function saveImage(bucket: R2Bucket, bytes: Uint8Array, type = "image/png"): Promise<string> {
  const id = fileId();
  await bucket.put(`files/${id}`, bytes, { httpMetadata: { contentType: type } });

  return id;
}

export const reply = (status: number, text: string) => new Response(`${text}\n`, { status });

export async function download(request: Request, bucket: R2Bucket, id: string): Promise<Response> {
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("Range") ?? "");

  const object = await bucket.get(`files/${id}`, range ? { range: rangeOf(range[1] ?? "", range[2] ?? "") } : {});

  if (!object) return reply(404, "Not found");

  const headers = new Headers({
    "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
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
