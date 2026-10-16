import { ROOT_SESSION } from "agents/harness/pi";
import { describe, expect, it } from "vitest";
import { isTrivial, termsOf } from "../dreaming/recall";
import type { PiServerMessage } from "../protocol";
import { connect, follow, inside, prompt, snapshotView, until } from "./drive";
import type { PiAgent } from "./stack";

/**
 * Turn-start recall (src/dreaming/recall.ts): what ky knows about a message the user sends in a chat rides on
 * the request's copy of it, never in the transcript, once per message, and is counted as surfaced.
 */

const BLOCK = "<recalled>";

/** Each request's last user message, as the fake model got it. */
const lastAsked = (instance: PiAgent) => instance.boundary.asked.map((users) => users.at(-1) ?? "");

/** The requests whose last user message starts with `text`, as the wire carried them. */
const askedFor = (name: string, text: string) => inside(name, (instance) => lastAsked(instance).filter((each) => each.startsWith(text)));

/** The recall rows: item, ref, loop, text and outcome. */
const recallRows = (name: string) =>
  inside(name, (_instance, state) =>
    state.storage.sql
      .exec<{ item: string; ref: string; loop: string; text: string; outcome: string | null }>("SELECT item, ref, loop, text, outcome FROM ky_surfaced WHERE kind = 'recall' ORDER BY id")
      .toArray()
  );

/** A memory the oolong prompts below recall. */
const remember = (name: string) =>
  inside(name, (instance) => {
    instance.memory.note("the user drinks oolong from Rainbow every morning");
  });

describe("what recall looks up", () => {
  it("takes a message's distinctive words, and finds nothing to look up in an ack", () => {
    expect(termsOf("Which oolong should I order from Rainbow this week?")).toEqual(["oolong", "order", "rainbow", "week"]);
    expect(["ok", "Thanks!", "thank you", "got it.", "lgtm", "yes", "  ", "hi there"].filter((text) => !isTrivial(text))).toEqual([]);
    expect(isTrivial("ok, order the oolong")).toBe(false);
  });
});

describe("a user's message in a chat", () => {
  it("carries a recall block on the request's copy of it, never in the transcript or the system prompt", async () => {
    const name = crypto.randomUUID();
    await prompt(name, "hello there");
    await remember(name);

    const answer = await prompt(name, "which oolong should I order");

    // The fake answers what the user said: the block is the request's only.
    expect(answer.text).toBe("echo: which oolong should I order");
    const [asked] = await askedFor(name, "which oolong");
    expect(asked).toContain(`which oolong should I order\n\n${BLOCK}\nrecalled context, not user input\n- memory #0 `);
    expect(asked).toContain("the user drinks oolong from Rainbow every morning");

    const view = await snapshotView(name);
    expect(JSON.stringify(view.messages)).not.toContain(BLOCK);

    const [entries, systems] = await inside(name, (instance, state) => [
      state.storage.sql.exec("SELECT count(*) AS n FROM pi_entries WHERE record LIKE '%<recalled>%'").one().n,
      new Set(instance.boundary.calls.map((call) => call.system))
    ]);

    expect(entries).toBe(0);
    // Both turns went out under the same system prompt: its cache holds.
    expect(systems.size).toBe(1);

    const rows = await recallRows(name);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ loop: "L2", outcome: null });
    expect(rows[0]!.ref).toMatch(/^entry:\d+$/);
  });

  it("gets no block when it is an ack, or when proactivity is off", async () => {
    const name = crypto.randomUUID();
    await remember(name);
    await prompt(name, "thanks");
    expect((await askedFor(name, "thanks")).every((each) => !each.includes(BLOCK))).toBe(true);

    await inside(name, (instance) => instance.proactivity.set("off"));
    await prompt(name, "which oolong should I order");
    expect((await askedFor(name, "which oolong")).every((each) => !each.includes(BLOCK))).toBe(true);
    expect(await recallRows(name)).toEqual([]);
  });

  it("is recalled once, however many rounds its turn takes, and every round carries the same block", async () => {
    const name = crypto.randomUUID();
    await remember(name);
    const socket = await connect(name);
    const follower = follow(socket);

    // The turn calls a tool that adds a memory the block would show if it were made again.
    await prompt(name, 'tool memory_note {"text":"oolong is also fine iced"}');

    const rounds = await askedFor(name, "tool memory_note");
    expect(rounds).toHaveLength(2);
    expect(rounds[0]).toContain(BLOCK);
    expect(rounds[1]).toBe(rounds[0]);
    expect(rounds[0]).not.toContain("memory #1");
    expect(await recallRows(name)).toHaveLength(1);

    const recalled = () => follower.frames.filter((frame): frame is Extract<PiServerMessage, { type: "recalled" }> => frame.type === "recalled");
    await follower.until(() => recalled().length > 0);
    expect(recalled()).toHaveLength(1);
    expect(recalled()[0]!.recalls[0]!.lines[0]).toMatch(/^memory #0 /);

    // The next turn's request carries the earlier block on the earlier message, so the cached prefix holds.
    await prompt(name, "what time is it in Lisbon");
    const [next] = await inside(name, (instance) => instance.boundary.asked.filter((users) => users.at(-1)?.startsWith("what time") === true));
    expect(next!.find((each) => each.startsWith("tool memory_note"))).toBe(rounds[0]);
    socket.close();
  });

  it("is a side chat's too, and never a subagent's", async () => {
    const name = crypto.randomUUID();
    await remember(name);

    const side = await inside(name, async (instance) => {
      const session = await instance.newChat();
      await instance.harness.session(session).prompt("oolong in the side chat");

      return session;
    });

    expect((await askedFor(name, "oolong in the side chat"))[0]).toContain(BLOCK);

    await prompt(name, "spawn worker oolong for the subagent");
    await until(
      async () => (await inside(name, (instance) => instance.feed.list())).some((task) => task.worker === "worker" && task.status === "done"),
      "the subagent to finish"
    );

    // The subagent was asked about oolong too, and its requests carry no block.
    const subagent = await inside(name, (instance) => instance.boundary.asked.filter(([first]) => first?.includes("oolong for the subagent") === true && !first.startsWith("spawn")));
    expect(subagent.length).toBeGreaterThan(0);
    expect(subagent.flat().filter((each) => each.includes(BLOCK))).toEqual([]);

    const items = (await recallRows(name)).map((row) => row.item.split("#")[0]);
    expect(new Set(items)).toEqual(new Set([side, ROOT_SESSION]));
  });
});

