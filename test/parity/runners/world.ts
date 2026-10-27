import fc from "fast-check";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { vi } from "vitest";
import type { MachineFacts } from "../../../src/machines/contract";
import type { Sandbox, SandboxChange, SandboxDraft } from "../../../src/runners/contract";
import { ownerRoute, pairAs, Sandboxes, tokenRoute } from "../../../src/runners/wiring";
import type { Clock, Instance, Json } from "../kit";

export const T = 1_760_000_000_000;

export const FACTS = {
  os: "darwin",
  chrome: true,
  repos: [{ name: "api", remote: "https://github.com/acme/api.git" }],
  agents: { claude: { installed: true, signedIn: true }, codex: { installed: false, signedIn: false } },
  ports: [3000],
  kind: "computer"
} satisfies MachineFacts;

export type Registry = {
  migrate(): void;
  seeded(): void;
  all(): Sandbox[];
  keep(lost: readonly Sandbox[]): void;
  live(): Sandbox[];
  kept(): Sandbox[];
  get(id: string): Sandbox | undefined;
  named(name: string): Sandbox | undefined;
  owner(repo: string): Sandbox | undefined;
  reposFor(id: string): readonly string[] | "all" | null;
  create(draft: SandboxDraft, taken: (name: string) => boolean): Sandbox;
  change(id: string, change: SandboxChange): Sandbox;
  delete(id: string): Sandbox;
  forget(id: string): Sandbox;
};

type Storage = ConstructorParameters<typeof Sandboxes>[0];

type Route = (request: Request, env: Env, url: URL) => Promise<Response> | undefined;

export type Side = {
  registry(storage: Storage, sql: Storage["sql"]): Registry;
  tokenRoute: Route;
  ownerRoute: Route;
  pairAs(env: Env, machine: string, facts: MachineFacts, sandbox?: string): Promise<string>;
};

export const next: Side = { registry: (storage) => new Sandboxes(storage), tokenRoute, ownerRoute, pairAs };

export function storageOf(db: DatabaseSync) {
  const exec = (query: string, ...bindings: SQLInputValue[]) => {
    const statement = db.prepare(query);
    const returns = statement.columns().length > 0;
    const rows = returns ? statement.all(...bindings).map((row) => ({ ...row })) : [];
    const rowsWritten = returns ? 0 : Number(statement.run(...bindings).changes);

    return { toArray: () => rows, one: () => rows[0], rowsWritten };
  };

  const transactionSync = <T>(work: () => T): T => {
    let kept = false;
    db.exec("SAVEPOINT runners");

    try {
      const result = work();
      kept = true;

      return result;
    } finally {
      db.exec(kept ? "RELEASE runners" : "ROLLBACK TO runners; RELEASE runners");
    }
  };

  const sql = { exec, databaseSize: 0 };

  return {
    // SAFETY: the registry calls sql.exec (toArray, one, rowsWritten) and transactionSync; nothing else.
    storage: (): Storage => ({ sql, transactionSync }) as never,
    // SAFETY: as the storage's, of its sql alone.
    sql: (): Storage["sql"] => sql as never
  };
}

type Token = { kind: string; subject: string; expiresAt: number | null };

let minting: { uuids: number } | undefined;

export function uuidsFrom(world: { uuids: number }): void {
  minting = world;
}

