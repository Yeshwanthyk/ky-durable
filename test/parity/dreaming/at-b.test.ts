import * as Schema from "effect/Schema";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DreamLedger } from "../../../src/dreaming/ledger";
import { Memory } from "../../../src/dreaming/memory";
import { Soul } from "../../../src/dreaming/soul";
import { Reviews, Skills, Specialists } from "../../../src/skills/wiring";
import { storageOf, StoredRow } from "../skills/storage";

const AtB = Schema.Struct({ at: Schema.Number, schema: Schema.Array(Schema.String), tables: Schema.Record(Schema.String, Schema.Array(StoredRow)), reads: Schema.Unknown });

const atB = Schema.decodeUnknownSync(AtB)(JSON.parse(readFileSync(new URL("at-b.json", import.meta.url), "utf8")));

const refusal = <A>(work: () => A): { said: A } | { refused: string } => {
  try {
    return { said: work() };
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) };
  }
};

type Storage = ConstructorParameters<typeof Skills>[0];

const memoryOver = ({ sql }: Storage) => new Memory(sql, () => Promise.reject(new Error("no compressor")));

describe("dreaming rows written at B", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("open under the port and read and undo as B did", () => {
    vi.spyOn(Date, "now").mockReturnValue(atB.at);
    const db = new DatabaseSync(":memory:");

    for (const statement of atB.schema.filter((each) => !each.includes("sqlite_sequence"))) db.exec(statement);

    for (const [table, rows] of Object.entries(atB.tables)) {
      for (const row of rows) {
        const columns = Object.keys(row);
        const values: SQLInputValue[] = Object.values(row);
        db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...values);
      }
    }

    const skills = new Skills(storageOf(db));
    const reviews = new Reviews(storageOf(db));
    const memory = memoryOver(storageOf(db));
    const specialists = new Specialists(storageOf(db));
    const soul = new Soul(storageOf(db));
    const ledger = new DreamLedger(storageOf(db), { skills, memory, reviews });

    const reads = {
      soul: { current: soul.current(), view: soul.view(), history: soul.history() },
      briefs: { eng: specialists.brief("eng").history(), none: specialists.brief("none").history(), current: refusal(() => specialists.brief("none").current()) },
      lastNight: ledger.lastNight(),
      undo: [1, 2, 4, 5, 6, 99].map((id) => refusal(() => ledger.undo(id))),
      after: ledger.lastNight()
    };

    expect(JSON.stringify(reads, null, 2)).toBe(JSON.stringify(atB.reads, null, 2));
    db.close();
  });
});
