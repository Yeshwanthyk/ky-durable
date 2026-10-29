import { fauxAssistantMessage, fauxText, type Message, type UserMessage } from "@earendil-works/pi-ai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as TestClock from "effect/testing/TestClock";
import fc from "fast-check";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Refusable } from "../../src/core/edge";
import { Sql } from "../../src/core/sql";
import { Anticipations } from "../../src/dreaming/anticipations";
import { type Compressor, Memories, Memory, type MemoryForget } from "../../src/dreaming/memory";
import { Proactivity } from "../../src/dreaming/proactivity";
import { Recalls } from "../../src/dreaming/recall";
import { Surfaced } from "../../src/dreaming/surfaced";
import { budget } from "../parity/kit";
import { sqlStorageOf, storageOf } from "../parity/memory/storage";

fc.configureGlobal({ baseSize: "large" });

const { numRuns, seed } = budget();

const START = Date.UTC(2026, 9, 1, 6, 30);

const HOUR = 3_600_000;

const LIMIT = 280;

const encoder = new TextEncoder();

const bytes = (line: string) => encoder.encode(line).length;

type Answer = { readonly said: unknown } | { readonly refused: string };

const answer = <A, E extends Refusable>(work: Effect.Effect<A, E>): Effect.Effect<Answer> =>
  Effect.match(work, { onFailure: (refusal): Answer => ({ refused: refusal.refusal }), onSuccess: (said): Answer => ({ said }) });

const cutAt = (line: string, limit: number) => {
  let kept = "";

  for (const char of line) {
    if (bytes(kept + char) > limit) break;
    kept += char;
  }

  return kept;
};

const dateIn = (zone: string | null, at: number) => {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: zone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
};

const dayOf = (id: number) => new Date(START + id * 6 * HOUR).toISOString().slice(0, 10);

type Note = { readonly id: number; readonly date: string; readonly text: string };

type Tree = Map<string, string | Uint8Array>;

const keyOf = (lo: number, hi: number) => `${lo}:${hi}`;

const textIn = (message: Message | undefined) =>
  message === undefined || message.role === "toolResult" ? "" : Array.isArray(message.content) ? message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n") : message.content;

const cleanups: Array<() => Promise<void>> = [];

