import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Deliveries } from "../../src/automations/delivery";

/**
 * An automation's report reaches its chat (src/automations/delivery.ts), run over generated operations on a real
 * SQLite: reports handed over (ids repeat, as a retried run hands its report over again), chats going busy and
 * idle, turns ending, the object restarting, and a crash between pi taking a report and its row being marked.
 * Some items are a look's messages, posted as ky's own. The chats are a fake pi that takes a request id once and
 * starts a run with each report it takes, and none with a look's message. Old rows a
 * past ky sent to the brief are there from the start. Once every chat has gone idle and the object has started
 * again:
 *
 * - every report and look message handed over is in its chat once, with what its first hand-over said, in hand-over order;
 * - a report an older ky sent to the brief is never put in a chat, and no row is left queued.
 */

const SESSIONS = ["0", "s1", "s2"] as const;

/** Ids of a look's messages, handed over with kind look. */
const LOOKS = ["l1", "l2"] as const;

/** Ids a past ky sent to the brief, as rows in state 'brief'. */
const BRIEFED = ["b1", "b2"] as const;

type Op =
  | { readonly op: "deliver"; readonly id: string; readonly session: string; readonly content: string }
  | { readonly op: "busy" | "idle" | "turnEnd"; readonly session: string }
  | { readonly op: "restart" | "crashNext" };

const session = fc.constantFrom(...SESSIONS);

const anOp: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ op: fc.constant("deliver" as const), id: fc.constantFrom("r1", "r2", "r3", "r4", ...LOOKS, ...BRIEFED), session, content: fc.string({ maxLength: 8 }) }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constantFrom("busy" as const, "idle" as const, "turnEnd" as const), session }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constantFrom("restart" as const, "crashNext" as const) }) }
);

type Storage = ConstructorParameters<typeof Deliveries>[0];

/** The SQLite Deliveries keeps its rows in: only `exec(...).toArray()`, which is all it uses. */
function storage(db: DatabaseSync): Storage {
  const exec = (query: string, ...bindings: SQLInputValue[]) => {
    const rows = db.prepare(query).all(...bindings);

    return { toArray: () => rows.map((row) => ({ ...row })) };
  };

  // SAFETY: Deliveries calls exec and reads toArray, nothing else of SqlStorage or its cursor.
  return { exec, databaseSize: 0 } as Storage;
}

/** pi's chats: a request id is taken once, a taken report starts a run (a look's message none), and a busy chat takes nothing. */
class Chats {
  readonly busy = new Set<string>();
  readonly posted: { id: string; session: string; content: string }[] = [];
  #taken = new Set<string>();
  #waiters: { session: string; resolve: () => void }[] = [];
  /** The next report pi takes is followed by a crash, before its row is marked. */
  crashNext = false;
  /** Bumped by a restart: an older object's waits never end and its submits fail. */
  life = 0;

  submit(life: number, session: string, content: string, id: string, starts = true): boolean {
    if (life !== this.life) throw new Error("This object was restarted.");

    if (this.busy.has(session)) return false;

    if (!this.#taken.has(id)) {
      this.#taken.add(id);
      this.posted.push({ id, session, content });

      if (starts) this.busy.add(session);
    }

    if (this.crashNext) {
      this.crashNext = false;
      this.life++;
      throw new Error("The object crashed.");
    }

    return true;
  }

  idle(life: number, session: string): Promise<void> {
    if (life === this.life && !this.busy.has(session)) return Promise.resolve();

    return new Promise((resolve) => {
      if (life === this.life) this.#waiters.push({ session, resolve });
    });
  }

  done(session: string): void {
    this.busy.delete(session);
    const ready = this.#waiters.filter((waiter) => waiter.session === session);
    this.#waiters = this.#waiters.filter((waiter) => waiter.session !== session);

    for (const waiter of ready) waiter.resolve();
  }

  restart(): void {
    this.life++;
    this.#waiters = [];
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** One ky object over its rows and its chats, started again after a restart or a crash. */
class World {
  readonly db = new DatabaseSync(":memory:");
  readonly chats = new Chats();
  /** Each id's first hand-over, in hand-over order. */
  readonly handed = new Map<string, { session: string; content: string }>();
  #deliveries: Deliveries;
  #opened = 0;
  #now = 1_000;

  constructor() {
    this.#deliveries = this.#open();

    for (const [index, id] of BRIEFED.entries()) {
      this.db.prepare("INSERT INTO ky_deliveries (id, session, content, line, ref, state, created_at, delivered_at) VALUES (?, '0', 'old', 'old', 'old', 'brief', ?, ?)").run(id, index, index);
    }
  }

  async step(op: Op): Promise<void> {
    if (op.op === "deliver") await this.#deliver(op);
    else if (op.op === "busy") this.chats.busy.add(op.session);
    else if (op.op === "idle") this.chats.done(op.session);
    else if (op.op === "turnEnd") this.#deliveries.atBoundary(op.session);
    else if (op.op === "crashNext") this.chats.crashNext = true;

    // A restart, or a crash a submit just had: the object starts again.
    if (op.op === "restart" || this.chats.life !== this.#opened) this.restart();

    await settle();
  }

  restart(): void {
    this.chats.restart();
    this.#deliveries = this.#open();
    this.#deliveries.recover(this.#now);
  }

  async #deliver({ id, session, content }: { id: string; session: string; content: string }): Promise<void> {
    if (!this.handed.has(id)) this.handed.set(id, { session, content });
    const kind = LOOKS.some((look) => look === id) ? "look" : "event";
    await this.#deliveries.deliver({ id, session, content, line: content, ref: `task:${id}`, kind }, this.#now++).catch(() => undefined);
  }

  #open(): Deliveries {
    const life = this.chats.life;
    this.#opened = life;

    return new Deliveries(storage(this.db), {
      surfaced: { shown: () => undefined },
      submit: async (at, content, id) => this.chats.submit(life, at, content, id),
      post: async (at, text, id) => this.chats.submit(life, at, text, id, false),
      idle: (at) => this.chats.idle(life, at),
      later: (work) => void work.catch(() => undefined)
    });
  }
}

async function play(ops: readonly Op[]): Promise<void> {
  const world = new World();

  for (const op of ops) await world.step(op);

  // Every chat goes idle and stays so; the object starts once more, as it would after any crash.
  world.chats.crashNext = false;
  world.restart();

  for (let round = 0; round < 50; round++) {
    for (const each of SESSIONS) world.chats.done(each);
    await settle();
  }

  const expected = [...world.handed].flatMap(([id, first]) => (BRIEFED.some((old) => old === id) ? [] : [{ id, session: first.session, content: first.content }]));

  for (const each of SESSIONS) {
    expect(world.chats.posted.filter((post) => post.session === each)).toEqual(expected.filter((post) => post.session === each));
  }

  expect(world.db.prepare("SELECT id FROM ky_deliveries WHERE state = 'queued'").all()).toEqual([]);
}

describe("an automation's report", () => {
  it("reaches its chat once, in full and in order, across busy chats, restarts and crashes; one sent to the brief stays there", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(anOp, { maxLength: 40 }), (ops) => play(ops)),
      { numRuns: 300 }
    );
  });
});
