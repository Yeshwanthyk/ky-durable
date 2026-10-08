import { upload } from "./files";
import { isMachineFacts, isMachineName, isPairRequest, PAIRING_HEADER, RUNNER_PATH, runnerPathMachine } from "./runner-protocol";

/**
 * Runners' routes. A machine pairs once with a code the user makes in ky,
 * and gets a machine token for its socket; each run hands its task a task
 * token for the task's uploads. All three are the Vault's: it keeps only
 * their hashes and checks them, so these routes never compare or keep a
 * token themselves.
 *
 * A machine token's subject is `<machine>:<pairing>`: each pairing gets a
 * new id, which the agent keeps as the machine's, so a token of an earlier
 * pairing, or of a removed machine, opens no socket even in the moment
 * between the Worker checking it and the agent taking the socket.
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

/** The subject of the machine token minted for a pairing. Machine names have no colon. */
const machineSubject = (machine: string, pairing: string) => `${machine}:${pairing}`;

/** A runner's socket, for the machine its token was minted for; the agent tags it as that machine. */
async function runnerSocket(request: Request, env: Env, url: URL): Promise<Response> {
  const machine = runnerPathMachine(url.pathname);

  if (!machine) return new Response("Not found", { status: 404 });
  const token = bearer(request);
  const subject = token ? await vault(env).check("machine", token) : null;
  const [owner, pairing] = subject?.split(":") ?? [];

  // Before the upgrade check, so a plain GET tells a runner whether ky still takes its token.
  if (owner !== machine || pairing === undefined) return unauthorized();

  if (request.headers.get("Upgrade") !== "websocket") return new Response("Upgrade Required", { status: 426 });
  // The token has done its job; the agent never sees it, only which pairing it was minted for.
  const headers = new Headers(request.headers);
  headers.delete("Authorization");
  headers.set(PAIRING_HEADER, pairing);

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

  // The agent takes the new pairing first: from then on, a token of the name's last pairing opens nothing.
  const pairing = crypto.randomUUID();
  const previous = await agent(env).pairMachine(body.name, body.facts, pairing);

  if (previous !== null) await vault(env).revoke("machine", machineSubject(body.name, previous));
  const token = await vault(env).mint("machine", machineSubject(body.name, pairing));

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
  if (url.pathname === "/api/runners/codes") {
    return request.method === "POST" ? newCode(env) : Promise.resolve(new Response("Method not allowed", { status: 405 }));
  }

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

/** Forget the machine, then revoke its token: its socket closes, and its runner must pair again. */
async function remove(env: Env, machine: string): Promise<Response> {
  if (!isMachineName(machine)) return new Response("Not found", { status: 404 });
  const removed = await agent(env).removeMachine(machine);

  if (!removed) return new Response(`No machine ${machine}.`, { status: 404 });

  if (removed.pairing !== null) await vault(env).revoke("machine", machineSubject(machine, removed.pairing));

  return new Response(null, { status: 204 });
}
