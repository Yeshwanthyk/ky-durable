import Type, { type Static, type TSchema } from "typebox";
import { parseOr } from "../core/decode";
import { badInfo, type Credential, HTTP_KIND, MAX_VALUE_CHARS, MIN_VALUE_CHARS } from "./credentials";
import { type Delivery, type Hook, HOOK_ID, type Received } from "./inbound";

/**
 * Inbound's routes. `/hooks/<id>/<token>` is open to anyone, as the one path under `/hooks/` in Access's BYPASS
 * (src/access.ts): a webhook's sender has no sign-in, only the URL. `/api/inbound/*` is the signed-in user's, for
 * Settings › Webhooks and the chat's cards: hooks, and credentials.
 */

const HOOKS_PATH = "/hooks/";

/** The most a post to a hook may carry. */
export const MAX_HOOK_BYTES = 256 * 1024;

const HOOK_URL = /^\/hooks\/([0-9a-f]{32})\/([0-9a-f]{64})$/;

const vault = (env: Env) => env.Vault.getByName("owner");

const agent = (env: Env) => env.PiAgent.getByName("me");

const notFound = () => new Response("Not found", { status: 404 });

const tooLarge = () => new Response(`A post to a hook is at most ${MAX_HOOK_BYTES / 1024} KB.`, { status: 413 });

const hex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** A post to a hook; undefined for a path outside `/hooks/`. */
export function hookRoute(request: Request, env: Env, url: URL): Promise<Response> | undefined {
  return url.pathname.startsWith(HOOKS_PATH) ? posted(request, env, url) : undefined;
}

/**
 * Limited per address by HOOK_LIMIT, since the route is open to anyone; a token is 256 random bits, so the limit is
 * against floods, not guessing. A wrong id or token is a 404 like any missing page, so a guess learns nothing.
 */
async function posted(request: Request, env: Env, url: URL): Promise<Response> {
  const hook = await admitted(request, env, url);

  if (hook instanceof Response) return hook;

  const body = await capped(request.body, MAX_HOOK_BYTES);

  if (body === null) return tooLarge();

  const signature = request.headers.get("X-Hub-Signature-256");

  if (!(await vault(env).hookSigned(hook.id, hook.signed, body, signature))) return new Response("The signature doesn't match the body.", { status: 401 });

  return RECEIVED[await agent(env).hookReceived(hook.id, deliveryOf(request, url, body, signature))]();
}

/** The hook a post is for, once it is under the limit, addressed right, and its token the hook's; or why not. */
async function admitted(request: Request, env: Env, url: URL): Promise<Hook | Response> {
  const address = request.headers.get("CF-Connecting-IP") ?? "unknown";

  if (!(await env.HOOK_LIMIT.limit({ key: `hook:${address}` })).success) return new Response("Too many posts; wait a minute.", { status: 429 });

  const addressee = addressed(request, url);

  if (addressee instanceof Response) return addressee;

  if ((await vault(env).check("hook", addressee.token)) !== addressee.id) return notFound();

  return (await agent(env).inboundHook(addressee.id)) ?? notFound();
}

/** The id and token a post names, once it is a POST small enough by what it says; or why not. */
function addressed(request: Request, url: URL): { id: string; token: string } | Response {
  const [, id, token] = HOOK_URL.exec(url.pathname) ?? [];

  if (id === undefined || token === undefined) return notFound();

  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });

  // What the sender says first, then what it sends: Content-Length can be left out, or wrong.
  return Number(request.headers.get("Content-Length") ?? 0) > MAX_HOOK_BYTES ? tooLarge() : { id, token };
}

/** A header's value, cut to a label's length; null when it isn't sent. */
const label = (request: Request, name: string) => request.headers.get(name)?.slice(0, 80) ?? null;

/** The headers a sender names each delivery by, sent again with a redelivery: GitHub's, GitLab's, and Standard Webhooks'. */
const DELIVERY_HEADERS = ["X-GitHub-Delivery", "X-Gitlab-Event-UUID", "Webhook-Id"];

