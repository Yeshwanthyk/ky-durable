/**
 * The machines domain's world: a Durable Object's SQLite (node:sqlite) with the real TaskFeed, FileStore
 * and Sandboxes over it, and fakes for what the hub reaches outside: the runner sockets, the Vault's tokens
 * and logins, pi's harness, the cloud machine and the Scheduler. Every fake writes what it was asked to do
 * to the world's effects, one ordered stream for each party, since only a party sees its own order. Time is the clock's: before each call the system time is set to it.
 */
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import fc from "fast-check";
import { vi } from "vitest";
import { TaskFeed } from "../../../src/automations/tasks";
import { FileStore } from "../../../src/files";
import { MachineHub as LegacyHub } from "../../../src/machines/legacy/machines";
import type { MachineChange, MachineFacts, TaskReport } from "../../../src/machines/contract";
import type { Harness } from "../../../src/machines/machines";
import { MachineHub } from "../../../src/machines/wiring";
import { Sandboxes } from "../../../src/sandboxes";
import type { Clock, Instance, Json } from "../kit";

type Row = Record<string, SQLOutputValue>;

type Hub = Omit<MachineHub, "change">;

type Storage = ConstructorParameters<typeof MachineHub>[0];

type SqlStorageOf = ConstructorParameters<typeof TaskFeed>[0];

type Answer = object | string | number | boolean | null | undefined | void;

const COMPUTERS = ["mini", "box"] as const;

const TASKS = ["t1", "t2", "t3"] as const;

const connection = fc.constantFrom("1", "2");

const SESSIONS = ["s1", "s2"] as const;

const TABLES = ["ky_machines", "ky_machine_inbox", "ky_machine_turns", "ky_machine_senders", "ky_machine_logins", "ky_machine_reports"] as const;

const facts = fc.record({
  os: fc.constantFrom("darwin", "linux"),
  chrome: fc.boolean(),
  repos: fc.subarray([
    { name: "api", remote: "https://github.com/acme/api.git" },
    { name: "web", remote: null }
  ]),
  agents: fc.record({
    claude: fc.record({ installed: fc.boolean(), signedIn: fc.boolean() }),
    codex: fc.record({ installed: fc.boolean(), signedIn: fc.boolean() })
  }),
  ports: fc.subarray([3000, 8080]),
  kind: fc.constant<"computer">("computer")
});

const machine = fc.constantFrom("mini", "mini", "mini", "box", "cloud", "lab");

const task = fc.constantFrom(...TASKS);

const turn = fc.integer({ min: 1, max: 4 });

const report: fc.Arbitrary<Exclude<TaskReport, { type: "hello" }>> = fc.oneof(
  fc.record({ type: fc.constant("ack" as const), seq: fc.integer({ min: 1, max: 10 }) }),
  fc.record({ type: fc.constant("session" as const), task, turn, session: fc.constantFrom("r1", "r2") }),
  fc.record(
    {
      type: fc.constant("step" as const),
      task,
      turn,
      text: fc.constantFrom("Reading", "Editing"),
      call: fc.constantFrom("k1", "k2"),
      state: fc.constantFrom("done" as const, "failed" as const)
    },
    { requiredKeys: ["type", "task", "turn", "text"] }
  ),
  fc.record(
    {
      type: fc.constant("result" as const),
      task,
      turn,
      ok: fc.boolean(),
      text: fc.constantFrom("All done.", "It broke."),
      session: fc.constantFrom("r1", null),
      agent: fc.constantFrom("claude" as const, "codex" as const),
      turns: fc.integer({ min: 0, max: 5 }),
      costUsd: fc.constantFrom(0, 0.5)
    },
    { requiredKeys: ["type", "task", "turn", "ok", "text", "session", "agent"] }
  )
);

const change: fc.Arbitrary<MachineChange> = fc.record(
  {
    // SAFETY: a caller past the tool's schema can send any state or login; the hub refuses them.
    state: fc.constantFrom("on", "on", "paused", "off", "asleep") as fc.Arbitrary<MachineChange["state"]>,
    note: fc.constantFrom("", "the desk one", "x".repeat(240)),
    // SAFETY: as the state.
    login: fc.constantFrom("own", "ky", "ky", "theirs") as fc.Arbitrary<MachineChange["login"]>
  },
  { requiredKeys: [] }
);