export function fakeUuids(): void {
  vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
    if (!minting) throw new Error("No world mints uuids now.");
    minting.uuids += 1;

    return `${minting.uuids.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
  });
}

export const TASK_TOKEN = "task-tok";

export const MACHINE_TOKEN = "mini-tok";

export class World {
  readonly db = new DatabaseSync(":memory:");
  readonly durable = storageOf(this.db);
  readonly registry: Registry;
  readonly tokens = new Map<string, Token>();
  readonly machines = new Map<string, string>([["mini", "p1"]]);
  readonly effects: Json[] = [];
  uuids = 0;
  #minted = 0;

  readonly side: Side;
  readonly clock: Clock;

  constructor(side: Side, clock: Clock) {
    this.side = side;
    this.clock = clock;
    this.at();
    this.registry = side.registry(this.durable.storage(), this.durable.sql());
    this.tokens.set(TASK_TOKEN, { kind: "task", subject: "t1", expiresAt: null });
    this.tokens.set(MACHINE_TOKEN, { kind: "machine", subject: "mini:p1", expiresAt: null });
    this.tokens.set("old-code", { kind: "pair", subject: "x", expiresAt: clock.now() - 1 });
    this.tokens.set("live-code", { kind: "pair", subject: "y", expiresAt: clock.now() + 60_000 });
  }

  at(): void {
    vi.setSystemTime(this.clock.now());
    uuidsFrom(this);
  }

  readonly vault = {
    check: async (kind: string, token: string) => this.#valid(kind, token)?.subject ?? null,
    consume: async (kind: string, token: string) => {
      const found = this.#valid(kind, token);
      this.effects.push({ consume: kind, token });

      if (found) this.tokens.delete(token);

      return found?.subject ?? null;
    },
    mint: async (kind: string, subject: string, ttlMs?: number) => {
      this.#minted += 1;
      const token = `tok-${kind}-${this.#minted}`;
      this.tokens.set(token, { kind, subject, expiresAt: ttlMs === undefined ? null : this.clock.now() + ttlMs });
      this.effects.push({ mint: kind, subject, ttlMs: ttlMs ?? null });

      return token;
    },
    revoke: async (kind: string, subject: string) => {
      this.effects.push({ revoke: kind, subject });

      for (const [token, row] of this.tokens) if (row.kind === kind && row.subject === subject) this.tokens.delete(token);
    }
  };

  #valid(kind: string, token: string): Token | undefined {
    const row = this.tokens.get(token);

    return row && row.kind === kind && (row.expiresAt === null || row.expiresAt > this.clock.now()) ? row : undefined;
  }

  readonly agent = {
    fetch: async (request: Request) => {
      const seen = { url: request.url, pairing: request.headers.get("X-Ky-Pairing"), authorization: request.headers.get("Authorization"), upgrade: request.headers.get("Upgrade") };
      this.effects.push({ socket: seen });

      return Response.json(seen);
    },
    isSandbox: async (name: string) => this.registry.named(name) !== undefined,
    pairMachine: async (machine: string, _facts: MachineFacts, pairing: string, sandbox?: string) => {
      const named = this.registry.named(machine);
      this.effects.push({ pairMachine: machine, pairing, sandbox: sandbox ?? null });

      if (sandbox !== undefined ? named?.id !== sandbox : named !== undefined) {
        throw new Error(sandbox !== undefined ? `The sandbox ${sandbox} is not ${machine} now.` : `${machine} is one of ky's sandboxes.`);
      }

      const previous = this.machines.get(machine) ?? null;
      this.machines.set(machine, pairing);

      return previous;
    },
    removeMachine: async (machine: string) => {
      this.effects.push({ removeMachine: machine });
      const pairing = this.machines.get(machine);

      if (pairing === undefined) return undefined;
      this.machines.delete(machine);

      return { pairing };
    },
    attachFile: async (file: { id: string; task: string; name: string; type: string; size: number; caption: string | null }) => {
      this.effects.push({ attachFile: file });

      return file.task === "done" ? "That task is over." : null;
    }
  };

  readonly bucket = {
    put: async (key: string, body: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }) => {
      this.effects.push({ put: key, size: body.byteLength, contentType: options?.httpMetadata?.contentType ?? null });

      return null;
    },
    delete: async (key: string) => {
      this.effects.push({ delete: key });
    }
  };

  readonly reached = {
    Vault: { getByName: () => this.vault },
    PiAgent: { getByName: () => this.agent },
    PAIR_LIMIT: {
      limit: async ({ key }: { key: string }) => {
        this.effects.push({ limit: key });

        return { success: key !== "flood" };
      }
    },
    FILES: this.bucket
  };

  // SAFETY: the routes reach Vault.getByName, PiAgent.getByName, PAIR_LIMIT.limit and FILES' put and delete above, nothing else of Env.
  readonly env: Env = this.reached as never;

  rows(query: string, ...bindings: SQLInputValue[]): Json[] {
    // SAFETY: the runners' tables hold text, integers and nulls, which JSON shows as they are.
    return this.db
      .prepare(query)
      .all(...bindings)
      .map((row) => ({ ...row }) as Json);
  }

  tables(): Json {
    return {
      ky_sandboxes: this.rows("SELECT * FROM ky_sandboxes ORDER BY id"),
      ky_sandboxes_seeded: this.rows("SELECT * FROM ky_sandboxes_seeded"),
      vault: [...this.tokens].sort(([a], [b]) => a.localeCompare(b)).map(([token, row]) => ({ token, ...row })),
      machines: [...this.machines].sort(([a], [b]) => a.localeCompare(b))
    };
  }

  async route(request: Request): Promise<Json> {
    const url = new URL(request.url);
    const answered = this.side.tokenRoute(request, this.env, url) ?? this.side.ownerRoute(request, this.env, url);

    if (!answered) return { unrouted: url.pathname };
    const response = await answered;

    return { status: response.status, type: response.headers.get("Content-Type"), body: await response.text() };
  }
}

