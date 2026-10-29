import * as Schema from "effect/Schema";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Memory } from "../../../src/dreaming/memory";
import { storageOf } from "../skills/storage";

const Blob = Schema.Struct({ blob: Schema.Array(Schema.Number) });

const StoredRow = Schema.Record(Schema.String, Schema.NullOr(Schema.Union([Schema.String, Schema.Number, Blob])));

const AtB = Schema.Struct({ at: Schema.Number, schema: Schema.Array(Schema.String), tables: Schema.Record(Schema.String, Schema.Array(StoredRow)), reads: Schema.Unknown });

const atB = Schema.decodeUnknownSync(AtB)(JSON.parse(readFileSync(new URL("at-b.json", import.meta.url), "utf8")));

const stored = (value: Schema.Schema.Type<typeof StoredRow>[string]): SQLInputValue => (Schema.is(Blob)(value) ? Uint8Array.from(value.blob) : value);

const refusal = <A>(work: () => A): { said: A } | { refused: string } => {
  try {
    return { said: work() };
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) };
  }
};

describe("memory rows written at B", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("open under the port and read, recall, search and forget as B did, damaged rows skipped", () => {
    vi.spyOn(Date, "now").mockReturnValue(atB.at);
    const db = new DatabaseSync(":memory:");

    for (const statement of atB.schema) db.exec(statement);

    for (const [table, rows] of Object.entries(atB.tables)) {
      for (const row of rows) {
        const columns = Object.keys(row);
        db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...Object.values(row).map(stored));
      }
    }

    const memory = new Memory(storageOf(db), () => Promise.reject(new Error("no compressor")), () => "America/Los_Angeles");

    const reads = {
      count: memory.count(),
      wake: memory.wake(),
      view: memory.view(),
      since: memory.since(36, 4),
      children: ["0-31", "32-47", "32-33", "40-41", "64-127", "1-2", "x"].map((id) => refusal(() => memory.children(id))),
      zoom: ["0-15", "32-35"].map((id) => refusal(() => memory.zoom(id))),
      recall: [
        refusal(() => memory.recall("tea")),
        refusal(() => memory.recall("lisbon|sam")),
        refusal(() => memory.recall("(")),
        refusal(() => memory.recall("damaged")),
        refusal(() => memory.recall("tea", { from: "2026-09-30", to: "2026-10-01", said: "between 2026-09-30 and 2026-10-01" }))
      ],
      search: ["tea", "[", "soy"].map((query) => memory.search(query)),
      relevant: memory.relevant(["tea", "lisbon", "sam's"], 3),
      forget: ["0-15", "0-15", "2-5"].map((id) => refusal(() => memory.forget(id, "c2"))),
      after: memory.wake()
    };

    expect(JSON.stringify(reads, null, 2)).toBe(JSON.stringify(atB.reads, null, 2));
    db.close();
  });
});