beforeAll(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

type Told = { changes: number; readonly forgot: MemoryForget[]; readonly asked: Array<{ readonly messages: Message[] }> };

async function memoryWorld(zone: string | null = null, reply: (call: number) => string | Error = (call) => `summary ${call}`) {
  const db = new DatabaseSync(":memory:");
  const told: Told = { changes: 0, forgot: [], asked: [] };
  const listeners = new Set([() => void told.changes++]);

  const forgets = new Set([
    (forget: MemoryForget) => {
      if (forget.conversation === "deny") throw new Error("not now");
      told.forgot.push(forget);
    }
  ]);

  const compressor: Compressor = async (_system, messages) => {
    told.asked.push({ messages: structuredClone(messages) });
    const said = reply(told.asked.length);

    if (said instanceof Error) throw said;

    return fauxAssistantMessage([fauxText(said)]);
  };

  const runtime = ManagedRuntime.make(Layer.mergeAll(Memories.layer({ compressor, zone: () => zone, listeners, forgets }), TestClock.layer()).pipe(Layer.provide(Sql.layer(storageOf(db)))));
  const run = <A, E>(work: (memories: Memories["Service"]) => Effect.Effect<A, E>) => runtime.runPromise(Memories.use(work));
  const at = (ms: number) => runtime.runPromise(TestClock.setTime(ms));
  cleanups.push(async () => {
    await runtime.dispose();
    db.close();
  });
  await at(START);
  await run((memories) => memories.count);

  const fill = (notes: readonly Note[]) => {
    for (const note of notes) db.prepare("INSERT INTO memo_log (id, date, text) VALUES (?, ?, ?)").run(note.id, note.date, note.text);
  };

  const plant = (tree: Tree) => {
    for (const [key, text] of tree) {
      const [lo, hi] = key.split(":").map(Number);
      db.prepare("INSERT INTO memo_tree (lo, hi, text) VALUES (?, ?, ?)").run(lo ?? 0, hi ?? 0, text);
    }
  };

  const notes = () => db.prepare("SELECT id, date, text FROM memo_log ORDER BY id").all();

  const tree = (): Tree => new Map(db.prepare("SELECT lo, hi, text FROM memo_tree ORDER BY lo, hi").all().map((row) => [keyOf(Number(row.lo), Number(row.hi)), row.text instanceof Uint8Array ? row.text : String(row.text)]));

  return { db, told, run, at, fill, plant, notes, tree };
}

const notesOf = (texts: readonly string[]): Note[] => texts.map((text, id) => ({ id, date: dayOf(id), text }));

function alignedBlocks(total: number): Array<readonly [number, number]> {
  const blocks: Array<readonly [number, number]> = [];

  for (let size = 2; size <= total; size *= 2) for (let lo = 0; lo + size <= total; lo += size) blocks.push([lo, lo + size]);

  return blocks;
}

const summarized = (total: number, keep: (lo: number, hi: number) => boolean): Tree =>
  new Map(alignedBlocks(total).flatMap(([lo, hi]) => (keep(lo, hi) ? [[keyOf(lo, hi), `S ${lo}-${hi - 1}`] as const] : [])));

const aWord = fc.constantFrom("tea", "Oolong", "lisbon", "sam", "café", "100%", "a_b", "s.t", "(x", "deck", "TEA");

const aText = fc.array(aWord, { minLength: 1, maxLength: 40 }).map((words) => cutAt(words.join(" "), LIMIT));

const aTotal = fc.integer({ min: 0, max: 260 });

const aKeep = fc.oneof(fc.constant(() => true), fc.constant(() => false), fc.integer({ min: 2, max: 5 }).map((n) => (lo: number, hi: number) => (lo + hi) % n !== 0));

describe("a note", () => {
  const aLine = fc.oneof(
    fc.string({ maxLength: 20 }),
    fc.constantFrom("", "   ", "a\nb", "a\rb", "  padded tea  ", "x".repeat(280), "x".repeat(281), "é".repeat(140), "é".repeat(141), ` ${"x".repeat(280)} `),
    fc.array(fc.constantFrom("a", " ", "é", "☕"), { minLength: 260, maxLength: 300 }).map((chars) => chars.join(""))
  );

  it("is one trimmed line of at most 280 bytes, kept as the next id under the clock's day in the user's zone; anything else is refused in B's words", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(null, "America/Los_Angeles", "Asia/Kolkata", "Pacific/Kiritimati", "Nowhere/Bogus"),
        fc.array(fc.record({ line: aLine, after: fc.integer({ min: 0, max: 30 * HOUR }) }), { maxLength: 12 }),
        async (zone, steps) => {
          const { run, at, notes, told } = await memoryWorld(zone);
          const kept: Note[] = [];
          let now = START;

          for (const { line, after } of steps) {
            now += after;
            await at(now);
            const said = await run((memories) => answer(memories.note(line)));
            const trimmed = line.trim();

            if (trimmed === "") expect(said).toEqual({ refused: "Empty. A memory is one line of text." });
            else if (/[\r\n]/.test(trimmed)) expect(said).toEqual({ refused: "A memory is one line: merge them, or note them separately." });
            else if (bytes(trimmed) > LIMIT) expect(said).toEqual({ refused: `Too long: ${bytes(trimmed)} bytes, limit 280. Compress it further.` });
            else {
              expect(said).toEqual({ said: `Saved as #${kept.length}.` });
              kept.push({ id: kept.length, date: dateIn(zone, now), text: trimmed });
            }
          }

          expect(notes()).toEqual(kept);
          expect(told.changes).toBe(kept.length);
        }
      ),
      { numRuns, seed }
    );
  });

  it("renoted has its whitespace squeezed and is cut at 280 bytes on a character, saying how long it was", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom("a", " ", "\t", "\n", "é", "☕", "𝄞"), { maxLength: 320 }), async (chars) => {
        const { run, notes } = await memoryWorld();
        const raw = chars.join("");
        const line = raw.replace(/\s+/g, " ").trim();
        const cut = cutAt(line, LIMIT);
        const said = await run((memories) => answer(memories.renote(raw)));

        if (cut.trim() === "") {
          expect(said).toEqual({ refused: "Empty. A memory is one line of text." });
          expect(notes()).toEqual([]);

          return;
        }

        expect(said).toEqual({ said: cut === line ? "Saved as #0." : `Saved as #0. It was ${bytes(line)} bytes, so it was cut to 280.` });
        expect(notes()).toEqual([{ id: 0, date: dateIn(null, START), text: cut.trim() }]);
      }),
      { numRuns, seed }
    );
  });
});

const aBlockId = fc.oneof(
  fc.constantFrom("x", "", "1-2", "3-3", "0-0", "-1-2", "2-5", "0-1x", "a0-1", "0-1 ", " 0-15", "08-15", "4-7", "0-2"),
  fc.tuple(fc.integer({ min: 1, max: 8 }), fc.integer({ min: 0, max: 40 })).map(([power, k]) => `${k * 2 ** power}-${(k + 1) * 2 ** power - 1}`),
  fc.tuple(fc.integer({ min: 0, max: 300 }), fc.integer({ min: 0, max: 300 })).map(([lo, hi]) => `${lo}-${hi}`)
);

function blockOf(id: string): "id" | "block" | readonly [number, number] {
  const parts = id.trim().split("-");

  if (parts.length !== 2 || !parts.every((part) => /^\d+$/.test(part))) return "id";
  const lo = Number(parts[0]);
  const hi = Number(parts[1]) + 1;
  const size = hi - lo;

  return size >= 2 && Number.isInteger(Math.log2(size)) && lo % size === 0 ? [lo, hi] : "block";
}

const blockRefusal = (id: string, block: "id" | "block") =>
  block === "id" ? { refused: `'${id}' is not a block id, like 16-31.` } : { refused: `${id} is not a block. Copy an id wake printed, like 16-31.` };

