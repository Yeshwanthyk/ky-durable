import type { UserInput } from "@earendil-works/pi-durable";
import * as Schema from "effect/Schema";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  baseType,
  checkInput,
  clock,
  DIFF_TYPE,
  FILE_TABLES,
  imageSupport,
  imagesOf,
  MAX_DIFF_BYTES,
  MAX_MEDIA_BYTES,
  type MediaClip,
  mediaKind,
  mediaTag,
  type NewFile,
  readMedia,
  spokenText
} from "../../src/files/contract";
import type { Purpose, SettingsView } from "../../src/settings";
import { download as downloadFrom, FileStore, retype as retypeFrom, upload as uploadTo, uploadedType, uploadMedia as uploadMediaTo } from "../../src/files/wiring";
import * as B from "../parity/files/legacy";
import { assertParity, budget, type Clock, type Instance, type Json, type Parity } from "../parity/kit";
import { storageOf, StoredRow } from "../parity/skills/storage";

fc.configureGlobal({ baseSize: "large" });

const START = Date.UTC(2026, 0, 1);

const MB = 1024 * 1024;

const MAX_FILE_BYTES = 25 * MB;

const fixture = (name: string) => new Uint8Array(readFileSync(path.join(import.meta.dirname, "../web/fixtures", name)));

const BODIES = {
  "sound.webm": fixture("sound.webm"),
  "clip.webm": fixture("clip.webm"),
  "sound.mp4": fixture("sound.mp4"),
  "clip.mp4": fixture("clip.mp4"),
  text: new TextEncoder().encode("diff --git a/x b/x"),
  one: new Uint8Array([7]),
  none: new Uint8Array()
} satisfies Record<string, Uint8Array<ArrayBuffer>>;

type BodyName = keyof typeof BODIES;

class FixedLength extends TransformStream<Uint8Array, Uint8Array> {
  constructor(expected: number) {
    let seen = 0;

    super({
      transform: (chunk, controller) => {
        seen += chunk.byteLength;
        controller.enqueue(chunk);
      },
      flush: (controller) => {
        if (seen !== expected) controller.error(new TypeError("FixedLengthStream did not see all expected bytes before close()."));
      }
    });
  }
}

type Logged = [string, string, string | null, number];

type PutOptions = { readonly httpMetadata?: { readonly contentType?: string } };

type GetOptions = { readonly range?: { readonly offset?: number; readonly length?: number } };

function bucketOf() {
  const objects = new Map<string, { bytes: Uint8Array<ArrayBuffer>; type: string | null }>();
  const log: Logged[] = [];

  const bucket = {
    put: async (key: string, value: BodyInit, options?: PutOptions) => {
      const bytes = new Uint8Array(await new Response(value).arrayBuffer());
      const type = options?.httpMetadata?.contentType ?? null;
      objects.set(key, { bytes, type });
      log.push(["put", key, type, bytes.byteLength]);

      return null;
    },
    delete: async (key: string) => {
      objects.delete(key);
      log.push(["delete", key, null, 0]);
    },
    get: async (key: string, options?: GetOptions) => {
      const object = objects.get(key);

      if (!object) return null;
      const range = options?.range;
      const offset = range?.offset ?? 0;
      const length = range?.length ?? object.bytes.length - offset;
      const slice = object.bytes.subarray(offset, offset + length);

      return {
        size: object.bytes.length,
        httpMetadata: { contentType: object.type ?? undefined },
        range: range ? { offset, length: slice.length } : undefined,
        body: new Response(slice).body,
        arrayBuffer: async () => slice.slice().buffer
      };
    }
  };

  return { bucket, objects, log };
}

type Fake = ReturnType<typeof bucketOf>["bucket"];

type Store = Pick<FileStore, "untyped" | "typed" | "restored" | "onChange" | "list" | "forTask" | "record">;

type Upload = (request: Request, bucket: Fake, record: (file: NewFile) => Promise<string | null>, typeOf: (declared: string, bytes: Uint8Array) => Promise<string>) => Promise<Response>;

type UploadMedia = (request: Request, bucket: Fake) => Promise<Response>;

type Retype = (store: Store, bucket: Fake) => Promise<void>;

type Download = (request: Request, bucket: Fake, id: string) => Promise<Response>;

// SAFETY: upload calls only the bucket's put and delete.
const upload = uploadTo as Upload;

// SAFETY: uploadMedia calls only the bucket's put.
const uploadMedia = uploadMediaTo as UploadMedia;

// SAFETY: retype calls only the bucket's get, reading arrayBuffer, and the store's untyped and typed.
const retype = retypeFrom as Retype;

// SAFETY: download calls only the bucket's get and reads size, httpMetadata, range and body, all of which the fake returns.
const download = downloadFrom as Download;

type Typer = "read" | "declared";

type UploadAction = {
  readonly upload: "PUT" | "POST";
  readonly task: string | null;
  readonly type: string;
  readonly length: string;
  readonly body: BodyName;
  readonly name: string | null;
  readonly caption: string | null;
  readonly typer: Typer;
};

type MediaAction = { readonly media: "PUT" | "GET"; readonly type: string; readonly length: string; readonly body: BodyName };

type Action =
  | UploadAction
  | MediaAction
  | { readonly record: NewFile }
  | { readonly list: true }
  | { readonly forTask: string }
  | { readonly untyped: true }
  | { readonly typed: readonly (readonly [string, string])[] }
  | { readonly restored: true }
  | { readonly retype: true }
  | { readonly check: UserInput }
  | { readonly read: string }
  | { readonly kind: string }
  | { readonly support: { readonly settings: SettingsView; readonly purpose: Purpose } }
  | { readonly tag: MediaClip }
  | { readonly clock: number };

const TASKS = ["t1", "t2", "gone"];

const IDS = ["f1", "f2", "f3"];

const STORED_TYPES = ["video/mp4", "video/webm", "image/png", "audio/mp4", "text/x-diff"];

const UPLOAD_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "video/webm", "video/mp4", "audio/webm", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav", DIFF_TYPE, "image/svg+xml", "video/quicktime", "", "IMAGE/PNG"];

const MEDIA_TYPES = ["audio/webm;codecs=opus", "AUDIO/MP4", " video/quicktime ", "audio/x-m4a", "audio/flac", "video/webm", "image/png", "audio/aiff", "", "text/plain"];

const LABELS = ["shot.png", "ok%20name", "%E0%A4%A", "", "x".repeat(255), "x".repeat(256), "%25", "caf%C3%A9"];

const aLength = (max: number) => fc.oneof(fc.constantFrom("body", "0", "-1", "1.5", "x", "", String(max), String(max + 1), String(MAX_DIFF_BYTES + 1)), fc.nat({ max: 60_000 }).map(String));

const aBody = fc.constantFrom<BodyName>("sound.webm", "clip.webm", "sound.mp4", "clip.mp4", "text", "one", "none");

const aClip: fc.Arbitrary<MediaClip> = fc.record({
  kind: fc.constantFrom<"audio" | "video">("audio", "video"),
  file: fc.constantFrom("a".repeat(32), "0123456789abcdef".repeat(2), "nope"),
  type: fc.constantFrom("audio/webm", "video/mp4", "audio/x-m4a; codecs=x", "image/png", 'a"<b>&'),
  name: fc.constantFrom("Voice note", "My <clip> & \"more\"", ""),
  seconds: fc.option(fc.constantFrom(0, 3, 61.6, -1, Number.NaN), { nil: null }),
  peaks: fc.option(fc.constantFrom("0123", "9".repeat(40), "", "12a"), { nil: null }),
  transcript: fc.constantFrom("", "hello there", "(no transcript yet)", "a < b & c"),
  frames: fc.constantFrom(0, 1, 3, 4)
});

const aText = fc.oneof(
  fc.constantFrom("", "plain", "x".repeat(10)),
  fc.array(fc.oneof(aClip.map(mediaTag), fc.constantFrom("say ", '<ky-media kind="audio" file="zz">x</ky-media>', "\n")), { maxLength: 6 }).map((parts) => parts.join(""))
);

const B64 = ["QUJD", "QUJDRA==", "not base64!", "x".repeat(400_000), "y".repeat(1_500_000)];

const anImage = fc.record({ type: fc.constant<"image">("image"), data: fc.constantFrom(...B64), mimeType: fc.constantFrom("image/png", "image/jpeg", "image/bmp") });

const aTaggedClip: fc.Arbitrary<MediaClip> = fc.constantFrom<"audio" | "video">("audio", "video").chain((kind) =>
  fc.record({
    kind: fc.constant(kind),
    file: fc.constant("0123456789abcdef".repeat(2)),
    type: fc.constant(kind === "audio" ? "audio/webm" : "video/mp4"),
    name: fc.constant("Clip"),
    seconds: fc.constant(null),
    peaks: fc.constant(null),
    transcript: fc.constantFrom("", "said"),
    frames: kind === "audio" ? fc.constant(0) : fc.integer({ min: 0, max: 3 })
  })
);

const aSmallImage = fc.record({
  type: fc.constant<"image">("image"),
  data: fc.oneof({ arbitrary: fc.constant("QUJD"), weight: 4 }, { arbitrary: fc.constant("QUJD".repeat(40_000)), weight: 3 }, { arbitrary: fc.constantFrom(...B64), weight: 1 }),
  mimeType: fc.oneof({ arbitrary: fc.constant("image/png"), weight: 6 }, { arbitrary: fc.constantFrom("image/jpeg", "image/bmp"), weight: 1 })
});

