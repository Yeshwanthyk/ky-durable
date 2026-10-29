import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Sandbox, saveKey } from "../runners/contract";
import { call, inside } from "./drive";
import { type CloudMachine, FakeBox } from "./stack";

/**
 * Restart safety (src/cloud.ts): R2 always holds a sandbox's state as of its last finished turn, so
 * its container may be destroyed or restarted at any time and lose at most the open turn. The real
 * CloudMachine runs over generated operations: tasks opening and their turns ending through the
 * agent's MachineHub, alarm ticks, idle time, crashes, and uploads cut off on their way to R2. Its
 * container is the in-memory FakeBox, whose disk is a set of markers, one per finished turn.
 *
 * The model is independent of the CloudMachine: `durable` is every marker that must be in R2 by
 * now, which a marker joins once a tick ends with its disk running and no upload cut, or a sleep
 * saves it. Invariants, checked after every operation:
 *
 * - P1: R2 holds every durable marker, and each restore into a new container gives them all back.
 * - P2: R2's markers never shrink, and no destroy throws away a marker R2 lacks (a crash may).
 */

type Op = { readonly op: "newTask" | "turnEnd" | "tick" | "crash" | "crashUnseen" | "uploadFailOnce" | "saveCutOnce" | "idleElapsed" | "sleep" | "wake" };

const ORIGIN = "https://ky.test";

/** Past any idle timeout: the sandbox's own minutes, or the deploy's 10. */
const LONG_IDLE_MS = 24 * 60 * 60_000;

// SAFETY: src/tests/wrangler.jsonc binds CloudMachine to the test stack's subclass.
const machine = (id: string) => (env.CloudMachine as DurableObjectNamespace<CloudMachine>).getByName(id);

const markers = (text: string | undefined) => new Set((text ?? "").split("\n").filter(Boolean));

const lacking = (have: ReadonlySet<string>, want: Iterable<string>) => [...want].filter((marker) => !have.has(marker));

const r2 = async (id: string) => markers(await (await env.FILES.get(saveKey(id)))?.text());

/** Run `work` in the sandbox `id`'s CloudMachine, on its in-memory container. */
const onBox = <T>(id: string, work: (instance: CloudMachine, box: FakeBox) => Promise<T> | T) =>
  runInDurableObject(machine(id), (instance: CloudMachine) => {
    instance.fake ??= new FakeBox();

    return work(instance, instance.fake);
  });

/** One generated run: its sandbox, the tasks open on it, and the model. */
type Run = {
  readonly id: string;
  readonly name: string;
  readonly open: string[];
  /** Every marker R2 must hold by now. */
  readonly durable: Set<string>;
  /** The markers each destroy threw away that R2 lacked. */
  readonly destroyedUnsaved: string[];
  /** R2's markers after the last operation. */
  saved: Set<string>;
  /** The restores already checked. */
  restores: number;
  next: number;
};

/** Give the disk a finished turn's marker, as its runner does while it runs; false if it doesn't run. */
const writeMarker = (run: Run, marker: string) =>
  onBox(run.id, (_instance, box) => {
    if (!box.up || box.state !== "running") return false;
    box.disk = [...markers(box.disk), marker].join("\n");

    return true;
  });

/** Its disk's every marker is durable once `work` ends with no upload cut off, if `counts` says so of what it saw. */
async function durableAfter(run: Run, work: (instance: CloudMachine) => Promise<boolean>, counts: (box: FakeBox) => boolean): Promise<void> {
  const before = await onBox(run.id, (_instance, box) => ({ counts: counts(box), disk: box.disk, cuts: box.cuts }));
  const after = await onBox(run.id, async (instance, box) => ({ done: await work(instance), cuts: box.cuts }));

  if (before.counts && after.done && after.cuts === before.cuts) for (const marker of markers(before.disk)) run.durable.add(marker);
}

