import * as Schema from "effect/Schema";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Approvals } from "../../../src/approvals/approvals";
import { ExecutorApprovals } from "../../../src/approvals/executor";
import { storageOf, StoredRow } from "../skills/storage";
import { readsOf } from "./reads";

const AtB = Schema.Struct({ now: Schema.Number, schema: Schema.Array(Schema.String), tables: Schema.Record(Schema.String, Schema.Array(StoredRow)), reads: Schema.Unknown });

const atB = Schema.decodeUnknownSync(AtB)(JSON.parse(readFileSync(new URL("at-b.json", import.meta.url), "utf8")));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("approval rows written at B", () => {
  it("open under the port and read as B read them", () => {
    vi.spyOn(Date, "now").mockImplementation(() => atB.now);
    const db = new DatabaseSync(":memory:");

    for (const statement of atB.schema) db.exec(statement);

    for (const [table, rows] of Object.entries(atB.tables)) {
      for (const row of rows) {
        const columns = Object.keys(row);
        const values: SQLInputValue[] = Object.values(row);
        db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...values);
      }
    }

    const approvals = new Approvals(storageOf(db), { present: () => false, home: () => "here", notify: () => {}, defer: () => {} });
    const executor = new ExecutorApprovals(storageOf(db), approvals, { config: async () => null, present: () => false, tell: async () => {} });

    expect(JSON.stringify(readsOf({ approvals, executor }), null, 2)).toBe(JSON.stringify(atB.reads, null, 2));
    db.close();
  });
});
