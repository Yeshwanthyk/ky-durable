import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ownedId, ownedOf, ownerName, SHARED } from "../skills/contract";
import { badInfo, type Credential, HTTP_KIND, MAX_VALUE_CHARS, MIN_VALUE_CHARS } from "./credentials";
import { type HookDelivery, type Hook, HOOK_ID, type Received } from "./inbound";

const HOOKS_PATH = "/hooks/";

export const MAX_HOOK_BYTES = 256 * 1024;

const HOOK_URL = /^\/hooks\/([0-9a-f]{32})\/([0-9a-f]{64})$/;

const vault = (env: Env) => env.Vault.getByName("owner");

const agent = (env: Env) => env.PiAgent.getByName("me");

const notFound = () => new Response("Not found", { status: 404 });

const tooLarge = () => new Response(`A post to a hook is at most ${MAX_HOOK_BYTES / 1024} KB.`, { status: 413 });

const hex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");

export function hookRoute(request: Request, env: Env, url: URL): Promise<Response> | undefined {
  return url.pathname.startsWith(HOOKS_PATH) ? posted(request, env, url) : undefined;
}

async function posted(request: Request, env: Env, url: URL): Promise<Response> {
  const hook = await admitted(request, env, url);

  if (hook instanceof Response) return hook;

  const body = await capped(request.body, MAX_HOOK_BYTES);

  if (body === null) return tooLarge();

  const signature = request.headers.get("X-Hub-Signature-256");

  if (!(await vault(env).hookSigned(hook.id, hook.signed, body, signature))) return new Response("The signature doesn't match the body.", { status: 401 });

  return RECEIVED[await agent(env).hookReceived(hook.id, deliveryOf(request, url, body, signature))]();
}

async function admitted(request: Request, env: Env, url: URL): Promise<Hook | Response> {
  const address = request.headers.get("CF-Connecting-IP") ?? "unknown";

  if (!(await env.HOOK_LIMIT.limit({ key: `hook:${address}` })).success) return new Response("Too many posts; wait a minute.", { status: 429 });

  const addressee = addressed(request, url);

  if (addressee instanceof Response) return addressee;

  if ((await vault(env).check("hook", addressee.token)) !== addressee.id) return notFound();

  return (await agent(env).inboundHook(addressee.id)) ?? notFound();
}

function addressed(request: Request, url: URL): { id: string; token: string } | Response {
  const [, id, token] = HOOK_URL.exec(url.pathname) ?? [];

  if (id === undefined || token === undefined) return notFound();

  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });

  return Number(request.headers.get("Content-Length") ?? 0) > MAX_HOOK_BYTES ? tooLarge() : { id, token };
}

const label = (request: Request, name: string) => request.headers.get(name)?.slice(0, 80) ?? null;

const DELIVERY_HEADERS = ["X-GitHub-Delivery", "X-Gitlab-Event-UUID", "Webhook-Id"];

function deliveryOf(request: Request, url: URL, body: string, signature: string | null): HookDelivery {
  return {
    body,
    source: (url.searchParams.get("source") ?? label(request, "User-Agent") ?? "unknown").slice(0, 80),
    event: label(request, "X-GitHub-Event"),
    signature,
    delivery: DELIVERY_HEADERS.map((name) => label(request, name)).find((value) => value !== null) ?? null
  };
}

const RECEIVED: Readonly<Record<Received, () => Response>> = {
  accepted: () => Response.json({ accepted: true }, { status: 202 }),
  replay: () => new Response("This delivery was already received.", { status: 409 }),
  gone: notFound
};

export async function capped(body: ReadableStream<unknown> | null, max: number): Promise<string | null> {
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

/** A key by its owner ("ky", a specialist's id, or "*" for shared) and name: `/api/inbound/secrets/<owner>/<name>`. */
const KEY_PATH = /^\/api\/inbound\/secrets\/([a-z0-9*][a-z0-9_-]*\/[A-Za-z][A-Za-z0-9_-]{0,63})$/;

const KEY_MOVE_PATH = /^\/api\/inbound\/secrets\/([a-z0-9*][a-z0-9_-]*\/[A-Za-z][A-Za-z0-9_-]{0,63})\/move$/;

/** The Vault id of the key a route names as `<owner>/<name>`: its owner, then its name. */
const keyAt = (path: string) => path.replace("/", ":");

type Route = {
  readonly method: string;
  readonly path: RegExp;
  readonly run: (request: Request, env: Env, url: URL, param: string) => Promise<Response>;
};

const ROUTES: readonly Route[] = [
  { method: "GET", path: /^\/api\/inbound\/hooks$/, run: (_request, env) => listHooks(env) },
  { method: "POST", path: /^\/api\/inbound\/hooks$/, run: addHook },
  { method: "POST", path: /^\/api\/inbound\/hooks\/([0-9a-f]{32})\/rotate$/, run: (_request, env, url, id) => rotate(env, url, id) },
  { method: "DELETE", path: /^\/api\/inbound\/hooks\/([0-9a-f]{32})$/, run: (_request, env, _url, id) => removeHook(env, id) },
  { method: "GET", path: /^\/api\/inbound\/secrets$/, run: (_request, env) => listSecrets(env) },
  { method: "POST", path: /^\/api\/inbound\/secrets$/, run: (request, env) => saveSecret(request, env) },
  { method: "DELETE", path: KEY_PATH, run: (_request, env, _url, key) => removeSecret(env, key) },
  { method: "POST", path: KEY_MOVE_PATH, run: (request, env, _url, key) => moveSecret(request, env, key) },
  { method: "GET", path: /^\/api\/inbound\/asks$/, run: (_request, env, url) => asks(env, url) }
];

export function inboundRoute(request: Request, env: Env, url: URL): Promise<Response> | undefined {
  if (!url.pathname.startsWith("/api/inbound/")) return undefined;

  const paths = ROUTES.filter((route) => route.path.test(url.pathname));
  const route = paths.find((each) => each.method === request.method);

  if (route === undefined) return paths.length > 0 ? notAllowed() : Promise.resolve(notFound());

  return route.run(request, env, url, route.path.exec(url.pathname)?.[1] ?? "");
}

const notAllowed = () => Promise.resolve(new Response("Method not allowed", { status: 405 }));

const refused = (text: string, status = 400) => new Response(text, { status });

const addHookBodyOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ session: Schema.String, label: Schema.optionalKey(Schema.String), signed: Schema.optionalKey(Schema.Boolean) }))
);

