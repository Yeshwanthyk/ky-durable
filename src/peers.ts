import { type Static, Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { bearer } from "./runners";
import type { Vault } from "./vault";

/**
 * Peers: other people's kys this one is paired with (docs/multiplayer-shaping.md, X1). The user
 * makes a code with `peer invite`, and gives it, with this ky's address, to the other person, whose
 * ky pairs with `peer pair`. Each side names the other its own way.
 *
 * Pairing swaps two tokens, as a runner's pairing does (src/runners.ts): each ky mints the token the
 * other calls it with, and keeps only its hash in the Vault; the token it calls the other with is a
 * secret in its Vault, ("peer", name). Removing a peer revokes the token it calls with, so its next
 * call is refused with 401, and its ky shows this one as revoked.
 *
 * The routes under PEER_PATH are open to the internet (src/access.ts BYPASS), and check their own
 * tokens: the pair route takes only an invite code, at most PAIR_LIMIT times a minute from one address.
 */

const PEER_PATH = "/peer/v1";

/** How long an invite code works. */
const INVITE_TTL_MS = 10 * 60_000;

/** How long a call to another ky may take. */
const CALL_TIMEOUT_MS = 15_000;

/** A peer's name: lowercase letters, digits and dashes, up to 32, as a machine's. */
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** A token the Vault mints: 32 random bytes as hex. */
const Token = Type.String({ pattern: "^[0-9a-f]{64}$" });

/** What another ky sends the pair route: the invite code, its address, and the token this ky will call it with. */
const PairBody = Type.Object({ code: Type.String(), address: Type.String(), token: Token });

/** What the pair route answers: the token to call that ky with. */
const Paired = Type.Object({ token: Token });

export type PeerState = "on" | "revoked";

export type PeerRow = { readonly name: string; readonly address: string; readonly state: PeerState; readonly created_at: number };

/** Where a ky's peer routes keep their state: its agent and its Vault, by name. */
export type PeerHome = { readonly agent: string; readonly vault: string };

const HOME: PeerHome = { agent: "me", vault: "owner" };

/** The peers this ky is paired with. */
export class Peers {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_peers (
      name TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL)`);
  }

  list(): PeerRow[] {
    return this.#sql.exec<PeerRow>("SELECT * FROM ky_peers ORDER BY name").toArray();
  }

  get(name: string): PeerRow | undefined {
    return this.#sql.exec<PeerRow>("SELECT * FROM ky_peers WHERE name = ?", name).toArray()[0];
  }

  /** Keep a new peer; false when the name is taken. */
  add(name: string, address: string): boolean {
    return (
      this.#sql
        .exec("INSERT INTO ky_peers (name, address, state, created_at) VALUES (?, ?, 'on', ?) ON CONFLICT (name) DO NOTHING RETURNING name", name, address, Date.now())
        .toArray().length > 0
    );
  }

  revoked(name: string): void {
    this.#sql.exec("UPDATE ky_peers SET state = 'revoked' WHERE name = ?", name);
  }

  remove(name: string): void {
    this.#sql.exec("DELETE FROM ky_peers WHERE name = ?", name);
  }
}

/** A ky's address, its origin, from what the user typed: https, or http on localhost; undefined for anything else. */
function peerAddress(text: string): string | undefined {
  let url: URL;

  try {
    url = new URL(text.trim());
  } catch {
    return undefined;
  }

  const local = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);

  return url.protocol === "https:" || local ? url.origin : undefined;
}

// --- The routes another ky calls ---

const vaultOf = (env: Env, home: PeerHome) => env.Vault.getByName(home.vault);

const agentOf = (env: Env, home: PeerHome) => env.PiAgent.getByName(home.agent);

/** A pairing another ky asks for, read: its body and address, or the answer that refuses it. */
async function pairRequest(request: Request, env: Env): Promise<Response | { body: Static<typeof PairBody>; address: string }> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  if (!(await env.PAIR_LIMIT.limit({ key: `peer:${request.headers.get("CF-Connecting-IP") ?? "unknown"}` })).success) {
    return new Response("Too many pairing attempts; wait a minute.", { status: 429 });
  }

  const body: unknown = await request.json().catch(() => undefined);
  const address = Value.Check(PairBody, body) ? peerAddress(body.address) : undefined;

  return Value.Check(PairBody, body) && address
    ? { body, address }
    : new Response("Send { code, address, token }: the invite code, your ky's https address, and your token.", { status: 400 });
}

/**
 * Another ky pairs with an invite code: it sends the token this ky will call it with, and gets the
 * one it will call this ky with. The code is used up first, so a refusal after it still costs it.
 */
async function pair(request: Request, env: Env, home: PeerHome): Promise<Response> {
  const asked = await pairRequest(request, env);

  if (asked instanceof Response) return asked;
  const { body, address } = asked;
  const vault = vaultOf(env, home);
  const name = await vault.consume("peer-invite", body.code);

  if (name === null) return new Response("That code is wrong, used or expired. Ask for a new one.", { status: 401 });

  if (!(await agentOf(env, home).peerJoined(name, address))) return new Response(`This ky already has a peer named ${name}.`, { status: 409 });

  try {
    await vault.put("peer", name, body.token);

    return Response.json({ token: await vault.mint("peer", name) });
  } catch (error) {
    await agentOf(env, home).peerLeft(name);
    throw error;
  }
}

/** Whether ky still takes a peer's token: 204, or 401. */
async function ping(request: Request, env: Env, home: PeerHome): Promise<Response> {
  const token = bearer(request);
  const name = token ? await vaultOf(env, home).check("peer", token) : null;

  return name === null ? new Response("Unauthorized", { status: 401 }) : new Response(null, { status: 204 });
}

/** The peer routes, which take their own tokens, never the user's sign-in; undefined for any other path. */
export function peerRoute(request: Request, env: Env, url: URL, home: PeerHome = HOME): Promise<Response> | undefined {
  if (url.pathname === `${PEER_PATH}/pair`) return pair(request, env, home);

  if (url.pathname === `${PEER_PATH}/ping`) return ping(request, env, home);

  return url.pathname.startsWith("/peer/") ? Promise.resolve(new Response("Not found", { status: 404 })) : undefined;
}

// --- The peer tool ---

/** What the peer tool works with: the peers, the Vault, how it reaches other kys, and this ky's own address. */
export type PeerDesk = {
  readonly peers: Peers;
  readonly vault: () => DurableObjectStub<Vault>;
  readonly fetch: typeof fetch;
  readonly origin: () => string | null;
};

type PeerArgs = { action: "invite" | "pair" | "list" | "remove"; name?: string; address?: string; code?: string };

/** Why a step of pairing stopped, in words for the user. */
type Refused = { readonly refused: string };

const taken = (name: string) => `There is already a peer named ${name}. Remove it first, or pick another name.`;

const NO_ORIGIN = "This ky doesn't know its own address yet. Open it in a browser once, then try again.";

async function invite(desk: PeerDesk, name: string): Promise<string> {
  const origin = desk.origin();

  if (!origin) return NO_ORIGIN;

  if (desk.peers.get(name)) return taken(name);
  const code = await desk.vault().mint("peer-invite", name, INVITE_TTL_MS);

  return [
    `Give the other person this ky's address and the code. It works once, within 10 minutes.`,
    `Address: ${origin}`,
    `Code: ${code}`,
    `On their ky, they say: pair with <a name for this ky>, ${origin} ${code}`
  ].join("\n");
}

