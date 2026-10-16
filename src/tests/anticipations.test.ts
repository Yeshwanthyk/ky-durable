import type { JsonValue } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { Draft } from "../dreaming/anticipations";
import type { Anticipation } from "../dreaming/contract";
import { REVIEW_ALLOWED } from "../skills/contract";
import { inside, prompt } from "./drive";

/**
 * Anticipations (src/dreaming/anticipations.ts) on ky's real PiAgent: what is still open, each row citing the
 * chat messages or memories it rests on. The store is driven as its callers drive it: the dream and the main chat
 * through the `anticipate` tool, recall and the brief through `match` and `due`.
 */

const tool = (name: string, args: Record<string, JsonValue>) => `tool ${name} ${JSON.stringify(args)}`;

const HOUR = 3_600_000;

/** The user's newest chat message, as a message id a row can cite. */
const newestAsk = (name: string) =>
  inside(name, (_instance, state) =>
    Number(state.storage.sql.exec("SELECT max(id) AS id FROM pi_entries WHERE json_extract(record, '$.kind') = 'pi.user'").one().id)
  );

/** A ky with one chat message and one memory to cite: the message's id. */
async function seeded(name: string): Promise<number> {
  await prompt(name, "I'll reply to Sam about the Lisbon dates by Friday");
  await inside(name, (instance) => instance.memory.note("the user is planning a Lisbon trip with Sam"));

  return newestAsk(name);
}

const loop = (message: number, more: Partial<Draft> = {}): Draft => ({
  kind: "open_loop",
  text: "Reply to Sam about the Lisbon dates",
  evidence: { messages: [message], memories: [] },
  ...more
});

/** Mark a row surfaced, as turn-start recall and the brief will when they show one; nothing does yet. */
const surfaced = (state: DurableObjectState, id: number) => state.storage.sql.exec("UPDATE ky_anticipations SET status = 'surfaced' WHERE id = ?", id);

/** A dream's conversation, as the dream makes one; its prompts' tool calls are the dream's. */
async function dreamSession(name: string): Promise<(text: string) => Promise<string>> {
  const session = await inside(name, async (instance) => {
    const { id } = await instance.harness.sessions.create();
    instance.reviews.add(id, "", "dream");

    return id;
  });

  return (text) => inside(name, async (instance) => (await instance.harness.session(session).prompt(text)).text ?? "");
}

describe("adding an anticipation", () => {
  it("is refused without evidence, or citing a message or memory that is not there", async () => {
    const name = crypto.randomUUID();
    const message = await seeded(name);

    const refusals = await inside(name, (instance) =>
      [
        { messages: [], memories: [] },
        { messages: [message + 1000], memories: [] },
        { messages: [], memories: [7] },
        { messages: [message], memories: [7] }
      ].map((evidence) => {
        try {
          instance.anticipations.add(loop(message, { evidence }), "dream");

          return "added";
        } catch (error) {
          return String(error);
        }
      })
    );

    expect(refusals[0]).toContain("No evidence");
    expect(refusals[1]).toContain(`No such message #${message + 1000}`);
    expect(refusals[2]).toContain("No such memory #7");
    // One good id does not carry a bad one.
    expect(refusals[3]).toContain("No such memory #7");
    expect(await inside(name, (instance) => instance.anticipations.open())).toEqual([]);

    const row = await inside(name, (instance) => instance.anticipations.add(loop(message, { evidence: { messages: [message], memories: [0] } }), "dream"));
    expect(row).toMatchObject({ created_by: "dream", status: "open", pinned: false, evidence: { messages: [message], memories: [0] } });
  });

  it("holds 5 a dream run, and 20 open for a machine, while the user's own always fit", async () => {
    const name = crypto.randomUUID();
    const message = await seeded(name);

    const [sixth, tomorrow, full, users] = await inside(name, (instance) => {
      const store = instance.anticipations;
      const now = Date.now();

      for (let i = 0; i < 5; i++) store.add(loop(message, { text: `loop ${i}` }), "dream", now);

      const sixth = (() => {
        try {
          store.add(loop(message, { text: "loop 5" }), "dream", now);
        } catch (error) {
          return String(error);
        }
      })();

      // The next night's run starts its own five.
      store.add(loop(message, { text: "tomorrow's" }), "dream", now + 13 * HOUR);

      for (let i = 0; i < 14; i++) store.add(loop(message, { text: `episode ${i}` }), "episode", now);

      const full = (() => {
        try {
          store.add(loop(message, { text: "one more" }), "episode", now);
        } catch (error) {
          return String(error);
        }
      })();

      return [sixth, store.open().length, full, store.add(loop(message, { text: "remind me" }), "user", now).created_by];
    });

    expect(sixth).toContain("at most 5");
    expect(tomorrow).toBe(20);
    expect(full).toContain("20 are open already");
    expect(users).toBe("user");
  });

  it("is refused over 280 bytes of text, 1,500 characters of prepared context, or an upcoming one with no window", async () => {
    const name = crypto.randomUUID();
    const message = await seeded(name);

    const errors = await inside(name, (instance) =>
      [loop(message, { text: "x".repeat(281) }), loop(message, { prepared: "y".repeat(1_501) }), loop(message, { kind: "upcoming" })].map((draft) => {
        try {
          instance.anticipations.add(draft, "user");
        } catch (error) {
          return String(error);
        }
      })
    );

    expect(errors[0]).toContain("Too long: 281 bytes");
    expect(errors[1]).toContain("prepared is 1501 characters");
    expect(errors[2]).toContain("needs a window");
  });
});