describe("a block id", () => {
  it("names an aligned block of a power of two, at least two, inside the memory: zoom, children and forget refuse any other in B's words", async () => {
    await fc.assert(
      fc.asyncProperty(aTotal, fc.array(aBlockId, { minLength: 1, maxLength: 8 }), async (total, picked) => {
        const { run, fill } = await memoryWorld();
        const ids = [...picked, `${total + (total % 2)}-${total + (total % 2) + 1}`];
        fill(notesOf(Array.from({ length: total }, (_, id) => `memory ${id}`)));

        for (const id of ids) {
          const block = blockOf(id);
          const reads = [await run((memories) => answer(memories.zoom(id))), await run((memories) => answer(memories.children(id)))];
          const forgot = await run((memories) => answer(memories.forget(id, null)));

          if (block === "id" || block === "block") {
            expect(reads).toEqual([blockRefusal(id, block), blockRefusal(id, block)]);
            expect(forgot).toEqual(blockRefusal(id, block));
            continue;
          }

          expect(forgot).toEqual({ refused: `No summary at ${id}.` });

          if (block[0] >= total) expect(reads).toEqual(Array(2).fill({ refused: `#${id} is beyond the memory: it holds ${total}.` }));
          else for (const read of reads) expect(read).toHaveProperty("said");
        }
      }),
      { numRuns, seed }
    );
  });
});

type Item = { kind: "memory"; id: number; date: string; text: string } | { kind: "block"; block: string; text: string | null; from: string; to: string };

const itemOf = (notes: readonly Note[], tree: Tree, [lo, hi]: readonly [number, number]): Item[] => {
  const held = notes.filter((note) => note.id >= lo && note.id < hi);

  if (hi - lo === 1) return held.map((note) => ({ kind: "memory", ...note }));
  const text = tree.get(keyOf(lo, hi));

  return [{ kind: "block", block: `${lo}-${hi - 1}`, text: text === undefined || text instanceof Uint8Array ? null : text, from: held[0]?.date ?? "", to: held.at(-1)?.date ?? "" }];
};

describe("reading the memory", () => {
  it("children opens a block into its newer half first, zoom lists it oldest first, a missing summary not compressed yet", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 200 }), aKeep, fc.array(fc.tuple(fc.integer({ min: 1, max: 7 }), fc.nat()), { minLength: 1, maxLength: 6 }), async (total, keep, picks) => {
        const { run, fill, plant } = await memoryWorld();
        const notes = notesOf(Array.from({ length: total }, (_, id) => `memory ${id}`));
        const tree = summarized(total, keep);
        fill(notes);
        plant(tree);

        for (const [power, pick] of picks) {
          const size = 2 ** power;
          const lo = (pick % Math.ceil(total / size)) * size;
          const id = `${lo}-${lo + size - 1}`;
          const mid = lo + size / 2;
          const halves = ([[mid, lo + size], [lo, mid]] as const).filter(([from]) => from < total);
          const items = halves.flatMap((half) => itemOf(notes, tree, half));

          expect(await run((memories) => memories.children(id))).toEqual(items);
          expect(await run((memories) => memories.zoom(id))).toBe(
            [...items]
              .reverse()
              .map((item) => (item.kind === "memory" ? `#${item.id} ${item.date} ${item.text}` : `#${item.block} ${item.text ?? "not compressed yet"}`))
              .join("\n")
          );
        }
      }),
      { numRuns, seed }
    );
  });

  it("wake tiles every memory once, oldest first and finer toward the newest, in 96 lines when every summary is written, a missing one opened into its halves", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 600 }), aKeep, async (total, keep) => {
        const { run, fill, plant } = await memoryWorld();
        const notes = notesOf(Array.from({ length: total }, (_, id) => `memory ${id}`));
        const tree = summarized(total, keep);
        fill(notes);
        plant(tree);
        const wake = await run((memories) => memories.wake);

        if (total === 0) {
          expect(wake).toBe("No memories yet. Record the first with memory_note.");

          return;
        }

        let next = 0;
        let last = Number.POSITIVE_INFINITY;
        const lines = wake.split("\n");

        for (const line of lines) {
          const block = /^#(\d+)-(\d+) (.*)$/.exec(line);

          if (block) {
            const [lo, hi] = [Number(block[1]), Number(block[2]) + 1];
            expect([lo, block[3]]).toEqual([next, tree.get(keyOf(lo, hi))]);
            next = hi;
            continue;
          }

          expect(line).toBe(`#${next} ${dayOf(next)} memory ${next}`);
          next++;
        }

        expect(next).toBe(total);

        if (summarized(total, () => true).size !== tree.size) return;
        expect(lines).toHaveLength(Math.min(total, 96));

        for (const line of lines) {
          const block = /^#(\d+)-(\d+) /.exec(line);
          const size = block ? Number(block[2]) + 1 - Number(block[1]) : 1;
          expect(size).toBeLessThanOrEqual(last);
          last = size;
        }
      }),
      { numRuns, seed }
    );
  });

  it("the panel's view holds at most 64 items, newest first, with the count and the newest memory's day", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 400 }), aKeep, async (total, keep) => {
        const { run, fill, plant } = await memoryWorld();
        const notes = notesOf(Array.from({ length: total }, (_, id) => `memory ${id}`));
        const tree = summarized(total, keep);
        fill(notes);
        plant(tree);
        const view = await run((memories) => memories.view);

        expect([view.count, view.newest]).toEqual([total, notes.at(-1)?.date ?? null]);
        expect(view.items).toHaveLength(Math.min(total, 64));
        let next = total;

        for (const item of view.items) {
          const [lo, hi] = item.kind === "memory" ? [item.id, item.id + 1] : item.block.split("-").map((each, at) => Number(each) + at);
          expect(hi).toBe(next);
          expect([item]).toEqual(itemOf(notes, tree, [lo ?? 0, hi ?? 0]));
          next = lo ?? 0;
        }

        expect(next).toBe(0);
      }),
      { numRuns, seed }
    );
  });

  it("since gives the newest memories from an id up to its limit, oldest first", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 60 }), fc.integer({ min: -2, max: 62 }), fc.integer({ min: 0, max: 10 }), async (total, from, limit) => {
        const { run, fill } = await memoryWorld();
        const notes = notesOf(Array.from({ length: total }, (_, id) => `memory ${id}`));
        fill(notes);
        const held = notes.filter((note) => note.id >= from);

        expect(await run((memories) => memories.since(from, limit))).toEqual(limit === 0 ? [] : held.slice(-limit));
      }),
      { numRuns, seed }
    );
  });
});