function deliveryOf(request: Request, url: URL, body: string, signature: string | null): Delivery {
  return {
    body,
    source: (url.searchParams.get("source") ?? label(request, "User-Agent") ?? "unknown").slice(0, 80),
    event: label(request, "X-GitHub-Event"),
    signature,
    delivery: DELIVERY_HEADERS.map((name) => label(request, name)).find((value) => value !== null) ?? null
  };
}

/** What the sender hears of a post the agent got. */
const RECEIVED: Readonly<Record<Received, () => Response>> = {
  accepted: () => Response.json({ accepted: true }, { status: 202 }),
  replay: () => new Response("This delivery was already received.", { status: 409 }),
  gone: notFound
};

/** The body as text, or null once it passes `max` bytes, read no further. */
async function capped(body: ReadableStream<unknown> | null, max: number): Promise<string | null> {
  if (body === null) return "";

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;

    if (!(value instanceof Uint8Array)) return null;

    size += value.byteLength;

    if (size > max) {
      await reader.cancel();

      return null;
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let at = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }

  return new TextDecoder().decode(bytes);
}

// --- The signed-in user's: Settings › Webhooks, and the chat's cards ---

type Route = {
  readonly method: string;
  readonly path: RegExp;
  /** `param` is the path's one group, when it has one: a hook's id, or a credential's name. */
  readonly run: (request: Request, env: Env, url: URL, param: string) => Promise<Response>;
};

const ROUTES: readonly Route[] = [
  { method: "GET", path: /^\/api\/inbound\/hooks$/, run: (_request, env) => listHooks(env) },
  { method: "POST", path: /^\/api\/inbound\/hooks$/, run: addHook },
  { method: "POST", path: /^\/api\/inbound\/hooks\/([0-9a-f]{32})\/rotate$/, run: (_request, env, url, id) => rotate(env, url, id) },
  { method: "DELETE", path: /^\/api\/inbound\/hooks\/([0-9a-f]{32})$/, run: (_request, env, _url, id) => removeHook(env, id) },
  { method: "GET", path: /^\/api\/inbound\/secrets$/, run: (_request, env) => listSecrets(env) },
  { method: "POST", path: /^\/api\/inbound\/secrets$/, run: (request, env) => saveSecret(request, env) },
  { method: "DELETE", path: /^\/api\/inbound\/secrets\/([A-Za-z][A-Za-z0-9_-]{0,63})$/, run: (_request, env, _url, name) => removeSecret(env, name) },
  { method: "GET", path: /^\/api\/inbound\/asks$/, run: (_request, env, url) => asks(env, url) }
];

/** `/api/inbound/*`, behind Access; undefined for any other path. */
export function inboundRoute(request: Request, env: Env, url: URL): Promise<Response> | undefined {
  if (!url.pathname.startsWith("/api/inbound/")) return undefined;

  const paths = ROUTES.filter((route) => route.path.test(url.pathname));
  const route = paths.find((each) => each.method === request.method);

  if (route === undefined) return paths.length > 0 ? notAllowed() : Promise.resolve(notFound());

  return route.run(request, env, url, route.path.exec(url.pathname)?.[1] ?? "");
}

const notAllowed = () => Promise.resolve(new Response("Method not allowed", { status: 405 }));

const refused = (text: string, status = 400) => new Response(text, { status });

const AddHookBody = Type.Object({ session: Type.String(), label: Type.Optional(Type.String()), signed: Type.Optional(Type.Boolean()) });

const SaveSecretBody = Type.Object({ session: Type.String(), name: Type.String(), value: Type.String() });

/** The request's JSON body as `schema` says, or null for any other body. */
async function bodyOf<Schema extends TSchema>(request: Request, schema: Schema): Promise<Static<Schema> | null> {
  return parseOr(schema, await request.text(), null);
}

