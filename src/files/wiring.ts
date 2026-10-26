import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type Edge, makeEdge, type Refusable } from "../core/edge";
import { Sql } from "../core/sql";
import type { FileRow, NewFile } from "./contract";
import { Files, reply, stored, typeOf, upload as accept, uploadMedia as acceptMedia } from "./files";

export { download, saveImage, uploadedType } from "./files";

export class FileStore {
  readonly #edge: Edge<Files>;
  readonly #listeners = new Set<() => void>();

  constructor(storage: DurableObjectStorage) {
    this.#edge = makeEdge(Files.layer.pipe(Layer.provide(Sql.layer(storage))));
    this.#edge.run(Effect.void);
  }

  untyped(): FileRow[] {
    return [...this.#edge.run(Files.use((files) => files.untyped))];
  }

  typed(types: ReadonlyMap<string, string>): void {
    this.#edge.run(Files.use((files) => files.typed(types)));

    if (types.size > 0) this.#changed();
  }

  restored(): void {
    this.#edge.run(Files.use((files) => files.restored));
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  list(): FileRow[] {
    return [...this.#edge.run(Files.use((files) => files.list))];
  }

  forTask(task: string): FileRow[] {
    return [...this.#edge.run(Files.use((files) => files.forTask(task)))];
  }

  record(file: NewFile): FileRow {
    const row = this.#edge.run(Files.use((files) => files.record(file)));
    this.#changed();

    return row;
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }
}

async function answer<E extends Refusable & { readonly status: number }>(effect: Effect.Effect<Response, E>): Promise<Response> {
  const edge = makeEdge(Layer.empty);

  try {
    return await edge.runPromise(effect.pipe(Effect.catch((refused) => Effect.succeed(reply(refused.status, refused.refusal)))));
  } finally {
    await edge.dispose();
  }
}

export const upload = (
  request: Request,
  bucket: R2Bucket,
  record: (file: NewFile) => Promise<string | null>,
  type: (declared: string, bytes: Uint8Array) => Promise<string>
) => answer(accept(request, bucket, record, type));

export const uploadMedia = (request: Request, bucket: R2Bucket) => answer(acceptMedia(request, bucket));

export async function retype(files: FileStore, bucket: R2Bucket): Promise<void> {
  const types = new Map<string, string>();

  for (const file of files.untyped()) {
    const type = await typeOf(file.type, stored(bucket, `files/${file.id}`), file.size);

    if (type !== file.type) types.set(file.id, type);
  }

  files.typed(types);
}