const aMessage: fc.Arbitrary<UserInput> = fc
  .record({
    clips: fc.array(aTaggedClip, { maxLength: 6 }),
    own: fc.oneof(fc.constant([]), fc.array(aSmallImage, { maxLength: 5 })),
    shown: fc.array(aSmallImage, { minLength: 13, maxLength: 13 }),
    off: fc.integer({ min: -1, max: 1 }),
    texts: fc.constantFrom(0, 1, 1, 1, 2)
  })
  .map(({ clips, own, shown, off, texts }) => [
    ...Array.from({ length: texts }, () => ({ type: "text" as const, text: `${clips.map(mediaTag).join("")}hi` })),
    ...own,
    ...shown.slice(0, Math.max(0, clips.reduce((total, clip) => total + clip.frames, 0) + off))
  ]);

const aFrameShort: fc.Arbitrary<UserInput> = fc.array(aTaggedClip, { minLength: 1, maxLength: 4 }).map((clips) => [
  { type: "text" as const, text: clips.map(mediaTag).join("") },
  ...Array.from({ length: Math.max(0, clips.reduce((total, clip) => total + clip.frames, 0) - 1) }, () => ({ type: "image" as const, data: "QUJD", mimeType: "image/png" }))
]);

const aFrameHeavy: fc.Arbitrary<UserInput> = fc
  .record({ clips: fc.array(aTaggedClip, { minLength: 1, maxLength: 4 }), chars: fc.constantFrom(100_000, 150_000, 150_004) })
  .map(({ clips, chars }) => [
    { type: "text" as const, text: clips.map(mediaTag).join("") },
    ...Array.from({ length: clips.reduce((total, clip) => total + clip.frames, 0) }, () => ({ type: "image" as const, data: "QUJD".repeat(chars / 4), mimeType: "image/png" }))
  ]);

const anImageHeavy: fc.Arbitrary<UserInput> = fc
  .record({ count: fc.integer({ min: 1, max: 4 }), total: fc.constantFrom(1_400_008, 2_000_000, 2_799_000) })
  .map(({ count, total }) => [
    { type: "text" as const, text: "look" },
    ...Array.from({ length: count }, () => ({ type: "image" as const, data: "QUJD".repeat(Math.ceil(total / count / 4)), mimeType: "image/png" }))
  ]);

const aBadImage: fc.Arbitrary<UserInput> = fc
  .record({
    before: fc.integer({ min: 0, max: 3 }),
    data: fc.constantFrom("QUJD", "not base64!", "QUJD QUJD", "QUJD===", "QU-D"),
    mimeType: fc.constantFrom("image/png", "image/png", "image/bmp", "image/svg+xml")
  })
  .map(({ before, data, mimeType }) => [
    { type: "text" as const, text: "look" },
    ...Array.from({ length: before }, () => ({ type: "image" as const, data: "QUJD", mimeType: "image/png" })),
    { type: "image" as const, data, mimeType }
  ]);

const anInput: fc.Arbitrary<UserInput> = fc.oneof(
  aText,
  aMessage,
  aFrameShort,
  aFrameHeavy,
  anImageHeavy,
  aBadImage,
  fc.array(fc.oneof({ arbitrary: aText.map((text) => ({ type: "text" as const, text })), weight: 1 }, { arbitrary: anImage, weight: 2 }), { maxLength: 10 })
);

const aSettings: fc.Arbitrary<SettingsView> = fc.record({
  providers: fc.array(
    fc.record({
      id: fc.constantFrom("p1", "p2"),
      kind: fc.constant<"api-key">("api-key"),
      name: fc.constant("P"),
      connected: fc.boolean(),
      models: fc.array(fc.record({ modelId: fc.constantFrom("m1", "m2"), name: fc.constantFrom("Model One", "Model Two"), featured: fc.boolean(), levels: fc.constant([]), images: fc.boolean() }), { maxLength: 2 })
    }),
    { maxLength: 2 }
  ),
  purposes: fc.record(
    {
      main: fc.record({ provider: fc.constantFrom("p1", "p2"), modelId: fc.constantFrom("m1", "m2"), thinkingLevel: fc.constant<"off">("off") }),
      fallback: fc.record({ provider: fc.constantFrom("p1", "p2"), modelId: fc.constantFrom("m1", "m2"), thinkingLevel: fc.constant<"off">("off") })
    },
    { requiredKeys: [] }
  ),
  vendors: fc.constant([])
});