async function listHooks(env: Env): Promise<Response> {
  return Response.json(await agent(env).inboundHooks());
}

/** A hook for a chat: its URL, and its signing secret if it is signed, shown this once. */
async function addHook(request: Request, env: Env, url: URL): Promise<Response> {
  const body = await bodyOf(request, AddHookBody);

  if (body === null) return refused("Send { session, label, signed }.");

  const id = hex(16);
  // In the Vault before the hook is kept: a signed hook is never there without its secret.
  const signing = body.signed === true ? await newSigning(env, id) : null;
  const added = await agent(env).addHook(id, body.session, body.label ?? "", signing !== null);

  if ("refused" in added) {
    if (signing !== null) await vault(env).remove("hook-signing", id);

    return refused(added.refused);
  }

  return Response.json({ hook: added, url: await hookUrl(env, url, id), signing });
}

/** A signing secret for hook `id`, kept in the Vault in place of any it had. */
async function newSigning(env: Env, id: string): Promise<string> {
  const signing = hex(32);

  await vault(env).put("hook-signing", id, signing, { hook: id });

  return signing;
}

/**
 * A new token for the hook, and a new signing secret if it is signed: the old URL and secret stop working, and a signed
 * hook whose secret was lost (a restore brings no Vault) works again.
 */
async function rotate(env: Env, url: URL, id: string): Promise<Response> {
  const hook = await agent(env).inboundHook(id);

  if (hook === null) return notFound();

  const signing = hook.signed ? await newSigning(env, id) : null;

  return Response.json({ url: await hookUrl(env, url, id), signing });
}

async function hookUrl(env: Env, url: URL, id: string): Promise<string> {
  return `${url.origin}${HOOKS_PATH}${id}/${await vault(env).mint("hook", id)}`;
}

async function removeHook(env: Env, id: string): Promise<Response> {
  if (!HOOK_ID.test(id) || !(await agent(env).removeHook(id))) return notFound();
  await vault(env).revoke("hook", id);
  await vault(env).remove("hook-signing", id);

  return new Response(null, { status: 204 });
}

async function listSecrets(env: Env): Promise<Response> {
  const secrets = (await vault(env).status()).filter((secret) => secret.kind === HTTP_KIND).map(({ id, meta, updatedAt }) => ({ name: id, ...meta, updatedAt }));

  return Response.json({ secrets });
}

/**
 * What the user typed into a chat's masked field, for an ask still open there: into the Vault, and only the Vault.
 * The agent hears that it was saved, never what.
 */
async function saveSecret(request: Request, env: Env): Promise<Response> {
  const body = await bodyOf(request, SaveSecretBody);

  if (body === null) return refused("Send { session, name, value }.");

  const { session, name, value } = body;

  if (value.length < MIN_VALUE_CHARS || value.length > MAX_VALUE_CHARS) return refused(`A credential is ${MIN_VALUE_CHARS} to ${MAX_VALUE_CHARS} characters.`);
  const ask = await agent(env).secretAsk(session, name);

  if (ask === null) return refused("ky isn't asking for that credential in this chat.", 404);
  const info = { origin: ask.origin, scheme: ask.scheme, header: ask.header, purpose: ask.purpose };
  const bad = badInfo(name, info);

  if (bad) return refused(bad);
  const credential: Credential = { ...info, value };

  await vault(env).put(HTTP_KIND, name, credential, info);
  await agent(env).secretSaved(session, name);

  return new Response(null, { status: 204 });
}

async function removeSecret(env: Env, name: string): Promise<Response> {
  await vault(env).remove(HTTP_KIND, name);

  return new Response(null, { status: 204 });
}

/** The credentials ky is asking for in a chat, which it shows a masked field for. */
async function asks(env: Env, url: URL): Promise<Response> {
  const session = url.searchParams.get("session");

  if (session === null) return refused("Name the chat: ?session=");

  return Response.json({ asks: await agent(env).secretAsks(session) });
}
