const RECORD_SIZE = 4096;

const VAPID_SECONDS = 12 * 3600;

const encoder = new TextEncoder();

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

async function rawKey(key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  const raw = await crypto.subtle.exportKey("raw", key);

  if (!(raw instanceof ArrayBuffer)) throw new Error("A raw key export gave no bytes.");

  return new Uint8Array(raw);
}

export async function encrypt(
  payload: Uint8Array,
  device: { readonly p256dh: string; readonly auth: string },
  sender: CryptoKeyPair,
  salt: Uint8Array<ArrayBuffer>
): Promise<Uint8Array<ArrayBuffer>> {
  const ua = fromBase64url(device.p256dh);
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const asPublic = await rawKey(sender.publicKey);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, sender.privateKey, 256);
  const ikm = await hkdf(fromBase64url(device.auth), shared, concat(encoder.encode("WebPush: info\0"), ua, asPublic), 32);
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(payload, Uint8Array.of(2)));
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, RECORD_SIZE);

  return concat(salt, size, Uint8Array.of(asPublic.length), asPublic, new Uint8Array(sealed));
}

export async function vapidToken(key: CryptoKey, audience: string, subject: string, now: number): Promise<string> {
  const part = (value: Readonly<Record<string, string | number>>) => base64url(encoder.encode(JSON.stringify(value)));
  const expires = Math.floor(now / 1000) + VAPID_SECONDS;
  const signed = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: audience, exp: expires, sub: subject })}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(signed));

  return `${signed}.${base64url(new Uint8Array(signature))}`;
}
