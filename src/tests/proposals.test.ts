import type { JsonValue } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import Type from "typebox";
import { decodeOr } from "../core/decode";
import type { PiServerMessage } from "../protocol";
import { browser, dreamSession, inside, prompt } from "./drive";

/**
 * Proposals (src/dreaming/proposals.ts) on ky's real PiAgent: the dream suggests an automation for a check the user
 * kept doing by hand, through the anticipate tool's propose action, and the user accepts or dismisses it in
 * Activity › Suggested, over the browser's socket.
 */

const tool = (name: string, args: Record<string, JsonValue>) => `tool ${name} ${JSON.stringify(args)}`;

const DAY = 86_400_000;

/** The user asks whether CI is green, today and the day before: the two messages' ids. */
async function checkedByHand(name: string): Promise<number[]> {
  await prompt(name, "is CI green on main?");
  await prompt(name, "is CI green on main now?");

  return inside(name, (_instance, state) => {
    const sql = state.storage.sql;

    const ids = sql
      .exec<{ id: number }>("SELECT id FROM pi_entries WHERE json_extract(record, '$.kind') = 'pi.user' ORDER BY id")
      .toArray()
      .map((row) => row.id);

    // The first ask was yesterday's.
    sql.exec("UPDATE pi_entries SET record = json_set(record, '$.model[0].timestamp', json_extract(record, '$.model[0].timestamp') - ?) WHERE id = ?", DAY, ids[0]!);

    return ids;
  });
}

const propose = (key: string, messages: number[], more: Record<string, JsonValue> = {}) =>
  tool("anticipate", {
    action: "propose",
    key,
    title: `Check ${key}`,
    why: "The user asked whether CI on main was green on two days",
    cron: "0 9 * * *",
    prompt: "Say whether CI on main is green",
    messages,
    ...more
  });

/** As if a night passed since every proposal so far was made. */
const nightPassed = (name: string) =>
  inside(name, (_instance, state) => {
    state.storage.sql.exec("UPDATE ky_proposals SET created_at = created_at - ?", DAY);
  });

type Page = Awaited<ReturnType<typeof browser>>;

const Suggested = Type.Array(Type.Object({ id: Type.Integer(), title: Type.String() }));

const Refusal = Type.Object({ refused: Type.String() });

/** Activity › Suggested as the page asks for it: each open proposal's id and title. */
async function suggested(page: Page): Promise<Array<{ id: number; title: string }>> {
  const frame = await page.send({ type: "proposals" });

  return frame?.type === "result" ? decodeOr(Suggested, frame.result, []).map(({ id, title }) => ({ id, title })) : [];
}

/** Whether the page's answer refused. */
const refused = (frame: PiServerMessage | undefined) => frame?.type === "error" || (frame?.type === "result" && decodeOr(Refusal, frame.result, undefined) !== undefined);

/** The automations the page was last told of: each title and who made it. */
const automations = (page: Page) =>
  page.frames
    .filter((frame): frame is Extract<PiServerMessage, { type: "automations" }> => frame.type === "automations")
    .at(-1)
    ?.automations.map((each) => [each.title, each.created_by]) ?? [];

describe("a proposal", () => {
  it("is the dream's alone, never offered again once dismissed, and held to 2 a night and 5 open", async () => {
    const name = crypto.randomUUID();
    const messages = await checkedByHand(name);
    const page = await browser(name);
    const dream = await dreamSession(name);
    const titles = async () => (await suggested(page)).map((each) => each.title);

    // From the chat, the user's own turn proposes nothing.
    await prompt(name, propose("check-ci", messages));
    expect(await titles()).toEqual([]);

    await dream(propose("check-ci", messages));
    const [ci] = await suggested(page);
    expect(ci?.title).toBe("Check check-ci");

    expect(refused(await page.send({ type: "proposal-dismiss", proposal: ci!.id }))).toBe(false);
    expect(await titles()).toEqual([]);
    // A dismissed one stays dismissed: accepting it now makes nothing, and the dream may not offer it again.
    expect(refused(await page.send({ type: "proposal-accept", proposal: ci!.id }))).toBe(true);
    await dream(propose("check-ci", messages));
    expect(await titles()).toEqual([]);

    // The dismissed one counts toward tonight's 2.
    await dream(propose("check-a", messages));
    await dream(propose("check-b", messages));
    expect(await titles()).toEqual(["Check check-a"]);

    for (const keys of [["check-b", "check-c"], ["check-d", "check-e"], ["check-f"]]) {
      await nightPassed(name);

      for (const key of keys) await dream(propose(key, messages));
    }

    expect(await titles()).toEqual(["Check check-a", "Check check-b", "Check check-c", "Check check-d", "Check check-e"]);
    expect(automations(page).filter(([title]) => String(title).startsWith("Check "))).toEqual([]);
    page.close();
  });

  it("accepted, becomes the user's automation; one whose automation cannot be made stays open", async () => {
    const name = crypto.randomUUID();
    const messages = await checkedByHand(name);
    const page = await browser(name);
    const dream = await dreamSession(name);

    await dream(propose("check-ci", messages));
    const [ci] = await suggested(page);
    expect(refused(await page.send({ type: "proposal-accept", proposal: ci!.id }))).toBe(false);
    await page.until(() => automations(page).some(([title]) => title === "Check check-ci"));
    expect(automations(page).filter(([title]) => title === "Check check-ci")).toEqual([["Check check-ci", "user"]]);
    expect(await suggested(page)).toEqual([]);

    // A minute 61 passes the proposal's shape, and the automation's save refuses it.
    await dream(propose("check-late", messages, { cron: "61 9 * * *" }));
    const [late] = await suggested(page);
    expect(refused(await page.send({ type: "proposal-accept", proposal: late!.id }))).toBe(true);
    expect(await suggested(page)).toEqual([late]);
    expect(automations(page).some(([title]) => title === "Check check-late")).toBe(false);
    page.close();
  });
});