/** Why another ky refused a pairing, in words for the user. */
function refusal(status: number, address: string, said: string): string {
  if (status === 401) return "That code is wrong, used or expired. Ask for a new one.";

  if (status === 409 || status === 429) return `${address} refused: ${said}`;

  return `${address} answered ${status}${status === 404 ? ": it may not be a ky, or one too old for peers." : "."}`;
}

/** Where to pair: this ky's address and the other's, or why not. */
function pairing(desk: PeerDesk, name: string, typed: string): { origin: string; address: string } | Refused {
  const origin = desk.origin();
  const address = peerAddress(typed);

  if (!origin) return { refused: NO_ORIGIN };

  if (!address) return { refused: `${typed} isn't a ky's address: it starts with https://.` };

  if (address === origin) return { refused: "That is this ky's own address." };

  return desk.peers.get(name) ? { refused: taken(name) } : { origin, address };
}

/** Ask the ky at `address` to pair, sending the token it will call this ky with: the token to call it with, or why not. */
async function askToPair(desk: PeerDesk, address: string, body: Static<typeof PairBody>): Promise<{ token: string } | Refused> {
  let response: Response;

  try {
    response = await desk.fetch(`${address}${PEER_PATH}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
    });
  } catch (error) {
    return { refused: `ky couldn't reach ${address}: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (!response.ok) return { refused: refusal(response.status, address, await response.text()) };
  const answer: unknown = await response.json().catch(() => undefined);

  return Value.Check(Paired, answer) ? answer : { refused: `${address} answered, but not as a ky pairing does.` };
}

async function pairWith(desk: PeerDesk, name: string, typed: string, code: string): Promise<string> {
  const where = pairing(desk, name, typed);

  if ("refused" in where) return where.refused;
  const vault = desk.vault();
  const asked = await askToPair(desk, where.address, { code: code.trim(), address: where.origin, token: await vault.mint("peer", name) });

  // A pairing that failed, or whose name another took meanwhile, leaves no token behind.
  if ("refused" in asked || !desk.peers.add(name, where.address)) {
    await vault.revoke("peer", name);

    return "refused" in asked ? asked.refused : taken(name);
  }

  await vault.put("peer", name, asked.token);

  return `Paired with ${name} (${where.address}).`;
}

/** Forget a peer's tokens, both ways: it can no longer reach this ky, nor this ky it. */
async function forget(desk: PeerDesk, name: string): Promise<void> {
  await desk.vault().revoke("peer", name);
  await desk.vault().remove("peer", name);
}

/** Whether a peer still takes this ky's token; a 401 means it unpaired, so this side is revoked too. */
async function check(desk: PeerDesk, peer: PeerRow): Promise<string> {
  if (peer.state === "revoked") return "revoked";
  const token = await desk.vault().peerToken(peer.name);

  try {
    const response = await desk.fetch(`${peer.address}${PEER_PATH}/ping`, {
      headers: { Authorization: `Bearer ${token ?? ""}` },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
    });

    await response.body?.cancel();

    if (response.ok) return "on";

    if (response.status !== 401) return `unreachable (it answered ${response.status})`;
  } catch (error) {
    return `unreachable (${error instanceof Error ? error.message : String(error)})`;
  }

  desk.peers.revoked(peer.name);
  await forget(desk, peer.name);

  return "revoked";
}

async function list(desk: PeerDesk): Promise<string> {
  const peers = desk.peers.list();

  if (peers.length === 0) return "No peers yet. To pair with someone's ky, make a code with invite, or pair with theirs.";
  const lines = await Promise.all(peers.map(async (peer) => `- ${peer.name}, ${peer.address}: ${await check(desk, peer)}`));

  return [...lines, "A revoked peer unpaired, or was removed; remove it here too, and pair again to talk to it."].join("\n");
}

async function unpair(desk: PeerDesk, name: string): Promise<string> {
  if (!desk.peers.get(name)) return `No peer named ${name}.`;
  await forget(desk, name);
  desk.peers.remove(name);

  return `Removed ${name}: it can no longer reach this ky. Its ky shows this one as revoked.`;
}

async function dispatch(desk: PeerDesk, { action, name, address, code }: PeerArgs): Promise<string> {
  if (action === "list") return list(desk);

  if (!name || !NAME.test(name)) return `${action} needs a name: lowercase letters, digits and dashes, up to 32.`;

  if (action === "invite") return invite(desk, name);

  if (action === "remove") return unpair(desk, name);

  if (!address || !code) return "pair needs the address and the code the other person gave.";

  return pairWith(desk, name, address, code);
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

/** The peer tool, for the main chat and the side chats only: `chat` says which conversations those are. */
export function peerExtension(desk: PeerDesk, chat: (session: string) => boolean): Extension {
  return defineExtension({
    name: "peers",
    tools: [
      defineTool({
        name: "peer",
        description:
          "Other people's kys this ky is paired with, called peers. Pair, list and remove only when the user asks. " +
          "Actions: invite (name: what to call their ky): a code and this ky's address for the user to give the other person; it works once, within 10 minutes. " +
          "pair (name: what to call their ky; address and code: what the other person gave the user). " +
          "list: each peer, and whether the link still works. remove (name): unpair, both ways.",
        parameters: Type.Object({
          action: Type.Union([Type.Literal("invite"), Type.Literal("pair"), Type.Literal("list"), Type.Literal("remove")]),
          name: Type.Optional(Type.String()),
          address: Type.Optional(Type.String()),
          code: Type.Optional(Type.String())
        }),
        replay: "unsafe",
        execute: async (args, api) =>
          text(chat(String(api.conversationId)) ? await dispatch(desk, args) : "Only the main chat and side chats manage peers.")
      })
    ]
  });
}