describe("recall and search", () => {
  const aPattern = fc.constantFrom("tea", "TEA", "lisbon|sam", "(", "[", "^#1", "s.t", "café", "nothing", "", ".*", "100%");

  const aDays = fc.option(
    fc.tuple(fc.integer({ min: 0, max: 60 }), fc.integer({ min: 0, max: 20 })).map(([from, span]) => ({ from: dayOf(from * 4), to: dayOf((from + span) * 4), said: `asked ${from}` })),
    { nil: undefined }
  );

  it("recall finds a regex's matches within the days asked, oldest first, keeping the newest 20000 bytes, and refuses a bad regex in B's words", async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.array(aText, { maxLength: 20 }), fc.array(aText, { minLength: 200, maxLength: 260 })), aPattern, aDays, async (texts, pattern, days) => {
        const { run, fill } = await memoryWorld();
        const notes = notesOf(texts);
        fill(notes);
        const said = await run((memories) => answer(memories.recall(pattern, days)));
        let regex: RegExp;

        try {
          regex = new RegExp(pattern, "i");
        } catch (error) {
          expect(said).toEqual({ refused: `Bad regex: ${error instanceof Error ? error.message : String(error)}` });

          return;
        }

        const hits = notes
          .filter((note) => days === undefined || (note.date >= days.from && note.date <= days.to))
          .map((note) => `#${note.id} ${note.date} ${note.text}`)
          .filter((line) => regex.test(line));

        if (hits.length === 0) {
          expect(said).toEqual({ said: days === undefined ? "No match." : `No match ${days.said}.` });

          return;
        }

        let kept = hits;

        while (kept.reduce((sum, line) => sum + bytes(line) + 1, 0) > 20_000) kept = kept.slice(1);
        const tail = kept.length < hits.length ? `Newest ${kept.length} of ${hits.length} matches. Narrow the regex.` : `${hits.length} match${hits.length === 1 ? "" : "es"}.`;

        expect(said).toEqual({ said: `${kept.join("\n")}\n${tail}` });
      }),
      { numRuns, seed }
    );
  });

  it("search lists the newest 50 matches newest first with the total, reading a query that is no regex as plain text", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(aText, { maxLength: 160 }), aPattern, async (texts, query) => {
        const { run, fill } = await memoryWorld();
        const notes = notesOf(texts);
        fill(notes);
        let test: (line: string) => boolean;
        let regex = true;

        try {
          const pattern = new RegExp(query, "i");
          test = (line) => pattern.test(line);
        } catch {
          regex = false;
          test = (line) => line.toLowerCase().includes(query.toLowerCase());
        }

        const matches = [...notes].reverse().filter((note) => test(`#${note.id} ${note.date} ${note.text}`));

        expect(await run((memories) => memories.search(query))).toEqual({ matches: matches.slice(0, 50), total: matches.length, regex });
      }),
      { numRuns, seed }
    );
  });

  it("relevant ranks memories by how many of the terms they hold, read literally, then newest, up to the limit", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(aText, { maxLength: 80 }),
        fc.uniqueArray(fc.constantFrom("tea", "lisbon", "sam", "café", "100%", "a_b", "s.t", "(x", "deck"), { maxLength: 4 }),
        fc.integer({ min: 0, max: 6 }),
        async (texts, terms, limit) => {
          const { run, fill } = await memoryWorld();
          const notes = notesOf(texts);
          fill(notes);

          const ranked = notes
            .map((note) => ({ note, score: terms.filter((term) => note.text.toLowerCase().includes(term)).length }))
            .filter((each) => each.score > 0)
            .sort((a, b) => b.score - a.score || b.note.id - a.note.id)
            .slice(0, limit)
            .map((each) => each.note);

          expect(await run((memories) => memories.relevant(terms, limit))).toEqual(ranked);
        }
      ),
      { numRuns, seed }
    );
  });
});

