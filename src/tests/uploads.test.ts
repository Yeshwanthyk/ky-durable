import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { saveKey } from "../runners/contract";
import { PART_BYTES, putInParts } from "../uploads";
import { type CloudMachine, FakeBox } from "./stack";

/**
 * A save's way into R2 (src/uploads.ts): a multipart upload in fixed-size parts, so the hub holds one
 * part of a save at a time, never all of it, and R2's object changes only once the last part is in.
 */

/** `size` bytes that don't repeat: each 32 is a hash of its offset. */
async function bytes(size: number, salt = "save"): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Uint8Array(size);

  for (let at = 0; at < size; at += 32) {
    const block = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${at}`)));
    out.set(block.subarray(0, Math.min(32, size - at)), at);
  }

  return out;
}

const hash = async (data: ArrayBuffer | Uint8Array<ArrayBuffer>) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** `data` as a body arrives from the runner: chunked, in pieces of `piece` bytes, failing after `failAfter` if given. */
function arriving(data: Uint8Array, piece = 65_536, failAfter?: number): ReadableStream<Uint8Array> {
  let at = 0;

  return new ReadableStream({
    pull(controller) {
      if (failAfter !== undefined && at >= failAfter) return controller.error(new Error("The save was cut off."));

      if (at >= data.length) return controller.close();
      controller.enqueue(data.slice(at, at + piece));
      at += piece;
    }
  });
}

/** R2, and the ids of the multipart uploads begun and aborted through it. */
type Watched = { readonly bucket: R2Bucket; readonly begun: string[]; readonly aborted: string[] };

/** R2, with each multipart upload it begins and aborts written down. */
function watched(): Watched {
  const begun: string[] = [];
  const aborted: string[] = [];
  // SAFETY: an object whose prototype is the binding has every R2Bucket method; the one below is replaced.
  const bucket = Object.create(env.FILES) as R2Bucket;

  bucket.createMultipartUpload = async (key, options) => {
    const upload = await env.FILES.createMultipartUpload(key, options);

    begun.push(upload.uploadId);

    return {
      key: upload.key,
      uploadId: upload.uploadId,
      uploadPart: (number, value, partOptions) => upload.uploadPart(number, value, partOptions),
      complete: (parts) => upload.complete(parts),
      abort: async () => {
        aborted.push(upload.uploadId);
        await upload.abort();
      }
    };
  };

  return { bucket, begun, aborted };
}

// SAFETY: src/tests/wrangler.jsonc binds CloudMachine to the test stack's subclass.
const machine = (id: string) => (env.CloudMachine as DurableObjectNamespace<CloudMachine>).getByName(id);

describe("a save's upload to R2", () => {
  it("parts are R2's minimum size or more", () => {
    // R2: every part but the last at least 5 MiB, and the same size.
    expect(PART_BYTES).toBeGreaterThanOrEqual(5 * 1024 * 1024);
  });

  it("puts a save of more than two parts whole, from a body of any chunking", async () => {
    const key = `test/uploads/${crypto.randomUUID()}`;
    const save = await bytes(2 * PART_BYTES + 12_345);
    const { bucket, aborted } = watched();

    // Pieces that don't divide a part: a part is cut from the middle of one.
    await putInParts(bucket, key, arriving(save, 100_003));
    const stored = await env.FILES.get(key);

    expect(stored?.size).toBe(save.length);
    expect(await hash(await stored!.arrayBuffer())).toBe(await hash(save));
    expect(aborted).toEqual([]);
    await env.FILES.delete(key);
  });

  it("leaves the last save in place, and aborts the upload, when the body fails part-way", async () => {
    const key = `test/uploads/${crypto.randomUUID()}`;
    const last = await bytes(1_000, "last");
    await env.FILES.put(key, last);
    const { bucket, begun, aborted } = watched();
    const save = await bytes(2 * PART_BYTES + 12_345);

    // Cut after the first part went up, inside the second.
    await expect(putInParts(bucket, key, arriving(save, 65_536, PART_BYTES + 65_536))).rejects.toThrow("cut off");
    expect(await hash(await (await env.FILES.get(key))!.arrayBuffer())).toBe(await hash(last));
    expect(aborted).toEqual(begun);
    expect(begun).toHaveLength(1);
    // Aborted: R2 takes no more parts for it.
    await expect(env.FILES.resumeMultipartUpload(key, begun[0]!).uploadPart(3, "late")).rejects.toThrow();
    await env.FILES.delete(key);
  });

  it("refuses an empty body: a save is never empty, and R2's last save stays", async () => {
    const key = `test/uploads/${crypto.randomUUID()}`;
    await env.FILES.put(key, "last");
    const { bucket, begun, aborted } = watched();

    await expect(putInParts(bucket, key, arriving(new Uint8Array(0)))).rejects.toThrow();
    expect(await (await env.FILES.get(key))!.text()).toBe("last");
    expect(aborted).toEqual(begun);
    await env.FILES.delete(key);
  });

  it("a sleep puts the container's whole disk of more than two parts to R2", async () => {
    const id = `uploads-${crypto.randomUUID().slice(0, 8)}`;
    // Text, as FakeBox's disk is: hex of bytes that don't repeat.
    const disk = [...(await bytes(PART_BYTES + 200_000))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

    await runInDurableObject(machine(id), async (instance: CloudMachine) => {
      await instance.primed(id, "https://ky.test");
      instance.fake = new FakeBox();
      Object.assign(instance.fake, { up: true, state: "running", disk });
      expect(await instance.sleep()).toBe(true);
    });
    const stored = await env.FILES.get(saveKey(id));

    expect(stored?.size).toBe(disk.length);
    expect(await hash(await stored!.arrayBuffer())).toBe(await hash(new TextEncoder().encode(disk)));
    await runInDurableObject(machine(id), (instance: CloudMachine) => instance.reset(id));
  });
});
