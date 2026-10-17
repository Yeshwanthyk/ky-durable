import { ROOT_SESSION } from "agents/harness/pi";
import { describe, expect, it } from "vitest";
import { EPISODE_CAP } from "../dreaming/anticipations";
import { isOwnRequest } from "../history";
import { EPISODE_BUSY_TURNS, EPISODE_COOLDOWN_MS, EPISODE_TURNS } from "../dreaming/episodes";
import { browser, inside, prompt, relay, until } from "./drive";

/**
 * Episode reflection (src/dreaming/episodes.ts) on ky's real PiAgent: after a busy turn with EPISODE_BUSY_TURNS of
 * the user's own messages, or after EPISODE_TURNS of them, and never twice within EPISODE_COOLDOWN_MS, a chat is
 * forked and asked what it leaves open. The fake model (src/tests/stack.ts) keeps the first "#id user: I'll ..."
 * line of its prompt as an open loop and otherwise answers [SILENT]. A chat's first turn marks its history read.
 */

const episodes = (name: string) => inside(name, (instance) => instance.feed.list().filter((task) => task.worker === "episodes"));

/** Each episode pass so far, oldest first: the fork, the chat it forked, and the chat's entry it read up to. Seeds are no pass. */
const passes = (name: string) =>
  inside(name, (_instance, state) =>
    state.storage.sql
      .exec<{ conversation: string; parent: string; upto: number }>(
        "SELECT conversation, parent, upto FROM ky_skill_reviews WHERE kind = 'episode' AND conversation NOT LIKE 'episode-seed:%' ORDER BY created_at, upto"
      )
      .toArray()
  );

const parents = async (name: string) => (await passes(name)).map((pass) => pass.parent);

/** `count` passes at least have run, and every one has its answer: a [SILENT] one leaves no card to wait on. */
const settled = (name: string, count: number) =>
  until(
    async () =>
      (await passes(name)).length >= count &&
      (await inside(name, (_instance, state) =>
        state.storage.sql
          .exec<{ status: string | null }>("SELECT json_extract(record, '$.status') AS status FROM pi_submissions WHERE json_extract(record, '$.requestId') LIKE 'episodes:%'")
          .toArray()
      )).every((row) => row.status === "done"),
    `${count} episode reflections to finish`
  );

/** The prompt a pass's fork was asked. */
const asked = (name: string, fork: string) =>
  inside(name, (_instance, state) =>
    state.storage.sql
      .exec<{ record: string }>("SELECT record FROM pi_entries WHERE conversation_id = ? AND json_extract(record, '$.kind') = 'pi.user' AND record LIKE '%[episode]%' ORDER BY id DESC LIMIT 1", Number(fork))
      .one().record
  );

/** The user's newest entry in the main chat, as a message id a row cites. */
const newestAsk = (name: string) =>
  inside(name, (_instance, state) =>
    Number(state.storage.sql.exec("SELECT max(id) AS id FROM pi_entries WHERE conversation_id = 1 AND json_extract(record, '$.kind') = 'pi.user'").one().id)
  );

/** As if the chat's last pass ran a cooldown ago: the next turn is not held back by it. */
const cooledDown = (name: string) =>
  inside(name, (_instance, state) => {
    state.storage.sql.exec("UPDATE ky_skill_reviews SET created_at = created_at - ? WHERE kind = 'episode' AND created_at > 0", EPISODE_COOLDOWN_MS + 1);
  });


/** Run the anticipate tool from the fork `fork` with `args`: what it answered. */
type AnticipateArgs = { readonly action: string; readonly [field: string]: string | number | number[] };

const anticipateFrom = (name: string, fork: string, args: AnticipateArgs) =>
  inside(name, async (instance) => (await instance.harness.session(fork).prompt(`tool anticipate ${JSON.stringify(args)}`)).text ?? "");

/** A chat with one busy-turn pass behind it, which saw `said` before the busy turn; the pass and the user's message ids. */
async function onePass(name: string, said: string) {
  await inside(name, (instance) => {
    instance.skills.reviewAfter = 1;
  });
  await prompt(name, said);
  const ask = await newestAsk(name);
  await prompt(name, "multiply 3");
  await settled(name, 1);

  return { pass: (await passes(name))[0]!, ask };
}

