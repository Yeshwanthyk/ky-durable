import { hasPicture, inMemory, type ReadRange } from "./container-tracks";
import type { FileStore } from "./files";
import { soundTypeOf } from "./media";

/**
 * A task file's type from its own tracks: `ky attach` types a file by its extension, so a sound saved as
 * .webm or .mp4 arrives as video, and is stored as the audio type. Kept apart from files.ts, which the
 * cloud machine's image loads, as only the Worker reads tracks.
 */

/** The type a file's tracks give it: a video type holding no picture is its audio type; any other keeps its own. */
async function typeOf(declared: string, read: ReadRange, size: number): Promise<string> {
  const sound = soundTypeOf.get(declared);

  return sound && (await hasPicture(read, size)) === false ? sound : declared;
}

/** An upload's type, from the bytes it brought. */
export const uploadedType = (declared: string, bytes: Uint8Array) => typeOf(declared, inMemory(bytes), bytes.length);

/** Ranges of a stored file, read from R2 as they're asked for. */
const stored =
  (bucket: R2Bucket, key: string): ReadRange =>
  async (offset, length) => {
    const object = await bucket.get(key, { range: { offset, length } });

    return object ? new Uint8Array(await object.arrayBuffer()) : new Uint8Array();
  };

/**
 * Once: each file stored as video before upload read its tracks takes the type its tracks give, so a sound
 * kept as .webm or .mp4 shows as audio. Each costs a few small reads of its start and index, however long
 * it plays; a restart part way reads them again, changing nothing already right.
 */
export async function retype(files: FileStore, bucket: R2Bucket): Promise<void> {
  const types = new Map<string, string>();

  for (const file of files.untyped()) {
    const type = await typeOf(file.type, stored(bucket, `files/${file.id}`), file.size);

    if (type !== file.type) types.set(file.id, type);
  }

  files.typed(types);
}
