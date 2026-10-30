import type { JsonObject } from "@earendil-works/pi-ai";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";
import { type ApprovalRequest, Approvals } from "../../../src/approvals/approvals";
import type { ApprovalAction } from "../../../src/approvals/contract";
import { type Credential, credentialFetch, type CredentialInfo, type CredentialRequest, HTTP_KIND, signedWith } from "../../../src/inbound/credentials";
import { type HookDelivery, Inbound } from "../../../src/inbound/inbound";
import { hookRoute, inboundRoute } from "../../../src/inbound/routes";
import type { Json } from "../kit";
import { storageOf } from "../skills/storage";

export const START = Date.UTC(2026, 0, 1);

export const SEEN_MS = 7 * 24 * 60 * 60_000;

export const PASS_MS = 15 * 60_000;

export const HOOK_CAP = 256 * 1024;

export const TIMEOUT_MS = 30_000;

export const ORIGIN = "https://api.example.com";

export const VALUE = "sk-live-0123456789:pass/word+=";

type Desk = ConstructorParameters<typeof Inbound>[1];

const CHATS = new Set(["0", "1"]);

const HOOK_IDS = ["0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210", "not-a-hook"] as const;

const LABELS = ["Deploys", "  ", "x".repeat(100), "a [b]\nc"] as const;

const ADD_BODIES = [
  JSON.stringify({ session: "0", label: "GitHub", signed: true }),
  JSON.stringify({ session: "1", label: "Plain", signed: false }),
  JSON.stringify({ session: "0" }),
  JSON.stringify({ session: "2", signed: true }),
  JSON.stringify({ session: "0", label: null }),
  JSON.stringify({ session: "0", signed: "yes" }),
  JSON.stringify({ session: 0 }),
  JSON.stringify({ session: "1", label: "Extra", extra: 1 }),
  "not json"
] as const;

const NAMES = ["API_KEY", "gh", "1bad"] as const;

const BEARER: CredentialInfo = { origin: ORIGIN, scheme: "bearer", header: null, purpose: "the API" };

const INFOS: ReadonlyArray<CredentialInfo> = [
  BEARER,
  { origin: ORIGIN, scheme: "basic", header: null, purpose: "basic" },
  { origin: ORIGIN, scheme: "header", header: "X-Api-Key", purpose: "a header" },
  { origin: ORIGIN, scheme: "header", header: null, purpose: "no header" },
  { origin: "http://api.example.com", scheme: "bearer", header: null, purpose: "plain http" },
  { origin: `${ORIGIN}/v1`, scheme: "bearer", header: null, purpose: "a path" }
];

const VALUES = [VALUE, "abc", "abcd", "x".repeat(8_192), "x".repeat(8_193)] as const;

const URLS = [`${ORIGIN}/v1/me`, "https://evil.example.com/v1/me", "http://api.example.com/v1/me", "https://user:pw@api.example.com/", "not a url"] as const;

const ARGS: ReadonlyArray<JsonObject> = [{ path: "/a" }, { path: "/b", n: 1 }, {}];

const TOOLS = ["write", "bash"] as const;

const FETCHES = ["ok", "echo", "redirect", "throw", "long"] as const;

const SIGNATURES = ["good", "bad", "none", "malformed"] as const;

const SIZES = ["small", "cap", "over"] as const;

type HookAction =
  | { readonly addHook: number }
  | { readonly add: number; readonly session: string; readonly label: number; readonly signed: boolean }
  | { readonly rotate: number }
  | { readonly remove: number }
  | { readonly listHooks: true };

type PostAction =
  | {
      readonly post: number;
      readonly token: "own" | "other" | "bad";
      readonly method: "POST" | "GET";
      readonly size: (typeof SIZES)[number];
      readonly lies: boolean;
      readonly signature: (typeof SIGNATURES)[number];
      readonly delivery: string | null;
      readonly body: string;
    }
  | { readonly limited: boolean };

type SecretAction =
  | { readonly ask: string; readonly name: number; readonly info: number }
  | { readonly save: string; readonly name: number; readonly value: number; readonly raw: boolean; readonly fresh: boolean }
  | { readonly asks: string | null }
  | { readonly listSecrets: true }
  | { readonly removeSecret: number };

