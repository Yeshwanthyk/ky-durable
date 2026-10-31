import type { ConversationId } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import fc from "fast-check";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Approvals } from "../../src/approvals/approvals";
import type { ToolPolicy } from "../../src/approvals/contract";
import { ExecutorApprovals } from "../../src/approvals/executor";
import { type Browsers, type BrowserTab, LOGIN_KIND, type LoginVault, type Seat } from "../../src/browse/contract";
import { Browsing } from "../../src/browse/wiring";
import { makeEdge } from "../../src/core/edge";
import { Sql } from "../../src/core/sql";
import type { CallResult, ExecutorCall } from "../../src/executor/contract";
import { OutsideContent } from "../../src/outside/outside";
import { budget } from "../parity/kit";
import { storageOf } from "../parity/skills/storage";

fc.configureGlobal({ baseSize: "large" });

/** Conversations by who is there: the user in their own turn, nobody who is watching, and a routine nobody can answer for. */
const CONVERSATIONS = [1, 2, 3] as const;

type Conversation = (typeof CONVERSATIONS)[number];

const HERE: Conversation = 1;

const ROUTINE: Conversation = 3;

const WORDS = "Words a stranger wrote on a page, as many as a page has. ".repeat(6);

const FREE = "https://free.test/";

const BANK = "https://bank.test/account";

const STEPS = [{ do: "click" as const, selector: "#go" }];

type Op =
  | { readonly t: "read"; readonly c: Conversation }
  | { readonly t: "carry"; readonly from: Conversation; readonly to: Conversation }
  | { readonly t: "pause"; readonly c: Conversation; readonly policy: ToolPolicy }
  | { readonly t: "steps"; readonly c: Conversation }
  | { readonly t: "decide"; readonly accept: boolean };

const aConversation = fc.constantFrom(...CONVERSATIONS);

// SAFETY: a conversation id is a number pi brands; browse reads it only as its session, String(id).
const idOf = (c: Conversation) => c as ConversationId;

const anOp: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ t: fc.constant("read" as const), c: aConversation }),
  fc.record({ t: fc.constant("carry" as const), from: aConversation, to: aConversation }),
  fc.record({ t: fc.constant("pause" as const), c: aConversation, policy: fc.constantFrom<ToolPolicy>("allow", "ask", "block") }),
  fc.record({ t: fc.constant("steps" as const), c: aConversation }),
  fc.record({ t: fc.constant("decide" as const), accept: fc.boolean() })
);

const vault: LoginVault = {
  status: async () => [{ kind: LOGIN_KIND, id: "bank.test", meta: { cookies: 1 }, updatedAt: 0 }],
  put: async () => {},
  remove: async () => {},
  browserLogins: async () => []
};

/** Browser Run with two pages, Kitesurf and Chromium alike: each click a step makes, as "click #go on <url>". */
function browsersOf(acted: string[]): Browsers {
  const tab = (): BrowserTab => {
    let at = "about:blank";

    return {
      goto: async (url) => {
        at = url;

        return null;
      },
      waitForLoadState: async () => {},
      evaluate: async () => ({ title: at, text: WORDS, links: [] }),
      url: () => at,
      locator: (selector) => {
        const act = async () => void acted.push(`click ${selector} on ${at}`);

        return { first: () => ({ click: act, fill: act, press: act }) };
      },
      context: () => ({ newCDPSession: async () => ({ send: async () => ({ data: "" }), detach: async () => {} }) }),
      title: async () => at,
      close: async () => {}
    };
  };

  const unused = () => Promise.reject(new Error("not in this world"));

  const seat: Seat = {
    newTab: async () => tab(),
    lastTab: async () => undefined,
    tab: async () => undefined,
    handoff: unused,
    liveView: unused,
    complete: unused,
    record: unused,
    recorded: unused,
    storageState: async () => ({ cookies: [], origins: [] }),
    restore: async () => {},
    end: async () => {},
    close: async () => {}
  };

  return {
    kitesurf: async () => ({ newPage: async () => tab(), close: async () => {} }),
    acquire: async () => "session-1",
    connect: async () => seat
  };
}

