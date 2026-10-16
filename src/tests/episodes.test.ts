import { ROOT_SESSION } from "agents/harness/pi";
import { describe, expect, it } from "vitest";
import { EPISODE_TURNS } from "../dreaming/episodes";
import { inside, prompt, until } from "./drive";

/**
 * Episode reflection (src/dreaming/episodes.ts) on ky's real PiAgent: after a busy turn, or after EPISODE_TURNS of
 * the user's messages, a chat is forked and asked what it leaves open. The fake model (src/tests/stack.ts) keeps
 * the user's first "I'll ..." message as an open loop and otherwise answers [SILENT].
 */

const episodes = (name: string) => inside(name, (instance) => instance.feed.list().filter((task) => task.worker === "episodes"));

/** Every episode pass so far has finished; `count` of them, at least. */
const settled = (name: string, count: number) =>
  until(async () => {
    const tasks = await episodes(name);

    return tasks.length >= count && tasks.every((task) => task.status !== "working");
  }, `${count} episode reflections to finish`);

/** The chat each episode pass forked, oldest first. */
const parents = (name: string) =>
  inside(name, (_instance, state) =>
    state.storage.sql.exec<{ parent: string }>("SELECT parent FROM ky_skill_reviews WHERE kind = 'episode' ORDER BY created_at").toArray().map((row) => row.parent)
  );

/** The user's newest message, as a message id a row cites. */
const newestAsk = (name: string) =>
  inside(name, (_instance, state) =>
    Number(state.storage.sql.exec("SELECT max(id) AS id FROM pi_entries WHERE json_extract(record, '$.kind') = 'pi.user'").one().id)
  );

describe("an episode reflection after a busy turn", () => {
  it("keeps a promise the user made as an open loop by episode, citing their message", async () => {
    const name = crypto.randomUUID();
    await inside(name, (instance) => {
      instance.skills.reviewAfter = 1;
    });

    await prompt(name, "I'll reply to Sam by Friday");
    const promise = await newestAsk(name);
    // One tool call makes the turn busy, so the chat gets a pass over both messages.
    await prompt(name, "multiply 3");
    await settled(name, 1);

    const open = await inside(name, (instance) => instance.anticipations.open());
    expect(open).toMatchObject([{ kind: "open_loop", created_by: "episode", text: "I'll reply to Sam by Friday", evidence: { messages: [promise], memories: [] } }]);

    const [task] = await episodes(name);
    expect(task).toMatchObject({ kind: "cloud", title: "Episode reflection", status: "done", summary: `tool said: Saved as #${open[0]!.id}.` });
    expect(await parents(name)).toEqual([ROOT_SESSION]);
  });

  it("answers [SILENT] and keeps nothing when the chat leaves nothing open", async () => {
    const name = crypto.randomUUID();
    await inside(name, (instance) => {
      instance.skills.reviewAfter = 1;
    });

    await prompt(name, "hello");
    await prompt(name, "multiply 3");
    await settled(name, 1);

    expect(await inside(name, (instance) => instance.anticipations.open())).toEqual([]);
    expect(await episodes(name)).toMatchObject([{ status: "done", summary: "Nothing open" }]);
  });

  it("may call only anticipate and memory_recall", async () => {
    const name = crypto.randomUUID();
    await inside(name, (instance) => {
      instance.skills.reviewAfter = 1;
    });

    await prompt(name, "multiply 3");
    await settled(name, 1);
    const fork = (await episodes(name))[0]!.session!;

    const blocked = await inside(name, async (instance) => (await instance.harness.session(fork).prompt("multiply 4")).text);
    expect(blocked).toContain("Tool call blocked: A episode reflection may only call anticipate, memory_recall.");
  });
});

describe("an episode reflection on a quiet chat", () => {
  it(`runs after ${EPISODE_TURNS} of the user's messages with few tools, and counts again from there`, async () => {
    const name = crypto.randomUUID();
    await inside(name, (instance) => {
      instance.skills.reviewAfter = 99;
    });

    for (let turn = 1; turn < EPISODE_TURNS; turn++) await prompt(name, `hello ${turn}`);
    expect(await episodes(name)).toEqual([]);

    await prompt(name, "hello again");
    await settled(name, 1);
    expect(await episodes(name)).toHaveLength(1);

    // The pass reset the count: the next ones are a fresh run of turns.
    for (let turn = 1; turn < EPISODE_TURNS; turn++) await prompt(name, `more ${turn}`);
    expect(await episodes(name)).toHaveLength(1);

    await prompt(name, "more again");
    await settled(name, 2);
    expect(await parents(name)).toEqual([ROOT_SESSION, ROOT_SESSION]);
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

    const side = await inside(name, async (instance) => {
      const session = await instance.newChat();
      await instance.harness.session(session).prompt("multiply 2");

      return session;
    });

    await until(async () => (await parents(name)).includes(side), "the side chat's pass");
    await settled(name, 2);

    const subagent = (await inside(name, (instance) => instance.feed.list())).find((task) => task.worker === "worker")!.session!;
    const forked = new Set(await parents(name));
    expect(forked).toEqual(new Set([ROOT_SESSION, side]));
    expect(forked.has(subagent)).toBe(false);
  });
});
