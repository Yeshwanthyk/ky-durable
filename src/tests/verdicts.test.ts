import { ROOT_SESSION } from "agents/harness/pi";
import { describe, expect, it } from "vitest";
import { browser, inside, type Tab } from "./drive";

/**
 * The user's 👍 or 👎 on ky's unasked posts (src/dreaming/verdicts.ts) on its real Worker: kept by the post's
 * delivery id from the page's socket, decoded by its Schema, read back by the next look's prompt and by the dream's
 * digest, and a 👎'd ref not posted again unless the look says what changed.
 */

const look = (row: Readonly<Record<string, string>>) => `look> ${JSON.stringify(row)}`;

/** ky's unasked posts in the main chat, oldest first: each its delivery id and text. */
const posts = (page: Tab) =>
  page
    .view()
    .messages.filter((message) => message.posted === true)
    .map((message) => ({ post: message.post, text: message.parts.map((part) => (part.type === "text" ? part.text : "")).join("") }));

/** The prompts the looks were asked with, oldest first. */
const lookPrompts = (name: string) => inside(name, (instance) => instance.boundary.asked.flatMap((users) => (users.at(-1)?.startsWith("[look]") === true ? [users.at(-1)!] : [])));

async function openLoop(page: Tab, name: string, text: string) {
  await page.say(`tool anticipate {"action":"add","kind":"open_loop","text":"${text}"}`);
  const [loop] = await inside(name, (instance) => instance.anticipations.open().map((row) => row.id));

  return `anticipation:${loop}`;
}

describe("a verdict on a post", () => {
  it("is kept by the post's delivery id, decoded at the socket, and changes with the user's mind", async () => {
    const name = crypto.randomUUID();
    const page = await browser(name);
    const ref = await openLoop(page, name, "Call the bank about the card");
    const said = "You still owe the bank a call about the card.";
    await page.say(look({ ref, needed: "call the bank", current: "not called", action: "tell", message: said }));
    await inside(name, (instance) => instance.looks.run("08:00"));
    await page.until(() => posts(page).some((post) => post.text === said));

    const [post] = posts(page);
    expect(post?.post).toMatch(new RegExp(`^look:\\d{4}-\\d{2}-\\d{2}:08:00:${ref}$`));
    const item = post?.post ?? "";

    expect(await page.send({ type: "post-verdict", verdict: { item, verdict: "not-useful", reason: "  I called them   yesterday " } })).toMatchObject({
      type: "result",
      result: { verdicts: [{ item, verdict: "not-useful", reason: "I called them yesterday" }], useful: 0, judged: 1 }
    });

    const stored = await inside(name, (_instance, state) => state.storage.sql.exec("SELECT item, kind, ref, text, verdict, reason FROM ky_post_verdicts").toArray());
    expect(stored).toEqual([{ item, kind: "look", ref, text: said, verdict: "not-useful", reason: "I called them yesterday" }]);

    // Not a verdict, or not a post: refused, and nothing kept.
    const refusal = "A verdict is useful or not-useful on a post, with a reason of at most 200 characters.";

    for (const verdict of [{ item, verdict: "meh" }, { item }, { item, verdict: "not-useful", reason: "x".repeat(201) }, "useful", null]) {
      expect(await page.send({ type: "post-verdict", verdict })).toMatchObject({ type: "result", result: { refused: refusal } });
    }

    expect(await page.send({ type: "post-verdict", verdict: { item: "look:nothing", verdict: "useful" } })).toMatchObject({ type: "result", result: { refused: "ky posted nothing as look:nothing." } });

    // A 👍 replaces the 👎, and drops its reason.
    expect(await page.send({ type: "post-verdict", verdict: { item, verdict: "useful" } })).toMatchObject({
      type: "result",
      result: { verdicts: [{ item, verdict: "useful", reason: null }], useful: 1, judged: 1 }
    });
    expect(await page.send({ type: "post-verdicts" })).toMatchObject({ type: "result", result: { useful: 1, judged: 1 } });
    page.close();
  });
});

describe("the looks after a 👎", () => {
  it("read how the posts landed, and post on a 👎'd ref again only with what changed", async () => {
    const name = crypto.randomUUID();
    const page = await browser(name);
    const ref = await openLoop(page, name, "Renew the passport");
    const first = "Your passport still needs renewing.";
    await page.say(look({ ref, needed: "renew passport", current: "not renewed", action: "tell", message: first }));
    await inside(name, (instance) => instance.looks.run("08:00"));
    await page.until(() => posts(page).length === 1);
    const item = posts(page)[0]?.post ?? "";
    await page.send({ type: "post-verdict", verdict: { item, verdict: "not-useful", reason: "I know, it is booked" } });

    // The user writing since would let a said ref go again; the 👎 still holds it.
    const again = "Reminder: the passport.";
    await page.say(look({ ref, needed: "renew passport", current: "not renewed", action: "tell", message: again }));
    await inside(name, (instance) => instance.looks.run("13:00"));

    const [, second] = await lookPrompts(name);
    expect(second).toContain("How your recent posts landed, newest first (the user's 👍 or 👎, and why):");
    expect(second).toContain(`- 👎 not useful: "${first}" (${ref}, `);
    expect(second).toContain("): I know, it is booked");
    expect(posts(page).map((post) => post.text)).toEqual([first]);

    const changed = "The passport office moved your slot to Friday.";
    await page.say(look({ ref, needed: "renew passport", current: "slot moved", action: "tell", message: changed, changed: "the slot moved" }));
    await inside(name, (instance) => instance.looks.run("18:00"));
    await page.until(() => posts(page).length === 2);
    expect(posts(page).map((post) => post.text)).toEqual([first, changed]);
    page.close();
  });
});

describe("the dream after 👎s", () => {
  it("reads them in its digest, and a note it makes is in its ledger and undone by a withdrawal", async () => {
    const name = crypto.randomUUID();
    const page = await browser(name);
    const ref = await openLoop(page, name, "Water the plants");
    const said = "The weather is sunny today.";
    await page.say(look({ ref, needed: "plants", current: "dry", action: "tell", message: said }));
    await inside(name, (instance) => instance.looks.run("08:00"));
    await page.until(() => posts(page).length === 1);
    await page.send({ type: "post-verdict", verdict: { item: posts(page)[0]?.post ?? "", verdict: "not-useful", reason: "no weather posts" } });

    const digest = await inside(name, (instance) => instance.dreaming.digest({ memories: 0, at: 0 }));
    expect(digest).toContain(`Posts the user marked not useful in the last 30 days, newest first:\n- 👎 not useful: "${said}" (${ref}, `);
    expect(digest).toContain("): no weather posts");

    const [rows, undone, wake] = await inside(name, (instance) => {
      const session = `dream-session-${crypto.randomUUID()}`;
      instance.reviews.add(session, "", "dream", { run: "dream-test" });
      instance.memory.note("The user does not want ky to post the weather unasked", session);
      instance.memory.note("Said in the main chat", ROOT_SESSION);
      const night = instance.ledger.lastNight().filter((row) => row.action === "note");

      return [night, instance.ledger.undo(night[0]?.id ?? 0), instance.memory.recall("weather")];
    });

    expect(rows).toMatchObject([{ kind: "memory", action: "note", actor: "dream", run: "dream-test", before: "The user does not want ky to post the weather unasked" }]);
    expect(undone).toMatch(/^Saved as #\d+\.$/);
    expect(wake).toContain(`Withdrawn: ${rows[0]?.target} no longer holds; the user took back ky's note "The user does not want ky to post the weather unasked".`);
    page.close();
  });
});
