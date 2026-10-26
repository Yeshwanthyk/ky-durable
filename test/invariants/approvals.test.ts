import * as Schema from "effect/Schema";
import fc from "fast-check";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ApprovalDeps, type ApprovalHandler, Approvals } from "../../src/approvals/approvals";
import { type ApprovalAction, type ApprovalKind, APPROVAL_TABLES, GONE, type ToolPolicy } from "../../src/approvals/contract";
import { type ExecutorApprovalDeps, ExecutorApprovals } from "../../src/approvals/executor";
import type { CallResult, ExecutorCall, ResumeAction } from "../../src/executor";
import { assertParity, type Clock, type Instance, type Json, type Parity } from "../parity/kit";
import { legacyOf } from "../parity/approvals/legacy";
import { storageOf, StoredRow } from "../parity/skills/storage";

fc.configureGlobal({ baseSize: "large" });

const START = Date.UTC(2026, 0, 1);

const CARRY_MS = 60_000;

const DECIDED: Record<ApprovalAction, string> = { accept: "accepted", decline: "declined", cancel: "cancelled" };

const CONVERSATIONS = ["here", "away", "side-1"] as const;

type Conversation = (typeof CONVERSATIONS)[number];

const REFS: Record<ApprovalKind, readonly string[]> = { executor: ["q1", "q2"], "webhook-action": ["w1", "w2"], "secret-request": ["s1"] };

const TOOLS = ["gmail.send", "calendar.read", ""];

type Outcome = "ok" | "expire" | "reopen" | "throw" | "hang";

type Action =
  | { readonly ask: ApprovalKind; readonly ref: string; readonly conversation: Conversation; readonly summary: string }
  | { readonly decide: ApprovalKind; readonly ref: string; readonly action: ApprovalAction; readonly outcome: Outcome }
  | { readonly withdraw: ApprovalKind; readonly ref: string; readonly action: "decline" | "cancel" }
  | { readonly recover: true }
  | { readonly replied: "approval-required" | "input-required"; readonly requestId: string; readonly tool: string; readonly conversation: Conversation; readonly isError: boolean }
  | { readonly setPolicy: string; readonly policy: ToolPolicy }
  | { readonly beforeResume: string; readonly action: ResumeAction; readonly conversation: Conversation }
  | { readonly resumed: string }
  | { readonly config: "none" | "throw" }
  | { readonly read: true };

const aKind = fc.constantFrom<ApprovalKind>("executor", "webhook-action", "secret-request");

const aRef = (kind: ApprovalKind) => fc.constantFrom(...REFS[kind], "none");

const aConversation = fc.constantFrom(...CONVERSATIONS);

const aRequest = fc.constantFrom("q1", "q2", "in1");

const actions: fc.Arbitrary<Action> = fc.oneof(
  { arbitrary: aKind.chain((kind) => fc.record({ ask: fc.constant(kind), ref: aRef(kind), conversation: aConversation, summary: fc.constantFrom("Send it", "x".repeat(220)) })), weight: 4 },
  {
    arbitrary: aKind.chain((kind) =>
      fc.record({ decide: fc.constant(kind), ref: aRef(kind), action: fc.constantFrom<ApprovalAction>("accept", "decline", "cancel"), outcome: fc.constantFrom<Outcome>("ok", "expire", "reopen", "throw", "hang") })
    ),
    weight: 4
  },
  { arbitrary: aKind.chain((kind) => fc.record({ withdraw: fc.constant(kind), ref: aRef(kind), action: fc.constantFrom<"decline" | "cancel">("decline", "cancel") })), weight: 1 },
  { arbitrary: fc.constant({ recover: true as const }), weight: 2 },
  {
    arbitrary: fc.record({
      replied: fc.constantFrom<"approval-required" | "input-required">("approval-required", "input-required"),
      requestId: aRequest,
      tool: fc.constantFrom(...TOOLS),
      conversation: aConversation,
      isError: fc.boolean()
    }),
    weight: 3
  },
  { arbitrary: fc.record({ setPolicy: fc.constantFrom(...TOOLS.filter(Boolean)), policy: fc.constantFrom<ToolPolicy>("allow", "ask", "block") }), weight: 2 },
  { arbitrary: fc.record({ beforeResume: aRequest, action: fc.constantFrom<ResumeAction>("answer", "decline", "cancel"), conversation: aConversation }), weight: 2 },
  { arbitrary: fc.record({ resumed: aRequest }), weight: 1 },
  { arbitrary: fc.record({ config: fc.constantFrom<"none" | "throw">("none", "throw") }), weight: 1 },
  { arbitrary: fc.constant({ read: true as const }), weight: 1 }
);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function normalize(observed: Json): Json {
  const seen = new Map<string, string>();

  return JSON.stringify(observed).replace(UUID, (id) => {
    const known = seen.get(id) ?? `id-${seen.size}`;
    seen.set(id, known);

    return known;
  });
}