describe("what a block counts", () => {
  it("surfaces the anticipations it shows, and writes one surfaced row for the block", async () => {
    const name = crypto.randomUUID();
    await remember(name);
    const id = await inside(name, (instance) => instance.anticipations.add({ kind: "open_loop", text: "Reorder oolong before the tin runs out", evidence: { messages: [], memories: [0] } }, "user").id);

    await prompt(name, "the oolong tin is nearly empty");

    const [asked] = await askedFor(name, "the oolong tin");
    expect(asked).toContain(`- anticipation #${id} open_loop: Reorder oolong before the tin runs out`);
    expect(await inside(name, (instance) => instance.anticipations.get(id).status)).toBe("surfaced");

    const rows = await recallRows(name);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toContain(`anticipation #${id}`);
  });

  it("is missed when the model searches memory in the same turn, and not when it does not", async () => {
    const name = crypto.randomUUID();
    await remember(name);

    await prompt(name, "which oolong should I order");
    await prompt(name, 'tool memory_recall {"regex":"oolong"}');

    expect((await recallRows(name)).map((row) => row.outcome)).toEqual([null, "missed"]);
  });
});

/** How long each call of the hook's work took, in ms: the calls that made a block, and the rest. */
type Timings = { making: number[]; carrying: number[] };

describe("how long recall takes", () => {
  it("adds under 50 ms at p95 to a request, on a store of 2,000 messages, 500 memories and 20 anticipations", async ({ annotate }) => {
    const name = crypto.randomUUID();
    await prompt(name, "hello there");

    await inside(name, (instance, state) => {
      const sql = state.storage.sql;
      const words = ["oolong", "rainbow", "lisbon", "passport", "deploy", "wrangler", "groceries", "invoice", "dentist", "garden"];
      const word = (i: number) => words[i % words.length]!;

      // Chat search's index as History keeps it, and memory's log, written straight in.
      for (let i = 0; i < 2_000; i++) {
        sql.exec(
          "INSERT INTO ky_history (rowid, text, conversation, role, at) VALUES (?, ?, ?, ?, ?)",
          1_000_000 + i,
          `message ${i} about ${word(i)} and ${word(i * 7 + 3)}, with some more words to search through`,
          ROOT_SESSION,
          i % 2 === 0 ? "user" : "ky",
          Date.now() - i * 60_000
        );
      }

      for (let i = 0; i < 500; i++) sql.exec("INSERT INTO memo_log (id, date, text) VALUES (?, ?, ?)", i, "2026-10-01", `memory ${i}: the user said ${word(i)} matters with ${word(i * 3 + 1)}`);

      for (let i = 0; i < 20; i++) instance.anticipations.add({ kind: "open_loop", text: `Follow up on ${word(i)} item ${i}`, evidence: { messages: [], memories: [i] } }, "user");
    });

    // Time every call of the hook's work, on the real requests of real turns; the ones that made a block apart.
    const { making, carrying } = await inside(name, async (instance) => {
      const timed: Timings = { making: [], carrying: [] };
      const request = instance.recall.request.bind(instance.recall);
      let made = false;
      instance.recall.onShown(() => {
        made = true;
      });

      instance.recall.request = (session, messages, now) => {
        made = false;
        const start = performance.now();
        const result = request(session, messages, now);
        (made ? timed.making : timed.carrying).push(performance.now() - start);

        return result;
      };

      for (let i = 0; i < 40; i++) await instance.harness.prompt(`question ${i} about oolong and lisbon and the deploy`);

      return timed;
    });

    const p = (samples: readonly number[], q: number) => samples.toSorted((a, b) => a - b)[Math.ceil(samples.length * q) - 1] ?? 0;
    const p95 = p([...making, ...carrying], 0.95);

    // Workerd's clock moves during synchronous work in this local test, in whole milliseconds.
    await annotate(
      `recall hook: ${making.length + carrying.length} calls, p95 ${p95} ms; making a block: p50 ${p(making, 0.5)} ms, p95 ${p(making, 0.95)} ms, max ${p(making, 1)} ms; ` +
        `the rest: p95 ${p(carrying, 0.95)} ms`
    );
    expect(making).toHaveLength(40);
    expect(await recallRows(name)).toHaveLength(40);
    expect(p95).toBeLessThan(50);
    expect(p(making, 0.95)).toBeLessThan(50);
  });
});