const actions: fc.Arbitrary<Action> = fc.oneof(
  {
    arbitrary: fc.record({
      upload: fc.constantFrom<"PUT" | "POST">("PUT", "PUT", "PUT", "POST"),
      task: fc.constantFrom<string | null>(...TASKS, "", null),
      type: fc.constantFrom(...UPLOAD_TYPES),
      length: aLength(MAX_FILE_BYTES),
      body: aBody,
      name: fc.option(fc.constantFrom(...LABELS), { nil: null, freq: 6 }),
      caption: fc.option(fc.constantFrom(...LABELS, "c".repeat(2000), "c".repeat(2001)), { nil: null }),
      typer: fc.constantFrom<Typer>("read", "declared")
    }),
    weight: 6
  },
  { arbitrary: fc.record({ media: fc.constantFrom<"PUT" | "GET">("PUT", "PUT", "GET"), type: fc.constantFrom(...MEDIA_TYPES), length: aLength(MAX_MEDIA_BYTES), body: aBody }), weight: 3 },
  {
    arbitrary: fc.record({
      record: fc.record({
        id: fc.constantFrom(...IDS),
        task: fc.constantFrom(...TASKS),
        name: fc.constantFrom("a.png", "b"),
        type: fc.constantFrom(...STORED_TYPES),
        size: fc.nat({ max: 5000 }),
        caption: fc.option(fc.constantFrom("hi", ""), { nil: null })
      })
    }),
    weight: 3
  },
  { arbitrary: fc.constant({ list: true as const }), weight: 1 },
  { arbitrary: fc.record({ forTask: fc.constantFrom(...TASKS) }), weight: 1 },
  { arbitrary: fc.constant({ untyped: true as const }), weight: 1 },
  { arbitrary: fc.record({ typed: fc.array(fc.tuple(fc.constantFrom(...IDS), fc.constantFrom("audio/mp4", "audio/webm")), { maxLength: 3 }) }), weight: 1 },
  { arbitrary: fc.constant({ restored: true as const }), weight: 1 },
  { arbitrary: fc.constant({ retype: true as const }), weight: 2 },
  { arbitrary: fc.record({ check: anInput }), weight: 2 },
  { arbitrary: fc.record({ read: aText }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constantFrom(...MEDIA_TYPES, ...UPLOAD_TYPES) }), weight: 1 },
  { arbitrary: fc.record({ support: fc.record({ settings: aSettings, purpose: fc.constantFrom<Purpose>("main", "worker", "fallback") }) }), weight: 1 },
  { arbitrary: fc.record({ tag: aClip }), weight: 1 },
  { arbitrary: fc.record({ clock: fc.constantFrom(-3, 0, 59.9, 60, 3599, 3600.5) }), weight: 1 }
);

const HEX_ID = /[0-9a-f]{32}/g;

function normalize(observed: Json): Json {
  const seen = new Map<string, string>();

  return JSON.stringify(observed).replace(HEX_ID, (id) => {
    const known = seen.get(id) ?? `id-${seen.size}`;
    seen.set(id, known);

    return known;
  });
}

const rowsDecoded = Schema.decodeUnknownSync(Schema.Array(StoredRow));

function rowsOf(db: DatabaseSync, table: string): Json[] {
  if (db.prepare("SELECT name FROM sqlite_master WHERE name = ?").all(table).length === 0) return [];

  return [...rowsDecoded(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())];
}

const thrownBy = (error: Error): string => (error.cause instanceof Error ? error.cause.message : error.message);

function requestOf(method: string, url: string, headers: Record<string, string | null>, body: BodyName): Request {
  const bytes = BODIES[body];
  const sent = Object.fromEntries(Object.entries(headers).flatMap(([key, value]) => (value === null ? [] : [[key, value === "body" ? String(bytes.length) : value]])));

  return new Request(url, { method, headers: sent, body: method === "GET" || body === "none" ? null : bytes });
}

async function answered(response: Promise<Response>): Promise<Json> {
  try {
    const done = await response;

    return { status: done.status, body: await done.text() };
  } catch (error) {
    return { threw: error instanceof Error ? thrownBy(error) : String(error) };
  }
}

type Side = {
  readonly store: (db: DatabaseSync) => Store;
  readonly upload: Upload;
  readonly uploadMedia: UploadMedia;
  readonly uploadedType: typeof uploadedType;
  readonly retype: Retype;
  readonly checkInput: typeof checkInput;
  readonly imagesOf: typeof imagesOf;
  readonly readMedia: typeof readMedia;
  readonly spokenText: typeof spokenText;
  readonly mediaKind: typeof mediaKind;
  readonly baseType: typeof baseType;
  readonly mediaTag: typeof mediaTag;
  readonly clock: typeof clock;
  readonly imageSupport: typeof imageSupport;
};

const legacy: Side = {
  ...B,
  store: B.legacyStore,
  // SAFETY: B's upload calls only the bucket's put and delete.
  upload: B.upload as Upload,
  // SAFETY: B's uploadMedia calls only the bucket's put.
  uploadMedia: B.uploadMedia as UploadMedia,
  // SAFETY: B's retype calls only the bucket's get, reading arrayBuffer, and the store's untyped and typed.
  retype: B.retype as Retype
};

const next: Side = {
  store: (db) => new FileStore(storageOf(db)),
  upload,
  uploadMedia,
  uploadedType,
  retype,
  checkInput,
  imagesOf,
  readMedia,
  spokenText,
  mediaKind,
  baseType,
  mediaTag,
  clock,
  imageSupport
};