const rowsDecoded = Schema.decodeUnknownSync(Schema.Array(StoredRow));

function rowsOf(db: DatabaseSync, table: string): Json[] {
  if (db.prepare("SELECT name FROM sqlite_master WHERE name = ?").all(table).length === 0) return [];

  return [...rowsDecoded(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())];
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const DONE: CallResult = { output: [{ type: "text", text: "done" }] };

type Side = {
  readonly approvals: Pick<Approvals, "handle" | "onChange" | "requestApproval" | "onDecision" | "withdraw" | "recover" | "byRef" | "pending">;
  readonly executor: Pick<ExecutorApprovals, "onPolicies" | "setPolicy" | "policies" | "replied" | "beforeResume" | "resumed"> & ApprovalHandler;
};

type Make = (db: DatabaseSync, deps: ApprovalDeps, executorDeps: ExecutorApprovalDeps) => Side;

const legacy: Make = legacyOf;

const next: Make = (db, deps, executorDeps) => {
  const approvals = new Approvals(storageOf(db), deps);

  return { approvals, executor: new ExecutorApprovals(storageOf(db), approvals, executorDeps) };
};

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

function world(db: DatabaseSync, make: Make) {
  const seen: Seen = { changes: 0, policyChanges: 0, notified: [], told: [], decided: [], lost: [], reopened: [], calls: [] };
  const outcomes = new Map<string, Outcome>();
  let config: "none" | "throw" = "none";

  const deps: ApprovalDeps = {
    present: (session: string) => session === "here",
    home: (session: string) => (session === "side-1" ? "here" : session),
    notify: (chat: string, text: string) => void seen.notified.push([chat, text]),
    defer
  };

  const executorDeps: ExecutorApprovalDeps = {
    config: async () => {
      if (config === "throw") throw new Error("vault locked");

      return null;
    },
    present: deps.present,
    tell: async (session: string, content: string, requestId: string) => void seen.told.push([session, content, requestId])
  };

  const { approvals, executor } = make(db, deps, executorDeps);

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
      },
      lost: async (approval, action) => void seen.lost.push([approval.kind, approval.ref, action, approval.status])
    });
  }

  const idOf = (kind: ApprovalKind, ref: string) => approvals.byRef(kind, ref)?.id ?? "none";

  const apply = async (action: Action): Promise<Json> => {
    if ("ask" in action) return approvals.requestApproval({ kind: action.ask, ref: action.ref, subject: "subject", summary: action.summary, payload: { ref: action.ref }, conversation: action.conversation });

    if ("decide" in action) {
      outcomes.set(action.ref, action.outcome);

      return approvals.onDecision(idOf(action.decide, action.ref), action.action);
    }

    if ("withdraw" in action) return approvals.withdraw(idOf(action.withdraw, action.ref), action.action);

    if ("recover" in action) return approvals.recover() ?? null;

    if ("replied" in action) {
      const text = JSON.stringify({ status: action.replied, requestId: action.requestId, message: "Send the mail", toolPath: action.tool || undefined });
      const said = await executor.replied({ output: [{ type: "text", text }], isError: action.isError }, action.conversation, call);

      return { output: said.output, isError: said.isError ?? null };
    }

    if ("setPolicy" in action) return executor.setPolicy(action.setPolicy, action.policy) ?? null;

    if ("beforeResume" in action) return executor.beforeResume(action.beforeResume, action.action, action.conversation) ?? null;

    if ("resumed" in action) return executor.resumed(action.resumed) ?? null;

    if ("config" in action) {
      config = action.config;

      return null;
    }

    return { pending: approvals.pending(), policies: executor.policies() };
  };

  return { seen, approvals, executor, call, apply };
}

function instance(db: DatabaseSync, make: Make): Instance<Action> {
  const made = world(db, make);

  return {
    apply: async (action) => {
      const result = await made.apply(action);
      await flush();

      return result;
    },
    tables: async () => ({
      schema: db
        .prepare("SELECT type, name, sql FROM sqlite_master WHERE name LIKE 'ky_%' ORDER BY name")
        .all()
        .map(({ type, name, sql }) => ({ type: String(type), name: String(name), sql: String(sql).replace(/\s+/g, " ") })),
      approvals: rowsOf(db, APPROVAL_TABLES.approvals),
      policies: rowsOf(db, APPROVAL_TABLES.policies),
      inputs: rowsOf(db, APPROVAL_TABLES.inputs)
    }),
    effects: async () => made.seen,
    dispose: async () => db.close()
  };
}