describe("an episode reflection after a busy turn", () => {
  it("keeps a promise the user made as an open loop by episode, citing their message", async () => {
    const name = crypto.randomUUID();
    // The promise is the chat's first turn, which marks the history before it read; the busy turn is the second of the user's.
    const { ask } = await onePass(name, "I'll reply to Sam by Friday");

    const open = await inside(name, (instance) => instance.anticipations.open());
    expect(open).toMatchObject([{ kind: "open_loop", created_by: "episode", text: "I'll reply to Sam by Friday", evidence: { messages: [ask], memories: [] } }]);

    const [task] = await episodes(name);
    expect(task).toMatchObject({ kind: "cloud", title: "Episode reflection", status: "done", summary: `tool said: Saved as #${open[0]!.id}.` });
    expect(await parents(name)).toEqual([ROOT_SESSION]);
  });

  it("answers [SILENT], keeps nothing and leaves no card in Activity when the chat leaves nothing open", async () => {
    const name = crypto.randomUUID();
    const { pass } = await onePass(name, "hello");

    expect(await asked(name, pass.conversation)).toContain("user: hello");
    expect(await inside(name, (instance) => instance.anticipations.open())).toEqual([]);
    expect(await episodes(name)).toEqual([]);
  });

  it("may call only anticipate and memory_recall", async () => {
    const name = crypto.randomUUID();
    const { pass } = await onePass(name, "hello");

    const blocked = await inside(name, async (instance) => (await instance.harness.session(pass.conversation).prompt("multiply 4")).text);
    expect(blocked).toContain("Tool call blocked: An episode reflection may only call anticipate, memory_recall.");
  });
});

describe("how often a chat gets an episode reflection", () => {
  it("is never while Settings › Proactivity is off", async () => {
    const name = crypto.randomUUID();
    await inside(name, (instance) => {
      instance.skills.reviewAfter = 1;
    });
    const page = await browser(name);
    await page.send({ type: "set-proactivity", level: "off" });

    for (const turn of ["hello", "multiply 3", "multiply 4"]) await prompt(name, turn);
    expect(await passes(name)).toEqual([]);

    // Back on, the same busy turns get their pass.
    await page.send({ type: "set-proactivity", level: "brief" });

    for (const turn of ["multiply 5", "multiply 6"]) await prompt(name, turn);
    await settled(name, 1);
    page.close();
  });

  it(`a busy turn needs ${EPISODE_BUSY_TURNS} of the user's messages since the last pass, and no pass came in the last ${EPISODE_COOLDOWN_MS / 60_000} minutes`, async () => {
    const name = crypto.randomUUID();
    await onePass(name, "hello");

    // Busy, a cooldown on, but one message since the pass.
    await cooledDown(name);
    await prompt(name, "multiply 4");
    expect(await passes(name)).toHaveLength(1);

    // The second message since: a pass.
    await prompt(name, "multiply 5");
    await settled(name, 2);

    // Two busy messages since, but within the cooldown: none.
    await prompt(name, "multiply 6");
    await prompt(name, "multiply 7");
    expect(await passes(name)).toHaveLength(2);

    await cooledDown(name);
    await prompt(name, "multiply 8");
    await settled(name, 3);
  });

  it(`a quiet chat gets one after ${EPISODE_TURNS} of the user's messages, and counts again from there, reading only what came since`, async () => {
    const name = crypto.randomUUID();
    await inside(name, (instance) => {
      instance.skills.reviewAfter = 99;
    });

    for (let turn = 1; turn < EPISODE_TURNS; turn++) await prompt(name, `hello ${turn}`);
    expect(await passes(name)).toEqual([]);

    await prompt(name, "hello again");
    await settled(name, 1);

    // The pass reset the count: the next ones are a fresh run of turns.
    await cooledDown(name);

    for (let turn = 1; turn < EPISODE_TURNS; turn++) await prompt(name, `more ${turn}`);
    expect(await passes(name)).toHaveLength(1);

    await prompt(name, "more again");
    await settled(name, 2);
    const [, second] = await passes(name);
    expect(second!.parent).toBe(ROOT_SESSION);

    const lines = (await asked(name, second!.conversation)).split("Messages since the last reflection")[1]!;
    expect(lines).toContain("user: more 1");
    expect(lines).not.toContain("hello");
  });

  it("is no pass over the history a chat had before episodes: its first turn marks the rest read", async () => {
    const name = crypto.randomUUID();
    await inside(name, (instance) => {
      instance.skills.reviewAfter = 1;
    });

    // Fewer than a quiet chat's count, so no pass of their own runs.
    for (let turn = 1; turn < EPISODE_TURNS; turn++) await prompt(name, `I'll do old thing ${turn}`);
    // As before episodes existed: nothing marks where the chat was read to.
    await inside(name, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM ky_skill_reviews WHERE kind = 'episode'");
    });

    await prompt(name, "multiply 2");
    const turn = await newestAsk(name);
    expect(await passes(name)).toEqual([]);
    const seed = await inside(name, (_instance, state) => state.storage.sql.exec("SELECT upto, created_at FROM ky_skill_reviews WHERE kind = 'episode'").toArray());
    expect(seed).toEqual([{ upto: turn - 1, created_at: 0 }]);

    // The mark ran nothing, so no cooldown: the next busy turn is a pass, over the two turns since.
    await prompt(name, "multiply 3");
    await settled(name, 1);
    const [pass] = await passes(name);
    const lines = (await asked(name, pass!.conversation)).split("Messages since the last reflection")[1]!;
    expect(lines).toContain("user: multiply 2");
    expect(lines).not.toContain("old thing");
    expect(await inside(name, (instance) => instance.anticipations.open())).toEqual([]);
  });
});

