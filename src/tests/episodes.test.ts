import { describe, expect, it } from "vitest";
import { isOwnRequest } from "../history";
import { EPISODE_COOLDOWN_MS, EPISODE_TURNS } from "../dreaming/episodes";
import { browser, inside, type Tab } from "./drive";

/**
 * Episode reflection (src/dreaming/episodes.ts) on ky's real Worker, driven from the browser: after a busy turn or a
 * quiet stretch of the user's messages, and never twice within EPISODE_COOLDOWN_MS, a chat is forked and asked what
 * it leaves open. The scripted model (src/tests/stack.ts) keeps the first "#id user: I'll ..." line of its prompt as
 * an open loop and otherwise answers [SILENT]. A chat's first turn marks its history read.
 */

/** How many episode passes the model was asked for so far: a pass that calls a tool asks again with the same prompt. */
const passes = (name: string) =>
  inside(name, (instance) => new Set(instance.boundary.asked.flatMap((users) => (users.at(-1)?.startsWith("[episode]") === true ? [users.at(-1)] : []))).size);

/** The Episode reflection cards Activity shows that have ended. */
const cards = (page: Tab) => (page.latest("tasks")?.tasks ?? []).filter((task) => task.title === "Episode reflection" && task.finished_at !== null);

/** ky's last answer in the chat. */
const lastAnswer = (page: Tab) =>
  (page.view().messages.findLast((message) => message.role === "assistant")?.parts ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");

/** A pass started by a turn has had time to start: another turn ran start to end after it. */
const settle = (page: Tab) => page.say("ok");

describe("an episode reflection", () => {
  it("keeps the user's promise after a busy turn, once per stretch, holding back for the cooldown", async () => {
    const name = crypto.randomUUID();
    // Seed: a turn with one tool call is busy.
    await inside(name, (instance) => {
      instance.skills.reviewAfter = 1;
    });
    const page = await browser(name);

    await page.say("hello");
    await page.say("I'll send Sam the deck by Friday");
    await page.say("multiply 3");
    await page.until(() => cards(page).length === 1);
    await page.say('tool anticipate {"action":"list"}');
    expect(lastAnswer(page)).toContain("I'll send Sam the deck by Friday");

    // Busy again inside the cooldown: no pass.
    await page.say("I'll call the bank tomorrow");
    await page.say("multiply 4");
    await settle(page);
    expect(await passes(name)).toBe(1);

    // Seed: the last pass ran a cooldown ago. The next busy turn reads only what came since it.
    await inside(name, (_instance, state) => {
      state.storage.sql.exec("UPDATE ky_skill_reviews SET created_at = created_at - ? WHERE kind = 'episode' AND created_at > 0", EPISODE_COOLDOWN_MS + 1);
    });
    await page.say("multiply 6");
    await page.until(() => cards(page).length === 2);
    await page.say('tool anticipate {"action":"list"}');
    expect(lastAnswer(page)).toContain("I'll call the bank tomorrow");
    expect(lastAnswer(page).match(/send Sam/g)).toHaveLength(1);
    page.close();
  });

  it(`runs none while Proactivity is off; back on, a quiet stretch of ${EPISODE_TURNS} gets one, and its [SILENT] leaves no card`, async () => {
    const name = crypto.randomUUID();
    const page = await browser(name);
    expect(await page.send({ type: "set-proactivity", level: "off" })).toMatchObject({ type: "result" });

    for (let turn = 0; turn <= EPISODE_TURNS + 1; turn++) await page.say(`hello ${turn}`);
    await settle(page);
    expect(await passes(name)).toBe(0);

    expect(await page.send({ type: "set-proactivity", level: "on" })).toMatchObject({ type: "result" });

    // The first turn back marks the chat read; the stretch counts from there.
    for (let turn = 0; turn <= EPISODE_TURNS; turn++) await page.say(`back ${turn}`);
    await settle(page);
    expect(await passes(name)).toBe(1);
    expect(cards(page)).toEqual([]);
    page.close();
  });
});

describe("Settings › Proactivity", () => {
  it("is on by default, and reads a level an older ky stored, brief or boundary, as on", async () => {
    const levels = await inside(crypto.randomUUID(), (instance, state) => {
      const fresh = instance.proactivity.level();

      const read = (stored: string) => {
        state.storage.sql.exec("INSERT OR REPLACE INTO ky_proactivity (id, level) VALUES (1, ?)", stored);

        return instance.proactivity.level();
      };

      return [fresh, read("brief"), read("boundary"), read("off")];
    });

    expect(levels).toEqual(["on", "on", "on", "off"]);
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