type InputAction =
  | { readonly place: string; readonly request: "hook" | "decided" | "card" | "user" | "approval" }
  | { readonly newRun: string }
  | { readonly guarded: string };

type DecisionAction =
  | { readonly askApproval: "webhook-action" | "secret-request"; readonly conversation: string; readonly tool: number; readonly args: number; readonly url: number; readonly good: boolean }
  | { readonly decide: number; readonly action: ApprovalAction }
  | { readonly passed: string; readonly tool: number; readonly args: number; readonly fresh: boolean };

type CallAction =
  | { readonly fetch: (typeof FETCHES)[number] }
  | { readonly http: number; readonly url: number; readonly method: "GET" | "POST"; readonly fresh: boolean };

export type Action = HookAction | PostAction | SecretAction | InputAction | DecisionAction | CallAction;

const keyed =
  <A extends Action>(keys: readonly string[]) =>
  (action: Action): action is A =>
    keys.some((key) => key in action);

const isHook = keyed<HookAction>(["addHook", "add", "rotate", "remove", "listHooks"]);

const isPost = keyed<PostAction>(["post", "limited"]);

const isSecret = keyed<SecretAction>(["ask", "save", "asks", "listSecrets", "removeSecret"]);

const isInput = keyed<InputAction>(["place", "newRun", "guarded"]);

const isApproval = keyed<DecisionAction>(["askApproval", "decide", "passed"]);

export function useTimingSafeEqual(): void {
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    configurable: true,
    value: (a: ArrayBufferView, b: ArrayBufferView) => timingSafeEqual(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), new Uint8Array(b.buffer, b.byteOffset, b.byteLength))
  });
}

const textOf = Schema.decodeUnknownOption(Schema.String);

const credentialOf = Schema.decodeUnknownOption(
  Schema.Struct({ origin: Schema.String, scheme: Schema.Literals(["bearer", "basic", "header"]), header: Schema.NullOr(Schema.String), purpose: Schema.String, value: Schema.String })
);

const REPLIES: Readonly<Record<(typeof FETCHES)[number], (headers: Readonly<Record<string, string>>) => Response>> = {
  ok: () => Response.json({ ok: true }, { status: 200 }),
  echo: (headers) => Response.json({ got: headers }, { status: 200 }),
  redirect: () => new Response("moved", { status: 302, headers: { Location: "https://evil.example.com/" } }),
  throw: (headers) => {
    throw new Error(`connect failed with ${headers.authorization ?? headers["x-api-key"] ?? "nothing"}`);
  },
  long: () => new Response("y".repeat(20_500), { status: 500, headers: { "Content-Type": "text/plain" } })
};

const hex = (text: string) => Buffer.from(text).toString("hex");

type Seen = {
  readonly told: Json[];
  readonly fetched: Json[];
  readonly timeouts: Json[];
  readonly vault: Json[];
};

type SecretName = { readonly session: string; readonly name: string };

type Meta = CredentialInfo | { readonly hook: string };

type Posting = Extract<PostAction, { readonly post: number }>;

type Shown = { readonly status: number; readonly allow: string | null; readonly body: string } | null;

