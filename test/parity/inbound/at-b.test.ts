import * as Schema from "effect/Schema";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Approvals } from "../../../src/approvals/approvals";
import { Inbound } from "../../../src/inbound/inbound";
import { storageOf, StoredRow } from "../skills/storage";
import { readsOf } from "./reads";

const AtB = Schema.Struct({ now: Schema.Number, schema: Schema.Array(Schema.String), tables: Schema.Record(Schema.String, Schema.Array(StoredRow)), reads: Schema.Unknown });

const atB = Schema.decodeUnknownSync(AtB)(JSON.parse(readFileSync(new URL("at-b.json", import.meta.url), "utf8")));

const TABLES = Object.keys(atB.tables);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("inbound rows written at B", () => {
  it("open under the port and read as B read them", async () => {
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

    const told: (readonly [string, string, string])[] = [];

    const asker = new Approvals(storageOf(db), { present: () => false, home: (session) => session, notify: () => {}, defer: () => {} });

    const inbound = new Inbound(storageOf(db), {
      // SAFETY: the reads make no credential call, so nothing reaches the Vault.
      vault: () => ({}) as never,
      asker,
      chat: (session) => session === "0" || session === "1",
      tell: async (...said) => void told.push(said)
    });

    const tables = () => Object.fromEntries(TABLES.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((row) => ({ ...row }))]));

    expect(JSON.stringify(await readsOf({ inbound, told, tables }), null, 2)).toBe(JSON.stringify(atB.reads, null, 2));
    db.close();
  });
});
