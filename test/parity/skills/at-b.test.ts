/**
 * Rows B wrote load under the port: at-b.json holds the skill tables as B made and filled them (a pinned
 * skill a background run edited, one with answers, a kit, an archived merge, two forks), and what B's own
 * reads gave over them. The port opens those tables as they are and reads the same.
 */
import * as Schema from "effect/Schema";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Reviews, Skills } from "../../../src/skills/wiring";
import { storageOf, StoredRow } from "./storage";

const AtB = Schema.Struct({ schema: Schema.Array(Schema.String), tables: Schema.Record(Schema.String, Schema.Array(StoredRow)), reads: Schema.Unknown });

const atB = Schema.decodeUnknownSync(AtB)(JSON.parse(readFileSync(new URL("at-b.json", import.meta.url), "utf8")));

describe("skill rows written at B", () => {
  it("open under the port and read as B read them", () => {
    const db = new DatabaseSync(":memory:");

    // SQLite makes sqlite_sequence itself, with the first AUTOINCREMENT table.
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
    const names = ["tea", "plan-trip", "ship-change", "old-lint"];

    const reads = {
      get: names.map((name) => skills.get(name)),
      all: skills.all(),
      archived: skills.list("archived"),
      history: names.map((name) => skills.history(name)),
      index: skills.index(),
      since: skills.versionsSince(0, 100),
      reviews: ["1", "2", "3"].map((conversation) => ({ kind: reviews.kind(conversation) ?? null, run: reviews.run(conversation), window: reviews.window(conversation) ?? null })),
      reached: reviews.reached("1", "review") ?? null
    };

    // As text: key order is part of what a caller sees.
    expect(JSON.stringify(reads, null, 2)).toBe(JSON.stringify(atB.reads, null, 2));
    db.close();
  });
});