describe("an anticipation's status", () => {
  it("moves only forward: a closed one never reopens, and an expired one is never done", async () => {
    const name = crypto.randomUUID();
    const message = await seeded(name);

    const errors = await inside(name, (instance) => {
      const store = instance.anticipations;
      const done = store.add(loop(message), "user");
      store.close(done.id, "dismissed", "user");
      const stale = store.add(loop(message, { window: { from: 0, to: 1 } }), "user");
      store.expire();

      return [
        () => store.close(done.id, "done", "user"),
        () => store.close(done.id, "dismissed", "user"),
        () => store.close(stale.id, "done", "user"),
        () => store.extend(done.id, { from: 0, to: Date.now() + HOUR }, "user")
      ].map((attempt) => {
        try {
          attempt();
        } catch (error) {
          return String(error);
        }
      });
    });

    expect(errors[0]).toMatch(/is dismissed; it cannot become done/);
    expect(errors[1]).toMatch(/is dismissed; it cannot become dismissed/);
    expect(errors[2]).toMatch(/is expired; it cannot become done/);
    expect(errors[3]).toMatch(/is dismissed; only an open one moves/);
  });

  it("expires open rows whose window passed, but not surfaced, pinned or future ones", async () => {
    const name = crypto.randomUUID();
    const message = await seeded(name);

    const [count, statuses] = await inside(name, (instance, state) => {
      const store = instance.anticipations;
      const now = Date.now();
      const past = { from: now - 3 * HOUR, to: now - HOUR };
      const stale = store.add(loop(message, { text: "stale" }), "dream", now);
      const seen = store.add(loop(message, { text: "seen", window: past }), "dream", now);
      const kept = store.add(loop(message, { text: "kept", window: past }), "dream", now);
      const ahead = store.add(loop(message, { text: "ahead", window: { from: now, to: now + HOUR } }), "dream", now);
      store.extend(stale.id, past, "dream");
      surfaced(state, seen.id);
      store.pin(kept.id);

      const count = store.expire(now);

      return [count, [stale, seen, kept, ahead].map((row) => store.get(row.id).status)];
    });

    expect(count).toBe(1);
    expect(statuses).toEqual(["expired", "surfaced", "open", "open"]);
  });

  it("writes one memory with the outcome when a loop closes as done, and none when dismissed", async () => {
    const name = crypto.randomUUID();
    const message = await seeded(name);

    const [before, after, recalled, row] = await inside(name, (instance) => {
      const store = instance.anticipations;
      const before = instance.memory.count();
      const done = store.add(loop(message), "dream");
      const dropped = store.add(loop(message, { text: "Book the Lisbon flat" }), "dream");
      store.close(done.id, "done", "dream", "replied to Sam: Lisbon 12-19 May");
      store.close(dropped.id, "dismissed", "dream");

      return [before, instance.memory.count(), instance.memory.recall("Lisbon 12-19"), store.get(done.id)];
    });

    expect(after - before).toBe(1);
    expect(recalled).toMatch(/replied to Sam: Lisbon 12-19 May\n1 match\./);
    expect(row.status).toBe("done");
    expect(row.closed_at).toBeGreaterThan(0);
  });
});