describe("forget", () => {
  it("drops a block's summary and every one above it, telling the watchers the smallest's text; a watcher's refusal keeps them all, and with none it is refused", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 130 }),
        aKeep,
        fc.array(fc.record({ power: fc.integer({ min: 1, max: 7 }), pick: fc.nat(), conversation: fc.constantFrom(null, "c1", "deny"), damage: fc.boolean() }), { minLength: 1, maxLength: 5 }),
        async (total, keep, steps) => {
          const { db, run, fill, plant, tree, told } = await memoryWorld();
          fill(notesOf(Array.from({ length: total }, (_, id) => `memory ${id}`)));
          plant(summarized(total, keep));

          for (const { power, pick, conversation, damage } of steps) {
            const size = 2 ** power;
            const lo = (pick % Math.ceil(total / size)) * size;
            const hi = lo + size;
            const id = `${lo}-${hi - 1}`;

            if (damage) db.prepare("UPDATE memo_tree SET text = X'02' WHERE lo <= ? AND hi >= ? AND hi - lo = (SELECT min(hi - lo) FROM memo_tree WHERE lo <= ? AND hi >= ?)").run(lo, hi, lo, hi);
            const before = tree();

            const above = [...before].flatMap(([key, text]) => {
              const [from = 0, to = 0] = key.split(":").map(Number);

              return from <= lo && to >= hi ? [{ key, text, size: to - from }] : [];
            });

            const smallest = [...above].sort((a, b) => a.size - b.size)[0];
            const forgot = told.forgot.length;
            const changes = told.changes;
            const said = await run((memories) => answer(memories.forget(id, conversation)));

            if (smallest === undefined) {
              expect(said).toEqual({ refused: `No summary at ${id}.` });
              expect(tree()).toEqual(before);
              continue;
            }

            if (conversation === "deny" && !(smallest.text instanceof Uint8Array)) {
              expect(said).toEqual({ refused: "not now" });
              expect(tree()).toEqual(before);
              continue;
            }

            const gone = above.length;
            expect(said).toEqual({ said: `Forgot ${gone} summar${gone === 1 ? "y" : "ies"}; ${gone === 1 ? "it is" : "they are"} rewritten in the background.` });
            expect(told.forgot.slice(forgot)).toEqual(smallest.text instanceof Uint8Array ? [] : [{ block: id, text: smallest.text, conversation }]);
            expect(told.changes).toBe(changes + 1);
            expect(tree()).toEqual(new Map([...before].filter(([key]) => !above.some((each) => each.key === key))));
          }
        }
      ),
      { numRuns, seed }
    );
  });
});

const stepOf = (notes: readonly Note[], tree: Tree, [lo, hi]: readonly [number, number]) => {
  if (hi - lo <= 16) {
    const held = notes.slice(lo, hi);
    const from = held[0]?.date ?? "";
    const to = held.at(-1)?.date ?? "";

    return [`Compress these ${held.length} notes, ${from === to ? `from ${from}` : `from ${from} to ${to}`}, into one line, in at most 280 bytes:`, ...held.map((note) => note.text)].join("\n");
  }

  const mid = (lo + hi) / 2;

  return [`Merge these two lines into one, in at most 280 bytes:`, tree.get(keyOf(lo, mid)), tree.get(keyOf(mid, hi))].join("\n");
};

const triesOf = (replies: readonly string[]) => {
  const tries: string[] = [];

  for (const reply of replies) {
    const line = reply.trim().replace(/\s*\n\s*/g, " ");

    if (line === "") break;
    tries.push(line);

    if (bytes(line) <= LIMIT) break;
  }

  return tries;
};

const asksOf = (tries: readonly string[]) => {
  const last = tries.at(-1);

  return (last !== undefined && bytes(last) <= LIMIT) || tries.length === 4 ? tries.length : tries.length + 1;
};

