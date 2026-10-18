import Type from "typebox";
import type { Fetch } from "./chatgpt";
import { decode } from "./core/decode";
import { localNow } from "./dreaming/contract";

/**
 * Web Push: what ky posts in a chat unasked (src/automations/delivery.ts) also shows as a notification on each
 * device the user turned notifications on for, in Settings › Proactivity. A device subscribes through its service
 * worker (public/sw.js) with ky's VAPID key, which the Vault makes the first time it is needed and signs every
 * push with (RFC 8292); each push is encrypted to the device's keys (RFC 8291, aes128gcm).
 *
 * At most the user's right-away number of posts a local day push, 6 until they change it; past that a post still
 * lands in its chat, quietly. A push counts once a device took it. A device the push service no longer knows (404
 * or 410), or that subscribed with another VAPID key (403), is dropped. A push is tried once: a failure is logged,
 * and never fails or holds up the post.
 */

/** A device's subscription: its push service's endpoint and its keys, base64url, as PushSubscription.toJSON gives them. */
export type PushDevice = { readonly endpoint: string; readonly p256dh: string; readonly auth: string };

/** What signs ky's pushes: the Vault. */
type Signer = {
  readonly vapidKey: () => Promise<string>;
  readonly vapidAuth: (audience: string, subject: string) => Promise<string>;
};

/** What pushes need from the rest of ky, set up in src/server.ts. */
type PushParts = {
  readonly vault: () => Signer;
  /** The user's time zone, which their day is counted in. */
  readonly zone: () => string | null;
  /** How many posts a day may push. */
  readonly most: () => number;
  /** A chat's name for the notification's title: "ky" for the main chat. */
  readonly title: (session: string) => string;
  /** ky's address, the contact a push service is given; null until a browser opened ky. */
  readonly origin: () => string | null;
};

/** A notification's text, at most. */
const BODY_CHARS = 120;

/** How long a push service keeps a push for a device that is off, in seconds. */
const TTL_SECONDS = 86_400;

/** A VAPID token lasts this long, in seconds; RFC 8292 allows at most a day. */
const VAPID_SECONDS = 12 * 3600;

/** The record size the one record of a push declares. */
const RECORD_SIZE = 4096;

/** Of a push service's error, at most this much is logged. */
const LOGGED_CHARS = 200;

/** What a push service answers for a device it won't push to again: unknown (404), gone (410), or keyed to another VAPID key (403). */
const GONE = new Set([403, 404, 410]);

const encoder = new TextEncoder();

const DeviceRow = Type.Object({ endpoint: Type.String(), p256dh: Type.String(), auth: Type.String() });

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
}

function concat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let at = 0;

  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }

  return out;
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: BufferSource, info: Uint8Array<ArrayBuffer>, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);

  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** A P-256 public key's 65 bytes. */
async function rawKey(key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  const raw = await crypto.subtle.exportKey("raw", key);

  if (!(raw instanceof ArrayBuffer)) throw new Error("A raw key export gave no bytes.");

  return new Uint8Array(raw);
}

/** `payload` encrypted to `device` as one aes128gcm record (RFC 8291), from the sender's ECDH key pair and a 16-byte salt. */
export async function encrypt(payload: Uint8Array, device: PushDevice, sender: CryptoKeyPair, salt: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const ua = fromBase64url(device.p256dh);
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const asPublic = await rawKey(sender.publicKey);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, sender.privateKey, 256);
  const ikm = await hkdf(fromBase64url(device.auth), shared, concat(encoder.encode("WebPush: info\0"), ua, asPublic), 32);
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // The last record ends with 2, and no padding.
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(payload, Uint8Array.of(2)));
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, RECORD_SIZE);

  return concat(salt, size, Uint8Array.of(asPublic.length), asPublic, new Uint8Array(sealed));
}