describe("what reads anticipations", () => {
  it("recall matches by a word of the text or the prepared context, and by a window around now", async () => {
    const name = crypto.randomUUID();
    const message = await seeded(name);

    const ids = (rows: Anticipation[]) => rows.map((row) => row.text);

    const [sam, wrangler, now, none, short] = await inside(name, (instance) => {
      const store = instance.anticipations;
      const at = Date.now();
      store.add(loop(message), "dream");
      store.add(loop(message, { kind: "predicted_ask", text: "The deploy will fail again", prepared: "Fixed last time by regenerating WRANGLER types" }), "dream");
      store.add(loop(message, { kind: "upcoming", text: "Dentist at 15:00", window: { from: at - HOUR, to: at + HOUR } }), "dream");
      const gone = store.add(loop(message, { text: "Sam's birthday present" }), "dream");
      store.close(gone.id, "dismissed", "dream");

      return [store.match(["sam"], at + 2 * HOUR), store.match(["wrangler", "100%"], at + 2 * HOUR), store.match([], at), store.match(["nothing"], at + 2 * HOUR), store.match(["to"], at + 2 * HOUR)];
    });

    expect(ids(sam)).toEqual(["Reply to Sam about the Lisbon dates"]);
    expect(ids(wrangler)).toEqual(["The deploy will fail again"]);
    expect(ids(now)).toEqual(["Dentist at 15:00"]);
    expect(none).toEqual([]);
    // Two letters is no word to match by.
    expect(short).toEqual([]);
  });

  it("the brief's due lists the upcoming dates of the day ahead, soonest first", async () => {
    const name = crypto.randomUUID();
    const message = await seeded(name);

    const due = await inside(name, (instance) => {
      const store = instance.anticipations;
      const now = Date.now();
      store.add(loop(message, { kind: "upcoming", text: "Dentist at 15:00", window: { from: now + 7 * HOUR, to: now + 11 * HOUR } }), "dream");
      store.add(loop(message, { kind: "upcoming", text: "Standup", window: { from: now + HOUR, to: now + 2 * HOUR } }), "dream");
      store.add(loop(message, { kind: "upcoming", text: "Next week's flight", window: { from: now + 7 * 24 * HOUR, to: now + 7 * 24 * HOUR + HOUR } }), "dream");
      store.add(loop(message, { kind: "open_loop", text: "Undated loop in window", window: { from: now, to: now + HOUR } }), "dream");

      return store.due(now).map((row) => row.text);
    });

    expect(due).toEqual(["Standup", "Dentist at 15:00"]);
  });
});

