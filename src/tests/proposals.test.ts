import type { JsonValue } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import Type from "typebox";
import { decodeOr } from "../core/decode";
import type { PiServerMessage } from "../protocol";
import { browser, dreamTonight, inside, type Tab } from "./drive";

/**
 * Proposals (src/dreaming/proposals.ts), driven from the browser: the night's dream suggests an automation for a
 * check the user kept doing by hand, and the user accepts or dismisses it in Activity › Suggested. The scripted dream
 * (src/tests/stack.ts) proposes what a user's line of its digest asks it to.
 */

const DAY = 86_400_000;

/** The user asks whether CI is green, yesterday and today: the two messages' ids. */
async function checkedByHand(name: string, page: Tab): Promise<number[]> {
  await page.say("is CI green on main?");
  await page.say("is CI green on main now?");

  // Seed: the first ask was yesterday's.
  return inside(name, (_instance, state) => {
    const sql = state.storage.sql;

    const ids = sql
      .exec<{ id: number }>("SELECT id FROM pi_entries WHERE json_extract(record, '$.kind') = 'pi.user' AND record LIKE '%is CI green%' ORDER BY id")
      .toArray()
      .map((row) => row.id);

    sql.exec("UPDATE pi_entries SET record = json_set(record, '$.model[0].timestamp', json_extract(record, '$.model[0].timestamp') - ?) WHERE id = ?", DAY, ids[0]!);

    return ids;
  });
}

const proposal = (key: string, messages: number[], more: Record<string, JsonValue> = {}) => ({
  action: "propose",
  key,
  title: `Check ${key}`,
  why: "The user asked whether CI on main was green on two days",
  cron: "0 9 * * *",
  prompt: "Say whether CI on main is green",
  messages,
  ...more
});

/** A night: the user asks the dream for these proposals, then it fires. */
async function night(name: string, page: Tab, proposals: ReadonlyArray<ReturnType<typeof proposal>>): Promise<void> {
  await page.say(`Tonight: ${proposals.map((each) => `dream> tool anticipate ${JSON.stringify(each)}`).join(" ")}`);
  await dreamTonight(name);
}

/** Seed: a night passed since every proposal so far was made. */
const nightPassed = (name: string) =>
  inside(name, (_instance, state) => {
    state.storage.sql.exec("UPDATE ky_proposals SET created_at = created_at - ?", DAY);
  });

const Suggested = Type.Array(Type.Object({ id: Type.Integer(), title: Type.String() }));

const Refusal = Type.Object({ refused: Type.String() });

/** Activity › Suggested as the page asks for it: each open proposal's id and title. */
async function suggested(page: Tab): Promise<Array<{ id: number; title: string }>> {
  const frame = await page.send({ type: "proposals" });

  return frame?.type === "result" ? decodeOr(Suggested, frame.result, []).map(({ id, title }) => ({ id, title })) : [];
}

const titles = async (page: Tab) => (await suggested(page)).map((each) => each.title);

/** Whether the page's answer refused. */
const refused = (frame: PiServerMessage | undefined) => frame?.type === "error" || (frame?.type === "result" && decodeOr(Refusal, frame.result, undefined) !== undefined);

/** The automations the page was last told of: each title and who made it. */
const automations = (page: Tab) => page.latest("automations")?.automations.map((each) => [each.title, each.created_by]) ?? [];

describe("a proposal", () => {
  it("is the dream's alone; accepted, it is the user's automation; dismissed, never again; 2 a night and 5 open", async () => {
    const name = crypto.randomUUID();
    const page = await browser(name);
    const asks = await checkedByHand(name, page);
    const id = async (title: string) => (await suggested(page)).find((each) => each.title === title)!.id;

    // From the chat, the user's own turn proposes nothing.
    await page.say(`tool anticipate ${JSON.stringify(proposal("check-mine", asks))}`);
    expect(await titles(page)).toEqual([]);

    // The first night offers two of three.
    await night(name, page, [proposal("check-ci", asks), proposal("check-a", asks), proposal("check-b", asks)]);
    expect(await titles(page)).toEqual(["Check check-ci", "Check check-a"]);

    const ci = await id("Check check-ci");
    expect(refused(await page.send({ type: "proposal-dismiss", proposal: ci }))).toBe(false);
    expect(refused(await page.send({ type: "proposal-accept", proposal: await id("Check check-a") }))).toBe(false);
    await page.until(() => automations(page).some(([title]) => title === "Check check-a"));
    expect(automations(page)).toEqual([["Check check-a", "user"]]);
    // A dismissed one stays dismissed: accepting it now makes nothing.
    expect(refused(await page.send({ type: "proposal-accept", proposal: ci }))).toBe(true);
    expect(await titles(page)).toEqual([]);

    // The next night may not offer the dismissed one again. A minute 61 passes the proposal's shape, and the
    // automation's save refuses it: it stays open.
    await nightPassed(name);
    await night(name, page, [proposal("check-ci", asks), proposal("check-late", asks, { cron: "61 9 * * *" }), proposal("check-c", asks)]);
    expect(await titles(page)).toEqual(["Check check-late", "Check check-c"]);
    expect(refused(await page.send({ type: "proposal-accept", proposal: await id("Check check-late") }))).toBe(true);
    expect(await titles(page)).toEqual(["Check check-late", "Check check-c"]);

    // Five open at most.
    for (const keys of [["check-d", "check-e"], ["check-f", "check-g"]]) {
      await nightPassed(name);
      await night(name, page, keys.map((key) => proposal(key, asks)));
    }

    expect(await titles(page)).toEqual(["Check check-late", "Check check-c", "Check check-d", "Check check-e", "Check check-f"]);
    expect(automations(page)).toEqual([["Check check-a", "user"]]);
    page.close();
  });
});