export const IDS = ["cloud", "sb-lab", "sb-00000001", "sb-00000002", "sb-00000003", "sb-00000004", "sb-00000006", "nope"];

const NAMES = ["cloud", "lab", "web", "api", "  web ", "Web", "-bad", "a".repeat(33), "mini", "box", ""];

const REPOS = ["acme/api", "acme/web", " Acme/API ", "acme", "acme/api/x", "a_b/c.d", ""];

const repos = fc.array(fc.constantFrom(...REPOS), { maxLength: 3 });

const sandbox: fc.Arbitrary<Sandbox> = fc.record({
  id: fc.constantFrom(...IDS),
  name: fc.constantFrom("cloud", "lab", "web", "old"),
  repos: fc.array(fc.constantFrom("acme/api", "acme/web", "acme/old"), { maxLength: 2 }),
  idleMinutes: fc.constantFrom(null, 30),
  isDefault: fc.boolean(),
  createdAt: fc.constantFrom(T - 5_000, T + 5_000),
  deletedAt: fc.constantFrom(null, T - 1_000)
});

const MACHINES = ["mini", "box", "lab", "web", "cloud", "Bad", "x".repeat(40), ""];

const TOKENS = [MACHINE_TOKEN, TASK_TOKEN, "tok-machine-1", "tok-machine-2", "tok-pair-1", "nope", ""];

const CODES = ["live-code", "live-code", "old-code", "tok-pair-1", "tok-pair-2", "tok-pair-3", "nope", ""];

const pairBody = fc.oneof(
  fc.record({ code: fc.constantFrom(...CODES), name: fc.constantFrom("box", "mini", ...MACHINES), facts: fc.constantFrom<Json>(FACTS, FACTS, { ...FACTS, kind: "phone" }, null) }).map((body) => JSON.stringify(body)),
  fc.constantFrom("", "not json", "null", "[]", '{"code":"live-code"}', `  ${JSON.stringify({ code: "live-code", name: "box", facts: FACTS })}  `)
);

export type Action =
  | { readonly kind: "migrate" }
  | { readonly kind: "seeded" }
  | { readonly kind: "keep"; readonly lost: readonly Sandbox[] }
  | { readonly kind: "create"; readonly name: string; readonly repos?: readonly string[]; readonly from?: string; readonly taken: boolean }
  | { readonly kind: "change"; readonly id: string; readonly change: SandboxChange }
  | { readonly kind: "delete"; readonly id: string }
  | { readonly kind: "forget"; readonly id: string }
  | { readonly kind: "read"; readonly id: string; readonly name: string; readonly repo: string }
  | { readonly kind: "wreck"; readonly id: string }
  | { readonly kind: "damage"; readonly id: string }
  | { readonly kind: "socket"; readonly machine: string; readonly token?: string; readonly upgrade: boolean }
  | { readonly kind: "pair"; readonly method: string; readonly ip?: string; readonly body: string }
  | { readonly kind: "upload"; readonly task?: string; readonly token?: string; readonly type: string; readonly length: number; readonly bytes: number; readonly name?: string }
  | { readonly kind: "code"; readonly method: string }
  | { readonly kind: "remove"; readonly machine: string; readonly method: string }
  | { readonly kind: "pairAs"; readonly machine: string; readonly sandbox?: string }
  | { readonly kind: "other"; readonly path: string };