function world(db: DatabaseSync, side: Side) {
  const store = side.store(db);
  const { bucket, objects, log } = bucketOf();
  let changes = 0;
  store.onChange(() => changes++);

  const record = async (file: NewFile) => {
    if (file.task === "gone") return "No task gone";
    store.record(file);

    return null;
  };

  const apply = async (action: Action): Promise<Json> => {
    if ("upload" in action) {
      const url = action.task === null ? "https://ky.test/api/files" : `https://ky.test/api/files?task=${action.task}`;
      const headers = { "Content-Type": action.type, "Content-Length": action.length, "X-Ky-Name": action.name, "X-Ky-Caption": action.caption };
      const typeOf = action.typer === "read" ? side.uploadedType : async (declared: string) => declared;

      return answered(side.upload(requestOf(action.upload, url, headers, action.body), bucket, record, typeOf));
    }

    if ("media" in action) return answered(side.uploadMedia(requestOf(action.media, "https://ky.test/api/media", { "Content-Type": action.type, "Content-Length": action.length }, action.body), bucket));

    try {
      if ("record" in action) return store.record(action.record);

      if ("list" in action) return store.list();

      if ("forTask" in action) return store.forTask(action.forTask);

      if ("untyped" in action) return store.untyped();

      if ("typed" in action) return store.typed(new Map(action.typed)) ?? null;

      if ("restored" in action) return store.restored() ?? null;

      if ("retype" in action) return (await side.retype(store, bucket)) ?? null;
    } catch (error) {
      return { threw: error instanceof Error ? thrownBy(error) : String(error) };
    }

    if ("check" in action) return side.checkInput(action.check);

    if ("read" in action) {
      const read = side.readMedia(action.read);

      return { read, spoken: side.spokenText(action.read), images: side.imagesOf([{ type: "text", text: action.read }]).length };
    }

    if ("kind" in action) return { kind: side.mediaKind(action.kind), base: side.baseType(action.kind) };

    if ("support" in action) return side.imageSupport(action.support.settings, action.support.purpose);

    if ("tag" in action) return side.mediaTag(action.tag);

    return side.clock(action.clock);
  };

  return { apply, effects: () => ({ changes, log, objects: [...objects.keys()].sort() }) };
}

function instance(db: DatabaseSync, side: Side): Instance<Action> {
  const made = world(db, side);

  return {
    apply: made.apply,
    tables: async () => ({
      schema: db
        .prepare("SELECT type, name, sql FROM sqlite_master WHERE name LIKE 'ky_%' ORDER BY name")
        .all()
        .map(({ type, name, sql }) => ({ type: String(type), name: String(name), sql: String(sql).replace(/\s+/g, " ") })),
      files: rowsOf(db, FILE_TABLES.files),
      typed: rowsOf(db, FILE_TABLES.typed)
    }),
    effects: async () => made.effects(),
    dispose: async () => db.close()
  };
}

function useClock(clock: Clock): void {
  vi.spyOn(Date, "now").mockImplementation(() => clock.now());
}

