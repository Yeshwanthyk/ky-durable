import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { type JsonObject, Type } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { decode, parseAs } from "../core/decode";
import { canonical, LOOP_LIMIT, preview, PREVIEW_HEAD, PREVIEW_TAIL, repeats, SPILL_CHARS, spillPath } from "../guardrails";
import { agent, gateStarted, inside, prompt, submit, wait } from "./drive";
import { bulkText } from "./stack";

const multiply = (value: number) => ["multiply", { value }];

const BLOCKED = /<harness>\n\[error\] Tool call blocked: multiply was already called 4 times in this turn with these same arguments, and it gave the same answer each time\. Calling it again will not change that: change approach/;

const CallRow = Type.Object({ id: Type.String(), conversation: Type.Number(), args: Type.String() });

const Arguments = Type.Unsafe<JsonObject>(Type.Record(Type.String(), Type.Any()));

/** A page `read` answers: an envelope, for a file it reads in parts. */
const Page = Type.Object({ content: Type.String(), truncated: Type.Boolean() });

/** The calls of the tool `name`, in order: each one's id, its conversation, and its arguments. */
function callsOf(sql: SqlStorage, name: string) {
  return sql
    .exec(
      `SELECT json_extract(c.value, '$.id') AS id, e.conversation_id AS conversation, json_extract(c.value, '$.arguments') AS args
       FROM pi_entries AS e, json_each(e.record, '$.model[0].content') AS c
       WHERE json_extract(e.record, '$.kind') = 'pi.assistant' AND json_extract(c.value, '$.name') = ? ORDER BY e.id, c.key`,
      name
    )
    .toArray()
    .map((row) => decode(CallRow, row, "a call"));
}

describe("the loop guard", () => {
  it("blocks the fifth identical call of a run, across a restart, and the sixth; other arguments still run", async () => {
    const name = crypto.randomUUID();
    const calls = [multiply(1), multiply(1), multiply(1), multiply(1), ["gate", {}], multiply(1), multiply(1), multiply(2)];
    const run = await submit(name, `calls ${JSON.stringify(calls)}`);

    // Four identical calls are in; the object is reset while the run waits on the gate, as a crash would, so nothing in
    // memory survives, and its alarm brings the run back, the gate running again.
    await gateStarted(name, 1);
    await inside(name, (_instance, state) => state.abort("restart")).catch(() => undefined);
    await runDurableObjectAlarm(agent(name));
    await gateStarted(name, 2);
    await agent(name).release();

    const results = (await wait(name, run.operationId)).text!.replace(/^results: /, "").split(" | ");
    expect(results.slice(0, 5)).toEqual(["3", "3", "3", "3", "released after 2 runs"]);
    expect(results[5]).toMatch(BLOCKED);
    expect(results[6]).toMatch(BLOCKED);
    expect(results[7]).toBe("6");

    // Read again from the entries alone in a fresh object, as a replay of each call's beforeTool would: the same answers.
    await evictDurableObject(agent(name));

    const counts = await inside(name, (_instance, state) =>
      callsOf(state.storage.sql, "multiply").map((call) => repeats(state.storage.sql, call.conversation, { id: call.id, name: "multiply", arguments: parseAs(Arguments, call.args, "arguments") }))
    );

    expect(counts).toEqual([0, 0, 0, 0, LOOP_LIMIT, LOOP_LIMIT, 0]);
  });

  it("starts the count over at the user's next message", async () => {
    const name = crypto.randomUUID();
    const four = `calls ${JSON.stringify([multiply(1), multiply(1), multiply(1), multiply(1)])}`;

    expect((await prompt(name, four)).text).toBe("results: 3 | 3 | 3 | 3");
    expect((await prompt(name, four)).text).toBe("results: 3 | 3 | 3 | 3");
  });

  it("lets a poll whose answer changes run as often as it is called", async () => {
    const name = crypto.randomUUID();
    const ticks = Array.from({ length: 7 }, () => ["tick", {}]);

    expect((await prompt(name, `calls ${JSON.stringify(ticks)}`)).text).toBe("results: tick 1 | tick 2 | tick 3 | tick 4 | tick 5 | tick 6 | tick 7");
  });

  it("compares arguments whatever order their keys are in", () => {
    expect(canonical({ b: 1, a: { d: [1, { f: 2, e: 3 }], c: null } })).toBe(canonical({ a: { c: null, d: [1, { e: 3, f: 2 }] }, b: 1 }));
    expect(canonical({ value: 1 })).not.toBe(canonical({ value: 2 }));
  });
});

describe("a big result", () => {
  it("goes to a workspace file, the model sees its start, end and path, and read gives back all of it", async () => {
    const name = crypto.randomUUID();
    const text = bulkText(1000);
    expect(text.length).toBeGreaterThan(60_000);

    const { answer, shown } = await inside(name, async (instance) => {
      const { text: answer, messages } = await instance.harness.prompt('readback tool bulk {"lines":1000}');
      const results = messages.flatMap((entry) => entry.model ?? []).filter((message) => message.role === "toolResult");

      return { answer, shown: results.map((message) => ({ tool: message.toolName, id: message.toolCallId, text: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n") })) };
    });

    const bulk = shown[0]!;
    const path = spillPath(bulk.id);
    expect(bulk.tool).toBe("bulk");
    expect(bulk.text.length).toBeLessThan(SPILL_CHARS);
    expect(bulk.text.startsWith(text.slice(0, 5_000))).toBe(true);
    expect(bulk.text).toContain(text.slice(-PREVIEW_TAIL / 2));
    expect(bulk.text).toContain(`left out: read ${path} for them`);
    expect(bulk.text).toContain(`<harness>\n[info] This result was ${text.length} characters (1000 lines), so only its start and end are shown. The whole text is in ${path}`);

    // The file holds the whole result, and the model's reads, never spilled themselves, put it back together.
    expect(await inside(name, (instance) => instance.workspace.fs.readFile(path, { encoding: "utf8" }))).toBe(text);

    // Each page is read's envelope; the last is the end of the file.
    const pages = shown.slice(1).map((page) => {
      expect(page.tool).toBe("read");
      expect(page.text).not.toContain("<harness>");

      return parseAs(Page, page.text, "a page");
    });

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.at(-1)!.truncated).toBe(false);
    expect(pages.map((page) => page.content).join("\n")).toBe(text);
    expect(answer).toBe(`read back in ${pages.length} pages: ${text.length} characters`);
  });

  it("is left as it is up to the limit", async () => {
    const result = await prompt(crypto.randomUUID(), 'readback tool bulk {"lines":200}');
    expect(result.text).toBe(`nothing spilled: ${bulkText(200).length} characters`);
  });

  it("previews its start and end at line breaks, and says which lines it left out", () => {
    const text = bulkText(1000);
    const shown = preview(text, "/workspace/.tool-results/x.txt");
    const [head, tail] = shown.split(/\n\n\[… .*? …\]\n\n/);

    expect(head!.length).toBeLessThanOrEqual(PREVIEW_HEAD);
    expect(text.startsWith(`${head}\n`)).toBe(true);
    expect(tail!.length).toBeLessThanOrEqual(PREVIEW_TAIL);
    expect(text.endsWith(`\n${tail}`)).toBe(true);
    expect(shown).toMatch(/\[… \d+ characters, lines 99–976, left out: read \/workspace\/\.tool-results\/x\.txt for them …\]/);
  });
});
