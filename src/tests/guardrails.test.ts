import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { Type } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { canonical } from "../core/canonical";
import { decode, parseAs } from "../core/decode";
import { LOOP_LIMIT, loopBlock, preview, PREVIEW_HEAD, PREVIEW_TAIL, prune, repeats, SPILL_CHARS, spillPath, WRAP_CHARS, wrapped } from "../guardrails";
import { SKILL_TABLES } from "../skills/contract";
import { agent, connectExecutor, gateStarted, inside, prompt, submit, wait } from "./drive";
import { bulkText, Page, SPILLED, wideText } from "./stack";

const multiply = (value: number | string) => ["multiply", { value }];

const BLOCKED = /<harness>\n\[error\] Tool call blocked: multiply was already called 4 times in this run with these same arguments, and it gave the same answer each time\. Calling it again will not change that: change approach/;

const CallRow = Type.Object({ id: Type.String(), conversation: Type.Number() });

/** A surrogate half without its other half: text cut through a pair. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const DAY_MS = 24 * 60 * 60 * 1000;

const ConversationRow = Type.Object({ conversation: Type.Number() });

/** A turn that runs an Executor program answering `rows` rows of JSON, one line over SPILL_CHARS, then reads it back. */
function bigAnswer(rows: number): string {
  const value = Array.from({ length: rows }, (_, id) => ({ id, note: "abcdefghij".repeat(6) }));

  return `readback tool executor_execute ${JSON.stringify({ code: `answer ${JSON.stringify(value)}` })}`;
}

/** The calls of the tool `name`, in order: each one's id and its conversation. */
function callsOf(sql: SqlStorage, name: string) {
  return sql
    .exec(
      `SELECT json_extract(c.value, '$.id') AS id, e.conversation_id AS conversation
       FROM pi_entries AS e, json_each(e.record, '$.model[0].content') AS c
       WHERE json_extract(e.record, '$.kind') = 'pi.assistant' AND json_extract(c.value, '$.name') = ? ORDER BY e.id, c.key`,
      name
    )
    .toArray()
    .map((row) => decode(CallRow, row, "a call"));
}