beforeEach(() => {
  vi.stubGlobal("FixedLengthStream", FixedLength);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const filesParity: Parity<Action> = {
  domain: "files",
  actions,
  start: START,
  advances: fc.integer({ min: 0, max: 90_000 }),
  normalize,
  legacy: async (time) => {
    useClock(time);

    return instance(new DatabaseSync(":memory:"), legacy);
  },
  next: async () => instance(new DatabaseSync(":memory:"), next)
};

describe("files parity", () => {
  it("answers, stores and puts what B does, step for step", async () => {
    await assertParity(filesParity);
  });
});

const runs = () => ({ numRuns: budget().numRuns, seed: budget().seed });

function port() {
  const db = new DatabaseSync(":memory:");
  const store = new FileStore(storageOf(db));
  const { bucket, objects, log } = bucketOf();
  const recorded: NewFile[] = [];

  const record = async (file: NewFile) => {
    if (file.task === "gone") return "No task gone";
    recorded.push(file);
    store.record(file);

    return null;
  };

  return {
    db,
    store,
    bucket,
    objects,
    log,
    recorded,
    send: (request: Request) => answered(upload(request, bucket, record, async (declared) => declared)),
    [Symbol.dispose]: () => db.close()
  };
}

const put = (headers: Record<string, string | null>, body: BodyName = "one", query = "?task=t1", method = "PUT") => requestOf(method, `https://ky.test/api/files${query}`, headers, body);

const good = { "Content-Type": "image/png", "Content-Length": "body", "X-Ky-Name": "a.png", "X-Ky-Caption": null };

const refused = (status: number, text: string) => ({ status, body: `${text}\n` });

describe("an upload", () => {
  it("is refused with 405 unless it is a PUT, and stores nothing", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom("POST", "GET", "PATCH", "DELETE"), async (method) => {
        using ky = port();

        expect(await ky.send(put(good, "one", "?task=t1", method))).toEqual(refused(405, "Use PUT"));
        expect(ky.log).toEqual([]);
      }),
      runs()
    );
  });

  it("names its task, or is refused with 400", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom("", "?task=", "?other=t1"), async (query) => {
        using ky = port();

        expect(await ky.send(put(good, "one", query))).toEqual(refused(400, "Name the task: ?task=<id>"));
        expect(ky.log).toEqual([]);
      }),
      runs()
    );
  });

  it("takes only the listed types, matched exactly", async () => {
    const listed = ["image/png", "image/jpeg", "image/webp", "image/gif", "video/webm", "video/mp4", "audio/webm", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav", "text/x-diff"];

    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.constantFrom(...listed), fc.string(), fc.constantFrom("IMAGE/PNG", "image/png; x=1", "audio/flac")), async (type) => {
        using ky = port();
        const said = await ky.send(put({ ...good, "Content-Type": type }));

        expect(said).toEqual(listed.includes(type) ? expect.objectContaining({ status: 200 }) : refused(415, "Type must be png, jpeg, webp, gif, webm, mp4, an audio type of webm, mp4, mpeg, ogg or wav, or x-diff"));
      }),
      runs()
    );
  });

  it("is 1 byte to 25 MB, or 2 MB for a diff, by its Content-Length, and the body must be that long", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.oneof(fc.integer({ min: -2, max: 30 * MB }), fc.constantFrom(0, 1, 2 * MB, 2 * MB + 1, 25 * MB, 25 * MB + 1, 1.5)), async (diff, size) => {
        using ky = port();
        const max = diff ? 2 * MB : 25 * MB;
        const said = await ky.send(put({ ...good, "Content-Type": diff ? DIFF_TYPE : "image/png", "Content-Length": String(size) }));
        const fits = Number.isInteger(size) && size >= 1 && size <= max;

        if (!fits) expect(said).toEqual(refused(413, `File must be 1 byte to ${diff ? 2 : 25} MB`));
        else if (size !== 1) expect(said).toEqual(refused(400, "Body is not Content-Length bytes"));
        else expect(said).toEqual(expect.objectContaining({ status: 200 }));

        expect(ky.log).toEqual(fits && size === 1 ? [["put", expect.stringMatching(/^files\/[0-9a-f]{32}$/), diff ? DIFF_TYPE : "image/png", 1]] : []);
      }),
      runs()
    );
  });

  it("has a name of 1 to 255 characters and a caption of 1 to 2000 when sent, both URI-decoded, or is refused with 400", async () => {
    const aLabel = fc.oneof(fc.string({ maxLength: 3000 }), fc.constantFrom("%", "%E0%A4%A", "%41", "", "x".repeat(255), "x".repeat(256), "c".repeat(2000), "c".repeat(2001)));

    await fc.assert(
      fc.asyncProperty(fc.option(aLabel, { nil: null }), fc.option(aLabel, { nil: null }), async (name, caption) => {
        using ky = port();

        const decoded = (value: string, max: number) => {
          try {
            const text = decodeURIComponent(value);

            return text.length >= 1 && text.length <= max ? text : false;
          } catch {
            return false;
          }
        };

        let sent: Request;

        try {
          sent = put({ ...good, "X-Ky-Name": name, "X-Ky-Caption": caption });
        } catch {
          return;
        }

        const heardName = sent.headers.get("X-Ky-Name");
        const heardCaption = sent.headers.get("X-Ky-Caption");
        const named = heardName === null ? false : decoded(heardName, 255);
        const captioned = heardCaption === null ? null : decoded(heardCaption, 2000);
        const said = await ky.send(sent);

        if (named === false || captioned === false) {
          expect(said).toEqual(refused(400, "Bad file name or caption"));
          expect(ky.recorded).toEqual([]);
        } else {
          expect(said).toEqual(expect.objectContaining({ status: 200 }));
          expect(ky.recorded).toEqual([expect.objectContaining({ name: named, caption: captioned })]);
        }
      }),
      runs()
    );
  });

  it("whose record is refused is taken back out of the bucket and answered 404 with the refusal", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom("t1", "gone"), async (task) => {
        using ky = port();
        const said = await ky.send(put(good, "one", `?task=${task}`));
        const key = ky.log[0]?.[1];

        if (task === "gone") {
          expect(said).toEqual(refused(404, "No task gone"));
          expect(ky.log).toEqual([["put", key, "image/png", 1], ["delete", key, null, 0]]);
          expect(ky.objects.size).toBe(0);
        } else {
          expect(said).toEqual({ status: 200, body: JSON.stringify({ id: key?.slice(6), url: `/${key}` }) });
          expect([...ky.objects.keys()]).toEqual([key]);
        }
      }),
      runs()
    );
  });
});

const SOUND = new Map([
  ["video/webm", "audio/webm"],
  ["video/mp4", "audio/mp4"]
]);

const MEDIA_FILES = ["sound.webm", "clip.webm", "sound.mp4", "clip.mp4"] as const;

const PICTURED: ReadonlySet<BodyName> = new Set(["clip.webm", "clip.mp4"]);

