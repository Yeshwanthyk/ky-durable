import * as Schema from "effect/Schema";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preamble } from "../../../src/avatars/contract";
import { Avatars, Setup } from "../../../src/avatars/wiring";
import { storageOf, StoredRow } from "../skills/storage";
import { readsOf } from "./reads";

const AtB = Schema.Struct({ now: Schema.Number, schema: Schema.Array(Schema.String), tables: Schema.Record(Schema.String, Schema.Array(StoredRow)), reads: Schema.Unknown });

const atB = Schema.decodeUnknownSync(AtB)(JSON.parse(readFileSync(new URL("at-b.json", import.meta.url), "utf8")));

const PromptsAtB = Schema.Array(
  Schema.Struct({
    config: Schema.Struct({
      executor: Schema.Boolean,
      cloud: Schema.optionalKey(Schema.String),
      selfEdit: Schema.optionalKey(Schema.Struct({ repo: Schema.String, url: Schema.String })),
      selfEditOn: Schema.optionalKey(Schema.String)
    }),
    prompt: Schema.String
  })
);

const promptsAtB = Schema.decodeUnknownSync(PromptsAtB)(JSON.parse(readFileSync(new URL("prompts-at-b.json", import.meta.url), "utf8")));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("avatar and setup rows written at B", () => {
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

    expect(JSON.stringify(readsOf({ avatars: new Avatars(storageOf(db)), setup: new Setup(storageOf(db)) }), null, 2)).toBe(JSON.stringify(atB.reads, null, 2));
    db.close();
  });
});

describe("the main prompt written at B", () => {
  // B named every agent ky.
  it("is the one the port writes, for every deploy", () => {
    for (const { config, prompt } of promptsAtB) expect(preamble({ name: "ky", ...config })).toBe(prompt);
  });
});