describe("compressing", () => {
  it("writes each owed summary, smallest blocks first and oldest first among them, from its notes or its two halves, and stops at the first that fails", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 90 }), aKeep, fc.option(fc.integer({ min: 1, max: 60 }), { nil: undefined }), async (total, keep, failing) => {
        const { run, fill, plant, tree, told } = await memoryWorld(null, (call) => (call === failing ? new Error("the model is down") : `S${call}`));
        const notes = notesOf(Array.from({ length: total }, (_, id) => `memory ${id}`));
        const expected = summarized(total, keep);
        fill(notes);
        plant(expected);
        const steps: string[] = [];

        for (const [lo, hi] of [...alignedBlocks(total)].sort((a, b) => a[1] - a[0] - (b[1] - b[0]) || a[0] - b[0])) {
          if (expected.has(keyOf(lo, hi))) continue;
          steps.push(stepOf(notes, expected, [lo, hi]));

          if (steps.length === failing) break;
          expected.set(keyOf(lo, hi), `S${steps.length}`);
        }

        const changes = told.changes;
        await run((memories) => memories.compress);

        expect(told.asked.map(({ messages }) => textIn(messages[0]).split("\n\n").at(-1))).toEqual(steps);
        expect(tree()).toEqual(expected);
        expect(told.changes - changes).toBe(steps.length - (failing !== undefined && steps.length === failing ? 1 : 0));
      }),
      { numRuns, seed }
    );
  });

  it("asks again while a summary is over 280 bytes, showing where it must end, at most 4 times, keeps the shortest, and stamps each ask with the clock's time", async () => {
    const aReply = fc.oneof(
      { arbitrary: fc.integer({ min: 281, max: 400 }).map((size) => "x".repeat(size)), weight: 4 },
      fc.integer({ min: 1, max: 400 }).map((size) => "x".repeat(size)),
      fc.integer({ min: 135, max: 150 }).map((size) => "é".repeat(size)),
      fc.constantFrom("a\nb  \n c", "x".repeat(280), "x".repeat(281), " ")
    );

    await fc.assert(
      fc.asyncProperty(fc.array(aReply, { minLength: 4, maxLength: 4 }), fc.integer({ min: 0, max: 400 * 24 * HOUR }), async (replies, after) => {
        const { run, at, fill, tree, told } = await memoryWorld(null, (call) => replies[call - 1] ?? "");
        fill(notesOf(["tea", "oolong"]));
        await at(START + after);
        await run((memories) => memories.compress);
        const tries = triesOf(replies);
        const asks = asksOf(tries);
        const users = (told.asked.at(-1)?.messages ?? []).filter((message): message is UserMessage => message.role === "user");

        expect(told.asked).toHaveLength(asks);
        expect(users.map((message) => message.timestamp)).toEqual(Array(users.length).fill(START + after));
        expect(users.slice(1).map(textIn)).toEqual(
          tries.slice(0, asks - 1).map((line) => `That line is ${bytes(line)} bytes; the limit is 280. It must end where it is cut here:\n${cutAt(line, LIMIT)}| ← LIMIT`)
        );
        const written = tries.length === asks ? tries.reduce((best, line) => (bytes(line) < bytes(best) ? line : best)) : undefined;

        expect(tree()).toEqual(written === undefined ? new Map() : new Map([[keyOf(0, 2), written]]));
      }),
      { numRuns, seed }
    );
  });

  it("writes a damaged summary again, and ends", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 40 }), fc.nat(), async (total, pick) => {
        const { db, run, fill, plant, tree, told } = await memoryWorld(null, (call) => (call > 3 ? new Error("asked too often") : `again ${call}`));
        const blocks = alignedBlocks(total);
        const [lo, hi] = blocks[pick % blocks.length] ?? [0, 2];
        fill(notesOf(Array.from({ length: total }, (_, id) => `memory ${id}`)));
        plant(summarized(total, () => true));
        db.prepare("UPDATE memo_tree SET text = X'02' WHERE lo = ? AND hi = ?").run(lo, hi);
        await run((memories) => memories.compress);

        expect(told.asked).toHaveLength(1);
        expect(tree().get(keyOf(lo, hi))).toBe("again 1");
      }),
      { numRuns, seed }
    );
  });
});

describe("a row a restore damaged", () => {
  const aDamage = fc.constantFrom<ReadonlyArray<[string, SQLInputValue]>>([["text", Uint8Array.of(0, 255)]], [["date", Uint8Array.of(1)]], [["text", Uint8Array.of(2)], ["date", Uint8Array.of(3)]]);

  it("is skipped by every read of the memories, and a damaged summary is read as absent", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(aText, { minLength: 2, maxLength: 70 }), fc.uniqueArray(fc.nat(), { minLength: 1, maxLength: 6 }), aDamage, async (texts, picks, damage) => {
        const { db, run, fill, plant } = await memoryWorld();
        const notes = notesOf(texts);
        const damaged = new Set(picks.map((pick) => pick % notes.length));
        const whole = notes.filter((note) => !damaged.has(note.id));
        const tree = summarized(notes.length, () => true);
        const [lo, hi] = alignedBlocks(notes.length)[(picks[0] ?? 0) % alignedBlocks(notes.length).length] ?? [0, 2];
        fill(notes);
        plant(tree);
        tree.delete(keyOf(lo, hi));
        db.prepare("UPDATE memo_tree SET text = X'02' WHERE lo = ? AND hi = ?").run(lo, hi);

        for (const id of damaged) for (const [column, value] of damage) db.prepare(`UPDATE memo_log SET ${column} = ? WHERE id = ?`).run(value, id);
        const lines = whole.map((note) => `#${note.id} ${note.date} ${note.text}`);

        expect(await run((memories) => memories.count)).toBe(notes.length);
        expect(await run((memories) => memories.since(0, 100))).toEqual(whole);
        expect(await run((memories) => memories.search("."))).toEqual({ matches: [...whole].reverse().slice(0, 50), total: whole.length, regex: true });
        expect((await run((memories) => memories.relevant(["tea", "sam", "deck", "lisbon", "café"], 100))).every((note) => !damaged.has(note.id))).toBe(true);
        expect(await run((memories) => memories.recall("."))).toBe(lines.length === 0 ? "No match." : `${lines.join("\n")}\n${lines.length} match${lines.length === 1 ? "" : "es"}.`);
        expect((await run((memories) => memories.children(`${lo}-${hi - 1}`))).every((item) => item.kind === "block" || !damaged.has(item.id))).toBe(true);
        expect((await run((memories) => memories.view)).items.some((item) => item.kind === "block" ? item.block === `${lo}-${hi - 1}` && item.text !== null : damaged.has(item.id))).toBe(false);
        expect((await run((memories) => memories.wake)).split("\n").some((line) => line.startsWith(`#${lo}-${hi - 1} `))).toBe(false);
      }),
      { numRuns, seed }
    );
  });
});