const optional = <T>(arbitrary: fc.Arbitrary<T>) => fc.option(arbitrary, { nil: undefined });

export const actions: fc.Arbitrary<Action> = fc.oneof(
  fc.constant({ kind: "migrate" as const }),
  fc.constant({ kind: "seeded" as const }),
  fc.record({ kind: fc.constant("keep" as const), lost: fc.array(sandbox, { maxLength: 2 }) }),
  { arbitrary: fc.record({ kind: fc.constant("create" as const), name: fc.constantFrom(...NAMES), repos: optional(repos), from: optional(fc.constantFrom(...IDS)), taken: fc.boolean() }, { requiredKeys: ["kind", "name", "taken"] }), weight: 4 },
  {
    arbitrary: fc.record({
      kind: fc.constant("change" as const),
      id: fc.constantFrom(...IDS),
      change: fc.record({ repos, idleMinutes: fc.constantFrom(null, 0, 1, 30, 1.5, 24 * 60, 24 * 60 + 1, -3), isDefault: fc.constant(true as const) }, { requiredKeys: [] })
    }),
    weight: 3
  },
  { arbitrary: fc.record({ kind: fc.constant("delete" as const), id: fc.constantFrom(...IDS) }), weight: 2 },
  fc.record({ kind: fc.constant("forget" as const), id: fc.constantFrom(...IDS) }),
  fc.record({ kind: fc.constant("read" as const), id: fc.constantFrom(...IDS), name: fc.constantFrom(...NAMES), repo: fc.constantFrom(...REPOS) }),
  fc.record({ kind: fc.constant("wreck" as const), id: fc.constantFrom(...IDS) }),
  fc.record({ kind: fc.constant("damage" as const), id: fc.constantFrom(...IDS) }),
  fc.record({ kind: fc.constant("socket" as const), machine: fc.constantFrom(...MACHINES, "mini/extra"), token: optional(fc.constantFrom(...TOKENS)), upgrade: fc.boolean() }, { requiredKeys: ["kind", "machine", "upgrade"] }),
  { arbitrary: fc.record({ kind: fc.constant("pair" as const), method: fc.constantFrom("POST", "POST", "GET"), ip: optional(fc.constantFrom("1.2.3.4", "flood")), body: pairBody }, { requiredKeys: ["kind", "method", "body"] }), weight: 3 },
  fc.record(
    {
      kind: fc.constant("upload" as const),
      task: optional(fc.constantFrom("t1", "t1", "t1", "t2", "done")),
      token: optional(fc.constantFrom(TASK_TOKEN, TASK_TOKEN, TASK_TOKEN, MACHINE_TOKEN, "nope")),
      type: fc.constantFrom("image/png", "image/png", "image/png", "text/html", ""),
      length: fc.constantFrom(8, 8, 8, 4, 0),
      bytes: fc.constantFrom(8, 8, 4),
      name: optional(fc.constantFrom("shot.png", "shot.png", ""))
    },
    { requiredKeys: ["kind", "type", "length", "bytes"] }
  ),
  { arbitrary: fc.record({ kind: fc.constant("code" as const), method: fc.constantFrom("POST", "POST", "GET") }), weight: 2 },
  fc.record({ kind: fc.constant("remove" as const), machine: fc.constantFrom(...MACHINES), method: fc.constantFrom("DELETE", "DELETE", "GET") }),
  fc.record({ kind: fc.constant("pairAs" as const), machine: fc.constantFrom(...MACHINES), sandbox: optional(fc.constantFrom(...IDS)) }, { requiredKeys: ["kind", "machine"] }),
  fc.record({ kind: fc.constant("other" as const), path: fc.constantFrom("/api/runners", "/api/runners/a/b", "/runner", "/api/files/x") })
);

