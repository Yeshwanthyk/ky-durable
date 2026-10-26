export type ReadRange = (offset: number, length: number) => Promise<Uint8Array>;

const WEBM_HEAD = 64 * 1024;

export async function hasPicture(read: ReadRange, size: number): Promise<boolean | undefined> {
  const head = await read(0, Math.min(size, WEBM_HEAD));

  if (ascii(head, 4, 4) === "ftyp") return verdict(await mp4Handlers(read, size), "vide", "soun");

  if (head.length >= 4 && viewOf(head).getUint32(0) === ID.EBML) return verdict(webmTypes(viewOf(head), 0, head.length), 1, 2);

  return undefined;
}

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

type Box = { readonly type: string; readonly size: number; readonly header: number };

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
    else if (box.type === "hdlr") handlers.push(ascii(body, 8, 4));
  }

  return handlers;
}

const ID = { EBML: 0x1a45dfa3, SEGMENT: 0x18538067, TRACKS: 0x1654ae6b, TRACK_ENTRY: 0xae, TRACK_TYPE: 0x83, CLUSTER: 0x1f43b675 } as const;

type Vint = { readonly value: number; readonly length: number; readonly unknown: boolean };

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

function element(view: DataView, at: number, end: number) {
  const id = vint(view, at, end, true);
  const size = id && vint(view, at + id.length, end, false);

  return id && size ? { id: id.value, size, body: at + id.length + size.length } : undefined;
}

function tracksWithin(view: DataView, size: Vint, body: number, end: number): number[] | undefined {
  return size.unknown || body + size.value > end ? undefined : trackTypes(view, body, body + size.value);
}

function webmTypes(view: DataView, start: number, end: number): number[] | undefined {
  for (let at = start; at < end; ) {
    const found = element(view, at, end);

    if (!found || found.id === ID.CLUSTER) return undefined;
    const { id, size, body } = found;

    if (id === ID.SEGMENT) return webmTypes(view, body, size.unknown ? end : Math.min(end, body + size.value));

    if (id === ID.TRACKS) return tracksWithin(view, size, body, end);

    if (size.unknown) return undefined;
    at = body + size.value;
  }

  return undefined;
}

function trackTypes(view: DataView, start: number, end: number): number[] {
  const types: number[] = [];

  for (let at = start; at < end; ) {
    const found = element(view, at, end);

    if (!found || found.size.unknown) break;
    const { id, size, body } = found;
    const stop = Math.min(end, body + size.value);

    if (id === ID.TRACK_ENTRY) types.push(...trackTypes(view, body, stop));
    else if (id === ID.TRACK_TYPE && size.value === 1 && body < end) types.push(view.getUint8(body));
    at = stop;
  }

  return types;
}