describe("a file's type", () => {
  it("is the sound type when a video file holds no picture, and as declared otherwise", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...MEDIA_FILES), fc.constantFrom("video/webm", "video/mp4", "image/png", "audio/webm"), async (file, declared) => {
        const sound = SOUND.get(declared);
        const bytes = BODIES[file];

        expect(await uploadedType(declared, bytes)).toBe(sound !== undefined && !PICTURED.has(file) ? sound : declared);
      }),
      runs()
    );
  });

  it("is read again once for the files stored as video, until a restore asks again", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...MEDIA_FILES), fc.constantFrom("video/webm", "video/mp4"), fc.boolean(), async (file, declared, restore) => {
        using ky = port();
        await ky.send(put({ ...good, "Content-Type": declared }, file));
        const id = ky.recorded[0]?.id;
        await ky.bucket.put(`files/${id}`, BODIES[file]);
        await retype(ky.store, ky.bucket);
        const after = !PICTURED.has(file) ? SOUND.get(declared) : declared;

        expect(ky.store.list().map((row) => row.type)).toEqual([after]);
        expect(ky.store.untyped()).toEqual([]);

        if (restore) ky.store.restored();

        expect(ky.store.untyped().length).toBe(restore && after === declared ? 1 : 0);
      }),
      runs()
    );
  });
});

const MAX_MEDIA = 95 * MB;

describe("a clip upload", () => {
  it("is a PUT of an audio or video type, 1 byte to 95 MB, with a body, or is refused with B's words", async () => {
    const audio = ["audio/webm", "audio/ogg", "audio/mp4", "audio/aac", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/x-m4a", "audio/flac"];
    const video = ["video/mp4", "video/webm", "video/quicktime"];

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<"PUT" | "POST">("PUT", "PUT", "POST"),
        fc.oneof({ arbitrary: fc.constantFrom(...audio, ...video), weight: 3 }, fc.constantFrom("AUDIO/FLAC; x=1", " video/mp4 ", "image/png", "audio/aiff", ""), fc.string()),
        fc.oneof({ arbitrary: fc.constantFrom(0, 1, 1, 1, 1.5, 2, MAX_MEDIA, MAX_MEDIA + 1), weight: 3 }, fc.integer({ min: -1, max: 100 * MB })),
        fc.boolean(),
        async (method, type, size, withBody) => {
          const { bucket, log } = bucketOf();
          const base = type.replace(/;.*$/s, "").trim().toLowerCase();
          const request = requestOf(method, "https://ky.test/api/media", { "Content-Type": type, "Content-Length": String(size) }, withBody ? "one" : "none");
          const said = await answered(uploadMedia(request, bucket));

          if (method !== "PUT") expect(said).toEqual(refused(405, "Use PUT"));
          else if (!audio.includes(base) && !video.includes(base)) expect(said).toEqual(refused(415, "Send an audio or video clip: webm, mp4, mov, m4a, mp3, ogg, wav or flac"));
          else if (!Number.isInteger(size) || size < 1 || size > MAX_MEDIA) expect(said).toEqual(refused(413, "A clip must be 1 byte to 95 MB"));
          else if (!withBody) expect(said).toEqual(refused(400, "Send the clip as the body"));
          else if (size === 1) expect(log).toEqual([["put", expect.stringMatching(/^files\/[0-9a-f]{32}$/), base, 1]]);
          else expect(JSON.stringify(said)).toMatch(/^\{"threw":/);
        }
      ),
      runs()
    );
  });
});

describe("a stored file's row", () => {
  it("keeps every column as recorded and takes created_at from the clock", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          id: fc.string({ minLength: 1 }),
          task: fc.oneof(fc.constant(""), fc.string()),
          name: fc.oneof(fc.constant(""), fc.string()),
          type: fc.oneof(fc.constant(""), fc.string()),
          size: fc.oneof(fc.constant(0), fc.nat()),
          caption: fc.option(fc.oneof(fc.constant(""), fc.string()), { nil: null })
        }),
        fc.integer({ min: 0, max: 2 ** 41 }),
        async (file, now) => {
          vi.spyOn(Date, "now").mockReturnValue(now);
          using ky = port();
          const row = ky.store.record(file);
          const stored = rowsDecoded(ky.db.prepare(`SELECT id, task, name, type, size, caption, created_at FROM ${FILE_TABLES.files}`).all());

          expect(row).toEqual({ ...file, created_at: now });
          expect(stored).toEqual([{ ...file, created_at: now }]);
          expect(ky.store.forTask(file.task)).toEqual([{ ...file, created_at: now }]);
          vi.restoreAllMocks();
        }
      ),
      runs()
    );
  });

  it("lists newest first, at most 200, and a task's oldest first", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 230 }).chain((count) => fc.array(fc.tuple(fc.constantFrom("t1", "t2"), fc.integer({ min: 0, max: 1000 })), { minLength: count, maxLength: count })), async (made) => {
        using ky = port();
        const times = new Map<string, number>();

        made.forEach(([task, at], index) => {
          vi.spyOn(Date, "now").mockReturnValue(at);
          ky.store.record({ id: `f${index}`, task, name: "n", type: "image/png", size: 1, caption: null });
          times.set(`f${index}`, at);
        });
        const at = (id: string) => times.get(id) ?? 0;
        const listed = ky.store.list().map((row) => row.id);
        const forT1 = ky.store.forTask("t1").map((row) => row.id);

        expect(listed.length).toBe(Math.min(200, made.length));
        expect(listed.every((id, index) => index === 0 || at(listed[index - 1] ?? "") >= at(id))).toBe(true);
        expect(forT1.length).toBe(made.filter(([task]) => task === "t1").length);
        expect(forT1.every((id, index) => index === 0 || at(forT1[index - 1] ?? "") <= at(id))).toBe(true);
        vi.restoreAllMocks();
      }),
      runs()
    );
  });
});