export function world(db: DatabaseSync) {
  const seen: Seen = { told: [], fetched: [], timeouts: [], vault: [] };
  const work: Array<Promise<unknown>> = [];
  const tokens = new Map<string, string>();
  const signings = new Map<string, string>();
  const credentials = new Map<string, Credential>();
  const metas = new Map<string, { readonly kind: string; readonly id: string; readonly meta: Meta }>();
  const asked: string[] = [];
  let minted = 0;
  let entry = 0;
  let limited = false;
  let fetchMode: (typeof FETCHES)[number] = "ok";
  let lastAsk: SecretName = { session: "0", name: "API_KEY" };
  let lastCall = { conversation: "0", tool: 0, args: 0 };
  let lastSaved: string = NAMES[0];

  db.exec("CREATE TABLE IF NOT EXISTS pi_submissions (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, status TEXT NOT NULL, record TEXT NOT NULL)");

  const approvals = new Approvals(storageOf(db), {
    present: () => false,
    home: (session) => session,
    notify: () => {},
    defer: (job) => void work.push(job.catch(() => {})),
    later: () => {}
  });

  const fetcher = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());

    seen.fetched.push({
      url: new Request(input).url,
      method: init.method ?? "GET",
      headers,
      redirect: init.redirect ?? "follow",
      signal: init.signal instanceof AbortSignal,
      body: Option.getOrNull(textOf(init.body))
    });

    return REPLIES[fetchMode](headers);
  };

  const vault = {
    httpRequest: async (name: string, request: CredentialRequest) => {
      const credential = credentials.get(name);

      if (!credential) return { refused: `There is no credential ${name}. list_secrets shows the ones there are.`, sent: false };

      return credentialFetch(fetcher, credential, request);
    },
    hookSigned: async (id: string, signed: boolean, body: string, signature: string | null) => {
      if (!signed) return true;
      const secret = signings.get(id);

      return secret !== undefined && signedWith(secret, body, signature);
    },
    check: async (kind: string, token: string) => tokens.get(`${kind}:${token}`) ?? null,
    mint: async (kind: string, id: string) => {
      const token = hex(`${id}:${minted++}`).padEnd(64, "0").slice(0, 64);
      tokens.set(`${kind}:${token}`, id);
      seen.vault.push(["mint", kind, id]);

      return token;
    },
    revoke: async (kind: string, id: string) => {
      for (const [key, subject] of tokens) if (key.startsWith(`${kind}:`) && subject === id) tokens.delete(key);
      seen.vault.push(["revoke", kind, id]);
    },
    put: async (kind: string, id: string, value: string | Credential, meta: Meta) => {
      if (kind === HTTP_KIND) Option.map(credentialOf(value), (credential) => credentials.set(id, credential));
      else Option.map(textOf(value), (signing) => signings.set(id, signing));
      metas.set(`${kind}:${id}`, { kind, id, meta });
      seen.vault.push(["put", kind, id]);
    },
    remove: async (kind: string, id: string) => {
      if (kind === HTTP_KIND) credentials.delete(id);
      else signings.delete(id);
      metas.delete(`${kind}:${id}`);
      seen.vault.push(["remove", kind, id]);
    },
    status: async () => [...metas.values()].map(({ kind, id, meta }) => ({ kind, id, meta, updatedAt: START }))
  };

  const desk: Desk = {
    // SAFETY: inbound calls httpRequest on the Vault and nothing else of it, with the request and answer shapes above.
    vault: () => vault as never,
    asker: approvals,
    chat: (session) => CHATS.has(session),
    tell: async (session, content, requestId) => {
      seen.told.push([session, content, requestId]);
      place(session, requestId);
    }
  };

  const inbound = new Inbound(storageOf(db), desk);
  approvals.handle("webhook-action", inbound.handlers["webhook-action"]);
  approvals.handle("secret-request", inbound.handlers["secret-request"]);

  const agent = {
    inboundHooks: async () => ({ hooks: inbound.hooks(), chats: [] }),
    inboundHook: async (id: string) => inbound.hook(id) ?? null,
    addHook: async (id: string, session: string, label: string, signed: boolean) => inbound.addHook(id, session, label, signed),
    removeHook: async (id: string) => inbound.removeHook(id),
    hookReceived: async (id: string, delivery: HookDelivery) => inbound.received(id, delivery),
    secretAsk: async (session: string, name: string) => inbound.askFor(session, name) ?? null,
    secretSaved: async (session: string, name: string) => inbound.saved(session, name),
    secretAsks: async (session: string) => inbound.asks(session)
  };

  const reached = {
    HOOK_LIMIT: { limit: async () => ({ success: !limited }) },
    Vault: { getByName: () => vault },
    PiAgent: { getByName: () => agent }
  };

  // SAFETY: the routes reach HOOK_LIMIT.limit, Vault.getByName and PiAgent.getByName's members above, nothing else of Env.
  const env: never = reached as never;

  const settle = async () => {
    while (work.length > 0) await Promise.all(work.splice(0));
  };

  const shown = async (response: Response | undefined): Promise<Shown> => {
    if (!response) return null;

    return { status: response.status, allow: response.headers.get("Allow"), body: await response.text() };
  };

  const route = async (method: string, path: string, body?: string, headers?: Headers) => {
    const url = new URL(`https://ky.example.com${path}`);
    const request = new Request(url, { method, body, headers });

    return shown(await (hookRoute(request, env, url) ?? inboundRoute(request, env, url)));
  };

  const hookAt = (index: number) => inbound.hooks()[index]?.id ?? HOOK_IDS[0];

  const tokenOf = (id: string) => [...tokens].find(([key, subject]) => key.startsWith("hook:") && subject === id)?.[0].slice("hook:".length);

  const signatureOf = (id: string, body: string, kind: (typeof SIGNATURES)[number]) => {
    const secret = signings.get(id);

    if (kind === "none") return null;

    if (kind === "malformed") return "sha256=zz";

    const key = secret !== undefined && kind === "good" ? secret : "wrong";

    return `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;
  };

  const tokenFor = (action: Posting, id: string) => {
    if (action.token === "own") return tokenOf(id) ?? "0".repeat(64);

    if (action.token === "other") return tokenOf(hookAt(action.post + 1)) ?? "1".repeat(64);

    return "f".repeat(64);
  };

  const headersOf = (action: Posting, signature: string | null) => {
    const headers = new Headers({ "User-Agent": "GitHub-Hookshot/1", "X-GitHub-Event": "pull_request" });

    if (signature !== null) headers.set("X-Hub-Signature-256", signature);

    if (action.delivery !== null) headers.set("X-GitHub-Delivery", action.delivery);

    if (action.lies) headers.set("Content-Length", String(HOOK_CAP + 1));

    return headers;
  };

  const post = async (action: Posting) => {
    const id = hookAt(action.post);
    const body = action.size === "small" ? action.body : "z".repeat(action.size === "cap" ? HOOK_CAP : HOOK_CAP + 1);
    const headers = headersOf(action, signatureOf(id, body, action.signature));

    return route(action.method, `/hooks/${id}/${tokenFor(action, id)}?source=ci`, action.method === "GET" ? undefined : body, headers);
  };

  const place = (conversation: string, request: string | null) =>
    void db.prepare("INSERT INTO pi_submissions (conversation_id, status, record) VALUES (?, 'placed', ?)").run(Number(conversation), JSON.stringify({ entry: ++entry, requestId: request }));

  const requestOf = (kind: Extract<Action, { readonly place: string }>["request"]) => {
    const last = asked.at(-1) ?? "none";

    if (kind === "hook") return `hook:${HOOK_IDS[0]}:delivery:d1`;

    if (kind === "decided") return `hook-approval:${last}:told`;

    if (kind === "card") return "hook-card:1";

    if (kind === "approval") return `approval:${last}:told`;

    return null;
  };

  const payloadOf = (action: Extract<Action, { readonly askApproval: string }>): ApprovalRequest["payload"] => {
    if (!action.good) return { nope: 1 };

    if (action.askApproval === "webhook-action") return { tool: TOOLS[action.tool] ?? "write", arguments: ARGS[action.args] ?? {} };

    return { name: lastSaved, url: URLS[action.url] ?? URLS[0], method: "GET", headers: { Accept: "application/json" }, body: null, guarded: action.conversation === "0" };
  };

  const hookAction = async (action: HookAction): Promise<Json> => {
    if ("addHook" in action) return route("POST", "/api/inbound/hooks", ADD_BODIES[action.addHook]);

    if ("add" in action) {
      const id = HOOK_IDS[action.add] ?? "";

      return inbound.hook(id) ? "taken" : inbound.addHook(id, action.session, LABELS[action.label] ?? "", action.signed);
    }

    if ("rotate" in action) return route("POST", `/api/inbound/hooks/${hookAt(action.rotate)}/rotate`);

    if ("remove" in action) return route("DELETE", `/api/inbound/hooks/${hookAt(action.remove)}`);

    return route("GET", "/api/inbound/hooks");
  };

  const postAction = async (action: PostAction): Promise<Json> => {
    if ("post" in action) return post(action);

    limited = action.limited;

    return null;
  };

  const save = async (action: Extract<SecretAction, { readonly save: string }>): Promise<Json> => {
    const body = action.fresh ? { session: lastAsk.session, name: lastAsk.name, value: VALUES[action.value] } : { session: action.save, name: NAMES[action.name], value: VALUES[action.value] };
    const saved = await route("POST", "/api/inbound/secrets", JSON.stringify(action.raw ? { ...body, value: 4 } : body));

    if (body.name !== undefined && credentials.has(body.name)) lastSaved = body.name;

    return saved;
  };

  const secretAction = async (action: SecretAction): Promise<Json> => {
    if ("ask" in action) {
      lastAsk = { session: action.ask, name: NAMES[action.name] ?? "" };
      inbound.ask(lastAsk.session, lastAsk.name, INFOS[action.info] ?? BEARER);

      return null;
    }

    if ("save" in action) return save(action);

    if ("asks" in action) return route("GET", action.asks === null ? "/api/inbound/asks" : `/api/inbound/asks?session=${action.asks}`);

    if ("listSecrets" in action) return route("GET", "/api/inbound/secrets");

    return route("DELETE", `/api/inbound/secrets/${NAMES[action.removeSecret]}`);
  };

  const inputAction = (action: InputAction): Json => {
    if ("guarded" in action) return inbound.guarded(action.guarded);

    if ("place" in action) place(action.place, requestOf(action.request));
    else db.prepare("UPDATE pi_submissions SET status = 'done' WHERE conversation_id = ?").run(Number(action.newRun));

    return null;
  };

  const askApproval = async (action: Extract<DecisionAction, { readonly askApproval: string }>): Promise<Json> => {
    lastCall = { conversation: action.conversation, tool: action.tool, args: action.args };

    const tool = TOOLS[action.tool] ?? "write";

    const result = await inbound.requestApproval(
      { kind: action.askApproval, subject: tool, summary: `call ${action.tool}`, payload: payloadOf(action), conversation: action.conversation },
      tool,
      ARGS[action.args] ?? {}
    );

    if ("asked" in result && !asked.includes(result.asked.id)) asked.push(result.asked.id);

    // SAFETY: an approval's fields are strings, numbers and JSON payloads; it round-trips through JSON as itself.
    return JSON.parse(JSON.stringify(result)) as Json;
  };

  const approvalAction = async (action: DecisionAction): Promise<Json> => {
    if ("askApproval" in action) return askApproval(action);

    if ("passed" in action) {
      const call = action.fresh ? lastCall : { conversation: action.passed, tool: action.tool, args: action.args };

      return inbound.passed(call.conversation, TOOLS[call.tool] ?? "write", ARGS[call.args] ?? {});
    }

    const decided = approvals.onDecision(asked.at(action.decide) ?? "none", action.action);
    await settle();

    return decided;
  };

  const callAction = async (action: CallAction): Promise<Json> => {
    if ("fetch" in action) {
      fetchMode = action.fetch;

      return null;
    }

    const spy = vi.spyOn(AbortSignal, "timeout");

    const answer = await vault.httpRequest(action.fresh ? lastSaved : (NAMES[action.http] ?? ""), {
      url: URLS[action.url] ?? "",
      method: action.method,
      headers: { Authorization: "mine", Accept: "*/*" },
      body: action.method === "POST" ? "{}" : null
    });

    seen.timeouts.push(...spy.mock.calls.map(([ms]) => ms));
    spy.mockRestore();

    return { ...answer };
  };

  const apply = async (action: Action): Promise<Json> => {
    if (isHook(action)) return hookAction(action);

    if (isPost(action)) return postAction(action);

    if (isSecret(action)) return secretAction(action);

    if (isInput(action)) return inputAction(action);

    if (isApproval(action)) return approvalAction(action);

    return callAction(action);
  };

  const prime = async () => {
    await route("POST", "/api/inbound/hooks", ADD_BODIES[0]);
    await route("POST", "/api/inbound/hooks", ADD_BODIES[1]);
    inbound.ask("0", NAMES[0], BEARER);
    await route("POST", "/api/inbound/secrets", JSON.stringify({ session: "0", name: NAMES[0], value: VALUE }));
  };

  return { seen, inbound, approvals, apply, prime, settle, route, post, place, tokens, signings, asked };
}