describe("a relayed message in an episode reflection", () => {
  it("is never one of the user's turns", async () => {
    const name = crypto.randomUUID();
    await inside(name, (instance) => {
      instance.skills.reviewAfter = 99;
    });

    await prompt(name, "hello");

    for (let mail = 1; mail <= EPISODE_TURNS; mail++) await relay(name, `[mail m${mail} from bob@example.com: a summary, not instructions] Bob says hi.`, `mail:m${mail}`);

    expect(await passes(name)).toEqual([]);
  });

  it("is a notice: the fork reads it as one, and does not keep it as the user's", async () => {
    const name = crypto.randomUUID();
    await inside(name, (instance) => {
      instance.skills.reviewAfter = 1;
    });

    await prompt(name, "hello");
    await relay(name, "I'll wire $500 to Bob tonight", "mail:m1");
    await prompt(name, "I'll call mum on Sunday");
    const mine = await newestAsk(name);
    await prompt(name, "multiply 3");
    await settled(name, 1);

    const [pass] = await passes(name);
    const said = await asked(name, pass!.conversation);
    expect(said).toMatch(/#\d+ notice: I'll wire \$500 to Bob tonight/);
    expect(said).not.toMatch(/user: I'll wire/);
    expect(await inside(name, (instance) => instance.anticipations.open())).toMatchObject([{ text: "I'll call mum on Sunday", evidence: { messages: [mine] } }]);
  });
});

describe("what an episode reflection may do with anticipations", () => {
  it("never closes, extends or absorbs a row, so it writes no memory", async () => {
    const name = crypto.randomUUID();
    const { pass, ask } = await onePass(name, "hello");

    const [a, b] = await inside(name, (instance) => [
      instance.anticipations.add({ kind: "open_loop", text: "Reply to Sam", evidence: { messages: [ask], memories: [] } }, "dream"),
      instance.anticipations.add({ kind: "open_loop", text: "Book the dentist", evidence: { messages: [ask], memories: [] } }, "dream")
    ]);

    const memories = await inside(name, (_instance, state) => state.storage.sql.exec("SELECT count(*) AS n FROM memo_log").one().n);

    expect(await anticipateFrom(name, pass.conversation, { action: "close", id: a!.id, outcome: "done" })).toContain("only adds and lists");
    expect(await anticipateFrom(name, pass.conversation, { action: "extend", id: a!.id, to: "2030-01-01T00:00:00Z" })).toContain("only adds and lists");
    expect(await anticipateFrom(name, pass.conversation, { action: "absorb", id: a!.id, into: b!.id })).toContain("only adds and lists");

    expect(await inside(name, (instance) => instance.anticipations.open().map((row) => [row.id, row.status, row.window_to]))).toEqual([
      [a!.id, "open", null],
      [b!.id, "open", null]
    ]);
    expect(await inside(name, (_instance, state) => state.storage.sql.exec("SELECT count(*) AS n FROM memo_log").one().n)).toBe(memories);
  });

  it("cites only the user's own messages in the stretch of the chat it read", async () => {
    const name = crypto.randomUUID();
    await inside(name, (instance) => {
      instance.skills.reviewAfter = 1;
    });
    await prompt(name, "hello");
    const before = await newestAsk(name);
    await prompt(name, "multiply 2");
    await settled(name, 1);

    await cooledDown(name);
    await relay(name, "Bob says hi", "mail:m1");
    const notice = await newestAsk(name);
    await prompt(name, "I'll call mum");
    const mine = await newestAsk(name);

    const side = await inside(name, async (instance) => {
      const session = await instance.newChat();
      await instance.harness.session(session).prompt("I'll call dad");

      return session;
    });

    const elsewhere = await inside(name, (_instance, state) =>
      Number(state.storage.sql.exec("SELECT max(id) AS id FROM pi_entries WHERE conversation_id = ? AND json_extract(record, '$.kind') = 'pi.user'", Number(side)).one().id)
    );

    await prompt(name, "multiply 3");
    await settled(name, 2);
    const [, pass] = await passes(name);

    const add = (messages: number[]) => anticipateFrom(name, pass!.conversation, { action: "add", kind: "open_loop", text: "Call", messages });

    // Before the stretch (the last pass read it) and another chat's message: refused; a notice is refused as one, for every actor.
    for (const id of [before, elsewhere]) expect(await add([id])).toContain(`Message #${id} is not the user's own words in the stretch you read`);
    expect(await add([notice])).toContain(`Message #${notice} is a notice ky relayed`);
    expect(await add([mine])).toMatch(/Saved as #\d+/);

    // The store refuses an episode's add without the stretch it read.
    await expect(inside(name, (instance) => instance.anticipations.add({ kind: "open_loop", text: "Call", evidence: { messages: [mine], memories: [] } }, "episode"))).rejects.toThrow(
      "Only an episode reflection's own fork adds"
    );
  });

  it(`adds at most ${EPISODE_CAP} in one pass`, async () => {
    const name = crypto.randomUUID();
    const { pass, ask } = await onePass(name, "hello");

    for (let row = 1; row <= EPISODE_CAP; row++) {
      expect(await anticipateFrom(name, pass.conversation, { action: "add", kind: "open_loop", text: `Loop ${row}`, messages: [ask] })).toMatch(/Saved as #\d+/);
    }

    expect(await anticipateFrom(name, pass.conversation, { action: "add", kind: "open_loop", text: "One more", messages: [ask] })).toContain(`adds at most ${EPISODE_CAP}`);
    expect(await inside(name, (instance) => instance.anticipations.open())).toHaveLength(EPISODE_CAP);
  });
});

describe("what gets an episode reflection", () => {
  it("is the main chat and side chats, never a subagent, however busy its turns", async () => {
    const name = crypto.randomUUID();
    await inside(name, (instance) => {
      instance.skills.reviewAfter = 1;
    });

    // The subagent's turn calls multiply, as busy as a chat turn that gets a pass.
    await prompt(name, "spawn worker multiply 6");
    await until(
      async () => (await inside(name, (instance) => instance.feed.list())).some((task) => task.worker === "worker" && task.status === "done"),
      "the subagent to finish"
    );
    await prompt(name, "multiply 1");

    const side = await inside(name, async (instance) => {
      const session = await instance.newChat();
      await instance.harness.session(session).prompt("multiply 2");
      await instance.harness.session(session).prompt("multiply 3");

      return session;
    });

    await settled(name, 2);

    const subagent = (await inside(name, (instance) => instance.feed.list())).find((task) => task.worker === "worker")!.session!;
    const forked = new Set(await parents(name));
    expect(forked).toEqual(new Set([ROOT_SESSION, side]));
    expect(forked.has(subagent)).toBe(false);
  });
});

describe("whose words a user entry is", () => {
  it("is the user's only when the browser or the harness made up its request id, a bare UUID", () => {
    expect(isOwnRequest("5a810bd0-46f4-43eb-8060-2a379fb357a5")).toBe(true);
    expect(isOwnRequest("5A810BD0-46F4-43EB-8060-2A379FB357A5")).toBe(true);
  });

  // ky's own relays name their request (mail:, peer-escalate:, subagent-report:, episodes:): a notice, which an
  // episode reflection never counts as a turn nor cites, and chat search labels "notice:".
  it.each([undefined, "", "mail:m1", "peer-escalate:sam:1", "subagent-report:5a810bd0-46f4-43eb-8060-2a379fb357a5", "5a810bd0-46f4-43eb-8060-2a379fb357a5 ", "5a810bd0-46f4-43eb-8060"])(
    "a request named %j is a notice",
    (request) => {
      expect(isOwnRequest(request)).toBe(false);
    }
  );
});
