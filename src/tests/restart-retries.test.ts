import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Sandbox, saveKey } from "../sandboxes";
import { call, inside } from "./drive";
import { type CloudMachine, FakeBox } from "./stack";

/**
 * Restart safety's retries (src/cloud.ts): a sandbox whose starts or saves keep failing retries on
 * a bounded schedule and says why. The real CloudMachine runs over generated operations: tasks
 * opening and their turns ending, the platform firing the alarm the machine booked (the test's
 * clock moves to its time), starts refused, saves answering 500, both mended, idle time and wakes.
 * Its container is the in-memory FakeBox. Invariants, checked after every operation:
 *
 * - P3a: between two resets (a wake, which new work brings, or a good start), the starts, and the
 *   machine tokens they were handed, are no more than the backoff allows in the time that passed:
 *   the k-th comes at least RETRY_MS·(2^k − 1), capped at TICK_MS a step, after the first.
 * - P3b: once starts have failed START_DEADLINE_MS while work waits, the waiting tasks fail once
 *   with "The sandbox didn't start", the machine says so, and no start comes until the next wake.
 * - P3c: after SAVE_FAILURES_BEFORE_REASON failed saves or snapshots in a row the machine says it
 *   couldn't save its files; a save that works clears that, and the count.
 * - P3d: a good start clears the count of failed starts; no destroy throws away a disk R2 lacks.
 */

/** src/cloud.ts's numbers, which the property is about: the tick the test runs at is production's. */
const RETRY_MS = 5_000;

const TICK_MS = 60_000;

const START_DEADLINE_MS = 10 * 60_000;

const SAVE_FAILURES_BEFORE_REASON = 5;

type Op = { readonly op: "newTask" | "turnEnd" | "fire" | "fireMany" | "startFails" | "saveFails" | "heal" | "wake" | "idle" };

const ORIGIN = "https://ky.test";

// SAFETY: src/tests/wrangler.jsonc binds CloudMachine to the test stack's subclass.
const machine = (id: string) => (env.CloudMachine as DurableObjectNamespace<CloudMachine>).getByName(id);

/** Run `work` in the sandbox `id`'s CloudMachine, on its in-memory container stamped with its clock. */
const onBox = <T>(id: string, work: (instance: CloudMachine, box: FakeBox) => Promise<T> | T) =>
  runInDurableObject(machine(id), (instance: CloudMachine) => {
    if (!instance.fake) {
      instance.fake = new FakeBox();
      instance.fake.clock = () => instance.clock();
    }

    return work(instance, instance.fake);
  });

/** The earliest time after a reset the k-th start may come, k from 0. */
function earliest(k: number): number {
  let at = 0;

  for (let step = 1; step <= k; step++) at += Math.min(RETRY_MS * 2 ** (step - 1), TICK_MS);

  return at;
}

type Run = {
  readonly id: string;
  readonly name: string;
  /** The tasks open on it, which the model expects to wait or run. */
  open: string[];
  /** The tasks P3b failed, which must stay failed with the start's reason. */
  readonly gaveUp: string[];
  /** The clock's times a busy alarm brought the container up, running. */
  readonly goodStarts: number[];
  /** When a busy alarm first failed to bring it up since the last good start or wake; null while none has. */
  failingSince: number | null;
  /** The disks each destroy threw away that R2 lacked. */
  readonly destroyedUnsaved: string[];
  next: number;
};

const reasonOf = (run: Run) => inside("me", (agent) => agent.machines.machine(run.name)?.reason ?? null);

/** One alarm the platform fires, and what the model learns of it: a good start, or one more failure. */
async function fire(run: Run): Promise<void> {
  const busy = run.open.length > 0;
  const { fired, now, wokeAt, up } = await onBox(run.id, async (instance, box) => {
    const went = await instance.fire();

    return { fired: went, now: instance.clock(), wokeAt: instance.wokeAt.at(-1) ?? 0, up: box.up && box.state === "running" };
  });

  if (!fired || !busy) return;

  if (up) {
    run.goodStarts.push(now);
    run.failingSince = null;
    expect((await onBox(run.id, (instance) => instance.failures())).starts, "P3d: a good start clears the failed starts").toBe(0);

    return;
  }

  // A wake since the first failure starts the count afresh, from this one.
  if (run.failingSince === null || wokeAt > run.failingSince) run.failingSince = now;

  if (now - run.failingSince < START_DEADLINE_MS) return;
  // P3b: the deadline passed at this alarm, which gave up on the waiting tasks.
  run.gaveUp.push(...run.open);
  run.open = [];
  run.failingSince = null;
}

