import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { Recording, TEACH_DIR } from "../browse/contract";
import { inside, promptTool, said } from "./drive";
import { type FakeBrowsers, liveSession } from "./fake-browser";

/**
 * Show me (src/browse/teach.ts): a hand-off with teach records what the user does in ky's browser; once they're
 * done the recording is kept in the workspace and a skill review drafts a skill from it, held archived until the
 * user says yes. Browser Run and its recorder are src/tests/fake-browser.ts; the draft is the fake model's.
 */

const SHOP = "https://shop.teach.test/";

const INSTRUCTIONS = "Show me how you reorder your usual groceries.";

type Logged = { readonly t: string; readonly title?: string; readonly value?: string; readonly url?: string; readonly at?: number; readonly el?: Readonly<Record<string, string>> };

const line = (event: Logged) => JSON.stringify({ url: SHOP, at: 1, ...event });

const DEMO = [
  line({ t: "page", title: "Shop", at: 1 }),
  line({ t: "input", el: { tag: "input", label: "Search", name: "q" }, value: "oat milk", at: 2 }),
  line({ t: "click", el: { tag: "button", text: "Add to cart" }, at: 3 }),
  "not an event",
  line({ t: "input", el: { tag: "input", type: "password", label: "Password" }, value: "[hidden]", url: `${SHOP}checkout`, at: 4 }),
  line({ t: "submit", el: { tag: "form", id: "checkout" }, url: `${SHOP}checkout`, at: 5 })
].join("\n");

async function using(name: string, set: (browsers: FakeBrowsers) => void): Promise<void> {
  await inside(name, (instance) => set(instance.boundary.browsers));
}

async function showMe(name: string) {
  await using(name, (browsers) => {
    browsers.pages.set(SHOP, { title: "Shop", text: "Groceries" });
    browsers.pages.set(`${SHOP}checkout`, { title: "Checkout", text: "Pay" });
  });
  const asked = await promptTool(name, `tool browse_handoff ${JSON.stringify({ url: SHOP, instructions: INSTRUCTIONS, teach: true })}`);
  expect(asked.failed).toBe(false);
  const [card] = await inside(name, (instance) => instance.approvals.pending());

  return card!;
}

const decide = (name: string, id: string, action: "accept" | "decline") => inside(name, (instance) => instance.approvals.onDecision(id, action));

const shown = (name: string) => inside(name, (instance) => instance.skills.all().filter((skill) => skill.name.startsWith("shown-")));

const kept = (name: string) => inside(name, async (instance) => (await instance.workspace.fs.readdir(TEACH_DIR).catch(() => [])).map((entry) => entry.name));

describe("a show-me hand-off", () => {
  it("records the user's steps, keeps them, and drafts a skill from them, held until the user says yes", async () => {
    const name = crypto.randomUUID();
    const card = await showMe(name);
    expect(card.summary).toBe(`${INSTRUCTIONS} ky records what you click and type to learn it, never a password, code or card number.`);
    expect(liveSession(await inside(name, (instance) => instance.boundary.browsers))?.tabs[0]?.recording).toBe(true);

    await using(name, (browsers) => {
      const tab = liveSession(browsers)!.tabs[0]!;
      tab.logs = [DEMO];
      void tab.goto(`${SHOP}checkout`);
    });

    expect(await decide(name, card.id, "accept")).toEqual({});
    await said(name, "From what they showed, ky drafted the skill shown-teach-test, kept archived so nothing uses it yet.");

    const [file] = await kept(name);

    const recording = Schema.decodeUnknownSync(Schema.fromJsonString(Recording))(
      await inside(name, (instance) => instance.workspace.fs.readFile(`${TEACH_DIR}/${file}`, { encoding: "utf8" }))
    );

    expect(recording).toMatchObject({ site: "teach.test", instructions: INSTRUCTIONS });
    expect(recording.pages.map((page) => page.url)).toEqual([SHOP, `${SHOP}checkout`]);
    expect(recording.events.map((event) => event.t)).toEqual(["page", "input", "click", "input", "submit"]);

    const [skill] = await shown(name);
    expect(skill).toMatchObject({ name: "shown-teach-test", status: "archived", created_by: "review" });
    expect(skill!.body).toContain('clicked button "Add to cart" on https://shop.teach.test/');
    expect(skill!.body).toContain('set password field "Password" to [hidden]');
    expect(skill!.body).toContain('set input "Search" (name=q) to "oat milk"');
    expect(skill!.body).toContain("## Needs");
    const history = await inside(name, (instance) => instance.skills.history("shown-teach-test").map((version) => `${version.action} by ${version.actor}`));
    expect(history).toEqual(["archive by ky", "create by review"]);
    const drafts = await inside(name, (instance) => instance.feed.list().filter((task) => task.title === "Skill from your demo"));
    expect(drafts).toMatchObject([{ worker: "skills", status: "done" }]);
  });

  it("makes no skill when the user did nothing there", async () => {
    const name = crypto.randomUUID();
    const card = await showMe(name);
    await using(name, (browsers) => {
      liveSession(browsers)!.tabs[0]!.logs = [line({ t: "page", title: "Shop" })];
    });

    expect(await decide(name, card.id, "accept")).toEqual({});
    await said(name, "ky saw nothing the user did there, so no skill was made.");
    expect(await shown(name)).toEqual([]);
    expect(await kept(name)).toEqual([]);
  });

  it("makes no skill when the user couldn't", async () => {
    const name = crypto.randomUUID();
    const card = await showMe(name);
    await using(name, (browsers) => {
      liveSession(browsers)!.tabs[0]!.logs = [DEMO];
    });

    expect(await decide(name, card.id, "decline")).toEqual({});
    await said(name, "Don't hand it over again unless they ask. No skill was made from it.");
    expect(await shown(name)).toEqual([]);
    expect(await kept(name)).toEqual([]);
  });
});