const ORIGIN = "https://ky.test";

function requestOf(action: Action): Request | undefined {
  switch (action.kind) {
    case "socket": {
      const headers = new Headers();

      if (action.token !== undefined) headers.set("Authorization", `Bearer ${action.token}`);

      if (action.upgrade) headers.set("Upgrade", "websocket");

      return new Request(`${ORIGIN}/runner/${action.machine}`, { headers });
    }

    case "pair": {
      const headers = new Headers();

      if (action.ip !== undefined) headers.set("CF-Connecting-IP", action.ip);

      return new Request(`${ORIGIN}/api/runners/pair`, { method: action.method, headers, body: action.method === "POST" ? action.body : null });
    }

    case "upload": {
      const headers = new Headers({ "Content-Type": action.type, "Content-Length": String(action.length) });

      if (action.token !== undefined) headers.set("Authorization", `Bearer ${action.token}`);

      if (action.name !== undefined) headers.set("X-Ky-Name", action.name);
      const query = action.task === undefined ? "" : `?task=${action.task}`;
      const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].slice(0, action.bytes));

      return new Request(`${ORIGIN}/api/files${query}`, { method: "PUT", headers, body });
    }

    case "code":
      return new Request(`${ORIGIN}/api/runners/codes`, { method: action.method });

    case "remove":
      return new Request(`${ORIGIN}/api/runners/${action.machine}`, { method: action.method });

    case "other":
      return new Request(`${ORIGIN}${action.path}`);

    default:
      return undefined;
  }
}

function sandboxJson(sandbox: Sandbox | undefined): Json {
  return sandbox === undefined ? null : { ...sandbox, repos: [...sandbox.repos] };
}

function reposJson(found: readonly string[] | "all" | null): Json {
  return found === null || found === "all" ? found : [...found];
}

async function applyTo(world: World, action: Action): Promise<Json> {
  const { registry } = world;
  const request = requestOf(action);

  if (request) return world.route(request);

  switch (action.kind) {
    case "migrate":
      registry.migrate();

      return null;
    case "seeded":
      registry.seeded();

      return null;
    case "keep":
      registry.keep(action.lost);

      return null;
    case "create":
      return sandboxJson(registry.create({ name: action.name, repos: action.repos, from: action.from }, (name) => action.taken && name === "box"));
    case "change":
      return sandboxJson(registry.change(action.id, action.change));
    case "delete":
      return sandboxJson(registry.delete(action.id));
    case "forget":
      return sandboxJson(registry.forget(action.id));
    case "read":
      return {
        all: registry.all().map(sandboxJson),
        live: registry.live().map(sandboxJson),
        kept: registry.kept().map(sandboxJson),
        get: sandboxJson(registry.get(action.id)),
        named: sandboxJson(registry.named(action.name)),
        owner: sandboxJson(registry.owner(action.repo)),
        reposFor: reposJson(registry.reposFor(action.id))
      };
    case "wreck":
      world.db.prepare("UPDATE ky_sandboxes SET repos = 'not json' WHERE id = ?").run(action.id);

      return null;
    case "damage":
      world.db.prepare("UPDATE ky_sandboxes SET created_at = 'soon' WHERE id = ?").run(action.id);

      return null;
    case "pairAs":
      return world.side.pairAs(world.env, action.machine, FACTS, action.sandbox);
    default:
      return null;
  }
}

export function instanceOf(side: Side, clock: Clock): Instance<Action> {
  const world = new World(side, clock);

  return {
    apply: async (action) => {
      world.at();

      try {
        return await applyTo(world, action);
      } catch (error) {
        return { threw: error instanceof Error ? error.message : String(error) };
      }
    },
    tables: async () => world.tables(),
    effects: async () => world.effects,
    dispose: async () => world.db.close()
  };
}
