import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Sandbox, saveKey } from "../sandboxes";
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

type Op =
  | { readonly op: "newTask" }
  | { readonly op: "turnEnd" }
  | { readonly op: "tick" }
  | { readonly op: "crash" }
  | { readonly op: "uploadFailOnce" }
  | { readonly op: "saveCutOnce" }
  | { readonly op: "idleElapsed" }
  | { readonly op: "sleep" }
  | { readonly op: "wake" };

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

/** One generated run: a fresh sandbox, the operations, the invariants after each, then the sandbox gone. */
async function play(ops: readonly Op[]): Promise<void> {
  const created = await call("/api/sandboxes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `rs-${crypto.randomUUID().slice(0, 8)}` }) });

  if (created.status !== 201) throw new Error(`Not created: ${await created.text()}`);
  const { id, name } = await created.json<Sandbox>();
  const destroyedUnsaved: string[] = [];

  await onBox(id, async (instance, box) => {
    await instance.hold();
    await instance.primed(id, ORIGIN);
    box.onDestroy = async (disk) => {
      const lost = lacking(await r2(id), markers(disk));

      if (lost.length > 0) destroyedUnsaved.push(...lost);
    };
  });

  const open: string[] = [];
  const durable = new Set<string>();
  let saved = new Set<string>();
  let restores = 0;
  let next = 0;

  try {
    for (const [at, { op }] of ops.entries()) {
      const where = `after op ${at} (${op}) of ${JSON.stringify(ops.map((each) => each.op))}`;

      switch (op) {
        case "newTask": {
          // One task open at a time: the sandbox is busy, or idle and free to sleep.
          if (open.length > 0) break;
          const task = `rs-task-${crypto.randomUUID()}`;

          await inside("me", (agent) => agent.machines.start(name, "restart safety", "work", task, "none", "automation:none", "claude"));
          open.push(task);
          break;
        }

        case "turnEnd": {
          const task = open[0];
          // A turn ends only on a running runner: it wrote its marker, then reported.
          const marker = `m${next}`;
          const ran = task !== undefined && (await onBox(id, (_instance, box) => box.up && box.state === "running" && ((box.disk = [...markers(box.disk), marker].join("\n")), true)));

          if (!ran) break;
          next++;
          open.shift();
          await inside("me", async (agent, state) => {
            const seqs = state.storage.sql.exec<{ seq: number }>("SELECT seq FROM ky_machine_inbox WHERE machine = ?", name).toArray();

            for (const { seq } of seqs) await agent.machines.onReport(name, { type: "ack", seq }, "restart-safety");
            await agent.machines.onReport(name, { type: "result", task, turn: 1, ok: true, text: "done", session: null, agent: "claude" }, "restart-safety");
          });
          break;
        }

        case "tick": {
          const before = await onBox(id, (_instance, box) => ({ running: box.up && box.state === "running", disk: box.disk, cuts: box.cuts }));
          const cuts = await onBox(id, async (instance, box) => {
            await instance.tick();

            return box.cuts;
          });

          // A tick that found its runner running and cut no upload leaves its disk's every marker in R2.
          if (before.running && cuts === before.cuts) for (const marker of markers(before.disk)) durable.add(marker);
          break;
        }

        case "crash":
          await onBox(id, (_instance, box) => box.crash());
          break;
        case "uploadFailOnce":
          await onBox(id, (_instance, box) => void box.cutUploads++);
          break;
        case "saveCutOnce":
          await onBox(id, (_instance, box) => void box.cutSaves++);
          break;
        case "idleElapsed":
          await onBox(id, (instance) => instance.idleFor(LONG_IDLE_MS));
          break;

        case "sleep": {
          const before = await onBox(id, (_instance, box) => ({ disk: box.disk, cuts: box.cuts }));
          const slept = await onBox(id, async (instance, box) => ({ slept: await instance.sleep().catch(() => false), cuts: box.cuts }));

          if (slept.slept && slept.cuts === before.cuts) for (const marker of markers(before.disk)) durable.add(marker);
          break;
        }

        case "wake":
          await onBox(id, (instance) => instance.wake(id, ORIGIN));
          break;
        default:
          op satisfies never;
      }

      const now = await r2(id);
      const restored = await onBox(id, (_instance, box) => box.restored.slice(restores));

      restores += restored.length;
      expect(lacking(now, durable), `P1: R2 lacks a durable marker ${where}`).toEqual([]);

      for (const disk of restored) expect(lacking(markers(disk), durable), `P1: a restore lacks a durable marker ${where}`).toEqual([]);
      expect(lacking(now, saved), `P2: R2's markers shrank ${where}`).toEqual([]);
      expect(destroyedUnsaved, `P2: a destroy threw away markers R2 lacked ${where}`).toEqual([]);
      saved = now;
    }
  } finally {
    await inside("me", (agent) => {
      for (const task of open) void agent.machines.onReport(name, { type: "result", task, turn: 1, ok: false, text: "test over", session: null, agent: "claude" }, "restart-safety");
    });
    await onBox(id, async (instance, box) => {
      box.onDestroy = undefined;
      box.cutUploads = 0;
      box.cutSaves = 0;
      await instance.reset(id);
    });
    await call(`/api/sandboxes/${id}`, { method: "DELETE" });
    await call(`/api/sandboxes/kept/${id}`, { method: "DELETE" });
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
      ["idleElapsed", 1],
      ["wake", 1]
    ] as const
  ).map(([op, weight]) => ({ weight, arbitrary: fc.constant<Op>({ op }) }))
);

const sequence = (...names: Op["op"][]): Op[] => names.map((op) => ({ op }) as Op);

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

  it("tries a cut-off snapshot again at the next tick", async () => {
    await play(sequence("newTask", "tick", "turnEnd", "uploadFailOnce", "tick", "tick", "crash", "newTask", "tick"));
  });
});
