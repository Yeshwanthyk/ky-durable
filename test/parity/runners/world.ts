import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { vi } from "vitest";
import type { MachineFacts } from "../../../src/machines/contract";
import { Sandboxes } from "../../../src/runners/wiring";
import type { Clock, Json } from "../kit";

export const T = 1_760_000_000_000;

export const FACTS = {
  os: "darwin",
  chrome: true,
  repos: [{ name: "api", remote: "https://github.com/acme/api.git" }],
  agents: { claude: { installed: true, signedIn: true }, codex: { installed: false, signedIn: false } },
  ports: [3000],
  kind: "computer"
} satisfies MachineFacts;

type Storage = ConstructorParameters<typeof Sandboxes>[0];

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
    storage: (): Storage => ({ sql, transactionSync }) as never
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
  readonly registry: Sandboxes;
  readonly tokens = new Map<string, Token>();
  readonly machines = new Map<string, string>([["mini", "p1"]]);
  readonly effects: Json[] = [];
  uuids = 0;
  #minted = 0;

  readonly clock: Clock;

  constructor(clock: Clock) {
    this.clock = clock;
    this.at();
    this.registry = new Sandboxes(this.durable.storage());
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
}