/** The results' text after `say`, in order, each with its tool and call; the answer; and the conversation it ran in. */
async function said(name: string, say: string) {
  return inside(name, async (instance, state) => {
    const { text: answer, messages } = await instance.harness.prompt(say);
    const results = messages.flatMap((entry) => entry.model ?? []).filter((message) => message.role === "toolResult");
    const shown = results.map((message) => ({ tool: message.toolName, id: message.toolCallId, text: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n") }));

    return { answer, shown, conversation: callsOf(state.storage.sql, shown[0]!.tool)[0]!.conversation };
  });
}

/** The pages `read` gave of a spilled file, each read's envelope, never spilled itself. */
function pagesOf(shown: ReadonlyArray<{ readonly tool: string; readonly text: string }>) {
  return shown.map((page) => {
    expect(page.tool).toBe("read");
    expect(page.text).not.toContain("<harness>");

    return parseAs(Page, page.text, "a page");
  });
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

    const counts = await inside(name, (_instance, state) => callsOf(state.storage.sql, "multiply").map((call) => repeats(state.storage.sql, call.conversation, { id: call.id, name: "multiply" })));

    expect(counts).toEqual([0, 0, 0, 0, LOOP_LIMIT, LOOP_LIMIT, 0]);
  });

  it("blocks a loose model's repeats too: arguments the tool's schema converts are compared as the model wrote them", async () => {
    const name = crypto.randomUUID();
    const results = (await prompt(name, `calls ${JSON.stringify(Array.from({ length: 5 }, () => multiply("1")))}`)).text!.replace(/^results: /, "").split(" | ");

    // "1" reaches the tool as 1, so it answers 3; the hook is handed 1, the entries keep "1".
    expect(results.slice(0, 4)).toEqual(["3", "3", "3", "3"]);
    expect(results[4]).toMatch(BLOCKED);
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

  it("lets a call run when its count fails", async () => {
    const name = crypto.randomUUID();
    await prompt(name, "hello");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // Without the entries table every query of the count throws, as a damaged database's would.
    const block = await inside(name, (_instance, state) => {
      state.storage.sql.exec("ALTER TABLE pi_entries RENAME TO pi_entries_away");

      try {
        return loopBlock(state.storage.sql, 1, { id: "call_1", name: "multiply" });
      } finally {
        state.storage.sql.exec("ALTER TABLE pi_entries_away RENAME TO pi_entries");
      }
    });

    expect(block).toBeUndefined();
    expect(warn).toHaveBeenCalledWith("guardrails: could not count the repeats of multiply", expect.any(Error));
    warn.mockRestore();
  });

  it("compares arguments whatever order their keys are in", () => {
    expect(canonical({ b: 1, a: { d: [1, { f: 2, e: 3 }], c: null } })).toBe(canonical({ a: { c: null, d: [1, { e: 3, f: 2 }] }, b: 1 }));
    expect(canonical({ value: 1 })).not.toBe(canonical({ value: 2 }));
  });
});

describe("a big result", () => {
  it("goes to its conversation's folder, the model sees its start, end and path, and read gives back all of it", async () => {
    const name = crypto.randomUUID();
    const text = bulkText(1000);
    expect(text.length).toBeGreaterThan(60_000);

    const { answer, shown, conversation } = await said(name, 'readback tool bulk {"lines":1000}');
    const bulk = shown[0]!;
    const path = spillPath(conversation, bulk.id);
    expect(bulk.tool).toBe("bulk");
    expect(SPILLED.exec(bulk.text)?.[0]).toBe(path);
    expect(bulk.text.length).toBeLessThan(SPILL_CHARS);
    expect(bulk.text.startsWith(text.slice(0, 5_000))).toBe(true);
    expect(bulk.text).toContain(text.slice(-PREVIEW_TAIL / 2));
    expect(bulk.text).toContain(`left out: read ${path} for them`);
    expect(bulk.text).toContain(`<harness>\n[info] This result was ${text.length} characters (1000 lines), so only its start and end are shown. The whole text is in ${path}`);
    expect(bulk.text).not.toContain("re-indented");

    // The file holds the whole result, and the model's reads, never spilled themselves, put it back together.
    expect(await inside(name, (instance) => instance.workspace.fs.readFile(path, { encoding: "utf8" }))).toBe(text);

    const pages = pagesOf(shown.slice(1));
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.at(-1)!.truncated).toBe(false);
    expect(pages.map((page) => page.content).join("\n")).toBe(text);
    expect(answer).toBe(`read back in ${pages.length} pages: ${text.length} characters`);
  });

  it("of one 60 KiB line is broken into lines read pages, and read gives back all of it", async () => {
    const name = crypto.randomUUID();
    const text = wideText(60 * 1024);

    const { answer, shown, conversation } = await said(name, `readback tool wide {"chars":${text.length}}`);
    const path = spillPath(conversation, shown[0]!.id);
    expect(shown[0]!.text).toContain(`Its lines over ${WRAP_CHARS} characters are broken into lines of ${WRAP_CHARS} there.`);

    const file = await inside(name, (instance) => instance.workspace.fs.readFile(path, { encoding: "utf8" }));
    expect(file.split("\n").every((line) => line.length <= WRAP_CHARS)).toBe(true);
    expect(file.replaceAll("\n", "")).toBe(text);

    // Without the breaks, read refuses the line ("exceeds the read cap") and its next page starts on it again.
    const pages = pagesOf(shown.slice(1));
    expect(pages.at(-1)!.truncated).toBe(false);
    expect(pages.map((page) => page.content).join("\n")).toBe(file);
    expect(answer).toBe(`read back in ${pages.length} pages: ${file.length} characters`);
  });

  it("of one line of JSON goes to the file re-indented, and the model is told the file's shape", async () => {
    const name = crypto.randomUUID();
    await connectExecutor(name);

    const { shown, conversation } = await said(name, bigAnswer(300));
    const result = shown[0]!;
    expect(result.tool).toBe("executor_execute");
    expect(result.text.length).toBeLessThan(SPILL_CHARS);
    expect(result.text).toContain("The file holds it re-indented as JSON, two spaces a level, so search it in that shape, not the result's own.");

    const file = await inside(name, (instance) => instance.workspace.fs.readFile(spillPath(conversation, result.id), { encoding: "utf8" }));
    expect(file).toContain('\n  "execution": {\n    "ok": true,\n    "value": [\n      {\n        "id": 0,\n');
    expect(file).toContain('\n        "id": 299,\n');
  });

  it("is left as it is up to the limit", async () => {
    const result = await prompt(crypto.randomUUID(), 'readback tool bulk {"lines":200}');
    expect(result.text).toBe(`nothing spilled: ${bulkText(200).length} characters`);
  });

  it("is left as it is in a run that may not call read: a check-in's, a look's, a dream's, a peer's question's", async () => {
    const name = crypto.randomUUID();

    const reads = await inside(name, (instance, state) => {
      for (const [conversation, kind] of [["901", "look"], ["902", "dream"], ["903", "review"], ["904", "episode"]]) {
        state.storage.sql.exec(`INSERT INTO ${SKILL_TABLES.skillReviews} (conversation, parent, created_at, kind) VALUES (?, '1', 0, ?)`, conversation, kind);
      }

      instance.peerAsks.received("anaky", "q1", "?");
      instance.peerAsks.answering("anaky", "q1", "906");

      const checkIn = vi.spyOn(instance.automations, "checkInRun").mockImplementation((session) => session === "905");

      try {
        return ["1", "901", "902", "903", "904", "905", "906"].map((session) => instance.mayCall(session, "read"));
      } finally {
        checkIn.mockRestore();
      }
    });

    expect(reads).toEqual([true, false, false, false, false, false, false]);
  });

  it("is left whole in a peer's question: its executor's big answer reaches the model, and no file is written", async () => {
    const name = crypto.randomUUID();
    await connectExecutor(name);
    await prompt(name, "hello");

    // The main chat answers a peer's question from here on, so it may call only PEER_TOOLS, never read.
    await inside(name, (instance, state) => {
      const { conversation } = decode(ConversationRow, state.storage.sql.exec("SELECT max(conversation_id) AS conversation FROM pi_entries").one(), "the chat");

      instance.peerAsks.received("anaky", "q1", "?");
      instance.peerAsks.answering("anaky", "q1", String(conversation));
    });

    const answer = (await prompt(name, bigAnswer(300))).text!;
    const kept = Number(/^nothing spilled: (\d+) characters$/.exec(answer)?.[1]);
    expect(kept).toBeGreaterThan(SPILL_CHARS);
    expect(await inside(name, (instance) => instance.workspace.fs.stat("/workspace/.tool-results").then((stat) => stat !== null, () => false))).toBe(false);
  });

  it("files are pruned past a week, and the oldest past the size cap; never the one just written", async () => {
    const name = crypto.randomUUID();
    const [a, b, c] = [spillPath(1, "call_a"), spillPath(1, "call_b"), spillPath(2, "call_c")];

    const left = await inside(name, async (instance) => {
      const { fs } = instance.workspace;
      const exists = (path: string) => fs.stat(path).then((stat) => stat !== null, () => false);
      const kept = () => Promise.all([a, b, c].map(exists));

      const write = async () => {
        for (const path of [a, b, c]) {
          await fs.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
          await fs.writeFile(path, "0123456789");
        }
      };

      await write();
      await prune(instance.workspace, c, { now: Date.now(), ms: DAY_MS, bytes: 1024 });
      const fresh = await kept();

      await prune(instance.workspace, c, { now: Date.now() + 8 * DAY_MS, ms: 7 * DAY_MS, bytes: 1024 });
      const old = [...(await kept()), await exists(a.slice(0, a.lastIndexOf("/")))];

      await write();
      await prune(instance.workspace, c, { now: Date.now(), ms: DAY_MS, bytes: 25 });

      return { fresh, old, full: await kept() };
    });

    // A day old at most, and under the cap: all kept, so mtime is in ms as now is.
    expect(left.fresh).toEqual([true, true, true]);
    // Past a week: only the file just written, and the folder left empty is gone.
    expect(left.old).toEqual([false, false, true, false]);
    // Over 25 bytes: the one just written counts first, then the newest; the oldest goes.
    expect(left.full).toEqual([false, true, true]);
  });

  it("previews its start and end at line breaks, and says which lines it left out", () => {
    const text = bulkText(1000);
    const path = spillPath(1, "x");
    const shown = preview(text, path);
    const [head, tail] = shown.split(/\n\n\[… .*? …\]\n\n/);

    expect(head!.length).toBeLessThanOrEqual(PREVIEW_HEAD);
    expect(text.startsWith(`${head}\n`)).toBe(true);
    expect(tail!.length).toBeLessThanOrEqual(PREVIEW_TAIL);
    expect(text.endsWith(`\n${tail}`)).toBe(true);
    expect(shown).toContain(`[… ${text.length - head!.length - tail!.length} characters, lines 99–976, left out: read ${path} for them …]`);
  });

  it("is cut, previewed and broken into lines never through a surrogate pair", () => {
    // Odd from the first character, so every cut at an even count falls inside an emoji.
    const text = `a${"😀".repeat(12_000)}`;
    const [head, tail] = preview(text, spillPath(1, "x")).split(/\n\n\[… .*? …\]\n\n/);

    expect(head).not.toMatch(LONE_SURROGATE);
    expect(tail).not.toMatch(LONE_SURROGATE);
    expect(text.startsWith(head!) && text.endsWith(tail!)).toBe(true);

    const lines = wrapped(text).split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.some((line) => LONE_SURROGATE.test(line))).toBe(false);
    expect(lines.join("")).toBe(text);
  });

  it("is spilled only past what subagent and chats `last` cut an answer to, with their note", () => {
    // src/skills/subagents.ts LAST_MAX and src/chats-tool.ts LAST_CHARS: 16,000 characters, then this note.
    expect(`${"x".repeat(16_000)}…[truncated; 1000000000 chars total]`.length).toBeLessThanOrEqual(SPILL_CHARS);
  });
});
