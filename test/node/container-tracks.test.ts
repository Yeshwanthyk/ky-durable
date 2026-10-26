import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasPicture, inMemory, type ReadRange } from "../../src/files/tracks.ts";

/**
 * Whether a file holds a picture comes from its track list, read in a few small ranges: a sound saved as
 * .webm or .mp4 is told from a video, wherever an MP4 keeps its index, without reading the media.
 */

const fixture = (name: string) => new Uint8Array(readFileSync(path.join(import.meta.dirname, "../web/fixtures", name)));

/** Reads as R2 would serve ranges, counting the bytes asked for. */
function counted(bytes: Uint8Array) {
  let total = 0;

  return {
    read: (async (offset, length) => {
      const range = bytes.subarray(offset, offset + length);
      total += range.length;

      return range;
    }) satisfies ReadRange,
    total: () => total
  };
}

describe("hasPicture", () => {
  it.each([
    ["sound.webm", false],
    ["clip.webm", true],
    ["sound.mp4", false],
    ["clip.mp4", true]
  ])("reads %s's tracks", async (name, picture) => {
    const bytes = fixture(name);

    expect(await hasPicture(inMemory(bytes), bytes.length)).toBe(picture);
  });

  it("finds an MP4's index after its media by hopping box headers, not reading the media", async () => {
    // ftyp, free, mdat, then moov: the media sits between the start and the index.
    const media = new Uint8Array(4 * 1024 * 1024);
    const sound = fixture("sound.mp4");
    const moov = sound.length - 962;
    const big = join(sound.subarray(0, 36), box("mdat", media), sound.subarray(moov));
    const { read, total } = counted(big);

    expect(await hasPicture(read, big.length)).toBe(false);
    expect(total()).toBeLessThan(80 * 1024);
  });

  it("can't tell from a file that isn't MP4 or WebM, or one cut off before its tracks", async () => {
    const cut = fixture("sound.webm").subarray(0, 40);
    const text = new TextEncoder().encode("not a video at all");

    expect(await hasPicture(inMemory(cut), cut.length)).toBeUndefined();
    expect(await hasPicture(inMemory(text), text.length)).toBeUndefined();
  });
});

function box(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(body, 8);

  return out;
}

function join(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  parts.reduce((at, part) => (out.set(part, at), at + part.length), 0);

  return out;
}