type Source = { readonly ahead: readonly string[]; readonly remembered: readonly string[]; readonly chats: readonly string[] };

const SKILLS = [
  { name: "brew", description: "steeps oolong tea for lisbon" },
  { name: "tea-order", description: "orders oolong tea" },
  { name: "deck_send", description: "sends sam the deck about oolong tea from lisbon" },
  { name: "unrelated", description: "nothing to see" }
];

const OWN = (entry: number) => `5a810bd0-46f4-43eb-8060-${String(entry).padStart(12, "0")}`;

async function recallWorld(source: Source) {
  const db = new DatabaseSync(":memory:");
  const recalled: Array<{ readonly ids: readonly number[]; readonly now: number }> = [];
  const shown: Array<{ readonly session: string; readonly entry: number; readonly lines: readonly string[] }> = [];
  db.exec("CREATE TABLE pi_entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, record TEXT NOT NULL)");
  db.exec("CREATE TABLE pi_submissions (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, status TEXT NOT NULL, record TEXT NOT NULL)");
  db.exec("CREATE TABLE ky_history (conversation TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL)");
  const proactivity = new Proactivity(sqlStorageOf(db));

  class Ahead extends Anticipations {
    override recallable(_terms: readonly string[], _now: number, limit = 5) {
      return source.ahead.slice(0, limit).map((text, id) => ({ id, created_at: 0, created_by: "dream" as const, kind: "watch" as const, text, evidence: { messages: [], memories: [] }, prepared: null, window_from: null, window_to: null, status: "open" as const, pinned: false, absorbed_into: null, closed_at: null }));
    }

    override recalled(ids: readonly number[], now = 0) {
      recalled.push({ ids: [...ids], now });
    }
  }

  const anticipations = new Ahead(sqlStorageOf(db), new Memory(storageOf(db), () => Promise.reject(new Error("no compressor"))), () => true);

  const listeners = new Set([(session: string, recall: { readonly entry: number; readonly lines: readonly string[] }) => void shown.push({ session, ...recall })]);

  const recalls = Recalls.layer(
    storageOf(db),
    {
      memory: { relevant: (_terms: readonly string[], limit: number) => source.remembered.slice(0, limit).map((text, id) => ({ id, date: "2026-10-01", text })) },
      history: { search: () => source.chats.map((text, at) => `#${9000 + at} user: ${text}`).join("\n") },
      anticipations,
      surfaced: new Surfaced(sqlStorageOf(db)),
      proactivity,
      skills: () => SKILLS,
      chat: (session: string) => session !== "9",
      delivered: (request: string) => request.startsWith("mail:")
    },
    listeners
  );

  const runtime = ManagedRuntime.make(Layer.mergeAll(recalls, TestClock.layer()).pipe(Layer.provide(Sql.layer(storageOf(db)))));
  const run = <A>(work: (recalls: Recalls["Service"]) => Effect.Effect<A>) => runtime.runPromise(Recalls.use(work));
  const at = (ms: number) => runtime.runPromise(TestClock.setTime(ms));
  cleanups.push(async () => {
    await runtime.dispose();
    db.close();
  });

  const say = (session: string, text: string, by: "own" | "mail" | "relay", now: number): UserMessage => {
    const id = Number(db.prepare("SELECT count(*) AS n FROM pi_entries").get()?.n ?? 0) + 1;
    const message: UserMessage = { role: "user", content: text, timestamp: now };
    db.prepare("INSERT INTO pi_entries (id, conversation_id, record) VALUES (?, ?, ?)").run(id, Number(session), JSON.stringify({ kind: "pi.user", model: [message] }));
    const request = by === "own" ? OWN(id) : by === "mail" ? `mail:${id}` : `peer-escalate:sam:${id}`;
    db.prepare("INSERT INTO pi_submissions (id, conversation_id, status, record) VALUES (?, ?, 'done', ?)").run(id, Number(session), JSON.stringify({ entry: id, requestId: request }));

    return message;
  };

  const surfaced = () => db.prepare("SELECT item, text, shown_at, expires_at, outcome, outcome_at FROM ky_surfaced ORDER BY id").all();

  return { run, at, say, surfaced, recalled, shown, proactivity };
}