const STEPS: Record<Op["op"], (run: Run) => Promise<void>> = {
  async newTask(run) {
    // One task open at a time: the sandbox is busy, or idle and free to sleep.
    if (run.open.length > 0) return;
    const task = `rs-task-${crypto.randomUUID()}`;

    await inside("me", (agent) => agent.machines.start(run.name, "restart safety", "work", task, "none", "automation:none", "claude"));
    run.open.push(task);
  },
  async turnEnd(run) {
    const task = run.open[0];

    // A turn ends only on a running runner: it wrote its marker, then reported.
    if (task === undefined || !(await writeMarker(run, `m${run.next}`))) return;
    run.next++;
    run.open.shift();
    await inside("me", async (agent, state) => {
      const seqs = state.storage.sql.exec<{ seq: number }>("SELECT seq FROM ky_machine_inbox WHERE machine = ?", run.name).toArray();

      for (const { seq } of seqs) await agent.machines.onReport(run.name, { type: "ack", seq }, "restart-safety");
      await agent.machines.onReport(run.name, { type: "result", task, turn: 1, ok: true, text: "done", session: null, agent: "claude" }, "restart-safety");
    });
  },
  // A tick that found its runner running and cut no upload leaves its disk's every marker in R2.
  tick: (run) =>
    durableAfter(
      run,
      async (instance) => {
        await instance.tick();

        return true;
      },
      (box) => box.up && box.state === "running"
    ),
  // So does a sleep that saved.
  sleep: (run) =>
    durableAfter(
      run,
      (instance) => instance.sleep().catch(() => false),
      () => true
    ),
  crash: (run) => onBox(run.id, (_instance, box) => box.crash()),
  // Dead, but said to run, as a killed runner's container is for a while.
  crashUnseen: (run) => onBox(run.id, (_instance, box) => box.crash(true)),
  uploadFailOnce: (run) => onBox(run.id, (_instance, box) => void box.cutUploads++),
  saveCutOnce: (run) => onBox(run.id, (_instance, box) => void box.cutSaves++),
  idleElapsed: (run) => onBox(run.id, (instance) => instance.idleFor(LONG_IDLE_MS)),
  wake: (run) => onBox(run.id, (instance) => instance.wake(run.id, ORIGIN))
};

/** P1 and P2, after an operation `where` says. */
async function holds(run: Run, where: string): Promise<void> {
  const now = await r2(run.id);
  const restored = await onBox(run.id, (_instance, box) => box.restored.slice(run.restores));

  run.restores += restored.length;
  expect(lacking(now, run.durable), `P1: R2 lacks a durable marker ${where}`).toEqual([]);

  for (const disk of restored) expect(lacking(markers(disk), run.durable), `P1: a restore lacks a durable marker ${where}`).toEqual([]);
  expect(lacking(now, run.saved), `P2: R2's markers shrank ${where}`).toEqual([]);
  expect(run.destroyedUnsaved, `P2: a destroy threw away markers R2 lacked ${where}`).toEqual([]);
  run.saved = now;
}

