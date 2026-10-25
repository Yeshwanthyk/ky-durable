import Type, { type Static } from "typebox";
import type { Fetch } from "../chatgpt";
import { SchemeSchema } from "./shapes";

/**
 * HTTP credentials: an API's token, which ky calls that API with and never sees. The Vault keeps each under
 * ("http", its name) and makes the call itself (`Vault.httpRequest`), so the value reaches only the origin it is
 * for, and is cut out of whatever comes back before the agent reads it.
 */

type Scheme = Static<typeof SchemeSchema>;

/** What a credential is, besides its value: where it may be sent, how, and what the user said it's for. */
export type CredentialInfo = {
  readonly origin: string;
  readonly scheme: Scheme;
  /** The header a "header" credential goes in; null for the other schemes, which use Authorization. */
  readonly header: string | null;
  readonly purpose: string;
};

/** A credential as the Vault keeps it: the value, and what it is for. */
export const CredentialSchema = Type.Object({
  origin: Type.String(),
  scheme: SchemeSchema,
  header: Type.Union([Type.String(), Type.Null()]),
  purpose: Type.String(),
  value: Type.String()
});

export type Credential = Static<typeof CredentialSchema>;

/** A call ky asks the Vault to make with a credential. */
export type CredentialRequest = {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
};

/**
 * What came back, cut to MAX_RESPONSE_CHARS with the value redacted; or why the call failed, and whether anything was
 * sent: `sent` is false only when no request left the Vault.
 */
export type CredentialReply =
  | { readonly status: number; readonly type: string | null; readonly body: string; readonly truncated: boolean }
  | { readonly refused: string; readonly sent: boolean };

export const HTTP_KIND = "http";

const SCHEMES: readonly Scheme[] = SchemeSchema.anyOf.map((literal) => literal.const);

/** A credential's name: a letter, then letters, digits, `_` and `-`, up to 64. */
export const SECRET_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** A header's name, as HTTP spells a token. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;

/** A value shorter than this would be redacted out of ordinary text, so it is not kept. */
export const MIN_VALUE_CHARS = 4;

export const MAX_VALUE_CHARS = 8_192;

const MAX_RESPONSE_CHARS = 20_000;

const REQUEST_TIMEOUT_MS = 30_000;

/** What a redacted value reads as. */
const REDACTED = "[redacted]";

const encoder = new TextEncoder();

/** The origin of an https URL, or null for any other URL, and for one with a user or password in it. */
function httpsOrigin(value: string): string | null {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return null;
  }

  return url.protocol === "https:" && url.username === "" && url.password === "" ? url.origin : null;
}

/** What the credential's definition gets wrong, or null; the same check for the tool that asks for one and the route that saves it. */
export function badInfo(name: string, info: CredentialInfo): string | null {
  if (!SECRET_NAME.test(name)) return "A credential's name is a letter, then letters, digits, _ and -, up to 64.";

  if (httpsOrigin(info.origin) !== info.origin) return "A credential's origin is an https origin, like https://api.example.com, with no path.";

  if (!SCHEMES.includes(info.scheme)) return `A credential's scheme is ${SCHEMES.join(", ")}.`;

  if (info.scheme === "header" && (info.header === null || !HEADER_NAME.test(info.header))) return "A header credential needs the header's name.";

  if (info.scheme !== "header" && info.header !== null) return "Only a header credential names a header.";

  return null;
}

/** The header the value goes on a request in. */
function credentialHeader(credential: Credential): [string, string] {
  if (credential.scheme === "bearer") return ["Authorization", `Bearer ${credential.value}`];

  if (credential.scheme === "basic") return ["Authorization", `Basic ${base64(credential.value)}`];

  // badInfo refuses a header credential without its header before it is kept; Authorization stands in, never sent.
  return [credential.header ?? "Authorization", credential.value];
}

function base64(text: string): string {
  return btoa(String.fromCharCode(...encoder.encode(text)));
}

/**
 * `value` as it can come back: raw, URL-encoded with upper or lower case escapes, JSON-escaped and base64, padded or
 * not, standard or URL-safe.
 */
function encodings(value: string): string[] {
  const padded = base64(value);
  const bare = padded.replace(/=+$/, "");
  const encoded = encodeURIComponent(value);

  return [value, encoded, encoded.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()), JSON.stringify(value).slice(1, -1), padded, bare, bare.replaceAll("+", "-").replaceAll("/", "_")];
}

/** Every form the credential's value can come back in; a basic one's user and password each on their own too, as an API can echo either. */
function forms(credential: Credential): string[] {
  const split = credential.value.indexOf(":");
  const halves = credential.scheme === "basic" && split >= 0 ? [credential.value.slice(0, split), credential.value.slice(split + 1)] : [];
  const all = [credential.value, ...halves].flatMap(encodings);

  // The longest first, so a form that holds a shorter one is cut whole.
  return [...new Set(all)].filter((form) => form.length >= MIN_VALUE_CHARS).sort((a, b) => b.length - a.length);
}

/** `text` with every form of the credential's value in it replaced by REDACTED. */
function redact(text: string, credential: Credential): string {
  return forms(credential).reduce((redacted, form) => redacted.replaceAll(form, REDACTED), text);
}

/**
 * Make `request` with the credential, inside the Vault: only to the credential's own origin, exactly, never
 * following a redirect, which could take the header elsewhere. The caller's headers can't replace the
 * credential's. What comes back, and any error, is redacted and cut to MAX_RESPONSE_CHARS.
 */
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
    // It may have reached the API before it failed.
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

/** What the agent reads of a call's answer: its status and type, then its body, or why no call was made. */
export function replyText(answer: CredentialReply): string {
  if ("refused" in answer) return answer.refused;
  const cut = answer.truncated ? "\n[cut at 20,000 characters]" : "";

  return `${answer.status}${answer.type ? ` (${answer.type})` : ""}\n\n${answer.body}${cut}`;
}

/** Whether an answer is an error to the agent: a refusal, or a status of 400 or more. */
export function replyFailed(answer: CredentialReply): boolean {
  return "refused" in answer || answer.status >= 400;
}

/**
 * Whether `signature`, GitHub's `X-Hub-Signature-256` (`sha256=` and the hex HMAC-SHA256 of the body), is the
 * body's under `secret`. Compared in constant time.
 */
export async function signedWith(secret: string, body: string, signature: string | null): Promise<boolean> {
  const sent = /^sha256=([0-9a-f]{64})$/i.exec(signature ?? "")?.[1];

  if (sent === undefined) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const made = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  const given = Uint8Array.from(sent.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

  // SAFETY: the Workers runtime has timingSafeEqual on crypto.subtle; the DOM lib's SubtleCrypto, which wins the merge here, lacks it.
  return (crypto.subtle as WorkersSubtle).timingSafeEqual(made, given);
}

type WorkersSubtle = SubtleCrypto & { timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean };
