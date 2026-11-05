import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Extension, GenerationHooks, HookApi, ToolExecutionApi } from "@earendil-works/pi-durable";
import * as Schema from "effect/Schema";
import fc from "fast-check";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ChatList } from "../../src/chats/chats";
import { chatsExtension } from "../../src/chats/tool";
import { isOwnRequest } from "../../src/history/contract";
import { budget } from "../parity/kit";
import { storageOf } from "../parity/skills/storage";

/**
 * Chats that message each other, run against the real chats tool and its onYield hook with a harness that queues,
 * places and dedupes inputs as pi-durable does. The operations are the actions of
 * .claude/skills/verify-formal-chats/Chats.tla, and the assertions are its invariants, judged by an oracle that
 * reads only what the chats did (each send, its notify, what was placed), never the tool's request ids or wait rows.
 */

const ROOT = "1";

const READING = "2";

const KID = "3";

const WRITERS = [ROOT, READING] as const;

/** The longest chain the model allows: a user's message, a send, the answer back, a send to a chat that one opened. */
const MAX_HOPS = 3;

/** `chat` picks among the chats the operation can act on now (a chat with a queue to place, one running, ...). */
type Op =
  | { readonly op: "write"; readonly chat: number }
  | { readonly op: "place"; readonly chat: number }
  | { readonly op: "send"; readonly chat: number; readonly to: number; readonly action: "steer" | "create"; readonly notify: boolean; readonly byTitle: boolean }
  | { readonly op: "yield"; readonly chat: number; readonly crash: boolean }
  | { readonly op: "rehook"; readonly chat: number }
  | { readonly op: "answer"; readonly chat: number };

type Input = { readonly request: string; readonly hops: number };

type Sent = { readonly from: string; readonly to: string; readonly request: string; readonly hops: number };

const ToolReply = Schema.Struct({ output: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })), isError: Schema.optional(Schema.Boolean) });

const UUIDS = Array.from({ length: 64 }, (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);

function answerOf(text: string): AssistantMessage {
  // SAFETY: the hook reads only the answer's text parts (textOf).
  return { role: "assistant", content: [{ type: "text", text }] } as AssistantMessage;
}

/** One ky: the real chat list and chats extension, over a harness that keeps each chat's queue and placed inputs. */
class World {
  readonly db = new DatabaseSync(":memory:");
  readonly chats = new ChatList(storageOf(this.db));
  readonly queue = new Map<string, Input[]>();
  readonly placed = new Map<string, Set<string>>();
  readonly submitted = new Map<string, Set<string>>();
  readonly newest = new Map<string, Input>();
  readonly running = new Set<string>();
  readonly answering = new Set<string>();
  /** The chat whose tool call or hook is submitting now, and which it is. */
  acting: { readonly by: string; readonly hook: boolean } | undefined;
  readonly sends: Sent[] = [];
  readonly notices: Sent[] = [];
  readonly harms: string[] = [];
  readonly extension: Extension;
  /** The hook crashes after its next notice is submitted, before the wait row goes: the harness reruns it. */
  #crash = false;
  #users = 0;
  #task = 100;
  #next = 20;

  constructor() {
    this.chats.add(READING);
    this.chats.rename(READING, "Reading");
    this.chats.add(KID, { by: ROOT, request: "chat-create:1:0" });
    this.chats.rename(KID, "Trip plans");
    this.extension = chatsExtension({
      chats: {
        list: () => this.chats.list(),
        touch: (session, text) => this.chats.touch(session, text),
        rename: (session, title) => this.chats.rename(session, title),
        archive: (session, archived) => this.chats.archive(session, archived),
        wait: (request, target, sender) => this.chats.wait(request, target, sender),
        waitsFor: (target) => this.chats.waitsFor(target),
        settle: (request) => {
          if (this.#crash) throw new Error("crashed before the commit");
          this.chats.settle(request);
        }
      },
      openedFor: (request) => this.chats.openedFor(request),
      openedBy: (session) => this.chats.openedBy(session),
      open: async (opener) => {
        const session = String(this.#next++);
        this.chats.add(session, opener);

        return session;
      },
      steer: async (session, _content, requestId) => this.submit(session, requestId),
      busy: async (session) => this.running.has(session),
      latest: () => "said",
      chat: (session) => session === ROOT || this.chats.has(session),
      userStarted: (session) => isOwnRequest(this.newest.get(session)?.request),
      taken: (session, request) => this.placed.get(session)?.has(request) === true
    });
  }

  sessions(): readonly string[] {
    return [ROOT, ...this.chats.list().map((row) => row.session)];
  }

  hopsOf(session: string): number {
    return this.newest.get(session)?.hops ?? 0;
  }

  /** pi-durable submit: a repeated request id keeps the first; anything else queues behind the chat's turn. */
  submit(session: string, request: string): void {
    const seen = this.submitted.get(session) ?? new Set<string>();

    if (seen.has(request)) return;
    seen.add(request);
    this.submitted.set(session, seen);
    const acting = this.acting;
    let hops = 0;

    if (acting && !acting.hook) {
      hops = this.hopsOf(acting.by) + 1;
      this.sends.push({ from: acting.by, to: session, request, hops });
    } else if (acting) {
      hops = this.notice(acting.by, session);
    }

    if (hops > MAX_HOPS) this.harms.push(`BoundedChain: a message ${hops} hops from the user's reached chat ${session}`);
    this.queue.set(session, [...(this.queue.get(session) ?? []), { request, hops }]);
  }

  /** The hook of `target` told `sender`: judge it against the sends `sender` asked to be told about. */
  notice(target: string, sender: string): number {
    const asked = this.sends.filter((send) => send.from === sender && send.to === target && this.notified.has(send.request));
    const taken = asked.filter((send) => this.placed.get(target)?.has(send.request));
    const told = this.notices.filter((each) => each.from === target && each.to === sender).length + 1;

    if (told > asked.length) this.harms.push(`NoticeOnce: ${sender} told ${told} times about ${asked.length} sends to ${target}`);

    if (told > taken.length) this.harms.push(`NoticeAfterAnswer: ${sender} told before ${target} took in what it sent`);
    const hops = Math.max(0, ...asked.map((send) => send.hops)) + 1;
    this.notices.push({ from: target, to: sender, request: "", hops });

    return hops;
  }

  /** The sends whose tool call asked for notify and went out. */
  readonly notified = new Set<string>();

  /** The chats `op` can act on now; its `chat` picks one, so generated runs keep moving. */
  able(op: Op["op"]): readonly string[] {
    const turning = (session: string) => this.running.has(session) && !this.answering.has(session);

    switch (op) {
      case "write":
        return WRITERS;
      case "place":
        return this.sessions().filter((session) => (this.queue.get(session) ?? []).length > 0 && !this.answering.has(session));
      case "send":
      case "yield":
        return this.sessions().filter(turning);
      case "rehook":
      case "answer":
        return [...this.answering];
    }
  }

  async run(op: Op): Promise<void> {
    const able = this.able(op.op);
    const chat = able[op.chat % Math.max(able.length, 1)];

    if (chat === undefined) return;
    const queued = this.queue.get(chat) ?? [];

    switch (op.op) {
      case "write":
        this.submit(chat, UUIDS[this.#users++ % UUIDS.length] ?? "");

        return;
      case "place":
        this.placed.set(chat, new Set([...(this.placed.get(chat) ?? []), ...queued.map((input) => input.request)]));
        this.newest.set(chat, queued.at(-1) ?? { request: "", hops: 0 });
        this.queue.set(chat, []);
        this.running.add(chat);

        return;
      case "send":
        return this.send(chat, op);
      case "yield":
        this.answering.add(chat);

        return op.crash ? this.crashed(chat) : this.hook(chat);
      case "rehook":
        return this.hook(chat);
      case "answer":
        this.answering.delete(chat);
        this.running.delete(chat);
    }
  }

  /** The hook crashes after a notice is submitted, before its wait row goes; a rehook is the harness's rerun. */
  async crashed(chat: string): Promise<void> {
    this.#crash = true;

    try {
      await this.hook(chat);
    } catch {
      // The run died here; the harness reruns the hook on its next rehook.
    } finally {
      this.#crash = false;
      this.acting = undefined;
    }
  }

  async send(from: string, op: Extract<Op, { op: "send" }>): Promise<void> {
    const sessions = this.sessions();
    const to = sessions[op.to % sessions.length] ?? ROOT;
    const title = to === ROOT ? "main" : this.chats.list().find((row) => row.session === to)?.title;
    const chat = op.byTitle && title ? title : to;
    const tool = this.extension.tools?.[0];

    if (!tool) throw new Error("the chats extension has no tool");
    // SAFETY: the chats tool reads the calling conversation and the call's task, nothing else of the api.
    const api = { conversationId: Number(from), taskId: this.#task++, callId: "call-1" } as ToolExecutionApi;
    const before = this.sends.length;
    this.acting = { by: from, hook: false };
    const said = Schema.decodeUnknownSync(ToolReply)(await tool.execute({ action: op.action, chat, message: "Look into it", notify: op.notify }, api, BACKGROUND_CONTEXT));
    this.acting = undefined;
    const sent = this.sends.slice(before);

    if (said.isError === true && sent.length > 0) this.harms.push(`a refused call still sent: ${JSON.stringify(said.output)}`);

    if (op.notify && said.isError !== true) for (const each of sent) this.notified.add(each.request);
  }

  async hook(target: string): Promise<void> {
    // SAFETY: the chats extension registers one hook, on GenerationTask (src/chats/tool.ts).
    const handlers = this.extension.hooks?.[0]?.handlers as GenerationHooks | undefined;

    if (!handlers?.onYield) throw new Error("the chats extension has no onYield hook");
    this.acting = { by: target, hook: true };
    // SAFETY: the hook reads only the conversation it runs in.
    await handlers.onYield(answerOf("Here is what I found."), { conversationId: Number(target) } as HookApi, BACKGROUND_CONTEXT);
    this.acting = undefined;
  }

  [Symbol.dispose](): void {
    this.db.close();
  }
}

const aChat = fc.nat(5);

const anOp: fc.Arbitrary<Op> = fc.oneof(
  { weight: 2, arbitrary: fc.record({ op: fc.constant("write" as const), chat: aChat }) },
  { weight: 4, arbitrary: fc.record({ op: fc.constant("place" as const), chat: aChat }) },
  {
    weight: 5,
    arbitrary: fc.record({
      op: fc.constant("send" as const),
      chat: aChat,
      to: fc.nat(6),
      action: fc.constantFrom("steer" as const, "steer" as const, "create" as const),
      notify: fc.boolean(),
      byTitle: fc.boolean()
    })
  },
  { weight: 3, arbitrary: fc.record({ op: fc.constant("yield" as const), chat: aChat, crash: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("rehook" as const), chat: aChat }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constant("answer" as const), chat: aChat }) }
);

describe("chats that message each other", () => {
  it("never keep waking each other, and tell an asking chat once, after the other chat took the message in", async () => {
    const reached = { notices: 0, longest: 0 };

    await fc.assert(
      fc.asyncProperty(fc.array(anOp, { minLength: budget().maxCommands, maxLength: budget().maxCommands * 3 }), async (ops) => {
        using world = new World();

        for (const op of ops) {
          await world.run(op);

          expect(world.harms).toEqual([]);
        }

        reached.notices += world.notices.length;
        reached.longest = Math.max(reached.longest, ...world.sends.map((send) => send.hops), ...world.notices.map((notice) => notice.hops));
      }),
      { numRuns: Math.max(budget().numRuns * 5, 2_500), seed: budget().seed }
    );

    // The runs reach what the invariants guard: answers coming back, and the longest chain the gates allow.
    expect(reached.notices).toBeGreaterThan(0);
    expect(reached.longest).toBe(MAX_HOPS);
  });

  it("reaches the stories on the chart: an asked chat answers, and the answer comes back to the chat that asked", async () => {
    using world = new World();

    const steps: Op[] = [
      { op: "write", chat: 0 },
      { op: "place", chat: 0 },
      { op: "send", chat: 0, to: 1, action: "steer", notify: true, byTitle: true },
      { op: "yield", chat: 0, crash: false },
      { op: "answer", chat: 0 },
      { op: "place", chat: 0 },
      { op: "yield", chat: 0, crash: true },
      { op: "rehook", chat: 0 },
      { op: "answer", chat: 0 }
    ];

    for (const step of steps) await world.run(step);

    expect(world.harms).toEqual([]);
    expect(world.sends.map((send) => [send.from, send.to, send.hops])).toEqual([[ROOT, READING, 1]]);
    expect(world.notices.map((notice) => [notice.from, notice.to, notice.hops])).toEqual([[READING, ROOT, 2]]);
    expect(world.queue.get(ROOT)).toHaveLength(1);
    expect(world.chats.waitsFor(READING)).toEqual([]);
  });
});