const STEPS: Record<Op["op"], (run: Run) => Promise<void>> = {
  async newTask(run) {
    if (run.open.length > 0) return;
    const task = `rr-task-${crypto.randomUUID()}`;

    await inside("me", (agent) => agent.machines.start(run.name, "restart retries", "work", task, "none", "automation:none", "claude"));
    run.open.push(task);
    // The hub's own wake goes through waitUntil; this one lands now, so the model knows when it came.
    await onBox(run.id, (instance) => instance.wake(run.id, ORIGIN));
  },
  async turnEnd(run) {
    const task = run.open[0];
    const wrote = await onBox(run.id, (_instance, box) => {
      if (!box.up || box.state !== "running") return false;
      box.disk = [...box.disk.split("\n").filter(Boolean), `m${run.next}`].join("\n");

      return true;
    });

    if (task === undefined || !wrote) return;
    run.next++;
    run.open.shift();
    await inside("me", async (agent, state) => {
      const seqs = state.storage.sql.exec<{ seq: number }>("SELECT seq FROM ky_machine_inbox WHERE machine = ?", run.name).toArray();

      for (const { seq } of seqs) await agent.machines.onReport(run.name, { type: "ack", seq }, "restart-retries");
      await agent.machines.onReport(run.name, { type: "result", task, turn: 1, ok: true, text: "done", session: null, agent: "claude" }, "restart-retries");
    });
  },
  fire,
  async fireMany(run) {
    for (let each = 0; each < 5; each++) await fire(run);
  },
  startFails: (run) => onBox(run.id, (_instance, box) => void (box.refusing = true)),
  saveFails: (run) => onBox(run.id, (_instance, box) => void (box.failSaves = true)),
  heal: (run) =>
    onBox(run.id, (_instance, box) => {
      box.refusing = false;
      box.failSaves = false;
    }),
  wake: (run) => onBox(run.id, (instance) => instance.wake(run.id, ORIGIN)),
  idle: (run) => onBox(run.id, (instance) => instance.idleFor(24 * 60 * 60_000))
};

/** The starts after each reset, by the clock: each segment's times. */
function segments(startedAt: readonly number[], resets: readonly number[]): number[][] {
  const bounds = [...resets].sort((a, b) => a - b);
  const all: number[][] = bounds.map(() => []);

  for (const at of startedAt) {
    const index = bounds.findLastIndex((bound) => bound <= at);

    if (index >= 0) all[index]!.push(at - bounds[index]!);
  }

  return all;
}

/** P3a–P3d after an operation `where` says. */
async function holds(run: Run, where: string): Promise<void> {
  const seen = await onBox(run.id, async (instance, box) => ({
    startedAt: [...box.startedAt],
    tokens: box.tokens.length,
    wokeAt: [...instance.wokeAt],
    uploads: [...box.uploads],
    failures: await instance.failures()
  }));
  // A good start ends its segment just after it: the next start begins the next one.
  const resets = [0, ...seen.wokeAt, ...run.goodStarts.map((at) => at + 0.5)];

  for (const segment of segments(seen.startedAt, resets)) {
    for (const [k, after] of segment.entries()) expect(after, `P3a: start ${k} of a segment came too soon ${where}`).toBeGreaterThanOrEqual(earliest(k));
    expect(segment.length, `P3b: starts went on past the deadline ${where}`).toBeLessThanOrEqual(1 + [...Array(40).keys()].filter((k) => earliest(k + 1) <= START_DEADLINE_MS + TICK_MS).length);
  }

  expect(seen.tokens, `P3a: a machine token for each start, no more ${where}`).toBe(seen.startedAt.length);
  const reason = await reasonOf(run);
  const trailing = seen.uploads.length - 1 - seen.uploads.findLastIndex((ok) => ok);

  if (trailing >= SAVE_FAILURES_BEFORE_REASON) expect(reason ?? "", `P3c: the machine says its saves fail ${where}`).toContain("couldn't save its files");

  if (seen.uploads.at(-1) === true) {
    expect(reason ?? "", `P3c: a save that works clears its reason ${where}`).not.toContain("couldn't save its files");
    expect(seen.failures.saves, `P3c: a save that works clears the count ${where}`).toBe(0);
  }

  if (run.gaveUp.length > 0) {
    const failed = await inside("me", (agent) => run.gaveUp.map((task) => agent.feed.get(task)));

    for (const row of failed) expect([row?.status, row?.summary], `P3b: a waiting task failed with the start's reason ${where}`).toEqual(["failed", expect.stringContaining("didn't start")]);
  }

  expect(run.destroyedUnsaved, `P3d: a destroy threw away a disk R2 lacked ${where}`).toEqual([]);
}

