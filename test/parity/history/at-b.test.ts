import * as Schema from "effect/Schema";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StoredRow } from "../skills/storage";
import { readAll } from "./reads";
import { nextSide } from "./sides";

const AtB = Schema.Struct({ now: Schema.Number, schema: Schema.Array(Schema.String), tables: Schema.Record(Schema.String, Schema.Array(StoredRow)), reads: Schema.Unknown });

const atB = Schema.decodeUnknownSync(AtB)(JSON.parse(readFileSync(new URL("at-b.json", import.meta.url), "utf8")));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("history rows written at B", () => {
  it("open under the port, catch up from B's mark and read as B read them", () => {
    vi.spyOn(Date, "now").mockImplementation(() => atB.now);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = new DatabaseSync(":memory:");

    for (const statement of atB.schema) db.exec(statement);

    for (const [table, rows] of Object.entries(atB.tables)) {
      for (const row of rows) {
        const columns = Object.keys(row);
        const values: SQLInputValue[] = Object.values(row);
        db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...values);
      }
    }

    const ids = (atB.tables.pi_entries ?? []).map((row) => Number(row.id));

    expect(JSON.stringify(readAll(nextSide.open(db), nextSide.reads(db), ids, atB.now), null, 2)).toBe(JSON.stringify(atB.reads, null, 2));
    db.close();
  });
});
