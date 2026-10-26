import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { vi } from "vitest";
import { TaskFeed } from "../../../src/automations/tasks";
import { FileStore } from "../../../src/files/wiring";
import type { Harness } from "../../../src/machines/machines";
import { MachineHub } from "../../../src/machines/wiring";
import { Sandboxes } from "../../../src/sandboxes";
import type { Json } from "../kit";

type Row = Record<string, SQLOutputValue>;

type Storage = ConstructorParameters<typeof MachineHub>[0];

type SqlStorageOf = ConstructorParameters<typeof TaskFeed>[0];

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
    db.exec("SAVEPOINT machines");

    try {
      const result = work();
      kept = true;

      return result;
    } finally {
      db.exec(kept ? "RELEASE machines" : "ROLLBACK TO machines; RELEASE machines");
    }
  };

  const sql = { exec, databaseSize: 0 };

  return {
    // SAFETY: the hub, the feed, the files and the sandboxes call sql.exec (toArray, one, rowsWritten) and transactionSync; nothing else.
    storage: (): Storage => ({ sql, transactionSync }) as Storage,
    // SAFETY: as the storage's, of its sql alone.
    sql: (): SqlStorageOf => sql as SqlStorageOf
  };
}

type Socket = { readyState: number; readonly tags: readonly string[] };

type Effects = { readonly vault: Json[]; readonly runner: Json[]; readonly pi: Json[]; readonly host: Json[] };

export class World {
  readonly db = new DatabaseSync(":memory:");
  readonly durable = storageOf(this.db);
  readonly feed = new TaskFeed(this.durable.sql());
  readonly files = new FileStore(this.durable.sql());
  readonly sandboxes = new Sandboxes(this.durable.sql());
  readonly effects: Effects = { vault: [], runner: [], pi: [], host: [] };
  readonly sockets = new Map<string, Socket>();
  constructor(now: number) {
    vi.setSystemTime(now);
    this.sandboxes.migrate();
    this.db.prepare("INSERT INTO ky_sandboxes (id, name, repos, is_default, created_at) VALUES ('sb-lab', 'lab', '[\"acme/api\"]', 0, ?)").run(now);
  }

  rows(query: string, ...bindings: SQLInputValue[]): Row[] {
    return this.db
      .prepare(query)
      .all(...bindings)
      .map((row) => ({ ...row }));
  }

  socketsOf = (tag: string): WebSocket[] =>
    [...this.sockets.entries()].flatMap(([connection, socket]) => {
      if (!socket.tags.includes(tag)) return [];

      const send = (text: string) => {
        if (socket.readyState !== 1) throw new Error("closed");
        // SAFETY: the hub sends JSON text.
        this.effects.runner.push({ frame: connection, command: JSON.parse(text) as Json });
      };

      // SAFETY: the hub reads readyState and calls send; nothing else of a socket.
      return [{ readyState: socket.readyState, send } as WebSocket];
    });

  tokens = {
    issue: async (task: string) => {
      this.effects.vault.push({ issue: task });

      return `tok-${task}`;
    },
    revoke: async (task: string) => {
      this.effects.vault.push({ revoke: task });
    },
    revokeAll: async (tasks: readonly string[]) => {
      this.effects.vault.push({ revokeAll: [...tasks] });
    }
  };

  creds = async (agent: "claude" | "codex") => {
    this.effects.vault.push({ creds: agent });

    return agent === "codex"
      ? { codex: { accessToken: "at", refreshToken: null, idToken: "it", accountId: "acct", expiresAt: 1_000 } }
      : { claude: { oauthToken: "oauth" } };
  };

  harness: Harness = {
    submit: async (input, options = {}) => {
      this.effects.pi.push({ submit: JSON.stringify(input), session: options.session ?? null, operationId: options.operationId ?? null, whenBusy: options.whenBusy ?? null });

      return { operationId: options.operationId ?? "", session: options.session ?? "", accepted: true };
    }
  };
}

export async function settle(): Promise<void> {
  for (let round = 0; round < 8; round += 1) await new Promise((resolve) => setImmediate(resolve));
}
