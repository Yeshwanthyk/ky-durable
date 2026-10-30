import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import fc from "fast-check";
import type { ConversationDocToken, ConversationId, JsonObject, Tx } from "@earendil-works/pi-durable";
import { Scheduler, type ScheduleOptions, type SchedulerPayload } from "agents/schedules";
import { vi } from "vitest";
import { ChatList } from "../../../src/chats/chats";
import type { AutomationAuthor, AutomationDraft, TaskStatus } from "../../../src/automations/contract";
import { Automations } from "../../../src/automations/wiring";
import { TaskFeed } from "../../../src/automations/tasks";
import type { AutomationDeps, Callbacks, GateAnswer } from "../../../src/automations/automations";
import type { MachineHub } from "../../../src/machines/contract";
import type { MachineInfo } from "../../../src/protocol";
import type { ModelChoice } from "../../../src/settings/contract";
import type { Spawn } from "../../../src/skills/contract";
import type { Clock, Instance, Json } from "../kit";
import { Bookings } from "./scheduler";

const NOTHING: GateAnswer = { text: JSON.stringify({ status: "completed", execution: { ok: true, value: null } }), error: false };

const GATES = new Map<string, GateAnswer>([
  ["nothing", NOTHING],
  ["news", { text: JSON.stringify({ status: "completed", execution: { ok: true, value: "news" } }), error: false }],
  ["more", { text: JSON.stringify({ status: "completed", execution: { ok: true, value: "more news" } }), error: false }],
  ["list", { text: JSON.stringify({ status: "completed", execution: { ok: true, value: [1, 2] } }), error: false }],
  ["throws", { text: JSON.stringify({ status: "completed", execution: { ok: false, error: "no mailbox" } }), error: false }],
  ["approval", { text: JSON.stringify({ status: "approval-required" }), error: false }],
  ["offline", { text: "Executor is offline", error: true }]
]);

const SIDE_CHAT = "5";

const MACHINE = "mini";

const WORKER: ModelChoice = { provider: "workers-ai", modelId: "glm", thinkingLevel: "off" };

const RUN_SESSION = "77";

export type WorldAction =
  | { readonly world: "progress"; readonly id: string; readonly status: TaskStatus }
  | { readonly world: "report"; readonly id: string }
  | { readonly world: "redeliver" }
  | { readonly world: "failNextCommit" }
  | { readonly world: "machine"; readonly state: "on" | "paused" | "off" }
  | { readonly world: "chat"; readonly archived: boolean };

type Change =
  | { readonly create: Partial<AutomationDraft>; readonly author: AutomationAuthor; readonly watch: number | null }
  | { readonly update: string; readonly patch: Partial<AutomationDraft> }
  | { readonly act: "pause" | "stop" | "archive" | "resume" | "delete" | "retire" | "unarchive" | "run"; readonly id: string }
  | { readonly checkIns: boolean }
  | { readonly zone: "setZone" | "pinZone"; readonly name: string }
  | { readonly unpinZone: string | null }
  | { readonly book: "dreamAt" | "recheckMachinesAt" | "sweepPeersAt"; readonly inMs: number }
  | { readonly start: "recover" | "bookLooks" };

type Read =
  | { readonly ask: "wanted" | "checkInRun"; readonly id: string }
  | { readonly checkGate: string }
  | { readonly look: "list" | "watches" | "checkIns" | "chatLabel"; readonly all: boolean };

export type Action = Change | Read | WorldAction;

type Storage = ConstructorParameters<typeof Automations>[0];

type SqlStorageOf = ConstructorParameters<typeof TaskFeed>[0];

type Row = Record<string, SQLOutputValue>;