export type Action =
  | { readonly do: "pair"; readonly machine: (typeof COMPUTERS)[number]; readonly pairing: string; readonly facts: MachineFacts }
  | { readonly do: "hello"; readonly machine: string; readonly connection: string; readonly active: readonly string[]; readonly facts: MachineFacts }
  | { readonly do: "close"; readonly machine: string; readonly connection: string; readonly code: number | undefined }
  | { readonly do: "report"; readonly machine: string; readonly connection: string; readonly report: Exclude<TaskReport, { type: "hello" }> }
  | { readonly do: "start"; readonly machine: string; readonly task: string; readonly parent: string; readonly agent: "claude" | "codex" | undefined }
  | { readonly do: "send"; readonly task: string; readonly parent: string | undefined }
  | { readonly do: "stop"; readonly task: string }
  | { readonly do: "move"; readonly task: string; readonly to: string }
  | { readonly do: "configure"; readonly machine: string; readonly change: MachineChange }
  | { readonly do: "remove"; readonly machine: string }
  | { readonly do: "refused"; readonly machine: string; readonly protocol: number }
  | { readonly do: "trouble"; readonly machine: string; readonly reason: string | null }
  | { readonly do: "startFailed"; readonly machine: string }
  | { readonly do: "sweepTokens" | "recheck" | "post" | "listSandboxes" | "renewLogin" | "dropSandbox" }
  | { readonly do: "wanted"; readonly task: string; readonly wanted: boolean }
  | { readonly do: "read"; readonly machine: string; readonly pairing: string | undefined; readonly repo: string };

export const actions: fc.Arbitrary<Action> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ do: fc.constant("pair" as const), machine: fc.constantFrom(...COMPUTERS), pairing: fc.constantFrom("p1", "p2"), facts }) },
  {
    weight: 4,
    arbitrary: fc.record({ do: fc.constant("hello" as const), machine, connection, active: fc.subarray([...TASKS]), facts })
  },
  {
    weight: 2,
    arbitrary: fc.record({ do: fc.constant("close" as const), machine, connection, code: fc.constantFrom(undefined, 1000, 4401, 4409) })
  },
  { weight: 8, arbitrary: fc.record({ do: fc.constant("report" as const), machine, connection, report }) },
  {
    weight: 5,
    arbitrary: fc.record({
      do: fc.constant("start" as const),
      machine,
      task,
      parent: fc.constantFrom(...SESSIONS),
      agent: fc.constantFrom(undefined, "claude" as const, "codex" as const)
    })
  },
  { weight: 3, arbitrary: fc.record({ do: fc.constant("send" as const), task, parent: fc.constantFrom(undefined, ...SESSIONS) }) },
  { weight: 2, arbitrary: fc.record({ do: fc.constant("stop" as const), task }) },
  { weight: 2, arbitrary: fc.record({ do: fc.constant("move" as const), task, to: machine }) },
  { weight: 3, arbitrary: fc.record({ do: fc.constant("configure" as const), machine, change }) },
  { weight: 1, arbitrary: fc.record({ do: fc.constant("remove" as const), machine }) },
  { weight: 1, arbitrary: fc.record({ do: fc.constant("refused" as const), machine, protocol: fc.constantFrom(3, 5) }) },
  { weight: 1, arbitrary: fc.record({ do: fc.constant("trouble" as const), machine, reason: fc.constantFrom(null, "Saves keep failing.") }) },
  { weight: 1, arbitrary: fc.record({ do: fc.constant("startFailed" as const), machine }) },
  { weight: 3, arbitrary: fc.record({ do: fc.constantFrom("sweepTokens" as const, "recheck" as const, "post" as const, "listSandboxes" as const, "renewLogin" as const, "dropSandbox" as const) }) },
  { weight: 1, arbitrary: fc.record({ do: fc.constant("wanted" as const), task, wanted: fc.boolean() }) },
  {
    weight: 3,
    arbitrary: fc.record({ do: fc.constant("read" as const), machine, pairing: fc.constantFrom(undefined, "p1", "p2"), repo: fc.constantFrom("acme/api", "acme/web", "") })
  }
);

