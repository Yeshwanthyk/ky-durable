/**
 * Whether an MP4 or WebM file carries a picture, read from its own track list. A file's extension can't
 * say: a lecture saved as .mp4 or .webm holds only sound, and `ky attach` types files by extension
 * (cli/runner/share.ts). MP4 (and QuickTime) lists each track's handler, `vide` or `soun`, in
 * moov/trak/mdia/hdlr; WebM (Matroska) lists each TrackEntry's TrackType, 1 for video and 2 for audio,
 * in Segment/Tracks, ahead of the media.
 *
 * The file is read in ranges, never whole: WebM's track list sits in its first bytes, and MP4's moov is
 * found by hopping box headers, so a stored file costs a few small reads however long it plays.
 */

/** `length` bytes from `offset`, fewer at the end of the file. */
export type ReadRange = (offset: number, length: number) => Promise<Uint8Array>;

/** How much of a WebM is read for its track list, which comes before any media. */
const WEBM_HEAD = 64 * 1024;

/** Some track is a picture: true; tracks found and none is: false; not a file this can read: undefined. */
export async function hasPicture(read: ReadRange, size: number): Promise<boolean | undefined> {
  const head = await read(0, Math.min(size, WEBM_HEAD));

  if (ascii(head, 4, 4) === "ftyp") return verdict(await mp4Handlers(read, size), "vide", "soun");

  if (head.length >= 4 && viewOf(head).getUint32(0) === ID.EBML) return verdict(webmTypes(viewOf(head), 0, head.length), 1, 2);

  return undefined;
}

/** Reads ranges of bytes already in memory, as an upload has them. */
export const inMemory =
  (bytes: Uint8Array): ReadRange =>
  async (offset, length) =>
    bytes.subarray(offset, offset + length);

function verdict<Kind>(kinds: readonly Kind[] | undefined, picture: Kind, sound: Kind): boolean | undefined {
  if (!kinds) return undefined;

  if (kinds.includes(picture)) return true;

  return kinds.includes(sound) ? false : undefined;
}

const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const ascii = (bytes: Uint8Array, at: number, length: number) =>
  at + length > bytes.length ? "" : String.fromCharCode(...bytes.subarray(at, at + length));

// ---------- MP4: boxes of a 32-bit size (1: a 64-bit size follows; 0: to the end) and a 4-letter type

type Box = { readonly type: string; readonly size: number; readonly header: number };

/** The box starting at `at` in `bytes`, whose bytes end at `end`; undefined when it doesn't fit, as in a cut-off file. */
function boxAt(bytes: Uint8Array, at: number, end: number): Box | undefined {
  if (at + 8 > Math.min(end, bytes.length)) return undefined;
  const view = viewOf(bytes);
  const type = ascii(bytes, at + 4, 4);
  const short = view.getUint32(at);
  const header = short === 1 ? 16 : 8;

  if (at + header > bytes.length) return undefined;
  const size = short === 1 ? Number(view.getBigUint64(at + 8)) : short === 0 ? end - at : short;

  return size < header || at + size > end ? undefined : { type, size, header };
}

/** The handler of every track, read from moov: the top-level boxes are hopped by their headers, as moov can sit after the media. */
async function mp4Handlers(read: ReadRange, size: number): Promise<string[] | undefined> {
  for (let at = 0; at + 8 <= size; ) {
    const box = boxAt(await read(at, 16), 0, size - at);

    if (!box) return undefined;

    if (box.type === "moov") return trackHandlers(await read(at + box.header, box.size - box.header));
    at += box.size;
  }

  return undefined;
}

const MP4_PARENTS: ReadonlySet<string> = new Set(["trak", "mdia"]);

function trackHandlers(bytes: Uint8Array): string[] {
  const handlers: string[] = [];

  for (let at = 0, box = boxAt(bytes, 0, bytes.length); box; at += box.size, box = boxAt(bytes, at, bytes.length)) {
    const body = bytes.subarray(at + box.header, at + box.size);

    if (MP4_PARENTS.has(box.type)) handlers.push(...trackHandlers(body));
    // hdlr: version and flags (4 bytes), pre_defined (4), then handler_type.
    else if (box.type === "hdlr") handlers.push(ascii(body, 8, 4));
  }

  return handlers;
}

// ---------- WebM: elements of a variable-length id and size; a size of all ones is unknown, to the parent's end

const ID = { EBML: 0x1a45dfa3, SEGMENT: 0x18538067, TRACKS: 0x1654ae6b, TRACK_ENTRY: 0xae, TRACK_TYPE: 0x83, CLUSTER: 0x1f43b675 } as const;

type Vint = { readonly value: number; readonly length: number; readonly unknown: boolean };

/** A variable-length integer: its length is the first byte's leading zeros plus one. An id keeps its marker bit. */
function vint(view: DataView, at: number, end: number, id: boolean): Vint | undefined {
  if (at >= end) return undefined;
  const first = view.getUint8(at);
  const length = Math.clz32(first) - 23;

  if (length > 8 || at + length > end) return undefined;
  let value = id ? first : first & (0xff >> length);
  let ones = value === 0xff >> length;

  for (let index = 1; index < length; index++) {
    const byte = view.getUint8(at + index);
    value = value * 256 + byte;
    ones &&= byte === 0xff;
  }

  return { value, length, unknown: !id && ones };
}

/**
 * The TrackType of every track, from the Tracks element between `start` and `end`. Undefined when Tracks
 * isn't wholly there, so a track list cut short never reads as sound only.
 */
function webmTypes(view: DataView, start: number, end: number): number[] | undefined {
  for (let at = start; at < end; ) {
    const id = vint(view, at, end, true);
    const size = id && vint(view, at + id.length, end, false);

    if (!id || !size || id.value === ID.CLUSTER) return undefined;
    const body = at + id.length + size.length;

    if (id.value === ID.SEGMENT) return webmTypes(view, body, size.unknown ? end : Math.min(end, body + size.value));

    if (id.value === ID.TRACKS) return size.unknown || body + size.value > end ? undefined : trackTypes(view, body, body + size.value);

    // Any other element of unknown size can't be stepped over.
    if (size.unknown) return undefined;
    at = body + size.value;
  }

  return undefined;
}

function trackTypes(view: DataView, start: number, end: number): number[] {
  const types: number[] = [];

  for (let at = start; at < end; ) {
    const id = vint(view, at, end, true);
    const size = id && vint(view, at + id.length, end, false);

    if (!id || !size || size.unknown) break;
    const body = at + id.length + size.length;
    const stop = Math.min(end, body + size.value);

    if (id.value === ID.TRACK_ENTRY) types.push(...trackTypes(view, body, stop));
    else if (id.value === ID.TRACK_TYPE && size.value === 1 && body < end) types.push(view.getUint8(body));
    at = stop;
  }

  return types;
}