function openStorage(db: DatabaseSync) {
  let depth = 0;

  const exec = (query: string, ...bindings: SQLInputValue[]) => {
    const statement = db.prepare(query);
    const rows = statement.columns().length > 0 ? statement.all(...bindings).map((row) => ({ ...row })) : (statement.run(...bindings), []);

    return { toArray: () => rows, one: () => rows[0] };
  };

  const transactionSync = <T>(closure: () => T): T => {
    const savepoint = `t${depth}`;
    depth += 1;
    db.exec(`SAVEPOINT ${savepoint}`);

    try {
      const result = closure();
      db.exec(`RELEASE ${savepoint}`);

      return result;
    } catch (error) {
      db.exec(`ROLLBACK TO ${savepoint}`);
      db.exec(`RELEASE ${savepoint}`);
      throw error;
    } finally {
      depth -= 1;
    }
  };

  const sql = { exec, databaseSize: 0 };

  return {
    // SAFETY: automations, the task feed and the chats call sql.exec, read toArray or one, and transactionSync; nothing else.
    storage: (): Storage => ({ sql, transactionSync }) as Storage,
    // SAFETY: as the storage's, of its sql alone.
    sql: (): SqlStorageOf => sql as SqlStorageOf
  };
}

let nextId: (() => number) | undefined;