export const advances = fc.oneof(fc.integer({ min: 1, max: 5_000 }), fc.constantFrom(1, 74_999, 75_000, 75_001), fc.constant(24 * 60 * 60_000));

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
  readonly unwanted = new Set<string>();
  expiresAt = 1_000;
  readonly clock: Clock;

  constructor(clock: Clock) {
    this.clock = clock;
    vi.setSystemTime(clock.now());
    this.sandboxes.migrate();
    this.db.prepare("INSERT INTO ky_sandboxes (id, name, repos, is_default, created_at) VALUES ('sb-lab', 'lab', '[\"acme/api\"]', 0, ?)").run(clock.now());
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
      ? { codex: { accessToken: "at", refreshToken: null, idToken: "it", accountId: "acct", expiresAt: this.expiresAt } }
      : { claude: { oauthToken: "oauth" } };
  };

  harness: Harness = {
    submit: async (input, options = {}) => {
      this.effects.pi.push({ submit: JSON.stringify(input), session: options.session ?? null, operationId: options.operationId ?? null, whenBusy: options.whenBusy ?? null });

      return { operationId: options.operationId ?? "", session: options.session ?? "", accepted: true };
    }
  };

  wire(hub: Hub): void {
    hub.cloud = {
      wake: (name) => this.effects.host.push({ wake: name }),
      turnEnded: (name) => this.effects.host.push({ turnEnded: name })
    };
    hub.recheckAt = (at) => this.effects.host.push({ recheckAt: at });
    hub.onChange(() => this.effects.host.push("changed"));
    hub.attach(this.harness, (task) => !this.unwanted.has(task));
  }

  async apply(hub: Hub, action: Action): Promise<Json> {
    vi.setSystemTime(this.clock.now());
    const result = await this.#apply(hub, action);
    await settle();

    // SAFETY: what the hub returns is JSON: rows, strings, booleans and nulls.
    return JSON.parse(JSON.stringify(result ?? null)) as Json;
  }

  async #apply(hub: Hub, action: Action): Promise<Answer> {
    switch (action.do) {
      case "pair":
        return hub.paired(action.machine, action.facts, action.pairing);
      case "hello":
        this.sockets.set(`${action.machine}:${action.connection}`, { readyState: 1, tags: [`${action.machine}:${action.connection}`] });

        return hub.onReport(action.machine, { type: "hello", protocol: 4, version: "1.0.0", active: action.active, facts: action.facts }, `${action.machine}:${action.connection}`);
      case "close": {
        const socket = this.sockets.get(`${action.machine}:${action.connection}`);

        if (socket) socket.readyState = 3;

        return hub.seen(action.machine, action.code);
      }

      case "report":
        return hub.onReport(action.machine, action.report, `${action.machine}:${action.connection}`);
      case "start":
        return hub.start(action.machine, "A task", "Do the thing", action.task, action.parent, "chat", action.agent);
      case "send": {
        const row = this.feed.get(action.task);

        return row ? hub.send(row, "And more", action.parent) : "no task";
      }

      case "stop": {
        const row = this.feed.get(action.task);

        return row ? hub.stop(row) : "no task";
      }

      case "move": {
        const row = this.feed.get(action.task);

        return row ? hub.move(row, action.to) : "no task";
      }

      case "configure":
        try {
          return hub.configure(action.machine, action.change);
        } catch (error) {
          return { threw: error instanceof Error ? error.message : String(error) };
        }

      case "remove":
        return hub.remove(action.machine);
      case "refused":
        return hub.refused(action.machine, action.protocol);
      case "trouble":
        return hub.trouble(action.machine, action.reason);
      case "startFailed":
        return hub.startFailed(action.machine, "It didn't start.");
      case "sweepTokens":
        return hub.sweepTokens();
      case "recheck":
        return hub.recheck();
      case "post":
        return hub.post();
      case "listSandboxes":
        return hub.listSandboxes();
      case "renewLogin":
        this.expiresAt += 60_000;

        return null;
      case "dropSandbox":
        this.db.prepare("UPDATE ky_sandboxes SET deleted_at = ? WHERE name = 'lab'").run(this.clock.now());

        return null;
      case "wanted":
        if (action.wanted) this.unwanted.delete(action.task);
        else this.unwanted.add(action.task);

        return null;
      case "read":
        return {
          online: hub.online(action.machine),
          machines: hub.machines(),
          busy: hub.busy(action.machine),
          turnsEnded: hub.turnsEnded(action.machine),
          pairedAs: hub.pairedAs(action.machine, action.pairing),
          sandboxFor: hub.sandboxFor(action.repo) ?? null,
          cloudOn: hub.cloudOn() ?? null,
          defaultAgent: hub.defaultAgent(action.machine)
        };
    }
  }

  json(query: string): Json {
    // SAFETY: these tables hold text and numbers alone, no blobs or bigints.
    return this.rows(query) as Json;
  }

  tables(hub: Hub): Json {
    const online = Object.fromEntries(["mini", "box", "cloud", "lab"].map((name) => [name, hub.online(name)]));
    const tables: Record<string, Json> = Object.fromEntries(TABLES.map((table) => [table, this.json(`SELECT * FROM ${table} ORDER BY rowid`)]));

    return { ...tables, online, ky_tasks: this.json("SELECT * FROM ky_tasks ORDER BY id"), ky_task_steps: this.json("SELECT * FROM ky_task_steps ORDER BY seq") };
  }
}

export async function settle(): Promise<void> {
  for (let round = 0; round < 8; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

const MINI: MachineFacts = {
  os: "darwin",
  chrome: true,
  repos: [{ name: "api", remote: "https://github.com/acme/api.git" }],
  agents: { claude: { installed: true, signedIn: true }, codex: { installed: true, signedIn: false } },
  ports: [],
  kind: "computer"
};

function instance(world: World, hub: Hub): Instance<Action> {
  world.wire(hub);
  hub.paired("mini", MINI, "p1");

  return {
    apply: (action) => world.apply(hub, action),
    tables: async () => world.tables(hub),
    effects: async () => world.effects,
    dispose: async () => world.db.close()
  };
}

export async function legacy(clock: Clock): Promise<Instance<Action>> {
  const world = new World(clock);

  // SAFETY: B's hub has the facade's members, typed for B's own rows.
  const hub = new LegacyHub(world.durable.sql(), world.feed, world.socketsOf, world.files, world.tokens, world.creds, world.sandboxes) as Hub;

  return instance(world, hub);
}

export async function next(clock: Clock): Promise<Instance<Action>> {
  const world = new World(clock);

  return instance(world, new MachineHub(world.durable.storage(), world.feed, world.socketsOf, world.files, world.tokens, world.creds, world.sandboxes));
}
