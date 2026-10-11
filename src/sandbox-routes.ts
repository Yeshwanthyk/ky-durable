import Type from "typebox";
import { Value } from "typebox/value";
import type { SandboxesView, SavedDisk } from "./protocol";
import { machineSubject } from "./runners";
import { SANDBOX_CAP, saveKey } from "./sandboxes";

/**
 * Settings' routes for sandboxes (src/sandboxes.ts), after the user's sign-in: list them with their
 * saved disks, create one (fresh or from a kept disk), change one, delete one (keeping its disk), and
 * delete a kept disk. The agent keeps the rows; these do what reaches past it: the Vault's token,
 * the container, and R2.
 */

const agent = (env: Env) => env.PiAgent.getByName("me");

const CreateSchema = Type.Object({
  name: Type.String(),
  repos: Type.Optional(Type.Array(Type.String())),
  from: Type.Optional(Type.String())
});

const ChangeSchema = Type.Object({
  repos: Type.Optional(Type.Array(Type.String())),
  idleMinutes: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  isDefault: Type.Optional(Type.Literal(true))
});

const refused = (why: string, status = 400) => Response.json({ refused: why }, { status });

/** The sandbox's saved disk in R2: its size and when it was saved; null with none. */
async function savedDisk(env: Env, id: string): Promise<SavedDisk | null> {
  const head = await env.FILES.head(saveKey(id));

  return head && { size: head.size, savedAt: head.uploaded.getTime() };
}

async function list(env: Env): Promise<Response> {
  const { live, kept } = await agent(env).sandboxList();
  const saves = Object.fromEntries(await Promise.all(live.map(async (sandbox) => [sandbox.id, await savedDisk(env, sandbox.id)] as const)));

  const view: SandboxesView = {
    enabled: Boolean(env.KY_CLOUD),
    cap: SANDBOX_CAP,
    saves,
    kept: await Promise.all(
      kept.map(async (disk) => ({ id: disk.id, name: disk.name, repos: disk.repos, deletedAt: disk.deletedAt ?? 0, save: await savedDisk(env, disk.id) }))
    )
  };

  return Response.json(view);
}

async function create(request: Request, env: Env): Promise<Response> {
  const body: unknown = await request.json().catch(() => undefined);

  if (!Value.Check(CreateSchema, body)) return refused("Send { name, repos?, from? }.");

  // A disk its deleted sandbox still saves to, or whose container still runs, isn't whole yet.
  if (body.from !== undefined && !(await env.CloudMachine.getByName(body.from).settled())) {
    return refused("That disk is still being saved: try again in a minute.", 409);
  }

  try {
    return Response.json(await agent(env).createSandbox(body), { status: 201 });
  } catch (error) {
    return refused((error instanceof Error ? error.message : String(error)), 409);
  }
}

async function change(request: Request, env: Env, id: string): Promise<Response> {
  const body: unknown = await request.json().catch(() => undefined);

  if (!Value.Check(ChangeSchema, body)) return refused("Send { repos?, idleMinutes?, isDefault? }.");

  try {
    return Response.json(await agent(env).changeSandbox(id, body));
  } catch (error) {
    return refused((error instanceof Error ? error.message : String(error)));
  }
}

/**
 * Delete a sandbox: the agent forgets it as a machine, then its token is revoked, then its container,
 * if one runs, saves its disk and stops. Each step runs even if one before it failed; what failed is
 * said. A failed save leaves the last one kept, and the container's alarm tries again.
 */
async function remove(env: Env, id: string): Promise<Response> {
  let deleted: { name: string; pairing: string | null };

  try {
    deleted = await agent(env).deleteSandbox(id);
  } catch (error) {
    return refused((error instanceof Error ? error.message : String(error)), 404);
  }

  const problems: string[] = [];

  try {
    if (deleted.pairing !== null) await env.Vault.getByName("owner").revoke("machine", machineSubject(deleted.name, deleted.pairing));
  } catch (error) {
    console.warn(`the sandbox ${id}'s token wasn't revoked as it was deleted`, error);
    problems.push(`its runner's token wasn't revoked (${(error instanceof Error ? error.message : String(error))}), though ky refuses it, as its pairing is gone`);
  }

  try {
    await env.CloudMachine.getByName(id).retire();
  } catch (error) {
    console.warn(`the sandbox ${id} didn't save its disk as it was deleted`, error);
    problems.push(`its disk didn't save (${(error instanceof Error ? error.message : String(error))}); the last save is kept, and it tries again`);
  }

  return Response.json({ problem: problems.length === 0 ? null : `${deleted.name} is deleted, but ${problems.join("; and ")}.` });
}

/** Delete a kept disk: its row, then a container that still runs, then the save. */
async function forget(env: Env, id: string): Promise<Response> {
  try {
    await agent(env).forgetKeptDisk(id);
  } catch (error) {
    return refused((error instanceof Error ? error.message : String(error)), 404);
  }

  await env.CloudMachine.getByName(id).forget();
  await env.FILES.delete(saveKey(id));

  return new Response(null, { status: 204 });
}

/** The signed-in user's routes for sandboxes; undefined for any other path. */
export function sandboxRoute(request: Request, env: Env, url: URL): Promise<Response> | undefined {
  if (url.pathname === "/api/sandboxes") {
    if (request.method === "GET") return list(env);

    if (request.method === "POST") return create(request, env);

    return Promise.resolve(new Response("Method not allowed", { status: 405 }));
  }

  const kept = /^\/api\/sandboxes\/kept\/([^/]+)$/.exec(url.pathname)?.[1];

  if (kept !== undefined) return request.method === "DELETE" ? forget(env, decodeURIComponent(kept)) : Promise.resolve(new Response("Method not allowed", { status: 405 }));
  const id = /^\/api\/sandboxes\/([^/]+)$/.exec(url.pathname)?.[1];

  if (id === undefined) return undefined;

  if (request.method === "PATCH") return change(request, env, decodeURIComponent(id));

  if (request.method === "DELETE") return remove(env, decodeURIComponent(id));

  return Promise.resolve(new Response("Method not allowed", { status: 405 }));
}
