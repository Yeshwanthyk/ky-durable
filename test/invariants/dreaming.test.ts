import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  anticipationRow,
  columnName,
  countOf,
  datesOf,
  DREAM_MEMORY_TOOLS,
  DREAMING_TABLES,
  markOf,
  MEMORY_WRITE_TOOLS,
  memoryRow,
  NO_MARK,
  soulVersion,
  summaryOf,
  versionOf
} from "../../src/dreaming/contract";

/**
 * Dreaming's storage and tools: memory (OptMem), SOUL.md and the nightly dream's mark.
 *
 * Its tables hold plain cells, and one JSON column (an anticipation's evidence), so what a restore can
 * damage is a cell's type or that JSON: each row decoder below turns a damaged row into its default (or
 * skips it) instead of throwing deep inside a read. That every allowlisted tool name is one the domain registers, and that the tables
 * exist after a start and survive a second one, need a Durable Object: src/tests/dreaming.test.ts.
 */

const FOLDER = path.join(import.meta.dirname, "../../src/dreaming");

const sources = readdirSync(FOLDER)
  .filter((file) => file.endsWith(".ts"))
  .map((file) => readFileSync(path.join(FOLDER, file), "utf8"));

describe("a damaged row decodes to its default", () => {
  const damaged: ReadonlyArray<Readonly<Record<string, SqlStorageValue>> | undefined> = [undefined, {}, { memories: "abc", at: 1 }, { id: "7", date: null, text: 3 }, { text: new ArrayBuffer(2) }];

  it.each(damaged)("the dream's mark from %o is the beginning", (row) => {
    expect(markOf(row)).toEqual(NO_MARK);
  });

  it("the dream's mark is read as stored when it is whole", () => {
    expect(markOf({ memories: 12, at: 1_700_000_000_000 })).toEqual({ memories: 12, at: 1_700_000_000_000 });
    expect(markOf({ memories: -1, at: 0 })).toEqual(NO_MARK);
  });

  it.each(damaged)("a memory from %o is skipped", (row) => {
    expect(memoryRow(row)).toBeUndefined();
  });

  it.each(damaged)("an anticipation from %o is skipped", (row) => {
    expect(anticipationRow(row)).toBeUndefined();
  });

  const anticipation = {
    id: 1, created_at: 1, created_by: "dream", kind: "open_loop", text: "Reply to Sam", evidence: '{"messages":[4],"memories":[0]}',
    prepared: null, window_from: null, window_to: null, status: "open", pinned: 1, absorbed_into: null, closed_at: null
  };

  it("an anticipation with damaged evidence, an unknown status or creator is skipped, and a whole one decodes", () => {
    expect(anticipationRow({ ...anticipation, evidence: "[4" })).toBeUndefined();
    expect(anticipationRow({ ...anticipation, evidence: '{"messages":["4"],"memories":[]}' })).toBeUndefined();
    expect(anticipationRow({ ...anticipation, status: "snoozed" })).toBeUndefined();
    expect(anticipationRow({ ...anticipation, created_by: "agent" })).toBeUndefined();
    expect(anticipationRow(anticipation)).toEqual({ ...anticipation, evidence: { messages: [4], memories: [0] }, pinned: true });
  });

  it.each(damaged)("a SOUL.md version from %o is skipped", (row) => {
    expect(soulVersion(row)).toBeUndefined();
  });

  it.each(damaged)("the counts, summaries, dates and columns from %o fall back", (row) => {
    expect(countOf(row)).toBe(0);
    expect(summaryOf(row)).toBeUndefined();
    expect(datesOf(row)).toEqual({ from: "", to: "" });
    expect(columnName(row)).toBe("");
    expect(versionOf(row)).toBe(0);
  });

  it("whole rows decode as stored", () => {
    expect(memoryRow({ id: 0, date: "2026-10-14", text: "the user likes green tea" })).toEqual({ id: 0, date: "2026-10-14", text: "the user likes green tea" });
    const version = { id: 2, action: "patch", actor: "user", conversation: null, body: "# SOUL.md", created_at: 1 };
    expect(soulVersion(version)).toEqual(version);
    expect(countOf({ n: 3 })).toBe(3);
    expect(summaryOf({ text: "a summary" })).toBe("a summary");
  });
});

describe("the tables the contract names", () => {
  const created = sources.flatMap((source) => [...source.matchAll(/CREATE TABLE (IF NOT EXISTS )?(\w+)/g)].map((match) => ({ table: match[2], guarded: match[1] !== undefined })));

  it("are exactly the ones the domain creates", () => {
    expect(created.map((each) => each.table).sort()).toEqual(Object.values(DREAMING_TABLES).sort());
  });

  it("are created only if they don't exist, and never dropped on start", () => {
    expect(created.filter((each) => !each.guarded)).toEqual([]);
    expect(sources.filter((source) => /DROP\s+TABLE/i.test(source))).toEqual([]);
  });
});

describe("the allowlists", () => {
  it("name each tool once, and the writes are among what a dream may call", () => {
    expect(new Set(DREAM_MEMORY_TOOLS).size).toBe(DREAM_MEMORY_TOOLS.length);
    expect(MEMORY_WRITE_TOOLS.filter((tool) => !DREAM_MEMORY_TOOLS.includes(tool))).toEqual([]);
  });
});
