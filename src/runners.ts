import { upload } from "./files";
import { isMachineFacts, isMachineName, isPairRequest, RUNNER_PATH, runnerPathMachine } from "./runner-protocol";

/**
 * Runners' routes. A machine pairs once with a code the user makes in ky,
 * and gets a machine token for its socket; each run hands its task a task
 * token for the task's uploads. All three are the Vault's: it keeps only
 * their hashes and checks them, so these routes never compare or keep a
 * token themselves.
 *
 * `tokenRoute` answers before the user's sign-in, and takes only these
 * tokens; `ownerRoute` comes after it.
 */

/** How long a pairing code works. */
const CODE_TTL_MS = 10 * 60_000;

const vault = (env: Env) => env.Vault.getByName("owner");

const agent = (env: Env) => env.PiAgent.getByName("me");

/** The bearer token a request carries; runners and tasks send no cookie. */
function bearer(request: Request): string | undefined {
  const header = request.headers.get("Authorization");

  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

const unauthorized = () => new Response("Unauthorized", { status: 401 });

/** A runner's socket, for the machine its token was minted for; the agent tags it as that machine. */
async function runnerSocket(request: Request, env: Env, url: URL): Promise<Response> {
  const machine = runnerPathMachine(url.pathname);

  if (!machine) return new Response("Not found", { status: 404 });
  const token = bearer(request);

  // Before the upgrade check, so a plain GET tells a runner whether ky still takes its token.
  if (!token || (await vault(env).check("machine", token)) !== machine) return unauthorized();

  if (request.headers.get("Upgrade") !== "websocket") return new Response("Upgrade Required", { status: 426 });
  // The token has done its job; the agent never sees it.
  const headers = new Headers(request.headers);
  headers.delete("Authorization");

  return agent(env).fetch(new Request(request, { headers }));
}

/** A file a task shares, with that task's own token. */
async function taskUpload(request: Request, env: Env, url: URL): Promise<Response> {
  const task = url.searchParams.get("task");
  const token = bearer(request);

  if (!task || !token || (await vault(env).check("task", token)) !== task) return unauthorized();

  return upload(request, env.FILES, (file) => agent(env).attachFile(file));
}

/**
 * A code for a machine token. Limited per address by PAIR_LIMIT, a Workers
 * rate limit, since this route is open to anyone; a code is 256 random bits,
 * so the limit is against floods, not guessing.
 */
async function pair(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const address = request.headers.get("CF-Connecting-IP") ?? "unknown";

  if (!(await env.PAIR_LIMIT.limit({ key: address })).success) {
    return new Response("Too many pairing attempts; wait a minute.", { status: 429 });
  }

  const body: unknown = await request.json().catch(() => undefined);

  if (!isPairRequest(body)) {
    return new Response("Send { code, name, facts }; a name is lowercase letters, digits and dashes, up to 32.", { status: 400 });
  }

  if (!isMachineFacts(body.facts)) return new Response("facts is not what a runner says about its machine.", { status: 400 });

  if ((await vault(env).consume("pair", body.code)) === null) {
    return new Response("That code is wrong, used or expired. Make a new one in ky.", { status: 401 });
  }

  // A name paired before gets a new token, and the old one stops working.
  const token = await vault(env).mint("machine", body.name);
  await agent(env).pairMachine(body.name, body.facts);

  return Response.json({ machine: body.name, token });
}

/** Runners' routes that take their own tokens, never the user's sign-in; undefined for any other path. */
export function tokenRoute(request: Request, env: Env, url: URL): Promise<Response> | undefined {
  if (url.pathname.startsWith(RUNNER_PATH)) return runnerSocket(request, env, url);

  if (url.pathname === "/api/runners/pair") return pair(request, env);

  if (url.pathname === "/api/files") return taskUpload(request, env, url);

  return undefined;
}

/** The signed-in user's routes for machines: a pairing code, and removing a machine; undefined for any other. */
export function ownerRoute(request: Request, env: Env, url: URL): Promise<Response> | undefined {
  if (url.pathname === "/api/runners/codes" && request.method === "POST") return newCode(env);

  const machine = /^\/api\/runners\/([^/]+)$/.exec(url.pathname)?.[1];

  if (machine !== undefined && request.method === "DELETE") return remove(env, machine);

  return undefined;
}

/** A single-use code that pairs one machine within ten minutes. */
async function newCode(env: Env): Promise<Response> {
  const expiresAt = Date.now() + CODE_TTL_MS;
  const code = await vault(env).mint("pair", crypto.randomUUID(), CODE_TTL_MS);

  return Response.json({ code, expiresAt });
}

/** Revoke the machine's token, then forget it: its socket closes, and its runner must pair again. */
async function remove(env: Env, machine: string): Promise<Response> {
  if (!isMachineName(machine)) return new Response("Not found", { status: 404 });
  await vault(env).revoke("machine", machine);

  return (await agent(env).removeMachine(machine))
    ? new Response(null, { status: 204 })
    : new Response(`No machine ${machine}.`, { status: 404 });
}