export function installIds(): void {
  vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
    if (!nextId) throw new Error("randomUUID outside a world's call");

    return `${nextId().toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
  });
}

type Effect = { readonly [key: string]: Json };

export type Seen = { readonly task: string; readonly status: string | null };

const MOVES = new Map<TaskStatus, readonly TaskStatus[]>([
  ["queued", ["working"]],
  ["working", ["done", "failed"]]
]);

export class World {
  readonly db = new DatabaseSync(":memory:");
  readonly durable = openStorage(this.db);
  readonly feed = new TaskFeed(this.durable.sql());
  readonly chats = new ChatList(this.durable.storage());
  readonly effects: Effect[] = [];
  readonly clock: Clock;
  ids = 0;
  emits = 0;
  machineState: "on" | "paused" | "off" = "on";
  failNextCommit = false;
  docs: Record<string, Json> = {};
  readonly started: Seen[] = [];
  readonly posted: Seen[] = [];

  constructor(clock: Clock) {
    this.clock = clock;
    this.chats.add(SIDE_CHAT);
  }

  async in<T>(call: () => T | Promise<T>): Promise<T> {
    nextId = () => (this.ids += 1);
    vi.setSystemTime(this.clock.now());

    try {
      return await call();
    } finally {
      nextId = undefined;
    }
  }

  rows(query: string, ...bindings: SQLInputValue[]): Row[] {
    return this.db.prepare(query).all(...bindings).map((row) => ({ ...row }));
  }

  #did(effect: Effect): void {
    this.effects.push(effect);
  }

  statusOf(task: string): string | null {
    const id = task.split("-")[1] ?? "";
    const [row] = this.rows("SELECT status FROM ky_automations WHERE id = ?", id);

    return row ? String(row.status) : null;
  }

  deps(): AutomationDeps {
    const info = (): MachineInfo => ({ name: MACHINE, online: true, seenAt: 0, reason: null, active: 0, state: this.machineState, note: "", facts: null, login: "own", cloud: null, sandbox: null });

    const machines: Pick<MachineHub, "machines" | "machine" | "defaultAgent" | "start" | "stop" | "recheck"> = {
      machines: () => [info()],
      machine: (name) => (name === MACHINE ? info() : undefined),
      defaultAgent: () => "claude",
      start: (machine, title, prompt, id, parent, source) => {
        if (this.feed.get(id) === undefined) {
          this.#did({ start: machine, title, prompt, id, parent, source: source ?? null });
          this.started.push({ task: id, status: this.statusOf(id) });
        }

        return this.feed.create({ id, kind: "machine", source, worker: machine, title, status: "queued", session: null, agent: "claude" });
      },
      stop: async (task) => this.#did({ stopMachineTask: task.id }),
      recheck: () => this.#did({ recheck: true })
    };

    const spawn: Spawn = async (_tx, owner, request) => {
      this.#did({ spawn: owner, name: request.name, message: request.message, feedId: request.feedId ?? null, label: request.label ?? null, checkIn: request.checkIn ?? false, post: request.post ?? false });
      this.started.push({ task: request.feedId ?? "", status: this.statusOf(request.feedId ?? "") });

      return owner;
    };

    return {
      feed: this.feed,
      // SAFETY: automations call only these six of MachineHub.
      machines: machines as MachineHub,
      chats: this.chats,
      models: {
        worker: (own) => own ?? WORKER,
        valid: (choice) => (choice.modelId === "bad" ? undefined : choice),
        choices: () => "workers-ai/glm (off)"
      },
      runtime: {
        spawn,
        commit: async (change) => {
          if (this.failNextCommit) {
            this.failNextCommit = false;
            throw new Error("pi is busy");
          }

          const docs = structuredClone(this.docs);
          // SAFETY: automations' commits read one doc, their Runs, by conversation; a fresh one is `{ runs: {} }`.
          const tx = { doc: async (_token: ConversationDocToken<JsonObject>, conversation: ConversationId) => (docs[conversation] ??= { runs: {} }) } as Tx;
          await change(tx);
          this.docs = docs;
        },
        wake: async () => this.#did({ wake: true }),
        abort: async (session) => this.#did({ abort: session }),
        deliver: async (item) => this.#did({ deliver: { ...item } })
      },
      gate: async (code) => {
        this.#did({ gate: code });

        return GATES.get(code) ?? NOTHING;
      },
      dream: { cron: (zone) => (zone === null ? "0 3 * * *" : "30 3 * * *"), run: () => this.#did({ dream: true }) },
      looks: {
        booked: (zone) => (zone === null ? [{ time: "09:00", cron: "0 9 * * *" }] : [{ time: "09:00", cron: "0 9 * * *" }, { time: "18:00", cron: "0 18 * * *" }]),
        run: (time) => this.#did({ look: time })
      },
      peers: async () => this.#did({ peers: true }),
      sites: async () => this.#did({ sites: true }),
      unwatched: (anticipation) => this.#did({ unwatched: anticipation })
    };
  }

  tables(): Json {
    // SAFETY: the tables hold text, integers and nulls, all JSON.
    const all = (query: string) => this.rows(query) as Json;

    return {
      automations: all("SELECT * FROM ky_automations ORDER BY id"),
      checkIns: all("SELECT * FROM ky_check_ins"),
      tasks: all("SELECT id, kind, worker, title, status, summary, session, source, created_at, updated_at FROM ky_tasks ORDER BY id"),
      chats: all("SELECT session, archived_at FROM ky_chats ORDER BY session"),
      runs: this.docs
    };
  }

  async world(action: WorldAction, scheduler: Bookings, side: Automations): Promise<Json> {
    switch (action.world) {
      case "progress":
        return this.#progress(action.id, action.status);
      case "report":
        return this.#report(action.id, side);
      case "redeliver":
        await scheduler.redeliver();

        return null;
      case "failNextCommit":
        this.failNextCommit = true;

        return null;
      case "machine":
        this.machineState = action.state;

        return null;
      case "chat":
        this.chats.archive(SIDE_CHAT, action.archived);

        return null;
    }
  }

  #progress(id: string, status: TaskStatus): string | null {
    const task = this.feed.latestFrom(`automation:${id}`);

    if (!task || !MOVES.get(task.status)?.includes(status)) return null;
    this.feed.update(task.id, { status, session: status === "working" && task.kind === "cloud" ? RUN_SESSION : task.session });

    return task.id;
  }

  #report(id: string, side: Automations): boolean {
    const task = this.feed.latestFrom(`automation:${id}`);

    if (task?.status !== "done" || this.posted.some((seen) => seen.task === task.id) || !side.wanted(task.id)) return false;
    this.posted.push({ task: task.id, status: this.statusOf(task.id) });

    return true;
  }
}

const DRAFT: AutomationDraft = { title: "Digest", prompt: "digest the news", cron: null, at: null, model: null, machine: null, chat: "1", gate: null };

type Answer = object | string | number | boolean | null | undefined;

async function settle(call: () => Answer | Promise<Answer | void>): Promise<Json> {
  try {
    const result = await call();

    // SAFETY: what the facade answers is plain data, rows and strings; JSON keeps what is JSON of it.
    return result === undefined ? null : (JSON.parse(JSON.stringify(result)) as Json);
  } catch (error) {
    return { threw: error instanceof Error ? error.message : String(error) };
  }
}

class Booked extends Scheduler<Callbacks> {
  readonly bookings: Bookings<Callbacks>;

  constructor(callbacks: Callbacks) {
    super({ callbacks });
    this.bookings = new Bookings({ callbacks });
  }

  override set<Name extends keyof Callbacks>(when: Date | string | number, callback: Name, payload?: SchedulerPayload<Callbacks[Name]>, options?: ScheduleOptions) {
    return this.bookings.set(when instanceof Date ? when : String(when), callback, payload, options);
  }

  override get(id: string) {
    return this.bookings.get(id);
  }

  override list() {
    return this.bookings.list();
  }

  override cancel(id: string) {
    return this.bookings.cancel(id);
  }
}

export function schedulerOf(side: Automations): Bookings<Callbacks> {
  if (!(side.scheduler instanceof Booked)) throw new Error("The port's Scheduler is not the world's.");

  return side.scheduler.bookings;
}

export const port = (world: World, deps: AutomationDeps) => new Automations(world.durable.storage(), deps, (callbacks) => new Booked(callbacks));

export function next(clock: Clock): Instance<Action> & { world: World; side: Automations; scheduler: Bookings<Callbacks>; due(): Promise<void> } {
  const world = new World(clock);
  const side = port(world, world.deps());
  const scheduler = schedulerOf(side);
  side.onChange(() => {
    world.emits += 1;
  });

  const at = (inMs: number) => clock.now() + inMs;

  const change = (action: Change) => {
    if ("create" in action) return side.create({ ...DRAFT, ...action.create }, action.author, action.watch);

    if ("update" in action) return side.update(action.update, action.patch);

    if ("act" in action) return side[action.act](action.id);

    if ("checkIns" in action) return side.setCheckIns(action.checkIns);

    if ("zone" in action) return side[action.zone](action.name);

    if ("unpinZone" in action) return side.unpinZone(action.unpinZone);

    if ("book" in action) return side[action.book](at(action.inMs));

    return side[action.start]();
  };

  const read = (action: Read) => {
    if ("ask" in action) return side[action.ask](action.ask === "wanted" ? (world.feed.latestFrom(`automation:${action.id}`)?.id ?? `chat-${action.id}`) : RUN_SESSION);

    if ("checkGate" in action) return side.checkGate(action.checkGate);

    if (action.look === "list") return side.list(action.all);

    if (action.look === "chatLabel") return side.chatLabel(action.all ? SIDE_CHAT : "1");

    return side[action.look]();
  };

  const apply = async (action: Action): Promise<Json> => {
    if ("world" in action) return world.in(() => world.world(action, scheduler, side));

    return world.in(() => settle(() => ("ask" in action || "checkGate" in action || "look" in action ? read(action) : change(action))));
  };

  return {
    world,
    side,
    scheduler,
    apply,
    due: () => world.in(() => scheduler.due()),
    nextAlarm: async () => scheduler.nextAlarm(),
    // SAFETY: bookings are ids, names, times and JSON payloads.
    pending: async () => JSON.parse(JSON.stringify(await scheduler.list())) as Json,
    tables: async () => world.tables(),
    effects: async () => ({ did: world.effects, emits: world.emits }),
    dispose: async () => world.db.close()
  };
}

const id = fc.constantFrom("00000001", "00000001", "00000001", "00000002", "00000002", "00000003", "0000000f");

export const HOUR = 3_600_000;

export const START = Date.UTC(2026, 9, 25, 8, 0, 0);

const timing = fc.oneof(
  fc.record({ cron: fc.constantFrom("*/30 * * * *", "*/30 * * * *", "0 9 * * *", "0 9 * * 1-5", "every day"), at: fc.constant(null) }),
  fc.record({ cron: fc.constant(null), at: fc.integer({ min: -HOUR, max: 6 * HOUR }).map((inMs) => START + inMs) })
);

const draftOf = (odd: boolean) =>
  fc.record(
    {
      title: odd ? fc.constantFrom("Digest", " ") : fc.constantFrom("Digest", "Mail"),
      gate: odd ? fc.constantFrom(null, ...GATES.keys(), " ") : fc.constantFrom(null, null, ...GATES.keys()),
      machine: odd ? fc.constantFrom(null, MACHINE, "nas") : fc.constantFrom(null, null, MACHINE),
      chat: odd ? fc.constantFrom("1", SIDE_CHAT, "9") : fc.constantFrom("1", "1", SIDE_CHAT),
      model: odd ? fc.constantFrom(null, { provider: "workers-ai", modelId: "bad", thinkingLevel: "off" as const }) : fc.constant(null),
      post: fc.boolean()
    },
    { requiredKeys: [] }
  );

const create = (odd: boolean) =>
  fc.record({
    create: fc.tuple(draftOf(odd), timing).map(([drafted, when]) => ({ ...drafted, ...when })),
    author: odd ? fc.constantFrom("user", "ky", "dream") : fc.constantFrom("user", "user", "ky"),
    watch: fc.constantFrom(null, null, 7)
  });

export const actions: fc.Arbitrary<Action> = fc.oneof(
  { weight: 6, arbitrary: create(false) },
  { weight: 2, arbitrary: create(true) },
  { weight: 3, arbitrary: fc.record({ update: id, patch: fc.oneof(draftOf(true), timing) }) },
  { weight: 8, arbitrary: fc.record({ act: fc.constantFrom("pause", "stop", "archive", "resume", "delete", "retire", "unarchive", "run"), id }) },
  { weight: 1, arbitrary: fc.record({ checkIns: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ zone: fc.constantFrom("setZone", "pinZone"), name: fc.constantFrom("Europe/London", "America/New_York", "Mars/Olympus") }) },
  { weight: 1, arbitrary: fc.record({ unpinZone: fc.constantFrom(null, "Asia/Tokyo") }) },
  { weight: 1, arbitrary: fc.record({ book: fc.constantFrom("dreamAt", "recheckMachinesAt", "sweepPeersAt"), inMs: fc.integer({ min: 0, max: 2 * HOUR }) }) },
  { weight: 1, arbitrary: fc.record({ start: fc.constantFrom("recover", "bookLooks") }) },
  { weight: 2, arbitrary: fc.record({ ask: fc.constantFrom("wanted", "checkInRun"), id }) },
  { weight: 1, arbitrary: fc.record({ checkGate: fc.constantFrom(...GATES.keys()) }) },
  { weight: 2, arbitrary: fc.record({ look: fc.constantFrom("list", "watches", "checkIns", "chatLabel"), all: fc.boolean() }) },
  { weight: 4, arbitrary: fc.record({ world: fc.constant("progress"), id, status: fc.constantFrom("working", "done", "failed") }) },
  { weight: 2, arbitrary: fc.record({ world: fc.constant("report"), id }) },
  { weight: 2, arbitrary: fc.record({ world: fc.constant("redeliver") }) },
  { weight: 1, arbitrary: fc.record({ world: fc.constant("failNextCommit") }) },
  { weight: 1, arbitrary: fc.record({ world: fc.constant("machine"), state: fc.constantFrom("on", "paused", "off") }) },
  { weight: 1, arbitrary: fc.record({ world: fc.constant("chat"), archived: fc.boolean() }) }
);
