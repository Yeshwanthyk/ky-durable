import Type, { type Static } from "typebox";
import type { Fetch } from "../providers/contract";
import { KY, ownedId, ownedOf, ownerName, SHARED } from "../skills/contract";
import { SchemeSchema } from "./shapes";

type Scheme = Static<typeof SchemeSchema>;

export type CredentialInfo = {
  readonly origin: string;
  readonly scheme: Scheme;
  readonly header: string | null;
  readonly purpose: string;
};

export const CredentialSchema = Type.Object({
  origin: Type.String(),
  scheme: SchemeSchema,
  header: Type.Union([Type.String(), Type.Null()]),
  purpose: Type.String(),
  value: Type.String()
});

export type Credential = Static<typeof CredentialSchema>;

export type CredentialRequest = {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
};

export type CredentialReply =
  | { readonly status: number; readonly type: string | null; readonly body: string; readonly truncated: boolean }
  | { readonly refused: string; readonly sent: boolean };

export const HTTP_KIND = "http";

/** The key `owner` calls with as `name`, among the Vault's `ids`: its own, else a shared one; never another owner's, which is asked of it. */
export function heldKey(owner: string, name: string, ids: readonly string[]): { readonly id: string } | { readonly refused: string } {
  const keys = ids.flatMap((id) => {
    const key = ownedOf(id);

    return key.name === name ? [key] : [];
  });

  const usable = keys.find((key) => key.owner === owner) ?? keys.find((key) => key.owner === SHARED);

  if (usable) return { id: ownedId(usable.owner, name) };
  const other = keys[0]?.owner;

  if (other === undefined) return { refused: `There is no credential ${name}. list_secrets shows the ones there are.` };

  return other === KY
    ? { refused: `ky holds ${name}, not ${ownerName(owner)}. Only the user can share it, or move it to ${ownerName(owner)}, in Settings › Webhooks.` }
    : { refused: `${ownerName(other)} holds that key; ask ${ownerName(other)}.` };
}

const SCHEMES: readonly Scheme[] = SchemeSchema.anyOf.map((literal) => literal.const);

export const SECRET_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;

export const MIN_VALUE_CHARS = 4;

export const MAX_VALUE_CHARS = 8_192;

const MAX_RESPONSE_CHARS = 20_000;

const REQUEST_TIMEOUT_MS = 30_000;

const REDACTED = "[redacted]";

const encoder = new TextEncoder();

function httpsOrigin(value: string): string | null {
  const url = URL.parse(value);

  return url?.protocol === "https:" && url.username === "" && url.password === "" ? url.origin : null;
}

export function badInfo(name: string, info: CredentialInfo): string | null {
  if (!SECRET_NAME.test(name)) return "A credential's name is a letter, then letters, digits, _ and -, up to 64.";

  if (httpsOrigin(info.origin) !== info.origin) return "A credential's origin is an https origin, like https://api.example.com, with no path.";

  if (!SCHEMES.includes(info.scheme)) return `A credential's scheme is ${SCHEMES.join(", ")}.`;

  if (info.scheme === "header" && (info.header === null || !HEADER_NAME.test(info.header))) return "A header credential needs the header's name.";

  if (info.scheme !== "header" && info.header !== null) return "Only a header credential names a header.";

  return null;
}

function credentialHeader(credential: Credential): [string, string] {
  if (credential.scheme === "bearer") return ["Authorization", `Bearer ${credential.value}`];

  if (credential.scheme === "basic") return ["Authorization", `Basic ${base64(credential.value)}`];

  return [credential.header ?? "Authorization", credential.value];
}

function base64(text: string): string {
  return btoa(String.fromCharCode(...encoder.encode(text)));
}

function encodings(value: string): string[] {
  const padded = base64(value);
  const bare = padded.replace(/=+$/, "");
  const encoded = encodeURIComponent(value);

  return [value, encoded, encoded.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()), JSON.stringify(value).slice(1, -1), padded, bare, bare.replaceAll("+", "-").replaceAll("/", "_")];
}

function forms(credential: Credential): string[] {
  const split = credential.value.indexOf(":");
  const halves = credential.scheme === "basic" && split >= 0 ? [credential.value.slice(0, split), credential.value.slice(split + 1)] : [];
  const all = [credential.value, ...halves].flatMap(encodings);

  return [...new Set(all)].filter((form) => form.length >= MIN_VALUE_CHARS).sort((a, b) => b.length - a.length);
}

function redact(text: string, credential: Credential): string {
  return forms(credential).reduce((redacted, form) => redacted.replaceAll(form, REDACTED), text);
}

export async function credentialFetch(fetcher: Fetch, credential: Credential, request: CredentialRequest): Promise<CredentialReply> {
  if (httpsOrigin(request.url) !== credential.origin) return { refused: `This credential is only sent to ${credential.origin}, and not to any other origin.`, sent: false };
  const [name, value] = credentialHeader(credential);
  const headers = new Headers();

  for (const [key, text] of Object.entries(request.headers)) {
    if (key.toLowerCase() !== name.toLowerCase()) headers.set(key, text);
  }

  headers.set(name, value);
  let response: Response;

  try {
    response = await fetcher(request.url, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    return { refused: redact(`The request failed: ${error instanceof Error ? error.message : String(error)}`, credential), sent: true };
  }

  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();

    return { refused: `${credential.origin} answered ${response.status}, a redirect, which ky doesn't follow with a credential.`, sent: true };
  }

  const text = redact(await response.text(), credential);

  return {
    status: response.status,
    type: response.headers.get("Content-Type"),
    body: text.slice(0, MAX_RESPONSE_CHARS),
    truncated: text.length > MAX_RESPONSE_CHARS
  };
}

export function replyText(answer: CredentialReply): string {
  if ("refused" in answer) return answer.refused;
  const cut = answer.truncated ? "\n[cut at 20,000 characters]" : "";

  return `${answer.status}${answer.type ? ` (${answer.type})` : ""}\n\n${answer.body}${cut}`;
}

export function replyFailed(answer: CredentialReply): boolean {
  return "refused" in answer || answer.status >= 400;
}

export async function signedWith(secret: string, body: string, signature: string | null): Promise<boolean> {
  const sent = /^sha256=([0-9a-f]{64})$/i.exec(signature ?? "")?.[1];

  if (sent === undefined) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const made = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  const given = Uint8Array.from(sent.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

  const subtle = crypto.subtle;

  return comparesSafely(subtle) && subtle.timingSafeEqual(made, given);
}

type WorkersSubtle = SubtleCrypto & { timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean };

const comparesSafely = (subtle: SubtleCrypto): subtle is WorkersSubtle => "timingSafeEqual" in subtle;
