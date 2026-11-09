import fc from "fast-check";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { LookEvents } from "../../src/dreaming/events";
import { storageOf } from "../parity/skills/storage";

/**
 * The model in .claude/skills/verify-formal-looks/Looks.tla, run against the real LookEvents over SQLite: mail
 * arrives (twice, sometimes), a look claims, the model fails or answers, the look posts, and ky restarts mid-look.
 * The harness keeps one look running at a time, as `looking` in Looks.run does.
 *
 * The oracle counts what each post showed from what its claim returned, never from the store's rows:
 * - ShownOnce: no mail reaches two posts;
 * - NoneStranded: after a last look, every mail that arrived was shown, unless the run that took it got its answer
 *   and ky restarted before it posted (the known finding the model allows).
 */

const MAILS = ["mail:1", "mail:2", "mail:3"] as const;

type Op =
  | { readonly kind: "arrive"; readonly mail: (typeof MAILS)[number] }
  | { readonly kind: "start" }
  | { readonly kind: "fail" }
  | { readonly kind: "answer" }
  | { readonly kind: "post" }
  | { readonly kind: "crash" };

const anOp: fc.Arbitrary<Op> = fc.oneof(
  fc.constantFrom(...MAILS).map((mail) => ({ kind: "arrive" as const, mail })),
  fc.constantFrom<Op>({ kind: "start" }, { kind: "fail" }, { kind: "answer" }, { kind: "post" }, { kind: "crash" })
);

/** The look running now, if any: one at a time, as `looking` keeps it. */
type Live = { live: Run | null };

type Run = { readonly id: string; readonly took: readonly string[]; readonly stage: "asking" | "posting" };

const NOW = 1_800_000_000_000;

function play(ops: readonly Op[]) {
  const events = new LookEvents(storageOf(new DatabaseSync(":memory:")));
  const shown = new Map<string, number>();
  const arrived = new Set<string>();
  const lostInPost = new Set<string>();
  const at: Live = { live: null };
  let n = 0;

  const start = () => {
    n += 1;
    const id = `look-${n}`;
    at.live = { id, took: events.claim(id).map((event) => event.id), stage: "asking" };
  };

  const post = (run: Run) => {
    for (const mail of run.took) shown.set(mail, (shown.get(mail) ?? 0) + 1);
  };

  // One op against the live run, if any; the harness drops ops that run's stage cannot take.
  const step = (op: Op, run: Run | null) => {
    if (op.kind === "arrive") {
      events.add(op.mail, "mail", `Mail ${op.mail}`, NOW);
      arrived.add(op.mail);
    } else if (op.kind === "start") {
      if (run === null) start();
    } else if (run !== null) {
      at.live = onRun(op.kind, run);
    }
  };

  // What each op does to a run in each stage: the run that goes on, or null when it ended. Missing pairs are dropped.
  const onRun = (kind: Exclude<Op["kind"], "arrive" | "start">, run: Run): Run | null => {
    const then = new Map<string, () => Run | null>([
      ["asking fail", () => (events.release(run.id), null)],
      ["asking answer", () => (events.ran(run.id, "heartbeat", "read", NOW), { ...run, stage: "posting" })],
      ["posting post", () => (post(run), null)],
      ["asking crash", () => null],
      ["posting crash", () => (run.took.forEach((mail) => lostInPost.add(mail)), null)]
    ]);

    return (then.get(`${run.stage} ${kind}`) ?? (() => run))();
  };

  for (const op of ops) step(op, at.live);

  // A run still going finishes (it answers and posts), then the next look time always comes: one last look.
  const last = at.live;

  if (last !== null) {
    if (last.stage === "asking") events.ran(last.id, "heartbeat", "read", NOW);
    post(last);
  }

  start();
  const final = at.live;

  if (final !== null) {
    events.ran(final.id, "look", "read", NOW);
    post(final);
  }

  return { shown, arrived, lostInPost, claimedAny: n > 0 };
}

describe("a look takes the mail that arrived", () => {
  it("shows each mail once, and none is left that no look can take", () => {
    let reachedRestart = 0;

    fc.assert(
      fc.property(fc.array(anOp, { maxLength: 24 }), (ops) => {
        const { shown, arrived, lostInPost } = play(ops);

        if (ops.some((op) => op.kind === "crash")) reachedRestart += 1;

        for (const [mail, times] of shown) expect(times, `ShownOnce: ${mail}`).toBeLessThanOrEqual(1);

        for (const mail of arrived) if (!lostInPost.has(mail)) expect(shown.get(mail) ?? 0, `NoneStranded: ${mail}`).toBe(1);
      }),
      { numRuns: 400 }
    );
    // The generator reaches restarts mid-look, or a pass says nothing about them.
    expect(reachedRestart).toBeGreaterThan(0);
  });

  it("gives a restarted look's mail to the next look (the trace verify-formal-looks found)", () => {
    const { shown } = play([{ kind: "arrive", mail: "mail:1" }, { kind: "start" }, { kind: "crash" }]);

    expect(shown.get("mail:1")).toBe(1);
  });
});
