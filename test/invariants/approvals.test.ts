import * as Schema from "effect/Schema";
import fc from "fast-check";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ApprovalDeps, Approvals } from "../../src/approvals/approvals";
import { type ApprovalAction, type ApprovalKind, APPROVAL_TABLES, GONE, type ToolPolicy } from "../../src/approvals/contract";
import { type ExecutorApprovalDeps, ExecutorApprovals } from "../../src/approvals/executor";
import type { CallResult, ExecutorCall } from "../../src/executor";
import { budget, type Json } from "../parity/kit";
import { storageOf } from "../parity/skills/storage";

fc.configureGlobal({ baseSize: "large" });

const START = Date.UTC(2026, 0, 1);

const CARRY_MS = 60_000;

const DECIDED: Record<ApprovalAction, string> = { accept: "accepted", decline: "declined", cancel: "cancelled" };

const CONVERSATIONS = ["here", "away", "side-1"] as const;

type Conversation = (typeof CONVERSATIONS)[number];

type Outcome = "ok" | "expire" | "reopen" | "throw" | "hang" | "late";

const aConversation = fc.constantFrom(...CONVERSATIONS);

const flush = () => new Promise((resolve) => setImmediate(resolve));

const DONE: CallResult = { output: [{ type: "text", text: "done" }] };

const defer = (work: Promise<unknown>) => void work.catch(() => {});

type Seen = {
  changes: number;
  policyChanges: number;
  readonly notified: Json[];
  readonly told: Json[];
  readonly decided: Json[];
  readonly lost: Json[];
  readonly reopened: Json[];
  readonly calls: Json[];
};

