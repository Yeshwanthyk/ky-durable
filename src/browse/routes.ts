import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { isRefusal } from "../core/refusal";
import { ownedId } from "../skills/contract";
import { LOGIN_KIND, type Login, MoveLogin, ownedLogin } from "./contract";

const cookiesOf = Schema.decodeUnknownOption(Schema.Struct({ cookies: Schema.Number }));

const moveOf = Schema.decodeUnknownOption(Schema.fromJsonString(MoveLogin));

const LOGINS = "/api/browse/logins";

/** `/api/browse/logins/<owner>/<site>`, and `/move` after it. */
const ONE = /^\/api\/browse\/logins\/([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9.-]{1,253})(\/move)?$/;

const vault = (env: Env) => env.Vault.getByName("owner");

const agent = (env: Env) => env.PiAgent.getByName("me");

/** Settings › the sites each owner's browser keeps a login for, Remove, and Move to: never a cookie's value. */
export function browseRoute(request: Request, env: Env, url: URL): Promise<Response> | undefined {
  if (url.pathname === LOGINS) return request.method === "GET" ? logins(env) : notAllowed();
  const [, owner, site, moving] = ONE.exec(url.pathname) ?? [];

  if (owner === undefined || site === undefined) return url.pathname.startsWith(`${LOGINS}/`) ? Promise.resolve(new Response("Not found", { status: 404 })) : undefined;

  if (moving !== undefined) return request.method === "POST" ? move(request, env, owner, site) : notAllowed();

  return request.method === "DELETE" ? remove(env, owner, site) : notAllowed();
}

const notAllowed = () => Promise.resolve(new Response("Method not allowed", { status: 405 }));

async function logins(env: Env): Promise<Response> {
  const logins = (await vault(env).status()).flatMap(({ kind, id, meta, updatedAt }): Login[] =>
    kind === LOGIN_KIND ? [{ ...ownedLogin(id), cookies: Option.getOrElse(Option.map(cookiesOf(meta), (kept) => kept.cookies), () => 0), updatedAt }] : []
  );

  return Response.json({ logins, owners: await agent(env).owners() });
}

async function remove(env: Env, owner: string, site: string): Promise<Response> {
  await vault(env).remove(LOGIN_KIND, ownedId(owner, site));
  await agent(env).browserForgot(owner);

  return new Response(null, { status: 204 });
}

async function move(request: Request, env: Env, owner: string, site: string): Promise<Response> {
  const asked = moveOf(await request.text());

  if (Option.isNone(asked)) return new Response("Say whom to move it to.", { status: 400 });
  const moved = await agent(env).browserMoved(owner, site, asked.value.to);

  return isRefusal(moved) ? new Response(moved.refused, { status: 409 }) : Response.json(moved);
}