const RECALLED_HEAD = "<recalled>\nrecalled context, not user input\n";

const blockText = (lines: readonly string[]) => `${RECALLED_HEAD}${lines.map((line) => `- ${line.replaceAll("<", "‹")}`).join("\n")}\n</recalled>`;

const fitted = (lines: readonly string[]) => {
  const kept: string[] = [];

  for (const raw of lines) {
    const line = raw.replaceAll("<", "‹").replace(/\s+/g, " ").trim();
    const cut = line.length <= 300 ? line : `${line.slice(0, 299)}…`;

    if (blockText([...kept, cut]).length > 1_500) break;
    kept.push(cut);
  }

  return kept;
};

describe("what recall shows before a request", () => {
  const aLine = fc.tuple(fc.constantFrom("tea", "a <b> tag", "lisbon  trip\t soon", "sam"), fc.integer({ min: 0, max: 420 })).map(([text, pad]) => `${text} ${"x".repeat(pad)}`.trim());

  const aSource = fc.record({ ahead: fc.array(aLine, { maxLength: 5 }), remembered: fc.array(aLine, { maxLength: 5 }), chats: fc.array(aLine, { maxLength: 5 }) });

  it("holds 3 anticipations, 3 memories, 3 chat lines and 2 skills, in that order, each cut at 300 characters, in at most 1500 characters", async () => {
    await fc.assert(
      fc.asyncProperty(aSource, async (source) => {
        const { run, at, say, shown, recalled } = await recallWorld(source);
        const message = say("1", "oolong tea for lisbon, and the deck for sam", "own", START);
        await at(START);
        const asked = await run((recalls) => recalls.request("1", [message]));

        const lines = fitted([
          ...source.ahead.slice(0, 3).map((text, id) => `anticipation #${id} watch: ${text}`),
          ...source.remembered.slice(0, 3).map((text, id) => `memory #${id} 2026-10-01: ${text}`),
          ...source.chats.slice(0, 3).map((text, at) => `chat #${9000 + at} user: ${text}`),
          "skill deck_send: sends sam the deck about oolong tea from lisbon",
          "skill brew: steeps oolong tea for lisbon"
        ]);

        expect(shown).toEqual([{ session: "1", entry: 1, lines }]);
        expect(recalled).toEqual([{ ids: source.ahead.slice(0, Math.min(3, lines.length)).map((_, id) => id), now: START }]);
        expect(asked).toEqual({ messages: [{ ...message, content: `${textIn(message)}\n\n${blockText(lines)}` }] });
      }),
      { numRuns, seed }
    );
  });

  it("is shown at the clock's time, missed when the user searches within the hour after, and expired at the hour", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 3 * HOUR }), fc.integer({ min: 0, max: 2 * HOUR }), fc.integer({ min: HOUR - 3, max: HOUR + 3 }), async (sent, wait, search) => {
        const { run, at, say, surfaced } = await recallWorld({ ahead: ["renew the passport"], remembered: [], chats: [] });
        const message = say("1", "the passport renewal", "own", START);
        const shownAt = START + sent;
        await at(shownAt);
        await run((recalls) => recalls.request("1", [message]));
        const searchedAt = shownAt + (wait % 2 === 0 ? search : wait);
        await at(searchedAt);
        await run((recalls) => recalls.searched("1"));
        const missed = searchedAt < shownAt + HOUR;

        expect(surfaced()).toEqual([
          { item: "1#1", text: "anticipation #0 watch: renew the passport", shown_at: shownAt, expires_at: shownAt + HOUR, outcome: missed ? "missed" : "expired", outcome_at: missed ? searchedAt : shownAt + HOUR }
        ]);
      }),
      { numRuns, seed }
    );
  });

  it("is for the user's own message or a delivered one in a chat while Proactivity is on, never a trivial one, a relayed one or another session's", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("1", "9"),
        fc.constantFrom("ok", "thanks!", "the", "  yes. ", "the passport renewal"),
        async (session, text) => {
          for (const by of ["own", "mail", "relay"] as const) {
            for (const level of ["on", "off"] as const) {
              const { run, at, say, shown, surfaced, proactivity } = await recallWorld({ ahead: ["renew the passport"], remembered: [], chats: [] });
              proactivity.set(level);
              const message = say(session, text, by, START);
              await at(START);
              await run((recalls) => recalls.request(session, [message]));
              await run((recalls) => recalls.request(session, [message]));
              const wanted = session === "1" && level === "on" && by !== "relay" && text === "the passport renewal";

              expect(shown).toEqual(wanted ? [{ session, entry: 1, lines: ["anticipation #0 watch: renew the passport"] }] : []);
              expect(surfaced().length).toBe(wanted ? 1 : 0);
            }
          }
        }
      ),
      { numRuns, seed }
    );
  });
});