function world(db: DatabaseSync) {
  const seen: Seen = { changes: 0, policyChanges: 0, notified: [], told: [], decided: [], lost: [], reopened: [], calls: [] };
  const outcomes = new Map<string, Outcome>();
  const late = new Map<string, Array<() => void>>();

  const deps: ApprovalDeps = {
    present: (session: string) => session === "here",
    home: (session: string) => (session === "side-1" ? "here" : session),
    notify: (chat: string, text: string) => void seen.notified.push([chat, text]),
    defer
  };

  const executorDeps: ExecutorApprovalDeps = {
    config: async () => null,
    present: deps.present,
    tell: async (session: string, content: string, requestId: string) => void seen.told.push([session, content, requestId])
  };

  const approvals = new Approvals(storageOf(db), deps);
  const executor = new ExecutorApprovals(storageOf(db), approvals, executorDeps);

  const call: ExecutorCall = async (name, args) => {
    seen.calls.push([name, JSON.stringify(args)]);

    return DONE;
  };

  approvals.onChange(() => seen.changes++);
  executor.onPolicies(() => seen.policyChanges++);
  approvals.handle("executor", executor);

  for (const kind of ["webhook-action", "secret-request"] as const) {
    approvals.handle(kind, {
      decide: async (approval, action, settle) => {
        const outcome = outcomes.get(approval.ref) ?? "ok";
        seen.decided.push([approval.kind, approval.ref, action, approval.status, outcome]);

        if (outcome === "expire") settle.expire();

        if (outcome === "reopen") seen.reopened.push(settle.reopen());

        if (outcome === "throw") throw new Error("handler failed");

        if (outcome === "hang") await new Promise(() => {});

        if (outcome === "late") await new Promise<void>((resolve) => void late.set(approval.ref, [...(late.get(approval.ref) ?? []), resolve]));
      },
      lost: async (approval, action) => void seen.lost.push([approval.kind, approval.ref, action, approval.status])
    });
  }

  const idOf = (kind: ApprovalKind, ref: string) => approvals.byRef(kind, ref)?.id ?? "none";

  const ask = (kind: ApprovalKind, ref: string, conversation: Conversation, summary: string) =>
    approvals.requestApproval({ kind, ref, subject: "subject", summary, payload: { ref }, conversation });

  const decide = (kind: ApprovalKind, ref: string, action: ApprovalAction, outcome: Outcome) => {
    outcomes.set(ref, outcome);

    return approvals.onDecision(idOf(kind, ref), action);
  };

  const release = (ref: string) => {
    const waiting = late.get(ref) ?? [];
    late.delete(ref);

    for (const resolve of waiting) resolve();

    return waiting.length;
  };

  const replied = (status: "approval-required" | "input-required", requestId: string, conversation: Conversation, toolPath?: string) => {
    const text = JSON.stringify({ status, requestId, message: "Send the mail", toolPath });

    return executor.replied({ output: [{ type: "text", text }], isError: false }, conversation, call);
  };

  return { seen, approvals, executor, call, ask, decide, release, replied };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const Stored = Schema.Struct({ status: Schema.String });

const Count = Schema.Struct({ n: Schema.Number });

function port() {
  let at = START;
  vi.spyOn(Date, "now").mockImplementation(() => at);
  const db = new DatabaseSync(":memory:");
  const made = world(db);

  const row = (kind: ApprovalKind, ref: string) => Schema.decodeUnknownSync(Stored)(db.prepare(`SELECT status FROM ${APPROVAL_TABLES.approvals} WHERE kind = ? AND ref = ?`).get(kind, ref));

  return {
    ...made,
    db,
    row,
    count: (table: string) => Schema.decodeUnknownSync(Count)(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).n,
    advance: (ms: number) => void (at += ms),
    settle: flush,
    [Symbol.dispose]: () => db.close()
  };
}

const anAction = fc.constantFrom<ApprovalAction>("accept", "decline", "cancel");

describe("a decision", () => {
  it("is taken once: a second tap on a decided approval, or a tap on one never asked, is refused and reaches no handler", async () => {
    await fc.assert(
      fc.asyncProperty(anAction, anAction, fc.constantFrom<Outcome>("ok", "hang", "throw"), async (first, second, outcome) => {
        using ky = port();
        ky.ask("webhook-action", "w1", "here", "Post it");

        expect(ky.decide("webhook-action", "w1", first, outcome)).toEqual({});
        await ky.settle();
        expect(ky.decide("webhook-action", "w1", second, "ok")).toEqual({ refused: GONE });
        expect(ky.approvals.onDecision(crypto.randomUUID(), first)).toEqual({ refused: GONE });
        await ky.settle();

        expect(ky.seen.decided).toHaveLength(1);
        expect(ky.row("webhook-action", "w1").status).toBe(DECIDED[first]);
        vi.restoreAllMocks();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });
});

describe("recover", () => {
  it("puts back a decision no one carried out once CARRY_MS has passed, and only that", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.integer({ min: 0, max: 3 * CARRY_MS }), fc.constantFrom(CARRY_MS - 1, CARRY_MS, CARRY_MS + 1)),
        fc.constantFrom<Outcome>("ok", "hang", "throw"),
        anAction,
        async (elapsed, outcome, action) => {
          using ky = port();
          ky.ask("secret-request", "s1", "away", "Use the key");
          ky.decide("secret-request", "s1", action, outcome);
          await ky.settle();
          ky.advance(elapsed);
          ky.approvals.recover();
          await ky.settle();

          const back = outcome === "hang" && elapsed > CARRY_MS;

          expect(ky.row("secret-request", "s1").status).toBe(back ? "pending" : DECIDED[action]);
          expect(ky.seen.lost).toEqual(back ? [["secret-request", "s1", action, "pending"]] : []);
          vi.restoreAllMocks();
        }
      ),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });
});

describe("a decision a restart cut off", () => {
  it("is carried only by its own handler: one that finishes after recover() and a second tap leaves the second decision to recover", async () => {
    await fc.assert(
      fc.asyncProperty(anAction, anAction, async (first, second) => {
        using ky = port();
        ky.ask("secret-request", "s1", "away", "Use the key");
        ky.decide("secret-request", "s1", first, "late");
        await ky.settle();
        ky.advance(CARRY_MS + 1);
        ky.approvals.recover();
        expect(ky.decide("secret-request", "s1", second, "hang")).toEqual({});
        expect(ky.release("s1")).toBe(1);
        await ky.settle();
        ky.advance(CARRY_MS + 1);
        ky.approvals.recover();

        expect(ky.row("secret-request", "s1").status).toBe("pending");
        expect(ky.seen.lost).toEqual([
          ["secret-request", "s1", first, "pending"],
          ["secret-request", "s1", second, "pending"]
        ]);
        vi.restoreAllMocks();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });
});

describe("a tool's policy", () => {
  it("Allow runs it while the user is here and asks when they're away, Ask always asks, Block declines it", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom<ToolPolicy>("allow", "ask", "block"), fc.constantFrom<Conversation>("here", "away"), async (policy, conversation) => {
        using ky = port();
        ky.executor.setPolicy("gmail.send", policy);
        await ky.replied("approval-required", "q1", conversation, "gmail.send");

        const resume = (action: string) => [["resume", JSON.stringify({ requestId: "q1", response: { action } })]];
        const asks = policy === "ask" || (policy === "allow" && conversation === "away");

        expect(ky.seen.calls).toEqual(asks ? [] : resume(policy === "block" ? "decline" : "accept"));
        expect(ky.count(APPROVAL_TABLES.approvals)).toBe(asks ? 1 : 0);
        vi.restoreAllMocks();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });
});

describe("asking", () => {
  it("notifies the user's devices only when they aren't in the chat, and once for an approval asked again", async () => {
    await fc.assert(
      fc.asyncProperty(aConversation, fc.integer({ min: 1, max: 3 }), async (conversation, times) => {
        using ky = port();

        for (let i = 0; i < times; i++) ky.ask("executor", "q1", conversation, "Send it");

        expect(ky.seen.notified).toEqual(conversation === "here" ? [] : [[conversation === "side-1" ? "here" : conversation, "Waiting for your OK: Send it"]]);
        expect(ky.count(APPROVAL_TABLES.approvals)).toBe(1);
        vi.restoreAllMocks();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });
});

describe("an input request", () => {
  it("is answered once, from its own conversation", async () => {
    await fc.assert(
      fc.asyncProperty(aConversation, aConversation, async (asked, answering) => {
        using ky = port();
        await ky.replied("input-required", "in1", asked);

        expect(ky.executor.beforeResume("in1", "answer", answering) === undefined).toBe(asked === answering);
        ky.executor.resumed("in1");

        expect(ky.executor.beforeResume("in1", "answer", asked)).toMatch(/no input request in1/);
        expect(ky.count(APPROVAL_TABLES.inputs)).toBe(0);
        vi.restoreAllMocks();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });
});
