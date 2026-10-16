import type { JsonValue } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { Draft } from "../dreaming/anticipations";
import { nextMidnight } from "../dreaming/local-day";
import type { PiClientMessage, PiServerMessage } from "../protocol";
import { connect, follow, inside, prompt } from "./drive";
import type { PiAgent } from "./stack";

/**
 * The morning brief (src/dreaming/brief.ts) and what ky surfaced (src/dreaming/surfaced.ts) on ky's real PiAgent:
 * the dream writes lines through the anticipate tool's brief action, a browser's first hello of the day gets the
 * card, its taps become outcomes, unhandled lines expire at midnight, and the counts come back to the dream.
 */

const tool = (name: string, args: Record<string, JsonValue>) => `tool ${name} ${JSON.stringify(args)}`;

const DAY = 86_400_000;

/** A ky with one chat message to cite: the message's id. */
async function seeded(name: string): Promise<number> {
  await prompt(name, "I'll reply to Sam about the Lisbon dates by Friday");

  return inside(name, (_instance, state) =>
    Number(state.storage.sql.exec("SELECT max(id) AS id FROM pi_entries WHERE json_extract(record, '$.kind') = 'pi.user'").one().id)
  );
}

const loop = (message: number, text = "Reply to Sam about the Lisbon dates"): Draft => ({ kind: "open_loop", text, evidence: { messages: [message], memories: [] } });

/** A dream's conversation, as the dream makes one; its prompts' tool calls are the dream's. */
async function dreamSession(name: string): Promise<(text: string) => Promise<string>> {
  const session = await inside(name, async (instance) => {
    const { id } = await instance.harness.sessions.create();
    instance.reviews.add(id, "", "dream");

    return id;
  });

  return (text) => inside(name, async (instance) => (await instance.harness.session(session).prompt(text)).text ?? "");
}

/** What `work` throws, or "ok". */
const refusal = (work: () => void) => {
  try {
    work();

    return "ok";
  } catch (error) {
    return String(error);
  }
};

/** A browser that said hello: its frames, and a way to send a message and wait for its result. */
async function browser(name: string) {
  const socket = await connect(name);
  const client = follow(socket);
  await client.until(() => client.frames.some((frame) => frame.type === "events"));

  const send = async (message: PiClientMessage): Promise<PiServerMessage | undefined> => {
    const id = crypto.randomUUID();
    socket.send(JSON.stringify({ ...message, id }));
    await client.until(() => client.frames.some((frame) => (frame.type === "result" || frame.type === "error") && frame.id === id));

    return client.frames.find((frame) => (frame.type === "result" || frame.type === "error") && frame.id === id);
  };

  return { frames: client.frames, send, close: () => socket.close() };
}

const briefs = (frames: readonly PiServerMessage[]) => frames.flatMap((frame) => (frame.type === "brief" ? [frame.brief] : []));

const outcomes = (_instance: PiAgent, state: DurableObjectState) =>
  state.storage.sql
    .exec<{ item: string; outcome: string | null }>("SELECT item, outcome FROM ky_surfaced ORDER BY id")
    .toArray()
    .map((row) => [row.item, row.outcome]);

