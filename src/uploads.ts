/**
 * A sandbox's save into R2 (src/cloud.ts), as a multipart upload in fixed-size parts: the runner
 * streams its tar.gz with no length, and the hub holds one part of it at a time, never all of it.
 * R2's object at the key changes only when `complete` succeeds, so an upload that fails anywhere
 * leaves the last save there whole; the failed upload is aborted.
 */

/**
 * Each part but the last. R2's multipart limits (developers.cloudflare.com/r2/objects/multipart-objects/,
 * /r2/platform/limits/): parts of 5 MiB to 5 GiB, every one but the last the same size, at most
 * 10,000 of them. 8 MiB parts take a save up to 78 GiB, past the 20 GB disk of Containers' largest
 * instance (/containers/platform-details/limits/), in at most 2,385 parts for a full disk: each is
 * one R2 call, a subrequest, of the 10,000 a Workers Paid invocation may make
 * (/workers/platform/limits/). The hub holds one part at a time, of the isolate's 128 MB.
 */
export const PART_BYTES = 8 * 1024 * 1024;

/**
 * How long one save may take. It runs in the CloudMachine's alarm, whose handler has 15 minutes of
 * wall time (developers.cloudflare.com/durable-objects/platform/limits/); a save still going after
 * this is aborted, so it fails as an error the alarm handles rather than the platform cutting it off.
 */
const SAVE_WITHIN_MS = 10 * 60_000;

/** The parts of `body`: each PART_BYTES long, the last whatever is left. */
async function* partsOf(body: ReadableStream<unknown>, within: <T>(step: Promise<T>) => Promise<T>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let part = new Uint8Array(PART_BYTES);
  let filled = 0;

  try {
    for (;;) {
      const { done, value } = await within(reader.read());

      if (done) break;

      if (!(value instanceof Uint8Array)) throw new Error("A save's body gave something other than bytes");

      for (let at = 0; at < value.byteLength; ) {
        const taken = Math.min(PART_BYTES - filled, value.byteLength - at);

        part.set(value.subarray(at, at + taken), filled);
        filled += taken;
        at += taken;

        if (filled === PART_BYTES) {
          yield part;
          part = new Uint8Array(PART_BYTES);
          filled = 0;
        }
      }
    }

    if (filled > 0) yield part.subarray(0, filled);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/**
 * Put `body` to `bucket` at `key` in parts, over what's there only once all of it is in. A body
 * that fails, an empty body, or one that takes longer than `withinMs`, throws, and R2 keeps its last save.
 */
export async function putInParts(bucket: R2Bucket, key: string, body: ReadableStream<unknown>, withinMs = SAVE_WITHIN_MS): Promise<void> {
  const upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: "application/gzip" } });
  let timer: ReturnType<typeof setTimeout> | undefined;

  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`The save to ${key} took longer than ${withinMs / 1000}s`)), withinMs);
  });

  const within = <T>(step: Promise<T>) => Promise.race([step, late]);

  try {
    const parts: R2UploadedPart[] = [];

    for await (const part of partsOf(body, within)) parts.push(await within(upload.uploadPart(parts.length + 1, part)));

    if (parts.length === 0) throw new Error(`The save to ${key} was empty`);
    await within(upload.complete(parts));
  } catch (error) {
    await upload.abort().catch((reason: Error) => console.warn(`the save to ${key} failed, and so did aborting its upload`, reason));

    throw error;
  } finally {
    clearTimeout(timer);
  }
}