async function begin(): Promise<Run> {
  const created = await call("/api/sandboxes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `rr-${crypto.randomUUID().slice(0, 8)}` }) });

  if (created.status !== 201) throw new Error(`Not created: ${await created.text()}`);
  const { id, name } = await created.json<Sandbox>();
  const run: Run = { id, name, open: [], gaveUp: [], goodStarts: [], failingSince: null, destroyedUnsaved: [], next: 0 };

  await onBox(id, async (instance, box) => {
    await instance.hold();
    await instance.retime(TICK_MS);
    await instance.primed(id, ORIGIN);
    box.onDestroy = async (disk) => {
      const saved = new Set(((await (await env.FILES.get(saveKey(id)))?.text()) ?? "").split("\n"));

      run.destroyedUnsaved.push(...disk.split("\n").filter((marker) => marker && !saved.has(marker)));
    };
  });

  return run;
}

async function end(run: Run): Promise<void> {
  await inside("me", async (agent) => {
    for (const task of run.open) await agent.machines.onReport(run.name, { type: "result", task, turn: 1, ok: false, text: "test over", session: null, agent: "claude" }, "restart-retries");
  });
  await onBox(run.id, async (instance, box) => {
    box.onDestroy = undefined;
    await instance.reset(run.id);
  });
  await call(`/api/sandboxes/${run.id}`, { method: "DELETE" });
  await call(`/api/sandboxes/kept/${run.id}`, { method: "DELETE" });
}

async function play(ops: readonly Op[]): Promise<void> {
  const run = await begin();

  try {
    for (const [at, { op }] of ops.entries()) {
      await STEPS[op](run);
      await holds(run, `after op ${at} (${op}) of ${JSON.stringify(ops.map((each) => each.op))}`);
    }
  } finally {
    await end(run);
  }
}

/** Weighted to fire often, so the clock runs past the backoff's cap and the deadline. */
const anOp = fc.oneof(
  ...(
    [
      ["newTask", 3],
      ["turnEnd", 2],
      ["fire", 4],
      ["fireMany", 3],
      ["startFails", 2],
      ["saveFails", 2],
      ["heal", 1],
      ["wake", 1],
      ["idle", 1]
    ] as const
  ).map(([op, weight]) => ({ weight, arbitrary: fc.constant<Op>({ op }) }))
);

const sequence = (...names: Op["op"][]): Op[] => names.map((op) => ({ op }));

describe("a sandbox's retries", () => {
  it("bounds its starts by the backoff, gives up at the deadline, and says why its saves fail, over generated operations", { timeout: 900_000 }, async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(anOp, { minLength: 8, maxLength: 40, size: "max" }), (ops) => play(ops)),
      { numRuns: 100, verbose: 1 }
    );
  });

  it("fails a task whose starts keep failing once, at the deadline, and starts no more", async () => {
    await play(sequence("startFails", "newTask", "fire", "fireMany", "fireMany", "fireMany", "fireMany", "fire", "fire"));
  });

  it("says a sandbox couldn't save its files after five failed snapshots, and clears it once one works", async () => {
    await play(sequence("newTask", "fire", "turnEnd", "saveFails", "fireMany", "fire", "heal", "fire"));
  });

  it("keeps a stopped runner whose save fails, and gives up on its start at the deadline", async () => {
    await play(sequence("newTask", "fire", "turnEnd", "saveFails", "idle", "fire", "newTask", "fireMany", "fireMany", "fireMany", "fireMany", "heal", "newTask", "fire"));
  });
});