const saveSecretBodyOf = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ session: Schema.String, name: Schema.String, value: Schema.String })));

async function listHooks(env: Env): Promise<Response> {
  return Response.json(await agent(env).inboundHooks());
}

async function addHook(request: Request, env: Env, url: URL): Promise<Response> {
  const body = Option.getOrNull(addHookBodyOf(await request.text()));

  if (body === null) return refused("Send { session, label, signed }.");

  const id = hex(16);
  const signing = body.signed === true ? await newSigning(env, id) : null;
  const added = await agent(env).addHook(id, body.session, body.label ?? "", signing !== null);

  if ("refused" in added) {
    if (signing !== null) await vault(env).remove("hook-signing", id);

    return refused(added.refused);
  }

  return Response.json({ hook: added, url: await hookUrl(env, url, id), signing });
}

async function newSigning(env: Env, id: string): Promise<string> {
  const signing = hex(32);

  await vault(env).put("hook-signing", id, signing, { hook: id });

  return signing;
}

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
  const secrets = (await vault(env).status()).flatMap(({ kind, id, meta, updatedAt }) => (kind === HTTP_KIND ? [{ ...ownedOf(id), ...meta, updatedAt }] : []));

  return Response.json({ secrets, owners: await agent(env).owners() });
}

async function saveSecret(request: Request, env: Env): Promise<Response> {
  const body = Option.getOrNull(saveSecretBodyOf(await request.text()));

  if (body === null) return refused("Send { session, name, value }.");

  const { session, name, value } = body;

  if (value.length < MIN_VALUE_CHARS || value.length > MAX_VALUE_CHARS) return refused(`A credential is ${MIN_VALUE_CHARS} to ${MAX_VALUE_CHARS} characters.`);
  const ask = await agent(env).secretAsk(session, name);

  if (ask === null) return refused("ky isn't asking for that credential in this chat.", 404);
  const info = { origin: ask.origin, scheme: ask.scheme, header: ask.header, purpose: ask.purpose };
  const bad = badInfo(name, info);

  if (bad) return refused(bad);
  const credential: Credential = { ...info, value };

  await vault(env).put(HTTP_KIND, ownedId(ask.owner, name), credential, info);
  await agent(env).secretSaved(session, name);

  return new Response(null, { status: 204 });
}

async function removeSecret(env: Env, key: string): Promise<Response> {
  await vault(env).remove(HTTP_KIND, keyAt(key));

  return new Response(null, { status: 204 });
}

const moveBodyOf = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ to: Schema.String })));

/** The user gives a key to another owner, or shares it with every owner ("*"). One off an owner that is gone moves too. */
async function moveSecret(request: Request, env: Env, key: string): Promise<Response> {
  const to = Option.getOrNull(moveBodyOf(await request.text()))?.to;

  if (to === undefined) return refused("Send { to }: ky, a specialist's id, or * for every owner.");

  if (to !== SHARED && !(await agent(env).owners()).includes(to)) return refused(`There is no specialist @${to}.`, 404);
  const { owner, name } = ownedOf(keyAt(key));

  if ((await vault(env).status()).some((secret) => secret.kind === HTTP_KIND && secret.id === ownedId(to, name))) {
    return refused(to === SHARED ? `A shared key ${name} is already kept: remove it first.` : `${ownerName(to)} already keeps a key ${name}: remove that one first.`, 409);
  }

  return (await vault(env).move(HTTP_KIND, keyAt(key), ownedId(to, name))) ? new Response(null, { status: 204 }) : refused(`${ownerName(owner)} has no key ${name}.`, 404);
}

async function asks(env: Env, url: URL): Promise<Response> {
  const session = url.searchParams.get("session");

  if (session === null) return refused("Name the chat: ?session=");

  return Response.json({ asks: await agent(env).secretAsks(session) });
}