/** A fresh sandbox whose CloudMachine ticks only when told, on an in-memory container that reports each destroy's loss. */
async function begin(): Promise<Run> {
  const created = await call("/api/sandboxes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `rs-${crypto.randomUUID().slice(0, 8)}` }) });

  if (created.status !== 201) throw new Error(`Not created: ${await created.text()}`);
  const { id, name } = await created.json<Sandbox>();
  const run: Run = { id, name, open: [], durable: new Set(), destroyedUnsaved: [], saved: new Set(), restores: 0, next: 0 };

  await onBox(id, async (instance, box) => {
    await instance.hold();
    await instance.primed(id, ORIGIN);
    box.onDestroy = async (disk) => {
      run.destroyedUnsaved.push(...lacking(await r2(id), markers(disk)));
    };
  });

  return run;
}

/** Close its open tasks, stop its container, and delete the sandbox and its kept disk. */
async function end(run: Run): Promise<void> {
  await inside("me", async (agent) => {
    for (const task of run.open) await agent.machines.onReport(run.name, { type: "result", task, turn: 1, ok: false, text: "test over", session: null, agent: "claude" }, "restart-safety");
  });
  await onBox(run.id, async (instance, box) => {
    box.onDestroy = undefined;
    box.cutUploads = 0;
    box.cutSaves = 0;
    await instance.reset(run.id);
  });
  await call(`/api/sandboxes/${run.id}`, { method: "DELETE" });
  await call(`/api/sandboxes/kept/${run.id}`, { method: "DELETE" });
}

/** One generated run: a fresh sandbox, the operations, the invariants after each, then the sandbox gone. */
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

/**
 * Weighted so most runs finish turns, tick, and sleep with a save cut off: a sleep cut off between a
 * turn's end and the next tick is the one way a disk gets ahead of every upload.
 */
const anOp = fc.oneof(
  ...(
    [
      ["newTask", 3],
      ["turnEnd", 3],
      ["tick", 3],
      ["sleep", 2],
      ["saveCutOnce", 2],
      ["uploadFailOnce", 1],
      ["crash", 1],
      ["crashUnseen", 1],
      ["idleElapsed", 1],
      ["wake", 1]
    ] as const
  ).map(([op, weight]) => ({ weight, arbitrary: fc.constant<Op>({ op }) }))
);

const sequence = (...names: Op["op"][]): Op[] => names.map((op) => ({ op }));

describe("a sandbox's restart safety", () => {
  it("keeps every finished turn in R2, and never destroys newer work, over generated operations", { timeout: 600_000 }, async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(anOp, { minLength: 8, maxLength: 30, size: "max" }), (ops) => play(ops)),
      { numRuns: 100, verbose: 1 }
    );
  });

  // fast-check's shrunk counterexample on the commit before snapshots (seed -1071661310).
  it("snapshots a finished turn at the next tick, though the sandbox is idle", async () => {
    await play(sequence("newTask", "tick", "turnEnd", "tick", "turnEnd"));
  });

  it("saves a stopped runner's newer disk before it starts afresh", async () => {
    await play(sequence("newTask", "tick", "turnEnd", "saveCutOnce", "sleep", "newTask", "tick"));
  });

  // fast-check's counterexample with #up destroying a stopped runner unsaved: a sleep cut off right after a turn ended.
  it("keeps a turn whose sleep was cut off, as the next task starts the container afresh", async () => {
    await play(
      sequence(
        "uploadFailOnce",
        "newTask",
        "tick",
        "turnEnd",
        "sleep",
        "newTask",
        "tick",
        "uploadFailOnce",
        "sleep",
        "turnEnd",
        "crash",
        "saveCutOnce",
        "saveCutOnce",
        "uploadFailOnce",
        "turnEnd"
      )
    );
  });

  // Live run 3 of test/live-cloud.ts: the follow-up waited START_WITHIN_MS on a container the platform still said ran.
  it("starts a busy sandbox afresh in the same tick when its container died unseen, and restores its last turn", async () => {
    const run = await begin();

    try {
      for (const { op } of sequence("newTask", "tick", "turnEnd", "tick", "newTask", "crashUnseen")) {
        await STEPS[op](run);
        await holds(run, `after ${op}`);
      }

      const began = Date.now();

      await STEPS.tick(run);
      expect(await onBox(run.id, (_instance, box) => ({ up: box.up, starts: box.starts, state: box.state }))).toEqual({ up: true, starts: 2, state: "running" });
      expect(Date.now() - began).toBeLessThan(10_000);
      await holds(run, "after the unseen crash's tick");
      expect([...markers(await onBox(run.id, (_instance, box) => box.disk))]).toEqual(["m0"]);
    } finally {
      await end(run);
    }
  });

  it("tries a cut-off snapshot again at the next tick", async () => {
    await play(sequence("newTask", "tick", "turnEnd", "uploadFailOnce", "tick", "tick", "crash", "newTask", "tick"));
  });
});