function useClock(clock: Clock): void {
  vi.spyOn(Date, "now").mockImplementation(() => clock.now());
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const approvalsParity: Parity<Action> = {
  domain: "approvals",
  actions,
  start: START,
  advances: fc.oneof(fc.integer({ min: 0, max: 90_000 }), fc.constantFrom(CARRY_MS, CARRY_MS + 1)),
  normalize,
  legacy: async (clock) => {
    useClock(clock);

    return instance(new DatabaseSync(":memory:"), legacy);
  },
  next: async () => instance(new DatabaseSync(":memory:"), next)
};

describe("approvals parity", () => {
  it("answers, stores, notifies and tells what B does, step for step", async () => {
    await assertParity(approvalsParity);
  });
});

const Stored = Schema.Struct({ status: Schema.String });

const Count = Schema.Struct({ n: Schema.Number });

function port() {
  let at = START;
  vi.spyOn(Date, "now").mockImplementation(() => at);
  const db = new DatabaseSync(":memory:");
  const made = world(db, next);

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
        await ky.apply({ ask: "webhook-action", ref: "w1", conversation: "here", summary: "Post it" });

        expect(await ky.apply({ decide: "webhook-action", ref: "w1", action: first, outcome })).toEqual({});
        await ky.settle();
        expect(await ky.apply({ decide: "webhook-action", ref: "w1", action: second, outcome: "ok" })).toEqual({ refused: GONE });
        expect(ky.approvals.onDecision(crypto.randomUUID(), first)).toEqual({ refused: GONE });
        await ky.settle();

        expect(ky.seen.decided).toHaveLength(1);
        expect(ky.row("webhook-action", "w1").status).toBe(DECIDED[first]);
        vi.restoreAllMocks();
      })
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
          await ky.apply({ ask: "secret-request", ref: "s1", conversation: "away", summary: "Use the key" });
          await ky.apply({ decide: "secret-request", ref: "s1", action, outcome });
          await ky.settle();
          ky.advance(elapsed);
          ky.approvals.recover();
          await ky.settle();

          const back = outcome === "hang" && elapsed > CARRY_MS;

          expect(ky.row("secret-request", "s1").status).toBe(back ? "pending" : DECIDED[action]);
          expect(ky.seen.lost).toEqual(back ? [["secret-request", "s1", action, "pending"]] : []);
          vi.restoreAllMocks();
        }
      )
    );
  });
});

describe("a tool's policy", () => {
  it("Allow runs it while the user is here and asks when they're away, Ask always asks, Block declines it", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom<ToolPolicy>("allow", "ask", "block"), fc.constantFrom<Conversation>("here", "away"), async (policy, conversation) => {
        using ky = port();
        ky.executor.setPolicy("gmail.send", policy);
        await ky.apply({ replied: "approval-required", requestId: "q1", tool: "gmail.send", conversation, isError: false });

        const resume = (action: string) => [["resume", JSON.stringify({ requestId: "q1", response: { action } })]];
        const asks = policy === "ask" || (policy === "allow" && conversation === "away");

        expect(ky.seen.calls).toEqual(asks ? [] : resume(policy === "block" ? "decline" : "accept"));
        expect(ky.count(APPROVAL_TABLES.approvals)).toBe(asks ? 1 : 0);
        vi.restoreAllMocks();
      })
    );
  });
});

describe("asking", () => {
  it("notifies the user's devices only when they aren't in the chat, and once for an approval asked again", async () => {
    await fc.assert(
      fc.asyncProperty(aConversation, fc.integer({ min: 1, max: 3 }), async (conversation, times) => {
        using ky = port();

        for (let i = 0; i < times; i++) await ky.apply({ ask: "executor", ref: "q1", conversation, summary: "Send it" });

        expect(ky.seen.notified).toEqual(conversation === "here" ? [] : [[conversation === "side-1" ? "here" : conversation, "Waiting for your OK: Send it"]]);
        expect(ky.count(APPROVAL_TABLES.approvals)).toBe(1);
        vi.restoreAllMocks();
      })
    );
  });
});

describe("an input request", () => {
  it("is answered once, from its own conversation", async () => {
    await fc.assert(
      fc.asyncProperty(aConversation, aConversation, async (asked, answering) => {
        using ky = port();
        await ky.apply({ replied: "input-required", requestId: "in1", tool: "", conversation: asked, isError: false });

        expect(ky.executor.beforeResume("in1", "answer", answering) === undefined).toBe(asked === answering);
        ky.executor.resumed("in1");

        expect(ky.executor.beforeResume("in1", "answer", asked)).toMatch(/no input request in1/);
        expect(ky.count(APPROVAL_TABLES.inputs)).toBe(0);
        vi.restoreAllMocks();
      })
    );
  });
});