/** A VAPID token (RFC 8292) made at `now`: a JWT for the push service at `audience`, signed ES256 by `key`, for VAPID_SECONDS. */
export async function vapidToken(key: CryptoKey, audience: string, subject: string, now: number): Promise<string> {
  const part = (value: Readonly<Record<string, string | number>>) => base64url(encoder.encode(JSON.stringify(value)));
  const expires = Math.floor(now / 1000) + VAPID_SECONDS;
  const signed = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: audience, exp: expires, sub: subject })}`;
  // WebCrypto's ECDSA signature is r and s, as JWS's ES256 wants it.
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(signed));

  return `${signed}.${base64url(new Uint8Array(signature))}`;
}

/** `device` as ky keeps it, or an error saying what is wrong: an https endpoint, a P-256 public key and a 16-byte secret. */
function checked(device: PushDevice): PushDevice {
  const keys = (() => {
    try {
      return { ua: fromBase64url(device.p256dh), auth: fromBase64url(device.auth) };
    } catch {
      return undefined;
    }
  })();

  if (!URL.canParse(device.endpoint) || new URL(device.endpoint).protocol !== "https:") throw new Error("A push endpoint is an https address.");

  if (keys?.ua.length !== 65 || keys.ua[0] !== 4 || keys.auth.length !== 16) throw new Error("A push subscription's keys aren't a P-256 key and a 16-byte secret.");

  return device;
}

export class Pushes {
  readonly #sql: SqlStorage;
  readonly #parts: PushParts;
  /** The push services, as each push reaches them; tests answer instead. */
  fetch: Fetch = (input, init) => fetch(input, init);

  constructor(sql: SqlStorage, parts: PushParts) {
    this.#sql = sql;
    this.#parts = parts;
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_push_devices (
      endpoint TEXT PRIMARY KEY,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at INTEGER NOT NULL)`);
    // The posts pushed on the user's local day; only today's row is kept.
    sql.exec("CREATE TABLE IF NOT EXISTS ky_push_sent (day TEXT PRIMARY KEY, sent INTEGER NOT NULL)");
  }

  /** ky's VAPID public key, base64url, which a device subscribes with. */
  key(): Promise<string> {
    return this.#parts.vault().vapidKey();
  }

  /** Push to `device` from now on; subscribing again replaces its keys. */
  subscribe(device: PushDevice, now = Date.now()): void {
    const { endpoint, p256dh, auth } = checked(device);
    this.#sql.exec(
      `INSERT INTO ky_push_devices (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
      endpoint,
      p256dh,
      auth,
      now
    );
  }

  unsubscribe(endpoint: string): void {
    this.#sql.exec("DELETE FROM ky_push_devices WHERE endpoint = ?", endpoint);
  }

  /** `text` was posted in `session`: push it to every device, unless today's pushes are used up. Never throws. */
  async notify(session: string, text: string, now = Date.now()): Promise<void> {
    try {
      const devices = this.#devices();

      if (devices.length === 0) return;
      const day = localNow(this.#parts.zone(), now).date;

      if (!this.#take(day)) return;
      const title = this.#parts.title(session);
      // By code point, so an emoji is never cut in half.
      const chars = Array.from(text.replaceAll(/\s+/g, " ").trim());
      const body = chars.length > BODY_CHARS ? `${chars.slice(0, BODY_CHARS - 1).join("")}…` : chars.join("");
      // The main chat's link too, as public/sw.js and the page read it (src/ui/use-session-route.ts).
      const url = `/?session=${encodeURIComponent(session)}`;
      // Lines, as public/sw.js reads them: the title and the chat's address, each one line, then the text.
      const payload = encoder.encode(`${title}\n${url}\n${body}`);
      const took = await Promise.all(devices.map((device) => this.#send(device, payload)));

      // Nothing took it: it doesn't count.
      if (!took.includes(true)) this.#sql.exec("UPDATE ky_push_sent SET sent = sent - 1 WHERE day = ?", day);
    } catch (error) {
      console.warn("push", error);
    }
  }

  #devices(): PushDevice[] {
    return this.#sql
      .exec("SELECT endpoint, p256dh, auth FROM ky_push_devices")
      .toArray()
      .map((row) => decode(DeviceRow, row, "A push subscription"));
  }

  /** Count a push on `day`, if there is room for one; one statement, so pushes at once never pass the limit. */
  #take(day: string): boolean {
    const most = this.#parts.most();

    if (most < 1) return false;
    this.#sql.exec("DELETE FROM ky_push_sent WHERE day <> ?", day);

    return (
      this.#sql
        .exec("INSERT INTO ky_push_sent (day, sent) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET sent = sent + 1 WHERE sent < ? RETURNING sent", day, most)
        .toArray().length > 0
    );
  }

  /** Push `payload` to `device`: whether it took it. */
  async #send(device: PushDevice, payload: Uint8Array): Promise<boolean> {
    try {
      const origin = this.#parts.origin();

      if (origin === null) throw new Error("ky doesn't know its own address yet.");

      const sender = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
      const body = await encrypt(payload, device, sender, crypto.getRandomValues(new Uint8Array(16)));
      const authorization = await this.#parts.vault().vapidAuth(new URL(device.endpoint).origin, origin);

      const response = await this.fetch(device.endpoint, {
        method: "POST",
        headers: { authorization, "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: String(TTL_SECONDS) },
        body
      });

      if (response.ok) return true;

      // The device unsubscribed, or its subscription expired, or it was made with a VAPID key ky no longer has.
      if (GONE.has(response.status)) this.unsubscribe(device.endpoint);
      else console.warn("push", response.status, (await response.text()).slice(0, LOGGED_CHARS));
    } catch (error) {
      console.warn("push", error);
    }

    return false;
  }
}