describe("the dream writing the brief", () => {
  it("puts a line in today's brief from an open anticipation, which becomes surfaced; the user may not", async () => {
    const name = crypto.randomUUID();
    const message = await seeded(name);
    const id = await inside(name, (instance) => instance.anticipations.add(loop(message), "dream").id);

    expect((await prompt(name, tool("anticipate", { action: "brief", id, text: "Reply to Sam today" }))).text).toContain("Only the dream writes the brief.");

    const dream = await dreamSession(name);
    expect(await dream(tool("anticipate", { action: "brief", id, text: "Reply to Sam about Lisbon today", chip: "Draft my reply to Sam" }))).toMatch(
      new RegExp(`In the brief as \\d{4}-\\d{2}-\\d{2}#0; #${id} is surfaced\\.`)
    );
    expect(await inside(name, (instance) => instance.anticipations.get(id).status)).toBe("surfaced");
    // The same anticipation twice is one line.
    expect(await dream(tool("anticipate", { action: "brief", id, text: "Again" }))).toContain(`already has a line from anticipation:${id}`);
    expect(await dream(tool("anticipate", { action: "brief", text: "Invented" }))).toContain("No evidence");
    expect(await dream(tool("anticipate", { action: "brief", messages: [message], text: "two\nlines" }))).toContain("one line of text");

    const shown = await inside(name, (instance) => instance.brief.show());
    expect(shown?.lines.map((line) => [line.text, line.chip, line.pinned])).toEqual([["Reply to Sam about Lisbon today", "Draft my reply to Sam", false]]);
    expect(shown?.lines[0]?.key).toMatch(/#0$/);
  });

  it("is refused a closed anticipation, a fourth line, and anything while proactivity is off", async () => {
    const name = crypto.randomUUID();
    const message = await seeded(name);
    const ids = await inside(name, (instance) => [1, 2, 3, 4, 5].map((n) => instance.anticipations.add(loop(message, `Loop ${n}`), "dream").id));
    await inside(name, (instance) => instance.anticipations.close(ids[4]!, "done", "dream"));

    const dream = await dreamSession(name);
    expect(await dream(tool("anticipate", { action: "brief", id: ids[4]!, text: "Closed" }))).toContain("the brief shows only an open one");

    for (const id of ids.slice(0, 3)) expect(await dream(tool("anticipate", { action: "brief", id, text: `Line ${id}` }))).toContain("In the brief as");
    expect(await dream(tool("anticipate", { action: "brief", id: ids[3]!, text: "Fourth" }))).toContain("holds 3 dream lines and is full");
    expect(await inside(name, (instance) => instance.anticipations.get(ids[3]!).status)).toBe("open");

    const off = crypto.randomUUID();
    const offMessage = await seeded(off);
    await inside(off, (instance) => instance.proactivity.set("off"));
    const offDream = await dreamSession(off);
    expect(await offDream(tool("anticipate", { action: "brief", messages: [offMessage], text: "Anything" }))).toContain("Proactivity is off");
  });
});

describe("the card", () => {
  it("comes with the first hello of the day only; a pinned line comes again", async () => {
    const name = crypto.randomUUID();
    await inside(name, (instance) => {
      instance.brief.append({ text: "Dentist at 3", chip: "Move my 3pm" }, { loop: "event", ref: "test:a" });
      instance.brief.append({ text: "Rent is due" }, { loop: "event", ref: "test:b" });
    });

    const first = await browser(name);
    const card = briefs(first.frames);
    expect(card).toHaveLength(1);
    expect(card[0]!.lines.map((line) => [line.text, line.chip, line.pinned])).toEqual([
      ["Dentist at 3", "Move my 3pm", false],
      ["Rent is due", null, false]
    ]);
    const [dentist, rent] = card[0]!.lines.map((line) => line.key);
    expect(await first.send({ type: "brief-pin", key: dentist! })).toMatchObject({ type: "result" });
    first.close();

    const second = await browser(name);
    expect(briefs(second.frames).map((brief) => brief.lines.map((line) => [line.key, line.pinned]))).toEqual([[[dentist, true]]]);
    expect(await inside(name, outcomes)).toEqual([
      [dentist, "pinned"],
      [rent, null]
    ]);
    second.close();
  });

  it("records act, pin and dismiss, pins and closes their anticipations, and dismiss-all leaves anticipations be", async () => {
    const name = crypto.randomUUID();
    const message = await seeded(name);
    const [a, b, c] = await inside(name, (instance) => ["One", "Two", "Three"].map((text) => instance.anticipations.add(loop(message, text), "dream").id));
    const keys = await inside(name, (instance) => [a, b, c].map((id) => instance.brief.append({ text: `Line ${id}`, chip: "Go" }, { loop: "dream", ref: `anticipation:${id}` })));

    const page = await browser(name);
    expect(briefs(page.frames)[0]!.lines).toHaveLength(3);
    await page.send({ type: "brief-act", key: keys[0]! });
    await page.send({ type: "brief-pin", key: keys[1]! });
    await page.send({ type: "brief-dismiss", key: keys[2]! });
    // Acted is final; a pinned one may still be dismissed.
    const error = (frame: PiServerMessage | undefined) => (frame?.type === "error" ? frame.message : "no error");
    expect(error(await page.send({ type: "brief-dismiss", key: keys[0]! }))).toContain("is acted already");
    expect(error(await page.send({ type: "brief-dismiss", key: "1999-01-01#0" }))).toContain("No line");

    const rows = await inside(name, (instance) => [a, b, c].map((id) => instance.anticipations.get(id!)));
    expect(rows.map((row) => [row.status, row.pinned])).toEqual([
      ["open", false],
      ["open", true],
      ["dismissed", false]
    ]);

    await page.send({ type: "brief-dismiss" });
    expect(await inside(name, outcomes)).toEqual([
      [keys[0], "acted"],
      [keys[1], "dismissed"],
      [keys[2], "dismissed"]
    ]);
    expect(await inside(name, (instance) => instance.anticipations.get(b!).status)).toBe("open");
    page.close();
  });

  it("is not sent while proactivity is off, which the settings page sets with its rates", async () => {
    const name = crypto.randomUUID();
    await inside(name, (instance) => instance.brief.append({ text: "Rent is due" }, { loop: "event", ref: "test:a" }));

    const page = await browser(name);
    expect(briefs(page.frames)).toHaveLength(1);
    const key = briefs(page.frames)[0]!.lines[0]!.key;
    await page.send({ type: "brief-dismiss", key });

    expect(await page.send({ type: "proactivity" })).toMatchObject({
      type: "result",
      result: { level: "brief", accepted: { count: 0, of: 1 }, dismissed: { count: 1, of: 1 }, expired: { count: 0, of: 0 } }
    });
    expect(await page.send({ type: "set-proactivity", level: "off" })).toMatchObject({ type: "result", result: { level: "off" } });
    page.close();

    await inside(name, (_instance, state) => state.storage.sql.exec("DELETE FROM ky_surfaced"));
    const after = await browser(name);
    expect(briefs(after.frames)).toEqual([]);
    expect(await inside(name, (instance) => refusal(() => instance.brief.append({ text: "More" }, { loop: "event", ref: "test:b" })))).toContain("Proactivity is off");
    after.close();
  });
});

describe("midnight", () => {
  it("expires what is unhandled at the brief's midnight, and the next day starts empty", async () => {
    const name = crypto.randomUUID();
    const now = Date.now();

    const result = await inside(name, (instance, state) => {
      const midnight = nextMidnight(null, now);
      const [handled, unhandled] = ["Handled", "Unhandled"].map((text, index) => instance.brief.append({ text }, { loop: "event", ref: `test:${index}` }, now));
      const card = instance.brief.show(now);
      instance.brief.dismiss(handled!, now);
      const before = instance.surfaced.outcomeOf("brief", unhandled!);
      const next = instance.brief.show(midnight);
      const late = refusal(() => instance.brief.pin(unhandled!, midnight + 1));
      const row = state.storage.sql.exec("SELECT outcome, outcome_at FROM ky_surfaced WHERE item = ?", unhandled!).one();

      return { midnight, expires: card?.expires_at, before, next, late, row, week: instance.surfaced.lastWeek("brief", midnight) };
    });

    expect(result.expires).toBe(result.midnight);
    expect(result.before).toBeNull();
    expect(result.next).toBeUndefined();
    expect(result.late).toContain("No line");
    expect(result.row).toEqual({ outcome: "expired", outcome_at: result.midnight });
    expect(result.week).toMatchObject({ shown: 2, dismissed: 1, expired: 1, open: 0 });
  });
});

describe("the brief's cap", () => {
  /** Four lines shown `daysAgo`, `accepted` of them pinned, the rest left to expire. */
  const week = (instance: PiAgent, now: number, daysAgo: number, accepted: number) => {
    for (let n = 0; n < 4; n++) {
      const at = now - daysAgo * DAY + n;
      const item = `cap-${daysAgo}#${n}`;
      instance.surfaced.shown({ kind: "brief", loop: "dream", ref: `test:${item}`, item, text: item, expiresAt: at + 3_600_000 }, at);

      if (n < accepted) instance.surfaced.outcome("brief", item, "pinned", at + 1);
    }
  };

  it("is 3, and 2 only after two weeks in a row with fewer than a quarter of the lines used", async () => {
    const now = Date.now();

    const caps = await Promise.all(
      [
        [],
        [[3, 0]],
        [
          [3, 0],
          [10, 1]
        ],
        [
          [3, 0],
          [10, 0]
        ],
        [
          [3, 0],
          [17, 0]
        ]
      ].map((weeks) =>
        inside(crypto.randomUUID(), (instance) => {
          for (const [daysAgo, accepted] of weeks) week(instance, now, daysAgo!, accepted!);

          return instance.surfaced.briefCap(now);
        })
      )
    );

    // None shown; one weak week; a quarter used the week before; two weak weeks; a gap between them.
    expect(caps).toEqual([3, 3, 3, 2, 3]);
  });

  it("holds the dream to two lines after two weak weeks", async () => {
    const name = crypto.randomUUID();
    const message = await seeded(name);
    const now = Date.now();

    const ids = await inside(name, (instance) => {
      week(instance, now, 3, 0);
      week(instance, now, 10, 0);

      return [1, 2, 3].map((n) => instance.anticipations.add(loop(message, `Loop ${n}`), "dream").id);
    });

    const dream = await dreamSession(name);

    for (const id of ids.slice(0, 2)) expect(await dream(tool("anticipate", { action: "brief", id, text: `Line ${id}` }))).toContain("In the brief as");
    expect(await dream(tool("anticipate", { action: "brief", id: ids[2]!, text: "Third" }))).toContain("holds 2 dream lines and is full");
  });
});

describe("the dream reading what it surfaced", () => {
  it("lists last week's counts and dismissed lines and what is due, and asks for the brief; none of it while off", async () => {
    const name = crypto.randomUUID();
    const message = await seeded(name);

    const digest = await inside(name, (instance) => {
      const upcoming = instance.anticipations.add(
        { kind: "upcoming", text: "Dentist this afternoon", evidence: { messages: [message], memories: [] }, window: { from: Date.now(), to: Date.now() + 3_600_000 } },
        "dream"
      );

      const [kept, dropped] = ["Rent is due", "Stretch more"].map((text, index) => instance.brief.append({ text }, { loop: "event", ref: `test:${index}` }));
      instance.brief.show();
      instance.brief.act(kept!);
      instance.brief.dismiss(dropped!);

      return { text: instance.dreaming.digest({ memories: 0, at: 0 }), upcoming: upcoming.id };
    });

    expect(digest.text).toMatch(new RegExp(`Due in the day ahead:\\n- #${digest.upcoming} upcoming[^\\n]*Dentist this afternoon`));
    expect(digest.text).toContain("What you surfaced last week:\n- 2 brief lines shown: 1 acted, 0 pinned, 1 dismissed, 0 expired, 0 open\n- dismissed: Stretch more");

    await inside(name, async (instance) => {
      instance.presence.seen(Date.now() - 3 * 3_600_000);
      await instance.dreaming.run();
    });

    const asked = await inside(name, (_instance, state) =>
      state.storage.sql
        .exec<{ text: string }>("SELECT json_extract(record, '$.model[0].content') AS text FROM pi_entries WHERE json_extract(record, '$.kind') = 'pi.user'")
        .toArray()
        .map((row) => String(row.text))
        .find((text) => text.startsWith("[dream]"))
    );

    expect(asked).toMatch(/\n\d\. The user's day: [^\n]*anticipate brief it[^\n]*At most 3 lines; prefer the due ones and those with evidence; none is fine/);

    const quiet = await inside(name, (instance) => {
      instance.proactivity.set("off");

      return instance.dreaming.digest({ memories: 0, at: 0 }) ?? "";
    });

    expect(quiet).not.toContain("Due in the day ahead");
    expect(quiet).not.toContain("What you surfaced last week");
  });
});