describe("the anticipate tool", () => {
  it("is the dream's: it adds with evidence, closes its own, and is refused on the user's or a pinned row", async () => {
    const name = crypto.randomUUID();
    const message = await seeded(name);
    expect(REVIEW_ALLOWED.dream).toContain("anticipate");

    const [mine, users, pinned] = await inside(name, (instance) => [
      instance.anticipations.add(loop(message, { text: "the dream's" }), "dream").id,
      instance.anticipations.add(loop(message, { text: "the user's" }), "user").id,
      instance.anticipations.add(loop(message, { text: "pinned" }), "dream").id
    ]);

    await inside(name, (instance) => instance.anticipations.pin(pinned));

    const dream = await dreamSession(name);
    expect(await dream(tool("anticipate", { action: "add", kind: "open_loop", text: "Invented loop" }))).toContain("No evidence");
    expect(await dream(tool("anticipate", { action: "add", kind: "open_loop", text: "Answer Sam", messages: [message] }))).toMatch(/Saved as #\d+\./);
    expect(await dream(tool("anticipate", { action: "close", id: users, outcome: "dismissed" }))).toContain(`#${users} is the user's`);
    expect(await dream(tool("anticipate", { action: "extend", id: pinned, to: "2030-01-01T00:00:00Z" }))).toContain(`#${pinned} is pinned`);
    expect(await dream(tool("anticipate", { action: "absorb", id: pinned, into: mine }))).toContain(`#${pinned} is pinned`);
    expect(await dream(tool("anticipate", { action: "absorb", id: mine, into: users }))).toContain(`#${mine} is folded into #${users}`);

    const rows = await inside(name, (instance) => [instance.anticipations.get(mine), instance.anticipations.get(users), instance.anticipations.get(pinned)]);
    expect(rows.map((row) => row.status)).toEqual(["dismissed", "open", "open"]);
    expect(rows[0]).toMatchObject({ absorbed_into: users });
    expect(rows[2]!.window_to).toBeNull();
    expect((await inside(name, (instance) => instance.anticipations.open())).find((row) => row.text === "Answer Sam")).toMatchObject({ created_by: "dream" });
  });

  it("is the user's from the main chat: it cites their message, and that's done becomes a memory", async () => {
    const name = crypto.randomUUID();
    const said = await prompt(name, tool("anticipate", { action: "add", kind: "open_loop", text: "Call the plumber" }));
    expect(said.text).toMatch(/tool said: Saved as #1\./);
    const ask = await newestAsk(name);

    expect(await inside(name, (instance) => instance.anticipations.get(1))).toMatchObject({ created_by: "user", evidence: { messages: [ask], memories: [] } });
    expect((await prompt(name, tool("anticipate", { action: "list" }))).text).toMatch(/#1 open_loop, open, today, by user: Call the plumber \(rests on message #\d+\)/);
    expect((await prompt(name, tool("anticipate", { action: "close", id: 1, outcome: "done", note: "the plumber fixed the sink on Monday" }))).text).toContain(
      "#1 is done; its outcome is a memory now"
    );
    expect(await inside(name, (instance) => instance.memory.recall("plumber"))).toMatch(/the plumber fixed the sink on Monday/);
  });

  it("lets the user pin one, which the dream may not, and lists by words or by the hours ahead", async () => {
    const name = crypto.randomUUID();
    const soon = new Date(Date.now() + 2 * HOUR).toISOString();
    const later = new Date(Date.now() + 3 * HOUR).toISOString();
    expect((await prompt(name, tool("anticipate", { action: "add", kind: "upcoming", text: "Dentist this afternoon", from: soon, to: later }))).text).toContain("Saved as #1.");
    expect((await prompt(name, tool("anticipate", { action: "add", kind: "open_loop", text: "Answer Sam about Lisbon" }))).text).toContain("Saved as #2.");

    expect((await prompt(name, tool("anticipate", { action: "pin", id: 2 }))).text).toContain("#2 is pinned");
    expect(await inside(name, (instance) => instance.anticipations.get(2).pinned)).toBe(true);
    const dream = await dreamSession(name);
    expect(await dream(tool("anticipate", { action: "unpin", id: 2 }))).toContain("Only the user pins.");

    const list = async (args: Record<string, JsonValue>) => (await prompt(name, tool("anticipate", { action: "list", ...args }))).text ?? "";
    expect(await list({ about: "what about lisbon?" })).toMatch(/^tool said: - #2 open_loop[^\n]*Answer Sam about Lisbon[^\n]*$/);
    expect(await list({ hours: 4 })).toMatch(/^tool said: - #1 upcoming[^\n]*Dentist this afternoon[^\n]*$/);
    expect(await list({ hours: 1 })).toBe("tool said: None open.");
  });
});

describe("the dream and anticipations", () => {
  it("shows the open ones in its digest with their age and status, and expires stale ones before it reads", async () => {
    const name = crypto.randomUUID();
    const message = await seeded(name);

    await inside(name, (instance, state) => {
      const store = instance.anticipations;
      const old = store.add(loop(message, { text: "Old loop" }), "dream", Date.now() - 3 * 24 * HOUR);
      surfaced(state, old.id);
      store.add(loop(message, { text: "Stale date", kind: "upcoming", window: { from: 0, to: 1 } }), "user");
      store.add(loop(message, { text: "Pinned one" }), "user");
      store.pin(3);
    });

    const digest = await inside(name, (instance) => instance.dreaming.digest({ memories: 0, at: 0 }));
    expect(digest).toMatch(/Open anticipations, oldest first:\n- #1 open_loop, surfaced, 3 days old, by dream: Old loop \(rests on message #\d+\)/);
    expect(digest).toContain("- #3 open_loop, open, today, by user, pinned: Pinned one");

    await inside(name, async (instance) => {
      instance.presence.seen(Date.now() - 3 * HOUR);
      await instance.dreaming.run();
    });

    expect(await inside(name, (instance) => instance.anticipations.get(2).status)).toBe("expired");

    const asked = await inside(name, (_instance, state) =>
      state.storage.sql
        .exec<{ text: string }>("SELECT json_extract(record, '$.model[0].content') AS text FROM pi_entries WHERE json_extract(record, '$.kind') = 'pi.user'")
        .toArray()
        .map((row) => String(row.text))
        .find((text) => text.startsWith("[dream]"))
    );

    expect(asked).toMatch(/You may call only [^\n]*anticipate/);
    expect(asked).toContain("7. A commitment the user made, a date ahead, or a question they are likely to ask next: anticipate add it");
    expect(asked).toContain("at most 5 new anticipations");
    expect(asked).not.toContain("Stale date");
  });
});