describe("a download", () => {
  it("serves the whole file, or the asked byte range as 206, with its stored type and never sniffed", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom<BodyName>(...MEDIA_FILES, "text"), fc.option(fc.tuple(fc.nat({ max: 3000 }), fc.option(fc.nat({ max: 3000 }), { nil: null })), { nil: null }), async (file, range) => {
        const { bucket } = bucketOf();
        const bytes = BODIES[file];
        await bucket.put("files/abc", bytes, { httpMetadata: { contentType: "video/mp4" } });
        const header = range === null ? null : `bytes=${range[0]}-${range[1] === null ? "" : range[0] + range[1]}`;
        const said = await download(new Request("https://ky.test/files/abc", { headers: header === null ? {} : { Range: header } }), bucket, "abc");

        expect(said.headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(said.headers.get("Content-Type")).toBe("video/mp4");

        if (range === null) {
          expect(said.status).toBe(200);
          expect(new Uint8Array(await said.arrayBuffer())).toEqual(bytes);
        } else {
          const start = range[0];
          const end = range[1] === null ? bytes.length : Math.min(bytes.length, start + range[1] + 1);
          const slice = bytes.subarray(start, end);

          expect(said.status).toBe(206);
          expect(said.headers.get("Content-Range")).toBe(`bytes ${start}-${start + slice.length - 1}/${bytes.length}`);
          expect(new Uint8Array(await said.arrayBuffer())).toEqual(slice);
        }

        expect((await download(new Request("https://ky.test/files/none"), bucket, "none")).status).toBe(404);
      }),
      runs()
    );
  });
});

describe("a message's input", () => {
  it("is text, or one text part with up to 4 images and each video's frames, in base64 of the listed types, within the size caps", async () => {
    await fc.assert(
      fc.asyncProperty(anInput, async (input) => {
        const said = checkInput(input);

        if (!Array.isArray(input)) {
          expect(said).toBe(null);

          return;
        }

        const images = input.filter((part) => part.type === "image");
        const texts = input.length - images.length;
        const clips = readMedia(input.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")).clips;
        const frames = clips.reduce((total, each) => total + each.frames, 0);
        const own = images.slice(0, images.length - frames);
        const shown = images.slice(images.length - frames);
        const chars = (some: typeof images) => some.reduce((total, image) => total + image.data.length, 0);

        const reasons = [
          [input.length === 0 || texts > 1, "Send one text part at most, and something."],
          [clips.length > 4, "Attach at most 4 clips."],
          [frames > images.length || frames > 12, "A video's frames don't match its tag."],
          [images.length - frames > 4, "Attach at most 4 images."],
          ...images.flatMap((image) => [
            [!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(image.mimeType), `Images must be JPEG, PNG, WebP or GIF, not ${image.mimeType}.`],
            [!/^[A-Za-z0-9+/]+={0,2}$/.test(image.data), "An image is not valid base64."]
          ]),
          [chars(own) > 1_400_000, "These images are too large together. Attach fewer."],
          [chars(shown) > 300_000, "These videos' frames are too large together."]
        ] as const;

        expect(said).toBe(reasons.find(([fails]) => fails)?.[1] ?? null);
      }),
      runs()
    );
  });
});

describe("a clip's tag", () => {
  it("reads back as the clip it was written from, whatever its name and transcript hold", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          kind: fc.constantFrom<"audio" | "video">("audio", "video"),
          file: fc.stringMatching(/^[0-9a-f]{32}$/),
          name: fc.string(),
          seconds: fc.option(fc.nat({ max: 10_000 }), { nil: null }),
          peaks: fc.option(fc.stringMatching(/^[0-9]{1,40}$/), { nil: null }),
          transcript: fc.string().filter((text) => !text.startsWith("(no transcript") && text.trim() === text),
          frames: fc.integer({ min: 0, max: 3 })
        }),
        fc.string().filter((text) => !text.includes("<ky-media") && text.trim() === text),
        async (clip, rest) => {
          const whole = { ...clip, type: clip.kind === "audio" ? "audio/webm" : "video/mp4" };
          const read = readMedia(`${mediaTag(whole)}${rest}`);

          expect(read.clips).toEqual([whole]);
          expect(read.text).toBe(rest);
          expect(spokenText(`${mediaTag(whole)}${rest}`)).toBe([clip.transcript || (clip.kind === "audio" ? "Voice note" : clip.name), rest].filter((each) => each !== "").join(" "));
        }
      ),
      runs()
    );
  });
});