function world() {
  const db = new DatabaseSync(":memory:");
  const deferred: Promise<unknown>[] = [];
  const resumes: string[] = [];
  const acted: string[] = [];
  const browsers = browsersOf(acted);
  const present = (session: string) => session === String(HERE);
  const unattended = (session: string) => session === String(ROUTINE);

  const approvals = new Approvals(storageOf(db), { present, home: () => String(HERE), notify: () => {}, defer: (work) => void deferred.push(work.catch(() => {})), later: () => {} });
  const executor = new ExecutorApprovals(storageOf(db), approvals, { config: async () => null, present, unattended, tell: async () => {} });

  const browsing = new Browsing(storageOf(db), {
    browsers,
    vault: () => vault,
    save: async () => "file-1",
    // SAFETY: a page under 20,000 characters is never spilled to the workspace.
    workspace: {} as ConstructorParameters<typeof Browsing>[1]["workspace"],
    reads: () => false,
    chat: present,
    asker: approvals,
    unattended,
    tell: async () => {},
    draft: () => Effect.die("no demos here"),
    later: () => {}
  });

  approvals.handle("executor", executor);
  approvals.handle("browse-steps", browsing.stepsHandler);
  const outside = makeEdge(OutsideContent.layer.pipe(Layer.provide(Sql.layer(storageOf(db)))));

  const call: ExecutorCall = async (name, args) => {
    resumes.push(`${name} ${JSON.stringify(args)}`);

    return { output: [{ type: "text", text: "done" }] } satisfies CallResult;
  };

  const pause = (c: Conversation, request: string) =>
    executor.replied(
      { output: [{ type: "text", text: JSON.stringify({ status: "approval-required", requestId: request, message: "Send the mail", toolPath: "gmail.send" }) }], isError: false },
      String(c),
      call
    );

  const settle = async () => {
    while (deferred.length > 0) await Promise.all(deferred.splice(0));
  };

  return { approvals, executor, browsing, acted, outside, resumes, pause, settle };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const accepts = (resumes: readonly string[]) => resumes.filter((each) => each.includes('"action":"accept"')).length;

const onBank = (acted: readonly string[]) => acted.filter((each) => each.endsWith(BANK)).length;

type Ky = ReturnType<typeof world>;

/** What the oracle knows: which conversations took outside content in, and how many steps the user approved. */
type Model = { readonly marked: Set<Conversation>; tapped: number; calls: number };

type Step<T extends Op["t"]> = (ky: Ky, model: Model, op: Extract<Op, { t: T }>) => Promise<void>;

const read: Step<"read"> = async (ky, model, op) => {
  await ky.browsing.browse({ url: FREE }, idOf(op.c), `call-${model.calls++}`);
  model.marked.add(op.c);
};

const carry: Step<"carry"> = async (ky, model, op) => {
  ky.outside.run(OutsideContent.use((outside) => outside.carry(String(op.from), String(op.to))));

  if (model.marked.has(op.from)) model.marked.add(op.to);
};

// Allow runs by itself only for the user in their own turn, in a conversation that read nothing from outside.
const pause: Step<"pause"> = async (ky, model, op) => {
  ky.executor.setPolicy("gmail.send", op.policy);
  const before = accepts(ky.resumes);
  await ky.pause(op.c, `request-${model.calls++}`);
  const auto = op.policy === "allow" && op.c === HERE && !model.marked.has(op.c);

  expect(accepts(ky.resumes) - before, `${op.policy} in ${op.c}, marked ${model.marked.has(op.c)}`).toBe(auto ? 1 : 0);
};

// Steps on the signed-in site ask on a card, or are refused at once in a routine; neither runs them.
const steps: Step<"steps"> = async (ky, model, op) => {
  const cards = ky.approvals.cards().length;
  const said = await ky.browsing.browse({ url: BANK, steps: STEPS }, idOf(op.c), `call-${model.calls++}`);

  expect(said).toMatchObject({ isError: op.c === ROUTINE });
  expect(ky.approvals.cards().length).toBe(op.c === ROUTINE ? cards : cards + 1);
};

const decide: Step<"decide"> = async (ky, model, op) => {
  const card = ky.approvals.cards().find((each) => each.kind === "browse-steps") ?? ky.approvals.cards()[0];

  if (card === undefined) return;
  ky.approvals.onDecision(card.id, op.accept ? "accept" : "decline");
  await ky.settle();

  if (op.accept && card.kind === "browse-steps") model.tapped++;
};

function run(ky: Ky, model: Model, op: Op): Promise<void> {
  if (op.t === "read") return read(ky, model, op);

  if (op.t === "carry") return carry(ky, model, op);

  if (op.t === "pause") return pause(ky, model, op);

  return op.t === "steps" ? steps(ky, model, op) : decide(ky, model, op);
}

describe("R7: a write after outside content never runs unapproved", () => {
  it("I-O1: a conversation that read a page with no saved login, or took another's marks, never auto-runs an Executor write; steps on a signed-in site run only on the user's tap", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(anOp, { maxLength: budget().maxCommands }), async (ops) => {
        const ky = world();
        const model: Model = { marked: new Set(), tapped: 0, calls: 0 };

        for (const op of ops) {
          await run(ky, model, op);
          expect(onBank(ky.acted)).toBe(model.tapped);
        }

        for (const c of CONVERSATIONS) expect(ky.outside.run(OutsideContent.use((outside) => outside.marked(String(c)))).length > 0, `conversation ${c}`).toBe(model.marked.has(c));
      }),
      { numRuns: budget().numRuns * 2, seed: budget().seed }
    );
  });
});
