import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { LOGIN_KIND, type Login } from "./contract";

const cookiesOf = Schema.decodeUnknownOption(Schema.Struct({ cookies: Schema.Number }));

const LOGINS = "/api/browse/logins";

const SITE = /^\/api\/browse\/logins\/([a-z0-9.-]{1,253})$/;

const vault = (env: Env) => env.Vault.getByName("owner");

/** Settings › the sites ky's browser keeps a login for, by site, and Remove: never a cookie's value. */
export function browseRoute(request: Request, env: Env, url: URL): Promise<Response> | undefined {
  if (url.pathname === LOGINS) return request.method === "GET" ? logins(env) : notAllowed();
  const site = SITE.exec(url.pathname)?.[1];

  if (site === undefined) return url.pathname.startsWith(`${LOGINS}/`) ? Promise.resolve(new Response("Not found", { status: 404 })) : undefined;

  return request.method === "DELETE" ? remove(env, site) : notAllowed();
}

const notAllowed = () => Promise.resolve(new Response("Method not allowed", { status: 405 }));

async function logins(env: Env): Promise<Response> {
  const logins = (await vault(env).status()).flatMap(({ kind, id, meta, updatedAt }): Login[] =>
    kind === LOGIN_KIND ? [{ site: id, cookies: Option.getOrElse(Option.map(cookiesOf(meta), (kept) => kept.cookies), () => 0), updatedAt }] : []
  );

  return Response.json({ logins });
}

async function remove(env: Env, site: string): Promise<Response> {
  await vault(env).remove(LOGIN_KIND, site);
  await env.PiAgent.getByName("me").browserForgot();

  return new Response(null, { status: 204 });
}
